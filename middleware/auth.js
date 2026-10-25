const crypto = require('crypto');
const mongoose = require('mongoose');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const User = require('../models/User');
const { LOGIN_DAYS, PASSWORD_MIN_CHARS, PASSWORD_MAX_CHARS } = require('../config/limits');
const { cookieOptions } = require('../config/cookies');

// Logins: an httpOnly cookie "sid" naming a server-side session in MongoDB (login_sessions) that holds only
// the user's id. loadUser turns it into req.user on every request, which middleware/owner.js then reads.
// Guests never get one: they're known by their guest cookie (middleware/owner.js).

const SESSION_COOKIE = 'sid';
const LOGIN_COLLECTION = 'login_sessions';
const LOGIN_MS = LOGIN_DAYS * 24 * 60 * 60 * 1000;

const dbReady = () => mongoose.connection.readyState === 1;
const run = (fn) => new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

// A dropped connection (the computer waking from sleep, MongoDB restarting) is back within seconds. A request
// arriving meanwhile waits for it, up to DB_WAIT_MS, instead of failing or being treated as logged out.
const DB_WAIT_MS = 3000;
async function waitForDb() {
  for (const end = Date.now() + DB_WAIT_MS; !dbReady() && Date.now() < end;) await new Promise((r) => setTimeout(r, 200));
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  console.warn('SESSION_SECRET is not set — everyone is logged out on each restart.');
  return crypto.randomBytes(32).toString('hex');
}

// The store needs a connected client, so it's made on the first request after MongoDB connects.
// While the database is down (after waitForDb) there's no req.session: nobody is signed in, and nothing
// waits on the store. Every request but static files passes here first, so this is where they all wait.
let sessionMiddleware = null;
async function sessions(req, res, next) {
  if (!dbReady()) await waitForDb();
  if (!dbReady()) return next();
  sessionMiddleware ||= session({
    name: SESSION_COOKIE,
    secret: sessionSecret(),
    store: MongoStore.create({
      client: mongoose.connection.getClient(),
      dbName: mongoose.connection.name,
      collectionName: LOGIN_COLLECTION,
      ttl: LOGIN_MS / 1000,
      // Seconds: an unchanged session is written back (expiry pushed) at most once an hour. The stored
      // expiry can lag the cookie's by this much, so a login may end up to an hour early.
      touchAfter: 60 * 60,
    }),
    resave: false,
    saveUninitialized: false, // no session (and no cookie) until someone logs in
    rolling: true, // each visit restarts the LOGIN_DAYS
    cookie: { ...cookieOptions(), maxAge: LOGIN_MS },
  });
  sessionMiddleware(req, res, next);
}

// req.user for routes and res.locals.user for views: { _id, name, email, role, plan }, or null for a guest
async function loadUser(req, res, next) {
  req.user = null;
  const id = req.session?.userId;
  if (id) {
    req.user = await User.findById(id, { name: 1, email: 1, role: 1, plan: 1 }).lean();
    if (!req.user) delete req.session.userId; // the account is gone
  }
  res.locals.user = req.user;
  next();
}

// A new session id at login, so an id planted in the browser beforehand is worthless (session fixation)
async function signIn(req, user) {
  await run((cb) => req.session.regenerate(cb));
  req.session.userId = String(user._id);
  await run((cb) => req.session.save(cb));
}

async function signOut(req, res) {
  if (req.session) await run((cb) => req.session.destroy(cb));
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

// Ends every login of this account, on every device (after a password reset)
async function signOutEverywhere(userId) {
  const id = String(userId);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('bad user id');
  await mongoose.connection.db.collection(LOGIN_COLLECTION).deleteMany({ session: { $regex: `"userId":"${id}"` } });
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

// Auth forms must be posted from our own pages. Otherwise another site could sign a visitor in to an
// account it controls (login CSRF) and collect whatever they save there, guest sessions included.
// Browsers send Sec-Fetch-Site, or at least Origin; a request with neither carries no visitor's cookies.
// req.host follows X-Forwarded-Host when Express trusts the proxy (TRUST_PROXY), so it matches the Origin.
function sameOrigin(req, res, next) {
  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  const ok = site ? site === 'same-origin' || site === 'none' : !origin || hostOf(origin) === req.host;
  if (!ok) return res.status(403).send('Cross-site request refused');
  next();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const cleanName = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

const emailProblem = (email) => (email.length > 254 || !EMAIL.test(email) ? 'Please enter a valid email address.' : null);

function passwordProblem(password) {
  if (password.length < PASSWORD_MIN_CHARS) return `Your password needs at least ${PASSWORD_MIN_CHARS} characters.`;
  if (password.length > PASSWORD_MAX_CHARS) return `Your password can have at most ${PASSWORD_MAX_CHARS} characters.`;
  return null;
}

// The first problem with a signup, as a message for the form, or null
function signupProblem({ name, email, password }) {
  if (!name || name.length > 80) return 'Please enter your name (80 characters max).';
  return emailProblem(email) || passwordProblem(password);
}

module.exports = {
  sessions,
  loadUser,
  signIn,
  signOut,
  signOutEverywhere,
  sameOrigin,
  normalizeEmail,
  cleanName,
  emailProblem,
  passwordProblem,
  signupProblem,
  SESSION_COOKIE,
};
