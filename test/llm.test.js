const test = require('node:test');
const assert = require('node:assert/strict');

const ENV = ['LLM_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_MODELS', 'OPENROUTER_MAX_TOKENS', 'OPENROUTER_REASONING', 'OPENROUTER_RETRY_MS'];
const realFetch = global.fetch;

// Fresh modules (the OpenRouter provider caches its model list) with a fake fetch.
function load(env, routes) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
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
});

const MODELS = [200, {
  data: [
    { id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['response_format'] },
    { id: 'anthropic/claude-sonnet-5.5:batch', pricing: { prompt: '0.000001', completion: '0.000005' }, supported_parameters: ['response_format'] },
    { id: 'openai/gpt-6-luna', pricing: { prompt: '0.0000001', completion: '0.0000005' }, supported_parameters: ['response_format', 'reasoning'], reasoning: { supported_efforts: ['none', 'low', 'medium'] } },
    { id: 'some/plain-text-model', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
  ],
}];
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
  const { openrouter, calls } = load({ OPENROUTER_API_KEY: 'sk-test' }, { '/chat/completions': CHAT });
  const { text } = await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3 });
  assert.equal(text, '{"names": ["Federal Bureau of Investigation"]}');
  calls.splice(0, calls.length, ...calls.filter((c) => c.url.endsWith('/chat/completions'))); // the catalog is read first
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.model, 'openai/gpt-6-luna');
  assert.equal(calls[0].body.temperature, 0.3);
  assert.equal(calls[0].body.max_tokens, 4096); // never the model's 65k default, which blocks small balances
});

test('openrouter: reasoning models are asked for low effort; others get no reasoning field', async () => {
  let { openrouter, calls } = load({ OPENROUTER_API_KEY: 'sk-test' }, { '/models': MODELS, '/chat/completions': CHAT });
  await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [] });
  await openrouter.chat({ model: 'anthropic/claude-sonnet-5.5', messages: [] });
  const bodies = calls.filter((c) => c.body).map((c) => c.body);
  assert.deepEqual(bodies[0].reasoning, { effort: 'low' });
  assert.equal(bodies[1].reasoning, undefined);
  ({ openrouter, calls } = load({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_REASONING: 'default' }, { '/models': MODELS, '/chat/completions': CHAT }));
  await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [] });
  assert.equal(calls.find((c) => c.body).body.reasoning, undefined); // the model's own default
  ({ openrouter, calls } = load({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_REASONING: 'xhigh' }, { '/models': MODELS, '/chat/completions': CHAT }));
  await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [] });
  assert.equal(calls.find((c) => c.body).body.reasoning, undefined); // an effort the model doesn't offer
});

test('openrouter: a connection cut mid-answer is a model error, not a crash', async () => {
  const { openrouter } = load({ OPENROUTER_API_KEY: 'sk-test' }, {});
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => { throw new TypeError('terminated'); } });
  await assert.rejects(openrouter.chat({ model: 'x', messages: [] }), { code: 'llm_error', message: /cut \(terminated\)/ });
});

test('openrouter: a rate limit (429) is waited out and retried', async () => {
  const limited = [429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '0' }];
  const { openrouter, calls } = load({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_RETRY_MS: '5' }, { '/chat/completions': { seq: [limited, limited, CHAT] } });
  const started = Date.now();
  const { text, usage } = await openrouter.chat({ model: 'x', messages: [] });
  assert.ok(Date.now() - started >= 15); // waited 5 + 10 ms despite "Retry-After: 0"
  assert.match(text, /Federal Bureau/);
  assert.equal(usage.rateLimitRetries, 2); // the waits are part of what the call used
  assert.ok(usage.waitMs >= 15);
  const chats = (list) => list.filter((c) => c.url.endsWith('/chat/completions')).length;
  assert.equal(chats(calls), 3);
  const stuck = load({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_RETRY_MS: '1' }, { '/chat/completions': { seq: Array(6).fill(limited) } });
  await assert.rejects(stuck.openrouter.chat({ model: 'x', messages: [] }), (err) => err.code === 'llm_error' && /429/.test(err.message) && err.usage.rateLimitRetries === 5);
  assert.equal(chats(stuck.calls), 6); // first try + 5 retries
});

