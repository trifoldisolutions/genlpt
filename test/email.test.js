const test = require('node:test');
const assert = require('node:assert/strict');
const emails = require('../services/email/templates');
const { sendEmail, link } = require('../services/email');
const { windowOf } = require('../middleware/rateLimit');

const URL = 'https://genlpt.com/app/verify?token=abc&x="<b>"';

test('every account email has a subject, a text version and an HTML version with its link', () => {
  for (const email of [
    emails.verifyEmail({ url: URL }),
    emails.resetPassword({ url: URL }),
    emails.alreadyRegistered({ loginUrl: URL, forgotUrl: URL }),
  ]) {
    assert.ok(email.subject.includes('GenLPT'));
    assert.ok(email.text.includes(URL), 'text version carries the raw link');
    assert.ok(email.html.includes('https://genlpt.com/app/verify?token=abc&amp;x=&quot;&lt;b&gt;&quot;'), 'HTML escapes it');
    assert.ok(!email.html.includes('"<b>"'));
    assert.match(email.text, /The GenLPT team$/);
  }
});

test('the "already registered" email keeps the agreed wording and never says to ignore it', () => {
  const { text } = emails.alreadyRegistered({ loginUrl: 'L', forgotUrl: 'F' });
  assert.ok(text.includes('which is already registered with us.'));
  assert.ok(text.includes('No new account was created, and your existing account has not been changed.'));
  assert.ok(!/ignore/i.test(text));
  assert.ok(text.includes('Log in: L') && text.includes('Reset my password: F'));
});

test('links in emails come from APP_URL, never from a request', () => {
  const before = process.env.APP_URL;
  process.env.APP_URL = 'https://genlpt.com/';
  assert.equal(link('/app/reset?token=t'), 'https://genlpt.com/app/reset?token=t');
  process.env.APP_URL = before;
});

test('without APP_URL, email links follow PORT (dev, where the port can change)', (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.APP_URL = '';
  process.env.PORT = '4321';
  assert.equal(link('/app/verify?token=t'), 'http://localhost:4321/app/verify?token=t');
});

test('sending: Resend gets the email when there is a key; without one it is printed (not in production)', async (t) => {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  const email = { to: 'delivered@resend.dev', ...emails.resetPassword({ url: 'https://genlpt.com/r' }) };

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return { ok: true }; });
  process.env.RESEND_API_KEY = 're_test';
  process.env.EMAIL_FROM = 'GenLPT <no-reply@genlpt.com>';
  assert.equal(await sendEmail(email), true);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['delivered@resend.dev']);
  assert.equal(body.from, 'GenLPT <no-reply@genlpt.com>');
  assert.ok(body.text && body.html);

  t.mock.method(console, 'error', () => {});
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: false, status: 422, text: async () => 'bad' }));
  assert.equal(await sendEmail(email), false, 'a refusal is reported, not thrown');

  const printed = [];
  t.mock.method(console, 'log', (msg) => printed.push(msg));
  delete process.env.RESEND_API_KEY;
  process.env.NODE_ENV = 'development';
  assert.equal(await sendEmail(email), true);
  assert.ok(printed.join('').includes('https://genlpt.com/r'));
  process.env.NODE_ENV = 'production';
  assert.equal(await sendEmail(email), false, 'production never prints links');
  assert.equal(printed.length, 1);
});

test('rate limit windows are fixed and line up on their length', () => {
  const at = Date.UTC(2026, 9, 3, 14, 7, 30);
  assert.deepEqual(windowOf('loginIp', at), { start: Date.UTC(2026, 9, 3, 14, 0), end: Date.UTC(2026, 9, 3, 14, 15) });
  assert.deepEqual(windowOf('mailHour', at), { start: Date.UTC(2026, 9, 3, 14, 0), end: Date.UTC(2026, 9, 3, 15, 0) });
});
