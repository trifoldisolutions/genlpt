const crypto = require('crypto');
const express = require('express');
const { sameOrigin, normalizeEmail } = require('../middleware/auth');
const adminAuth = require('../middleware/admin');
const { tooMany, tooManyMessage } = require('../middleware/rateLimit');
const mail = require('../services/mail');
const { MAILBOXES, BODY_MAX_CHARS } = require('../config/mail');

const router = express.Router();

// The admin section is apart from the customers' app: admins are the ADMINS list, not accounts, with their own
// sign-in, cookie, layout and theme (middleware/admin.js, views/admin/partials/). A customer's login opens nothing here.

const loginPage = (res, { next = '/admin', email = '', error = '', status = 200 } = {}) =>
  res.status(status).render('admin/login', { title: 'Sign in', next, email, error });

router.get('/login', (req, res) => loginPage(res, { next: adminAuth.safeNext(req.query.next) }));

router.post('/login', sameOrigin, async (req, res) => {
  const body = req.body || {};
  const next = adminAuth.safeNext(body.next);
  const email = normalizeEmail(body.email);
  const wait = await tooMany(['adminLoginIp', req.ip], ['adminLoginEmail', email]);
  if (wait) {
    res.set('Retry-After', String(wait));
    return loginPage(res, { next, email, error: tooManyMessage(wait), status: 429 });
  }
  const admin = await adminAuth.checkLogin(email, body.password);
  if (!admin) return loginPage(res, { next, email, error: 'Wrong email or password.', status: 401 });
  adminAuth.signIn(res, admin);
  res.redirect(next);
});

router.post('/logout', sameOrigin, (req, res) => {
  adminAuth.signOut(res);
  res.redirect('/admin/login');
});

// Everything below: signed-in admins only (req.admin)
router.use(adminAuth.requireAdmin);

router.get('/', async (req, res) => {
  const unread = await mail.unreadCounts().catch(() => null);
  res.render('admin/index', { title: 'Admin', unread });
});

// ---------------------------------------------------------------------------
// Mail: the team's mailbox (services/mail.js). One page, views/admin/mail.ejs: a folder's threads; one thread, with
// its reply form; or a new email. Query: box (a folder of mail.BOXES), t (a thread), compose=1, unread=1 (unread
// threads only), before (the list's next page), done (what just happened: sent, synced with n).

// A form's own key: sending it twice (a double click, a reload) sends one email (Resend's Idempotency-Key)
const newKey = () => crypto.randomBytes(16).toString('base64url');

// The reply form's starting values: from the mailbox the thread is at, to whom it's with, answering the latest
// email they sent. A new email starts from the open folder's address.
function startDraft(box, opened) {
  const fallback = MAILBOXES[0].address;
  if (!opened) return { from: box.address || fallback, to: '', cc: '', subject: '', body: '', answering: '', key: newKey() };
  const { thread, messages } = opened;
  const answering = [...messages].reverse().find((m) => m.direction === 'in') || messages[messages.length - 1];
  return {
    from: thread.mailbox || fallback,
    to: thread.counterpart?.address || '',
    cc: '',
    subject: mail.replySubject(answering.subject || thread.subject),
    body: '',
    answering: String(answering._id),
    key: newKey(),
  };
}

// What just happened, after a redirect: a toast (views/admin/mail.ejs, public/js/flash.js)
function notice(query) {
  if (query.done === 'sent') return { kind: 'ok', text: 'Your email was sent.' };
  if (query.done !== 'synced') return null;
  const n = Number(query.n) || 0;
  return n ? { kind: 'ok', text: `${n} new email${n === 1 ? '' : 's'}.` } : { kind: 'info', text: 'No new mail.' };
}

