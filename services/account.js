const User = require('../models/User');
const BrainstormSession = require('../models/BrainstormSession');
const AuthToken = require('../models/AuthToken');
const Usage = require('../models/Usage');
const AiAction = require('../models/AiAction');
const Transaction = require('../models/Transaction');
const SupportRequest = require('../models/SupportRequest');
const brand = require('../config/brand');
const { VERIFY_LINK_HOURS } = require('../config/limits');
const usage = require('./usage');

// A signed-in user's own account (settings → Account and Billing, routes/api.js): change its email address or password,
// list its payments, download all of its data, or delete it with that data (GDPR, Québec Law 25). Logins
// (login_sessions) are ended by the route, with middleware/auth.js.

const ownerOf = (userId) => `user:${userId}`;

// A payment as the account sees it (models/Transaction.js), without the provider's ids
const TRANSACTION_FIELDS = { _id: 0, date: 1, plan: 1, amount: 1, currency: 1, status: 1, receiptUrl: 1 };
const TRANSACTIONS_SHOWN = 24; // two years of monthly payments

// Settings → Billing's transaction history: the latest payments, newest first, and whether there are older ones
// (the data export has them all). Each with its own id, for Help center's form to say which one a message is about.
async function transactions(userId) {
  const list = await Transaction.find({ userId }, { ...TRANSACTION_FIELDS, _id: 1 }).sort({ date: -1 }).limit(TRANSACTIONS_SHOWN + 1).lean();
  return { transactions: list.slice(0, TRANSACTIONS_SHOWN), more: list.length > TRANSACTIONS_SHOWN };
}

// Everything kept about the account, as plain JSON for "Download my data", or null when it's gone. Sessions are
// as the account sees them in the app: acronyms its plan doesn't show yet stay locked, counted. The AI log says
// what was done and when, not what it cost us.
async function exportData(userId, now = new Date()) {
  const owner = ownerOf(userId);
  const [user, sessions, window, actions, payments, requests] = await Promise.all([
    User.findById(userId).lean(),
    BrainstormSession.find({ owner }).sort({ updatedAt: -1 }),
    Usage.findById(`owner:${owner}`).lean(),
    AiAction.find({ owner }, { _id: 0, kind: 1, variant: 1, sessionId: 1, status: 1, counted: 1, createdAt: 1 }).sort({ createdAt: 1 }).lean(),
    Transaction.find({ userId }, TRANSACTION_FIELDS).sort({ date: -1 }).lean(),
    SupportRequest.find({ userId }, { _id: 0, ref: 1, topic: 1, message: 1, email: 1, createdAt: 1 }).sort({ createdAt: -1 }).lean(),
  ]);
  if (!user) return null;
  const plan = usage.planOf({ user });
  return {
    app: brand.appName,
    exportedAt: now.toISOString(),
    account: {
      name: user.name,
      email: user.email,
      plan,
      role: user.role,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt,
      ...(user.termsAcceptedAt ? { termsAcceptedAt: user.termsAcceptedAt } : {}),
      ...(user.subscription ? { subscription: { status: user.subscription.status, startedAt: user.subscription.startedAt, currentPeriodEnd: user.subscription.currentPeriodEnd } } : {}),
    },
    sessions: sessions.map((session) => {
      const { __v, ...json } = session.toJSON();
      const { visible, locked } = usage.splitAcronyms(json.acronyms, plan);
      return { ...json, acronyms: visible, lockedAcronyms: locked };
    }),
    usage: usage.toView(plan, window, now.getTime()),
    aiActions: actions,
    transactions: payments,
    supportRequests: requests,
  };
}

// Deletes the account and everything it owns. The AI log keeps each action's cost for pricing the plans, no longer
// tied to anyone. Payments go too: the provider keeps its own records of them. So do Help center messages (the
// inbox keeps its emailed copies). The account goes last: if a step fails, it's still there to try again.
async function erase(userId) {
  const owner = ownerOf(userId);
  await BrainstormSession.deleteMany({ owner });
  await Usage.deleteOne({ _id: `owner:${owner}` });
  await AiAction.updateMany({ owner }, { $unset: { owner: 1, sessionId: 1 } });
  await AuthToken.deleteMany({ userId });
  await Transaction.deleteMany({ userId });
  await SupportRequest.deleteMany({ userId });
  await User.deleteOne({ _id: userId });
}

// A new email address waits for the link sent to it (routes/app.js /confirm-email); until it's used, the account
// keeps its own. A newer request replaces the older one. Returns the link's token.
const requestEmailChange = (userId, email) => AuthToken.issue(userId, 'email', VERIFY_LINK_HOURS, { email });

// The address waiting to be confirmed, or null
async function pendingEmail(userId) {
  const record = await AuthToken.findOne({ userId, purpose: 'email', expiresAt: { $gt: new Date() } }, { email: 1 }).lean();
  return record?.email || null;
}

const cancelEmailChange = (userId) => AuthToken.deleteMany({ userId, purpose: 'email' });

// Makes a confirmed new address the account's own. An account never confirmed at that address goes first: only the
// inbox's owner could have activated it, and they've just used the link. False when a confirmed account has the
// address (one signed up with it meanwhile).
async function applyEmailChange(userId, email) {
  const unconfirmed = await User.findOne({ email, emailVerifiedAt: null }, { _id: 1 }).lean();
  if (unconfirmed) await erase(unconfirmed._id);
  try {
    await User.updateOne({ _id: userId }, { $set: { email, emailVerifiedAt: new Date() } });
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
  return true;
}

// A password changed in settings; links to reset the old one stop working
async function setPassword(userId, password) {
  const passwordHash = await User.hashPassword(password);
  await User.updateOne({ _id: userId }, { $set: { passwordHash } });
  await AuthToken.deleteMany({ userId, purpose: 'reset' });
}

module.exports = {
  exportData,
  erase,
  transactions,
  requestEmailChange,
  pendingEmail,
  cancelEmailChange,
  applyEmailChange,
  setPassword,
  TRANSACTIONS_SHOWN,
};
