const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const mail = require('../services/mail');
const MailMessage = require('../models/MailMessage');
const MailThread = require('../models/MailThread');
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
function mailStubs(t, forwarded) {
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
  assert.match(body.text, /^Can you look\?\n\n---------- Forwarded message ---------\nFrom: Ana <ana@example.com>/);
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
  await assert.rejects(mail.forwardAttachments(huge, ['report']), /Untick some/);
  assert.equal(calls.sent.length, 0);
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
function drawMail(state = {}) {
  const box = mail.boxOf('support');
  return ejs.renderFile(path.join(__dirname, '../views/admin/mail.ejs'), {
    appName: 'GenLPT', admin: { email: 'ops@example.dev', name: 'Ops', role: 'Admin', initials: 'O' }, title: 'Mail', nav: 'mail', fill: true,
    mail, boxes: mail.BOXES, box, counts: { all: 2, support: 2 }, mailboxes: MAILBOXES, bodyMax: 20000,
    list: { threads: [], more: false }, opened: null, compose: false, forwarding: null, q: '', unreadOnly: false, before: null, form: null, formError: null, toasts: [],
    ...state,
  });
}
const OPENED = {
  thread: { _id: 'd'.repeat(24), mailbox: 'support@genlpt.com', subject: 'Billing', counterpart: RECEIVED.from, lastAt: RECEIVED.date, unread: 0, messages: 1, snippet: 'My invoice', lastDirection: 'in' },
  messages: [RECEIVED],
};

test('mail page: three columns, with mailboxes for every folder and no email open at first', async () => {
  const html = await drawMail({ list: { threads: [OPENED.thread], more: false } });
  for (const b of mail.BOXES) assert.ok(html.includes(`href="/mail?box=${b.key}"`), b.key);
  assert.match(html, /id="mail-list"/);
  assert.match(html, /Choose an email to read it here/);
  assert.doesNotMatch(html, /id="mail-form"/);
  assert.match(html, /<body class="flex h-dvh flex-col overflow-hidden/);
});

test('mail page: an open thread sits beside the list, with Reply and Forward and no form yet', async () => {
  const html = await drawMail({ opened: OPENED, list: { threads: [OPENED.thread], more: false } });
  assert.match(html, /My invoice is attached/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /reply=1"[^>]*>\s*<iconify-icon icon="boxicons:reply"/);
  assert.match(html, /forward=c{24}"[^>]*>\s*<iconify-icon icon="boxicons:forward"/);
  assert.doesNotMatch(html, /id="mail-form"/);
  assert.match(html, /attachments\/report"/);
});

test('mail page: the reply and forward forms each say what they send', async () => {
  const reply = await drawMail({ opened: OPENED, form: { from: 'support@genlpt.com', to: 'ana@example.com', subject: 'Re: Billing', answering: RECEIVED._id, key: 'k' } });
  assert.match(reply, new RegExp(`name="answering" value="${RECEIVED._id}"`));
  assert.doesNotMatch(reply, /name="forwarding"/);
  assert.match(reply, /<textarea name="body"[^>]* required/);
  const forward = await drawMail({ opened: OPENED, forwarding: RECEIVED, form: { from: 'support@genlpt.com', to: '', subject: 'Fwd: Billing', forwarding: RECEIVED._id, attachments: ['report'], key: 'k' } });
  assert.match(forward, new RegExp(`name="forwarding" value="${RECEIVED._id}"`));
  assert.doesNotMatch(forward, /name="answering"/);
  assert.doesNotMatch(forward, /<textarea name="body"[^>]* required/);
  assert.match(forward, /value="report"\s+checked/);
  assert.doesNotMatch(forward, /value="gone"\s+checked/);
});

test('mail page: what a forward carried is listed, without a link Resend could not answer', async () => {
  const sent = { ...RECEIVED, _id: 'e'.repeat(24), direction: 'out', attachments: [{ filename: 'report.pdf', size: 12 }] };
  const html = await drawMail({ opened: { ...OPENED, messages: [sent] } });
  assert.match(html, /report\.pdf/);
  assert.doesNotMatch(html, /\/attachments\//);
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
  await mail.listThreads(mail.boxOf('all'), { query: 'again' });
  assert.equal(updated.length, 1);
  await mail.listThreads(mail.boxOf('all'), { query: '   ' });
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
  const search = { action: '/mail', value: q, label: 'Search Support', maxLength: 200, hidden: { box: 'support' }, clear: '/mail?box=support', phone: true };
  const html = await drawMail({ q, search, list: { threads: [OPENED.thread], more: true } });
  assert.match(html, /role="search"/);
  assert.match(html, /placeholder="Search Support"/);
  assert.match(html, /aria-label="Clear search"/);
  assert.ok(!html.includes('<img src=x>'));
  assert.match(html, /Results for “&lt;img src=x&gt;”/);
  assert.ok(html.includes('q=%3Cimg+src%3Dx%3E&amp;t='), 'opening a result keeps the results listed');
  assert.ok(/q=%3Cimg\+src%3Dx%3E&amp;before=/.test(html), 'so does the next page');
  assert.match(html, /name="q" value="&lt;img src=x&gt;"/);
});

test('mail page: nothing found says so, and offers the other mailboxes', async () => {
  const html = await drawMail({ q: 'refund' });
  assert.match(html, /Nothing in Support matches “refund”/);
  assert.ok(html.includes('href="/mail?box=all&amp;q=refund"'));
  assert.doesNotMatch(await drawMail({ q: 'refund', box: mail.boxOf('all') }), /Search all mail/);
});

test('mail page: in a longer thread, the email a search found stays open', async () => {
  const older = { ...RECEIVED, _id: 'f'.repeat(24), read: true, subject: 'Billing', text: 'The first email', attachments: [] };
  const latest = { ...RECEIVED, read: true, text: 'The last one', attachments: [] };
  const opened = { ...OPENED, messages: [older, latest] };
  const openDetails = (html) => (html.match(/<details[^>]*\sopen\s*>/g) || []).length;
  assert.equal(openDetails(await drawMail({ opened })), 1);
  assert.equal(openDetails(await drawMail({ opened, q: 'first' })), 2);
});
