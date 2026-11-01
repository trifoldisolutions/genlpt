const test = require('node:test');
const assert = require('node:assert/strict');

const SpendDay = require('../models/SpendDay');
const spend = require('../services/spend');
const { spendAlert } = require('../services/email/templates');
const { DAILY_SPEND } = require('../config/limits');

const realFetch = global.fetch;
const REAL = {
  findOneAndUpdate: SpendDay.findOneAndUpdate,
  updateOne: SpendDay.updateOne,
  findById: SpendDay.findById,
};
const ENV = ['RESEND_API_KEY', 'ALERT_EMAIL', 'NODE_ENV', 'ADMINS'];

// spend_days in memory, for the few queries services/spend.js makes; emails go to a fake Resend
function fakeDb({ admins = [] } = {}) {
  const days = new Map();
  const lean = (value) => ({ lean: async () => (value ? structuredClone(value) : null) });
  SpendDay.findOneAndUpdate = (filter, update) => {
    const day = days.get(filter._id) || { _id: filter._id, ...update.$setOnInsert };
    for (const [path, n] of Object.entries(update.$inc)) {
      const [a, b] = path.split('.');
      if (b) day[a] = { ...day[a], [b]: (day[a]?.[b] || 0) + n };
      else day[a] = (day[a] || 0) + n;
    }
    days.set(day._id, day);
    return lean(day);
  };
  SpendDay.updateOne = async (filter, update) => {
    const day = days.get(filter._id);
    const [path, at] = Object.entries(update.$set)[0];
    const line = path.split('.')[1];
    if (!day || day.alerted?.[line] != null) return { modifiedCount: 0 };
    day.alerted = { ...day.alerted, [line]: at };
    return { modifiedCount: 1 };
  };
  SpendDay.findById = (id) => lean(days.get(id));
  process.env.ADMINS = admins.map((email) => `${email}:$argon2id$test`).join(' '); // where alerts go without ALERT_EMAIL

  const emails = [];
  process.env.RESEND_API_KEY = 're_test';
  global.fetch = async (url, init) => {
    emails.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '{}' };
  };
  return { days, emails };
}

test.afterEach(() => {
  Object.assign(SpendDay, { findOneAndUpdate: REAL.findOneAndUpdate, updateOne: REAL.updateOne, findById: REAL.findById });
  global.fetch = realFetch;
  for (const k of ENV) delete process.env[k];
});

const at = (iso) => new Date(iso);

test('the lines: warning first, then guests, then free accounts; paid accounts are never paused', () => {
  const { warning, pause } = DAILY_SPEND;
  assert.ok(warning < pause.guest && pause.guest < pause.free);
  assert.equal(pause.paid, undefined);
  assert.deepEqual(spend.linesReached(warning - 0.01), []);
  assert.deepEqual(spend.linesReached(warning), ['warning']);
  assert.deepEqual(spend.linesReached(pause.guest), ['warning', 'guest']);
  assert.deepEqual(spend.linesReached(pause.free + 100), ['warning', 'guest', 'free']);
  assert.equal(spend.pausedAt('guest', pause.guest - 0.01), false);
  assert.equal(spend.pausedAt('guest', pause.guest), true);
  assert.equal(spend.pausedAt('free', pause.guest), false);
  assert.equal(spend.pausedAt('free', pause.free), true);
  assert.equal(spend.pausedAt('paid', 1e6), false);
});

