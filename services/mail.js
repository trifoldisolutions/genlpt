const crypto = require('crypto');
const mongoose = require('mongoose');
const sanitizeHtml = require('sanitize-html');
const MailMessage = require('../models/MailMessage');
const MailThread = require('../models/MailThread');
const MailSignature = require('../models/MailSignature');
const MailDraft = require('../models/MailDraft');
const User = require('../models/User');
const { esc } = require('./email/design');
const { mailboxMessage } = require('./email/templates');
const { normalizeEmail, emailProblem } = require('../middleware/auth');
const brand = require('../config/brand');
const { MAILBOXES, TIME_ZONE, HTML_MAX_CHARS, TEXT_MAX_CHARS, BODY_MAX_CHARS, RECIPIENTS_MAX, TEMPLATES, ATTACHMENTS_MAX_BYTES } = require('../config/mail');

// The team's mailbox (Admin → Mail, routes/admin.js). Email to any address of the domain is received by Resend, which
// keeps it 30 days: the app copies each one into mail_messages, grouped in mail_threads, where admins read and answer
// it. Two ways in, both through ingest(): Resend's webhook as each email arrives (routes/webhooks.js), and sync(),
// which asks Resend for what came in since (opening the mailbox, "Check for mail"), so nothing is missed while the
// webhook is down or can't reach the app (local dev). Replies go out through Resend from the mailbox's address.
// Reading received emails takes a Resend key with Full access, not Sending access.

