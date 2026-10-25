const test = require('node:test');
const assert = require('node:assert/strict');
const { domainFor, domainsFor, lookup } = require('../services/domains');

// A stand-in for fetch: answers every request with `status` (or throws), and records what was asked
function fakeFetch(status) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (status instanceof Error) throw status;
    return { status, body: null };
  };
  return Object.assign(fn, { calls });
}

test('an acronym’s domain is its letters in lowercase, on .com', () => {
  assert.equal(domainFor('SERA'), 'sera.com');
  assert.equal(domainFor('Ab'), 'ab.com');
  assert.equal(domainFor(''), null);
  assert.equal(domainFor(null), null);
  assert.equal(domainFor('A-'), null, 'no hyphen at the end');
  assert.equal(domainFor('ÉCOLE'), null, 'letters are A–Z already; anything else is no domain');
  assert.equal(domainFor('A'.repeat(64)), null, 'a label is at most 63 characters');
  assert.equal(domainFor('SERA', 'io'), 'sera.io');
  assert.equal(domainFor('SERA', 'xyz'), null, 'only TLDs with a known RDAP server');
});

test('each acronym gets its .com, .net, .org and .io, in that order', () => {
  assert.deepEqual(domainsFor('SERA'), ['sera.com', 'sera.net', 'sera.org', 'sera.io']);
  assert.deepEqual(domainsFor(''), []);
});

test('each TLD’s registry is asked for RDAP JSON, by domain name', async () => {
  const f = fakeFetch(404);
  for (const d of ['sera.com', 'sera.net', 'sera.org', 'sera.io']) await lookup(d, f);
  assert.deepEqual(f.calls.map((c) => c.url), [
    'https://rdap.verisign.com/com/v1/domain/sera.com',
    'https://rdap.verisign.com/net/v1/domain/sera.net',
    'https://rdap.publicinterestregistry.org/rdap/domain/sera.org',
    'https://rdap.identitydigital.services/rdap/domain/sera.io',
  ]);
  assert.equal(f.calls[0].opts.headers.Accept, 'application/rdap+json');
  assert.ok(f.calls[0].opts.signal, 'with a timeout');
});

test('registered is 200, free is 404, anything else is unknown', async () => {
  assert.equal(await lookup('google.com', fakeFetch(200)), 'taken');
  assert.equal(await lookup('sera.com', fakeFetch(404)), 'available');
  assert.equal(await lookup('sera.com', fakeFetch(429)), 'unknown', 'rate limited');
  assert.equal(await lookup('sera.com', fakeFetch(503)), 'unknown');
  assert.equal(await lookup('sera.com', fakeFetch(new Error('timeout'))), 'unknown');
});
