const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOwner, ensureOwner, guestOwner, clearGuest, keepGuest, GUEST_COOKIE, GUEST_TTL_MS } = require('../middleware/owner');

const HOUR = 60 * 60 * 1000;
const RANDOM = 'a'.repeat(43);
const guestCookie = (startedAt, random = RANDOM) => `${GUEST_COOKIE}=${random}.${startedAt}`;

// Runs the middleware on a fake request (resolveOwner, plus ensureOwner when creating a session)
function run({ cookie, user, create = false } = {}) {
  const req = { headers: cookie ? { cookie } : {}, user };
  let set = null;
  const res = { cookie: (name, value, opts) => { set = { name, value, opts }; } };
  resolveOwner(req, res, () => {});
  if (create) ensureOwner(req, res, () => {});
  return { owner: req.owner, set };
}

test('a guest session is kept 3 hours after its last use', () => {
  assert.equal(GUEST_TTL_MS, 3 * HOUR);
});

test('a visitor owns nothing until their first session', () => {
  const r = run();
  assert.equal(r.owner, null);
  assert.equal(r.set, null, 'no cookie just for looking');
});

test('a first session starts a guest: random httpOnly cookie for 3 hours, hashed owner key', () => {
  const a = run({ create: true });
  const b = run({ create: true });
  assert.equal(a.set.name, GUEST_COOKIE);
  assert.equal(a.set.opts.httpOnly, true);
  assert.equal(a.set.opts.maxAge, GUEST_TTL_MS);
  assert.match(a.set.value, /^[A-Za-z0-9_-]{43}\.\d{13}$/);
  assert.notEqual(a.set.value, b.set.value);
  assert.match(a.owner, /^guest:/);
  assert.ok(!a.owner.includes(a.set.value.split('.')[0]), 'the raw cookie never becomes the owner key');
});

test('a returning guest keeps their owner, and gets no new cookie just for that', () => {
  const first = run({ create: true });
  const again = run({ cookie: `theme=x; ${GUEST_COOKIE}=${first.set.value}`, create: true });
  assert.equal(again.owner, first.owner);
  assert.equal(again.set, null);
});

test('a guest still active long after their first session is still the same guest', () => {
  const cookie = guestCookie(Date.now() - 10 * HOUR);
  assert.ok(run({ cookie }).owner);
  assert.equal(run({ cookie }).owner, run({ cookie }).owner);
});

test('using a session gives the cookie another 3 hours, same value, same guest', () => {
  const cookie = guestCookie(Date.now() - 2 * HOUR);
  const owner = run({ cookie }).owner;
  let set = null;
  keepGuest({ headers: { cookie }, owner }, { cookie: (name, value, opts) => { set = { name, value, opts }; } });
  assert.equal(set.name, GUEST_COOKIE);
  assert.equal(set.value, cookie.split('=')[1]);
  assert.equal(set.opts.maxAge, GUEST_TTL_MS);
  assert.equal(set.opts.httpOnly, true);
});

test('the cookie is only renewed for the guest the request acts as', () => {
  let set = null;
  const res = { cookie: () => { set = true; } };
  keepGuest({ headers: {}, owner: null }, res);
  assert.equal(set, null, 'no guest, no cookie');
  keepGuest({ headers: { cookie: guestCookie(Date.now()) }, owner: 'guest:someone-new' }, res);
  assert.equal(set, null, 'a new guest replaced this one: their cookie is already set');
});

test('editing the start time gives a different, empty guest', () => {
  const now = Date.now();
  const real = run({ cookie: guestCookie(now - HOUR) });
  const edited = run({ cookie: guestCookie(now) });
  assert.ok(real.owner && edited.owner);
  assert.notEqual(edited.owner, real.owner);
});

test('a malformed guest cookie is ignored', () => {
  assert.equal(run({ cookie: `${GUEST_COOKIE}=abc` }).owner, null);
  assert.equal(run({ cookie: `${GUEST_COOKIE}=${RANDOM}` }).owner, null); // the old format, without a start time
});

test('a signed-in user owns by user id and gets no guest cookie', () => {
  const r = run({ cookie: guestCookie(Date.now()), user: { _id: '64b000000000000000000001' }, create: true });
  assert.equal(r.owner, 'user:64b000000000000000000001');
  assert.equal(r.set, null);
});

test('a signed-in user can still reach the guest this browser carries, by the same key', () => {
  const now = Date.now();
  const cookie = guestCookie(now - HOUR);
  const asGuest = run({ cookie }).owner;
  assert.equal(guestOwner({ headers: { cookie } }), asGuest);
  assert.equal(guestOwner({ headers: {} }), null);
});

test('clearing the guest expires its cookie, and only when there is one', () => {
  const cleared = [];
  const res = { clearCookie: (name, opts) => cleared.push({ name, opts }) };
  clearGuest({ headers: {} }, res);
  assert.equal(cleared.length, 0);
  clearGuest({ headers: { cookie: `${GUEST_COOKIE}=abc` } }, res); // malformed ones go too
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].name, GUEST_COOKIE);
  assert.equal(cleared[0].opts.httpOnly, true);
});
