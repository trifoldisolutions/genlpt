const SpendDay = require('../models/SpendDay');
const { sendEmail } = require('./email');
const templates = require('./email/templates');
const { DAILY_SPEND } = require('../config/limits');
const { adminEmails } = require('../middleware/admin');

// The platform's daily AI spend (DAILY_SPEND in config/limits.js). Each AI action's cost is added to its day once
// it's done (routes/api.js); a plan past its pause line gets no AI until the day ends, at midnight UTC.

const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (now) => now.toISOString().slice(0, 10);
// When the day `now` falls in ends, and the spend starts over
const dayEnd = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

// Whether a day's spend pauses this plan (a plan without a line, like paid, never is)
const pausedAt = (plan, cost, limits = DAILY_SPEND) => limits.pause[plan] != null && cost >= limits.pause[plan];

// The lines a day's spend has reached: 'warning', then each plan's pause line ('guest', 'free')
function linesReached(cost, limits = DAILY_SPEND) {
  return [['warning', limits.warning], ...Object.entries(limits.pause)]
    .filter(([, at]) => cost >= at)
    .map(([line]) => line);
}

// Whether this plan's AI is paused for the rest of the day: { paused, resetAt }
async function check(plan, now = new Date()) {
  if (DAILY_SPEND.pause[plan] == null) return { paused: false, resetAt: null };
  const day = await SpendDay.findById(dayOf(now), { cost: 1 }).lean();
  return { paused: pausedAt(plan, day?.cost || 0), resetAt: dayEnd(now) };
}

// ALERT_EMAIL's addresses (several: comma-separated)
const alertAddresses = () => (process.env.ALERT_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);

// ALERT_EMAIL, or every admin's address (ADMINS)
async function recipients() {
  const listed = alertAddresses();
  return listed.length ? listed : adminEmails();
}

async function alert(line, day) {
  const email = templates.spendAlert({ line, cost: day.cost, byPlan: day.byPlan || {}, limits: DAILY_SPEND });
  console.warn(`[spend] ${email.subject} (${day._id}: $${day.cost.toFixed(4)})`);
  const to = await recipients();
  if (!to.length) return console.warn('[spend] no ALERT_EMAIL and no ADMINS: the alert was not emailed');
  await Promise.all(to.map((address) => sendEmail({ to: address, ...email })));
}

// Adds one AI action's cost (USD) to its day. The action that takes the day past a line sends that line's email.
async function add(plan, cost, now = new Date()) {
  if (!(cost > 0)) return;
  const day = await SpendDay.findOneAndUpdate(
    { _id: dayOf(now) },
    {
      $inc: { cost, [`byPlan.${plan}`]: cost },
      $setOnInsert: { expiresAt: new Date(now.getTime() + SpendDay.KEEP_DAYS * DAY_MS) },
    },
    { upsert: true, returnDocument: 'after' }
  ).lean();
  for (const line of linesReached(day.cost)) {
    if (day.alerted?.[line]) continue;
    // Claimed once, however many actions cross the line at the same moment
    const claimed = await SpendDay.updateOne({ _id: day._id, [`alerted.${line}`]: null }, { $set: { [`alerted.${line}`]: now } });
    if (claimed.modifiedCount) await alert(line, day);
  }
}

module.exports = { check, add, dayOf, dayEnd, pausedAt, linesReached, alertAddresses };