const RESEND_URL = 'https://api.resend.com';
const TIMEOUT_MS = 15000;
const ATTACHMENTS_TIMEOUT_MS = 60000; // downloading a forward's attachments, and sending them
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
async function resend(path, { method = 'GET', body, idempotencyKey, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
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
      signal: AbortSignal.timeout(timeoutMs),
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
const forwardSubject = (subject) => `Fwd: ${baseSubject(subject) || subject || ''}`.trim();

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
// The start of what an email says: what comes before its signature, marked the standard way, "-- " on its own line
const snippetOf = (message) => {
  const body = bodyText(message);
  return (body.split(/\n-- ?\n/)[0].trim() || body).replace(/\s+/g, ' ').trim().slice(0, 160);
};

// Plain text, apart from the quote that ends it: its "> " lines, without those marks, under their "On <date>, <who>
// wrote:" (which a mail app may wrap onto a second line). Lines quoted between someone's answers stay in what they wrote.
const ATTRIBUTION = /^(?:On|Le) .*(?:wrote|a écrit)\s?:\s*$/;
function splitQuote(text) {
  const lines = String(text).split(/\r?\n/);
  let start = lines.length;
  while (start > 0 && /^\s*(?:>|$)/.test(lines[start - 1])) start -= 1;
  if (!lines.slice(start).some((line) => line.trim())) return { written: String(text), quote: '' };
  if (ATTRIBUTION.test(lines[start - 1])) start -= 1;
  else if (ATTRIBUTION.test(`${lines[start - 2]} ${lines[start - 1]}`)) start -= 2;
  return {
    written: lines.slice(0, start).join('\n').trimEnd(),
    quote: lines.slice(start).map((line) => line.replace(/^\s*> ?/, '')).join('\n').trim(),
  };
}

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

// Who a received email is from, for answering: its Reply-To when it has one (Contact us's messages come from our own
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
async function file(fields, { threadId = null, counterpart, searchBody = null }) {
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
    const searchText = searchTextOf(searchBody === null ? fields : { ...fields, text: searchBody });
    message = (await MailMessage.create({ ...fields, threadId: id, searchText })).toObject();
  } catch (err) {
    if (err.code !== 11000) throw err;
    if (created) await MailThread.deleteOne({ _id: id }); // the webhook and a sync crossed: the other one saved it
    return MailMessage.findOne({ resendId: fields.resendId }).lean();
  }
  const unread = fields.direction === 'in' ? 1 : 0;
  // Anything new brings a thread back from Trash: a customer's answer mustn't go unseen
  await MailThread.updateOne({ _id: id }, { $inc: { messages: 1, unread }, $set: { trashedAt: null } });
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

// What the form's editor (public/js/mail-editor.js) can make, and all that's kept of what it sends, whatever it sends:
// no styles, scripts, images or attributes but a link's address, and links only to web pages or email addresses.
const NOTE_RULES = {
  allowedTags: ['div', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: { p: 'div', strong: 'b', em: 'i' },
};
const cleanNote = (html) => sanitizeHtml(String(html || ''), NOTE_RULES);

// A note's plain-text version, for the email's text part, snippets and search: lists as lists, links with their address
function noteText(html) {
  const lists = [];
  const marked = html
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (match, href, label) => {
      const shown = href.replace(/^mailto:/i, '');
      return label === href || label === shown ? label : `${label} (${shown})`;
    })
    .replace(/<(\/?)(ul|ol|li)>/g, (match, closing, tag) => {
      if (tag !== 'li') {
        if (closing) lists.pop();
        else lists.push(tag === 'ol' ? { n: 0 } : null);
        return '\n';
      }
      if (closing) return '\n';
      const list = lists[lists.length - 1];
      return list ? `${(list.n += 1)}. ` : '- ';
    });
  return htmlToText(marked);
}

// The form without its editor sends plain text: the same note, for the email's design
const plainNote = (text) => text.split('\n').map((line) => `<div>${line ? esc(line) : '<br>'}</div>`).join('');

// An opening or a closing as the form sends it (the quote button's, config/mail.js): plain text, no more than a blank
// line at a time
const TEMPLATE_MAX_CHARS = 1000;
const cleanPiece = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, TEMPLATE_MAX_CHARS);

// What was written, with its opening over it and its closing under it, a blank line apart: in plain text and as a note
const framed = ({ opening, text, note, closing }) => ({
  text: [opening, text, closing].filter(Boolean).join('\n\n'),
  note: [opening && plainNote(opening), text && note, closing && plainNote(closing)].filter(Boolean).join('<div><br></div>'),
});

// The compose, reply or forward form, checked: { value } or { error } (a message for the form). A forward's message is
// optional: the email forwarded is what it says. An opening and a closing frame a message; they aren't one. value.text:
// all of it in plain text; value.note: in the few tags above.
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
  const edited = body.format === 'html' ? cleanNote(body.body) : null;
  const text = (edited === null ? String(body.body || '') : noteText(edited)).replace(/\r\n?/g, '\n').trim();
  const forwarding = isId(body.forwarding) ? body.forwarding : null;
  if (!text && !forwarding) return { error: 'Write a message.' };
  const whole = framed({ opening: cleanPiece(body.opening), text, note: edited ?? plainNote(text), closing: cleanPiece(body.closing) });
  if (whole.text.length > BODY_MAX_CHARS) return { error: `Keep the message under ${BODY_MAX_CHARS} characters.` };
  return {
    value: {
      from,
      to: to.value,
      cc: cc.value,
      subject,
      text: whole.text,
      note: whole.note,
      answering: !forwarding && isId(body.answering) ? body.answering : null,
      forwarding,
      attachments: forwarding ? [].concat(body.attachments || []).map(String) : [],
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

// The email forwarded, under the note: its headers and all of its words (unlike a reply's quote, whose reader has
// seen it), as plain text, like everything the mailbox sends
function forwardedText(message) {
  const lines = [
    '---------- Forwarded message ---------',
    `From: ${formatAddress(message.from)}`,
    `Date: ${fullDate(message.date)}`,
    `Subject: ${message.subject || '(no subject)'}`,
    `To: ${(message.to || []).join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.join(', ')}`] : []),
  ];
  return `${lines.join('\n')}\n\n${bodyText(message).trim()}`;
}

const tooBig = () => new MailError('too_big', `These attachments are over the ${Math.floor(ATTACHMENTS_MAX_BYTES / 1024 / 1024)} MB an email can carry. Remove some.`);

// The attachments chosen to go along with a forward, for Resend: their content, not their download links. A link can
// change each time it's asked for, and a form sent twice must be the same request to Resend to stay one email.
// otherBytes: what the email carries besides them.
async function forwardAttachments(message, ids, { fetchImpl = fetch, otherBytes = 0 } = {}) {
  const chosen = (message.attachments || []).filter((a) => a.id && ids.includes(a.id));
  if (chosen.reduce((sum, a) => sum + (a.size || 0), otherBytes) > ATTACHMENTS_MAX_BYTES) throw tooBig();
  return Promise.all(chosen.map(async (a) => {
    const url = await attachmentUrl(String(message._id), a.id);
    const res = url && (await fetchImpl(url, { signal: AbortSignal.timeout(ATTACHMENTS_TIMEOUT_MS) }).catch(() => null));
    if (!res?.ok) throw new MailError('attachment', `Couldn’t get “${a.filename || 'an attachment'}” from Resend. Try again, or untick it.`);
    return { filename: a.filename || 'attachment', content: Buffer.from(await res.arrayBuffer()).toString('base64'), size: a.size, contentType: a.contentType };
  }));
}

// Sends a checked draft (cleanDraft) from its mailbox: a reply when it answers a message, a forward when it forwards
// one, else a new thread. A forward is a new thread too: it's with whom it went to, so their answer can't be taken for
// the customer's, or a reply to it go to the customer. uploads: the files attached to the form (multer's). Like
// forwarded attachments, they go to Resend and only what they are is kept here. The draft's key makes a form sent twice
// (a double click, a reload) one email. Returns the saved message.
async function send(draft, { sentBy = null, uploads = [] } = {}) {
  const attached = uploads.filter((file) => file.size);
  const attachedBytes = attached.reduce((sum, file) => sum + file.size, 0);
  if (attachedBytes > ATTACHMENTS_MAX_BYTES) throw tooBig();
  const forwarding = draft.forwarding ? await MailMessage.findById(draft.forwarding).lean() : null;
  if (draft.forwarding && !forwarding) throw new MailError('gone', 'That email no longer exists, so it can’t be forwarded.');
  const answering = draft.answering ? await MailMessage.findById(draft.answering).lean() : null;
  // The signature follows what the admin wrote: a forward with nothing of theirs has none
  const signature = draft.text ? (await signatures())[draft.from.address] : '';
  const under = forwarding ? forwardedText(forwarding) : answering ? quoted(answering) : '';
  const text = [draft.text, signature && `-- \n${signature}`, under].filter(Boolean).join('\n\n');
  // The design marks a quote with its rule, so only the text version needs the "> "
  const html = mailboxMessage({ note: draft.note, signature, quote: forwarding ? under : splitQuote(under).quote });
  const attachments = [
    ...(forwarding ? await forwardAttachments(forwarding, draft.attachments, { otherBytes: attachedBytes }) : []),
    ...attached.map((file) => ({ filename: file.originalname, content: file.buffer.toString('base64'), size: file.size, contentType: file.mimetype })),
  ];
  const { references, headers } = replyHeaders(answering);
  const sent = await resend('/emails', {
    method: 'POST',
    idempotencyKey: draft.key,
    timeoutMs: attachments.length ? ATTACHMENTS_TIMEOUT_MS : TIMEOUT_MS,
    body: {
      from: formatAddress(draft.from),
      to: draft.to,
      ...(draft.cc.length ? { cc: draft.cc } : {}),
      subject: draft.subject,
      text,
      html,
      headers,
      ...(attachments.length ? { attachments: attachments.map(({ filename, content }) => ({ filename, content })) } : {}),
    },
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
    html,
    attachments: attachments.map(({ filename, size, contentType }) => ({ filename, size, contentType })),
    date: new Date(),
    sentBy,
    // Search goes by what was written: every signature's "GenLPT Support" would make "support" find every email sent
  }, { threadId: answering?.threadId || null, counterpart, searchBody: [draft.text, under].filter(Boolean).join('\n\n') });
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
// Drafts: what an admin saved to finish later. Unlike the draft the form keeps while it's being written
// (public/js/mail-draft.js), these last, and follow them to another browser.

const DRAFTS_LIST_SIZE = 100;
const DRAFT_ADDRESSES_MAX_CHARS = 2000;

// Where a draft's files are: the file's bytes, apart from the draft, as they can be larger than a document can hold
const draftFileStore = {
  bucket: () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'mail_draft_files' }),
  put(file) {
    return new Promise((resolve, reject) => {
      const upload = this.bucket().openUploadStream(file.originalname);
      upload.on('finish', () => resolve(upload.id));
      upload.on('error', reject);
      upload.end(file.buffer);
    });
  },
  read: (id) => draftFileStore.bucket().openDownloadStream(id),
  remove: (id) => draftFileStore.bucket().delete(id).catch((err) => console.error('[mail] draft file:', err.message)),
};

