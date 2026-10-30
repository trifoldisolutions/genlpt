const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { securityHeaders } = require('../middleware/headers');

// Headers of a page served behind securityHeaders, as a browser would receive them
async function headersOf(options) {
  const app = express();
  app.use(securityHeaders(options));
  app.get('/', (req, res) => res.send('ok'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/`);
    return res.headers;
  } finally {
    server.close();
  }
}

// The CSP as { directive: [sources] }
const cspOf = (headers) =>
  Object.fromEntries(headers.get('content-security-policy').split(';').map((d) => {
    const [name, ...sources] = d.trim().split(/\s+/);
    return [name, sources];
  }));

test('security headers: nosniff, HSTS, framing and referrer rules are sent', async () => {
  const h = await headersOf();
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.match(h.get('strict-transport-security'), /max-age=\d+/);
  assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('x-powered-by'), null);
});

test('CSP: scripts from this site, the iconify-icon package (not all of jsDelivr) and Turnstile only', async () => {
  const csp = cspOf(await headersOf());
  assert.deepEqual(csp['script-src'], ["'self'", 'https://cdn.jsdelivr.net/npm/iconify-icon@2/', 'https://challenges.cloudflare.com']);
  assert.deepEqual(csp['script-src-attr'], ["'none'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
});

test('CSP: icons can be fetched from the Iconify API and its backup hosts', async () => {
  const csp = cspOf(await headersOf());
  for (const host of ['https://api.iconify.design', 'https://api.simplesvg.com', 'https://api.unisvg.com']) {
    assert.ok(csp['connect-src'].includes(host), host);
  }
});

test("CSP: signup's bot check can show its frame, and no other site's", async () => {
  const csp = cspOf(await headersOf());
  assert.deepEqual(csp['frame-src'], ["'self'", 'https://challenges.cloudflare.com']);
});

test('CSP: Google Fonts stylesheets and font files are allowed', async () => {
  const csp = cspOf(await headersOf());
  assert.ok(csp['style-src'].includes('https:'));
  assert.ok(csp['font-src'].includes('https:'));
});

test('CSP: http requests are upgraded to https in production only', async () => {
  assert.ok('upgrade-insecure-requests' in cspOf(await headersOf({ production: true })));
  assert.ok(!('upgrade-insecure-requests' in cspOf(await headersOf({ production: false }))), 'dev over plain http keeps working');
});
