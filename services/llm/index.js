// Provider-agnostic LLM facade. Add a provider as services/llm/<name>.js exposing
// listModels(), ping(), chat({ model, messages, temperature }) → { text, usage }, warmup(model),
// defaultModel() and concurrency (how many requests it serves at once); optionally settings().
// usage: { inputTokens, outputTokens (reasoning included), reasoningTokens, cachedTokens, cost (USD) },
// plus rateLimitRetries and waitMs when the provider waits out rate limits; a failed call may carry err.usage.
// Providers: ollama (local), openrouter (hosted); pick one with LLM_PROVIDER.
const { LLMError } = require('./errors');
const meter = require('./meter');

const providerName = () => (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

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

function concurrency() {
  try {
    return provider().concurrency || 1;
  } catch {
    return 1;
  }
}

// A session keeps the model it was created with. If the current provider doesn't offer it
// (an Ollama model after switching to OpenRouter), use the provider's default instead.
async function resolveModel(model) {
  if (!model) return defaultModel();
  try {
    const names = (await provider().listModels()).map((m) => m.name);
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

async function listModels() {
  return provider().listModels();
}

// The cheapest listed model by price per million tokens (input + output); the default when no prices are known
async function cheapestModel() {
  try {
    const priced = (await listModels()).filter((m) => m.price);
    if (!priced.length) return defaultModel();
    const cost = (m) => m.price.in + m.price.out;
    return priced.reduce((best, m) => (cost(m) < cost(best) ? m : best)).name;
  } catch {
    return defaultModel();
  }
}

async function isAvailable() {
  try {
    return await provider().ping();
  } catch {
    return false;
  }
}

// One provider call, recorded on the current meter (meter.js) with what it used, whether it answers or fails
async function meteredChat(p, { step, retry, ...args }) {
  const started = Date.now();
  const call = { step: step || 'other', model: args.model, retry };
  try {
    const { text, usage } = await p.chat(args);
    meter.record({ ...call, ok: true, ms: Date.now() - started, ...usage });
    return text;
  } catch (err) {
    meter.record({ ...call, ok: false, error: err.code || 'llm_error', ms: Date.now() - started, ...err.usage });
    throw err;
  }
}

// step: what the call is for (the prompt builders set it), to break costs down in the usage report
async function chatJSON({ model, system, user, temperature = 0.7, step }) {
  const p = provider();
  const m = await resolveModel(model);
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

async function warmup(model) {
  return provider().warmup(await resolveModel(model));
}

// The provider's settings that change what calls cost (e.g. reasoning effort), kept with each AI action
function settings() {
  try {
    return provider().settings?.() || {};
  } catch {
    return {};
  }
}

module.exports = { listModels, cheapestModel, isAvailable, chatJSON, warmup, defaultModel, concurrency, settings, mapLimit, providerName, LLMError };
