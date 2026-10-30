const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config/models');

const ENV = ['LLM_PROVIDER', 'OPENROUTER_GENLPT_GUEST', 'OPENROUTER_GENLPT_FREE', 'OPENROUTER_GENLPT_PAID', 'OPENROUTER_MAX_TOKENS', 'OPENROUTER_RETRY_MS'];
const realFetch = global.fetch;
const REAL_MODELS = [...config.MODELS];

// The platform's models in these tests, in place of config/models.js (put back after each test)
const MODELS = [
  { id: 'anthropic/claude-sonnet-5.5' },
  { id: 'openai/gpt-6-luna', reasoning: 'low', guest: true },
];

// Fresh modules (the facade keeps its last ping) with a fake fetch and these models.
function load(env, routes, models = MODELS) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  config.MODELS.splice(0, config.MODELS.length, ...models);
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname.replace('/api/v1', '');
    const route = routes[path];
    // A route is [status, data, headers], or { seq: [...] } to answer differently on each call
    const [status, data, headers = {}] = route?.seq ? route.seq.shift() : route || [404, { error: { message: 'not found' } }];
    return { ok: status < 400, status, headers: { get: (h) => headers[h] ?? null }, text: async () => JSON.stringify(data) };
  };
  for (const m of ['../services/llm/index', '../services/llm/openrouter']) delete require.cache[require.resolve(m)];
  return { llm: require('../services/llm/index'), openrouter: require('../services/llm/openrouter'), calls };
}

test.afterEach(() => {
  global.fetch = realFetch;
  for (const k of ENV) delete process.env[k];
  config.MODELS.splice(0, config.MODELS.length, ...REAL_MODELS);
});

const CHAT = [200, { choices: [{ message: { content: '{"names": ["Federal Bureau of Investigation"]}' } }] }];

test('mapLimit keeps order and never exceeds the limit', async () => {
  const { llm } = load({}, {});
  let inFlight = 0;
  let peak = 0;
  const out = await llm.mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test('openrouter: no key means unavailable, before any request', async () => {
  const { openrouter, calls } = load({ LLM_PROVIDER: 'openrouter' }, {});
  await assert.rejects(openrouter.ping(), { code: 'llm_unavailable' });
  assert.equal(calls.length, 0);
});

test('openrouter: chat sends the key, the model and JSON mode, and returns the text', async () => {
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': CHAT });
  const { text } = await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 });
  assert.equal(text, '{"names": ["Federal Bureau of Investigation"]}');
  assert.equal(calls.length, 1); // nothing looked up first
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.model, 'openai/gpt-6-luna');
  assert.equal(calls[0].body.temperature, 0.3);
  assert.equal(calls[0].body.max_tokens, 4096); // never the model's 65k default, which blocks small balances
});

test('openrouter: each model is asked for the reasoning effort config/models.js gives it, or none', async () => {
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': CHAT });
  await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [] });
  await openrouter.chat({ model: 'anthropic/claude-sonnet-5.5', messages: [] });
  assert.equal(calls.length, 2); // the chats only
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
  assert.equal(calls[1].body.reasoning, undefined); // none given: the model's own default
  // Kept with each AI action for the usage report
  assert.deepEqual(openrouter.settings('openai/gpt-6-luna'), { reasoning: 'low', maxTokens: 4096 });
  assert.deepEqual(openrouter.settings('anthropic/claude-sonnet-5.5'), { maxTokens: 4096 });
});

test('openrouter: a connection cut mid-answer is a model error, not a crash', async () => {
  const { openrouter } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, {});
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(openrouter.chat({ model: 'x', messages: [] }), { code: 'llm_error', message: /cut \(terminated\)/ });
});

