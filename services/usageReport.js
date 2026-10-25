// The usage report (npm run usage:report): what the AI actions of a period cost (models/AiAction.js), and what that
// means for each plan: one usage window, a month, and the paid plan's price. AiAction records in, markdown out.
// Estimates rest on the assumptions in config/pricing.js.
const { PLAN_LIMITS } = require('../config/limits');
const pricing = require('../config/pricing');

const PLANS = ['guest', 'free', 'paid'];
const KINDS = ['words', 'expansions', 'runs', 'reformulations'];
const KIND_LABELS = { words: 'Generate words', expansions: 'Expand a word', runs: 'Generate acronyms', reformulations: 'Reformulate an answer' };
const VARIANTS = ['default', 'chunks', 'realWords'];
const VARIANT_LABELS = { chunks: 'letter chunks', realWords: 'real words only' };
const STEP_LABELS = {
  words: 'Branch words',
  title: 'Session title',
  expand: 'Word expansion',
  compose: 'Name writing',
  name: 'Naming (real words only)',
  rank: 'Scoring',
  reformulate: 'Reformulation',
};

const MARK = '<!-- reports -->';
const INTRO = `# Usage reports

What the AI costs, measured on the actions recorded while testing. Each report covers the actions since the one
before it; the newest is first. Add one with \`npm run usage:report -- --label "what was tested"\`.
The estimates rest on the assumptions in \`config/pricing.js\`.

${MARK}
`;

const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
const avg = (list, f) => (list.length ? sum(list, f) / list.length : null);
const max = (list, f) => (list.length ? Math.max(...list.map((x) => f(x) || 0)) : null);

// Cents for prices and months; more digits for the fractions of a cent one call costs
function usd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  return `$${v.toFixed(v >= 0.1 ? 2 : v >= 0.001 ? 4 : 6)}`;
}
const num = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const secs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const pct = (v) => `${+(v * 100).toFixed(1)}%`;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const list = (items) => items.join(', ');

function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const callsOf = (actions) => actions.flatMap((a) => a.calls || []);
const clickLabel = (kind, variant) => KIND_LABELS[kind] + (VARIANT_LABELS[variant] ? ` (${VARIANT_LABELS[variant]})` : '');

// ---------------------------------------------------------------------------
// Estimates

// Whether the period has any counted click on `plan`: without one, its estimates would only be zeros
const tested = (actions, plan) => actions.some((a) => a.plan === plan && a.counted);

// One counted click of `kind` on `plan`: its average and priciest cost, or null when the period has none.
// Given-back clicks are left out: they don't use up a limit, so they don't fill a window.
function clickCost(actions, plan, kind) {
  const clicks = actions.filter((a) => a.plan === plan && a.kind === kind && a.counted);
  return clicks.length ? { avg: avg(clicks, (a) => a.cost), max: max(clicks, (a) => a.cost), n: clicks.length } : null;
}

// Clicks of `kind` in one window on `plan`: its limit, or a share of it for a typical window
function clicksPerWindow(plan, kind, use) {
  const limits = PLAN_LIMITS[plan];
  const full = kind === 'reformulations' ? (limits.reformulations || 0) * pricing.REFORMULATION_SESSIONS_PER_WINDOW : limits[kind] || 0;
  return use === 'typical' ? full * pricing.TYPICAL_WINDOW_SHARE : full;
}

// What one usage window costs on `plan`. use: 'typical', 'full' (average clicks) or 'worst' (priciest clicks).
// missing: kinds the plan can use that the period has no counted click for, left out of the cost.
function windowCost(actions, plan, use) {
  let cost = 0;
  const missing = [];
  for (const kind of KINDS) {
    const clicks = clicksPerWindow(plan, kind, use);
    if (!clicks) continue;
    const c = clickCost(actions, plan, kind);
    if (!c) missing.push(kind);
    else cost += clicks * (use === 'worst' ? c.max : c.avg);
  }
  return { cost, missing };
}

// A month on `plan`: light and regular use typical windows; max uses every window there is, in full
function monthCost(actions, plan) {
  const typical = windowCost(actions, plan, 'typical').cost;
  const { cost: full, missing } = windowCost(actions, plan, 'full');
  const { light, regular, max: most } = pricing.MONTH_WINDOWS;
  return { light: light * typical, regular: regular * typical, max: most * full, missing };
}

