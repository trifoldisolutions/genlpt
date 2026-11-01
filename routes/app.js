const express = require('express');
const User = require('../models/User');
const AuthToken = require('../models/AuthToken');
const {
  signIn,
  signOut,
  signOutEverywhere,
  sameOrigin,
  normalizeEmail,
  cleanName,
  emailProblem,
  passwordProblem,
  signupProblem,
} = require('../middleware/auth');
const { clearGuest } = require('../middleware/owner');
const { tooMany, mailAllowed, tooManyMessage } = require('../middleware/rateLimit');
const { sendEmail, link } = require('../services/email');
const emails = require('../services/email/templates');
const account = require('../services/account');
const { turnstileSiteKey, checkTurnstile } = require('../services/turnstile');
const { PASSWORD_MAX_CHARS, VERIFY_LINK_HOURS, RESET_LINK_HOURS, UNVERIFIED_DAYS } = require('../config/limits');

const router = express.Router();

// The single-page brainstorm tool; session id travels in ?s=<id>. pendingEmail: an email change waiting for its
// link, for settings → Account. turnstileSiteKey: the bot check on a guest's Help center message (null: none).
router.get('/', async (req, res) => {
  const pendingEmail = req.user ? await account.pendingEmail(req.user._id).catch(() => null) : null;
  res.render('app/index', { shell: 'app', pendingEmail, turnstileSiteKey: req.user ? null : turnstileSiteKey() });
});

// ---------------------------------------------------------------------------
// Accounts. Nothing a visitor sees may differ between an email that has an account and one that doesn't:
// signup, "Send a new email" and "Forgot password?" always answer with the same page, and the email that
// fits the case goes out after the response. Login takes as long for unknown emails (User.checkNobody).

// Only same-origin paths, so ?next= can't bounce users to another site
const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/app');

const TITLES = {
  login: 'Log in',
  signup: 'Sign up',
  'check-email': 'Check your inbox',
  verify: 'Confirm your email address',
  'link-expired': 'Link no longer valid',
  forgot: 'Reset your password',
  'forgot-sent': 'Check your inbox',
  reset: 'Choose a new password',
  'confirm-email': 'Confirm your new email address',
};
const UNAVAILABLE = 'Accounts are unavailable right now. Please try again in a moment, or continue as a guest.';
const WRONG_LOGIN = 'Wrong email or password.';
// Signup's bot check (services/turnstile.js), by its result
const NOT_CHECKED = {
  missing: "The security check didn't finish. Please try again in a moment. If this keeps happening, a browser extension may be blocking it.",
  failed: "The security check didn't go through. Please try again.",
};

// Every account page shares one layout (views/app/auth.ejs); `screen` picks its form column (views/app/auth/)
function render(res, screen, locals = {}, status = 200) {
  res.status(status).render('app/auth', {
    title: TITLES[screen],
    screen,
    shell: 'auth',
    next: '/app',
    error: '',
    notice: '',
    values: {},
    turnstileSiteKey: turnstileSiteKey(), // signup's bot check; null when it's off
    ...locals,
  });
}

function renderTooMany(res, screen, seconds, locals) {
  res.set('Retry-After', String(seconds));
  render(res, screen, { ...locals, error: tooManyMessage(seconds) }, 429);
}

// Accounts need the database; while it's down there's no req.session (middleware/auth.js)
const needAccounts = (screen = 'login') => (req, res, next) => {
  if (req.session) return next();
  render(res, screen, { error: UNAVAILABLE, next: safeNext((req.body || {}).next || req.query.next) }, 503);
};

// Background work after a response: failures are logged, never shown (the page must not differ)
const later = (label, promise) => promise.catch((err) => console.error(`[${label}]`, err.message));

// The one email a signup sends: an activation link for an unconfirmed account, or (unconfirmed = null)
// a notice to the owner of the confirmed one. A newer link cancels the older one, so nothing is issued past
// the mail limit.
async function emailSignup(email, unconfirmed, next) {
  if (!(await mailAllowed(email))) return;
  if (unconfirmed) {
    const token = await AuthToken.issue(unconfirmed._id, 'verify', VERIFY_LINK_HOURS, { next });
    await sendEmail({ to: email, ...emails.verifyEmail({ url: link(`/app/verify?token=${token}`) }) });
    return;
  }
  await sendEmail({ to: email, ...emails.alreadyRegistered({ loginUrl: link('/app/login'), forgotUrl: link('/app/forgot') }) });
}

// Signup for an address: a new account, or a fresh start for one never confirmed (whoever made it can no
// longer get in, and only the inbox owner can activate it). Null when the address has a confirmed account,
// which is left untouched. The signup form says that creating an account accepts the terms.
async function registerUnconfirmed({ name, email }, passwordHash) {
  const now = Date.now();
  try {
    return await User.findOneAndUpdate(
      { email, emailVerifiedAt: null },
      { $set: { name, passwordHash, termsAcceptedAt: new Date(now), deleteAfter: new Date(now + UNVERIFIED_DAYS * 24 * 60 * 60 * 1000) } },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );
  } catch (err) {
    if (err.code === 11000) return null; // the unique email index: a confirmed account has it
    throw err;
  }
}

