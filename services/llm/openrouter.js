// OpenRouter provider: hosted models behind one OpenAI-style API (https://openrouter.ai).
const { LLMError } = require('./errors');
const { appName } = require('../../config/brand');

const baseUrl = () => (process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 180000;
const apiKey = () => (process.env.OPENROUTER_API_KEY || '').trim();
const MODELS_TTL = 10 * 60 * 1000;
// Output cap per call. Without one, OpenRouter checks credits against the model's maximum (often 65k tokens)
// and refuses calls on a small balance. Answers here are short; reasoning models also spend from this budget.
const maxTokens = () => Number(process.env.OPENROUTER_MAX_TOKENS) || 4096;
// Reasoning models think before answering, billed as output and slow (a Luna Pro default: ~7k tokens, ~60 s
// per call). Short naming tasks don't need it: "low" by default; OPENROUTER_REASONING=default keeps the model's own.
const reasoningEffort = () => (process.env.OPENROUTER_REASONING || 'low').trim().toLowerCase();
// Rate limits (429, e.g. 20 requests/min on new accounts): wait and retry this many times.
const RETRIES = 5; // 2+4+8+16+30 s: enough to outlast a one-minute rate-limit window

// Hosted models take parallel requests (a local Ollama serves them one at a time).
const concurrency = Number(process.env.OPENROUTER_CONCURRENCY) || 6;

const defaultModel = () => process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5.5';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait after a 429: 2 s, 4 s, 8 s… (or longer if Retry-After asks), capped at 30 s, with jitter so parallel calls
// don't retry in lockstep. Retry-After alone isn't trusted: OpenRouter can send 0 while the minute window is full.
const retryBase = () => Number(process.env.OPENROUTER_RETRY_MS) || 2000;
function retryDelay(res, attempt) {
  const header = Number(res.headers?.get?.('retry-after')) * 1000 || 0;
  return Math.min(Math.max(header, retryBase() * 2 ** attempt), 30000) + Math.random() * retryBase() / 4;
}

async function request(pathname, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const { res, data, text } = await send(pathname, opts);
    if (res.status === 429 && attempt < RETRIES) {
      await sleep(retryDelay(res, attempt));
      continue;
    }
    if (!res.ok || data?.error) {
      const msg = data?.error?.message || text;
      // 401 bad key, 402 no credits: nothing will work until the account is fixed
      const code = res.status === 401 || res.status === 402 ? 'llm_unavailable' : 'llm_error';
      throw new LLMError(code, `OpenRouter ${res.status}: ${String(msg).slice(0, 300)}`);
    }
    if (!data) throw new LLMError('llm_error', 'OpenRouter returned a non-JSON response');
    return data;
  }
}

async function send(pathname, { method = 'GET', body, timeout = timeoutMs(), auth = true } = {}) {
  if (auth && !apiKey()) throw new LLMError('llm_unavailable', 'OPENROUTER_API_KEY is not set in .env');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  let text;
  try {
    res = await fetch(baseUrl() + pathname, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${apiKey()}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-Title': appName, // shows the app in the OpenRouter activity log
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new LLMError('llm_timeout', `OpenRouter did not answer within ${timeout} ms`);
    if (!res) throw new LLMError('llm_unavailable', `Cannot reach OpenRouter at ${baseUrl()}`);
    throw new LLMError('llm_error', `The connection to OpenRouter was cut (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* handled by request() */ }
  return { res, data, text };
}

// The models chosen in .env: OPENROUTER_MODEL, plus any extra choices in OPENROUTER_MODELS (comma-separated).
// OpenRouter's catalog is read only for their prices (per million tokens); an id it doesn't know is
// still listed, and OpenRouter's error will name the problem when it's used.
// OpenRouter's public model catalog (prices, supported parameters), cached; null if unreachable.
let catalogCache = { at: 0, map: null };
async function catalog() {
  if (catalogCache.map && Date.now() - catalogCache.at < MODELS_TTL) return catalogCache.map;
  try {
    const map = new Map(((await request('/models', { auth: false, timeout: 15000 })).data || []).map((m) => [m.id, m]));
    catalogCache = { at: Date.now(), map };
    return map;
  } catch {
    return null;
  }
}

async function listModels() {
  const extra = (process.env.OPENROUTER_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = [...new Set([defaultModel(), ...extra])];
  const known = await catalog(); // prices are a nicety
  const perMillion = (v) => Math.round(Number(v || 0) * 1e8) / 100;
  return ids.map((id) => {
    const m = known?.get(id);
    return m ? { name: id, price: { in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion) } } : { name: id };
  });
}

// { reasoning: { effort } } for a model that supports that effort, else nothing.
async function reasoningFor(model) {
  const effort = reasoningEffort();
  if (effort === 'default') return {};
  const m = (await catalog())?.get(model);
  if (!(m?.supported_parameters || []).includes('reasoning')) return {};
  const efforts = m.reasoning?.supported_efforts;
  return !efforts || efforts.includes(effort) ? { reasoning: { effort } } : {};
}

// Checks the key, not just the network.
async function ping() {
  await request('/key', { timeout: 5000 });
  return true;
}

// Returns the raw assistant text.
async function chat({ model, messages, temperature = 0.7 }) {
  const data = await request('/chat/completions', {
    method: 'POST',
    body: { model, messages, temperature, max_tokens: maxTokens(), response_format: { type: 'json_object' }, ...(await reasoningFor(model)) },
  });
  return data.choices?.[0]?.message?.content ?? '';
}

// Hosted models are always loaded.
async function warmup() {}

module.exports = { listModels, ping, chat, warmup, defaultModel, concurrency };
