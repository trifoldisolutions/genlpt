const crypto = require('crypto');
const MailMessage = require('../models/MailMessage');
const MailThread = require('../models/MailThread');
const { normalizeEmail, emailProblem } = require('../middleware/auth');
const { MAILBOXES, TIME_ZONE, HTML_MAX_CHARS, TEXT_MAX_CHARS, BODY_MAX_CHARS, RECIPIENTS_MAX } = require('../config/mail');

// The team's mailbox (Admin → Mail, routes/admin.js). Email to any address of the domain is received by Resend, which
// keeps it 30 days: the app copies each one into mail_messages, grouped in mail_threads, where admins read and answer
// it. Two ways in, both through ingest(): Resend's webhook as each email arrives (routes/webhooks.js), and sync(),
// which asks Resend for what came in since (opening the mailbox, "Check for mail"), so nothing is missed while the
// webhook is down or can't reach the app (local dev). Replies go out through Resend from the mailbox's address.
// Reading received emails takes a Resend key with Full access, not Sending access.

const RESEND_URL = 'https://api.resend.com';
const TIMEOUT_MS = 15000;
const WEBHOOK_TOLERANCE_S = 5 * 60; // Svix's own: an older delivery could be a replay
const SYNC_EVERY_MS = 60 * 1000; // opening the mailbox asks Resend at most this often
const SYNC_PAGES = 10; // 100 emails each: a first sync takes up to Resend's 30 days' worth
const SUBJECT_MATCH_DAYS = 60; // a reply whose headers name no message of ours joins a thread with its subject this recent
const QUOTE_MAX_CHARS = 4000; // the message answered, quoted under a reply
const SUBJECT_MAX_CHARS = 300;

const MAILBOX_ADDRESSES = MAILBOXES.map((m) => m.address);

class MailError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status; // Resend's HTTP status, when it answered
  }
}

// Resend's API. Throws a MailError whose message says what to fix.
async function resend(path, { method = 'GET', body, idempotencyKey, fetchImpl = fetch } = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new MailError('no_key', 'RESEND_API_KEY is not set, so the mailbox can’t reach Resend.');
  let res;
  try {
    res = await fetchImpl(RESEND_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MailError('unreachable', `Resend didn’t answer (${err.message}). Try again in a moment.`);
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  if (res.status === 401 || res.status === 403) {
    throw new MailError('key_refused', `Resend refused the API key (${data?.message || res.status}). Reading received emails needs a key with Full access.`, res.status);
  }
  throw new MailError('resend_error', `Resend answered ${res.status}: ${String(data?.message || '').slice(0, 300)}`, res.status);
}

// ---------------------------------------------------------------------------
// Webhook

// Whether a webhook really comes from Resend: it's signed the Svix way (https://docs.svix.com/receiving/verifying-payloads/how-manual),
// an HMAC-SHA256 of "<svix-id>.<svix-timestamp>.<raw body>" keyed with the secret after its whsec_ prefix, base64.
// svix-signature lists one or more "v1,<base64>": any match will do (the secret may be mid-rotation).
function verifyWebhook(rawBody, headers, secret = process.env.RESEND_WEBHOOK_SECRET, now = Date.now()) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];
  if (!secret || !id || !timestamp || !signatures || !rawBody) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = crypto
    .createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();
  return String(signatures).split(' ').some((entry) => {
    const [version, signature] = entry.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// ---------------------------------------------------------------------------
// Reading an email

// "Ana Lima <ana@example.com>" → { name: 'Ana Lima', address: 'ana@example.com' }; a bare address has no name
function parseAddress(value) {
  const s = String(value || '').trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^<>]+)>$/);
  return m ? { name: m[1].trim(), address: normalizeEmail(m[2]) } : { name: '', address: normalizeEmail(s) };
}

const formatAddress = ({ name, address }) => (name ? `${name} <${address}>` : address);

// Resend's to, cc, reply_to: a list, one address, or nothing → addresses, without names
const addresses = (value) => [].concat(value || []).map((a) => parseAddress(a).address).filter(Boolean);

// A header from Resend's headers object (lowercase names); a repeated one may come as a list: the last one counts
function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[value.length - 1] || '' : value || '';
}

// The <message-ids> a header names (Message-ID, In-Reply-To, References)
const messageIds = (value) => String(value || '').match(/<[^<>\s]+>/g) || [];