const authPage = (screen) => (req, res) => {
  const next = safeNext(req.query.next);
  if (res.locals.user) return res.redirect(next);
  render(res, screen, { next });
};

router.get('/login', authPage('login'));
router.get('/signup', authPage('signup'));

// Logging in leaves this browser's guest alone: the app then asks whether its sessions are this user's
router.post('/login', sameOrigin, needAccounts('login'), async (req, res) => {
  const body = req.body || {};
  const next = safeNext(body.next);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const locals = { next, values: { email } };
  const wait = await tooMany(['loginIp', req.ip], ['loginEmail', email]);
  if (wait) return renderTooMany(res, 'login', wait, locals);

  const user = email && password.length <= PASSWORD_MAX_CHARS ? await User.findOne({ email }).select('+passwordHash') : null;
  const ok = user ? await user.checkPassword(password) : await User.checkNobody(password);
  if (!ok) return render(res, 'login', { ...locals, error: WRONG_LOGIN }, 401);
  // Only someone with the right password learns the account isn't confirmed yet
  if (!user.emailVerifiedAt) return render(res, 'login', { ...locals, notice: 'unverified' }, 403);
  await signIn(req, user);
  res.redirect(next);
});

// Signup never logs in: the confirmation link does. The page is the same whether or not the email is taken.
router.post('/signup', sameOrigin, needAccounts('signup'), async (req, res) => {
  const body = req.body || {};
  const next = safeNext(body.next);
  const values = { name: cleanName(body.name), email: normalizeEmail(body.email) };
  const password = typeof body.password === 'string' ? body.password : '';
  const problem = signupProblem({ ...values, password });
  if (problem) return render(res, 'signup', { next, values, error: problem }, 400);
  const wait = await tooMany(['signupIp', req.ip]);
  if (wait) return renderTooMany(res, 'signup', wait, { next, values });
  const check = await checkTurnstile(body['cf-turnstile-response'], req.ip);
  if (check === 'unavailable') return render(res, 'signup', { next, values, error: UNAVAILABLE }, 503);
  if (check !== 'ok') return render(res, 'signup', { next, values, error: NOT_CHECKED[check] }, 400);

  const passwordHash = await User.hashPassword(password); // hashed even for a taken email: same time either way
  const unconfirmed = await registerUnconfirmed(values, passwordHash);
  later('signup email', emailSignup(values.email, unconfirmed, next));
  render(res, 'check-email', { next, values: { email: values.email } });
});

// "Send a new email" (check-inbox page, or login with an unconfirmed account): repeats whatever signup sent
router.post('/signup/resend', sameOrigin, needAccounts('login'), async (req, res) => {
  const body = req.body || {};
  const next = safeNext(body.next);
  const email = normalizeEmail(body.email);
  const locals = { next, values: { email }, notice: 'resent' };
  const wait = await tooMany(['signupIp', req.ip]);
  if (wait) return renderTooMany(res, 'check-email', wait, locals);
  if (!emailProblem(email)) {
    later('resend email', User.findOne({ email }).lean().then((user) => user && emailSignup(email, user.emailVerifiedAt ? null : user, next)));
  }
  render(res, 'check-email', locals);
});

// The link in the email shows a page with a button; only the button (a POST) confirms. Mail scanners
// open links to check them, and would otherwise use up the single-use token before the person can.
router.get('/verify', needAccounts(), async (req, res) => {
  const token = String(req.query.token || '');
  const record = await AuthToken.peek(token, 'verify');
  const user = record && (await User.findById(record.userId).lean());
  if (!user) return render(res, 'link-expired', { kind: 'verify' }, 410);
  render(res, 'verify', { token, values: { email: user.email } });
});

router.post('/verify', sameOrigin, needAccounts(), async (req, res) => {
  const record = await AuthToken.consume(String((req.body || {}).token || ''), 'verify');
  if (!record) return render(res, 'link-expired', { kind: 'verify' }, 410);
  await User.updateOne({ _id: record.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() }, $unset: { deleteAfter: 1 } });
  const user = await User.findById(record.userId);
  if (!user) return render(res, 'link-expired', { kind: 'verify' }, 410);
  await signIn(req, user);
  res.redirect(safeNext(record.next));
});

router.get('/forgot', (req, res) => {
  render(res, 'forgot', { values: { email: normalizeEmail(req.query.email) } });
});

router.post('/forgot', sameOrigin, needAccounts('forgot'), async (req, res) => {
  const email = normalizeEmail((req.body || {}).email);
  const problem = emailProblem(email);
  if (problem) return render(res, 'forgot', { values: { email }, error: problem }, 400);
  const wait = await tooMany(['forgotIp', req.ip]);
  if (wait) return renderTooMany(res, 'forgot', wait, { values: { email } });
  later('reset email', (async () => {
    const user = await User.findOne({ email }).lean();
    if (!user || !(await mailAllowed(email))) return;
    const token = await AuthToken.issue(user._id, 'reset', RESET_LINK_HOURS);
    await sendEmail({ to: email, ...emails.resetPassword({ url: link(`/app/reset?token=${token}`) }) });
  })());
  render(res, 'forgot-sent', { values: { email } });
});

