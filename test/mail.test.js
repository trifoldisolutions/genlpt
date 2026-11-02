const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const mail = require('../services/mail');
const MailMessage = require('../models/MailMessage');
const MailThread = require('../models/MailThread');
const MailSignature = require('../models/MailSignature');
const MailDraft = require('../models/MailDraft');
const templates = require('../services/email/templates');
const { MAILBOXES } = require('../config/mail');

// A webhook signed the way Resend (Svix) signs it
const SECRET = `whsec_${Buffer.from('a test signing secret').toString('base64')}`;
function signed(body, { secret = SECRET, id = 'msg_1', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${signature}` };
}

test('mail webhook: a correct signature passes, among others (a secret mid-rotation)', () => {
  const body = Buffer.from('{"type":"email.received"}');
  assert.equal(mail.verifyWebhook(body, signed(body), SECRET), true);
  const headers = signed(body);
  headers['svix-signature'] = `v1,AAAA ${headers['svix-signature']}`;
  assert.equal(mail.verifyWebhook(body, headers, SECRET), true);
});

test('mail webhook: a changed body, another secret, an old timestamp or no secret fail', () => {
  const body = Buffer.from('{"type":"email.received"}');
  const headers = signed(body);
  assert.equal(mail.verifyWebhook(Buffer.from('{"type":"email.received" }'), headers, SECRET), false);
  assert.equal(mail.verifyWebhook(body, signed(body, { secret: `whsec_${Buffer.from('another').toString('base64')}` }), SECRET), false);
  assert.equal(mail.verifyWebhook(body, signed(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }), SECRET), false);
  assert.equal(mail.verifyWebhook(body, headers, ''), false);
  assert.equal(mail.verifyWebhook(body, { ...headers, 'svix-signature': 'v2,abc' }, SECRET), false);
});

// The webhook route as Resend reaches it, with server.js's raw body
async function postWebhook(body, headers) {
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api/webhooks', require('../routes/webhooks'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/webhooks/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

test('mail webhook route: refused without a secret set, or with a bad signature; other events are ignored', async () => {
  const saved = process.env.RESEND_WEBHOOK_SECRET;
  try {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const body = JSON.stringify({ type: 'email.sent', data: {} });
    assert.equal((await postWebhook(body, signed(body))).status, 503);
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    assert.equal((await postWebhook(body, { ...signed(body), 'svix-signature': 'v1,bm9wZQ==' })).status, 401);
    const ok = await postWebhook(body, signed(body));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ignored, true);
  } finally {
    if (saved === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = saved;
  }
});

test('mail: addresses are read with or without a name, and lists are checked', () => {
  assert.deepEqual(mail.parseAddress('Ana Lima <Ana@Example.com>'), { name: 'Ana Lima', address: 'ana@example.com' });
  assert.deepEqual(mail.parseAddress('"Lima, Ana" <ana@example.com>'), { name: 'Lima, Ana', address: 'ana@example.com' });
  assert.deepEqual(mail.parseAddress('ana@example.com'), { name: '', address: 'ana@example.com' });
  assert.deepEqual(mail.addressList('a@x.com, Bo <b@y.com>; a@x.com').value, ['a@x.com', 'b@y.com']);
  assert.match(mail.addressList('a@x.com, nope').error, /“nope” isn’t a valid email address/);
});

test('mail: subjects lose their Re:/Fwd: to match a thread, and a reply gets one Re:', () => {
  assert.equal(mail.baseSubject('Re: Fwd: RE: Billing question'), 'Billing question');
  assert.equal(mail.baseSubject('AW: TR: Facture'), 'Facture');
  assert.equal(mail.baseSubject('Refund for my plan'), 'Refund for my plan');
  assert.equal(mail.replySubject('Billing question'), 'Re: Billing question');
  assert.equal(mail.replySubject('Re: Billing question'), 'Re: Billing question');
  assert.equal(mail.replySubject('Fwd: Billing question'), 'Re: Billing question');
});

test('mail: a preview shows what an email says, not its signature', () => {
  assert.equal(mail.snippetOf({ text: 'Words that stay.\n\n-- \nGenLPT Support\n\nOn Nov 1, Ana wrote:\n> Hello' }), 'Words that stay.');
  assert.equal(mail.snippetOf({ text: 'Thanks!\n--\nAna Lima' }), 'Thanks!');
  assert.equal(mail.snippetOf({ text: 'One\ntwo  three' }), 'One two three');
  assert.equal(mail.snippetOf({ text: 'Costs 5 -- or 6' }), 'Costs 5 -- or 6', 'a dash in a sentence is no signature');
  assert.equal(mail.snippetOf({ text: '\n-- \nJust a signature' }), '-- Just a signature');
});

test('mail: the quote that ends a plain-text email comes apart from what was written', () => {
  assert.deepEqual(mail.splitQuote('Thanks.\n\n-- \nGenLPT Support\n\nOn Nov 1, 2026, Ana <ana@example.com> wrote:\n> Hello\n>\n> > Older'), {
    written: 'Thanks.\n\n-- \nGenLPT Support',
    quote: 'On Nov 1, 2026, Ana <ana@example.com> wrote:\nHello\n\n> Older',
  });
  assert.deepEqual(mail.splitQuote('Merci\r\n\r\nOn Sun, Nov 1, 2026 at 4:39 PM Ana <ana@example.com>\r\nwrote:\r\n\r\n> Hello\r\n'), {
    written: 'Merci',
    quote: 'On Sun, Nov 1, 2026 at 4:39 PM Ana <ana@example.com>\nwrote:\n\nHello',
  }, 'wrapped by a mail app');
  assert.equal(mail.splitQuote('Merci\n\nLe 1 nov. 2026, Ana a écrit :\n> Bonjour').written, 'Merci', 'in French');
  assert.deepEqual(mail.splitQuote('> Hello'), { written: '', quote: 'Hello' }, 'nothing written');
  assert.deepEqual(mail.splitQuote('Just words\n'), { written: 'Just words\n', quote: '' });
  const answered = '> First question\nFirst answer\n> Second question\nSecond answer';
  assert.deepEqual(mail.splitQuote(answered), { written: answered, quote: '' }, 'answers between quoted lines stay whole');
});

test('mail: HTML becomes plain text for snippets and quotes', () => {
  const html = '<html><head><style>p{color:red}</style></head><body><p>Hello&nbsp;there,</p><div>Line one<br>Line &amp; two</div><script>x()</script>&#233;t&#xE9;</body></html>';
  assert.equal(mail.htmlToText(html), 'Hello there,\nLine one\nLine & two\nété');
});

test('mail: a received email is filed by mailbox, with its thread headers and whom to answer', () => {
  const email = {
    id: 'r1',
    from: 'no-reply@genlpt.com',
    to: ['support@genlpt.com'],
    cc: [],
    reply_to: ['Ana <ana@example.com>'],
    subject: 'Re: Help',
    text: 'Thanks!',
    html: null,
    message_id: '<m2@example.com>',
    headers: { from: 'GenLPT <no-reply@genlpt.com>', 'in-reply-to': '<m1@genlpt.com>', references: '<m0@example.com> <m1@genlpt.com>' },
    attachments: [{ id: 'a1', filename: 'shot.png', content_type: 'image/png', size: 2048, content_id: null, content_disposition: 'attachment' }],
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    created_at: '2026-11-01T12:00:00.000Z',
  };
  const fields = mail.receivedFields(email);
  assert.equal(fields.mailbox, 'support@genlpt.com');
  assert.deepEqual(fields.from, { name: 'GenLPT', address: 'no-reply@genlpt.com' });
  assert.equal(fields.inReplyTo, '<m1@genlpt.com>');
  assert.deepEqual(fields.references, ['<m0@example.com>', '<m1@genlpt.com>']);
  assert.deepEqual(mail.counterpartOf(fields), { name: '', address: 'ana@example.com' }); // Help center's: answer the sender, not no-reply
  assert.equal(fields.attachments[0].contentType, 'image/png');
  assert.equal(fields.read, false);
  assert.equal(mail.receivedFields({ ...email, to: ['typo@genlpt.com'] }).mailbox, null); // Other
});

test('mail: a reply names the email it answers, and the thread before it', () => {
  const answering = { messageId: '<m2@example.com>', references: ['<m0@example.com>', '<m1@genlpt.com>'] };
  const { references, headers } = mail.replyHeaders(answering);
  assert.deepEqual(references, ['<m0@example.com>', '<m1@genlpt.com>', '<m2@example.com>']);
  assert.deepEqual(headers, { 'In-Reply-To': '<m2@example.com>', References: '<m0@example.com> <m1@genlpt.com> <m2@example.com>' });
  assert.equal(mail.replyHeaders({ messageId: null }).headers, undefined);
  // In the mailbox's time zone (Florida: UTC-4 in summer); Intl may put a narrow no-break space before PM
  const quote = mail.quoted({ from: { name: 'Ana', address: 'ana@example.com' }, date: new Date('2026-07-01T16:00:00Z'), text: 'Hi\nThanks' });
  assert.match(quote, /^On Jul 1, 2026, 12:00\sPM, Ana <ana@example.com> wrote:\n> Hi\n> Thanks$/);
});

test('mail: a draft needs one of our mailboxes, valid recipients, a subject and a message', () => {
  const draft = { from: MAILBOXES[0].address, to: 'ana@example.com', cc: '', subject: ' Hello ', body: 'Hi Ana\r\n', key: 'k'.repeat(22) };
  const { value } = mail.cleanDraft(draft);
  assert.equal(value.from.address, MAILBOXES[0].address);
  assert.deepEqual(value.to, ['ana@example.com']);
  assert.equal(value.subject, 'Hello');
  assert.equal(value.text, 'Hi Ana');
  assert.equal(value.key, 'k'.repeat(22));
  assert.match(mail.cleanDraft({ ...draft, from: 'me@elsewhere.com' }).error, /address to send from/);
  assert.match(mail.cleanDraft({ ...draft, to: '' }).error, /at least one recipient/);
  assert.match(mail.cleanDraft({ ...draft, subject: '' }).error, /subject/);
  assert.match(mail.cleanDraft({ ...draft, body: '  ' }).error, /Write a message/);
  assert.equal(mail.cleanDraft({ ...draft, key: 'bad key' }).value.key, null);
});

test('mail: a sender is flagged when DMARC fails, or SPF and DKIM both do', () => {
  const inbound = (authentication) => ({ direction: 'in', authentication });
  assert.equal(mail.unverified(inbound({ spf: 'pass', dkim: 'pass', dmarc: 'fail' })), true);
  assert.equal(mail.unverified(inbound({ spf: 'fail', dkim: 'fail', dmarc: 'gray' })), true);
  assert.equal(mail.unverified(inbound({ spf: 'fail', dkim: 'pass', dmarc: 'gray' })), false);
  assert.equal(mail.unverified(inbound(null)), false);
  assert.equal(mail.unverified({ direction: 'out' }), false);
});

test('mail: a forward says who wrote the email, then all of it, and its subject gets one Fwd:', () => {
  assert.equal(mail.forwardSubject('Billing question'), 'Fwd: Billing question');
  assert.equal(mail.forwardSubject('Re: Billing question'), 'Fwd: Billing question');
  assert.equal(mail.forwardSubject('Fwd: Billing question'), 'Fwd: Billing question');
  const long = 'x'.repeat(5000); // past what a reply quotes
  const text = mail.forwardedText({ from: { name: 'Ana', address: 'ana@example.com' }, to: ['support@genlpt.com'], cc: ['bo@example.com'], date: new Date('2026-07-01T16:00:00Z'), subject: 'Billing', text: long });
  assert.match(text, /^---------- Forwarded message ---------\nFrom: Ana <ana@example.com>\nDate: Jul 1, 2026, 12:00\sPM\nSubject: Billing\nTo: support@genlpt.com\nCc: bo@example.com\n\nx+$/);
  assert.ok(text.endsWith(long));
});

test('mail: a forward needs no message of its own, and carries only the attachments ticked', () => {
  const draft = { from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Fwd: Hi', body: ' ', forwarding: 'a'.repeat(24), answering: 'b'.repeat(24) };
  const { value } = mail.cleanDraft({ ...draft, attachments: 'one' });
  assert.equal(value.forwarding, 'a'.repeat(24));
  assert.equal(value.answering, null);
  assert.deepEqual(value.attachments, ['one']);
  assert.deepEqual(mail.cleanDraft({ ...draft, attachments: ['one', 'two'] }).value.attachments, ['one', 'two']);
  assert.deepEqual(mail.cleanDraft(draft).value.attachments, []);
  assert.match(mail.cleanDraft({ ...draft, forwarding: 'not an id' }).error, /Write a message/);
});

// send(), up to Resend and the database: what was saved and what Resend was asked to send
function mailStubs(t, forwarded, savedSignatures = []) {
  const calls = { sent: [], threads: [], saved: [] };
  process.env.RESEND_API_KEY = 're_test';
  t.after(() => { delete process.env.RESEND_API_KEY; });
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the look-up of the sent email's Message-ID, a few seconds later
  t.mock.method(MailMessage, 'findById', () => ({ lean: async () => forwarded }));
  t.mock.method(MailMessage, 'updateMany', async () => ({}));
  t.mock.method(MailMessage, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(MailMessage, 'create', async (fields) => { calls.saved.push(fields); return { toObject: () => ({ _id: 'm1', ...fields }) }; });
  t.mock.method(MailThread, 'findOne', () => ({ sort: () => ({ lean: async () => null }) }));
  t.mock.method(MailThread, 'create', async (fields) => { calls.threads.push(fields); return { _id: 'new-thread' }; });
  t.mock.method(MailThread, 'updateOne', async () => ({}));
  t.mock.method(MailSignature, 'find', () => ({ lean: async () => savedSignatures }));
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url === 'https://cdn.example/report') return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('report bytes') };
    if (url === 'https://cdn.example/gone') return { ok: false, status: 403 };
    if (String(url).includes('/attachments/')) return json({ download_url: `https://cdn.example/${String(url).split('/').pop()}` });
    if (init.method === 'POST') { calls.sent.push({ url, init, body: JSON.parse(init.body) }); return json({ id: 'sent1' }); }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

const RECEIVED = {
  _id: 'c'.repeat(24),
  direction: 'in',
  resendId: 'r1',
  threadId: 'customer-thread',
  messageId: '<m1@example.com>',
  from: { name: 'Ana', address: 'ana@example.com' },
  to: ['support@genlpt.com'],
  date: new Date('2026-07-01T16:00:00Z'),
  subject: 'Billing',
  text: 'My invoice is attached.',
  attachments: [
    { id: 'report', filename: 'report.pdf', contentType: 'application/pdf', size: 12 },
    { id: 'gone', filename: 'old.pdf', contentType: 'application/pdf', size: 12 },
  ],
};
const forwardDraft = (draft = {}) => mail.cleanDraft({ from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Fwd: Billing', body: 'Can you look?', forwarding: RECEIVED._id, attachments: ['report'], key: 'k'.repeat(22), ...draft }).value;

test('mail: a forward is a new thread with its recipient, not a reply, and sends the ticked attachments as content', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  await mail.send(forwardDraft(), { sentBy: 'ops@example.dev' });
  const [{ init, body }] = calls.sent;
  assert.equal(init.headers['Idempotency-Key'], 'k'.repeat(22));
  assert.equal(body.headers, undefined); // no In-Reply-To: the recipient's mail app doesn't file it under Ana's thread
  assert.match(body.text, /^Can you look\?\n\n-- \nGenLPT Support\n\n---------- Forwarded message ---------\nFrom: Ana <ana@example.com>/);
  assert.ok(body.text.endsWith('My invoice is attached.'));
  assert.deepEqual(body.attachments, [{ filename: 'report.pdf', content: Buffer.from('report bytes').toString('base64') }]);
  assert.deepEqual(calls.threads[0].counterpart, { name: '', address: 'bo@example.com' });
  assert.equal(calls.threads[0].subject, 'Billing');
  assert.equal(calls.saved[0].threadId, 'new-thread');
  assert.equal(calls.saved[0].inReplyTo, null);
  assert.deepEqual(calls.saved[0].attachments, [{ filename: 'report.pdf', size: 12, contentType: 'application/pdf' }]);
});

test('mail: a forward with an attachment that can\'t be fetched, or too big to send, isn\'t sent', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  await assert.rejects(mail.send(forwardDraft({ attachments: ['gone'] })), /Couldn’t get “old.pdf” from Resend/);
  const huge = { ...RECEIVED, attachments: [{ ...RECEIVED.attachments[0], size: 30 * 1024 * 1024 }] };
  await assert.rejects(mail.forwardAttachments(huge, ['report']), /Remove some/);
  assert.equal(calls.sent.length, 0);
});

const upload = (originalname, text = 'file bytes', mimetype = 'application/pdf') => ({ originalname, mimetype, size: Buffer.byteLength(text), buffer: Buffer.from(text) });

test('mail: files attached to a new email or a reply go out as content, and only what they are is kept', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  t.mock.method(MailThread, 'findById', () => ({ lean: async () => ({ counterpart: RECEIVED.from }) }));
  const { value: fresh } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Hello', body: 'See attached.' });
  await mail.send(fresh, { uploads: [upload('reçu de paiement.pdf')] });
  assert.deepEqual(calls.sent[0].body.attachments, [{ filename: 'reçu de paiement.pdf', content: Buffer.from('file bytes').toString('base64') }]);
  assert.deepEqual(calls.saved[0].attachments, [{ filename: 'reçu de paiement.pdf', size: 10, contentType: 'application/pdf' }]);
  assert.ok(calls.saved[0].searchText.includes('recu de paiement.pdf'), 'search finds it by its name');
  const { value: reply } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'ana@example.com', subject: 'Re: Billing', body: 'Done.', answering: RECEIVED._id });
  await mail.send(reply, { uploads: [upload('receipt.pdf')] });
  assert.equal(calls.sent[1].body.headers['In-Reply-To'], '<m1@example.com>', 'still a reply');
  assert.equal(calls.sent[1].body.attachments[0].filename, 'receipt.pdf');
});