// "Re: Fwd: RE: Billing" → "Billing": what a thread's replies have in common (AW, WG: German; TR: French; SV: Nordic…)
const SUBJECT_PREFIXES = /^\s*((re|fwd?|aw|wg|tr|sv|vs|rv|antw)\s*(\[\d+\])?\s*:\s*)+/i;
const baseSubject = (subject) => String(subject || '').replace(SUBJECT_PREFIXES, '').trim();
const replySubject = (subject) => (/^\s*re\s*:/i.test(subject || '') ? subject : `Re: ${baseSubject(subject) || subject || ''}`.trim());

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntity(match, entity) {
  if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? match;
  const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  try {
    return String.fromCodePoint(code);
  } catch {
    return match;
  }
}

// An HTML email's words, for the list's snippet and for quoting it under a reply (never shown as HTML)
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const bodyText = (message) => (message.text ? String(message.text) : htmlToText(message.html));
const snippetOf = (message) => bodyText(message).replace(/\s+/g, ' ').trim().slice(0, 160);

// Which mailbox an email came to: the first of ours among its addresses; null: Other
const mailboxOf = (list) => list.find((a) => MAILBOX_ADDRESSES.includes(a)) || null;

// A received email as Resend's Receiving API returns it → the fields of its MailMessage
function receivedFields(email) {
  const headers = email.headers || {};
  const from = parseAddress(header(headers, 'from') || email.from);
  if (!from.address) from.address = parseAddress(email.from).address;
  const to = addresses(email.to);
  const cc = addresses(email.cc);
  return {
    direction: 'in',
    resendId: email.id,
    mailbox: mailboxOf([...to, ...cc, ...addresses(email.received_for)]),
    messageId: email.message_id || messageIds(header(headers, 'message-id'))[0] || null,
    inReplyTo: messageIds(header(headers, 'in-reply-to'))[0] || null,
    references: messageIds(header(headers, 'references')).slice(-50),
    from,
    to,
    cc,
    replyTo: addresses(email.reply_to),
    subject: String(email.subject || '').slice(0, SUBJECT_MAX_CHARS),
    text: email.text ? String(email.text).slice(0, TEXT_MAX_CHARS) : null,
    html: email.html || null,
    attachments: (email.attachments || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
      contentId: a.content_id,
      disposition: a.content_disposition,
    })),
    authentication: email.authentication || undefined,
    date: new Date(email.created_at || Date.now()),
    read: false,
  };
}

// Who a received email is from, for answering: its Reply-To when it has one (Help center's messages come from our own
// no-reply address, with the sender as Reply-To), else its sender
const counterpartOf = (fields) => (fields.replyTo[0] ? { name: '', address: fields.replyTo[0] } : fields.from);

// ---------------------------------------------------------------------------
// Threads

// The thread a message joins: the one holding a message its In-Reply-To or References names; else, for a reply
// (Re: …) whose headers name none of ours, the latest recent thread with the same subject and person; else null (new)
async function findThread(fields, counterpart) {
  const ids = [fields.inReplyTo, ...fields.references].filter(Boolean);
  if (ids.length) {
    const earlier = await MailMessage.findOne({ messageId: { $in: ids } }, { threadId: 1 }).sort({ date: -1 }).lean();
    if (earlier) return earlier.threadId;
  }
  const subject = baseSubject(fields.subject);
  if (!subject || subject === fields.subject.trim()) return null;
  const since = new Date(fields.date.getTime() - SUBJECT_MATCH_DAYS * 24 * 60 * 60 * 1000);
  const thread = await MailThread.findOne(
    { mailbox: fields.mailbox, subject, 'counterpart.address': counterpart.address, lastAt: { $gt: since } },
    { _id: 1 }
  ).sort({ lastAt: -1 }).lean();
  return thread?._id || null;
}

