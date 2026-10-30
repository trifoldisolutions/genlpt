const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const User = require('../models/User');
const BrainstormSession = require('../models/BrainstormSession');
const AuthToken = require('../models/AuthToken');
const Usage = require('../models/Usage');
const AiAction = require('../models/AiAction');
const Transaction = require('../models/Transaction');
const account = require('../services/account');
const emails = require('../services/email/templates');
const { PLAN_LIMITS, VERIFY_LINK_HOURS } = require('../config/limits');

const MODELS = { User, BrainstormSession, AuthToken, Usage, AiAction, Transaction };
const METHODS = ['findById', 'find', 'findOne', 'create', 'deleteMany', 'deleteOne', 'updateOne', 'updateMany'];
const REAL = Object.fromEntries(Object.entries(MODELS).map(([name, model]) => [name, Object.fromEntries(METHODS.map((m) => [m, model[m]]))]));
const { hashPassword } = User;

test.afterEach(() => {
  for (const [name, model] of Object.entries(MODELS)) Object.assign(model, REAL[name]);
  User.hashPassword = hashPassword;
});

const userId = new mongoose.Types.ObjectId();
const owner = `user:${userId}`;
const lean = (value) => ({ lean: async () => (value ? structuredClone(value) : null) });

// Transaction.find(filter, projection).sort(…).limit(…).lean(), in memory; the query is kept in `seen`
function fakeTransactions(list, seen = {}) {
  Transaction.find = (filter, projection) => {
    Object.assign(seen, { filter, projection });
    const query = {
      sort: (order) => { seen.sort = order; return query; },
      limit: (n) => { seen.limit = n; return query; },
      lean: async () => structuredClone(list.slice(0, seen.limit ?? list.length)),
    };
    return query;
  };
  return seen;
}

// What services/account.js reads, in memory; each query's filter is kept, to check it only reaches this account
function fakeExport({ user, sessions = [], window = null, actions = [], payments = [] }) {
  const filters = {};
  User.findById = (id) => { filters.user = id; return lean(user); };
  BrainstormSession.find = (filter) => { filters.sessions = filter; return { sort: async () => sessions }; };
  Usage.findById = (id) => { filters.usage = id; return lean(window); };
  AiAction.find = (filter, projection) => {
    filters.actions = { filter, projection };
    return { sort: () => lean(actions) };
  };
  filters.payments = fakeTransactions(payments);
  return filters;
}

const payment = (day, status = 'paid') => ({
  date: new Date(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`),
  plan: 'paid',
  amount: 9,
  currency: 'USD',
  status,
  receiptUrl: `https://pay.example.com/receipts/${day}`,
});

const acronym = (letters, rank) => ({ letters, rank, source: 'llm', parts: [] });

test('the export holds the account, its sessions as the app shows them, and its AI log, all keyed on the account', async () => {
  const now = new Date('2026-10-25T12:00:00Z');
  const createdAt = new Date('2026-10-02T09:00:00Z');
  const user = { _id: userId, name: 'Ada', email: 'ada@example.com', plan: 'free', role: 'user', createdAt, emailVerifiedAt: createdAt, passwordHash: '$argon2id$secret' };
  const session = new BrainstormSession({
    owner,
    title: 'Farm app',
    answers: { who: 'A mobile app for local farmers' },
    acronyms: Array.from({ length: PLAN_LIMITS.free.shown + 2 }, (_, i) => acronym(`AB${i}`, i)),
  });
  const window = { _id: `owner:${owner}`, startedAt: now, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), runs: 2, words: 1, expansions: 0, reformulations: {} };
  const actions = [{ kind: 'runs', variant: 'default', sessionId: String(session._id), status: 200, counted: true, createdAt: now }];
  const payments = [payment(25), payment(1, 'refunded')];
  const filters = fakeExport({ user, sessions: [session], window, actions, payments });

  const data = await account.exportData(userId, now);

  assert.equal(filters.user, userId);
  assert.deepEqual(filters.sessions, { owner });
  assert.equal(filters.usage, `owner:${owner}`);
  assert.deepEqual(filters.actions.filter, { owner });
  assert.equal(filters.actions.projection.cost, undefined, 'what an action cost us stays out');
  assert.deepEqual(filters.payments.filter, { userId });
  assert.equal(filters.payments.limit, undefined, 'every payment, not only the ones Billing shows');
  assert.deepEqual(data.transactions, payments);

  assert.equal(data.app, 'GenLPT');
  assert.equal(data.exportedAt, now.toISOString());
  assert.deepEqual(data.account, { name: 'Ada', email: 'ada@example.com', plan: 'free', role: 'user', createdAt, emailVerifiedAt: createdAt });
  assert.ok(!JSON.stringify(data).includes('argon2'), 'never the password hash');

  const [exported] = data.sessions;
  assert.equal(exported.title, 'Farm app');
  assert.equal(exported.answers.who, 'A mobile app for local farmers');
  assert.equal(exported.acronyms.length, PLAN_LIMITS.free.shown, 'acronyms past the plan’s share stay locked');
  assert.equal(exported.lockedAcronyms, 2);
  for (const key of ['owner', 'expiresAt', '__v']) assert.equal(key in exported, false, key);

  assert.equal(data.usage.plan, 'free');
  assert.deepEqual(data.usage.runs, { used: 2, limit: PLAN_LIMITS.free.runs });
  assert.deepEqual(data.aiActions, actions);
  assert.doesNotThrow(() => JSON.stringify(data));
});

