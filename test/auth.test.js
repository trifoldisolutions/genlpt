const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const { sameOrigin, normalizeEmail, cleanName, signupProblem, emailProblem, nameProblem, passwordProblem } = require('../middleware/auth');

// Runs sameOrigin on a fake request: true if it lets the request through.
// reqHost is Express's req.host: the Host header, or X-Forwarded-Host behind a trusted proxy.
function passes(headers, reqHost = headers.host) {
  const req = { get: (name) => headers[name.toLowerCase()], host: reqHost };
  let status = null;
  const res = { status: (s) => { status = s; return res; }, send: () => res };
  let passed = false;
  sameOrigin(req, res, () => { passed = true; });
  assert.equal(passed, status === null);
  return passed;
}

test('auth forms: only same-origin posts are accepted', () => {
  const host = 'genlpt.test';
  assert.equal(passes({ host, 'sec-fetch-site': 'same-origin', origin: `https://${host}` }), true);
  assert.equal(passes({ host, 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' }), false);
  assert.equal(passes({ host, 'sec-fetch-site': 'same-site', origin: `https://app.${host}` }), false);
  // Older browsers: Origin only
  assert.equal(passes({ host, origin: `http://${host}` }), true);
  assert.equal(passes({ host, origin: 'https://evil.test' }), false);
  assert.equal(passes({ host, origin: 'null' }), false);
  // No browser headers at all: not a visitor's browser, so no cookies to abuse
  assert.equal(passes({ host }), true);
});

test('signup input: emails lowercased, names tidied, first problem reported', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail(['a@b.c']), '');
  assert.equal(cleanName('  Ada \n Lovelace '), 'Ada Lovelace');
  assert.equal(cleanName('jean-pierre élan McDonald'), 'Jean-Pierre Élan McDonald', 'first letters only');
  const ok = { name: 'Ada', email: 'ada@example.com', password: 'Pebble-Rug-CANYON-742!' };
  assert.equal(signupProblem(ok), null);
  assert.match(signupProblem({ ...ok, name: '' }), /name/);
  assert.match(signupProblem({ ...ok, email: 'ada@example' }), /email/);
  assert.match(signupProblem({ ...ok, password: 'Ab1!' }), /at least 3 lowercase letters/);
  assert.match(signupProblem({ ...ok, password: 'x'.repeat(201) }), /at most 200/);
  assert.equal(emailProblem('ada@example.com'), null);
  assert.equal(passwordProblem('Pebble-Rug-CANYON-742!'), null);
});

test('a name (signup, settings) is needed, and 80 characters at most', () => {
  assert.equal(nameProblem('Ada Lovelace'), null);
  assert.equal(nameProblem('x'.repeat(80)), null);
  assert.match(nameProblem(''), /enter your name/);
  assert.match(nameProblem(cleanName('   ')), /enter your name/);
  assert.match(nameProblem('x'.repeat(81)), /80 characters max/);
});

test('new passwords need 3 each of lowercase, uppercase, numbers and special characters, said in full', () => {
  const kinds = 'Your password needs at least 3 lowercase letters, 3 uppercase letters, 3 numbers and 3 special characters (like ! ? # $).';
  assert.equal(passwordProblem('correct horse battery'), kinds, 'long, but only lowercase');
  assert.equal(passwordProblem('Ab!c@d#12E3xyz'), kinds, 'one short of a kind');
  assert.equal(passwordProblem('Ab1!'), kinds, 'short: the kinds say it (they make 12 characters)');
});

test('behind a trusted proxy, Origin is matched against the forwarded host, not the raw Host header', () => {
  // The proxy rewrote Host to its upstream; X-Forwarded-Host (req.host) keeps the public name
  assert.equal(passes({ host: 'localhost:3001', origin: 'https://genlpt.com' }, 'genlpt.com'), true);
  assert.equal(passes({ host: 'localhost:3001', origin: 'https://evil.test' }, 'genlpt.com'), false);
});

test('a login with an unknown email still pays for a password check, and always fails', async () => {
  const started = Date.now();
  assert.equal(await User.checkNobody('correct horse'), false);
  assert.equal(await User.checkNobody('correct horse'), false);
  assert.ok(Date.now() - started > 5, 'argon2 work happened');
});

test('passwords are stored as argon2id hashes and checked against them', async () => {
  const passwordHash = await User.hashPassword('correct horse');
  assert.match(passwordHash, /^\$argon2id\$/);
  const user = new User({ email: 'ada@example.com', passwordHash });
  assert.equal(await user.checkPassword('correct horse'), true);
  assert.equal(await user.checkPassword('Correct horse'), false);
  assert.equal(await new User({ passwordHash: 'not a hash' }).checkPassword('x'), false);
  assert.equal(user.toJSON().passwordHash, undefined, 'never serialized');
});
