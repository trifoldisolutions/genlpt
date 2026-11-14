const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { sameOrigin, normalizeEmail } = require('../middleware/auth');
const adminAuth = require('../middleware/admin');
const { tooMany, tooManyMessage } = require('../middleware/rateLimit');
const mail = require('../services/mail');
const { MAILBOXES, BODY_MAX_CHARS, SIGNATURE_MAX_CHARS, ATTACHMENTS_MAX_BYTES, ATTACHMENTS_MAX_FILES } = require('../config/mail');

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
// Mail: the team's mailbox (services/mail.js). One page, views/admin/mail.ejs, in four columns: the folders, a folder's
// threads, the thread open, and the form to write in. Query: box (a mailbox of mail.BOXES, the first by default), folder
// (one of mail.FOLDERS, left out for the first), q (what's searched for, in that folder), unread, author, since and until (its filter: mail.cleanFilters), before (the list's next page), t (the thread open), done (what just
// happened: sent, forwarded, synced with n). The form starts empty; public/js/mail-draft.js fills it in from the Reply,
// Forward and New email links' drafts. Without the script, those links reach it through reply=1, forward (the id of the
// thread's message to forward) and compose=1.

const folderParam = (folder) => (folder.key === mail.FOLDERS[0].key ? {} : { folder: folder.key });

// A form's own key: sending it twice (a double click, a reload) sends one email (Resend's Idempotency-Key)
const newKey = () => crypto.randomBytes(16).toString('base64url');

// What a forward can send along, as the form lists it
const choicesOf = (message) => (message?.attachments || []).filter((a) => a.id).map((a) => ({ id: a.id, filename: a.filename || 'Attachment', size: mail.fileSize(a.size) }));

// The form before anything fills it in: empty. views/admin/mail.ejs shows a mailbox's address as what it goes out from.
const emptyDraft = () => ({ from: '', to: '', cc: '', subject: '', body: '', opening: '', closing: '', t: '', answering: '', forwarding: '', attachments: [], choices: [], d: '', savedFiles: [], key: newKey() });

// The form's starting values. A reply: from the mailbox the thread is at, to whom it's with, answering the latest
// email they sent. A forward: from that mailbox, to whomever's typed, with all of the email's attachments ticked. A new
// email: from the mailbox open. Other has no address of its own, so that one is left to choose.
function startDraft(box, opened = null, forwarding = null) {
  const fallback = MAILBOXES[0].address;
  if (!opened) return { ...emptyDraft(), from: box.address || '' };
  const { thread, messages } = opened;
  if (forwarding) {
    const choices = choicesOf(forwarding);
    return {
      ...emptyDraft(),
      from: thread.mailbox || fallback,
      subject: mail.forwardSubject(forwarding.subject || thread.subject),
      t: String(thread._id),
      forwarding: String(forwarding._id),
      attachments: choices.map((c) => c.id),
      choices,
    };
  }
  const answering = [...messages].reverse().find((m) => m.direction === 'in') || messages[messages.length - 1];
  return {
    ...emptyDraft(),
    from: thread.mailbox || fallback,
    to: thread.counterpart?.address || '',
    subject: mail.replySubject(answering.subject || thread.subject),
    t: String(thread._id),
    answering: String(answering._id),
  };
}

// What just happened, after a redirect: a toast (views/admin/mail.ejs, public/js/flash.js)
function notice(query) {
  if (query.done === 'sent') return { kind: 'ok', text: 'Your email was sent.' };
  if (query.done === 'forwarded') return { kind: 'ok', text: 'Your email was forwarded.' };
  if (query.done === 'drafted') return { kind: 'ok', text: 'Your draft was saved. You’ll find it in Drafts.' };
  if (query.done === 'draft-deleted') return { kind: 'info', text: 'Your draft was deleted.' };
  if (query.done === 'trashed') return { kind: 'info', text: 'The conversation was moved to Trash.' };
  if (query.done === 'restored') return { kind: 'ok', text: 'The conversation was restored.' };
  if (query.done !== 'synced') return null;
  const n = Number(query.n) || 0;
  return n ? { kind: 'ok', text: `${n} new email${n === 1 ? '' : 's'}.` } : { kind: 'info', text: 'No new mail.' };
}