test('the export shows a subscription’s state only, and nothing for an account that is gone', async () => {
  const start = new Date('2026-10-25T00:00:00Z');
  const end = new Date('2026-11-25T00:00:00Z');
  const subscription = { provider: 'stripe', customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active', startedAt: start, currentPeriodEnd: end };
  fakeExport({ user: { _id: userId, email: 'ada@example.com', plan: 'paid', role: 'user', subscription } });
  const data = await account.exportData(userId);
  assert.deepEqual(data.account.subscription, { status: 'active', startedAt: start, currentPeriodEnd: end });
  assert.equal(data.account.plan, 'paid');
  assert.deepEqual(data.sessions, []);

  fakeExport({ user: null });
  assert.equal(await account.exportData(userId), null);
});

test('deleting an account removes everything it owns, unlinks its AI log, and removes the account last', async () => {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  BrainstormSession.deleteMany = record('sessions.deleteMany');
  Usage.deleteOne = record('usage.deleteOne');
  AiAction.updateMany = record('aiActions.updateMany');
  AuthToken.deleteMany = record('tokens.deleteMany');
  Transaction.deleteMany = record('transactions.deleteMany');
  User.deleteOne = record('user.deleteOne');

  await account.erase(userId);

  assert.deepEqual(calls, [
    ['sessions.deleteMany', { owner }],
    ['usage.deleteOne', { _id: `owner:${owner}` }],
    ['aiActions.updateMany', { owner }, { $unset: { owner: 1, sessionId: 1 } }],
    ['tokens.deleteMany', { userId }],
    ['transactions.deleteMany', { userId }],
    ['user.deleteOne', { _id: userId }],
  ]);
});

test('the transaction history is the account’s latest payments, newest first, without the provider’s ids', async () => {
  const seen = fakeTransactions([payment(27), payment(20, 'failed')]);
  assert.deepEqual(await account.transactions(userId), { transactions: [payment(27), payment(20, 'failed')], more: false });
  assert.deepEqual(seen.filter, { userId });
  assert.deepEqual(seen.sort, { date: -1 });
  assert.equal(seen.projection._id, 0);
  for (const key of ['provider', 'providerId', 'userId']) assert.equal(seen.projection[key], undefined, key);
});

test('past the shown ones, the history says there are older payments', async () => {
  const many = Array.from({ length: account.TRANSACTIONS_SHOWN + 3 }, (_, i) => payment((i % 28) + 1));
  fakeTransactions(many);
  const { transactions, more } = await account.transactions(userId);
  assert.equal(transactions.length, account.TRANSACTIONS_SHOWN);
  assert.equal(more, true);
});

test('a failed step leaves the account in place, so deleting it can be tried again', async () => {
  let userDeleted = false;
  BrainstormSession.deleteMany = async () => { throw new Error('connection lost'); };
  User.deleteOne = async () => { userDeleted = true; };
  await assert.rejects(account.erase(userId), /connection lost/);
  assert.equal(userDeleted, false);
});

// AuthToken.issue, on the database in memory: what it deletes and creates
function fakeIssue() {
  const calls = [];
  AuthToken.deleteMany = async (filter) => { calls.push(['deleteMany', filter]); };
  AuthToken.create = async (doc) => { calls.push(['create', doc]); };
  return calls;
}

test('a new email address waits on a link: its token holds the address, and replaces an older request', async () => {
  const calls = fakeIssue();
  const token = await account.requestEmailChange(userId, 'new@example.com');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const [[, older], [, created]] = calls;
  assert.deepEqual(older, { userId, purpose: 'email' });
  assert.equal(created.userId, userId);
  assert.equal(created.purpose, 'email');
  assert.equal(created.email, 'new@example.com');
  assert.notEqual(created._id, token, 'only its hash is stored');
  const hours = (created.expiresAt - Date.now()) / (60 * 60 * 1000);
  assert.ok(hours > VERIFY_LINK_HOURS - 0.1 && hours <= VERIFY_LINK_HOURS);
});

test('a signup link still keeps where it leads', async () => {
  const calls = fakeIssue();
  await AuthToken.issue(userId, 'verify', VERIFY_LINK_HOURS, { next: '/app?s=1' });
  assert.equal(calls[1][1].next, '/app?s=1');
  assert.equal(calls[1][1].email, undefined);
});

test('the pending address is the one of the live link, or null', async () => {
  let filter;
  AuthToken.findOne = (f) => { filter = f; return lean({ email: 'new@example.com' }); };
  assert.equal(await account.pendingEmail(userId), 'new@example.com');
  assert.equal(filter.userId, userId);
  assert.equal(filter.purpose, 'email');
  assert.ok(filter.expiresAt.$gt instanceof Date, 'an expired link the TTL index hasn’t deleted yet doesn’t count');

  AuthToken.findOne = () => lean(null);
  assert.equal(await account.pendingEmail(userId), null);
});

test('a confirmed new address first clears an account never confirmed there, then becomes the account’s own', async () => {
  const unconfirmed = new mongoose.Types.ObjectId();
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); return {}; };
  User.findOne = (filter) => { calls.push(['user.findOne', filter]); return { lean: async () => ({ _id: unconfirmed }) }; };
  BrainstormSession.deleteMany = record('sessions.deleteMany');
  Usage.deleteOne = record('usage.deleteOne');
  AiAction.updateMany = record('aiActions.updateMany');
  AuthToken.deleteMany = record('tokens.deleteMany');
  Transaction.deleteMany = record('transactions.deleteMany');
  User.deleteOne = record('user.deleteOne');
  User.updateOne = record('user.updateOne');

  assert.equal(await account.applyEmailChange(userId, 'new@example.com'), true);

  assert.deepEqual(calls[0], ['user.findOne', { email: 'new@example.com', emailVerifiedAt: null }]);
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf('user.deleteOne') < names.indexOf('user.updateOne'), 'the address is free before it’s taken');
  assert.deepEqual(calls.find(([name]) => name === 'user.deleteOne'), ['user.deleteOne', { _id: unconfirmed }]);
  const [, filter, update] = calls.at(-1);
  assert.deepEqual(filter, { _id: userId });
  assert.equal(update.$set.email, 'new@example.com');
  assert.ok(update.$set.emailVerifiedAt instanceof Date);
});