// Saves a message in its thread (threadId, else findThread, else a new one) and brings the thread up to date.
// A message already saved (same Resend id) comes back as it was.
async function file(fields, { threadId = null, counterpart }) {
  if (fields.resendId) {
    const saved = await MailMessage.findOne({ resendId: fields.resendId }).lean();
    if (saved) return saved;
  }
  let id = threadId || (await findThread(fields, counterpart));
  let created = false;
  if (!id) {
    const thread = await MailThread.create({
      mailbox: fields.mailbox,
      subject: baseSubject(fields.subject) || fields.subject.trim(),
      counterpart,
      lastAt: fields.date,
    });
    id = thread._id;
    created = true;
  }
  let message;
  try {
    message = (await MailMessage.create({ ...fields, threadId: id })).toObject();
  } catch (err) {
    if (err.code !== 11000) throw err;
    if (created) await MailThread.deleteOne({ _id: id }); // the webhook and a sync crossed: the other one saved it
    return MailMessage.findOne({ resendId: fields.resendId }).lean();
  }
  const unread = fields.direction === 'in' ? 1 : 0;
  await MailThread.updateOne({ _id: id }, { $inc: { messages: 1, unread } });
  // A sync can save an older message after a newer one: only the latest one is the thread's last
  await MailThread.updateOne(
    { _id: id, $or: [{ lastAt: { $lte: fields.date } }, { snippet: null }] },
    { $set: { lastAt: fields.date, snippet: snippetOf(fields), lastDirection: fields.direction } }
  );
  return message;
}

// ---------------------------------------------------------------------------
// Receiving

// Saves the email Resend received under this id, once; null when it was already saved
async function ingest(resendId) {
  if (await MailMessage.exists({ resendId })) return null;
  const path = `/emails/receiving/${encodeURIComponent(resendId)}`;
  let email = await resend(path);
  if (email.html && email.html.length > HTML_MAX_CHARS) {
    // Inline images come as data: URIs by default; without them it may fit (they're still among the attachments)
    const { html } = await resend(`${path}?html_format=cid`);
    email = { ...email, html: html && html.length <= HTML_MAX_CHARS ? html : null };
  }
  const fields = receivedFields(email);
  return file(fields, { counterpart: counterpartOf(fields) });
}