test('openrouter: a rate limit (429) is waited out and retried', async () => {
  const limited = [429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '0' }];
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test', OPENROUTER_RETRY_MS: '5' }, { '/chat/completions': { seq: [limited, limited, CHAT] } });
  const started = Date.now();
  const { text, usage } = await openrouter.chat({ model: 'x', messages: [] });
  assert.ok(Date.now() - started >= 15); // waited 5 + 10 ms despite "Retry-After: 0"
  assert.match(text, /Federal Bureau/);
  assert.equal(usage.rateLimitRetries, 2); // the waits are part of what the call used
  assert.ok(usage.waitMs >= 15);
  const chats = (list) => list.filter((c) => c.url.endsWith('/chat/completions')).length;
  assert.equal(chats(calls), 3);
  const stuck = load({ OPENROUTER_GENLPT_GUEST: 'sk-test', OPENROUTER_RETRY_MS: '1' }, { '/chat/completions': { seq: Array(6).fill(limited) } });
  await assert.rejects(stuck.openrouter.chat({ model: 'x', messages: [] }), (err) => err.code === 'llm_error' && /429/.test(err.message) && err.usage.rateLimitRetries === 5);
  assert.equal(chats(stuck.calls), 6); // first try + 5 retries
});

test('openrouter: a bad key is "unavailable", other failures are model errors', async () => {
  let { openrouter } = load({ OPENROUTER_GENLPT_GUEST: 'sk-bad' }, { '/key': [401, { error: { message: 'No auth credentials found' } }] });
  await assert.rejects(openrouter.ping(), { code: 'llm_unavailable' });
  ({ openrouter } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': [500, { error: { message: 'Upstream error' } }] }));
  await assert.rejects(openrouter.chat({ model: 'x', messages: [] }), { code: 'llm_error' });
  // A 403 that names no budget (moderation, permissions) isn't a spent budget
  ({ openrouter } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': [403, { error: { message: 'Input was flagged' } }] }));
  await assert.rejects(openrouter.chat({ model: 'x', messages: [] }), { code: 'llm_error' });
});

test('openrouter: a spent key limit (402 or 403), the account’s credits or a guardrail budget pause the plan', async () => {
  const spent = (status, source) => [status, { error: { code: status, message: 'Key limit exceeded (monthly limit)', ...(source ? { metadata: { limit_source: source } } : {}) } }];
  for (const answer of [spent(402, 'openrouter_key_limit'), spent(403, 'openrouter_key_limit'), spent(402, 'openrouter_credits'), spent(402), spent(403, 'openrouter_guardrail_budget')]) {
    const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test', OPENROUTER_RETRY_MS: '1' }, { '/chat/completions': answer });
    await assert.rejects(openrouter.chat({ model: 'x', messages: [], plan: 'free' }), (err) => {
      assert.equal(err.code, 'ai_paused');
      assert.equal(err.status, 503);
      assert.deepEqual(err.extra, { plan: 'free', resetAt: null }); // no reset time: it may be weeks away
      assert.match(err.message, new RegExp(`^OpenRouter ${answer[0]}`)); // the reason, for the server log
      return true;
    });
    assert.equal(calls.length, 1, `${answer[0]} ${answer[1].error.metadata?.limit_source}`); // not retried
  }
});

test('openrouter: an in-flight budget 402 is waited out like a rate limit', async () => {
  const settling = [402, { error: { code: 402, message: 'Retry after in-flight requests settle', metadata: { reason: 'in_flight_budget_exhausted', limit_source: 'openrouter_in_flight_budget' } } }, { 'retry-after': '0' }];
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test', OPENROUTER_RETRY_MS: '1' }, { '/chat/completions': { seq: [settling, CHAT] } });
  const out = await openrouter.chat({ model: 'x', messages: [] });
  assert.match(out.text, /Federal Bureau/);
  assert.equal(calls.length, 2);
  assert.equal(out.usage.rateLimitRetries, 1);
});

test('openrouter: ping tries once; a rate limit (429) still means the key works', async () => {
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test', OPENROUTER_RETRY_MS: '1' }, { '/key': [429, { error: { message: 'Rate limit exceeded' } }] });
  assert.equal(await openrouter.ping(), true);
  assert.equal(calls.length, 1); // no waiting it out: the public health check answers at once
});

test('isAvailable shares one ping and keeps its answer: 60 s up, 10 s down', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const up = [200, { data: { label: 'sk-...' } }];
    const down = [401, { error: { message: 'No auth credentials found' } }];
    const { llm, calls } = load({ LLM_PROVIDER: 'openrouter', OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/key': { seq: [up, down, up] } });
    const pings = () => calls.filter((c) => c.url.endsWith('/key')).length;
    assert.deepEqual(await Promise.all([llm.isAvailable(), llm.isAvailable(), llm.isAvailable()]), [true, true, true]);
    assert.equal(pings(), 1); // asked at once: one ping
    now += 59 * 1000;
    assert.equal(await llm.isAvailable(), true);
    assert.equal(pings(), 1);
    now += 2 * 1000;
    assert.equal(await llm.isAvailable(), false);
    assert.equal(pings(), 2);
    now += 9 * 1000;
    assert.equal(await llm.isAvailable(), false);
    assert.equal(pings(), 2);
    now += 2 * 1000;
    assert.equal(await llm.isAvailable(), true); // a recovery shows within 10 s
    assert.equal(pings(), 3);
  } finally {
    Date.now = realNow;
  }
});

test('openrouter: each plan uses its own key; one without a key yet, or no plan, uses the guest key', async () => {
  const { openrouter, calls } = load(
    { OPENROUTER_GENLPT_GUEST: 'sk-guest', OPENROUTER_GENLPT_PAID: 'sk-paid' },
    { '/chat/completions': CHAT, '/key': [200, { data: {} }] },
  );
  const keyOf = (call) => call.init.headers.Authorization;
  await openrouter.chat({ model: 'x', messages: [], plan: 'guest' });
  await openrouter.chat({ model: 'x', messages: [], plan: 'paid' });
  await openrouter.chat({ model: 'x', messages: [], plan: 'free' });
  await openrouter.chat({ model: 'x', messages: [] });
  await openrouter.ping('paid');
  await openrouter.ping();
  assert.deepEqual(calls.map(keyOf), ['Bearer sk-guest', 'Bearer sk-paid', 'Bearer sk-guest', 'Bearer sk-guest', 'Bearer sk-paid', 'Bearer sk-guest']);
});

test('openrouter: without the guest key, a plan with no key of its own is unavailable, before any request', async () => {
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_PAID: 'sk-paid' }, { '/chat/completions': CHAT });
  await assert.rejects(openrouter.chat({ model: 'x', messages: [], plan: 'free' }), { code: 'llm_unavailable', message: 'Neither OPENROUTER_GENLPT_FREE nor OPENROUTER_GENLPT_GUEST is set in .env' });
  await assert.rejects(openrouter.chat({ model: 'x', messages: [], plan: 'guest' }), { message: 'OPENROUTER_GENLPT_GUEST is not set in .env' });
  assert.equal(calls.length, 0);
  await openrouter.chat({ model: 'x', messages: [], plan: 'paid' });
  assert.equal(calls.length, 1);
});

