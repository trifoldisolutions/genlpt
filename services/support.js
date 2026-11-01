const crypto = require('crypto');
const SupportRequest = require('../models/SupportRequest');
const Transaction = require('../models/Transaction');
const BrainstormSession = require('../models/BrainstormSession');
const { sendEmail } = require('./email');
const templates = require('./email/templates');
const usage = require('./usage');
const { normalizeEmail, emailProblem } = require('../middleware/auth');
const { SUPPORT_MESSAGE_MIN_CHARS, SUPPORT_MESSAGE_MAX_CHARS } = require('../config/limits');
const { adminEmails } = require('../middleware/admin');

// Settings → Help center's contact form (POST /api/support). Each message is saved first (models/SupportRequest.js),
// then emailed to SUPPORT_INBOX with the sender as Reply-To, so the team answers from their own mail client.

const { TOPICS } = SupportRequest;
// No 0/O or 1/I: a reference gets read out and typed back
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_LENGTH = 6;
const USER_AGENT_MAX = 300;

const isId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const newRef = () => Array.from({ length: REF_LENGTH }, () => REF_CHARS[crypto.randomInt(REF_CHARS.length)]).join('');

// The form's fields, checked: { value } or { error: [code, message] }. A guest types the address to reply to; an
// account's is its own. The payment (billing only) and the open session are only checked to be ids here: submit()
// keeps them only if they're the sender's.
function cleanRequest(body, { signedIn }) {
  const topic = body?.topic;
  if (!TOPICS.includes(topic)) return { error: ['invalid_topic', 'Choose what your message is about.'] };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length < SUPPORT_MESSAGE_MIN_CHARS) {
    return { error: ['message_too_short', `Please describe the problem in at least ${SUPPORT_MESSAGE_MIN_CHARS} characters.`] };
  }
  if (message.length > SUPPORT_MESSAGE_MAX_CHARS) {
    return { error: ['message_too_long', `Please keep your message under ${SUPPORT_MESSAGE_MAX_CHARS} characters.`] };
  }
  let email = null;
  if (!signedIn) {
    email = normalizeEmail(body.email);
    const problem = emailProblem(email);
    if (problem) return { error: ['invalid_email', problem] };
  }
  return {
    value: {
      topic,
      message,
      email,
      transactionId: topic === 'billing' && isId(body.transactionId) ? body.transactionId : null,
      sessionId: isId(body.sessionId) ? body.sessionId : null,
    },
  };
}

// Saves a checked request with what the app knows about its sender (a payment or session that isn't theirs is
// dropped) and a reference of its own. Returns the saved request.
async function submit(req, value) {
  const { user } = req;
  const [payment, session] = await Promise.all([
    value.transactionId && user ? Transaction.exists({ _id: value.transactionId, userId: user._id }) : null,
    value.sessionId && req.owner ? BrainstormSession.exists({ _id: value.sessionId, owner: req.owner }) : null,
  ]);
  const sub = user?.subscription;
  const fields = {
    topic: value.topic,
    message: value.message,
    email: user ? user.email : value.email,
    userId: user?._id || null,
    owner: req.owner || null,
    plan: usage.planOf(req),
    subscription: sub?.status ? { status: sub.status, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : undefined,
    transactionId: payment ? value.transactionId : undefined,
    sessionId: session ? value.sessionId : undefined,
    userAgent: String(req.get('user-agent') || '').slice(0, USER_AGENT_MAX),
  };
  for (let tries = 1; ; tries++) {
    try {
      return await SupportRequest.create({ ...fields, ref: newRef() });
    } catch (err) {
      if (err.code !== 11000 || tries >= 3) throw err; // a reference already taken: draw another
    }
  }
}

// SUPPORT_INBOX's addresses (several: comma-separated), or every admin's (ADMINS)
async function inbox() {
  const listed = (process.env.SUPPORT_INBOX || '').split(',').map((s) => s.trim()).filter(Boolean);
  return listed.length ? listed : adminEmails();
}

// Emails a saved request to the inbox, and marks it emailed once one copy went out. Returns whether one did.
async function notify(request) {
  const to = await inbox();
  if (!to.length) {
    console.error(`[support] no SUPPORT_INBOX and no ADMINS: request ${request.ref} was saved but not emailed`);
    return false;
  }
  const email = templates.supportRequest(request);
  const sent = await Promise.all(to.map((address) => sendEmail({ to: address, replyTo: request.email, ...email })));
  if (!sent.some(Boolean)) {
    console.error(`[support] request ${request.ref} was saved but its email failed`);
    return false;
  }
  await SupportRequest.updateOne({ _id: request._id }, { $set: { emailed: true } });
  return true;
}

module.exports = { cleanRequest, submit, notify, inbox, newRef, TOPICS };