test('mail: a forward carries what it forwards and what was attached, and they count together', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  await mail.send(forwardDraft(), { uploads: [upload('note.txt', 'a note', 'text/plain')] });
  assert.deepEqual(calls.sent[0].body.attachments.map((a) => a.filename), ['report.pdf', 'note.txt']);
  const nearly = { originalname: 'big.bin', mimetype: 'application/octet-stream', size: 29 * 1024 * 1024 - 5, buffer: Buffer.alloc(0) };
  await assert.rejects(mail.send(forwardDraft(), { uploads: [nearly] }), /over the 29 MB an email can carry/);
  const over = { ...nearly, size: 29 * 1024 * 1024 + 1 };
  const { value } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Hello', body: 'Big.' });
  await assert.rejects(mail.send(value, { uploads: [over] }), /over the 29 MB an email can carry/);
  assert.equal(calls.sent.length, 1, 'nothing goes out over the limit');
});

test('mail: an empty file, or a folder that came in as one, is left out', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  const { value } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Hello', body: 'Hi.' });
  await mail.send(value, { uploads: [upload('empty.txt', '')] });
  assert.equal(calls.sent[0].body.attachments, undefined);
});

test('mail: a reply still answers its email in its thread', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  t.mock.method(MailThread, 'findById', () => ({ lean: async () => ({ counterpart: { name: 'Ana', address: 'ana@example.com' } }) }));
  const { value } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'ana@example.com', subject: 'Re: Billing', body: 'Done.', answering: RECEIVED._id });
  await mail.send(value);
  assert.deepEqual(calls.sent[0].body.headers, { 'In-Reply-To': '<m1@example.com>', References: '<m1@example.com>' });
  assert.equal(calls.sent[0].body.attachments, undefined);
  assert.equal(calls.threads.length, 0);
  assert.equal(calls.saved[0].threadId, 'customer-thread');
});

// The mailbox's page as the route draws it, in each of its states
const EMPTY_FORM = { from: '', to: '', cc: '', subject: '', body: '', t: '', answering: '', forwarding: '', attachments: [], choices: [], key: 'k' };
function drawMail(state = {}) {
  const box = mail.boxOf('support');
  return ejs.renderFile(path.join(__dirname, '../views/admin/mail.ejs'), {
    appName: 'GenLPT', admin: { email: 'ops@example.dev', name: 'Ops', role: 'Admin', initials: 'O' }, title: 'Mail', nav: 'mail', fill: true,
    mailboxMenu: { chosen: box, options: [], elsewhere: false }, mail, folders: mail.FOLDERS, folder: mail.folderOf(), box, counts: { all: 2, support: 2 }, mailboxes: MAILBOXES, bodyMax: 20000, filesMax: 10, filesMaxBytes: 1024 * 1024 * 29, signatures: { 'support@genlpt.com': 'GenLPT Support' },
    list: { threads: [], more: false }, opened: null, around: {}, q: '', filters: mail.cleanFilters(), clearFilters: '/mail?box=support', before: null, filled: false, form: EMPTY_FORM,
    drafts: { new: { ...EMPTY_FORM, from: 'support@genlpt.com' }, reply: null, forward: {} }, formError: null, toasts: [],
    ...state,
  });
}
const OPENED = {
  thread: { _id: 'd'.repeat(24), mailbox: 'support@genlpt.com', subject: 'Billing', counterpart: RECEIVED.from, lastAt: RECEIVED.date, unread: 0, messages: 1, snippet: 'My invoice', lastDirection: 'in' },
  messages: [RECEIVED],
};

