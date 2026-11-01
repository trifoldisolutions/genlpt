const crypto = require('crypto');
const argon2 = require('argon2');
const { ADMIN_SESSION_HOURS } = require('../config/limits');

// The people who run GenLPT are not GenLPT accounts: no row in users, no plan, no customer login. ADMINS lists them,
// one "email:argon2-hash" per admin, separated by spaces (npm run admin:password prints one). Signing in at
// /admin/login sets a cookie only /admin pages receive, valid ADMIN_SESSION_HOURS, signed with SESSION_SECRET. It names
// the admin and a fingerprint of their hash, so a changed password or an admin taken off ADMINS ends their sessions.
// Nothing here sends email: an admin's address is only their name to sign in with.

const COOKIE = 'genlpt_admin';
const COOKIE_PATH = '/admin';
const SESSION_MS = ADMIN_SESSION_HOURS * 60 * 60 * 1000;

// ADMINS → Map(email → hash). An entry without a colon, or whose hash isn't argon2's, is skipped (and said once).
let warned = false;
function admins(value = process.env.ADMINS) {
  const map = new Map();
  for (const entry of String(value || '').split(/\s+/).filter(Boolean)) {
    const i = entry.indexOf(':');
    const email = i > 0 ? entry.slice(0, i).trim().toLowerCase() : '';
    const hash = i > 0 ? entry.slice(i + 1) : '';
    if (email && hash.startsWith('$argon2')) map.set(email, hash);
    else if (!warned) {
      warned = true;
      console.warn('ADMINS has an entry that isn’t "email:hash" (npm run admin:password prints one): skipped');
    }
  }
  return map;
}

const adminEmails = () => [...admins().keys()];

// The key that signs admin cookies: SESSION_SECRET's, kept apart from the customer login's own use of it
let devKey = null;
function signingKey() {
  const secret = process.env.SESSION_SECRET || (devKey ||= crypto.randomBytes(32).toString('hex')); // no secret: one per start
  return crypto.createHash('sha256').update(`genlpt-admin-session:${secret}`).digest();
}

const fingerprint = (hash) => crypto.createHash('sha256').update(hash).digest('base64url').slice(0, 16);
const sign = (payload) => crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');

// The cookie's value: "<email, base64url>.<expiry ms>.<signature>"
function sessionValue(email, hash, now = Date.now()) {
  const expires = now + SESSION_MS;
  const name = Buffer.from(email).toString('base64url');
  return `${name}.${expires}.${sign(`${email}|${expires}|${fingerprint(hash)}`)}`;
}

// The admin a cookie value stands for, or null: a bad signature, an expired one, an admin no longer listed or whose
// password changed since
function readSession(value, list = admins(), now = Date.now()) {
  const m = /^([A-Za-z0-9_-]+)\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(String(value || ''));
  if (!m) return null;
  const email = Buffer.from(m[1], 'base64url').toString();
  const expires = Number(m[2]);
  const hash = list.get(email);
  if (!hash || expires <= now) return null;
  const expected = Buffer.from(sign(`${email}|${expires}|${fingerprint(hash)}`));
  const given = Buffer.from(m[3]);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? { email, expires } : null;
}

function readCookie(req) {
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > -1 && pair.slice(0, i).trim() === COOKIE) return pair.slice(i + 1).trim();
  }
  return null;
}

const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: COOKIE_PATH });

// Whether this email and password are an admin's: the email, else null. An unknown email is checked against a decoy
// hash, so the answer takes as long and doesn't say which addresses are admins.
let decoy = null;
async function checkLogin(email, password, list = admins()) {
  const hash = list.get(String(email || '').trim().toLowerCase());
  const ok = await argon2.verify(hash || (await (decoy ||= argon2.hash(crypto.randomBytes(16).toString('hex')))), String(password || '')).catch(() => false);
  return ok && hash ? String(email).trim().toLowerCase() : null;
}

function signIn(res, email, list = admins()) {
  res.cookie(COOKIE, sessionValue(email, list.get(email)), { ...cookieOptions(), maxAge: SESSION_MS });
}

const signOut = (res) => res.clearCookie(COOKIE, cookieOptions());

// req.admin ({ email }) and res.locals.admin for the admin pages; signed out: to the sign-in, then back
function requireAdmin(req, res, next) {
  const session = readSession(readCookie(req));
  if (session) {
    req.admin = { email: session.email };
    res.locals.admin = req.admin;
    return next();
  }
  if (req.method === 'GET') return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(401).type('text').send('Signed out: sign in again at /admin/login.');
}

// Where sign-in leads: an admin page only
const safeNext = (next) => (typeof next === 'string' && /^\/admin(?:[/?#]|$)/.test(next) && !next.startsWith('/admin/login') ? next : '/admin');

module.exports = {
  admins,
  adminEmails,
  sessionValue,
  readSession,
  checkLogin,
  signIn,
  signOut,
  requireAdmin,
  safeNext,
  COOKIE,
};
