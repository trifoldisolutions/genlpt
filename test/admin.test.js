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

// The mailbox's page with its data stubbed: the thread Ana started, that we answered
function stubMail(t) {
  const mail = require('../services/mail');
  const ana = { name: 'Ana', address: 'ana@example.com' };
  const thread = { _id: 'd'.repeat(24), mailbox: 'support@genlpt.com', subject: 'Billing', counterpart: ana, lastAt: new Date(), unread: 0, messages: 2, snippet: 'Thanks', lastDirection: 'out' };
  const received = { _id: 'a'.repeat(24), direction: 'in', from: ana, to: ['support@genlpt.com'], subject: 'Billing', text: 'Help', date: new Date(), read: true, attachments: [{ id: 'att1', filename: 'report.pdf', size: 2048 }] };
  const sent = { _id: 'b'.repeat(24), direction: 'out', from: { name: 'GenLPT Support', address: 'support@genlpt.com' }, to: ['ana@example.com'], subject: 'Re: Billing', text: 'Thanks', date: new Date() };
  t.mock.method(mail, 'syncIfStale', async () => null);
  t.mock.method(mail, 'getThread', async (id) => (id === thread._id ? { thread, messages: [received, sent] } : null));
  t.mock.method(mail, 'listThreads', async () => ({ threads: [thread], more: false }));
  t.mock.method(mail, 'threadsAround', async () => ({ newer: null, older: null }));
  t.mock.method(mail, 'markRead', async () => {});
  t.mock.method(mail, 'unreadCounts', async () => ({ all: 0 }));
  t.mock.method(mail, 'signatures', async () => ({ 'support@genlpt.com': 'GenLPT Support', 'privacy@genlpt.com': '', 'alerts@genlpt.com': 'GenLPT Alerts' }));
  t.mock.method(mail, 'countDrafts', async () => 0);
  t.mock.method(mail, 'listDrafts', async () => []);
  return { thread, received, sent };
}
const signedIn = () => ({ headers: { cookie: `${adminAuth.COOKIE}=${adminAuth.sessionValue('ops@example.dev', HASH)}` } });
const attribute = (s) => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// The draft a link fills the form with
const draftOf = (html, hrefPart) => JSON.parse(attribute(new RegExp(`href="[^"]*${hrefPart}[^"]*" data-draft="([^"]*)"`).exec(html)[1]));

test('mail: Reply fills in who from, to whom and the subject, answering what they wrote last; the form starts empty', async (t) => {
  const { thread, received, sent } = stubMail(t);
  await withAdminApp(async (get) => {
    const html = await (await get(`/mail?box=support&t=${thread._id}`, signedIn())).text();
    assert.match(html, /id="mail-columns" data-writing="false"/);
    assert.match(html, /<input type="hidden" name="from" value="support@genlpt.com">/, 'the mailbox it goes out from, already');
    assert.doesNotMatch(html, /id="mail-from"/, 'and nothing to choose it with');
    assert.match(html, /name="to" value=""/);
    assert.match(html, /name="subject" value=""/);

    const reply = draftOf(html, 'reply=1');
    assert.equal(reply.from, 'support@genlpt.com');
    assert.equal(reply.to, 'ana@example.com');
    assert.equal(reply.subject, 'Re: Billing');
    assert.equal(reply.t, thread._id);
    assert.equal(reply.answering, received._id, 'what they wrote, not our answer, though ours is the latest');
    assert.equal(reply.body, '');

    const forward = draftOf(html, `forward=${sent._id}`);
    assert.equal(forward.from, 'support@genlpt.com');
    assert.equal(forward.to, '');
    assert.equal(forward.subject, 'Fwd: Billing');
    assert.equal(forward.t, thread._id);
    assert.equal(forward.forwarding, sent._id);

    const older = draftOf(html, `forward=${received._id}`);
    assert.deepEqual(older.attachments, ['att1']);
    assert.deepEqual(older.choices, [{ id: 'att1', filename: 'report.pdf', size: '2 KB' }]);

    const fresh = draftOf(html, 'compose=1');
    assert.equal(fresh.from, 'support@genlpt.com', 'a new email starts from the mailbox open');
    const other = draftOf(await (await get('/mail?box=other', signedIn())).text(), 'compose=1');
    assert.equal(other.from, '', 'Other has no address of its own: it is left to choose, not quietly Support');
    assert.equal(fresh.to, '');
    assert.equal(fresh.t, '');
  });
});

