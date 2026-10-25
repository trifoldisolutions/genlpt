const crypto = require('crypto');
const { GUEST_HOURS } = require('../config/limits');
const { cookieOptions } = require('../config/cookies');

// Who owns the sessions this request touches, as one opaque key (BrainstormSession.owner):
//   "user:<id>"    a signed-in account (req.user, set by middleware/auth.js)
//   "guest:<hash>" a browser without an account, known by an httpOnly cookie "<random id>.<start ms>"
// A guest starts with their first session (one left with only blank sessions starts over: restartBlankGuest
// in routes/api.js). Each of their sessions is erased GUEST_HOURS after it was last used (its expiresAt, a TTL
// index), and each use pushes that back (touchGuest in routes/api.js). The cookie lasts as long as their
// last session to go: once they're all gone it lapses, and their next session starts a new guest.
// The DB keeps only the hash of the cookie, start time included, so editing the cookie just makes a
// different, empty guest.
// Logging in doesn't touch the guest: on a shared computer its sessions may be someone else's. The app asks
// the user to move them to their account or delete them (/api/guest-sessions), then the guest is cleared.
// Logging out clears it too, so the next person on this browser starts fresh.

const GUEST_COOKIE = 'guest_id';
const GUEST_VALUE = /^[A-Za-z0-9_-]{43}\.\d{13}$/; // 32 random bytes (base64url) . start time in ms
const GUEST_TTL_MS = GUEST_HOURS * 60 * 60 * 1000;

function readCookie(req, name) {
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > -1 && pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim();
  }
  return null;
}

const hash = (value) => crypto.createHash('sha256').update(value).digest('base64url');

// The guest cookie's value, or null when there's none or it's malformed
function readGuest(req) {
  const value = readCookie(req, GUEST_COOKIE);
  return value && GUEST_VALUE.test(value) ? value : null;
}

const guestKey = (value) => `guest:${hash(value)}`;

const setCookie = (res, value) => res.cookie(GUEST_COOKIE, value, {
  ...cookieOptions(),
  maxAge: GUEST_TTL_MS, // Max-Age counts on the browser's own clock, so skew doesn't matter
});

// The owner key of the guest this browser still carries, even for a signed-in user (who owns by user id)
function guestOwner(req) {
  const value = readGuest(req);
  return value ? guestKey(value) : null;
}

// Forget this browser's guest (live, expired or malformed); its sessions, if any are left, expire on schedule
function clearGuest(req, res) {
  if (readCookie(req, GUEST_COOKIE) !== null) res.clearCookie(GUEST_COOKIE, cookieOptions());
}

// A session of this guest was just used: their cookie lasts GUEST_HOURS from now again. Only for the guest
// the request acts as (not one ensureOwner just replaced, whose cookie is already set).
function keepGuest(req, res) {
  const value = readGuest(req);
  if (value && guestKey(value) === req.owner) setCookie(res, value);
}

// Sets req.owner, or leaves it null: a guest who hasn't created a session yet owns nothing
function resolveOwner(req, res, next) {
  req.owner = null;
  if (req.user) {
    req.owner = `user:${req.user._id}`;
    return next();
  }
  const value = readGuest(req);
  if (value) req.owner = guestKey(value);
  next();
}

// Before creating a session: a visitor without an owner becomes a new guest
function ensureOwner(req, res, next) {
  if (req.owner) return next();
  const value = `${crypto.randomBytes(32).toString('base64url')}.${Date.now()}`;
  setCookie(res, value);
  req.owner = guestKey(value);
  next();
}

module.exports = { resolveOwner, ensureOwner, guestOwner, clearGuest, keepGuest, GUEST_COOKIE, GUEST_TTL_MS };
