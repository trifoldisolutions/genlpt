const DomainCheck = require('../models/DomainCheck');
const { mapLimit } = require('./llm');

// Whether an acronym's domain names are registered, asked of each TLD registry's RDAP server (RFC 9082): 200
// is registered, 404 is not. Free and keyless, but it only knows "registered or not": no price (a free .io or
// .org may be a pricier premium name), and a name the registry reserves would show as free. Answers are kept
// in domain_checks, shared by everyone: a taken name for a day, a free one for an hour (someone may register
// it meanwhile). A lookup that fails (timeout, rate limit, registry error) is 'unknown' and isn't kept.

// By TLD, in the order the badges show. From IANA's list (data.iana.org/rdap/dns.json), except .io: country
// codes needn't run RDAP and it isn't listed, but its registry (Identity Digital) answers on its own server.
// Registries throttle each IP: past that, names come back 'unknown' for a while.
const RDAP = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/net/v1/',
  org: 'https://rdap.publicinterestregistry.org/rdap/',
  io: 'https://rdap.identitydigital.services/rdap/',
};
const TLDS = Object.keys(RDAP);
const KEEP_MS = { available: 60 * 60 * 1000, taken: 24 * 60 * 60 * 1000 };
const TIMEOUT_MS = 5000;
const CONCURRENCY = 8;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// "SERA" → "sera.com"; null when the letters can't make a domain name
function domainFor(letters, tld = 'com') {
  const label = String(letters || '').toLowerCase();
  return RDAP[tld] && LABEL.test(label) ? `${label}.${tld}` : null;
}

// "SERA" → ["sera.com", "sera.net", "sera.org", "sera.io"]
const domainsFor = (letters) => TLDS.map((tld) => domainFor(letters, tld)).filter(Boolean);

// One registry lookup: 'available' | 'taken' | 'unknown'
async function lookup(domain, fetchImpl = fetch) {
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  try {
    const res = await fetchImpl(`${RDAP[tld]}domain/${domain}`, {
      headers: { Accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    res.body?.cancel().catch(() => {}); // only the status matters
    return res.status === 200 ? 'taken' : res.status === 404 ? 'available' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Concurrent requests for the same name share one lookup
const inFlight = new Map();
function lookupAndKeep(domain) {
  if (!inFlight.has(domain)) {
    const p = (async () => {
      const status = await lookup(domain);
      if (status !== 'unknown') {
        const now = Date.now();
        await DomainCheck.updateOne(
          { _id: domain },
          { $set: { status, checkedAt: new Date(now), expiresAt: new Date(now + KEEP_MS[status]) } },
          { upsert: true }
        ).catch((err) => console.error('[domains]', err.message));
      }
      return status;
    })().finally(() => inFlight.delete(domain));
    inFlight.set(domain, p);
  }
  return inFlight.get(domain);
}

// { <domain>: status } for these names: kept answers first, the registry for the rest
async function check(domains) {
  const names = [...new Set(domains.filter(Boolean))];
  const out = {};
  const kept = await DomainCheck.find({ _id: { $in: names }, expiresAt: { $gt: new Date() } }, { status: 1 }).lean();
  for (const d of kept) out[d._id] = d.status;
  await mapLimit(names.filter((d) => !out[d]), CONCURRENCY, async (d) => { out[d] = await lookupAndKeep(d); });
  return out;
}

module.exports = { domainFor, domainsFor, lookup, check };