test('openrouter: a bad key or no credits is "unavailable", other failures are model errors', async () => {
  let { openrouter } = load({ OPENROUTER_API_KEY: 'sk-bad' }, { '/key': [401, { error: { message: 'No auth credentials found' } }] });
  await assert.rejects(openrouter.ping(), { code: 'llm_unavailable' });
  ({ openrouter } = load({ OPENROUTER_API_KEY: 'sk-test' }, { '/chat/completions': [402, { error: { message: 'Insufficient credits' } }] }));
  await assert.rejects(openrouter.chat({ model: 'x', messages: [] }), { code: 'llm_unavailable' });
  ({ openrouter } = load({ OPENROUTER_API_KEY: 'sk-test' }, { '/chat/completions': [500, { error: { message: 'Upstream error' } }] }));
  await assert.rejects(openrouter.chat({ model: 'x', messages: [] }), { code: 'llm_error' });
});

test('openrouter: the dropdown offers the .env model (plus OPENROUTER_MODELS), priced per million', async () => {
  let { openrouter } = load({ OPENROUTER_MODEL: 'openai/gpt-6-luna' }, { '/models': MODELS });
  assert.deepEqual(await openrouter.listModels(), [{ name: 'openai/gpt-6-luna', price: { in: 0.1, out: 0.5 } }]);
  ({ openrouter } = load({ OPENROUTER_MODELS: 'openai/gpt-6-luna, some/unknown-model' }, { '/models': MODELS }));
  assert.deepEqual(await openrouter.listModels(), [
    { name: 'anthropic/claude-sonnet-5.5', price: { in: 2, out: 10 } }, // the default, since OPENROUTER_MODEL is unset
    { name: 'openai/gpt-6-luna', price: { in: 0.1, out: 0.5 } },
    { name: 'some/unknown-model' },
  ]);
  ({ openrouter } = load({ OPENROUTER_MODEL: 'openai/gpt-6-luna' }, {})); // catalog unreachable: still listed, no price
  assert.deepEqual(await openrouter.listModels(), [{ name: 'openai/gpt-6-luna' }]);
});

test('openrouter: chat returns what it used: tokens, reasoning, cache, and the cost charged', async () => {
  const usage = { prompt_tokens: 1200, completion_tokens: 300, cost: 0.0042, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 180 } };
  const { openrouter, calls } = load({ OPENROUTER_API_KEY: 'sk-test' }, { '/chat/completions': [200, { ...CHAT[1], usage }] });
  const out = await openrouter.chat({ model: 'openai/gpt-6-luna', messages: [] });
  assert.deepEqual(out.usage, { inputTokens: 1200, outputTokens: 300, reasoningTokens: 180, cachedTokens: 1000, cost: 0.0042, rateLimitRetries: 0, waitMs: 0 });
  assert.deepEqual(calls.find((c) => c.body).body.usage, { include: true });
  assert.deepEqual(openrouter.settings(), { reasoning: 'low', maxTokens: 4096 });
});

test('openrouter: without a charged cost, the cost comes from the listed prices', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200 };
  const { openrouter } = load({ OPENROUTER_API_KEY: 'sk-test' }, { '/models': MODELS, '/chat/completions': [200, { ...CHAT[1], usage }] });
  const { usage: used } = await openrouter.chat({ model: 'anthropic/claude-sonnet-5.5', messages: [] });
  assert.ok(Math.abs(used.cost - (1000 * 0.000002 + 200 * 0.00001)) < 1e-12);
  const unknown = await openrouter.chat({ model: 'some/unknown-model', messages: [] });
  assert.equal(unknown.usage.cost, null);
});

test('chatJSON records every call on the current meter, JSON retries and failures included; none outside one', async () => {
  const meter = require('../services/llm/meter');
  const usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 };
  const prose = [200, { choices: [{ message: { content: 'Sure! Here are names.' } }], usage }];
  const { llm } = load(
    { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-test' },
    { '/models': MODELS, '/chat/completions': { seq: [prose, [200, { ...CHAT[1], usage }], [500, { error: { message: 'Upstream error' } }], [200, CHAT[1]]] } },
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
  const { llm, calls } = load(
    { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-test', OPENROUTER_MODELS: 'openai/gpt-6-luna' },
    { '/models': MODELS, '/chat/completions': CHAT },
  );
  assert.equal(llm.concurrency(), 6);
  const out = await llm.chatJSON({ model: 'huihui_ai/gemma-4-abliterated:12b', user: 'x' });
  assert.deepEqual(out.names, ['Federal Bureau of Investigation']);
  assert.equal(calls.find((c) => c.body).body.model, 'anthropic/claude-sonnet-5.5');
  await llm.chatJSON({ model: 'openai/gpt-6-luna', user: 'x' });
  assert.equal(calls.filter((c) => c.body).at(-1).body.model, 'openai/gpt-6-luna');
});
