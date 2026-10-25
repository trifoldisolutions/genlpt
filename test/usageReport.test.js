const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../services/usageReport');
const pricing = require('../config/pricing');
const { PLAN_LIMITS } = require('../config/limits');

const call = (step, cost, extra = {}) => ({ step, model: 'openai/gpt-6-luna', ok: true, retry: false, ms: 1000, inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cost, ...extra });
const action = (kind, plan, calls, extra = {}) => ({
  kind, plan, calls, counted: true, ms: 3000, createdAt: new Date('2026-10-22T10:00:00Z'), provider: 'openrouter', settings: { reasoning: 'low', maxTokens: 4096 },
  cost: calls.reduce((n, c) => n + (c.cost || 0), 0), ...extra,
});

// Every plan, every kind it can use, at round costs: a word run $0.01, an expansion $0.002, an acronym run $0.05
// (paid: $0.08 or $0.12), a reformulation $0.003
function sample() {
  const list = [];
  for (const plan of ['guest', 'free', 'paid']) {
    list.push(action('words', plan, [call('words', 0.002), call('words', 0.002), call('words', 0.002), call('words', 0.002), call('title', 0.002)]));
    list.push(action('expansions', plan, [call('expand', 0.002)]));
    if (plan !== 'guest') list.push(action('reformulations', plan, [call('reformulate', 0.003)]));
  }
  list.push(action('runs', 'guest', [call('compose', 0.03), call('rank', 0.02)], { variant: 'default', result: { kept: 10, visible: 3, locked: 7 } }));
  list.push(action('runs', 'free', [call('compose', 0.03), call('rank', 0.02)], { variant: 'chunks', result: { kept: 10, visible: 6, locked: 4 } }));
  list.push(action('runs', 'paid', [call('compose', 0.06), call('rank', 0.02)], { variant: 'default', result: { kept: 10, visible: 10, locked: 0 } }));
  list.push(action('runs', 'paid', [call('compose', 0.1), call('rank', 0.02)], { variant: 'realWords', result: { kept: 10, visible: 10, locked: 0 } }));
  return list;
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('a click costs its average over the counted clicks; given-back ones cost us but fill no window', () => {
  const actions = [...sample(), action('runs', 'guest', [call('compose', 1)], { counted: false })];
  const runs = report.clickCost(actions, 'guest', 'runs');
  close(runs.avg, 0.05);
  assert.equal(runs.n, 1);
  close(report.clickCost(sample(), 'paid', 'runs').avg, 0.1);
  close(report.clickCost(sample(), 'paid', 'runs').max, 0.12);
  assert.equal(report.clickCost(sample(), 'guest', 'reformulations'), null);
});

test('a window is each limit times its click cost; typical takes a share, worst the priciest click', () => {
  const g = PLAN_LIMITS.guest;
  const full = g.runs * 0.05 + g.words * 0.01 + g.expansions * 0.002; // guests can't reformulate
  close(report.windowCost(sample(), 'guest', 'full').cost, full);
  close(report.windowCost(sample(), 'guest', 'typical').cost, full * pricing.TYPICAL_WINDOW_SHARE);
  const p = PLAN_LIMITS.paid;
  const reformulations = p.reformulations * pricing.REFORMULATION_SESSIONS_PER_WINDOW;
  close(report.windowCost(sample(), 'paid', 'worst').cost, p.runs * 0.12 + p.words * 0.01 + p.expansions * 0.002 + reformulations * 0.003);
  assert.deepEqual(report.windowCost(sample(), 'guest', 'full').missing, []);
});

test('a kind with no clicks yet is left out and named, not guessed', () => {
  const noExpansions = sample().filter((a) => !(a.plan === 'free' && a.kind === 'expansions'));
  const w = report.windowCost(noExpansions, 'free', 'full');
  assert.deepEqual(w.missing, ['expansions']);
  const md = report.build(noExpansions, { until: new Date('2026-10-22T12:00:00Z') });
  assert.match(md, /\*\*Partial\*\*, leaving out what isn't tested yet: free without Expand a word\./);
  assert.match(md, /\| free \| [^|]+ \| \$\d+\.\d+ \(partial\) \|/);
  // A plan with no clicks at all shows no estimate rather than $0, and there's no price without it
  const noPaid = report.build(sample().filter((a) => a.plan !== 'paid'), { until: new Date() });
  assert.match(noPaid, /\| paid \| [^|]+ \| — \| — \| — \|/);
  assert.match(noPaid, /\*\*Not tested yet:\*\* paid\./);
  assert.match(noPaid, /The price needs every plan tested: paid not yet\./);
});

test('a month: light and regular are typical windows, max is every window in full', () => {
  const typical = report.windowCost(sample(), 'free', 'typical').cost;
  const full = report.windowCost(sample(), 'free', 'full').cost;
  const m = report.monthCost(sample(), 'free');
  close(m.light, pricing.MONTH_WINDOWS.light * typical);
  close(m.regular, pricing.MONTH_WINDOWS.regular * typical);
  close(m.max, pricing.MONTH_WINDOWS.max * full);
  assert.equal(pricing.MONTH_WINDOWS.max, 144); // 5-hour windows, 30 days
});

test('the price covers a paid month, the free users and guests it carries, fees and margin', () => {
  const P = pricing;
  const p = report.priceFor(sample());
  close(p.paid, report.monthCost(sample(), 'paid').regular);
  close(p.freeUsers, P.FREE_USERS_PER_PAID * report.monthCost(sample(), 'free').light);
  close(p.guests, P.GUEST_WINDOWS_PER_PAID * report.windowCost(sample(), 'guest', 'typical').cost);
  close(p.cover, p.paid + p.freeUsers + p.guests + p.fixed);
  // What's left after fees is the cost (break-even), or the cost plus the margin (target)
  close(p.breakEven * (1 - P.PAYMENT_FEE_PCT) - P.PAYMENT_FEE_FIXED, p.cover);
  close(p.target * (1 - P.PAYMENT_FEE_PCT) - P.PAYMENT_FEE_FIXED - p.target * P.MARGIN, p.cover);
  assert.ok(p.target > p.breakEven);
});

test('the report has every section, its waste, and a marker for the next one', () => {
  const actions = [
    ...sample(),
    action('words', 'free', [call('words', 0.001, { ok: false, error: 'llm_timeout', cost: null }), call('words', 0.002, { retry: true, rateLimitRetries: 2, waitMs: 4000 })], { counted: false }),
  ];
  const until = new Date('2026-10-22T12:00:00Z');
  const md = report.build(actions, { label: 'luna, low', until, models: [{ name: 'openai/gpt-6-luna', price: { in: 0.1, out: 0.5 } }] });
  for (const h of ['Per step', 'Per click', 'Where the output goes', 'Spent without a result', 'One usage window per plan', 'One user for a month', 'Paid plan price']) {
    assert.ok(md.includes(`### ${h}`), h);
  }
  assert.match(md, /^## \d{4}-\d\d-\d\d \d\d:\d\d · luna, low/);
  assert.match(md, /openai\/gpt-6-luna \(\$0\.10 in, \$0\.50 out per million tokens\)/);
  assert.match(md, /card fees \(2\.9% \+ \$0\.30\)/);
  assert.match(md, /openrouter, reasoning low, max output 4096/);
  assert.match(md, /\| Generate acronyms \(real words only\) \| paid \| 1 \| 0 \| 2\.0 \| \$0\.12 \|/);
  assert.match(md, /\*\*Failed calls:\*\* 1, \$0 \(llm_timeout\)/);
  assert.match(md, /\*\*JSON retries:\*\* 1, \$0\.0020/);
  assert.match(md, /\*\*Given-back clicks:\*\* 1/);
  assert.match(md, /\*\*Rate-limit waits:\*\* 2 retries, 4\.0 s/);
  // 7 + 4 of 40 kept were locked; their share of scoring: 0.02 × 7/10 + 0.02 × 4/10
  assert.match(md, /\*\*Locked acronyms:\*\* 11 of 40 kept were hidden until an upgrade; their share of scoring: about \$0\.0220/);
  assert.equal(report.lastUntil(md).toISOString(), until.toISOString());
});

test('reports go newest first under the intro; the newest marker says where the next one starts', () => {
  const first = report.insert('', '## Report A\n\n<!-- until: 2026-10-22T10:00:00.000Z -->\n');
  assert.match(first, /^# Usage reports/);
  const second = report.insert(first, '## Report B\n\n<!-- until: 2026-10-22T11:00:00.000Z -->\n');
  assert.ok(second.indexOf('## Report B') < second.indexOf('## Report A'));
  assert.equal(second.match(/# Usage reports/g).length, 1);
  assert.equal(report.lastUntil(second).toISOString(), '2026-10-22T11:00:00.000Z');
  assert.equal(report.lastUntil(''), null);
  // A file whose intro was edited away still keeps everything, with the new report at the end
  const edited = report.insert('My notes\n', '## Report C\n');
  assert.equal(edited, 'My notes\n\n## Report C\n');
});