// Saves the form as it is: over the draft it came from when it's still theirs, else as a new one. Null when there's
// nothing in it to save.
async function saveDraft(body, { by, uploads = [] }) {
  const attached = uploads.filter((file) => file.size);
  if (attached.reduce((sum, file) => sum + file.size, 0) > ATTACHMENTS_MAX_BYTES) throw tooBig();
  const note = body.format === 'html' ? cleanNote(body.body) : plainNote(String(body.body || '').replace(/\r\n?/g, '\n').trim());
  const text = noteText(note).trim();
  if (text.length > BODY_MAX_CHARS) throw new MailError('too_long', `Keep the message under ${BODY_MAX_CHARS} characters.`);
  const line = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const fields = {
    from: MAILBOXES.find((m) => m.address === body.from)?.address || '',
    to: line(body.to, DRAFT_ADDRESSES_MAX_CHARS),
    cc: line(body.cc, DRAFT_ADDRESSES_MAX_CHARS),
    subject: line(body.subject, SUBJECT_MAX_CHARS),
    body: text ? note : '',
    text,
    opening: cleanPiece(body.opening),
    closing: cleanPiece(body.closing),
    t: isId(body.t) ? body.t : '',
    answering: isId(body.answering) ? body.answering : '',
    forwarding: isId(body.forwarding) ? body.forwarding : '',
    attachments: [].concat(body.attachments || []).map(String),
  };
  if (!fields.to && !fields.cc && !fields.subject && !fields.text && !fields.opening && !fields.closing && !attached.length) return null;
  const files = await Promise.all(attached.map(async (file) => ({
    id: await draftFileStore.put(file),
    filename: file.originalname,
    contentType: file.mimetype,
    size: file.size,
  })));
  const earlier = isId(body.d) ? await MailDraft.findOne({ _id: body.d, createdBy: by }).lean() : null;
  if (!earlier) return MailDraft.create({ ...fields, files, createdBy: by });
  const saved = await MailDraft.findOneAndUpdate({ _id: earlier._id }, { $set: { ...fields, files } }, { returnDocument: 'after' }).lean();
  await Promise.all((earlier.files || []).map((file) => draftFileStore.remove(file.id)));
  return saved;
}