test('mail page: four columns, with every folder of the mailbox, no email open and the form empty at first', async () => {
  const html = await drawMail({ list: { threads: [OPENED.thread], more: false } });
  assert.ok(html.includes('href="/mail?box=support"'));
  for (const f of mail.FOLDERS.slice(1)) assert.ok(html.includes(`href="/mail?box=support&amp;folder=${f.key}"`), f.key);
  assert.match(html, /id="mail-list"/);
  assert.match(html, /Choose an email to read it here/);
  assert.match(html, /<body class="flex h-dvh flex-col overflow-hidden/);
  assert.match(html, /id="mail-columns" data-writing="false"/);
  assert.match(html, /<input type="hidden" name="from" value="support@genlpt.com">/);
  for (const name of ['to', 'cc', 'subject', 't', 'answering', 'forwarding']) assert.match(html, new RegExp(`name="${name}" value=""`));
  assert.match(html, /<textarea name="body"[^>]*><\/textarea>/);
  assert.match(html, /<span data-when="new">New email<\/span>/);
  assert.match(html, /<span data-when="reply" hidden>Reply<\/span>/);
});

test('mail page: an open thread sits beside the list, with Reply and Forward, and the form still empty', async () => {
  const drafts = { new: EMPTY_FORM, reply: { ...EMPTY_FORM, to: 'ana@example.com' }, forward: { [RECEIVED._id]: { ...EMPTY_FORM, forwarding: RECEIVED._id } } };
  const html = await drawMail({ opened: OPENED, drafts, list: { threads: [OPENED.thread], more: false } });
  assert.match(html, /My invoice is attached/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /reply=1" data-draft="[^"]*ana@example.com[^"]*"[^>]*>\s*<iconify-icon icon="boxicons:reply"/);
  assert.match(html, /forward=c{24}" data-draft="[^"]*c{24}[^"]*"[^>]*>\s*<iconify-icon icon="boxicons:forward"/);
  assert.match(html, /name="to" value=""/);
  assert.match(html, /attachments\/report"/);
});

test('mail page: the form, filled in, says what it sends', async () => {
  const reply = await drawMail({ opened: OPENED, filled: true, form: { ...EMPTY_FORM, from: 'support@genlpt.com', to: 'ana@example.com', subject: 'Re: Billing', t: OPENED.thread._id, answering: RECEIVED._id } });
  assert.match(reply, /<input type="hidden" name="from" value="support@genlpt.com">/);
  assert.match(reply, /name="to" value="ana@example.com"/);
  assert.match(reply, /name="subject" value="Re: Billing"/);
  assert.match(reply, new RegExp(`name="answering" value="${RECEIVED._id}"`));
  assert.match(reply, /name="forwarding" value=""/);
  assert.match(reply, /<textarea name="body"[^>]* required/);
  assert.match(reply, /<span data-when="reply">Reply<\/span>/);
  assert.match(reply, /id="mail-columns" data-writing="true"/);
  const choices = [{ id: 'report', filename: 'report.pdf', size: '1 KB' }, { id: 'gone', filename: 'old.pdf', size: '1 KB' }];
  const forward = await drawMail({ opened: OPENED, filled: true, form: { ...EMPTY_FORM, from: 'support@genlpt.com', subject: 'Fwd: Billing', t: OPENED.thread._id, forwarding: RECEIVED._id, attachments: ['report'], choices } });
  assert.match(forward, new RegExp(`name="forwarding" value="${RECEIVED._id}"`));
  assert.match(forward, /name="answering" value=""/);
  assert.doesNotMatch(forward, /<textarea name="body"[^>]* required/);
  assert.match(forward, /<span data-when="forward">Forward<\/span>/);
  assert.match(forward, /value="report"\s+checked/);
  assert.doesNotMatch(forward, /value="gone"\s+checked/);
});

test('mail page: what a forward carried is listed, without a link Resend could not answer', async () => {
  const sent = { ...RECEIVED, _id: 'e'.repeat(24), direction: 'out', attachments: [{ filename: 'report.pdf', size: 12 }] };
  const html = await drawMail({ opened: { ...OPENED, messages: [sent] } });
  assert.match(html, /report\.pdf/);
  assert.doesNotMatch(html, /\/attachments\//);
});

test('mail note: only a few plain tags survive, whatever is sent', () => {
  const dirty = '<div style="color:red" onclick="x()">Hi <strong>you</strong><script>alert(1)</script><img src="x" onerror="y()"><span>there</span></div>'
    + '<p>Two</p><iframe src="https://evil.example"></iframe><style>p{color:red}</style>'
    + '<a href="javascript:bad()">no</a><a href="data:text/html,x">nor</a><a href="//evil.example">nor this</a>'
    + '<a href="https://a.example/?b=1&c=2" target="_blank" class="z" onclick="x()">yes</a><a href="mailto:a@example.com">mail</a><ul><li><em>One</em></li></ul>';
  const clean = mail.cleanNote(dirty);
  assert.equal(clean, '<div>Hi <b>you</b>there</div><div>Two</div><a>no</a><a>nor</a><a>nor this</a><a href="https://a.example/?b=1&amp;c=2">yes</a><a href="mailto:a@example.com">mail</a><ul><li><i>One</i></li></ul>');
  for (const bad of ['script', 'onclick', 'onerror', 'style', 'iframe', 'img', 'javascript', 'data:', 'class', 'target']) assert.ok(!clean.includes(bad), bad);
});

test('mail note: its plain-text version keeps lists as lists and says where links go', () => {
  assert.equal(mail.noteText('<div>Hello <b>there</b></div><div><br></div><div>Bye</div>'), 'Hello there\n\nBye');
  assert.equal(mail.noteText('<ul><li>One</li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol>'), '- One\n- Two\n\n1. First\n2. Second');
  assert.equal(mail.noteText('<ol><li>A<ul><li>B</li></ul></li><li>C</li></ol>'), '1. A\n- B\n\n2. C', 'numbering carries on past a list inside');
  assert.equal(mail.noteText('See <a href="https://a.example/?b=1&amp;c=2">our guide</a>'), 'See our guide (https://a.example/?b=1&c=2)');
  assert.equal(mail.noteText('<a href="https://a.example">https://a.example</a>'), 'https://a.example');
  assert.equal(mail.noteText('<a href="mailto:a@example.com">a@example.com</a>'), 'a@example.com');
  assert.equal(mail.noteText('<a href="mailto:a@example.com">Write to us</a>'), 'Write to us (a@example.com)');
  assert.equal(mail.noteText('1 &lt; 2 &amp; <b>3</b>'), '1 < 2 & 3');
});

test('mail: a draft from the editor keeps its note; one without the script is plain text, escaped; an empty note is no message', () => {
  const draft = { from: MAILBOXES[0].address, to: 'ana@example.com', subject: 'Hello', key: 'k'.repeat(22) };
  const edited = mail.cleanDraft({ ...draft, format: 'html', body: '<div>Hi <b>Ana</b><script>x()</script></div>' }).value;
  assert.equal(edited.note, '<div>Hi <b>Ana</b></div>');
  assert.equal(edited.text, 'Hi Ana');
  const plain = mail.cleanDraft({ ...draft, body: 'Line <b>one</b>\r\n\r\nLine two' }).value;
  assert.equal(plain.text, 'Line <b>one</b>\n\nLine two');
  assert.equal(plain.note, '<div>Line &lt;b&gt;one&lt;/b&gt;</div><div><br></div><div>Line two</div>', 'typed markup without the editor stays text');
  assert.match(mail.cleanDraft({ ...draft, format: 'html', body: '<div><br></div><script>x()</script>' }).error, /Write a message/);
  const forward = mail.cleanDraft({ ...draft, format: 'html', body: '<div><br></div>', forwarding: 'a'.repeat(24) }).value;
  assert.equal(forward.note, '', 'nothing written is nothing to sign');
});

test('mail: what goes out has a plain-text and a designed version, signed by the address it is from', async (t) => {
  const calls = mailStubs(t, RECEIVED, [{ address: MAILBOXES[0].address, text: 'Ana Lima\nSupport team' }]);
  const { value } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Hello', format: 'html', body: '<div>Hi <b>Bo</b></div><ul><li>One</li></ul><a href="https://a.example">Guide</a>' });
  await mail.send(value);
  const { text, html } = calls.sent[0].body;
  assert.equal(text, 'Hi Bo\n\n- One\n\nGuide (https://a.example)\n\n-- \nAna Lima\nSupport team');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<b>Bo<\/b>/);
  assert.match(html, /<ul style="margin:0 0 16px;padding-left:24px;/, 'styled inline, as email apps need');
  assert.match(html, /<a style="color:#c11562;text-decoration:underline;" href="https:\/\/a.example">Guide<\/a>/);
  assert.match(html, /Ana Lima\nSupport team<\/p>/);
  assert.match(html, /max-width:480px/, 'the same card as the account emails');
  assert.equal(calls.saved[0].html, html, 'kept as it went out');
  assert.ok(!calls.saved[0].searchText.includes('support team'), 'search goes by what was written, not by the signature');
  assert.ok(calls.saved[0].searchText.includes('hi bo'));
});

test('mail: signatures: each mailbox signs with its name until set, an empty one signs with nothing, and what is typed is escaped', async (t) => {
  const support = MAILBOXES[0].address;
  const calls = mailStubs(t, RECEIVED, [{ address: support, text: '' }, { address: MAILBOXES[1].address, text: 'Rosa <b>&</b> team' }]);
  const signed = await mail.signatures();
  assert.equal(signed[support], '');
  assert.equal(signed[MAILBOXES[2].address], MAILBOXES[2].name);
  const draftFrom = (address) => mail.cleanDraft({ from: address, to: 'bo@example.com', subject: 'Hi', body: 'Words' }).value;
  await mail.send(draftFrom(support));
  assert.equal(calls.sent[0].body.text, 'Words', 'no signature, no separator');
  await mail.send(draftFrom(MAILBOXES[1].address));
  assert.match(calls.sent[1].body.text, /-- \nRosa <b>&<\/b> team$/);
  assert.match(calls.sent[1].body.html, /Rosa &lt;b&gt;&amp;&lt;\/b&gt; team/);
  await mail.send(draftFrom(MAILBOXES[2].address));
  assert.match(calls.sent[2].body.text, new RegExp(`-- \\n${MAILBOXES[2].name}$`));
});

test('mail: signatures: saving writes every mailbox, trimmed, and says who did', async (t) => {
  const writes = [];
  t.mock.method(MailSignature, 'updateOne', async (filter, update, options) => { writes.push({ filter, update, options }); });
  await mail.saveSignatures({ [MAILBOXES[0].address]: '  Ana\r\nSupport  ' }, { by: 'ops@example.dev' });
  assert.equal(writes.length, MAILBOXES.length);
  assert.deepEqual(writes[0].update.$set, { text: 'Ana\nSupport', updatedBy: 'ops@example.dev' });
  assert.equal(writes[0].options.upsert, true);
  assert.equal(writes[1].update.$set.text, '', 'one left out is empty');
});

test('mail: a reply and a forward carry their original under the signature, in both versions, and a bare forward has no signature', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  t.mock.method(MailThread, 'findById', () => ({ lean: async () => ({ counterpart: RECEIVED.from }) }));
  const { value: reply } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'ana@example.com', subject: 'Re: Billing', body: 'Done.', answering: RECEIVED._id });
  await mail.send(reply);
  assert.match(calls.sent[0].body.text, /^Done\.\n\n-- \nGenLPT Support\n\nOn Jul 1, 2026/);
  assert.match(calls.sent[0].body.text, /wrote:\n> My invoice is attached\.$/);
  assert.match(calls.sent[0].body.html, /GenLPT Support<\/p>\n<p style="[^"]*">On Jul 1, 2026[\s\S]*wrote:\nMy invoice is attached\.<\/p>/, 'the design marks the quote, so no "> " there');
  const { value: bare } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'bo@example.com', subject: 'Fwd: Billing', body: '', forwarding: RECEIVED._id });
  await mail.send(bare);
  assert.match(calls.sent[1].body.text, /^---------- Forwarded message/);
  assert.ok(!calls.sent[1].body.html.includes('GenLPT Support'));
  assert.match(calls.sent[1].body.html, /Forwarded message/);
});