test('a new address that a confirmed account took meanwhile is refused', async () => {
  User.findOne = () => lean(null);
  User.updateOne = async () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); };
  assert.equal(await account.applyEmailChange(userId, 'taken@example.com'), false);
});

test('a password changed in settings is stored hashed, and links to reset the old one stop working', async () => {
  const calls = [];
  User.hashPassword = async (password) => `hash(${password})`;
  User.updateOne = async (...args) => { calls.push(['user.updateOne', ...args]); };
  AuthToken.deleteMany = async (filter) => { calls.push(['tokens.deleteMany', filter]); };
  await account.setPassword(userId, 'Pebble-Rug-CANYON-742!');
  assert.deepEqual(calls, [
    ['user.updateOne', { _id: userId }, { $set: { passwordHash: 'hash(Pebble-Rug-CANYON-742!)' } }],
    ['tokens.deleteMany', { userId, purpose: 'reset' }],
  ]);
});

test('the email and password change emails name nothing a visitor typed and say what to do if it wasn’t them', () => {
  const url = 'https://genlpt.test/app/confirm-email?token=abc';
  const confirm = emails.confirmNewEmail({ url });
  assert.equal(confirm.subject, 'Confirm your new email address for GenLPT');
  assert.ok(confirm.text.includes(`Confirm my new email address: ${url}`));
  assert.ok(confirm.text.includes(`expires in ${VERIFY_LINK_HOURS} hours`));
  assert.ok(confirm.text.includes('Nothing will change unless this link is used'));

  const inUse = emails.emailInUse({ loginUrl: 'https://genlpt.test/app/login', forgotUrl: 'https://genlpt.test/app/forgot' });
  assert.ok(inUse.text.includes('nothing was changed'));
  assert.ok(inUse.text.includes('Log in: https://genlpt.test/app/login'));

  const changed = emails.emailChanged();
  assert.equal(changed.subject, 'Your GenLPT email address has been changed');
  assert.ok(changed.text.includes('someone who knew your password did'));

  const password = emails.passwordChanged({ forgotUrl: 'https://genlpt.test/app/forgot' });
  assert.equal(password.subject, 'Your GenLPT password has been changed');
  assert.ok(password.text.includes('Reset my password: https://genlpt.test/app/forgot'));

  for (const email of [confirm, inUse, changed, password]) {
    assert.ok(!/ignore/i.test(email.text));
    assert.match(email.text, /The GenLPT team$/);
  }
});

test('the "account deleted" email names nothing a visitor typed and says what to do if it wasn’t them', () => {
  const email = emails.accountDeleted();
  assert.equal(email.subject, 'Your GenLPT account has been deleted');
  assert.ok(email.text.includes('together with all of its sessions'));
  assert.ok(email.text.includes('someone who knew your password did'));
  assert.ok(!/ignore/i.test(email.text));
  assert.match(email.text, /The GenLPT team$/);
  assert.ok(email.html.includes('The GenLPT team'));
});
