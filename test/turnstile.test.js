const test = require('node:test');
const assert = require('node:assert/strict');
const { turnstileSiteKey, checkTurnstile } = require('../services/turnstile');

const KEYS = { TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' };

// Runs each test with the check on (or `env` instead), and console.error captured
function withKeys(t, env = KEYS) {
  const before = { ...process.env };
  t.after(() => { process.env = before; });
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  Object.assign(process.env, env);
  return t.mock.method(console, 'error', () => {});
}

// A fake Cloudflare: answers every siteverify call with `answer` (or throws it), and keeps what it was sent.
// An answer that's a string is a page that isn't JSON (a proxy's error page).
function cloudflare(answer, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (answer instanceof Error) throw answer;
    return { ok: status < 400, status, json: async () => (typeof answer === 'string' ? JSON.parse(answer) : answer) };
  };
  return { calls, fetchImpl };
}

test('turnstile: off unless both keys are set, and then every signup passes without asking Cloudflare', async (t) => {
  withKeys(t, { TURNSTILE_SITE_KEY: 'site-key' });
  assert.equal(turnstileSiteKey(), null);
  const cf = cloudflare({ success: false });
  assert.equal(await checkTurnstile(undefined, '1.2.3.4', cf.fetchImpl), 'ok');
  assert.equal(cf.calls.length, 0);
  process.env.TURNSTILE_SECRET_KEY = 'secret-key';
  assert.equal(turnstileSiteKey(), 'site-key');
});

test('turnstile: a missing or impossibly long token is turned down without asking Cloudflare', async (t) => {
  withKeys(t);
  const cf = cloudflare({ success: true });
  assert.equal(await checkTurnstile(undefined, '1.2.3.4', cf.fetchImpl), 'missing');
  assert.equal(await checkTurnstile('', '1.2.3.4', cf.fetchImpl), 'missing');
  assert.equal(await checkTurnstile(['a', 'b'], '1.2.3.4', cf.fetchImpl), 'missing'); // ?cf-turnstile-response[]=
  assert.equal(await checkTurnstile('x'.repeat(2049), '1.2.3.4', cf.fetchImpl), 'failed');
  assert.equal(cf.calls.length, 0);
});

test('turnstile: the token, secret and visitor IP go to siteverify, and a genuine token passes', async (t) => {
  withKeys(t);
  const cf = cloudflare({ success: true, 'error-codes': [], hostname: 'genlpt.com' });
  assert.equal(await checkTurnstile('token-1', '1.2.3.4', cf.fetchImpl), 'ok');
  assert.equal(cf.calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(cf.calls[0].options.method, 'POST');
  assert.deepEqual(cf.calls[0].body, { secret: 'secret-key', response: 'token-1', remoteip: '1.2.3.4' });
});

test('turnstile: a token Cloudflare rejects, already used or expired, fails', async (t) => {
  withKeys(t);
  for (const code of ['invalid-input-response', 'timeout-or-duplicate']) {
    const cf = cloudflare({ success: false, 'error-codes': [code] });
    assert.equal(await checkTurnstile('token-1', '1.2.3.4', cf.fetchImpl), 'failed', code);
  }
});

test('turnstile: a wrong secret blocks signups, loudly, rather than silently letting everyone through', async (t) => {
  const errors = withKeys(t);
  // Sent as a 400, as Cloudflare does
  const cf = cloudflare({ success: false, 'error-codes': ['invalid-input-secret'], messages: [] }, 400);
  assert.equal(await checkTurnstile('token-1', '1.2.3.4', cf.fetchImpl), 'unavailable');
  assert.match(errors.mock.calls[0].arguments[0], /TURNSTILE_SECRET_KEY/);
});

test("turnstile: when Cloudflare can't answer, the signup goes ahead and it's logged", async (t) => {
  const errors = withKeys(t);
  const answers = [
    cloudflare({ success: false, 'error-codes': ['internal-error'] }),
    cloudflare('<html>Bad gateway</html>', 502),
    cloudflare({}, 503),
    cloudflare(new Error('fetch failed')),
  ];
  for (const cf of answers) assert.equal(await checkTurnstile('token-1', '1.2.3.4', cf.fetchImpl), 'ok');
  assert.equal(errors.mock.callCount(), answers.length);
});