test('mail: without the script, the links still reach a filled form; with nothing open, a new email', async (t) => {
  const { thread, received } = stubMail(t);
  await withAdminApp(async (get) => {
    const reply = await (await get(`/mail?box=support&t=${thread._id}&reply=1`, signedIn())).text();
    assert.match(reply, /id="mail-columns" data-writing="true"/);
    assert.match(reply, /name="to" value="ana@example.com"/);
    assert.match(reply, /name="subject" value="Re: Billing"/);
    const forward = await (await get(`/mail?box=support&t=${thread._id}&forward=${received._id}`, signedIn())).text();
    assert.match(forward, new RegExp(`name="forwarding" value="${received._id}"`));
    assert.match(forward, /value="att1"\s+checked/);
    const compose = await (await get('/mail?box=support&compose=1', signedIn())).text();
    assert.match(compose, /<input type="hidden" name="from" value="support@genlpt.com">/);
    assert.match(compose, /Choose an email to read it here/);
  });
});

test('mail: a mailbox sends from its own address; only Other chooses', async (t) => {
  const mail = require('../services/mail');
  const { thread } = stubMail(t);
  const sending = t.mock.method(mail, 'send', async () => ({ threadId: thread._id }));
  await withAdminApp(async (get) => {
    const send = (fields) => get('/mail/send', { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ to: 'a@example.com', subject: 'Hi', body: 'Hello', t: '', answering: '', forwarding: '', key: 'k'.repeat(22), ...fields }) });
    const elsewhere = await send({ box: 'support', from: 'privacy@genlpt.com' });
    assert.equal(elsewhere.status, 400);
    const html = await elsewhere.text();
    assert.match(html, /This mailbox sends from support@genlpt\.com/);
    assert.match(html, /<input type="hidden" name="from" value="support@genlpt\.com">/, 'it comes back showing the right one');
    assert.match(html, /Hello<\/textarea>/, 'with what was written');
    assert.equal(sending.mock.calls.length, 0);
    assert.equal((await send({ box: 'support', from: 'support@genlpt.com' })).status, 302);
    const other = await send({ box: 'other', from: 'privacy@genlpt.com' });
    assert.equal(other.status, 302);
    assert.equal(new URL(other.headers.get('location'), 'http://x').searchParams.get('box'), 'other', 'the form says which mailbox’s draft is done, as the page may show another');
    assert.equal(sending.mock.calls.length, 2);
  });
});

test('mail: a saved draft opens at the mailbox it is from, wherever Drafts was opened', async (t) => {
  const mail = require('../services/mail');
  stubMail(t);
  const saved = { _id: 'e'.repeat(24), createdBy: 'ops@example.dev', from: 'privacy@genlpt.com', to: 'bo@example.com', cc: '', subject: 'Data request', body: 'Half', text: 'Half', t: null, files: [], updatedAt: new Date() };
  t.mock.method(mail, 'listDrafts', async () => [saved]);
  t.mock.method(mail, 'countDrafts', async () => 1);
  t.mock.method(mail, 'getDraft', async () => saved);
  await withAdminApp(async (get) => {
    const list = await (await get('/mail?box=support&folder=drafts', signedIn())).text();
    assert.match(list, new RegExp(`href="/mail\\?box=privacy&amp;folder=drafts&amp;d=${saved._id}" data-open-draft="${saved._id}" data-box="privacy" data-box-label="Privacy"`));
    const opened = await (await get(`/mail?box=support&folder=drafts&d=${saved._id}`, signedIn())).text();
    assert.match(opened, /<h1 class="sr-only">Privacy: Drafts<\/h1>/);
    assert.match(opened, /name="box" value="privacy"/);
    assert.match(opened, /<input type="hidden" name="from" value="privacy@genlpt\.com">/);
    saved.from = '';
    assert.match(await (await get(`/mail?box=support&folder=drafts&d=${saved._id}`, signedIn())).text(), /<input type="hidden" name="from" value="support@genlpt\.com">/, 'with no address yet: the mailbox open');
  });
});