function draftStubs(t, existing = null) {
  const calls = { created: [], updated: [], deleted: [], put: [], removed: [], asked: [] };
  t.mock.method(MailDraft, 'findOne', (filter) => { calls.asked.push(filter); return { lean: async () => (existing && filter._id === existing._id && filter.createdBy === existing.createdBy ? existing : null) }; });
  t.mock.method(MailDraft, 'create', async (fields) => { calls.created.push(fields); return { _id: 'new-draft', ...fields }; });
  t.mock.method(MailDraft, 'findOneAndUpdate', (filter, update) => { calls.updated.push({ filter, set: update.$set }); return { lean: async () => ({ _id: filter._id, ...update.$set }) }; });
  t.mock.method(MailDraft, 'deleteOne', async (filter) => { calls.deleted.push(filter); });
  t.mock.method(mail.draftFileStore, 'put', async (file) => { calls.put.push(file.originalname); return `stored-${file.originalname}`; });
  t.mock.method(mail.draftFileStore, 'remove', async (id) => { calls.removed.push(id); });
  return calls;
}
const OPS = 'ops@example.dev';

test('mail drafts: anything can be saved unchecked, cleaned of what it shouldn\'t hold; nothing at all saves nothing', async (t) => {
  const calls = draftStubs(t);
  const saved = await mail.saveDraft({ from: 'someone@elsewhere.com', to: 'not an address,  another', subject: '  Half\n a thought ', format: 'html', body: '<div onclick="x()">Hi <b>Ana</b><script>alert(1)</script></div>', t: 'not an id', answering: 'a'.repeat(24), attachments: 'one' }, { by: OPS });
  assert.equal(saved._id, 'new-draft');
  const [fields] = calls.created;
  assert.equal(fields.createdBy, OPS);
  assert.equal(fields.from, '', 'an address that isn\'t ours is none');
  assert.equal(fields.to, 'not an address, another');
  assert.equal(fields.subject, 'Half a thought');
  assert.equal(fields.body, '<div>Hi <b>Ana</b></div>');
  assert.equal(fields.text, 'Hi Ana');
  assert.equal(fields.t, '');
  assert.equal(fields.answering, 'a'.repeat(24));
  assert.deepEqual(fields.attachments, ['one']);
  assert.equal(await mail.saveDraft({ format: 'html', body: '<div><br></div><script>x()</script>', to: '  ', subject: '' }, { by: OPS }), null);
  assert.equal(calls.created.length, 1);
  const plain = await mail.saveDraft({ body: 'Line <b>one</b>\r\nLine two' }, { by: OPS });
  assert.equal(plain.body, '<div>Line &lt;b&gt;one&lt;/b&gt;</div><div>Line two</div>', 'without the editor: plain text, kept as text');
});

test('mail drafts: a draft\'s files are kept apart, and an empty one isn\'t; too many bytes or too long a message isn\'t saved', async (t) => {
  const calls = draftStubs(t);
  const upload = (originalname, size = 5) => ({ originalname, size, mimetype: 'application/pdf', buffer: Buffer.alloc(size) });
  await mail.saveDraft({ subject: 'Files' }, { by: OPS, uploads: [upload('reçu.pdf'), upload('empty.txt', 0)] });
  assert.deepEqual(calls.put, ['reçu.pdf']);
  assert.deepEqual(calls.created[0].files, [{ id: 'stored-reçu.pdf', filename: 'reçu.pdf', contentType: 'application/pdf', size: 5 }]);
  await mail.saveDraft({ to: 'a@example.com' }, { by: OPS, uploads: [{ ...upload('x'), size: 29 * 1024 * 1024 + 1 }] }).then(() => assert.fail('saved'), (err) => assert.match(err.message, /over the 29 MB/));
  await mail.saveDraft({ format: 'html', body: `<div>${'x'.repeat(20001)}</div>` }, { by: OPS }).then(() => assert.fail('saved'), (err) => assert.match(err.message, /under 20000/));
  assert.equal(calls.created.length, 1);
});

test('mail drafts: saving again replaces a draft and its old files; another admin\'s is left alone', async (t) => {
  const id = 'f'.repeat(24);
  const existing = { _id: id, createdBy: OPS, files: [{ id: 'old-file' }] };
  const calls = draftStubs(t, existing);
  const saved = await mail.saveDraft({ d: id, subject: 'Second go' }, { by: OPS, uploads: [{ originalname: 'new.pdf', size: 5, buffer: Buffer.alloc(5) }] });
  assert.equal(saved._id, id);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated[0].set.subject, 'Second go');
  assert.equal(calls.updated[0].set.files[0].id, 'stored-new.pdf');
  assert.deepEqual(calls.removed, ['old-file']);
  const theirs = await mail.saveDraft({ d: id, subject: 'Not mine' }, { by: 'other@example.dev' });
  assert.equal(calls.created.length, 1, 'a draft of their own instead');
  assert.equal(calls.created[0].createdBy, 'other@example.dev');
  assert.equal(calls.updated.length, 1);
  assert.equal(theirs._id, 'new-draft');
});

test('mail drafts: deleting takes its files with it, and only one\'s own', async (t) => {
  const id = 'f'.repeat(24);
  const calls = draftStubs(t, { _id: id, createdBy: OPS, files: [{ id: 'f1' }, { id: 'f2' }] });
  await mail.deleteDraft(id, 'other@example.dev');
  assert.equal(calls.deleted.length, 0);
  await mail.deleteDraft('nonsense', OPS);
  assert.equal(calls.deleted.length, 0);
  await mail.deleteDraft(id, OPS);
  assert.deepEqual(calls.deleted, [{ _id: id }]);
  assert.deepEqual(calls.removed, ['f1', 'f2']);
});