// error: a toast. formError: what's wrong with the form just sent, shown in it, like the Account tab's forms.
async function mailPage(res, { admin, boxKey, folderKey, threadId = null, compose = false, reply = false, forward = null, q = '', filters = mail.cleanFilters(), before = null, draft = null, error = null, formError = null, flash = null, status = 200 }) {
  const folder = mail.folderOf(folderKey);
  const syncError = await mail.syncIfStale();
  const opened = threadId ? await mail.getThread(threadId) : null;
  if (threadId && !opened) error ||= 'That conversation no longer exists.';
  // A conversation is at one mailbox, so that's the one showing while it's open: one just sent from another, say
  const box = opened ? mail.boxOfThread(opened.thread) : mail.boxOf(boxKey);
  // Listed before it's marked read: with Unread only on, the thread being read stays in the list
  const list = folder.drafts ? { threads: [], more: false } : await mail.listThreads(box, { folder, ...filters, before, query: q });
  const savedDrafts = folder.drafts ? await mail.listDrafts(admin.email) : [];
  const around = opened && !folder.drafts ? await mail.threadsAround(box, opened.thread, { folder, ...filters, query: q }) : {};
  if (opened?.thread.unread) await mail.markRead(opened.thread._id);
  const counts = { ...(await mail.unreadCounts()), drafts: await mail.countDrafts(admin.email) };
  // The message forwarded is one of the thread's; any other id means its latest
  const forwarding = opened && forward ? opened.messages.find((m) => String(m._id) === forward) || opened.messages.at(-1) : null;
  // Whether the form comes filled in: a reply, forward or new email reached without the script, or one sent back with a problem
  const filled = !!draft || !!forwarding || (opened ? reply : compose);
  const filterParam = mail.filterParams(filters);
  const searched = folder.drafts ? mail.FOLDERS[0] : folder; // Drafts has no search: from there it looks through the Inbox
  res.status(status).render('admin/mail', {
    title: 'Internal Mail Services',
    nav: 'mail',
    fill: true,
    // The header's search bar (views/admin/partials/head.ejs), with "Check for mail" beside it. A new search starts from
    // the top of the folder; checking for mail keeps everything where it is.
    search: {
      action: '/mail',
      value: q,
      label: `Search ${searched.label}`,
      maxLength: mail.QUERY_MAX_CHARS,
      hidden: { box: box.key, ...folderParam(searched) },
      // The filter, inside the field (views/admin/partials/mail-filter.ejs). Drafts has nothing for it to narrow.
      filter: folder.drafts ? null : { ...filters, on: mail.countFilters(filters), hint: mail.filterHint(filters) },
      clear: `/mail?${new URLSearchParams({ box: box.key, ...folderParam(folder), ...filterParam, ...(opened ? { t: String(opened.thread._id) } : {}) })}`,
      phone: !opened && !compose,
      sync: { action: '/mail/sync', hidden: { box: box.key, ...folderParam(folder), ...(q ? { q } : {}), ...filterParam, ...(opened ? { t: String(opened.thread._id) } : {}) } },
    },
    q,
    // The choice of mailbox (views/admin/partials/mailbox-menu.ejs): another one opens at the same folder, with
    // nothing open. elsewhere: unread mail the mailbox chosen doesn't show.
    mailboxMenu: {
      chosen: box,
      options: mail.BOXES.map((b) => ({ ...b, href: `/mail?${new URLSearchParams({ box: b.key, ...folderParam(folder) })}`, unread: counts[b.key] || 0 })),
      elsewhere: counts.all > (counts[box.key] || 0),
    },
    mail,
    folders: mail.FOLDERS,
    folder,
    box,
    counts,
    list,
    opened,
    around,
    savedDrafts,
    filters,
    clearFilters: `/mail?${new URLSearchParams({ box: box.key, ...folderParam(folder), ...(q ? { q } : {}), ...(opened ? { t: String(opened.thread._id) } : {}) })}`,
    before,
    filled,
    form: draft ? { ...draft, choices: choicesOf(forwarding) } : filled ? startDraft(box, opened, forwarding) : emptyDraft(),
    // What the Reply, Forward and New email links fill the form with
    drafts: {
      new: startDraft(box),
      reply: opened?.messages.length ? startDraft(box, opened) : null,
      forward: Object.fromEntries((opened?.messages || []).map((m) => [String(m._id), startDraft(box, opened, m)])),
    },
    mailboxes: MAILBOXES,
    bodyMax: BODY_MAX_CHARS,
    filesMax: ATTACHMENTS_MAX_FILES,
    filesMaxBytes: ATTACHMENTS_MAX_BYTES,
    signatures: await mail.signatures(),
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
  // d: a saved draft to open: in the form, with the email it answers or forwards from
  const saved = req.query.d ? await mail.getDraft(String(req.query.d), req.admin.email) : null;
  await mailPage(res, {
    admin: req.admin,
    boxKey: mail.BOXES.find((b) => saved?.from && b.address === saved.from)?.key || req.query.box, // a saved draft is at the mailbox it's from
    folderKey: req.query.folder,
    threadId: req.query.t ? String(req.query.t) : saved?.t || null,
    compose: req.query.compose === '1',
    reply: req.query.reply === '1',
    forward: req.query.forward ? String(req.query.forward) : saved?.forwarding || null,
    q: mail.cleanQuery(req.query.q),
    filters: mail.cleanFilters(req.query),
    before: before && !Number.isNaN(before.getTime()) ? before : null,
    flash: notice(req.query),
    draft: saved && {
      ...saved,
      d: String(saved._id),
      savedFiles: (saved.files || []).map((file) => ({ id: String(file.id), filename: file.filename, contentType: file.contentType })),
      key: newKey(),
    },
  });
});

// Saved to finish later, then out of the way: the form goes back to empty, and the email it was about stays open
router.post('/mail/drafts', sameOrigin, acceptFiles, async (req, res) => {
  const body = req.body || {};
  const box = mail.boxOf(body.box);
  const folder = mail.folderOf(body.folder);
  const draft = { from: body.from, to: body.to, cc: body.cc, subject: body.subject, body: body.format === 'html' ? mail.cleanNote(body.body) : body.body, opening: body.opening, closing: body.closing, t: body.t, answering: body.answering, forwarding: body.forwarding, attachments: [].concat(body.attachments || []), d: body.d, key: body.key };
  const filters = mail.cleanFilters(body);
  const view = { admin: req.admin, boxKey: box.key, folderKey: folder.key, filters, threadId: body.t || null, compose: !body.t, reply: !!body.t && !body.forwarding, forward: body.forwarding ? String(body.forwarding) : null, draft };
  if (req.fileProblem) return mailPage(res, { ...view, formError: req.fileProblem.replace('Not sent', 'Not saved'), status: 413 });
  let saved;
  try {
    saved = await mail.saveDraft(body, { by: req.admin.email, uploads: req.files });
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { ...view, formError: `Not saved. ${err.message}`, status: 400 });
  }
  const q = mail.cleanQuery(body.q);
  const back = { box: box.key, ...folderParam(folder), ...(q ? { q } : {}), ...mail.filterParams(filters), ...(body.t && !folder.drafts ? { t: String(body.t) } : {}), ...(saved ? { done: 'drafted' } : {}) };
  res.redirect(`/mail?${new URLSearchParams(back)}`);
});