test('chatJSON calls go through the key of the meter’s plan, and each plan’s key is pinged on its own', async () => {
  const meter = require('../services/llm/meter');
  const { llm, calls } = load(
    { LLM_PROVIDER: 'openrouter', OPENROUTER_GENLPT_GUEST: 'sk-guest', OPENROUTER_GENLPT_PAID: 'sk-paid' },
    { '/chat/completions': CHAT, '/key': [200, { data: {} }] },
  );
  await meter.run({ calls: [], plan: 'paid' }, () => llm.chatJSON({ user: 'x' }));
  await meter.run({ calls: [], plan: 'guest' }, () => llm.chatJSON({ user: 'x' }));
  assert.deepEqual(calls.map((c) => c.init.headers.Authorization), ['Bearer sk-paid', 'Bearer sk-guest']);
  calls.length = 0;
  assert.deepEqual(await Promise.all([llm.isAvailable('paid'), llm.isAvailable('paid'), llm.isAvailable('guest')]), [true, true, true]);
  assert.deepEqual(calls.map((c) => c.init.headers.Authorization), ['Bearer sk-paid', 'Bearer sk-guest']);
});

test('OpenRouter is the provider by default', async () => {
  const { llm } = load({}, {});
  assert.equal(llm.providerName(), 'openrouter');
  assert.equal(llm.defaultModel(), 'anthropic/claude-sonnet-5.5');
});