test('mail page: new and unread mail stands out in the brand\'s color; what\'s read or being read doesn\'t', async () => {
  const fresh = { ...OPENED.thread, _id: 'a'.repeat(24), unread: 2 };
  const read = { ...OPENED.thread, _id: 'b'.repeat(24), unread: 0 };
  const open = { ...OPENED.thread, _id: 'd'.repeat(24), unread: 1 };
  const html = await drawMail({ opened: OPENED, list: { threads: [fresh, read, open], more: false } });
  const rows = html.split('<li>').slice(1, 4).filter((row) => row.includes('href="/mail?box=support'));
  const [freshRow, readRow, openRow] = rows;
  assert.match(freshRow, /border-l-brand bg-cerise-50/);
  assert.match(freshRow, /bg-brand text-on-brand/);
  assert.match(freshRow, /text-on-brand">New</);
  assert.match(freshRow, /font-semibold text-cerise-700/);
  for (const row of [readRow, openRow]) {
    assert.doesNotMatch(row, /bg-cerise-50|bg-brand|>New</);
    assert.match(row, /border-l-transparent/);
  }
});

test('mail design: the account emails and the team mailbox share one card', () => {
  const account = templates.resetPassword({ url: 'https://x.example/r' }).html;
  const team = templates.mailboxMessage({ note: '<div>Hi</div>', signature: 'Ana', quote: '> quoted <b>' });
  const card = (html) => html.slice(0, html.indexOf('</p>'));
  assert.equal(card(team), card(account));
  assert.match(team, /&gt; quoted &lt;b&gt;/, 'what is quoted stays text');
  assert.equal(templates.mailboxMessage({ note: '' }).includes('undefined'), false);
});

test('mail page: a sent email shows as it went out, measured but with no script; what came in stays locked down', async () => {
  const sent = { ...RECEIVED, _id: 'e'.repeat(24), direction: 'out', html: '<!doctype html>\n<html lang="en">\n<body style="margin:0"><p>Sent words</p></body>\n</html>', attachments: [] };
  const html = await drawMail({ opened: { ...OPENED, messages: [sent] } });
  assert.match(html, /<iframe data-fit sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(html, /allow-scripts/);
  assert.match(html, /&lt;base target=&#34;_blank&#34;&gt;/);
  const received = await drawMail({ opened: { ...OPENED, messages: [{ ...RECEIVED, html: '<p>Their words</p>', attachments: [] }] } });
  assert.match(received, /<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.doesNotMatch(received, /allow-same-origin|data-fit/);
});

test('mail page: the quote under a plain-text email is set apart, without its marks', async () => {
  const text = 'Thank you.\n\nOn Nov 1, 2026, Ana <ana@example.com> wrote:\n> Hello <b>there</b>';
  const html = await drawMail({ opened: { ...OPENED, messages: [{ ...RECEIVED, html: null, text, attachments: [] }] } });
  assert.match(html, />Thank you\.<\/div>/);
  assert.match(html, /<blockquote[^>]*text-sm[^>]*>On Nov 1, 2026, Ana &lt;ana@example.com&gt; wrote:\nHello &lt;b&gt;there&lt;\/b&gt;<\/blockquote>/);
  const plain = await drawMail({ opened: { ...OPENED, messages: [{ ...RECEIVED, html: null, text: 'Only words', attachments: [] }] } });
  assert.doesNotMatch(plain, /<blockquote/);
});

test('mail search: looks through who, subject, words and attachment names, without accents, tags or our own addresses', () => {
  const text = mail.searchTextOf({
    direction: 'in',
    from: { name: 'François Dubois', address: 'francois@example.fr' },
    to: ['support@genlpt.com', 'bo@example.com'],
    cc: ['cy@example.com'],
    replyTo: ['ana@example.com'],
    subject: 'Reçu de Paiement',
    html: '<p style="color:red">Mon cœur &amp; don’t</p>',
    attachments: [{ filename: 'Facture-Octobre.PDF' }],
  });
  for (const part of ['francois dubois', 'francois@example.fr', 'bo@example.com', 'cy@example.com', 'ana@example.com', 'recu de paiement', 'coeur', "don't", 'facture-octobre.pdf']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes('genlpt'), 'our own address would match every email');
  assert.ok(!text.includes('color'), 'an HTML email is searched by its words, not its tags');
  const sent = mail.searchTextOf({ direction: 'out', from: { name: 'GenLPT Support', address: 'support@genlpt.com' }, to: ['ana@example.com'], subject: 'Hi', text: 'Done.' });
  assert.equal(sent, 'ana@example.com hi done.');
});

test('mail search: words are folded, without repeats, and an email must have them all', () => {
  assert.deepEqual(mail.searchWords('  Reçu   RECU facture '), ['recu', 'facture']);
  assert.deepEqual(mail.searchWords('   '), []);
  assert.deepEqual(mail.searchWords(undefined), []);
  assert.equal(mail.searchWords('a b c d e f g h i j k l m').length, 10);
  assert.equal(mail.cleanQuery(['a', 'b']), '');
  assert.equal(mail.cleanQuery('x'.repeat(500)).length, mail.QUERY_MAX_CHARS);
  const email = { direction: 'in', from: { name: 'Ana', address: 'ana@example.com' }, subject: 'Invoice', text: 'Refund please' };
  assert.equal(mail.matchesSearch(email, 'INVO'), true);
  assert.equal(mail.matchesSearch(email, 'refund ana'), true);
  assert.equal(mail.matchesSearch(email, 'refund bo'), false);
  assert.equal(mail.matchesSearch(email, ''), false);
});

test('mail search: a query becomes literal words over the threads, and older emails get their text once', async (t) => {
  const asked = {};
  const updated = [];
  t.mock.method(MailMessage, 'find', () => ({ lean: () => ({ cursor: () => (async function* older() { yield { _id: 'm0', direction: 'in', subject: 'Old one' }; })() }) }));
  t.mock.method(MailMessage, 'updateOne', async (filter, update) => { updated.push([filter._id, update.$set.searchText]); });
  t.mock.method(MailMessage, 'distinct', async (field, filter) => { asked.field = field; asked.words = filter.$and.map((w) => w.searchText.source); return ['t1']; });
  t.mock.method(MailThread, 'find', (filter) => { asked.threads = filter; return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; });
  await mail.listThreads(mail.boxOf('support'), { query: 'A.b (C' });
  assert.equal(asked.field, 'threadId');
  assert.deepEqual(asked.words, ['a\\.b', '\\(c']);
  assert.deepEqual(asked.threads._id, { $in: ['t1'] });
  assert.equal(asked.threads.mailbox, 'support@genlpt.com');
  assert.deepEqual(updated, [['m0', 'old one']]);
  await mail.listThreads(mail.boxOf('support'), { query: 'again' });
  assert.equal(updated.length, 1);
  await mail.listThreads(mail.boxOf('support'), { query: '   ' });
  assert.equal(asked.threads._id, undefined);
});

test('mail search: an email saved from now on can be found', async (t) => {
  const calls = mailStubs(t, RECEIVED);
  await mail.send(forwardDraft());
  assert.ok(calls.saved[0].searchText.includes('can you look?'));
  assert.ok(calls.saved[0].searchText.includes('my invoice is attached.'));
});

test('mail page: the header has the search bar, what was searched is escaped, and the list keeps it', async () => {
  const q = '<img src=x>';
  const sync = { action: '/mail/sync', hidden: { box: 'support', q, t: 'abc' } };
  const search = { action: '/mail', value: q, label: 'Search Support', maxLength: 200, hidden: { box: 'support' }, clear: '/mail?box=support', phone: true, sync };
  const html = await drawMail({ q, search, list: { threads: [OPENED.thread], more: true } });
  assert.match(html, /role="search"/);
  const checkForMail = html.slice(html.indexOf('</form>', html.indexOf('role="search"')));
  assert.match(checkForMail, /action="\/mail\/sync"[\s\S]*name="box" value="support"[\s\S]*name="q" value="&lt;img src=x&gt;"[\s\S]*name="t" value="abc"[\s\S]*aria-label="Check for mail"/, 'right after the search field, keeping what is open');
  assert.equal((html.match(/action="\/mail\/sync"/g) || []).length, 1, 'and only there');
  assert.match(html, /placeholder="Search Support"/);
  assert.match(html, /aria-label="Clear search"/);
  assert.ok(!html.includes('<img src=x>'));
  assert.match(html, /Results for “&lt;img src=x&gt;”/);
  assert.ok(html.includes('q=%3Cimg+src%3Dx%3E&amp;t='), 'opening a result keeps the results listed');
  assert.ok(/q=%3Cimg\+src%3Dx%3E&amp;before=/.test(html), 'so does the next page');
  assert.match(html, /name="q" value="&lt;img src=x&gt;"/);
});

test('mail page: nothing found says so, and offers the other of Inbox and Sent, then the other mailboxes', async () => {
  const offered = (page) => [.../<p class="mt-2">Try ([\s\S]*?)<\/p>/.exec(page)[1].matchAll(/href="\/mail\?([^"]*)"/g)].map((match) => match[1]);
  const inbox = await drawMail({ q: 'refund' });
  assert.match(inbox, /Nothing in Inbox matches “refund”/);
  assert.deepEqual(offered(inbox), ['box=support&amp;folder=sent&amp;q=refund', 'box=privacy&amp;q=refund', 'box=alerts&amp;q=refund', 'box=other&amp;q=refund'], 'not the one that found nothing');
  const sent = await drawMail({ q: 'refund', folder: mail.folderOf('sent') });
  assert.match(sent, /Nothing in Sent matches “refund”/);
  assert.deepEqual(offered(sent), ['box=support&amp;q=refund', 'box=privacy&amp;folder=sent&amp;q=refund', 'box=alerts&amp;folder=sent&amp;q=refund', 'box=other&amp;folder=sent&amp;q=refund']);
  const starred = await drawMail({ q: 'refund', folder: mail.folderOf('starred') });
  assert.deepEqual(offered(starred), ['box=privacy&amp;folder=starred&amp;q=refund', 'box=alerts&amp;folder=starred&amp;q=refund', 'box=other&amp;folder=starred&amp;q=refund'], 'only Inbox and Sent are two halves of one mailbox');
});

test('mail page: in a longer thread, the email a search found stays open', async () => {
  const older = { ...RECEIVED, _id: 'f'.repeat(24), read: true, subject: 'Billing', text: 'The first email', attachments: [] };
  const latest = { ...RECEIVED, read: true, text: 'The last one', attachments: [] };
  const opened = { ...OPENED, messages: [older, latest] };
  const openDetails = (html) => (html.match(/<details[^>]*\sopen\s*>/g) || []).length;
  assert.equal(openDetails(await drawMail({ opened })), 1);
  assert.equal(openDetails(await drawMail({ opened, q: 'first' })), 2);
});

test('mail mailboxes: one at a time, the first by default, and a conversation shows at its own', () => {
  assert.deepEqual(mail.BOXES.map((b) => b.key), ['support', 'privacy', 'alerts', 'other']);
  assert.equal(mail.boxOf(undefined).key, 'support');
  assert.equal(mail.boxOf('all').key, 'support', 'an old link');
  assert.equal(mail.boxOfThread({ mailbox: 'privacy@genlpt.com' }).key, 'privacy');
  assert.equal(mail.boxOfThread({ mailbox: null }).key, 'other');
  assert.equal(mail.boxOfThread({ mailbox: 'retired@genlpt.com' }).key, 'other');
});

test('mail mailboxes: unread counts go by mailbox, what is at no mailbox under Other, and all of them together', async (t) => {
  t.mock.method(MailThread, 'aggregate', async () => [{ _id: 'support@genlpt.com', unread: 2 }, { _id: null, unread: 3 }, { _id: 'retired@genlpt.com', unread: 4 }]);
  assert.deepEqual(await mail.unreadCounts(), { all: 9, support: 2, other: 7 });
});

test('mail folders: each is within the mailbox chosen; Trash alone holds what was deleted', async (t) => {
  const asked = [];
  t.mock.method(MailMessage, 'distinct', async () => []);
  t.mock.method(MailThread, 'find', (filter) => { asked.push(filter); return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; });
  const ask = (box, folder) => mail.listThreads(mail.boxOf(box), { folder: mail.folderOf(folder) });
  await ask('support');
  await ask('other');
  await ask('support', 'starred');
  await ask('support', 'trash');
  const [support, other, starred, trash] = asked;
  assert.equal(support.trashedAt, null);
  assert.equal(support.mailbox, 'support@genlpt.com');
  assert.equal('starred' in support, false);
  assert.deepEqual(other.mailbox, { $nin: MAILBOXES.map((m) => m.address) }, 'whatever is at no mailbox, now or any more');
  assert.equal(starred.trashedAt, null);
  assert.equal(starred.starred, true);
  assert.equal(starred.mailbox, 'support@genlpt.com');
  assert.deepEqual(trash.trashedAt, { $ne: null });
  assert.equal(trash.mailbox, 'support@genlpt.com');
});

test('mail folders: Inbox holds the conversations with an email received, Sent those with one sent', async (t) => {
  const asked = [];
  const distinct = t.mock.method(MailMessage, 'distinct', async (field, match) => [match.direction || 'matched']);
  t.mock.method(MailThread, 'countDocuments', async () => 1);
  t.mock.method(MailThread, 'find', (filter) => { asked.push(filter); return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; });
  const ask = (folder, shown) => mail.listThreads(mail.boxOf('support'), { folder: mail.folderOf(folder), ...shown });
  await ask('inbox');
  await ask('sent');
  const [inbox, sent] = asked;
  assert.deepEqual(distinct.mock.calls.map((call) => call.arguments), [['threadId', { direction: 'in' }], ['threadId', { direction: 'out' }]]);
  assert.deepEqual(inbox.$and, [{ _id: { $in: ['in'] } }]);
  assert.deepEqual(sent.$and, [{ _id: { $in: ['out'] } }]);
  for (const filter of [inbox, sent]) {
    assert.equal(filter.mailbox, 'support@genlpt.com');
    assert.equal(filter.trashedAt, null, 'what was deleted is only in Trash');
  }

  await ask('inbox', { author: 'ana' });
  assert.deepEqual(asked.at(-1).$and, [{ _id: { $in: ['in'] } }, { _id: { $in: ['matched'] } }], 'the filter narrows the folder, it does not replace it');

  const calls = distinct.mock.calls.length;
  await ask('starred');
  assert.equal(asked.at(-1).$and, undefined);
  assert.equal(distinct.mock.calls.length, calls, 'no other folder needs a look through the emails');
  assert.equal(mail.folderOf().key, 'inbox', 'the first, where the page opens');
  assert.equal(mail.folderOf('mail').key, 'inbox', 'a page left open from when there was an All mail');
});

test('mail folders: what is in Trash counts for no unread badge', async (t) => {
  const aggregate = t.mock.method(MailThread, 'aggregate', async () => []);
  await mail.unreadCounts();
  assert.equal(aggregate.mock.calls[0].arguments[0][0].$match.trashedAt, null);
});

test('mail: anything new in a thread in Trash brings it back', async (t) => {
  mailStubs(t, RECEIVED);
  t.mock.method(MailThread, 'findById', () => ({ lean: async () => ({ counterpart: RECEIVED.from }) }));
  const { value } = mail.cleanDraft({ from: MAILBOXES[0].address, to: 'ana@example.com', subject: 'Re: Billing', body: 'Done.', answering: RECEIVED._id });
  await mail.send(value);
  const counted = MailThread.updateOne.mock.calls.map((call) => call.arguments[1]).find((update) => update.$inc);
  assert.equal(counted.$set.trashedAt, null);
});

test('mail list: the threads around one are the nearest each way, in the same folder and filter', async (t) => {
  const asked = [];
  t.mock.method(MailThread, 'findOne', (filter) => ({ sort: (order) => { asked.push({ filter, order }); return { lean: async () => ({ _id: order.lastAt }) }; } }));
  const at = new Date('2026-07-01T16:00:00Z');
  const around = await mail.threadsAround(mail.boxOf('support'), { lastAt: at }, { folder: mail.folderOf('starred'), unreadOnly: true });
  assert.deepEqual(asked.map((a) => a.filter.lastAt), [{ $gt: at }, { $lt: at }]);
  assert.deepEqual(asked.map((a) => a.order), [{ lastAt: 1 }, { lastAt: -1 }]);
  for (const { filter } of asked) {
    assert.equal(filter.mailbox, 'support@genlpt.com');
    assert.equal(filter.starred, true);
    assert.deepEqual(filter.unread, { $gt: 0 });
  }
  assert.deepEqual(around, { newer: { _id: 1 }, older: { _id: -1 } });
});

const NEWER = { ...OPENED.thread, _id: 'e'.repeat(24), lastAt: new Date('2026-07-02T00:00:00Z') };
const OLDER = { ...OPENED.thread, _id: 'f'.repeat(24), lastAt: new Date('2026-06-30T00:00:00Z') };
const REPLYABLE = { new: EMPTY_FORM, reply: EMPTY_FORM, forward: { [RECEIVED._id]: EMPTY_FORM } };
const linkTo = (html, label) => new RegExp(`<a href="([^"]*)" class="icon-btn" aria-label="${label}"`).exec(html)?.[1].replace(/&amp;/g, '&');

test('mail page: Reply and Forward on the left; on the right previous, what can be done, then next', async () => {
  const html = await drawMail({ opened: OPENED, drafts: REPLYABLE, around: { newer: NEWER, older: OLDER }, list: { threads: [NEWER, OPENED.thread, OLDER], more: false } });
  const bar = html.slice(html.indexOf('reply=1'));
  assert.match(bar, /<span>Reply<\/span>[\s\S]*<span>Forward<\/span>[\s\S]*aria-label="Previous email"[\s\S]*aria-label="Mark unread"[\s\S]*aria-label="Print"[\s\S]*aria-label="Star"[\s\S]*aria-label="Delete"[\s\S]*aria-label="Next email"/);
  assert.ok(html.indexOf('aria-label="Mark unread"') > html.indexOf('<h2'), 'no longer above the email');
  assert.equal((html.match(/aria-label="Mark unread"/g) || []).length, 1);
  assert.match(linkTo(html, 'Previous email'), new RegExp(`t=${NEWER._id}$`));
  assert.match(linkTo(html, 'Next email'), new RegExp(`t=${OLDER._id}$`));
  assert.match(html, new RegExp(`href="/mail/threads/${OPENED.thread._id}/print" target="_blank"`));
});

test('mail page: previous and next are off at the ends of the list, and take it along to another of its pages', async () => {
  const ends = await drawMail({ opened: OPENED, drafts: REPLYABLE });
  assert.match(ends, /<button type="button" disabled class="icon-btn" aria-label="Previous email"/);
  assert.match(ends, /<button type="button" disabled class="icon-btn" aria-label="Next email"/);
  const paged = await drawMail({ opened: OPENED, drafts: REPLYABLE, around: { newer: NEWER, older: OLDER }, list: { threads: [OPENED.thread], more: true } });
  assert.equal(new URL(linkTo(paged, 'Next email'), 'http://x').searchParams.get('before'), OPENED.thread.lastAt.toISOString());
  assert.equal(new URL(linkTo(paged, 'Previous email'), 'http://x').searchParams.get('before'), '2026-07-02T00:00:00.001Z', 'its page starts just above it');
});

test('mail page: what can be done to a thread goes by its state, and its forms carry the list as it is', async () => {
  const plain = await drawMail({ opened: OPENED, drafts: REPLYABLE, q: 'invoice', filters: mail.cleanFilters({ unread: '1' }), before: new Date('2026-07-05T00:00:00Z') });
  const star = plain.slice(plain.indexOf(`/threads/${OPENED.thread._id}/star`), plain.indexOf('aria-label="Star"'));
  for (const [name, value] of [['box', 'support'], ['q', 'invoice'], ['unread', '1'], ['before', '2026-07-05T00:00:00.000Z'], ['on', '1']]) assert.ok(star.includes(`name="${name}" value="${value}"`), name);
  assert.match(plain, /aria-label="Star"[^>]*aria-pressed="false"/);

  const starred = { ...OPENED.thread, starred: true };
  const on = await drawMail({ opened: { ...OPENED, thread: starred }, drafts: REPLYABLE, list: { threads: [starred], more: false } });
  assert.match(on, /name="on" value="0"/);
  assert.match(on, /aria-label="Star"[^>]*aria-pressed="true"/);
  assert.match(on, /boxicons:star-filled" width="14"[^>]*aria-label="Starred"/, 'in the list too');

  const trashed = await drawMail({ opened: { ...OPENED, thread: { ...OPENED.thread, trashedAt: new Date() } }, drafts: REPLYABLE });
  assert.match(trashed, /aria-label="Restore"/);
  assert.doesNotMatch(trashed, /aria-label="Delete"/);

  const sentOnly = await drawMail({ opened: { ...OPENED, messages: [{ ...RECEIVED, direction: 'out', attachments: [] }] }, drafts: REPLYABLE });
  assert.match(sentOnly, /aria-label="Mark unread" title="Mark unread"[^>]*disabled/, 'nothing received to mark');
});

test('mail print: every email in full, as words with its quote set apart, with no frame and nothing unescaped', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/admin/mail-print.ejs'), {
    mail,
    thread: { ...OPENED.thread, subject: 'Billing <b>' },
    messages: [
      { ...RECEIVED, text: null, html: '<p>Their <b>own</b> words</p><script>x()</script>' },
      { ...RECEIVED, _id: 'b'.repeat(24), direction: 'out', from: { name: 'GenLPT Support', address: 'support@genlpt.com' }, text: 'Thanks.\n\nOn Jul 1, 2026, Ana <ana@example.com> wrote:\n> <i>Hello</i>', html: '<body>designed</body>', attachments: [] },
    ],
  });
  assert.doesNotMatch(html, /<iframe|<details|<script>x|designed/);
  assert.match(html, /<title>Billing &lt;b&gt;<\/title>/);
  assert.match(html, />Their own words<\/div>/);
  assert.match(html, />Thanks\.<\/div>/);
  assert.match(html, /<blockquote[^>]*>On Jul 1, 2026, Ana &lt;ana@example.com&gt; wrote:\n&lt;i&gt;Hello&lt;\/i&gt;<\/blockquote>/);
  assert.match(html, /Attachments: report\.pdf, old\.pdf/);
  assert.match(html, /<script src="\/js\/mail-print\.js"><\/script>/);
});

test('mail page: the files attached are one row of their own, above the formatting buttons and apart from them', async () => {
  const html = await drawMail();
  const box = html.slice(html.indexOf('id="mail-editor-box"'));
  const [editor, files, toolbar] = ['id="mail-editor"', 'id="mail-files"', 'role="toolbar"'].map((part) => box.indexOf(part));
  assert.ok(editor > 0 && editor < files && files < toolbar);
  const row = /<ul id="mail-files"[^>]*class="([^"]*)"/.exec(html)[1].split(' ');
  for (const name of ['flex', 'shrink-0', 'overflow-x-auto', '[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden']) assert.ok(row.includes(name), name);
  assert.ok(!row.includes('flex-wrap'));
  assert.match(html, /<template id="mail-file">\s*<li class="flex shrink-0[\s\S]*boxicons:paperclip[\s\S]*data-name[\s\S]*data-size[\s\S]*Remove this file[\s\S]*<\/template>/);
});

test('mail form: a file\'s badge shows the first 20 characters of its name, then its extension', async () => {
  const { shortName } = await import('../public/js/mail-attachments.js');
  assert.equal(shortName('dispatch_michael_admin000_creds.txt'), 'dispatch_michael_adm….txt');
  assert.equal(shortName('genlpt-data-2026-10-27.json'), 'genlpt-data-2026-10-….json');
  assert.equal(shortName('exactly-twenty-chars.pdf'), 'exactly-twenty-chars.pdf', 'nothing to cut');
  assert.equal(shortName('short.png'), 'short.png');
  assert.equal(shortName('archive.backup.2026.tar.gz'), 'archive.backup.2026.….gz');
  assert.equal(shortName('no extension at all in this long name'), 'no extension at all …');
  assert.equal(shortName('notes.this is not an extension at all'), 'notes.this is not an…', 'a space after the dot: not an extension');
  assert.equal(shortName('.env'), '.env');
  assert.equal(shortName(`${'é'.repeat(25)}.pdf`), `${'é'.repeat(20)}….pdf`);
  assert.equal(shortName(`${'😀'.repeat(25)}.pdf`), `${'😀'.repeat(20)}….pdf`, 'whole characters, not halves');
});

test('mail page: the sidebar holds the folders of the mailbox chosen, and no mailboxes', async () => {
  const html = await drawMail({ folder: mail.folderOf('trash'), counts: { all: 5, support: 2, drafts: 3 } });
  const nav = html.slice(html.indexOf('aria-label="Folders"'), html.indexOf('</nav>', html.indexOf('aria-label="Folders"')));
  assert.deepEqual([...nav.matchAll(/href="([^"]*)"/g)].map((match) => match[1]), [
    '/mail?box=support',
    '/mail?box=support&amp;folder=sent',
    '/mail?box=support&amp;folder=starred',
    '/mail?box=support&amp;folder=drafts',
    '/mail?box=support&amp;folder=trash',
  ]);
  assert.match(nav, /folder=trash" aria-current="page"/);
  assert.match(nav, /Inbox<\/span>\s*<span[^>]*>2<span class="sr-only"> unread/, 'what is unread in this mailbox, not in all of them');
  assert.doesNotMatch(nav, /Sent<\/span>\s*<span/, 'all that is unread was received');
  assert.doesNotMatch(nav, /All mail/);
  assert.match(nav, /boxicons:inbox[\s\S]*Inbox[\s\S]*boxicons:send[\s\S]*Sent/);
  assert.match(nav, /Drafts<\/span>\s*<span[^>]*>3<span class="sr-only"> saved/);
  assert.doesNotMatch(nav, /genlpt\.com|Support|Privacy|Alerts/);
  assert.match(html, /<h1 class="sr-only">Support: Trash<\/h1>/, 'said to screen readers: the sidebar shows it');
  assert.match(html, /name="folder" value="trash"/);
});

test('mail page: the mailbox is chosen at the top of the sidebar, above New email', async () => {
  const options = mail.BOXES.map((b) => ({ ...b, href: `/mail?box=${b.key}&folder=trash`, unread: b.key === 'privacy' ? 4 : 0 }));
  const html = await drawMail({ mailboxMenu: { chosen: mail.boxOf('support'), options, elsewhere: true } });
  assert.doesNotMatch(html.slice(html.indexOf('<header'), html.indexOf('</header>')), /mailbox-menu/);
  const aside = html.slice(html.indexOf('id="mail-folders"'), html.indexOf('</aside>'));
  const [choice, write, folders] = ['popovertarget="mailbox-menu"', '>New email</a>', 'aria-label="Folders"'].map((part) => aside.indexOf(part));
  assert.ok(choice > 0 && choice < write && write < folders);
  const sender = aside.slice(aside.indexOf('id="mail-sender"'), folders);
  assert.ok(sender.includes('popovertarget="mailbox-menu"') && sender.includes('>New email</a>'), 'together: a new email goes out from that mailbox');
  assert.doesNotMatch(/id="mail-sender" class="([^"]*)"/.exec(aside)[1], /border|\bp-\d/, 'with no box around them, so they get the full width');
  assert.doesNotMatch(sender.slice(sender.indexOf('compose=1')), /iconify-icon/, 'New email is words only');
  assert.match(aside, /id="mailbox-menu" popover data-menu="left"/, 'wider than the sidebar: it opens from the left edge');
  assert.match(html, /<aside id="mail-folders" class="[^"]*\brelative\b[^"]*overflow-x-auto/, 'on a phone, what is only for screen readers would otherwise widen the page');
  assert.match(html, /id="admin-menu" popover data-menu="right"/);
  const button = aside.slice(choice, aside.indexOf('</button>'));
  assert.match(button, />Support<\/span>/);
  assert.match(button, />support@genlpt\.com<\/span>/);
  assert.match(button, /unread mail in other mailboxes/);
  assert.doesNotMatch(button, /chevron-down/);
  assert.match(button, /boxicons:swap-vertical[^>]*><\/iconify-icon>\s*<span class="[^"]*size-2\.5 rounded-full bg-brand/, 'its dot on the way to the others');
  assert.doesNotMatch(button.slice(0, button.indexOf('boxicons:swap-vertical')), /bg-brand/, 'not on this mailbox: the unread mail is not here');
  const menu = aside.slice(aside.indexOf('id="mailbox-menu"'), aside.indexOf('</nav>', aside.indexOf('id="mailbox-menu"')));
  assert.deepEqual([...menu.matchAll(/href="\/mail\?box=(\w+)&amp;folder=trash"/g)].map((match) => match[1]), ['support', 'privacy', 'alerts', 'other']);
  assert.match(menu, /box=support&amp;folder=trash" aria-current="true"/);
  assert.match(menu, />Other addresses<\/span>/);
  assert.match(menu, />4<span class="sr-only"> unread/);
  const quiet = await drawMail({ mailboxMenu: { chosen: mail.boxOf('privacy'), options, elsewhere: false } });
  assert.doesNotMatch(quiet, /unread mail in other mailboxes/);
  const quietButton = quiet.slice(quiet.indexOf('popovertarget="mailbox-menu"'), quiet.indexOf('</button>', quiet.indexOf('popovertarget="mailbox-menu"')));
  assert.match(quietButton, /boxicons:swap-vertical/, 'it can still be switched');
  assert.doesNotMatch(quietButton, /bg-brand/);
});

test('mail page: in a mailbox the sender is that mailbox, shown like the menu and not chosen', async () => {
  const fromPart = (html) => html.slice(html.indexOf('name="d"'), html.indexOf('name="to"'));
  const empty = await drawMail();
  assert.doesNotMatch(empty, /<select id="mail-from"|mail-from-combobox/);
  assert.match(fromPart(empty), /<input type="hidden" name="from" value="support@genlpt.com">/, 'even before anything fills the form in');
  assert.match(fromPart(empty), /class="-mb-px grid gap-2 grid-cols-2">\s*<div class="min-w-0 rounded-md border border-zinc-200 px-3 py-2">[\s\S]*?>From<\/span>[\s\S]*?name="from"[\s\S]*?<\/div>\s*<\/div>[\s\S]*?id="mail-signature"[\s\S]*?>Signature<\/span>[\s\S]*?data-signature title="GenLPT Support" class="truncate[^>]*>GenLPT Support<\/p>\s*<a href="\/mail\/signatures" aria-label="Edit signature"[^>]*text-sm[\s\S]*?>Edit<\/span>/, 'side by side above the fields, Edit under the signature like the address under the name');
  for (const label of ['From', 'Signature']) assert.match(fromPart(empty), new RegExp(`<span class="block text-sm text-zinc-500">${label}</span>`), 'quiet, so that what it labels stands out');
  assert.match(fromPart(empty), /font-medium text-zinc-900">GenLPT Support<\/span>/);
  assert.match(fromPart(empty), /font-medium text-zinc-900">GenLPT Support<\/p>/);
  for (const m of MAILBOXES) {
    const part = fromPart(await drawMail({ box: mail.BOXES.find((b) => b.address === m.address) }));
    assert.match(part, new RegExp(`name="from" value="${m.address}"[\\s\\S]*?boxicons:${m.icon}[\\s\\S]*?>${m.name}</span>[\\s\\S]*?>${m.address}</span>`));
    assert.equal(MAILBOXES.filter((other) => part.includes(other.name)).length, 1, 'that one only');
  }

  for (const from of ['privacy@genlpt.com', 'old@genlpt.com', '']) {
    assert.match(fromPart(await drawMail({ filled: true, form: { ...EMPTY_FORM, from } })), /name="from" value="support@genlpt.com"/, 'whatever a form held');
  }
});

test('mail page: Other has no address of its own, so From is chosen there, and stays a plain select without the script', async () => {
  const options = mail.BOXES.map((b) => ({ ...b, href: `/mail?box=${b.key}`, unread: 0 }));
  const box = mail.boxOf('other');
  const html = await drawMail({ box, mailboxMenu: { chosen: box, options, elsewhere: false } });
  assert.doesNotMatch(html, /type="hidden" name="from"/);
  assert.doesNotMatch(html.slice(html.indexOf('name="d"'), html.indexOf('id="mail-from"')), /grid-cols-2|border-zinc-200/, 'a field needs the row to itself, and no box around its own');
  assert.match(html, /id="mail-signature" hidden class="min-w-0 rounded-md border border-zinc-200 px-3 py-2"/);
  assert.ok(html.indexOf('id="mail-from"') < html.indexOf('id="mail-signature"') && html.indexOf('id="mail-signature"') < html.indexOf('name="to"'), 'the signature right under it');
  assert.match(await drawMail({ box, mailboxMenu: { chosen: box, options, elsewhere: false }, filled: true, form: { ...EMPTY_FORM, from: 'privacy@genlpt.com' } }), /<option value="privacy@genlpt\.com" selected data-icon="shield"/);
  const from = html.slice(html.indexOf('<select id="mail-from"'), html.indexOf('</select>', html.indexOf('<select id="mail-from"')));
  const menu = html.slice(html.indexOf('id="mailbox-menu"'), html.indexOf('</nav>', html.indexOf('id="mailbox-menu"')));
  for (const m of MAILBOXES) {
    assert.match(from, new RegExp(`<option value="${m.address}"\\s+data-icon="${m.icon}" data-title="${m.name}" data-detail="${m.address}">${m.name} &lt;${m.address}&gt;</option>`));
    assert.ok(menu.includes(`boxicons:${m.icon}`), 'one icon for a mailbox, in both places');
  }
  assert.match(from, /<option value="" hidden selected>Choose an address<\/option>/, 'a prompt, with nothing to show beside it');
  assert.ok(menu.includes(`boxicons:${box.icon}`));
});

test('mail page: the list says whether a conversation\'s latest email was sent or received, and an email in it which it was', async () => {
  const sentThread = { ...OPENED.thread, _id: 'e'.repeat(24), lastDirection: 'out', snippet: 'Our answer' };
  const list = await drawMail({ list: { threads: [OPENED.thread, sentThread], more: false } });
  const rows = list.split('<li>').slice(1);
  const row = (id) => rows.find((part) => part.includes(`t=${id}`));
  const received = row(OPENED.thread._id);
  assert.match(received, /boxicons:arrow-down-left[^]*Received<\/span> · My invoice/);
  assert.doesNotMatch(received, />To <\/span>/);
  const sent = row(sentThread._id);
  assert.match(sent, /boxicons:arrow-up-right[^]*Sent<\/span> · Our answer/);
  assert.match(sent, />To <\/span>Ana/, 'whom it went to');
  assert.doesNotMatch(list, /You: /);

  const ours = { ...RECEIVED, _id: 'b'.repeat(24), direction: 'out', attachments: [] };
  const open = await drawMail({ opened: { ...OPENED, messages: [{ ...RECEIVED, attachments: [] }, ours] } });
  const reading = open.slice(open.indexOf('id="mail-reading"'), open.indexOf('id="mail-writing"'));
  assert.equal((reading.match(/>Received<\/span>/g) || []).length, 1);
  assert.equal((reading.match(/>Sent<\/span>/g) || []).length, 1);
});

test('mail filter: unread, who wrote it and between which days; what makes no sense is left out', () => {
  assert.deepEqual(mail.cleanFilters(), { unreadOnly: false, author: '', recipient: '', since: '', until: '' });
  assert.deepEqual(mail.cleanFilters({ unread: '1', author: '  Ana   Lima ', recipient: ' bo@example.com ', since: '2026-07-01', until: '2026-07-31' }), { unreadOnly: true, author: 'Ana Lima', recipient: 'bo@example.com', since: '2026-07-01', until: '2026-07-31' });
  assert.deepEqual(mail.cleanFilters({ unread: 'yes', author: ['a'], recipient: { a: 1 }, since: 'soon', until: '07/31/2026' }), { unreadOnly: false, author: '', recipient: '', since: '', until: '' });
  const swapped = mail.cleanFilters({ since: '2026-07-31', until: '2026-07-01' });
  assert.deepEqual([swapped.since, swapped.until], ['2026-07-01', '2026-07-31'], 'days the wrong way round');
  assert.deepEqual(mail.filterParams(mail.cleanFilters()), {});
  assert.deepEqual(mail.filterParams(mail.cleanFilters({ unread: '1', recipient: 'bo', since: '2026-07-01' })), { unread: '1', recipient: 'bo', since: '2026-07-01' });
  assert.equal(mail.countFilters(mail.cleanFilters()), 0);
  assert.equal(mail.countFilters(mail.cleanFilters({ unread: '1', author: 'a', recipient: 'b', since: '2026-07-01', until: '2026-07-31' })), 4, 'the two days are one');
});

test('mail filter: what it is set to, in words', () => {
  const hint = (query) => mail.filterHint(mail.cleanFilters(query));
  assert.equal(hint({}), '');
  assert.equal(hint({ unread: '1' }), 'Unread only');
  assert.equal(hint({ author: 'ana@example.com' }), 'From ana@example.com');
  assert.equal(hint({ recipient: 'bo@example.com' }), 'To bo@example.com');
  assert.equal(hint({ since: '2026-07-01' }), 'Since Jul 1, 2026');
  assert.equal(hint({ until: '2026-07-01' }), 'Until Jul 1, 2026');
  assert.equal(hint({ since: '2026-07-01', until: '2026-07-01' }), 'On Jul 1, 2026');
  assert.equal(hint({ since: '2026-07-01', until: '2026-07-31' }), 'Between Jul 1 and Jul 31, 2026');
  assert.equal(hint({ since: '2025-12-30', until: '2026-01-02' }), 'Between Dec 30, 2025 and Jan 2, 2026', 'across years, both say theirs');
  assert.equal(hint({ unread: '1', author: 'Ana Lima', recipient: 'bo@example.com', since: '2026-07-01', until: '2026-07-31' }), 'Unread only, from Ana Lima, to bo@example.com, between Jul 1 and Jul 31, 2026');
});

test('mail filter: the threads holding an email by that person between those days, days being the business\'s', async (t) => {
  const asked = {};
  const distinct = t.mock.method(MailMessage, 'distinct', async (field, match) => { asked.field = field; asked.match = match; return ['t1']; });
  t.mock.method(MailThread, 'countDocuments', async () => 1);
  t.mock.method(MailThread, 'find', (filter) => { asked.threads = filter; return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) }; });
  await mail.listThreads(mail.boxOf('support'), { author: 'A.na', since: '2026-11-01', until: '2026-11-01' });
  assert.equal(asked.field, 'threadId');
  const [name, address, replyTo] = asked.match.$and[0].$or;
  assert.equal(name['from.name'].source, 'A\\.na');
  assert.equal(name['from.name'].flags, 'i');
  assert.ok(address['from.address'].test('a.NA@example.com'));
  assert.ok(replyTo.replyTo.test('a.na@example.com'), 'a Help center message comes from us, for them');
  assert.ok(!name['from.name'].test('Axna'), 'taken literally');
  // Daylight saving ended in Florida that morning, so that day is 25 hours long
  assert.deepEqual(asked.match.date, { $gte: new Date('2026-11-01T04:00:00Z'), $lt: new Date('2026-11-02T05:00:00Z') });
  assert.deepEqual(asked.threads.$and, [{ _id: { $in: ['t1'] } }]);

  await mail.listThreads(mail.boxOf('support'), { author: 'ana', recipient: 'B.o' });
  assert.equal(asked.match.$and.length, 2, 'one email has to be by the one and to the other');
  const [inTo, inCc] = asked.match.$and[1].$or;
  assert.ok(inTo.to.test('b.O@example.com'));
  assert.ok(inCc.cc.test('b.o@example.com'));
  assert.ok(!inTo.to.test('bxo@example.com'), 'taken literally');
  await mail.listThreads(mail.boxOf('support'), { recipient: 'bo' });
  assert.equal(asked.match.$and.length, 1);
  assert.deepEqual(asked.threads.$and, [{ _id: { $in: ['t1'] } }]);

  await mail.listThreads(mail.boxOf('support'), { since: '2026-07-01' });
  assert.deepEqual(asked.match, { date: { $gte: new Date('2026-07-01T04:00:00Z') } });
  await mail.listThreads(mail.boxOf('support'), { until: '2026-01-15' });
  assert.deepEqual(asked.match, { date: { $lt: new Date('2026-01-16T05:00:00Z') } });

  const calls = distinct.mock.calls.length;
  await mail.listThreads(mail.boxOf('support'), { unreadOnly: true });
  assert.equal(distinct.mock.calls.length, calls, 'no look through the emails without need');
  assert.equal(asked.threads.$and, undefined);
  assert.deepEqual(asked.threads.unread, { $gt: 0 });
});

test('mail filter: how many it found is over all the pages, and only asked for with a filter on', async (t) => {
  let counted = null;
  const count = t.mock.method(MailThread, 'countDocuments', async (filter) => { counted = { ...filter }; return 73; });
  t.mock.method(MailThread, 'find', () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  const list = await mail.listThreads(mail.boxOf('support'), { unreadOnly: true, before: new Date('2026-07-01T00:00:00Z') });
  assert.equal(list.total, 73);
  assert.deepEqual(counted.unread, { $gt: 0 });
  assert.equal(counted.lastAt, undefined, 'not only what is left from this page on');
  assert.equal((await mail.listThreads(mail.boxOf('support'), {})).total, null);
  assert.equal(count.mock.calls.length, 1);
});

test('mail page: a filtered list says how many results it has, on every screen', async () => {
  const filters = mail.cleanFilters({ unread: '1' });
  const bar = async (state) => {
    const html = await drawMail({ filters, list: { threads: [OPENED.thread], more: true, total: 73 }, ...state });
    return html.slice(html.indexOf('id="mail-threads"'), html.indexOf('id="mail-list"'));
  };
  const filtered = await bar({});
  assert.match(filtered, />73 results from filters</);
  assert.doesNotMatch(filtered, /<div class="flex shrink-0[^"]*lg:hidden/, 'the bar stays on a wide screen');
  assert.match(filtered, /class="flex lg:hidden[^"]*bg-cerise-50/, 'what the filter is set to is in the search field there');
  assert.match(await bar({ list: { threads: [OPENED.thread], more: false, total: 1 } }), />1 result from filters</);
  assert.match(await bar({ list: { threads: [], more: false, total: 0 } }), />0 results from filters</);
  assert.match(await bar({ q: 'refund' }), />73 results from search and filters</);

  const searched = await bar({ q: 'refund', filters: mail.cleanFilters(), list: { threads: [OPENED.thread], more: false, total: null } });
  assert.doesNotMatch(searched, /results from/, 'a search alone is not a filter');
  assert.match(searched, /<div class="flex shrink-0[^"]*lg:hidden/);
  assert.doesNotMatch(await bar({ filters: mail.cleanFilters(), list: { threads: [], more: false, total: null } }), /results? from/);
});