test('a day is a UTC day, and it ends at the next midnight UTC', () => {
  assert.equal(spend.dayOf(at('2026-10-25T23:59:59Z')), '2026-10-25');
  assert.equal(spend.dayOf(at('2026-10-26T00:00:00Z')), '2026-10-26');
  assert.equal(spend.dayEnd(at('2026-10-25T08:30:00Z')).toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(spend.dayEnd(at('2026-12-31T23:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('costs add up per day and per plan; nothing for a call that cost nothing or no known cost', async () => {
  const { days } = fakeDb();
  const now = at('2026-10-25T10:00:00Z');
  await spend.add('guest', 0.25, now);
  await spend.add('free', 0.5, now);
  await spend.add('guest', 0.25, now);
  await spend.add('paid', 0, now);
  await spend.add('paid', null, now);
  const day = days.get('2026-10-25');
  assert.equal(day.cost, 1);
  assert.deepEqual(day.byPlan, { guest: 0.5, free: 0.5 });
  assert.ok(day.expiresAt > now);
  await spend.add('guest', 2, at('2026-10-26T00:00:01Z'));
  assert.equal(days.get('2026-10-26').cost, 2); // a new day starts from zero
});

test('guests are paused at their line, free accounts at theirs, paid accounts never; the next day all start over', async () => {
  fakeDb();
  const now = at('2026-10-25T10:00:00Z');
  const paused = async (plan, when = now) => (await spend.check(plan, when)).paused;
  assert.equal(await paused('guest'), false);
  await spend.add('free', DAILY_SPEND.pause.guest, now);
  assert.equal(await paused('guest'), true);
  assert.equal(await paused('free'), false);
  await spend.add('paid', DAILY_SPEND.pause.free - DAILY_SPEND.pause.guest, now);
  assert.equal(await paused('free'), true);
  assert.equal(await paused('paid'), false);
  assert.equal((await spend.check('guest', now)).resetAt.toISOString(), '2026-10-26T00:00:00.000Z');
  assert.equal(await paused('guest', at('2026-10-26T00:00:00Z')), false);
});

test('each line sends its email once a day, to ALERT_EMAIL, or to the admins without it', async () => {
  let { emails } = fakeDb({ admins: ['admin@example.com'] });
  process.env.ALERT_EMAIL = 'ops@example.com, me@example.com';
  const now = at('2026-10-25T10:00:00Z');
  await spend.add('guest', DAILY_SPEND.warning - 1, now);
  assert.equal(emails.length, 0);
  await spend.add('guest', 1, now); // reaches the warning
  await spend.add('guest', 1, now);
  assert.deepEqual(emails.map((e) => e.to[0]), ['ops@example.com', 'me@example.com']);
  assert.match(emails[0].subject, /reached \$30/);
  await spend.add('free', 100, now); // past both pause lines at once: one email each
  assert.equal(emails.length, 6);
  assert.match(emails[2].subject, /paused for guests until/);
  assert.match(emails[4].subject, /guests and free accounts/);
  await spend.add('free', 1, now);
  assert.equal(emails.length, 6);

  ({ emails } = fakeDb({ admins: ['admin@example.com'] }));
  delete process.env.ALERT_EMAIL;
  await spend.add('guest', DAILY_SPEND.warning, now);
  assert.deepEqual(emails.map((e) => e.to[0]), ['admin@example.com']);
});

test('the alert says the spend, what is paused, and the spend by plan', () => {
  const email = spendAlert({ line: 'guest', cost: 40.123, byPlan: { guest: 30, free: 10.123 }, limits: DAILY_SPEND });
  assert.match(email.subject, /AI is paused for guests until midnight UTC/);
  assert.match(email.text, /Today's AI spend is \$40\.12 since midnight UTC/);
  assert.match(email.text, /Free accounts will be paused at \$50\./);
  assert.match(email.text, /guests \$30\.00, free accounts \$10\.12, paid accounts \$0\.00/);
  assert.match(email.html, /\$40\.12/);
});
test('a test alert (npm run alert:test) is marked as one, and says nothing was spent', () => {
  const real = spendAlert({ line: 'warning', cost: 30, byPlan: {}, limits: DAILY_SPEND });
  const test = spendAlert({ line: 'warning', cost: 30, byPlan: {}, limits: DAILY_SPEND, test: true });
  assert.equal(test.subject, `[Test] ${real.subject}`);
  assert.match(test.text, /^This is a test of the daily AI spend alerts: nothing was spent/);
  assert.ok(test.text.endsWith(real.text), 'then the real alert');
  assert.doesNotMatch(real.text, /test/i);
});

test('alert addresses: ALERT_EMAIL, comma-separated, blanks ignored', () => {
  process.env.ALERT_EMAIL = ' ops@example.com,, me@example.com ';
  assert.deepEqual(spend.alertAddresses(), ['ops@example.com', 'me@example.com']);
  delete process.env.ALERT_EMAIL;
  assert.deepEqual(spend.alertAddresses(), []);
});