router.post('/mail/drafts/:id/delete', sameOrigin, async (req, res) => {
  await mail.deleteDraft(req.params.id, req.admin.email);
  res.sendStatus(204);
});

// A saved draft's file, back to the form that's opening it
router.get('/mail/drafts/:id/files/:file', async (req, res) => {
  const draft = await mail.getDraft(req.params.id, req.admin.email);
  const file = draft?.files?.find((f) => String(f.id) === req.params.file);
  if (!file) return notFound(res);
  res.attachment(file.filename);
  res.type(file.contentType || 'application/octet-stream');
  mail.draftFileStore.read(file.id).on('error', () => res.destroy()).pipe(res);
});

// The form's attached files, held in memory only until they're sent. filename* isn't what browsers send: utf8 keeps
// "reçu.pdf" from turning into mojibake. Too many or too big is a problem with the form, said in it.
const readFiles = multer({
  storage: multer.memoryStorage(),
  limits: { files: ATTACHMENTS_MAX_FILES, fileSize: ATTACHMENTS_MAX_BYTES },
  defParamCharset: 'utf8',
}).array('files');
function acceptFiles(req, res, next) {
  readFiles(req, res, (err) => {
    if (err && !(err instanceof multer.MulterError)) return next(err);
    if (err) {
      const problems = {
        LIMIT_FILE_SIZE: `These attachments are over the ${Math.floor(ATTACHMENTS_MAX_BYTES / 1024 / 1024)} MB an email can carry. Remove some.`,
        LIMIT_FILE_COUNT: `An email can carry ${ATTACHMENTS_MAX_FILES} attached files at most.`,
      };
      req.fileProblem = `Not sent. ${problems[err.code] || 'This message is too long.'}`;
    }
    next();
  });
}

