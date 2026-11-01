const crypto = require('crypto');
const express = require('express');
const { sameOrigin, normalizeEmail } = require('../middleware/auth');
const adminAuth = require('../middleware/admin');
const { tooMany, tooManyMessage } = require('../middleware/rateLimit');
const mail = require('../services/mail');
const { MAILBOXES, BODY_MAX_CHARS } = require('../config/mail');

const router = express.Router();

// The admin section is apart from the customers' app: admins are the ADMINS list, not accounts, with their own
// hostname, sign-in, cookie, layout and theme (middleware/admin.js, views/admin/partials/). A customer's login opens
// nothing here. Mounted at the root of the admin hostname only (server.js): its paths don't exist on the customers' site.

const notFound = (res) => res.status(404).render('admin/404', { title: 'Not found' });

const loginPage = (res, { next = '/', email = '', error = '', status = 200 } = {}) =>
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
  res.redirect('/login');
});

// Everything below: signed-in admins only (req.admin)
router.use(adminAuth.requireAdmin);

router.get('/', async (req, res) => {
  const unread = await mail.unreadCounts().catch(() => null);
  res.render('admin/index', { title: 'Admin', unread });
});

// ---------------------------------------------------------------------------
// Mail: the team's mailbox (services/mail.js). One page, views/admin/mail.ejs, in three columns: the folders, a folder's
// threads, and the thread open or a form. Query: box (a folder of mail.BOXES), q (what's searched for, in that folder),
// unread=1 (unread threads only), before (the list's next page), t (the thread open), reply=1, forward (the id of the
// thread's message to forward), compose=1 (a new email), done (what just happened: sent, forwarded, synced with n).

// A form's own key: sending it twice (a double click, a reload) sends one email (Resend's Idempotency-Key)
const newKey = () => crypto.randomBytes(16).toString('base64url');

// The form's starting values. A reply: from the mailbox the thread is at, to whom it's with, answering the latest
// email they sent. A forward: from that mailbox, to whomever's typed, with all of the email's attachments ticked. A new
// email: from the open folder's address.
function startDraft(box, opened, forwarding) {
  const fallback = MAILBOXES[0].address;
  if (!opened) return { from: box.address || fallback, to: '', cc: '', subject: '', body: '', answering: '', key: newKey() };
  const { thread, messages } = opened;
  if (forwarding) {
    return {
      from: thread.mailbox || fallback,
      to: '',
      cc: '',
      subject: mail.forwardSubject(forwarding.subject || thread.subject),
      body: '',
      forwarding: String(forwarding._id),
      attachments: (forwarding.attachments || []).map((a) => a.id),
      key: newKey(),
    };
  }
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
  if (query.done === 'forwarded') return { kind: 'ok', text: 'Your email was forwarded.' };
  if (query.done !== 'synced') return null;
  const n = Number(query.n) || 0;
  return n ? { kind: 'ok', text: `${n} new email${n === 1 ? '' : 's'}.` } : { kind: 'info', text: 'No new mail.' };
}

// error: a toast. formError: what's wrong with the form just sent, shown in it, like the Account tab's forms.
async function mailPage(res, { boxKey, threadId = null, compose = false, reply = false, forward = null, q = '', unreadOnly = false, before = null, draft = null, error = null, formError = null, flash = null, status = 200 }) {
  const box = mail.boxOf(boxKey);
  const syncError = await mail.syncIfStale();
  const opened = threadId ? await mail.getThread(threadId) : null;
  if (threadId && !opened) error ||= 'That conversation no longer exists.';
  // Listed before it's marked read: with Unread only on, the thread being read stays in the list
  const list = await mail.listThreads(box, { unreadOnly, before, query: q });
  if (opened?.thread.unread) await mail.markRead(opened.thread._id);
  const counts = await mail.unreadCounts();
  // The message forwarded is one of the thread's; any other id means its latest
  const forwarding = opened && forward ? opened.messages.find((m) => String(m._id) === forward) || opened.messages.at(-1) : null;
  const writing = !!forwarding || (opened ? reply : compose);
  const unreadParam = unreadOnly ? { unread: '1' } : {};
  res.status(status).render('admin/mail', {
    title: 'Internal Mail Services',
    nav: 'mail',
    fill: true,
    // The header's search bar (views/admin/partials/head.ejs), with "Check for mail" beside it. A new search starts from
    // the top of the folder; checking for mail keeps everything where it is.
    search: {
      action: '/mail',
      value: q,
      label: `Search ${box.label}`,
      maxLength: mail.QUERY_MAX_CHARS,
      hidden: { box: box.key, ...unreadParam },
      clear: `/mail?${new URLSearchParams({ box: box.key, ...unreadParam, ...(opened ? { t: String(opened.thread._id) } : {}) })}`,
      phone: !opened && !compose,
      sync: { action: '/mail/sync', hidden: { box: box.key, ...(q ? { q } : {}), ...unreadParam, ...(opened ? { t: String(opened.thread._id) } : {}) } },
    },
    q,
    mail,
    boxes: mail.BOXES,
    box,
    counts,
    list,
    opened,
    compose: compose && !opened,
    forwarding,
    unreadOnly,
    before,
    form: writing ? draft || startDraft(box, opened, forwarding) : null,
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
    reply: req.query.reply === '1',
    forward: req.query.forward ? String(req.query.forward) : null,
    q: mail.cleanQuery(req.query.q),
    unreadOnly: req.query.unread === '1',
    before: before && !Number.isNaN(before.getTime()) ? before : null,
    flash: notice(req.query),
  });
});