test('mail: a form sent back with a problem comes back as it was typed, on the thread it answers', async (t) => {
  const { thread, received } = stubMail(t);
  await withAdminApp(async (get) => {
    const send = (fields) => get('/mail/send', { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const bad = await send({ box: 'support', from: 'support@genlpt.com', to: 'nope', subject: 'Re: Billing', body: 'My answer', opening: 'Hi Ana,', closing: 'Best,\nOps', t: thread._id, answering: received._id, forwarding: '', key: 'k'.repeat(22) });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.match(html, /“nope” isn’t a valid email address/);
    assert.match(html, /My answer<\/textarea>/);
    assert.match(html, /name="opening" value="Hi Ana,"/);
    assert.match(html, /name="closing" value="Best,\r?\nOps"/);
    assert.match(html, /data-filled="true"/);
    assert.match(html, new RegExp(`name="t" value="${thread._id}"`));
    assert.match(html, /Help/, 'the email stays open');
    const noFrom = await send({ box: 'support', from: '', to: 'a@example.com', subject: 'Hi', body: 'Hello', t: '', answering: '', forwarding: '', key: 'k'.repeat(22) });
    assert.equal(noFrom.status, 400);
    assert.match(await noFrom.text(), /Choose the address to send from/);
  });
});

test('mail: the form sends its files with it, their names intact; too many is said in the form, with what was typed', async (t) => {
  const { thread } = stubMail(t);
  const mail = require('../services/mail');
  const { ATTACHMENTS_MAX_FILES } = require('../config/mail');
  const given = [];
  t.mock.method(mail, 'send', async (draft, options) => { given.push({ draft, options }); return { threadId: thread._id }; });
  const fields = { box: 'support', from: 'support@genlpt.com', to: 'bo@example.com', subject: 'Hello', body: 'My words', t: '', answering: '', forwarding: '', key: 'k'.repeat(22) };
  const form = (fileCount) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.append(name, value);
    for (let i = 0; i < fileCount; i++) data.append('files', new Blob(['file bytes'], { type: 'application/pdf' }), `reçu ${i}.pdf`);
    return data;
  };
  await withAdminApp(async (get) => {
    const send = (data) => get('/mail/send', { method: 'POST', headers: signedIn().headers, body: data });
    const ok = await send(form(2));
    assert.equal(ok.status, 302);
    assert.equal(given[0].draft.subject, 'Hello');
    assert.deepEqual(given[0].options.uploads.map((f) => f.originalname), ['reçu 0.pdf', 'reçu 1.pdf']);
    assert.equal(given[0].options.uploads[0].buffer.toString(), 'file bytes');
    assert.equal(given[0].options.sentBy, 'ops@example.dev');

    const tooMany = await send(form(ATTACHMENTS_MAX_FILES + 1));
    assert.equal(tooMany.status, 413);
    const html = await tooMany.text();
    assert.match(html, new RegExp(`at most|${ATTACHMENTS_MAX_FILES} attached files`));
    assert.match(html, /My words<\/textarea>/);
    assert.match(html, /name="to" value="bo@example.com"/);
    assert.equal(given.length, 1, 'not sent');
  });
});

test('mail: the form is ready for files and a dropdown, and its column is there empty', async (t) => {
  stubMail(t);
  await withAdminApp(async (get) => {
    const html = await (await get('/mail?box=support', signedIn())).text();
    assert.match(html, /enctype="multipart\/form-data"/);
    assert.match(html, /<input id="mail-file-input" type="file" name="files" multiple/);
    const other = await (await get('/mail?box=other', signedIn())).text();
    assert.match(other, /<select id="mail-from" name="from"/);
    assert.match(other, /<label for="mail-from"/);
    assert.doesNotMatch(other, /<select id="mail-from"[^>]* required/, 'a hidden required field would stop the form without a word');
  });
});

test('mail: what the editor sends comes back cleaned when there is a problem, and its formatting reaches the sending', async (t) => {
  const { thread } = stubMail(t);
  const mail = require('../services/mail');
  const given = [];
  t.mock.method(mail, 'send', async (draft) => { given.push(draft); return { threadId: thread._id }; });
  await withAdminApp(async (get) => {
    const send = (fields) => get('/mail/send', { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ box: 'support', from: 'support@genlpt.com', subject: 'Hi', t: '', answering: '', forwarding: '', format: 'html', ...fields }) });
    const hostile = '<div onclick="x()"><b>Bold</b><script>alert(1)</script></div>';
    const bad = await send({ to: 'nope', body: hostile });
    const html = await bad.text();
    assert.equal(bad.status, 400);
    assert.match(html, /&lt;div&gt;&lt;b&gt;Bold&lt;\/b&gt;&lt;\/div&gt;<\/textarea>/);
    assert.doesNotMatch(html, /alert\(1\)/);
    assert.equal((await send({ to: 'bo@example.com', body: hostile })).status, 302);
    assert.equal(given[0].text, 'Bold');
    assert.equal(given[0].note, '<div><b>Bold</b></div>');
  });
});

