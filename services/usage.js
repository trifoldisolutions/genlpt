const crypto = require('crypto');
const Usage = require('../models/Usage');
const { USAGE_WINDOW_HOURS, PLAN_LIMITS, GUEST_IP_LIMITS } = require('../config/limits');
const { PLAN_PRICES } = require('../config/pricing');
const { guestStartedAt } = require('../middleware/owner');

// AI usage limits (PLAN_LIMITS in config/limits.js). Each subject — the session owner, plus the IP for a
// guest — has a window that opens on its first AI action and resets USAGE_WINDOW_HOURS later. An action
// is counted on all of them, or refused when any one is full. Reformulations are counted per session, in
// the owner's window: at reformulations.<session id>.

const WINDOW_MS = USAGE_WINDOW_HOURS * 60 * 60 * 1000;
const KINDS = ['runs', 'words', 'expansions'];
// A new window's counts, before the action that opens it
const EMPTY = { runs: 0, words: 0, expansions: 0, reformulations: {} };

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('base64url').slice(0, 22);

// 'guest' | 'free' | 'paid'
const planOf = (req) => (!req.user ? 'guest' : req.user.plan === 'paid' ? 'paid' : 'free');
const limitsOf = (req) => PLAN_LIMITS[planOf(req)];

// [counter id, limits] for each subject this request is held to (the IP's limits only cover some kinds)
function subjects(req, kind) {
  const list = [[`owner:${req.owner}`, limitsOf(req)]];
  if (!req.user) list.push([`ip:${hash(req.ip)}`, GUEST_IP_LIMITS]);
  return list.filter(([, limits]) => limits[kind] !== undefined);
}

// Where a count is kept in a window: 'runs', or 'reformulations.<session id>' for a per-session kind
const countPath = (kind, sessionId) => (sessionId ? `${kind}.${sessionId}` : kind);
const countAt = (window, path) => path.split('.').reduce((o, k) => o?.[k], window) || 0;

// A window opened by one action at `path`
function freshCounts(path) {
  const [kind, sessionId] = path.split('.');
  return { ...EMPTY, [kind]: sessionId ? { [sessionId]: 1 } : 1 };
}

// Counts one action on a counter; the window it went into, or null when that window is full
async function takeOne(id, path, limit, now = new Date()) {
  if (limit <= 0) return { ok: false, window: await Usage.findById(id).lean() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const open = await Usage.findOneAndUpdate(
      { _id: id, expiresAt: { $gt: now }, [path]: { $not: { $gte: limit } } }, // a count not there yet is 0
      { $inc: { [path]: 1 } },
      { returnDocument: 'after' }
    ).lean();
    if (open) return { ok: true, window: open };
    try {
      // No window yet, or it has ended: this action opens a new one
      const fresh = await Usage.findOneAndUpdate(
        { _id: id, expiresAt: { $lte: now } },
        { $set: { startedAt: now, expiresAt: new Date(now.getTime() + WINDOW_MS), ...freshCounts(path) } },
        { upsert: true, returnDocument: 'after' }
      ).lean();
      return { ok: true, window: fresh };
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    // The upsert hit an open window: full, unless another request opened it a moment ago (then try once more)
    const current = await Usage.findById(id).lean();
    if (!current || countAt(current, path) >= limit) return { ok: false, window: current };
  }
  return { ok: false, window: await Usage.findById(id).lean() };
}

// Gives one action back to the windows it was counted in (not to a newer window opened since)
async function giveBack(windows, path) {
  await Promise.all(windows.map((w) => Usage.updateOne(
    { _id: w._id, startedAt: w.startedAt, [path]: { $gt: 0 } },
    { $inc: { [path]: -1 } }
  )));
}

// What the page shows: the plan's limits and the owner's counts in the current window (0 before it opens).
// reformulations.used: { <session id>: count }, for the sessions that used any.
function toView(plan, window, now = Date.now()) {
  const limits = PLAN_LIMITS[plan];
  const open = !!window && new Date(window.expiresAt).getTime() > now;
  return {
    plan,
    resetAt: open ? window.expiresAt : null,
    shown: limits.shown,
    realWords: limits.realWords,
    chunks: limits.chunks,
    allModels: limits.allModels,
    ...Object.fromEntries(KINDS.map((k) => [k, { used: open ? window[k] || 0 : 0, limit: limits[k] }])),
    reformulations: { used: open ? window.reformulations || {} : {}, limit: limits.reformulations },
  };
}

async function view(req) {
  const window = req.owner ? await Usage.findById(`owner:${req.owner}`).lean() : null;
  return toView(planOf(req), window);
}

// Counts one `kind` action for this request (in that session, for reformulations), all or nothing.
// { ok: true, taken, path, view } (path: for giveBack) or { ok: false, resetAt } (when the full window frees up)
async function take(req, kind, sessionId = null) {
  const path = countPath(kind, sessionId);
  const taken = [];
  for (const [id, limits] of subjects(req, kind)) {
    const r = await takeOne(id, path, limits[kind]);
    if (!r.ok) {
      await giveBack(taken, path);
      return { ok: false, resetAt: r.window?.expiresAt || new Date(Date.now() + WINDOW_MS) };
    }
    taken.push(r.window);
  }
  return { ok: true, taken, path, view: toView(planOf(req), taken[0]) };
}

// The plan as Settings → Billing shows it: its price (null: free), when it began, and when its period ends.
//   guest  began with their first session (the guest cookie's start); the page knows when their sessions go
//   free   began with the account, and has no end
//   paid   the subscription's dates, from the payment provider; renews: false once it's canceled
function planDetails(req) {
  const plan = planOf(req);
  const base = { plan, price: PLAN_PRICES[plan] || null, startedAt: null, periodEnd: null, renews: false };
  if (plan === 'guest') return { ...base, startedAt: guestStartedAt(req) };
  if (plan === 'free') return { ...base, startedAt: req.user.createdAt || null };
  const sub = req.user.subscription || {};
  return {
    ...base,
    startedAt: sub.startedAt || null,
    periodEnd: sub.currentPeriodEnd || null,
    renews: !!sub.currentPeriodEnd && !sub.cancelAtPeriodEnd && sub.status !== 'canceled',
  };
}

// Each acronym of a run gets its place in it, best first: score (unscored last), then the engine's score,
// the same order as the list's "Score" sort.
function rankRun(candidates) {
  const score = (c) => c.score ?? -1;
  return [...candidates]
    .sort((a, b) => score(b) - score(a) || (b.engineScore || 0) - (a.engineScore || 0))
    .map((c, rank) => ({ ...c, rank }));
}

// A plan sees the first `shown` acronyms of each run; the others never leave the server, so an upgrade
// (guest → free → paid) reveals them. Acronyms from before ranks existed are all visible.
function splitAcronyms(acronyms, plan) {
  const { shown } = PLAN_LIMITS[plan];
  const visible = acronyms.filter((a) => shown == null || a.rank == null || a.rank < shown);
  return { visible, locked: acronyms.length - visible.length };
}

module.exports = { planOf, limitsOf, planDetails, take, giveBack, view, toView, rankRun, splitAcronyms, KINDS };