test('mail page: the filter is inside the search field, on its right, and in the search\'s own form', async () => {
  const filters = mail.cleanFilters({ unread: '1', author: '<Ana>', recipient: 'bo@example.com', since: '2026-07-01', until: '2026-07-31' });
  const search = { action: '/mail', value: 'refund', label: 'Search Support', maxLength: 200, hidden: { box: 'support' }, clear: '/mail?box=support', phone: true, filter: { ...filters, on: 4, hint: mail.filterHint(filters) } };
  const html = await drawMail({ q: 'refund', search, filters, clearFilters: '/mail?box=support&q=refund', list: { threads: [OPENED.thread], more: false } });
  const form = html.slice(html.indexOf('role="search"'), html.indexOf('</form>', html.indexOf('role="search"')));
  const [field, clear, words, clearAll, button, menu] = ['name="q"', 'aria-label="Clear search"', 'id="mail-filter-hint"', 'aria-label="Clear filters"', 'popovertarget="mail-filter"', 'id="mail-filter"'].map((part) => form.indexOf(part));
  assert.ok(field > 0 && field < clear && clear < words && words < clearAll && clearAll < button && button < menu, 'what is typed and its cross, what the filter is set to and its cross, then the filter');
  assert.match(form, /aria-label="Filter \(4 on\)"/);
  assert.match(form, /popovertarget="mail-filter"[\s\S]*?boxicons:menu-filter/);
  assert.match(form, /name="unread" value="1" checked/);
  assert.match(form, /name="author" value="&lt;Ana&gt;"/);
  assert.match(form, /name="recipient" value="bo@example\.com"/);
  assert.ok(form.indexOf('name="author"') < form.indexOf('name="recipient"'));
  assert.match(form, /name="since" value="2026-07-01"/);
  assert.match(form, /name="until" value="2026-07-31"/);
  assert.match(form, /<button type="submit"[^>]*>Apply<\/button>/);
  assert.match(form, /class="hidden lg:flex[^"]*rounded-md bg-cerise-50[^"]*text-cerise-700[^"]*">\s*<span id="mail-filter-hint"[^>]*>Unread only, from &lt;Ana&gt;, to bo@example\.com, between Jul 1 and Jul 31, 2026<\/span>/, 'in its own color and container: it is not what was typed');
  assert.match(form, /href="\/mail\?box=support&amp;q=refund"[^>]*aria-label="Clear filters"/, 'the cross keeps the search');
  assert.equal((html.match(/id="mail-filter-hint"/g) || []).length, 1, 'above the list it says the same, with no second id');
  assert.match(form, /name="q"[^>]*aria-describedby="mail-filter-hint"/);

  const list = html.slice(html.indexOf('id="mail-threads"'), html.indexOf('id="mail-list"'));
  assert.match(list, /class="[^"]*lg:hidden[^"]*">/, 'above the list only where the field has no room for it');
  assert.doesNotMatch(list, /Results for/, 'no room for both on a phone, and the field right above says what was searched');
  assert.match(list, /class="flex[^"]*bg-cerise-50[^"]*text-cerise-700[^"]*">\s*<span[^>]*>Unread only, from &lt;Ana&gt;, to bo@example\.com, between Jul 1 and Jul 31, 2026</);
  assert.match(list, /href="\/mail\?box=support&amp;q=refund"[^>]*aria-label="Clear filters"/);
  assert.ok(html.includes('author=%3CAna%3E&amp;recipient=bo%40example.com&amp;since=2026-07-01&amp;until=2026-07-31&amp;t='), 'opening an email keeps them');
  assert.match(html.slice(html.indexOf('id="mail-form"')), /name="author" value="&lt;Ana&gt;"/, 'so does writing one');
  assert.doesNotMatch(html, /Unread only<\/a>|Show all/);
});