// The reset form, for a link that's still valid
async function resetForm(res, token, locals = {}, status = 200) {
  const record = await AuthToken.peek(token, 'reset');
  const user = record && (await User.findById(record.userId).lean());
  if (!user) return render(res, 'link-expired', { kind: 'reset' }, 410);
  render(res, 'reset', { token, values: { email: user.email }, ...locals }, status);
}

router.get('/reset', needAccounts(), (req, res) => resetForm(res, String(req.query.token || '')));

// A new password also confirms the email (the link proved the inbox) and logs out every other device
router.post('/reset', sameOrigin, needAccounts(), async (req, res) => {
  const body = req.body || {};
  const token = String(body.token || '');
  const password = typeof body.password === 'string' ? body.password : '';
  const problem = passwordProblem(password);
  if (problem) return resetForm(res, token, { error: problem }, 400);

  const record = await AuthToken.consume(token, 'reset');
  if (!record) return render(res, 'link-expired', { kind: 'reset' }, 410);
  const passwordHash = await User.hashPassword(password);
  await User.updateOne({ _id: record.userId }, { $set: { passwordHash } });
  await User.updateOne({ _id: record.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() }, $unset: { deleteAfter: 1 } });
  const user = await User.findById(record.userId);
  if (!user) return render(res, 'link-expired', { kind: 'reset' }, 410);
  await signOutEverywhere(user._id);
  await signIn(req, user);
  res.redirect('/app');
});

// The link sent to a new email address (settings → Account, routes/api.js). Like /verify, only the button confirms.
// It works only while logged in to the account that asked, so whoever owns a mistyped address can't take the account
// over by using it: logged out, the page asks to log in first, and the login comes back here.
async function emailChangeLink(req, res, token) {
  const record = await AuthToken.peek(token, 'email');
  if (!record) {
    render(res, 'link-expired', { kind: 'email' }, 410);
    return null;
  }
  const values = { email: record.email };
  if (!req.user) {
    render(res, 'confirm-email', { step: 'login', values, next: `/app/confirm-email?token=${encodeURIComponent(token)}` });
    return null;
  }
  if (String(req.user._id) !== String(record.userId)) {
    render(res, 'confirm-email', { step: 'other', title: 'This link is for another account' }, 403);
    return null;
  }
  return record;
}

router.get('/confirm-email', needAccounts(), async (req, res) => {
  const token = String(req.query.token || '');
  const record = await emailChangeLink(req, res, token);
  if (record) render(res, 'confirm-email', { step: 'confirm', token, values: { email: record.email } });
});

// The previous address gets a notice once the change is done
router.post('/confirm-email', sameOrigin, needAccounts(), async (req, res) => {
  const token = String((req.body || {}).token || '');
  if (!(await emailChangeLink(req, res, token))) return;
  const record = await AuthToken.consume(token, 'email');
  if (!record) return render(res, 'link-expired', { kind: 'email' }, 410);
  const values = { email: record.email };
  if (!(await account.applyEmailChange(req.user._id, record.email))) {
    return render(res, 'confirm-email', { step: 'taken', title: 'This email address is already in use', values }, 409);
  }
  const previous = req.user.email;
  later('email changed email', (async () => {
    if (await mailAllowed(previous)) await sendEmail({ to: previous, ...emails.emailChanged() });
  })());
  render(res, 'confirm-email', { step: 'done', title: 'Your email address has been changed', values });
});

// Forgets the guest too, so the next person on this browser starts fresh
router.post('/logout', sameOrigin, async (req, res) => {
  await signOut(req, res);
  clearGuest(req, res);
  res.redirect('/app');
});

router.routes = [
  { method: 'GET', path: '/', label: 'Acronym brainstorm tool' },
  { method: 'GET', path: '/login', label: 'Log in' },
  { method: 'GET', path: '/signup', label: 'Sign up' },
  { method: 'POST', path: '/login', label: 'Log in (form)' },
  { method: 'POST', path: '/signup', label: 'Sign up (form)' },
  { method: 'POST', path: '/signup/resend', label: 'Send a new signup email' },
  { method: 'GET', path: '/verify', label: 'Confirm email (link from the email)' },
  { method: 'POST', path: '/verify', label: 'Confirm email (button)' },
  { method: 'GET', path: '/forgot', label: 'Forgot password' },
  { method: 'POST', path: '/forgot', label: 'Send a reset link' },
  { method: 'GET', path: '/reset', label: 'Choose a new password (link from the email)' },
  { method: 'POST', path: '/reset', label: 'Save the new password' },
  { method: 'GET', path: '/confirm-email', label: 'Confirm a new email address (link from the email)' },
  { method: 'POST', path: '/confirm-email', label: 'Confirm a new email address (button)' },
  { method: 'POST', path: '/logout', label: 'Log out' },
];

module.exports = router;