// The paid plan's lowest sensible price: one paying user's regular month, plus the free users and guest windows
// they carry and their share of fixed costs, after card fees. breakEven keeps nothing; target keeps MARGIN.
function priceFor(actions) {
  const P = pricing;
  const paid = monthCost(actions, 'paid');
  const freeUsers = P.FREE_USERS_PER_PAID * monthCost(actions, 'free').light;
  const guests = P.GUEST_WINDOWS_PER_PAID * windowCost(actions, 'guest', 'typical').cost;
  const fixed = P.PAYING_USERS ? P.FIXED_MONTHLY / P.PAYING_USERS : 0;
  const cover = paid.regular + freeUsers + guests + fixed;
  const priceAt = (margin) => {
    const keep = 1 - P.PAYMENT_FEE_PCT - margin;
    return keep > 0 ? (cover + P.PAYMENT_FEE_FIXED) / keep : null;
  };
  return { paid: paid.regular, paidMax: paid.max, freeUsers, guests, fixed, cover, breakEven: priceAt(0), target: priceAt(P.MARGIN) };
}

// ---------------------------------------------------------------------------
// Sections

function header(actions, { label, since, until, models }) {
  const calls = callsOf(actions);
  const from = since || new Date(Math.min(...actions.map((a) => new Date(a.createdAt))));
  const used = [...new Set(calls.map((c) => c.model).filter(Boolean))].map((name) => {
    const price = models.find((m) => m.name === name)?.price;
    return price ? `${name} (${usd(price.in)} in, ${usd(price.out)} out per million tokens)` : name;
  });
  const settings = [...new Set(actions.map((a) => {
    const s = a.settings || {};
    return [a.provider, s.reasoning && `reasoning ${s.reasoning}`, s.maxTokens && `max output ${s.maxTokens}`].filter(Boolean).join(', ');
  }))];
  return [
    `## ${stamp(until)}${label ? ` · ${label}` : ''}`,
    '',
    `- **Period:** ${stamp(from)} → ${stamp(until)}`,
    `- **Clicks:** ${actions.length}, making ${calls.length} AI calls, for ${usd(sum(actions, (a) => a.cost))} in all`,
    `- **Tokens:** ${num(sum(calls, (c) => c.inputTokens))} in, ${num(sum(calls, (c) => c.outputTokens))} out (${num(sum(calls, (c) => c.reasoningTokens))} of them reasoning)`,
    `- **Models:** ${list(used) || '—'}`,
    `- **Settings:** ${list(settings) || '—'}`,
  ].join('\n');
}

function stepSection(actions) {
  const calls = callsOf(actions);
  const steps = [...new Set([...Object.keys(STEP_LABELS), ...calls.map((c) => c.step)])];
  const rows = steps.flatMap((step) => {
    const of = calls.filter((c) => c.step === step);
    if (!of.length) return [];
    return [[
      STEP_LABELS[step] || step, of.length,
      num(avg(of, (c) => c.inputTokens)), num(avg(of, (c) => c.outputTokens)), num(avg(of, (c) => c.reasoningTokens)),
      usd(avg(of, (c) => c.cost)), usd(sum(of, (c) => c.cost)), secs(avg(of, (c) => c.ms)), secs(max(of, (c) => c.ms)),
    ]];
  });
  return '### Per step\n\nEach kind of AI call, averaged per call. Output includes reasoning.\n\n' +
    table(['Step', 'Calls', 'Input', 'Output', 'Reasoning', 'Cost', 'Total', 'Time', 'Slowest'], rows);
}

function clickSection(actions) {
  const rows = [];
  for (const kind of KINDS) {
    for (const variant of [null, ...VARIANTS]) {
      for (const plan of PLANS) {
        const clicks = actions.filter((a) => a.kind === kind && (a.variant || null) === variant && a.plan === plan);
        if (!clicks.length) continue;
        rows.push([
          clickLabel(kind, variant), plan, clicks.length, clicks.filter((a) => !a.counted).length,
          (avg(clicks, (a) => (a.calls || []).length)).toFixed(1),
          usd(avg(clicks, (a) => a.cost)), usd(max(clicks, (a) => a.cost)), secs(avg(clicks, (a) => a.ms)), secs(max(clicks, (a) => a.ms)),
        ]);
      }
    }
  }
  return '### Per click\n\nWhat one click costs, and how long the user waits for it. Calls: average AI calls per click.\n\n' +
    table(['Click', 'Plan', 'Clicks', 'Given back', 'Calls', 'Cost', 'Priciest', 'Wait', 'Longest'], rows);
}