test('mail page: above the list, nothing unless it is narrowed', async () => {
  const plain = await drawMail({ list: { threads: [OPENED.thread], more: false } });
  const top = plain.slice(plain.indexOf('id="mail-threads"'), plain.indexOf('id="mail-list"'));
  assert.doesNotMatch(top, /<p|support@genlpt\.com|<a /);
  assert.match(await drawMail({ filters: mail.cleanFilters({ since: '2026-07-01' }) }), /Since Jul 1, 2026/);
  assert.match(await drawMail({ filters: mail.cleanFilters({ until: '2026-07-01' }) }), /Until Jul 1, 2026/);
  assert.match(await drawMail({ filters: mail.cleanFilters({ author: 'ana' }) }), /No mail matches these filters\./);
  assert.match(await drawMail(), /No mail here yet\./);
  assert.match(await drawMail({ folder: mail.folderOf('drafts'), savedDrafts: [] }), /Only you can see yours/);
  assert.match(plain, /popovertarget="mailbox-menu"/);
});

test('date field: days are worked out as strings, with no time zone to move them', async () => {
  const { addDays, addMonths, monthPage, clampDay } = await import('../public/js/date-field.js');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09', 'across the clocks changing');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', 'the month is shorter');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'a leap year');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-15', -12), '2025-01-15');
  const page = monthPage('2026-11-15');
  assert.equal(page.length, 42, 'always six weeks');
  assert.equal(page[0], '2026-11-01', 'November 2026 starts on a Sunday');
  assert.equal(monthPage('2026-10-31')[0], '2026-09-27', 'the Sunday before the 1st');
  assert.equal(clampDay('2026-07-05', '2026-07-10', ''), '2026-07-10');
  assert.equal(clampDay('2026-07-25', '', '2026-07-20'), '2026-07-20');
  assert.equal(clampDay('2026-07-15', '2026-07-10', '2026-07-20'), '2026-07-15');
});

test('mail page: the filter\'s dates stay native inputs underneath, named for the calendar to take over', async () => {
  const filters = mail.cleanFilters({ since: '2026-07-01' });
  const search = { action: '/mail', value: '', label: 'Search Support', maxLength: 200, hidden: { box: 'support' }, clear: '/mail?box=support', phone: true, filter: { ...filters, on: 1 } };
  const html = await drawMail({ search, filters });
  assert.match(html, /<label for="mail-since"[^>]*>From date<\/label>\s*<div class="mt-1"><input id="mail-since" type="date" name="since" value="2026-07-01"/);
  assert.match(html, /<label for="mail-until"[^>]*>To date<\/label>\s*<div class="mt-1"><input id="mail-until" type="date" name="until" value=""/);
});