test('the models are the platform’s: the first is the default, guests get the one marked guest', async () => {
  let { llm, calls } = load({}, {});
  assert.deepEqual(llm.listModels(), [{ name: 'anthropic/claude-sonnet-5.5' }, { name: 'openai/gpt-6-luna' }]);
  assert.equal(llm.defaultModel(), 'anthropic/claude-sonnet-5.5');
  assert.equal(llm.guestModel(), 'openai/gpt-6-luna');
  assert.equal(calls.length, 0); // nothing asked of OpenRouter
  ({ llm } = load({}, {}, [{ id: 'a/one' }, { id: 'b/two' }]));
  assert.equal(llm.guestModel(), 'a/one'); // none marked: the default
});

test('config/models.js: at least one model, no id twice, one guest at most, known efforts', () => {
  assert.ok(REAL_MODELS.length >= 1);
  assert.equal(new Set(REAL_MODELS.map((m) => m.id)).size, REAL_MODELS.length);
  assert.ok(REAL_MODELS.filter((m) => m.guest).length <= 1);
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const m of REAL_MODELS) assert.ok(m.reasoning === undefined || EFFORTS.includes(m.reasoning), m.id);
});

test('openrouter: chat returns what it used: tokens, reasoning, cache, and the cost charged', async () => {
  const usage = { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0042, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 180 } };
  const { openrouter, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': [200, { ...CHAT[1], usage }] });
  const out = await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [] });
  assert.deepEqual(out.usage, { inputTokens: 1200, outputTokens: 300, reasoningTokens: 180, cachedTokens: 1000, cost: 0.0042, rateLimitRetries: 0, waitMs: 0 });
  assert.deepEqual(calls.find((c) => c.body).body.usage, { include: true });
});

test('openrouter: without a charged cost, the cost is unknown (null)', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200 };
  const { openrouter } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': [200, { ...CHAT[1], usage }] });
  const { usage: used } = await openrouter.chat({ model: 'anthropic/claude-sonnet-5.5', messages: [] });
  assert.equal(used.cost, null);
  assert.equal(used.inputTokens, 1000);
});

test('chatJSON records every call on the current meter, JSON retries and failures included; none outside one', async () => {
  const meter = require('../services/llm/meter');
  const usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 };
  const prose = [200, { choices: [{ message: { content: 'Sure! Here are names.' } }], usage }];
  const { llm } = load(
    { LLM_PROVIDER: 'openrouter', OPENROUTER_GENLPT_GUEST: 'sk-test' },
    { '/chat/completions': { seq: [prose, [200, { ...CHAT[1], usage }], [500, { error: { message: 'Upstream error' } }], [200, CHAT[1]]] } },
  );
  const m = { calls: [] };
  await meter.run(m, async () => {
    await llm.chatJSON({ user: 'x', step: 'rank' });
    await assert.rejects(llm.chatJSON({ user: 'x', step: 'compose' }), { code: 'llm_error' });
  });
  assert.deepEqual(m.calls.map((c) => [c.step, c.retry, c.ok]), [['rank', false, true], ['rank', true, true], ['compose', false, false]]);
  assert.equal(m.calls[0].model, 'anthropic/claude-sonnet-5.5');
  assert.equal(m.calls[1].cost, 0.001);
  assert.equal(m.calls[2].error, 'llm_error');
  assert.ok(m.calls.every((c) => typeof c.ms === 'number'));
  assert.deepEqual(meter.totals(m.calls), { cost: 0.002, inputTokens: 200, outputTokens: 40, reasoningTokens: 0 });
  await llm.chatJSON({ user: 'x', step: 'rank' }); // no meter: nothing kept, nothing thrown
  assert.equal(m.calls.length, 3);
});

test('a session model the provider does not offer falls back to its default', async () => {
  const { llm, calls } = load({ OPENROUTER_GENLPT_GUEST: 'sk-test' }, { '/chat/completions': CHAT });
  assert.equal(llm.concurrency(), 6);
  const out = await llm.chatJSON({ model: 'huihui_ai/gemma-4-abliterated:12b', user: 'x' });
  assert.deepEqual(out.names, ['Federal Bureau of Investigation']);
  assert.equal(calls.find((c) => c.body).body.model, 'anthropic/claude-sonnet-5.5');
  await llm.chatJSON({ model: 'openai/gpt-6-luna', user: 'x' });
  assert.equal(calls.filter((c) => c.body).at(-1).body.model, 'openai/gpt-6-luna');
});
