const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const mail = require('../services/mail');
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
