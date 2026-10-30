// Provider-agnostic LLM facade. Add a provider as services/llm/<name>.js exposing
// listModels() → [{ name }], defaultModel(), guestModel(), ping(plan), chat({ model, messages, temperature, plan })
// → { text, usage } and concurrency (how many requests it serves at once); optionally settings(model). plan: the
// plan the call is made for (guest, free, paid, or null), when the provider bills each plan separately.
// usage: { inputTokens, outputTokens (reasoning included), reasoningTokens, cachedTokens, cost (USD) },
// plus rateLimitRetries and waitMs when the provider waits out rate limits; a failed call may carry err.usage.
// Provider: openrouter (hosted), the only one so far; LLM_PROVIDER would pick another added here.
const { LLMError } = require('./errors');
const meter = require('./meter');

const providerName = () => (process.env.LLM_PROVIDER || 'openrouter').toLowerCase();

const NOT_PROVIDERS = new Set(['index', 'errors', 'prompts', 'meter']);

function provider() {
  if (NOT_PROVIDERS.has(providerName())) throw new LLMError('llm_unavailable', 'Invalid LLM_PROVIDER');
  try {
    return require(`./${providerName()}`);
  } catch {
    throw new LLMError('llm_unavailable', `Unknown LLM provider "${providerName()}"`);
  }
}

function defaultModel() {
  try {
    return provider().defaultModel();
  } catch {
    return '';
  }
}

// The model guests get (config/models.js); every other plan may pick any listed one
function guestModel() {
  try {
    return provider().guestModel();
  } catch {
    return defaultModel();
  }
}

function concurrency() {
  try {
    return provider().concurrency || 1;
  } catch {
    return 1;
  }
}

// A session keeps the model it was created with. If the provider no longer offers it (dropped from
// config/models.js, or an old session's local Ollama model), use the provider's default instead.
function resolveModel(model) {
  if (!model) return defaultModel();
  try {
    const names = provider().listModels().map((m) => m.name);
    return names.includes(model) ? model : defaultModel();
  } catch {
    return model;
  }
}

// Runs fn over items with at most `limit` calls in flight; results keep the items' order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* fall through */ }
  }
  return undefined;
}

function listModels() {
  return provider().listModels();
}

// The provider's ping for a plan, shared: callers meanwhile wait for the same one, and its answer is kept a while.
// The public /api/health asks on every visit, so visitors must not each cost a call to the provider; a recovery
// still shows within PING_DOWN_MS.
const PING_UP_MS = 60 * 1000;
const PING_DOWN_MS = 10 * 1000;
const lastPings = new Map(); // "<provider>:<plan>" → { answer (a promise), until }

function isAvailable(plan = null) {
  const id = `${providerName()}:${plan || ''}`;
  let ping = lastPings.get(id);
  if (!ping || Date.now() >= ping.until) {
    const fresh = { until: Infinity };
    fresh.answer = Promise.resolve()
      .then(() => provider().ping(plan))
      .then(() => true, () => false)
      .then((ok) => {
        fresh.until = Date.now() + (ok ? PING_UP_MS : PING_DOWN_MS);
        return ok;
      });
    lastPings.set(id, fresh);
    ping = fresh;
  }
  return ping.answer;
}

// One provider call, recorded on the current meter (meter.js) with what it used, whether it answers or fails.
// It goes through the key of the meter's plan.
async function meteredChat(p, { step, retry, ...args }) {
  const started = Date.now();
  const call = { step: step || 'other', model: args.model, retry };
  try {
    const { text, usage } = await p.chat({ ...args, plan: meter.current()?.plan || null });
    meter.record({ ...call, ok: true, ms: Date.now() - started, ...usage });
    return text;
  } catch (err) {
    meter.record({ ...call, ok: false, error: err.code || 'llm_error', ms: Date.now() - started, ...err.usage });
    // Users only see that AI is paused or unavailable: what to fix (a spent key, a bad key) is for the server log
    if (err.code === 'ai_paused' || err.code === 'llm_unavailable') console.error(`[llm] ${meter.current()?.plan || 'no plan'}: ${err.message}`);
    throw err;
  }
}

// step: what the call is for (the prompt builders set it), to break costs down in the usage report
async function chatJSON({ model, system, user, temperature = 0.7, step }) {
  const p = provider();
  const m = resolveModel(model);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: user },
  ];
  const first = parseJSON(await meteredChat(p, { step, retry: false, model: m, messages, temperature }));
  if (first && typeof first === 'object') return first;

  const retry = [...messages, { role: 'user', content: 'Return only valid JSON. No prose, no markdown.' }];
  const second = parseJSON(await meteredChat(p, { step, retry: true, model: m, messages: retry, temperature }));
  if (second && typeof second === 'object') return second;
  throw new LLMError('invalid_json', 'The model did not return valid JSON');
}

// The provider's settings that change what a model's calls cost (e.g. reasoning effort), kept with each AI action
function settings(model) {
  try {
    return provider().settings?.(model) || {};
  } catch {
    return {};
  }
}

module.exports = { listModels, guestModel, isAvailable, chatJSON, defaultModel, concurrency, settings, mapLimit, providerName, LLMError };