// error: a toast. formError: what's wrong with the form just sent, shown in it, like the Account tab's forms.
async function mailPage(res, { boxKey, threadId = null, compose = false, unreadOnly = false, before = null, draft = null, error = null, formError = null, flash = null, status = 200 }) {
  const box = mail.boxOf(boxKey);
  const syncError = await mail.syncIfStale();
  const opened = threadId ? await mail.getThread(threadId) : null;
  if (threadId && !opened) error ||= 'That conversation no longer exists.';
  if (opened?.thread.unread) await mail.markRead(opened.thread._id);
  const writing = !!opened || compose;
  const [counts, list] = await Promise.all([mail.unreadCounts(), writing ? null : mail.listThreads(box, { unreadOnly, before })]);
  res.status(status).render('admin/mail', {
    title: 'Mail',
    nav: 'mail',
    mail,
    boxes: mail.BOXES,
    box,
    counts,
    list,
    opened,
    compose: compose && !opened,
    unreadOnly,
    form: writing ? draft || startDraft(box, opened) : null,
    mailboxes: MAILBOXES,
    bodyMax: BODY_MAX_CHARS,
    formError,
    toasts: [
      flash,
      error && { kind: 'error', text: error },
      syncError && { kind: 'error', text: `Couldn’t check Resend for new mail, so the latest may be missing. ${syncError}` },
    ].filter(Boolean),
  });
}

router.get('/mail', async (req, res) => {
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  await mailPage(res, {
    boxKey: req.query.box,
    threadId: req.query.t ? String(req.query.t) : null,
    compose: req.query.compose === '1',
    unreadOnly: req.query.unread === '1',
    before: before && !Number.isNaN(before.getTime()) ? before : null,
    flash: notice(req.query),
  });
});

// A reply or a new email. A problem shows the form again as it was typed, with what's wrong.
router.post('/mail/send', sameOrigin, async (req, res) => {
  const body = req.body || {};
  const view = { boxKey: body.box, threadId: body.t || null, compose: !body.t };
  const draft = { from: body.from, to: body.to, cc: body.cc, subject: body.subject, body: body.body, answering: body.answering, key: body.key };
  const checked = mail.cleanDraft(body);
  if (checked.error) return mailPage(res, { ...view, draft, formError: checked.error, status: 400 });
  let message;
  try {
    message = await mail.send(checked.value, { sentBy: req.admin.email });
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { ...view, draft, formError: `Not sent. ${err.message}`, status: 502 });
  }
  res.redirect(`/admin/mail?box=${mail.boxOf(body.box).key}&t=${message.threadId}&done=sent`);
});

// "Check for mail": what Resend received since, now (the webhook brings it on its own once it's set up)
router.post('/mail/sync', sameOrigin, async (req, res) => {
  const box = mail.boxOf(req.body?.box);
  let added;
  try {
    added = await mail.sync();
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { boxKey: box.key, error: `Couldn’t check for mail. ${err.message}`, status: 502 });
  }
  res.redirect(`/admin/mail?box=${box.key}&done=synced&n=${added}`);
});

router.post('/mail/threads/:id/unread', sameOrigin, async (req, res) => {
  const opened = await mail.getThread(req.params.id);
  if (opened) await mail.markUnread(opened.thread._id);
  res.redirect(`/admin/mail?box=${mail.boxOf(req.body?.box).key}`);
});

// A received email's attachment: off to Resend's download link
router.get('/mail/messages/:id/attachments/:attachment', async (req, res) => {
  let url;
  try {
    url = await mail.attachmentUrl(req.params.id, req.params.attachment);
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return res.status(err.status === 404 ? 404 : 502).type('text').send(err.message);
  }
  if (!url) return res.status(404).render('public/404', { title: 'Not found' });
  res.redirect(url);
});

router.routes = [
  { method: 'GET', path: '/login', label: 'Admin sign-in (ADMINS only)' },
  { method: 'GET', path: '/', label: 'Admin index' },
  { method: 'GET', path: '/mail', label: 'Mail: the team’s mailbox' },
  { method: 'POST', path: '/mail/send', label: 'Mail: send a reply or a new email' },
  { method: 'POST', path: '/mail/sync', label: 'Mail: check Resend for new mail' },
];

module.exports = router;