test('mail drafts: Drafts lists what the admin saved, with no filter to show; a draft opens filled in, with its email', async (t) => {
  const { thread, received } = stubMail(t);
  const mail = require('../services/mail');
  const saved = { _id: 'f'.repeat(24), createdBy: 'ops@example.dev', from: 'support@genlpt.com', to: 'ana@example.com', cc: '', subject: 'Re: Billing', body: '<div>Half <b>done</b></div>', text: 'Half done', t: thread._id, answering: received._id, forwarding: '', attachments: [], files: [{ id: 'a1b2', filename: 'reçu.pdf', contentType: 'application/pdf', size: 10 }], updatedAt: new Date() };
  const asked = [];
  t.mock.method(mail, 'listDrafts', async (by) => { asked.push(by); return [saved]; });
  t.mock.method(mail, 'countDrafts', async () => 1);
  t.mock.method(mail, 'getDraft', async (id, by) => (id === saved._id && by === 'ops@example.dev' ? saved : null));
  await withAdminApp(async (get) => {
    const list = await (await get('/mail?folder=drafts', signedIn())).text();
    assert.deepEqual(asked, ['ops@example.dev'], 'their own');
    assert.match(list, new RegExp(`href="/mail\\?box=support&amp;folder=drafts&amp;d=${saved._id}" data-open-draft="${saved._id}"`));
    assert.match(list, /ana@example.com/);
    assert.match(list, /Half done · 1 file/);
    assert.doesNotMatch(list, /Unread only/);
    assert.match(list, /> saved</, 'the folder counts them, without calling them unread');
    assert.match(list, /placeholder="Search Inbox"/);
    const opened = await (await get(`/mail?folder=drafts&d=${saved._id}`, signedIn())).text();
    assert.match(opened, /id="mail-columns" data-writing="true"/);
    assert.match(opened, new RegExp(`name="d" value="${saved._id}"`));
    assert.match(opened, /name="to" value="ana@example.com"/);
    assert.match(opened, /&lt;div&gt;Half &lt;b&gt;done&lt;\/b&gt;&lt;\/div&gt;<\/textarea>/);
    assert.match(opened, /Help/, 'the email it answers is open beside it');
    assert.match(attribute(/data-saved-files="([^"]*)"/.exec(opened)[1]), /"filename":"reçu.pdf"/);
    const stranger = await (await get(`/mail?folder=drafts&d=${'0'.repeat(24)}`, signedIn())).text();
    assert.match(stranger, /name="d" value=""/, 'someone else\'s, or one that\'s gone, opens nothing');
  });
});

test('mail drafts: Save as draft saves what is there, without checking it, and goes back to where it was', async (t) => {
  const { thread } = stubMail(t);
  const mail = require('../services/mail');
  const given = [];
  t.mock.method(mail, 'saveDraft', async (body, options) => { given.push({ body, options }); return { _id: 'f'.repeat(24) }; });
  const form = (fields, files = []) => {
    const data = new FormData();
    for (const [name, value] of Object.entries({ box: 'support', from: '', to: 'not an address', subject: '', body: '', format: 'html', t: '', answering: '', forwarding: '', d: '', ...fields })) data.append(name, value);
    files.forEach((name) => data.append('files', new Blob(['bytes']), name));
    return data;
  };
  await withAdminApp(async (get) => {
    const save = (data) => get('/mail/drafts', { method: 'POST', headers: signedIn().headers, body: data });
    const ok = await save(form({ t: thread._id, q: 'refund' }, ['reçu.pdf']));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), `/mail?box=support&q=refund&t=${thread._id}&done=drafted`);
    assert.equal(given[0].options.by, 'ops@example.dev');
    assert.equal(given[0].options.uploads[0].originalname, 'reçu.pdf');
    const fromDrafts = await save(form({ folder: 'drafts', t: thread._id }));
    assert.equal(fromDrafts.headers.get('location'), '/mail?box=support&folder=drafts&done=drafted', 'Drafts stays Drafts');
    t.mock.method(mail, 'saveDraft', async () => null);
    assert.equal((await save(form({}))).headers.get('location'), '/mail?box=support', 'nothing to save, nothing to say');
    t.mock.method(mail, 'saveDraft', async () => { throw new mail.MailError('too_long', 'Keep the message under 20000 characters.'); });
    const long = await save(form({ body: '<div>Kept</div>', to: 'a@example.com' }));
    assert.equal(long.status, 400);
    const html = await long.text();
    assert.match(html, /Not saved\. Keep the message/);
    assert.match(html, /&lt;div&gt;Kept&lt;\/div&gt;<\/textarea>/);
  });
});

