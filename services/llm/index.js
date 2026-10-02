// Provider-agnostic LLM facade. Add a provider as services/llm/<name>.js exposing
// listModels(), ping(), chat({ model, messages, temperature }) → string, warmup(model),
// defaultModel() and concurrency (how many requests it serves at once).
// Providers: ollama (local), openrouter (hosted); pick one with LLM_PROVIDER.
const { LLMError } = require('./errors');

const providerName = () => (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

const NOT_PROVIDERS = new Set(['index', 'errors', 'prompts']);

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

async function isAvailable() {
  try {
    return await provider().ping();
  } catch {
    return false;
  }
}

async function chatJSON({ model, system, user, temperature = 0.7 }) {
  const p = provider();
  const m = await resolveModel(model);
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: user },
  ];
  const first = parseJSON(await p.chat({ model: m, messages, temperature }));
  if (first && typeof first === 'object') return first;

  const retry = [...messages, { role: 'user', content: 'Return only valid JSON. No prose, no markdown.' }];
  const second = parseJSON(await p.chat({ model: m, messages: retry, temperature }));
  if (second && typeof second === 'object') return second;
  throw new LLMError('invalid_json', 'The model did not return valid JSON');
}

async function warmup(model) {
  return provider().warmup(await resolveModel(model));
}

module.exports = { listModels, isAvailable, chatJSON, warmup, defaultModel, concurrency, mapLimit, providerName, LLMError };
