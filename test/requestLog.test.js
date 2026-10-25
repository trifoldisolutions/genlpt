const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { requestLog, redactUrl } = require('../middleware/requestLog');

// The log line written for one request to `url`
async function logLineFor(url, production) {
  let line = '';
  const app = express();
  app.use(requestLog({ production, stream: { write: (s) => { line += s; } } }));
  app.get('/app/reset', (req, res) => res.send('ok'));
  const server = app.listen(0);
  try {
    await fetch(`http://localhost:${server.address().port}${url}`);
    // morgan writes once the response has finished, just after fetch resolves
    for (let i = 0; i < 50 && !line; i++) await new Promise((r) => setTimeout(r, 10));
    return line;
  } finally {
    server.close();
  }
}

test('request log: tokens and email addresses in the query are hidden', () => {
  assert.equal(redactUrl('/app/reset?token=abc123'), '/app/reset?token=***');
  assert.equal(redactUrl('/app/verify?token=abc123&next=/app'), '/app/verify?token=***&next=/app');
  assert.equal(redactUrl('/app/forgot?email=a%40b.com'), '/app/forgot?email=***');
  assert.equal(redactUrl('/app?next=/app&token=abc#top'), '/app?next=/app&token=***#top');
});

test('request log: other URLs are logged as they are', () => {
  assert.equal(redactUrl('/api/sessions/123?ids=a,b'), '/api/sessions/123?ids=a,b');
  assert.equal(redactUrl('/app/tokens'), '/app/tokens');
});

test('request log: production lines have date, method, redacted URL, status and time', async () => {
  const line = await logLineFor('/app/reset?token=secret123', true);
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\S+ \S+ GET \/app\/reset\?token=\*\*\* 200 \d+ - [\d.]+ ms\n$/);
  assert.ok(!line.includes('secret123'));
});

test('request log: development lines hide tokens too', async () => {
  const line = await logLineFor('/app/reset?token=secret123', false);
  assert.match(line, /GET \/app\/reset\?token=\*\*\*/);
  assert.ok(!line.includes('secret123'));
});