// A reply, a forward or a new email. A problem shows the form again as it was typed, with what's wrong (the browser
// holds on to the files: public/js/mail-attachments.js).
router.post('/mail/send', sameOrigin, acceptFiles, async (req, res) => {
  const body = req.body || {};
  const q = mail.cleanQuery(body.q);
  const filters = mail.cleanFilters(body);
  const view = { admin: req.admin, boxKey: body.box, folderKey: body.folder, filters, threadId: body.t || null, compose: !body.t, reply: !!body.t && !body.forwarding, forward: body.forwarding ? String(body.forwarding) : null, q };
  // Sent back as cleaned: the editor picks it up from there
  const typed = body.format === 'html' ? mail.cleanNote(body.body) : body.body;
  const draft = { from: body.from, to: body.to, cc: body.cc, subject: body.subject, body: typed, opening: body.opening, closing: body.closing, t: body.t, answering: body.answering, forwarding: body.forwarding, attachments: [].concat(body.attachments || []), d: body.d, key: body.key };
  if (req.fileProblem) return mailPage(res, { ...view, draft, formError: req.fileProblem, status: 413 });
  const checked = mail.cleanDraft(body);
  if (checked.error) return mailPage(res, { ...view, draft, formError: checked.error, status: 400 });
  // A mailbox sends from its own address, which only a page from before that was the rule could get wrong. It comes back showing the right one.
  const own = mail.boxOf(body.box).address;
  if (own && checked.value.from.address !== own) return mailPage(res, { ...view, draft, formError: `Not sent. This mailbox sends from ${own}. Check your email and send it again.`, status: 400 });
  let message;
  try {
    message = await mail.send(checked.value, { sentBy: req.admin.email, uploads: req.files });
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { ...view, draft, formError: `Not sent. ${err.message}`, status: 502 });
  }
  // Sent: the saved draft it came from is done. The email went out, so a problem here is no reason to say otherwise.
  if (body.d) await mail.deleteDraft(String(body.d), req.admin.email).catch((err) => console.error('[mail] draft:', err.message));
  // A forward starts its own thread: back to the one it came from. A reply or a new email: its thread.
  const list = { box: mail.boxOf(body.box).key, ...folderParam(mail.folderOf(body.folder)), ...(q ? { q } : {}), ...mail.filterParams(filters) };
  if (checked.value.forwarding) return res.redirect(`/mail?${new URLSearchParams({ ...list, t: String(body.t), done: 'forwarded' })}`);
  res.redirect(`/mail?${new URLSearchParams({ ...list, t: String(message.threadId), done: 'sent' })}`);
});

// "Check for mail": what Resend received since, now (the webhook brings it on its own once it's set up). The thread
// open, the search and the list's filter stay as they were.
router.post('/mail/sync', sameOrigin, async (req, res) => {
  const box = mail.boxOf(req.body?.box);
  const folder = mail.folderOf(req.body?.folder);
  const threadId = req.body?.t ? String(req.body.t) : null;
  const filters = mail.cleanFilters(req.body);
  const q = mail.cleanQuery(req.body?.q);
  let added;
  try {
    added = await mail.sync();
  } catch (err) {
    if (!(err instanceof mail.MailError)) throw err;
    return mailPage(res, { admin: req.admin, boxKey: box.key, folderKey: folder.key, threadId, q, filters, error: `Couldn’t check for mail. ${err.message}`, status: 502 });
  }
  const back = new URLSearchParams({ box: box.key, ...folderParam(folder), ...(q ? { q } : {}), ...mail.filterParams(filters), ...(threadId ? { t: threadId } : {}), done: 'synced', n: String(added) });
  res.redirect(`/mail?${back}`);
});

