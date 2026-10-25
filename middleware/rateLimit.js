const crypto = require('crypto');
const RateLimit = require('../models/RateLimit');
const { RATE_LIMITS } = require('../config/limits');

// Fixed-window counters in MongoDB (rate_limits), so limits survive restarts and hold across servers.
// A counter's key holds a hash of the IP or email, never the value itself.

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url').slice(0, 22);

// The window `now` falls in for a limit: { start, end } in ms
function windowOf(name, now = Date.now()) {
  const ms = RATE_LIMITS[name].minutes * 60 * 1000;
  const start = Math.floor(now / ms) * ms;
  return { start, end: start + ms };
}

// Counts one hit; returns 0 while under the limit, else the seconds until the window ends
async function hit(name, subject) {
  const { start, end } = windowOf(name);
  const doc = await RateLimit.findOneAndUpdate(
    { _id: `${name}:${hash(subject)}:${start}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(end) } },
    { upsert: true, returnDocument: 'after' }
  ).lean();
  return doc.count > RATE_LIMITS[name].limit ? Math.max(1, Math.ceil((end - Date.now()) / 1000)) : 0;
}

// Counts a hit on each [limit, subject] pair; 0 if all are fine, else the longest wait in seconds
async function tooMany(...checks) {
  const waits = await Promise.all(checks.map(([name, subject]) => hit(name, subject)));
  return Math.max(0, ...waits);
}

// Whether this address may receive one more account email now (counts it if so)
async function mailAllowed(email) {
  return !(await tooMany(['mailHour', email], ['mailDay', email]));
}

const waitText = (seconds) => (seconds <= 60 ? 'a minute' : `${Math.ceil(seconds / 60)} minutes`);
const tooManyMessage = (seconds) => `Too many attempts. For your security, please wait ${waitText(seconds)} before trying again.`;

module.exports = { tooMany, mailAllowed, tooManyMessage, windowOf };