function outputSection(actions) {
  const calls = callsOf(actions);
  const total = sum(calls, (c) => c.outputTokens);
  const steps = [...new Set([...Object.keys(STEP_LABELS), ...calls.map((c) => c.step)])];
  const rows = steps.flatMap((step) => {
    const of = calls.filter((c) => c.step === step);
    if (!of.length) return [];
    const out = sum(of, (c) => c.outputTokens);
    const reasoning = sum(of, (c) => c.reasoningTokens);
    return [[STEP_LABELS[step] || step, num(out), num(reasoning), num(out - reasoning), total ? pct(out / total) : '—']];
  });
  return '### Where the output goes\n\nOutput tokens usually cost several times more than input. Reasoning is the model thinking before it answers; ' +
    'answer text is what it writes back.\n\n' +
    table(['Step', 'Output', 'Reasoning', 'Answer text', 'Share'], rows);
}

function wasteSection(actions) {
  const calls = callsOf(actions);
  const failed = calls.filter((c) => c.ok === false);
  const retries = calls.filter((c) => c.retry);
  const givenBack = actions.filter((a) => !a.counted);
  const runs = actions.filter((a) => a.kind === 'runs' && a.result);
  const locked = sum(runs, (a) => a.result.locked);
  const kept = sum(runs, (a) => a.result.kept);
  // A locked acronym's share of its run's scoring calls (rationale and tagline included)
  const lockedCost = sum(runs, (a) => {
    const { locked: l, kept: k } = a.result;
    return k && l ? sum((a.calls || []).filter((c) => c.step === 'rank'), (c) => c.cost) * (l / k) : 0;
  });
  return '### Spent without a result for the user\n\n' + [
    `- **Failed calls:** ${failed.length}, ${usd(sum(failed, (c) => c.cost))}${failed.length ? ` (${list([...new Set(failed.map((c) => c.error))])})` : ''}`,
    `- **JSON retries:** ${retries.length}, ${usd(sum(retries, (c) => c.cost))}: answers that weren't valid JSON, asked again`,
    `- **Given-back clicks:** ${givenBack.length}, ${usd(sum(givenBack, (a) => a.cost))}: failed or added nothing, so they didn't count against the user's limits`,
    `- **Rate-limit waits:** ${sum(calls, (c) => c.rateLimitRetries)} retries, ${secs(sum(calls, (c) => c.waitMs))} waited`,
    `- **Locked acronyms:** ${locked} of ${kept} kept were hidden until an upgrade; their share of scoring: about ${usd(lockedCost)}`,
  ].join('\n');
}

function limitsText(plan) {
  const l = PLAN_LIMITS[plan];
  return `${l.runs} acronym runs · ${l.words} word runs · ${l.expansions} expansions · ${l.reformulations || 0} reformulations a session`;
}

// An estimate for `plan`: "—" when the plan isn't tested at all, "(partial)" when some of its kinds aren't
const estimate = (actions, plan, cost) => (!tested(actions, plan) ? '—' : `${usd(cost)}${windowCost(actions, plan, 'full').missing.length ? ' (partial)' : ''}`);

// What the estimates above can't include yet
function testedNote(actions) {
  const untested = PLANS.filter((p) => !tested(actions, p));
  const partial = PLANS.filter((p) => tested(actions, p) && windowCost(actions, p, 'full').missing.length);
  const notes = [];
  if (untested.length) notes.push(`**Not tested yet:** ${list(untested)}.`);
  if (partial.length) {
    const parts = partial.map((p) => `${p} without ${list(windowCost(actions, p, 'full').missing.map((k) => KIND_LABELS[k]))}`);
    notes.push(`**Partial**, leaving out what isn't tested yet: ${parts.join('; ')}.`);
  }
  return notes.map((n) => `\n\n${n}`).join('');
}