const listDrafts = (by) => MailDraft.find({ createdBy: by }, { body: 0 }).sort({ updatedAt: -1 }).limit(DRAFTS_LIST_SIZE).lean();
const countDrafts = (by) => MailDraft.countDocuments({ createdBy: by });
const getDraft = (id, by) => (isId(id) ? MailDraft.findOne({ _id: id, createdBy: by }).lean() : null);

async function deleteDraft(id, by) {
  const draft = await getDraft(id, by);
  if (!draft) return;
  await MailDraft.deleteOne({ _id: draft._id });
  await Promise.all((draft.files || []).map((file) => draftFileStore.remove(file.id)));
}

// ---------------------------------------------------------------------------
// Signatures

// What goes under an admin's words, by mailbox address: what's been set in Admin → Mail → Signatures, else the mailbox's name
async function signatures() {
  const saved = new Map((await MailSignature.find({}, { address: 1, text: 1 }).lean()).map((s) => [s.address, s.text]));
  return Object.fromEntries(MAILBOXES.map((m) => [m.address, saved.get(m.address) ?? m.name]));
}

const cleanSignature = (value) => String(value || '').replace(/\r\n?/g, '\n').trim();

async function saveSignatures(byAddress, { by = null } = {}) {
  await Promise.all(MAILBOXES.map(({ address }) => MailSignature.updateOne(
    { address },
    { $set: { text: cleanSignature(byAddress[address]), updatedBy: by } },
    { upsert: true }
  )));
}

// ---------------------------------------------------------------------------
// Templates: the openings and closings of what the form's quote button shows (config/mail.js)

