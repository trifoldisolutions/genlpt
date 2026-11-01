const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
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
const ENV = { ADMINS: process.env.ADMINS, SESSION_SECRET: process.env.SESSION_SECRET, ADMIN_HOST: process.env.ADMIN_HOST, NODE_ENV: process.env.NODE_ENV };
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

test('admin: shown by the name and role ADMIN_PROFILES gives, else a name made from the address', () => {
  const profiles = ' ops@example.dev = Ana Lima | Super admin ; Bo@Example.dev=Bo ;nameless@example.dev=|Support';
  assert.deepEqual(adminAuth.adminProfile('ops@example.dev', profiles), { name: 'Ana Lima', role: 'Super admin', initials: 'AL' });
  assert.deepEqual(adminAuth.adminProfile('bo@example.dev', profiles), { name: 'Bo', role: 'Admin', initials: 'B' });
  assert.deepEqual(adminAuth.adminProfile('nameless@example.dev', profiles), { name: 'Nameless', role: 'Support', initials: 'N' });
  assert.deepEqual(adminAuth.adminProfile('trifoldi.admin000@trifoldi.dev', ''), { name: 'Trifoldi Admin000', role: 'Admin', initials: 'TA' });
  assert.deepEqual(adminAuth.adminProfile('other@example.dev', profiles), { name: 'Other', role: 'Admin', initials: 'O' });
  assert.equal(adminAuth.adminProfile('op@example.dev', 'ops@example.dev=Ana').name, 'Op', 'the whole address has to match');
});

test('admin: only an admin’s own password signs them in', async () => {
  assert.equal(await adminAuth.checkLogin(' OPS@example.dev ', PASSWORD), 'ops@example.dev');
  assert.equal(await adminAuth.checkLogin('ops@example.dev', 'wrong'), null);
  assert.equal(await adminAuth.checkLogin('nobody@example.dev', PASSWORD), null);
});

test('admin: sign-in only leads to a page of its own hostname, never another site', () => {
  assert.equal(adminAuth.safeNext('/mail?box=support&q=a//b'), '/mail?box=support&q=a//b');
  assert.equal(adminAuth.safeNext('/'), '/');
  for (const next of ['//evil.example', '///evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example/', 'evil.example', 'javascript:alert(1)', '/login', '/LOGIN?next=/mail', '', undefined, ['/mail']]) {
    assert.equal(adminAuth.safeNext(next), '/', JSON.stringify(next));
  }
});

test('admin: its hostname is the brand\'s in production and admin.localhost in development, unless ADMIN_HOST says', () => {
  delete process.env.ADMIN_HOST;
  process.env.NODE_ENV = 'production';
  assert.equal(adminAuth.adminHost(), brand.adminHost);
  process.env.NODE_ENV = 'development';
  assert.equal(adminAuth.adminHost(), 'admin.localhost');
  process.env.ADMIN_HOST = 'Admin.Staging.Example';
  assert.equal(adminAuth.adminHost(), 'admin.staging.example');
  delete process.env.ADMIN_HOST;
});

// The admin section as a browser reaches it, with a customer signed in to the app or not
async function withAdminApp(fn, { customer = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../views'));
  Object.assign(app.locals, { appName: brand.appName, brand, limits });
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.user = customer; res.locals.user = customer; next(); });
  app.use(require('../routes/admin'));
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
    const res = await get('/mail?box=support');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login?next=%2Fmail%3Fbox%3Dsupport');
    assert.equal((await get('/mail/sync', { method: 'POST' })).status, 401);
  }, { customer: { _id: 'u1', email: 'ops@example.dev', plan: 'paid' } });
});

test('admin sign-in: the right password sets a strict cookie for this hostname only; a wrong one says so', async () => {
  await withAdminApp(async (get) => {
    const page = await get('/login?next=%2Fmail');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="next" value="\/mail"/);
    assert.match(html, /data-key="admin.theme"/, 'admin has its own theme setting');
    assert.doesNotMatch(html, /href="\/about"/, 'not the public site’s header');

    const form = (password) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'ops@example.dev', password, next: '/mail' }) });
    const wrong = await get('/login', form('nope'));
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Wrong email or password/);

    const ok = await get('/login', form(PASSWORD));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/mail');
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^${adminAuth.COOKIE}=`));
    assert.match(cookie, /Path=\/(;|$)/);
    assert.doesNotMatch(cookie, /Domain=/i, 'a domain would hand it to the customers\' site too');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);

    const session = { headers: { cookie: cookie.split(';')[0] } };
    const index = await get('/', session);
    assert.equal(index.status, 200);
    const text = await index.text();
    assert.match(text, /popovertarget="admin-menu"[\s\S]*>O<[\s\S]*>Ops<[\s\S]*>Admin</, 'the button shows the avatar, name and role');
    const menu = text.slice(text.indexOf('id="admin-menu"'));
    assert.match(menu, /ops@example.dev/, 'the menu names who is signed in');
    for (const theme of ['system', 'light', 'dark']) assert.match(menu, new RegExp(`name="admin-theme" value="${theme}"`));
    assert.match(menu, /action="\/logout"/, 'and signs out');
    assert.match(text, />Internal Mail Services</);
    assert.doesNotMatch(text, /(href|action)="\/admin/, 'no links to the old paths');

    const missing = await get('/nothing-here', session);
    assert.equal(missing.status, 404);
    const notFound = await missing.text();
    assert.match(notFound, /Go to the admin home/);
    assert.doesNotMatch(notFound, /href="\/about"/, 'not the public site’s 404');

    const out = await get('/logout', { method: 'POST', headers: { cookie: cookie.split(';')[0] } });
    assert.equal(out.headers.get('location'), '/login');
    assert.match(out.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  });
});

// A request with the Host a browser would send, which fetch won't set
function ask(port, { host, path: p = '/', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: p, method, headers: { Host: host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('admin hostname: the section answers there and nowhere else, and nothing of it leaks to the other', async () => {
  process.env.ADMIN_HOST = 'admin.genlpt.test';
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../views'));
  Object.assign(app.locals, { appName: brand.appName, brand, limits });
  app.use(adminAuth.onAdminHost(require('../routes/admin')));
  app.use((req, res) => res.status(404).send('the customers site'));
  const server = app.listen(0);
  const { port } = server.address();
  try {
    assert.match((await ask(port, { host: 'admin.genlpt.test', path: '/login' })).body, /For the people who run/);
    assert.match((await ask(port, { host: `ADMIN.genlpt.test:${port}`, path: '/login' })).body, /For the people who run/, 'whatever the case and port');
    for (const host of ['genlpt.test', 'www.genlpt.test', 'admin.genlpt.test.evil.example', 'localhost']) {
      for (const p of ['/login', '/mail', '/admin', '/admin/login']) {
        assert.equal((await ask(port, { host, path: p })).body, 'the customers site', `${host}${p}`);
      }
    }
  } finally {
    server.close();
    delete process.env.ADMIN_HOST;
  }
});

test('admin hostname: to the browser the customers\' site is the same site, so its forms are refused by name', async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(require('../routes/admin'));
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const post = (site) => ask(port, { host: 'admin.genlpt.test', path: '/logout', method: 'POST', headers: { 'Sec-Fetch-Site': site } });
    assert.equal((await post('same-site')).status, 403);
    assert.equal((await post('cross-site')).status, 403);
    assert.equal((await post('same-origin')).status, 302);
  } finally {
    server.close();
  }
});