// Saves what Resend received that the mailbox doesn't have yet, oldest first, so a reply finds the email it answers.
// Resend lists newest first: pages are read until one holds an email already saved. Returns how many were added.
// One sync at a time: a second call waits for the one going on.
let syncing = null;
let lastSyncAt = 0;
function sync() {
  syncing ||= (async () => {
    try {
      const fresh = [];
      let after = null;
      for (let page = 0; page < SYNC_PAGES; page++) {
        const list = await resend(`/emails/receiving?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        const items = list?.data || [];
        const saved = new Set((await MailMessage.find({ resendId: { $in: items.map((e) => e.id) } }, { resendId: 1 }).lean()).map((m) => m.resendId));
        fresh.push(...items.filter((e) => !saved.has(e.id)).map((e) => e.id));
        if (!list?.has_more || saved.size > 0 || !items.length) break;
        after = items[items.length - 1].id;
      }
      let added = 0;
      for (const id of fresh.reverse()) if (await ingest(id)) added++;
      lastSyncAt = Date.now();
      return added;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// Opening the mailbox: a sync if the last one is a minute old. Returns the error to show, or null.
async function syncIfStale() {
  if (Date.now() - lastSyncAt < SYNC_EVERY_MS) return null;
  try {
    await sync();
    return null;
  } catch (err) {
    lastSyncAt = Date.now(); // don't ask again on every page while Resend refuses
    console.error('[mail] sync:', err.message);
    return err.message;
  }
}

// A link to download a received email's attachment: Resend's, valid an hour, asked for each time. Null when the
// message has no such attachment. Resend keeps attachments 30 days: past that it can't give one (a MailError).
async function attachmentUrl(messageId, attachmentId) {
  const message = isId(messageId) ? await MailMessage.findById(messageId, { direction: 1, resendId: 1, attachments: 1 }).lean() : null;
  if (message?.direction !== 'in' || !message.attachments?.some((a) => a.id === attachmentId)) return null;
  try {
    const att = await resend(`/emails/receiving/${encodeURIComponent(message.resendId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return att?.download_url || null;
  } catch (err) {
    if (err.status === 404) throw new MailError('gone', 'Resend no longer has this attachment: it keeps emails 30 days.', 404);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sending

const isId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);

// "a@x.com, Ana <b@y.com>; c@z.com" → { value: [addresses] } or { error }
function addressList(value) {
  const list = [];
  for (const part of String(value || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const { address } = parseAddress(part);
    if (emailProblem(address)) return { error: `“${part}” isn’t a valid email address.` };
    if (!list.includes(address)) list.push(address);
  }
  return { value: list };
}

// The compose or reply form, checked: { value } or { error } (a message for the form)
function cleanDraft(body) {
  const from = MAILBOXES.find((m) => m.address === body?.from);
  if (!from) return { error: 'Choose the address to send from.' };
  const to = addressList(body.to);
  if (to.error) return to;
  if (!to.value.length) return { error: 'Add at least one recipient.' };
  const cc = addressList(body.cc);
  if (cc.error) return cc;
  if (to.value.length + cc.value.length > RECIPIENTS_MAX) return { error: `Send to ${RECIPIENTS_MAX} addresses at most.` };
  const subject = String(body.subject || '').replace(/\s+/g, ' ').trim();
  if (!subject) return { error: 'Add a subject.' };
  if (subject.length > SUBJECT_MAX_CHARS) return { error: `Keep the subject under ${SUBJECT_MAX_CHARS} characters.` };
  const text = String(body.body || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: 'Write a message.' };
  if (text.length > BODY_MAX_CHARS) return { error: `Keep the message under ${BODY_MAX_CHARS} characters.` };
  return {
    value: {
      from,
      to: to.value,
      cc: cc.value,
      subject,
      text,
      answering: isId(body.answering) ? body.answering : null,
      key: typeof body.key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.key) ? body.key : null,
    },
  };
}

// The message answered, under a reply: "On <date>, <who> wrote:" then its lines, each behind "> "
function quoted(message) {
  const body = bodyText(message).trim().slice(0, QUOTE_MAX_CHARS);
  return `On ${fullDate(message.date)}, ${formatAddress(message.from)} wrote:\n${body.split('\n').map((line) => `> ${line}`).join('\n')}`;
}

// A reply's In-Reply-To and References, so the recipient's mail app files it with the email it answers
function replyHeaders(answering) {
  if (!answering?.messageId) return { references: [], headers: undefined };
  const references = [...new Set([...(answering.references || []), answering.messageId])].slice(-20);
  return { references, headers: { 'In-Reply-To': answering.messageId, References: references.join(' ') } };
}

// Sends a checked draft (cleanDraft) from its mailbox: a reply when it answers a message, else a new thread. The
// draft's key makes a form sent twice (a double click, a reload) one email. Returns the saved message.
async function send(draft, { sentBy = null } = {}) {
  const answering = draft.answering ? await MailMessage.findById(draft.answering).lean() : null;
  const text = answering ? `${draft.text}\n\n${quoted(answering)}` : draft.text;
  const { references, headers } = replyHeaders(answering);
  const sent = await resend('/emails', {
    method: 'POST',
    idempotencyKey: draft.key,
    body: { from: formatAddress(draft.from), to: draft.to, ...(draft.cc.length ? { cc: draft.cc } : {}), subject: draft.subject, text, headers },
  });
  const thread = answering ? await MailThread.findById(answering.threadId).lean() : null;
  const counterpart = thread?.counterpart?.address === draft.to[0] ? thread.counterpart : { name: '', address: draft.to[0] };
  const message = await file({
    direction: 'out',
    resendId: sent.id,
    mailbox: draft.from.address,
    inReplyTo: answering?.messageId || null,
    references,
    from: { name: draft.from.name, address: draft.from.address },
    to: draft.to,
    cc: draft.cc,
    replyTo: [],
    subject: draft.subject,
    text,
    date: new Date(),
    sentBy,
  }, { threadId: answering?.threadId || null, counterpart });
  if (answering) await markRead(answering.threadId);
  // Resend gives the email its Message-ID: once known, a reply that names only it still finds this thread
  setTimeout(() => {
    resend(`/emails/${encodeURIComponent(sent.id)}`)
      .then((e) => e?.message_id && MailMessage.updateOne({ _id: message._id }, { $set: { messageId: e.message_id } }))
      .catch((err) => console.error('[mail] message id:', err.message));
  }, 3000).unref();
  return message;
}

// ---------------------------------------------------------------------------
// The mailbox's views

// The list's folders: every mailbox's mail, each mailbox, and Other (addresses of the domain that aren't one)
const localPart = (address) => address.split('@')[0];
const BOXES = [
  { key: 'all', label: 'All mail' },
  ...MAILBOXES.map((m) => ({ key: localPart(m.address), label: localPart(m.address)[0].toUpperCase() + localPart(m.address).slice(1), address: m.address })),
  { key: 'other', label: 'Other' },
];
const boxOf = (key) => BOXES.find((b) => b.key === key) || BOXES[0];
const boxFilter = (box) => (box.key === 'all' ? {} : { mailbox: box.key === 'other' ? null : box.address });

const LIST_SIZE = 50;

// A folder's threads, latest first, LIST_SIZE at a time (before: the lastAt to continue from)
async function listThreads(box, { unreadOnly = false, before = null } = {}) {
  const filter = { ...boxFilter(box), messages: { $gt: 0 } };
  if (unreadOnly) filter.unread = { $gt: 0 };
  if (before) filter.lastAt = { $lt: before };
  const threads = await MailThread.find(filter).sort({ lastAt: -1 }).limit(LIST_SIZE + 1).lean();
  return { threads: threads.slice(0, LIST_SIZE), more: threads.length > LIST_SIZE };
}

// Unread messages by folder key
async function unreadCounts() {
  const rows = await MailThread.aggregate([{ $match: { unread: { $gt: 0 } } }, { $group: { _id: '$mailbox', unread: { $sum: '$unread' } } }]);
  const counts = { all: 0 };
  for (const row of rows) {
    const key = row._id ? localPart(row._id) : 'other';
    counts[key] = (counts[key] || 0) + row.unread;
    counts.all += row.unread;
  }
  return counts;
}

async function getThread(id) {
  if (!isId(id)) return null;
  const thread = await MailThread.findById(id).lean();
  if (!thread) return null;
  const messages = await MailMessage.find({ threadId: thread._id }).sort({ date: 1 }).lean();
  return { thread, messages };
}

async function markRead(threadId) {
  await MailMessage.updateMany({ threadId, direction: 'in', read: false }, { $set: { read: true } });
  await MailThread.updateOne({ _id: threadId }, { $set: { unread: 0 } });
}

// Back to unread: its latest received message
async function markUnread(threadId) {
  const latest = await MailMessage.findOne({ threadId, direction: 'in' }, { _id: 1 }).sort({ date: -1 }).lean();
  if (!latest) return;
  await MailMessage.updateOne({ _id: latest._id }, { $set: { read: false } });
  await MailThread.updateOne({ _id: threadId }, { $set: { unread: 1 } });
}

// Dates in the business's time zone: the list's short one (a time today, a day this year, else a full date) and a message's
const dateParts = (date, options) => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, ...options }).format(date);
function shortDate(date, now = new Date()) {
  const day = (d) => dateParts(d, { dateStyle: 'short' });
  if (day(date) === day(now)) return dateParts(date, { hour: 'numeric', minute: '2-digit' });
  if (dateParts(date, { year: 'numeric' }) === dateParts(now, { year: 'numeric' })) return dateParts(date, { month: 'short', day: 'numeric' });
  return dateParts(date, { dateStyle: 'medium' });
}
const fullDate = (date) => dateParts(date, { dateStyle: 'medium', timeStyle: 'short' });

// What a received email's HTML is shown in: a frame with no scripts, forms or access to the page (sandbox, in the
// view); links open in a new tab. Images from other sites stay out: the page's CSP doesn't allow them (no tracking
// pixels); the email's own, inlined as data: URIs, show.
const frameDoc = (html) => `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;color:#18181b;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;

// Whether the receiving server found the sender's address forged or unconfirmed: shown as a warning
function unverified(message) {
  const auth = message.direction === 'in' && message.authentication;
  return !!auth && (auth.dmarc === 'fail' || (auth.spf === 'fail' && auth.dkim === 'fail'));
}

module.exports = {
  MailError,
  verifyWebhook,
  ingest,
  sync,
  syncIfStale,
  attachmentUrl,
  cleanDraft,
  send,
  BOXES,
  boxOf,
  listThreads,
  unreadCounts,
  getThread,
  markRead,
  markUnread,
  replySubject,
  shortDate,
  fullDate,
  frameDoc,
  unverified,
  formatAddress,
  // for tests
  parseAddress,
  addressList,
  baseSubject,
  messageIds,
  htmlToText,
  receivedFields,
  counterpartOf,
  replyHeaders,
  quoted,
};