// A name as a greeting says it: its first word, capitalized when it came all lowercase ("ana lima" → "Ana"). An address is no name.
function firstName(name) {
  const word = String(name || '').replace(/["“”]/g, '').trim().split(/\s+/)[0];
  if (!word || word.includes('@')) return '';
  return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

// The first name of whom the form's To is for: as typed there ("Ana Lima <ana@example.com>"), else their account's,
// else the one their emails came with. '' when it names no one, or several people.
async function recipientName(to) {
  const typed = String(to || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  if (typed.length !== 1) return '';
  const { name, address } = parseAddress(typed[0]);
  if (firstName(name)) return firstName(name);
  if (emailProblem(address)) return '';
  const user = await User.findOne({ email: address }, { name: 1 }).lean();
  if (firstName(user?.name)) return firstName(user.name);
  const thread = await MailThread.findOne({ 'counterpart.address': address, 'counterpart.name': { $nin: ['', null] } }, { counterpart: 1 }).sort({ lastAt: -1 }).lean();
  return firstName(thread?.counterpart?.name);
}

// A template with its names in: {name} or {name|fallback} for whom it's to, {me} for the admin writing, {team} for the
// mailbox it's from
const fillTemplate = (text, { name = '', me = '', team = '' } = {}) => text
  .replace(/( ?)\{name(?:\|([^}]*))?\}/g, (match, space, fallback) => (name || fallback ? space + (name || fallback) : ''))
  .replace(/\{me\}/g, me)
  .replace(/\{team\}/g, team)
  .trim();

// The quote button's openings and closings for what's in To, signed by the admin writing for the mailbox it's from:
// its name, or the app's while From is still to choose (Other)
async function templatesFor(to, { me = '', from = '' } = {}) {
  const name = await recipientName(to);
  const team = MAILBOXES.find((m) => m.address === from)?.name || brand.appName;
  const fill = (text) => fillTemplate(text, { name, me, team });
  return { openings: TEMPLATES.openings.map(fill), closings: TEMPLATES.closings.map(fill) };
}

// ---------------------------------------------------------------------------
// Searching

const QUERY_MAX_CHARS = 200;
const QUERY_MAX_WORDS = 10;

const cleanQuery = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX_CHARS) : '');

// What a list is narrowed to, from its filter (views/admin/partials/mail-filter.ejs): unread, who wrote it, whom it was
// sent to, between which days. What makes no sense is left out, and days the wrong way round are put right.
const cleanDay = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : '');
function cleanFilters(query) {
  const [since, until] = [cleanDay(query?.since), cleanDay(query?.until)];
  const swapped = since && until && since > until;
  return { unreadOnly: query?.unread === '1', author: cleanQuery(query?.author), recipient: cleanQuery(query?.recipient), since: swapped ? until : since, until: swapped ? since : until };
}
const filterParams = ({ unreadOnly, author, recipient, since, until }) => ({ ...(unreadOnly ? { unread: '1' } : {}), ...(author ? { author } : {}), ...(recipient ? { recipient } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}) });
// How many are on: the two days count as one
const countFilters = ({ unreadOnly, author, recipient, since, until }) => [unreadOnly, author, recipient, since || until].filter(Boolean).length;