// What's done to the thread open comes back to the list as it was: the forms carry it (partials/mail-thread-action.ejs)
function listPlace(body) {
  const q = mail.cleanQuery(body?.q);
  return {
    box: mail.boxOf(body?.box).key,
    ...folderParam(mail.folderOf(body?.folder)),
    ...(q ? { q } : {}),
    ...mail.filterParams(mail.cleanFilters(body)),
    ...(body?.before ? { before: String(body.before) } : {}),
  };
}

// Back to the list, with no thread open: opening it would mark it read again
router.post('/mail/threads/:id/unread', sameOrigin, async (req, res) => {
  const opened = await mail.getThread(req.params.id);
  if (opened) await mail.markUnread(opened.thread._id);
  res.redirect(`/mail?${new URLSearchParams(listPlace(req.body))}`);
});

router.post('/mail/threads/:id/star', sameOrigin, async (req, res) => {
  await mail.setStarred(req.params.id, req.body?.on === '1');
  res.redirect(`/mail?${new URLSearchParams({ ...listPlace(req.body), t: req.params.id })}`);
});

// Deleted and restored threads leave the list they were in. Nothing else opens in their place: it would be marked read.
router.post('/mail/threads/:id/trash', sameOrigin, async (req, res) => {
  await mail.setTrashed(req.params.id, true);
  res.redirect(`/mail?${new URLSearchParams({ ...listPlace(req.body), done: 'trashed' })}`);
});

router.post('/mail/threads/:id/restore', sameOrigin, async (req, res) => {
  await mail.setTrashed(req.params.id, false);
  res.redirect(`/mail?${new URLSearchParams({ ...listPlace(req.body), done: 'restored' })}`);
});

router.get('/mail/threads/:id/print', async (req, res) => {
  const opened = await mail.getThread(req.params.id);
  if (!opened) return notFound(res);
  res.render('admin/mail-print', { ...opened, mail });
});

// What goes under what's written, one for each mailbox. The form's own key for each: the mailbox's name, before its @.
const signatureField = (address) => `signature_${address.split('@')[0]}`;
function signaturesPage(res, { texts, error = null, flash = null, status = 200 }) {
  res.status(status).render('admin/signatures', {
    title: 'Signatures',
    nav: 'mail',
    mailboxes: MAILBOXES.map((m) => ({ ...m, field: signatureField(m.address), text: texts[m.address] ?? '' })),
    signatureMax: SIGNATURE_MAX_CHARS,
    error,
    toasts: flash ? [flash] : [],
  });
}

router.get('/mail/signatures', async (req, res) => {
  signaturesPage(res, { texts: await mail.signatures(), flash: req.query.done === 'saved' ? { kind: 'ok', text: 'Your signatures were saved.' } : null });
});

router.post('/mail/signatures', sameOrigin, async (req, res) => {
  const texts = Object.fromEntries(MAILBOXES.map((m) => [m.address, String(req.body?.[signatureField(m.address)] ?? '')]));
  if (Object.values(texts).some((text) => text.trim().length > SIGNATURE_MAX_CHARS)) {
    return signaturesPage(res, { texts, error: `Keep each signature under ${SIGNATURE_MAX_CHARS} characters.`, status: 400 });
  }
  await mail.saveSignatures(texts, { by: req.admin.email });
  res.redirect('/mail/signatures?done=saved');
});

// What the form's quote button shows (public/js/mail-templates.js): its openings and closings, with the name of whom To
// is for, the admin's own and the mailbox's it's from. A name is personal: not kept in the browser's cache.
router.get('/mail/templates', async (req, res) => {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 2000) : '');
  res.set('Cache-Control', 'no-store');
  res.json(await mail.templatesFor(text(req.query.to), { me: req.admin.name, from: text(req.query.from) }));
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
  { method: 'GET', path: '/mail/signatures', label: 'Mail: each mailbox’s signature' },
  { method: 'GET', path: '/mail/templates', label: 'Mail: the form’s openings and closings, named' },
];

module.exports = router;
