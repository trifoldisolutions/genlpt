const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const SupportRequest = require('../models/SupportRequest');
const Transaction = require('../models/Transaction');
const BrainstormSession = require('../models/BrainstormSession');
const User = require('../models/User');
const support = require('../services/support');
const emails = require('../services/email/templates');
const { SUPPORT_MESSAGE_MIN_CHARS, SUPPORT_MESSAGE_MAX_CHARS } = require('../config/limits');

const REAL = {
  create: SupportRequest.create,
  updateOne: SupportRequest.updateOne,
  transactionExists: Transaction.exists,
  sessionExists: BrainstormSession.exists,
  userFind: User.find,
};

test.afterEach(() => {
  SupportRequest.create = REAL.create;
  SupportRequest.updateOne = REAL.updateOne;
  Transaction.exists = REAL.transactionExists;
  BrainstormSession.exists = REAL.sessionExists;
  User.find = REAL.userFind;
});

const id = () => String(new mongoose.Types.ObjectId());
const message = 'I was charged twice for October.';
const userId = new mongoose.Types.ObjectId();
const user = { _id: userId, email: 'ada@example.com', plan: 'paid', subscription: { provider: 'stripe', customerId: 'cus_1', status: 'past_due', currentPeriodEnd: new Date('2026-11-30T00:00:00Z'), cancelAtPeriodEnd: false } };
const request = (fields) => ({ user: null, owner: null, get: (header) => (header === 'user-agent' ? 'Mozilla/5.0 Test' : undefined), ...fields });

test('a message needs a topic and a length within the limits; a guest also needs an address to reply to', () => {
  const error = (body, signedIn = true) => support.cleanRequest(body, { signedIn }).error?.[0];
  assert.equal(error({ topic: 'refunds', message }), 'invalid_topic');
  assert.equal(error({ message }), 'invalid_topic');
  assert.equal(error({ topic: 'other', message: ` ${'a'.repeat(SUPPORT_MESSAGE_MIN_CHARS - 1)}  ` }), 'message_too_short', 'spaces around it don’t count');
  assert.equal(error({ topic: 'other', message: 'a'.repeat(SUPPORT_MESSAGE_MAX_CHARS + 1) }), 'message_too_long');
  assert.equal(error({ topic: 'other', message: { text: message } }), 'message_too_short');
  assert.equal(error({ topic: 'other', message }, false), 'invalid_email');
  assert.equal(error({ topic: 'other', message, email: 'not-an-address' }, false), 'invalid_email');

  const { value } = support.cleanRequest({ topic: 'other', message: `  ${message}\n`, email: ' Ada@Example.com ' }, { signedIn: false });
  assert.equal(value.message, message);
  assert.equal(value.email, 'ada@example.com');
  assert.equal(support.cleanRequest({ topic: 'other', message, email: 'x@y.z' }, { signedIn: true }).value.email, null, 'an account replies from its own address');
});

test('only a billing message names a payment, and only well-formed ids are kept', () => {
  const tx = id();
  const clean = (body) => support.cleanRequest({ message, ...body }, { signedIn: true }).value;
  assert.equal(clean({ topic: 'billing', transactionId: tx }).transactionId, tx);
  assert.equal(clean({ topic: 'account', transactionId: tx }).transactionId, null);
  assert.equal(clean({ topic: 'billing', transactionId: { $ne: null } }).transactionId, null);
  assert.equal(clean({ topic: 'billing', transactionId: 'abc' }).transactionId, null);
  assert.equal(clean({ topic: 'other', sessionId: 'nope' }).sessionId, null);
});

test('an account’s message carries its address, plan and subscription, and only a payment and session of its own', async () => {
  const mine = id();
  const theirs = id();
  const session = id();
  const created = [];
  SupportRequest.create = async (doc) => { created.push(doc); return doc; };
  Transaction.exists = async (filter) => (String(filter._id) === mine && filter.userId === userId ? { _id: mine } : null);
  BrainstormSession.exists = async (filter) => (filter._id === session && filter.owner === `user:${userId}` ? { _id: session } : null);
  const req = request({ user, owner: `user:${userId}` });

  const saved = await support.submit(req, { topic: 'billing', message, email: null, transactionId: mine, sessionId: session });
  assert.equal(saved.email, 'ada@example.com');
  assert.equal(saved.userId, userId);
  assert.equal(saved.plan, 'paid');
  assert.deepEqual(saved.subscription, { status: 'past_due', currentPeriodEnd: user.subscription.currentPeriodEnd, cancelAtPeriodEnd: false }, 'not the provider’s ids');
  assert.equal(saved.transactionId, mine);
  assert.equal(saved.sessionId, session);
  assert.equal(saved.userAgent, 'Mozilla/5.0 Test');
  assert.match(saved.ref, /^[A-HJ-NP-Z2-9]{6}$/);

  const other = await support.submit(req, { topic: 'billing', message, email: null, transactionId: theirs, sessionId: id() });
  assert.equal(other.transactionId, undefined, 'someone else’s payment is dropped');
  assert.equal(other.sessionId, undefined, 'someone else’s session is dropped');
});