// A reply, a forward or a new email. A problem shows the form again as it was typed, with what's wrong.
router.post('/mail/send', sameOrigin, async (req, res) => {
  const body = req.body || {};
  const q = mail.cleanQuery(body.q);
  const view = { boxKey: body.box, threadId: body.t || null, compose: !body.t, reply: !!body.t && !body.forwarding, forward: body.forwarding ? String(body.forwarding) : null, q };
  const draft = { from: body.from, to: body.to, cc: body.cc, subject: body.subject, body: body.body, answering: body.answering, forwarding: body.forwarding, attachments: [].concat(body.attachments || []), key: body.key };
  const checked = mail.cleanDraft(body);
  if (checked.error) return mailPage(res, { ...view, draft, formError: checked.error, status: 400 });
  let message;
  try {
    message = await mail.send(checked.value, { sentBy: req.admin.email });
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { ...view, draft, formError: `Not sent. ${err.message}`, status: 502 });
  }
  // A forward starts its own thread: back to the one it came from. A reply or a new email: its thread.
  const list = { box: mail.boxOf(body.box).key, ...(q ? { q } : {}) };
  if (checked.value.forwarding) return res.redirect(`/mail?${new URLSearchParams({ ...list, t: String(body.t), done: 'forwarded' })}`);
  res.redirect(`/mail?${new URLSearchParams({ ...list, t: String(message.threadId), done: 'sent' })}`);
});

// "Check for mail": what Resend received since, now (the webhook brings it on its own once it's set up). The thread
// open, the search and the list's filter stay as they were.
router.post('/mail/sync', sameOrigin, async (req, res) => {
  const box = mail.boxOf(req.body?.box);
  const threadId = req.body?.t ? String(req.body.t) : null;
  const unreadOnly = req.body?.unread === '1';
  const q = mail.cleanQuery(req.body?.q);
  let added;
  try {
    added = await mail.sync();
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { boxKey: box.key, threadId, q, unreadOnly, error: `Couldn’t check for mail. ${err.message}`, status: 502 });
  }
  const back = new URLSearchParams({ box: box.key, ...(q ? { q } : {}), ...(unreadOnly ? { unread: '1' } : {}), ...(threadId ? { t: threadId } : {}), done: 'synced', n: String(added) });
  res.redirect(`/mail?${back}`);
});

router.post('/mail/threads/:id/unread', sameOrigin, async (req, res) => {
  const opened = await mail.getThread(req.params.id);
  if (opened) await mail.markUnread(opened.thread._id);
  const q = mail.cleanQuery(req.body?.q);
  res.redirect(`/mail?${new URLSearchParams({ box: mail.boxOf(req.body?.box).key, ...(q ? { q } : {}) })}`);
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
  if (!url) return notFound(res);
  res.redirect(url);
});

// The hostname is all admin: nothing goes on to the customers' routes
router.use((req, res) => notFound(res));

router.routes = [
  { method: 'GET', path: '/login', label: 'Admin sign-in (ADMINS only)' },
  { method: 'GET', path: '/', label: 'Admin index' },
  { method: 'GET', path: '/mail', label: 'Mail: the team’s mailbox' },
  { method: 'POST', path: '/mail/send', label: 'Mail: send a reply or a new email' },
  { method: 'POST', path: '/mail/sync', label: 'Mail: check Resend for new mail' },
];

module.exports = router;