function windowSection(actions) {
  const rows = PLANS.map((plan) => [
    plan, limitsText(plan),
    ...['typical', 'full', 'worst'].map((use) => estimate(actions, plan, windowCost(actions, plan, use).cost)),
  ]);
  return '### One usage window per plan\n\n' +
    `A typical window uses ${pct(pricing.TYPICAL_WINDOW_SHARE)} of each limit; a full one uses all of them, at the average click ` +
    `or at the priciest click seen. Reformulations are limited per session, so a full window assumes ${pricing.REFORMULATION_SESSIONS_PER_WINDOW} sessions.\n\n` +
    table(['Plan', 'Limits per window', 'Typical', 'Full', 'Full, priciest clicks'], rows) +
    testedNote(actions);
}

function monthSection(actions) {
  const { light, regular, max: most } = pricing.MONTH_WINDOWS;
  const rows = PLANS.map((plan) => {
    const m = monthCost(actions, plan);
    return [plan, ...[m.light, m.regular, m.max].map((cost) => estimate(actions, plan, cost))];
  });
  return '### One user for a month\n\n' +
    `Light and regular are typical windows. Max opens every window there is (${most} a month) and uses each in full: ` +
    'nothing in the limits stops it today.\n\n' +
    table(['Plan', `Light (${light} windows)`, `Regular (${regular})`, `Max (${most})`], rows);
}

function priceSection(actions) {
  const untested = PLANS.filter((plan) => !tested(actions, plan));
  if (untested.length) return `### Paid plan price\n\nThe price needs every plan tested: ${list(untested)} not yet.`;
  const p = priceFor(actions);
  const P = pricing;
  const partial = PLANS.some((plan) => windowCost(actions, plan, 'full').missing.length);
  return '### Paid plan price\n\n' + [
    `- One paid user, regular month: ${usd(p.paid)}`,
    `- ${P.FREE_USERS_PER_PAID} free users at light use: ${usd(p.freeUsers)}`,
    `- ${P.GUEST_WINDOWS_PER_PAID} guest windows: ${usd(p.guests)}`,
    ...(p.fixed ? [`- Fixed costs per paying user: ${usd(p.fixed)}`] : []),
    `- **To cover per paying user:** ${usd(p.cover)} a month`,
    `- **Break-even price:** ${usd(p.breakEven)}, after card fees (${pct(P.PAYMENT_FEE_PCT)} + ${usd(P.PAYMENT_FEE_FIXED)})`,
    `- **Price for a ${pct(P.MARGIN)} margin:** ${usd(p.target)}`,
    `- **Risk:** a paid user at max use costs ${usd(p.paidMax)} a month on their own.`,
  ].join('\n') + (partial ? '\n\nPartial: some clicks aren\'t tested yet (see the window table).' : '');
}

// The markdown section for these actions. since: the period's start (null: from the first action);
// models: [{ name, price: { in, out } }] per million tokens, for the header.
function build(actions, { label = '', since = null, until = new Date(), models = [] } = {}) {
  return [
    header(actions, { label, since, until, models }),
    stepSection(actions),
    clickSection(actions),
    outputSection(actions),
    wasteSection(actions),
    windowSection(actions),
    monthSection(actions),
    priceSection(actions),
    `<!-- until: ${until.toISOString()} -->`,
  ].join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// The reports file

// When the newest report's period ended (its marker), or null before the first report
function lastUntil(text) {
  const dates = [...String(text || '').matchAll(/<!-- until: (\S+) -->/g)].map((m) => new Date(m[1])).filter((d) => !Number.isNaN(d.getTime()));
  return dates.length ? new Date(Math.max(...dates)) : null;
}

// The file's text with `section` added as the newest report, right under the intro
function insert(text, section) {
  const base = text || INTRO;
  if (!base.includes(MARK)) return `${base.trimEnd()}\n\n${section.trim()}\n`;
  const at = base.indexOf(MARK) + MARK.length;
  const rest = base.slice(at).trim();
  return `${base.slice(0, at)}\n\n${section.trim()}\n${rest ? `\n${rest}\n` : ''}`;
}

module.exports = { build, lastUntil, insert, clickCost, windowCost, monthCost, priceFor };