// Lowercase, without accents and with one kind of apostrophe, so "recu" finds "Reçu" and "don't" finds "don’t"
const folded = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/œ/g, 'oe')
  .replace(/æ/g, 'ae')
  .replace(/ß/g, 'ss')
  .replace(/[‘’]/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

// What search looks through: who an email is from and to, its subject, its words (an HTML email's, without its tags)
// and its attachments' names. Our own addresses stay out, or "support" would find every email.
function searchTextOf(message) {
  const sender = message.direction === 'out' ? [] : [message.from?.name, message.from?.address];
  const others = [...(message.to || []), ...(message.cc || []), ...(message.replyTo || [])].filter((a) => !MAILBOX_ADDRESSES.includes(a));
  const names = (message.attachments || []).map((a) => a.filename);
  return folded([...sender, ...others, message.subject, bodyText(message).slice(0, TEXT_MAX_CHARS), ...names].filter(Boolean).join(' '));
}

const searchWords = (query) => [...new Set(folded(cleanQuery(query)).split(' ').filter(Boolean))].slice(0, QUERY_MAX_WORDS);

// Whether an email has all of the words searched for, anywhere in what search looks through, parts of words included
function matchesSearch(message, query) {
  const words = searchWords(query);
  if (!words.length) return false;
  const text = searchTextOf(message);
  return words.every((word) => text.includes(word));
}

// Emails saved before search existed get their text the first time someone searches, so there's nothing to migrate
let filling = null;
function fillSearchText() {
  filling ||= (async () => {
    for await (const message of MailMessage.find({ searchText: { $exists: false } }).lean().cursor()) {
      await MailMessage.updateOne({ _id: message._id }, { $set: { searchText: searchTextOf(message) } });
    }
  })().catch((err) => {
    filling = null; // the next search tries again
    throw err;
  });
  return filling;
}

const asRegex = (word) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

// The threads holding an email with all these words (a team's mailbox is small enough to read through)
async function threadsWith(words) {
  await fillSearchText();
  return MailMessage.distinct('threadId', { $and: words.map((word) => ({ searchText: asRegex(word) })) });
}

// The threads holding an email written by this person (part of a name or an address, or of the Reply-To of a message sent
// for them: Contact us's), sent to this one (part of an address, the only thing kept of whom it went to, in To or Cc),
// between these days. One email has to be all of those.
function threadsMatching({ author, recipient, since, until }) {
  const match = {};
  const like = (text) => new RegExp(asRegex(text).source, 'i');
  const who = [];
  if (author) who.push({ $or: [{ 'from.name': like(author) }, { 'from.address': like(author) }, { replyTo: like(author) }] });
  if (recipient) who.push({ $or: [{ to: like(recipient) }, { cc: like(recipient) }] });
  if (who.length) match.$and = who;
  if (since || until) match.date = { ...(since ? { $gte: startOfDay(since) } : {}), ...(until ? { $lt: startOfDay(until, 1) } : {}) };
  return MailMessage.distinct('threadId', match);
}

// ---------------------------------------------------------------------------
// The mailbox's views

// The mailboxes to choose from, one at a time: together, sent and received are hard to tell apart. Other: any address of
// the domain that isn't one, or no longer is, so that no conversation is out of reach.
const localPart = (address) => address.split('@')[0];
const BOXES = [
  ...MAILBOXES.map((m) => ({ key: localPart(m.address), label: localPart(m.address)[0].toUpperCase() + localPart(m.address).slice(1), address: m.address, icon: m.icon })),
  { key: 'other', label: 'Other', note: 'Other addresses', icon: 'folder' },
];
const boxOf = (key) => BOXES.find((b) => b.key === key) || BOXES[0];
const boxOfThread = (thread) => BOXES.find((b) => b.address === thread.mailbox) || boxOf('other');

// What's in the mailbox chosen, in the sidebar. Trash is the only one holding what was deleted. A conversation is in Inbox
// once it holds an email received and in Sent once it holds one sent, so one that was answered is in both and none is in neither.
const FOLDERS = [
  { key: 'inbox', label: 'Inbox', direction: 'in' },
  { key: 'sent', label: 'Sent', direction: 'out' },
  { key: 'starred', label: 'Starred', starred: true },
  { key: 'drafts', label: 'Drafts', drafts: true }, // the admin's own, what they saved to finish later, from any mailbox
  { key: 'trash', label: 'Trash', trash: true },
];
const folderOf = (key) => FOLDERS.find((f) => f.key === key) || FOLDERS[0];

const LIST_SIZE = 50;

// What a folder of a mailbox lists, or with no folder all that isn't in Trash (query: only threads with an email that has its words)
async function listFilter(box, { folder = {}, unreadOnly = false, author = '', recipient = '', since = '', until = '', query = '' } = {}) {
  const filter = { mailbox: box.address || { $nin: MAILBOX_ADDRESSES }, trashedAt: folder.trash ? { $ne: null } : null, messages: { $gt: 0 } };
  if (folder.starred) filter.starred = true;
  if (unreadOnly) filter.unread = { $gt: 0 };
  const words = searchWords(query);
  if (words.length) filter._id = { $in: await threadsWith(words) };
  const among = [];
  if (folder.direction) among.push({ _id: { $in: await MailMessage.distinct('threadId', { direction: folder.direction }) } });
  if (author || recipient || since || until) among.push({ _id: { $in: await threadsMatching({ author, recipient, since, until }) } });
  if (among.length) filter.$and = among;
  return filter;
}

// A folder's threads in a mailbox, latest first, LIST_SIZE at a time (before: the lastAt to continue from). total: with a
// filter on, how many it found on all the pages.
async function listThreads(box, { before = null, ...shown } = {}) {
  const filter = await listFilter(box, shown);
  const total = countFilters(shown) ? await MailThread.countDocuments(filter) : null;
  if (before) filter.lastAt = { $lt: before };
  const threads = await MailThread.find(filter).sort({ lastAt: -1 }).limit(LIST_SIZE + 1).lean();
  return { threads: threads.slice(0, LIST_SIZE), more: threads.length > LIST_SIZE, total };
}

// The threads on either side of one in a folder's list, whichever of its pages they're on: newer above it, older below
async function threadsAround(box, thread, shown = {}) {
  const filter = await listFilter(box, shown);
  const nearest = (lastAt, order) => MailThread.findOne({ ...filter, lastAt }, { lastAt: 1 }).sort({ lastAt: order }).lean();
  const [newer, older] = await Promise.all([nearest({ $gt: thread.lastAt }, 1), nearest({ $lt: thread.lastAt }, -1)]);
  return { newer, older };
}

// Unread messages by mailbox, and all of them
async function unreadCounts() {
  const rows = await MailThread.aggregate([{ $match: { unread: { $gt: 0 }, trashedAt: null } }, { $group: { _id: '$mailbox', unread: { $sum: '$unread' } } }]);
  const counts = { all: 0 };
  for (const row of rows) {
    const key = MAILBOX_ADDRESSES.includes(row._id) ? localPart(row._id) : 'other';
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

async function setStarred(threadId, starred) {
  if (isId(threadId)) await MailThread.updateOne({ _id: threadId }, { $set: { starred } });
}

// Deleting moves a thread to Trash rather than erasing it: a sync would bring back any received email it no longer finds
async function setTrashed(threadId, trashed) {
  if (isId(threadId)) await MailThread.updateOne({ _id: threadId }, { $set: { trashedAt: trashed ? new Date() : null } });
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

// When a day (YYYY-MM-DD) starts in that time zone, or plus days after it
function startOfDay(day, plus = 0) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, date + plus);
  const there = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(utc).map((part) => [part.type, Number(part.value)]));
  return new Date(2 * utc - Date.UTC(there.year, there.month - 1, there.day, there.hour, there.minute, there.second));
}
// A filter's day, as it's shown
const dayLabel = (day) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${day}T00:00:00Z`));

// What a list's filter is set to, in words, for the search field: "Unread only, from Ana, between Jul 1 and Jul 31, 2026"
function filterHint({ unreadOnly, author, recipient, since, until }) {
  let dates = '';
  if (since && since === until) dates = `on ${dayLabel(since)}`;
  else if (since && until) {
    const sameYear = since.slice(0, 4) === until.slice(0, 4);
    dates = `between ${sameYear ? dayLabel(since).replace(/, \d+$/, '') : dayLabel(since)} and ${dayLabel(until)}`;
  } else if (since) dates = `since ${dayLabel(since)}`;
  else if (until) dates = `until ${dayLabel(until)}`;
  const hint = [unreadOnly && 'unread only', author && `from ${author}`, recipient && `to ${recipient}`, dates].filter(Boolean).join(', ');
  return hint && hint[0].toUpperCase() + hint.slice(1);
}

const fileSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);

// What a received email's HTML is shown in: a frame with no scripts, forms or access to the page (sandbox, in the
// view); links open in a new tab. Images from other sites stay out: the page's CSP doesn't allow them (no tracking
// pixels); the email's own, inlined as data: URIs, show.
// A sent email as it went out, in its frame (views/admin/mail.ejs): links open in a new tab
const sentFrameDoc = (html) => html.replace('<body', '<head><meta charset="utf-8"><base target="_blank"></head><body');

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
  cleanNote,
  signatures,
  saveSignatures,
  templatesFor,
  saveDraft,
  listDrafts,
  countDrafts,
  getDraft,
  deleteDraft,
  draftFileStore,
  sentFrameDoc,
  BOXES,
  boxOf,
  boxOfThread,
  FOLDERS,
  folderOf,
  QUERY_MAX_CHARS,
  cleanQuery,
  cleanFilters,
  filterParams,
  countFilters,
  filterHint,
  matchesSearch,
  listThreads,
  threadsAround,
  unreadCounts,
  getThread,
  markRead,
  markUnread,
  setStarred,
  setTrashed,
  replySubject,
  forwardSubject,
  bodyText,
  snippetOf,
  splitQuote,
  shortDate,
  fullDate,
  fileSize,
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
  forwardedText,
  forwardAttachments,
  searchTextOf,
  searchWords,
  noteText,
  firstName,
  recipientName,
  fillTemplate,
};