test('a guest’s message keeps the address they typed, and a long user agent is cut short', async () => {
  SupportRequest.create = async (doc) => doc;
  BrainstormSession.exists = async () => null;
  const req = request({ owner: 'guest:abc', get: () => 'x'.repeat(1000) });
  const saved = await support.submit(req, { topic: 'sessions', message, email: 'guest@example.com', transactionId: null, sessionId: null });
  assert.equal(saved.email, 'guest@example.com');
  assert.equal(saved.userId, null);
  assert.equal(saved.owner, 'guest:abc');
  assert.equal(saved.plan, 'guest');
  assert.equal(saved.subscription, undefined);
  assert.equal(saved.userAgent.length, 300);
});

test('a reference already taken is drawn again', async () => {
  let tries = 0;
  SupportRequest.create = async (doc) => {
    tries += 1;
    if (tries < 3) throw Object.assign(new Error('duplicate key'), { code: 11000 });
    return doc;
  };
  const saved = await support.submit(request({ owner: 'guest:abc' }), { topic: 'other', message, email: 'g@example.com' });
  assert.equal(tries, 3);
  assert.ok(saved.ref);

  SupportRequest.create = async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); };
  await assert.rejects(support.submit(request({ owner: 'guest:abc' }), { topic: 'other', message, email: 'g@example.com' }), /duplicate key/);
});

test('the inbox gets the message with Reply-To the sender, and the request is marked emailed', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  delete process.env.RESEND_API_KEY;
  process.env.NODE_ENV = 'test';
  process.env.SUPPORT_INBOX = 'team@example.com, help@example.com';
  const printed = [];
  t.mock.method(console, 'log', (text) => printed.push(text));
  const updates = [];
  SupportRequest.updateOne = async (...args) => { updates.push(args); };

  const saved = { _id: id(), ref: 'K7Q2XM', topic: 'billing', message, email: 'ada@example.com', userId, plan: 'paid', createdAt: new Date() };
  assert.equal(await support.notify(saved), true);
  assert.equal(printed.length, 2, 'one copy per inbox address');
  assert.ok(printed[0].includes('To: team@example.com') && printed[1].includes('To: help@example.com'));
  for (const text of printed) assert.ok(text.includes('Reply-To: ada@example.com'));
  assert.deepEqual(updates, [[{ _id: saved._id }, { $set: { emailed: true } }]]);
});

test('without SUPPORT_INBOX the admins get it; with no one to send to, the request stays saved, unmarked', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  delete process.env.SUPPORT_INBOX;
  User.find = (filter) => ({ lean: async () => (filter.role === 'admin' ? [{ email: 'admin@example.com' }] : []) });
  assert.deepEqual(await support.inbox(), ['admin@example.com']);

  User.find = () => ({ lean: async () => [] });
  t.mock.method(console, 'error', () => {});
  let marked = false;
  SupportRequest.updateOne = async () => { marked = true; };
  assert.equal(await support.notify({ _id: id(), ref: 'K7Q2XM', topic: 'other', message, email: 'g@example.com', plan: 'guest' }), false);
  assert.equal(marked, false);
});

test('the inbox email shows the message as written, escaped, with what the app knew, and no team signature', () => {
  const tx = id();
  const { subject, text, html } = emails.supportRequest({
    ref: 'K7Q2XM',
    topic: 'billing',
    message: 'Charged twice.\n<script>alert(1)</script>',
    email: 'ada@example.com',
    userId,
    owner: `user:${userId}`,
    plan: 'paid',
    subscription: { status: 'past_due', currentPeriodEnd: new Date('2026-11-30T00:00:00Z'), cancelAtPeriodEnd: true },
    transactionId: tx,
    userAgent: 'Mozilla/5.0 Test',
    createdAt: new Date('2026-10-30T12:00:00Z'),
  });
  assert.equal(subject, '[Billing] Support request K7Q2XM');
  assert.ok(text.startsWith('Charged twice.\n<script>'), 'the text version keeps it as typed');
  assert.ok(html.includes('Charged twice.\n&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('white-space:pre-wrap'));
  assert.ok(!html.includes('<script>'));
  assert.ok(text.includes('From: ada@example.com (account)'));
  assert.ok(text.includes('Plan: Paid plan'));
  assert.ok(text.includes('Subscription: past_due, ends 2026-11-30'));
  assert.ok(text.includes(`Payment: ${tx}`));
  assert.ok(text.includes('your reply goes to ada@example.com'));
  assert.ok(!text.includes('The GenLPT team'), 'an internal email isn’t signed');

  const guest = emails.supportRequest({ ref: 'AB23CD', topic: 'other', message, email: 'g@example.com', userId: null, plan: 'guest' });
  assert.ok(guest.text.includes('From: g@example.com (guest, address not confirmed)'));
  assert.ok(!guest.text.includes('Subscription:') && !guest.text.includes('Payment:'));
});
