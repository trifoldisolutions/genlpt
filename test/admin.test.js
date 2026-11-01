const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const argon2 = require('argon2');
const adminAuth = require('../middleware/admin');
const RateLimit = require('../models/RateLimit');
const MailThread = require('../models/MailThread');
const brand = require('../config/brand');
const limits = require('../config/limits');

const PASSWORD = 'abcDEF123!?#';
let HASH;
const ENV = { ADMINS: process.env.ADMINS, SESSION_SECRET: process.env.SESSION_SECRET };
const REAL = { hit: RateLimit.findOneAndUpdate, aggregate: MailThread.aggregate };

test.before(async () => {
  HASH = await argon2.hash(PASSWORD);
  process.env.SESSION_SECRET = 'a test secret';
});
test.beforeEach(() => {
  process.env.ADMINS = `Ops@Example.dev:${HASH}`;
  RateLimit.findOneAndUpdate = () => ({ lean: async () => ({ count: 1 }) }); // under every limit
  MailThread.aggregate = async () => [];
});
test.after(() => {
  for (const [k, v] of Object.entries(ENV)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  RateLimit.findOneAndUpdate = REAL.hit;
  MailThread.aggregate = REAL.aggregate;
});

test('admin: ADMINS lists admins by address, separated by spaces; a malformed entry is skipped', (t) => {
  t.mock.method(console, 'warn', () => {});
  const list = adminAuth.admins(`a@x.dev:$argon2id$one  B@Y.dev:$argon2id$v=19$m=65536,t=3,p=4$two broken nohash@x.dev:plain`);
  assert.deepEqual([...list.keys()], ['a@x.dev', 'b@y.dev']);
  assert.equal(list.get('b@y.dev'), '$argon2id$v=19$m=65536,t=3,p=4$two');
  assert.deepEqual(adminAuth.adminEmails(), ['ops@example.dev']);
});

test('admin: a session cookie names its admin until it expires, and only with an untouched signature', () => {
  const list = adminAuth.admins();
  const now = Date.now();
  const value = adminAuth.sessionValue('ops@example.dev', HASH, now);
  assert.equal(adminAuth.readSession(value, list, now + 1000).email, 'ops@example.dev');
  assert.equal(adminAuth.readSession(value, list, now + limits.ADMIN_SESSION_HOURS * 3600 * 1000 + 1), null, 'expired');
  const [name, expires, sig] = value.split('.');
  assert.equal(adminAuth.readSession(`${name}.${Number(expires) + 1000}.${sig}`, list, now), null, 'a longer life is forged');
  const other = Buffer.from('else@example.dev').toString('base64url');
  assert.equal(adminAuth.readSession(`${other}.${expires}.${sig}`, adminAuth.admins(`else@example.dev:${HASH}`), now), null, 'another admin is forged');
  assert.equal(adminAuth.readSession('nonsense', list, now), null);
});

test('admin: a changed password or an admin taken off ADMINS ends their sessions', () => {
  const value = adminAuth.sessionValue('ops@example.dev', HASH);
  assert.equal(adminAuth.readSession(value, adminAuth.admins(`ops@example.dev:$argon2id$another-hash`)), null);
  assert.equal(adminAuth.readSession(value, adminAuth.admins('')), null);
});

test('admin: only an admin’s own password signs them in', async () => {
  assert.equal(await adminAuth.checkLogin(' OPS@example.dev ', PASSWORD), 'ops@example.dev');
  assert.equal(await adminAuth.checkLogin('ops@example.dev', 'wrong'), null);
  assert.equal(await adminAuth.checkLogin('nobody@example.dev', PASSWORD), null);
});

test('admin: sign-in only leads to admin pages', () => {
  assert.equal(adminAuth.safeNext('/admin/mail?box=support'), '/admin/mail?box=support');
  for (const next of ['/app', '//evil.example', 'https://evil.example/admin', '/administrator', '/admin/login', undefined]) {
    assert.equal(adminAuth.safeNext(next), '/admin', String(next));
  }
});

// The admin section as a browser reaches it, with a customer signed in to the app or not
async function withAdminApp(fn, { customer = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../views'));
  Object.assign(app.locals, { appName: brand.appName, brand, limits });
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.user = customer; res.locals.user = customer; next(); });
  app.use('/admin', require('../routes/admin'));
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    return await fn((p, init = {}) => fetch(base + p, { redirect: 'manual', ...init }));
  } finally {
    server.close();
  }
}

test('admin pages: signed out (even as a customer), they lead to the admin sign-in', async () => {
  await withAdminApp(async (get) => {
    const res = await get('/admin/mail?box=support');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/login?next=%2Fadmin%2Fmail%3Fbox%3Dsupport');
    assert.equal((await get('/admin/mail/sync', { method: 'POST' })).status, 401);
  }, { customer: { _id: 'u1', email: 'ops@example.dev', plan: 'paid' } });
});

test('admin sign-in: the right password sets a strict cookie for /admin only; a wrong one says so', async () => {
  await withAdminApp(async (get) => {
    const page = await get('/admin/login?next=%2Fadmin%2Fmail');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="next" value="\/admin\/mail"/);
    assert.match(html, /data-key="admin.theme"/, 'admin has its own theme setting');
    assert.doesNotMatch(html, /href="\/about"/, 'not the public site’s header');

    const form = (password) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'ops@example.dev', password, next: '/admin/mail' }) });
    const wrong = await get('/admin/login', form('nope'));
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Wrong email or password/);

    const ok = await get('/admin/login', form(PASSWORD));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/admin/mail');
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^${adminAuth.COOKIE}=`));
    assert.match(cookie, /Path=\/admin/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const index = await get('/admin', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(index.status, 200);
    const text = await index.text();
    assert.match(text, /ops@example.dev/, 'the header names who is signed in');
    assert.match(text, /action="\/admin\/logout"/);

    const out = await get('/admin/logout', { method: 'POST', headers: { cookie: cookie.split(';')[0] } });
    assert.equal(out.headers.get('location'), '/admin/login');
    assert.match(out.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  });
});