test('mail drafts: after saving and after deleting, the page says what happened', async (t) => {
  stubMail(t);
  await withAdminApp(async (get) => {
    assert.match(await (await get('/mail?box=support&done=drafted', signedIn())).text(), /data-flash="ok">Your draft was saved\. You’ll find it in Drafts\./);
    assert.match(await (await get('/mail?folder=drafts&done=draft-deleted', signedIn())).text(), /data-flash="info">Your draft was deleted\./);
  });
});

test('mail drafts: sending one deletes it, whatever comes of that; a failed send keeps it; delete and files are the admin\'s own', async (t) => {
  const { thread } = stubMail(t);
  const mail = require('../services/mail');
  const deleted = [];
  let sendFails = false;
  t.mock.method(mail, 'send', async () => {
    if (sendFails) throw new mail.MailError('resend_error', 'Resend answered 500');
    return { threadId: thread._id };
  });
  t.mock.method(mail, 'deleteDraft', async (id, by) => { deleted.push([id, by]); });
  t.mock.method(mail, 'getDraft', async () => null);
  const id = 'f'.repeat(24);
  await withAdminApp(async (get) => {
    const headers = { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' };
    const fields = { box: 'support', from: 'support@genlpt.com', to: 'bo@example.com', subject: 'Hi', body: 'Words', d: id, key: 'k'.repeat(22) };
    sendFails = true;
    const failed = await get('/mail/send', { method: 'POST', headers, body: new URLSearchParams(fields) });
    assert.equal(failed.status, 502);
    assert.match(await failed.text(), new RegExp(`name="d" value="${id}"`), 'it can still be saved or sent');
    assert.equal(deleted.length, 0);
    sendFails = false;
    assert.equal((await get('/mail/send', { method: 'POST', headers, body: new URLSearchParams(fields) })).status, 302);
    assert.deepEqual(deleted, [[id, 'ops@example.dev']]);
    assert.equal((await get(`/mail/drafts/${id}/delete`, { method: 'POST', headers: signedIn().headers })).status, 204);
    assert.deepEqual(deleted[1], [id, 'ops@example.dev']);
    assert.equal((await get(`/mail/drafts/${id}/delete`, { method: 'POST', headers: { ...signedIn().headers, 'Sec-Fetch-Site': 'same-site' } })).status, 403, 'not from the customers\' site');
    assert.equal((await get(`/mail/drafts/${id}/files/abc`, signedIn())).status, 404);
    const signedOut = await get(`/mail/drafts/${id}/files/abc`);
    assert.equal(signedOut.status, 302);
  });
});

test('mail signatures: the page lists each mailbox, saves them, and refuses one too long as it was typed', async (t) => {
  stubMail(t);
  const mail = require('../services/mail');
  const { SIGNATURE_MAX_CHARS } = require('../config/mail');
  const saved = [];
  t.mock.method(mail, 'saveSignatures', async (texts, options) => { saved.push({ texts, options }); });
  await withAdminApp(async (get) => {
    const page = await (await get('/mail/signatures', signedIn())).text();
    assert.match(page, /name="signature_support"[^>]*>GenLPT Support<\/textarea>/);
    assert.match(page, /name="signature_privacy"[^>]*><\/textarea>/);
    assert.match(page, /Back to mail/);
    const post = (fields) => get('/mail/signatures', { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    const ok = await post({ signature_support: 'Ana\nSupport team', signature_privacy: '', signature_alerts: 'Alerts' });
    assert.equal(ok.headers.get('location'), '/mail/signatures?done=saved');
    assert.deepEqual(saved[0].texts, { 'support@genlpt.com': 'Ana\nSupport team', 'privacy@genlpt.com': '', 'alerts@genlpt.com': 'Alerts' });
    assert.equal(saved[0].options.by, 'ops@example.dev');
    const long = await post({ signature_support: 'x'.repeat(SIGNATURE_MAX_CHARS + 1) });
    assert.equal(long.status, 400);
    assert.match(await long.text(), new RegExp(`under ${SIGNATURE_MAX_CHARS} characters`));
    assert.equal(saved.length, 1);
    const toasted = await (await get('/mail/signatures?done=saved', signedIn())).text();
    assert.match(toasted, /data-flash="ok">Your signatures were saved/);
  });
});

test('mail templates: the quote button\'s openings and closings, for whom To is for, signed by the admin for the mailbox; not cached, admins only', async (t) => {
  const mail = require('../services/mail');
  const asked = [];
  t.mock.method(mail, 'templatesFor', async (to, options) => {
    asked.push({ to, options });
    return { openings: ['Hi Ana,'], closings: ['Thanks,\nOps'] };
  });
  await withAdminApp(async (get) => {
    const res = await get(`/mail/templates?${new URLSearchParams({ to: 'Ana <ana@example.com>', from: 'support@genlpt.com' })}`, signedIn());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a name is personal');
    assert.deepEqual(await res.json(), { openings: ['Hi Ana,'], closings: ['Thanks,\nOps'] });
    assert.deepEqual(asked[0], { to: 'Ana <ana@example.com>', options: { me: 'Ops', from: 'support@genlpt.com' } });
    await get('/mail/templates?to=a@example.com&to=b@example.com', signedIn());
    assert.deepEqual(asked[1], { to: '', options: { me: 'Ops', from: '' } }, 'one To, as the form sends it; no From yet');
    assert.equal((await get('/mail/templates?to=a@example.com')).status, 302, 'signed out: to the sign-in');
    assert.equal(asked.length, 2);
  });
});

test('mail: the form has the editor and shows the signature of the address chosen', async (t) => {
  const { thread } = stubMail(t);
  await withAdminApp(async (get) => {
    const empty = await (await get('/mail?box=support', signedIn())).text();
    assert.match(empty, /id="mail-editor" contenteditable="true"/);
    for (const command of ['bold', 'italic', 'insertUnorderedList', 'insertOrderedList']) assert.match(empty, new RegExp(`data-format="${command}"`));
    assert.match(empty, /data-link /);
    assert.match(empty, /name="format" value="text"/, 'plain text, unless the script takes over');
    assert.match(empty, /data-signature[^>]*>GenLPT Support</, 'a mailbox has its address from the start');
    assert.match(await (await get('/mail?box=other', signedIn())).text(), /id="mail-signature" hidden/, 'no address, no signature');
    const reply = await (await get(`/mail?box=support&t=${thread._id}&reply=1`, signedIn())).text();
    assert.match(reply, /data-signature[^>]*>GenLPT Support</);
    assert.match(attribute(/data-signatures="([^"]*)"/.exec(reply)[1]), /"privacy@genlpt.com":""/);
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

test('mail: what is done to a thread comes back to the list as it was, with the thread open only for a star', async (t) => {
  const mail = require('../services/mail');
  const { thread } = stubMail(t);
  const unread = t.mock.method(mail, 'markUnread', async () => {});
  const star = t.mock.method(mail, 'setStarred', async () => {});
  const trash = t.mock.method(mail, 'setTrashed', async () => {});
  const place = { box: 'support', folder: 'starred', q: 'invoice', unread: '1', author: 'ana', recipient: 'bo', since: '2026-07-01', until: '2026-07-31', before: '2026-07-05T00:00:00.000Z' };
  await withAdminApp(async (get) => {
    const post = async (action, fields = {}) => {
      const out = await get(`/mail/threads/${thread._id}/${action}`, { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...place, ...fields }) });
      assert.equal(out.status, 302);
      const back = Object.fromEntries(new URL(out.headers.get('location'), 'http://x').searchParams);
      for (const [name, value] of Object.entries(place)) assert.equal(back[name], value, `${action}: ${name}`);
      return back;
    };
    assert.equal((await post('unread')).t, undefined);
    assert.equal(unread.mock.calls.length, 1);

    assert.equal((await post('star', { on: '1' })).t, thread._id);
    assert.deepEqual(star.mock.calls[0].arguments, [thread._id, true]);
    await post('star', { on: '0' });
    assert.deepEqual(star.mock.calls[1].arguments, [thread._id, false]);

    const trashed = await post('trash');
    assert.equal(trashed.t, undefined);
    assert.equal(trashed.done, 'trashed');
    assert.deepEqual(trash.mock.calls[0].arguments, [thread._id, true]);

    const restored = await post('restore');
    assert.equal(restored.t, undefined);
    assert.equal(restored.done, 'restored');
    assert.deepEqual(trash.mock.calls[1].arguments, [thread._id, false]);

    assert.match(await (await get('/mail?folder=trash&done=trashed', signedIn())).text(), /moved to Trash/);
  });
});

test('mail: printing a thread is for admins, and a thread that is gone has no page', async (t) => {
  const { thread } = stubMail(t);
  await withAdminApp(async (get) => {
    const page = await get(`/mail/threads/${thread._id}/print`, signedIn());
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Billing<\/title>/);
    assert.match(html, />Help<\/div>/);
    assert.match(html, />Thanks<\/div>/);
    assert.doesNotMatch(html, /id="mail-columns"/);
    assert.equal((await get(`/mail/threads/${'0'.repeat(24)}/print`, signedIn())).status, 404);
    assert.notEqual((await get(`/mail/threads/${thread._id}/print`)).status, 200);
  });
});

test('mail: a mailbox and a folder are chosen apart, and everything on the page keeps both', async (t) => {
  const mail = require('../services/mail');
  const { thread } = stubMail(t);
  const listed = t.mock.method(mail, 'listThreads', async () => ({ threads: [thread], more: false }));
  const around = t.mock.method(mail, 'threadsAround', async () => ({ newer: null, older: null }));
  const counts = t.mock.method(mail, 'unreadCounts', async () => ({ all: 5, support: 2, privacy: 3 }));
  await withAdminApp(async (get) => {
    const html = await (await get(`/mail?box=support&folder=starred&t=${thread._id}`, signedIn())).text();
    const [box, shown] = listed.mock.calls[0].arguments;
    assert.equal(box.key, 'support');
    assert.equal(shown.folder.key, 'starred');
    assert.equal(around.mock.calls[0].arguments[2].folder.key, 'starred');

    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, /placeholder="Search Starred"/);
    assert.match(header, /name="box" value="support"[\s\S]*name="folder" value="starred"/, 'the search stays where it is');
    const aside = html.slice(html.indexOf('id="mail-folders"'), html.indexOf('</aside>'));
    assert.match(aside, /popovertarget="mailbox-menu"[\s\S]*unread mail in other mailboxes[\s\S]*>New email<\/a>/);
    assert.match(aside, /href="\/mail\?box=privacy&amp;folder=starred"/, 'another mailbox opens at the same folder, with nothing open');
    assert.match(aside, />3<span class="sr-only"> unread/);
    assert.match(html, /aria-label="Back to Starred"/);

    const drafts = await (await get('/mail?box=support&folder=drafts', signedIn())).text();
    assert.match(drafts, /placeholder="Search Inbox"/, 'Drafts has no search: from there it looks through the Inbox');
    assert.match(drafts, /href="\/mail\?box=privacy&amp;folder=drafts"/);

    const first = await (await get('/mail', signedIn())).text();
    assert.match(first, /<h1 class="sr-only">Support: Inbox<\/h1>/, 'the first mailbox, as there is no view of them all');
    assert.equal(listed.mock.calls.at(-1).arguments[1].folder.key, 'inbox');
    assert.doesNotMatch(first, /All mailboxes/);

    for (const [key, label, direction] of [['inbox', 'Inbox', 'in'], ['sent', 'Sent', 'out']]) {
      const page = await (await get(`/mail?box=support&folder=${key}`, signedIn())).text();
      assert.equal(listed.mock.calls.at(-1).arguments[1].folder.direction, direction);
      assert.match(page, new RegExp(`<h1 class="sr-only">Support: ${label}</h1>`));
      assert.match(page, new RegExp(`placeholder="Search ${label}"`));
      assert.match(page, new RegExp(`name="folder" value="${key}"`), 'writing from there comes back there');
    }

    counts.mock.mockImplementation(async () => ({ all: 2, support: 2 }));
    assert.doesNotMatch(await (await get('/mail?box=support', signedIn())).text(), /unread mail in other mailboxes/, 'all that is unread is here');

    const elsewhere = await (await get(`/mail?box=privacy&t=${thread._id}`, signedIn())).text();
    assert.equal(listed.mock.calls.at(-1).arguments[0].key, 'support', 'an open conversation shows its own mailbox');
    assert.match(elsewhere, /<h1 class="sr-only">Support: Inbox<\/h1>/);
  });
});

test('mail: sending and checking for mail come back to the same mailbox and folder', async (t) => {
  const mail = require('../services/mail');
  const { thread } = stubMail(t);
  t.mock.method(mail, 'send', async () => ({ threadId: thread._id }));
  t.mock.method(mail, 'sync', async () => 0);
  const place = { box: 'support', folder: 'trash' };
  await withAdminApp(async (get) => {
    const post = (path, fields) => get(path, { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...place, ...fields }) });
    const sent = await post('/mail/send', { from: 'support@genlpt.com', to: 'bo@example.com', subject: 'Hello', body: 'Words', t: '', answering: '', forwarding: '', key: 'k'.repeat(22) });
    assert.match(sent.headers.get('location'), /^\/mail\?box=support&folder=trash&t=/);
    const synced = await post('/mail/sync', {});
    assert.match(synced.headers.get('location'), /^\/mail\?box=support&folder=trash&done=synced/);
    const refused = await post('/mail/send', { from: 'support@genlpt.com', to: 'nope', subject: 'Hello', body: 'Words', t: '', answering: '', forwarding: '', key: 'k'.repeat(22) });
    assert.match(await refused.text(), /name="folder" value="trash"/, 'a form sent back stays there too');
  });
});

test('mail: the filter narrows the list, and stays through searches, checks for mail and what is sent', async (t) => {
  const mail = require('../services/mail');
  const { thread } = stubMail(t);
  const listed = t.mock.method(mail, 'listThreads', async () => ({ threads: [thread], more: false }));
  const around = t.mock.method(mail, 'threadsAround', async () => ({ newer: null, older: null }));
  t.mock.method(mail, 'send', async () => ({ threadId: thread._id }));
  t.mock.method(mail, 'sync', async () => 0);
  const on = { unread: '1', author: 'ana', recipient: 'bo', since: '2026-07-01', until: '2026-07-31' };
  await withAdminApp(async (get) => {
    const html = await (await get(`/mail?box=support&${new URLSearchParams({ ...on, t: thread._id })}`, signedIn())).text();
    const { unreadOnly, author, recipient, since, until } = listed.mock.calls[0].arguments[1];
    assert.deepEqual({ unreadOnly, author, recipient, since, until }, { unreadOnly: true, author: 'ana', recipient: 'bo', since: '2026-07-01', until: '2026-07-31' });
    assert.equal(around.mock.calls[0].arguments[2].author, 'ana', 'previous and next stay among them');

    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, /aria-label="Filter \(4 on\)"/);
    assert.match(header, />Unread only, from ana, to bo, between Jul 1 and Jul 31, 2026<\/span>/);
    const hidden = header.slice(header.indexOf('role="search"'), header.indexOf('name="q"'));
    assert.doesNotMatch(hidden, /name="unread"|name="author"/, 'the form has them as fields, not twice');
    assert.match(header, new RegExp(`href="/mail\\?box=support&amp;t=${thread._id}" class="btn-ghost[^>]*>Clear<`), 'Clear keeps what is open');

    const post = (path, fields) => get(path, { method: 'POST', headers: { ...signedIn().headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ box: 'support', ...on, ...fields }) });
    const synced = new URL((await post('/mail/sync', {})).headers.get('location'), 'http://x').searchParams;
    assert.equal(synced.get('author'), 'ana');
    assert.equal(synced.get('recipient'), 'bo');
    assert.equal(synced.get('since'), '2026-07-01');
    const sent = new URL((await post('/mail/send', { from: 'support@genlpt.com', to: 'bo@example.com', subject: 'Hello', body: 'Words', t: '', answering: '', forwarding: '', key: 'k'.repeat(22) })).headers.get('location'), 'http://x').searchParams;
    assert.equal(sent.get('unread'), '1');
    assert.equal(sent.get('until'), '2026-07-31');
    assert.equal(sent.get('recipient'), 'bo');
  });
});

test('mail: Drafts has nothing for the filter to narrow', async (t) => {
  stubMail(t);
  await withAdminApp(async (get) => {
    const html = await (await get('/mail?folder=drafts', signedIn())).text();
    assert.doesNotMatch(html, /mail-filter/);
    assert.match(html, /role="search"/, 'the search is still there');
  });
});
