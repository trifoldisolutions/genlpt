// OpenRouter provider: hosted models behind one OpenAI-style API (https://openrouter.ai). The models, and the
// reasoning effort each is asked for, come from config/models.js.
const { LLMError } = require('./errors');
const { appName } = require('../../config/brand');
const { MODELS } = require('../../config/models');

const baseUrl = () => (process.env.OPENROUTER_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 180000;
const apiKey = () => (process.env.OPENROUTER_API_KEY || '').trim();
// Output cap per call. Without one, OpenRouter checks credits against the model's maximum (often 65k tokens)
// and refuses calls on a small balance. Answers here are short; reasoning models also spend from this budget.
const maxTokens = () => Number(process.env.OPENROUTER_MAX_TOKENS) || 4096;
// Rate limits (429, e.g. 20 requests/min on new accounts): wait and retry this many times.
const RETRIES = 5; // 2+4+8+16+30 s: enough to outlast a one-minute rate-limit window

// Hosted models take parallel requests.
const concurrency = Number(process.env.OPENROUTER_CONCURRENCY) || 6;

const defaultModel = () => MODELS[0].id;
const guestModel = () => (MODELS.find((m) => m.guest) || MODELS[0]).id;
const listModels = () => MODELS.map((m) => ({ name: m.id }));
const reasoningOf = (model) => MODELS.find((m) => m.id === model)?.reasoning;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait after a 429: 2 s, 4 s, 8 s… (or longer if Retry-After asks), capped at 30 s, with jitter so parallel calls
// don't retry in lockstep. Retry-After alone isn't trusted: OpenRouter can send 0 while the minute window is full.
const retryBase = () => Number(process.env.OPENROUTER_RETRY_MS) || 2000;
function retryDelay(res, attempt) {
  const header = Number(res.headers?.get?.('retry-after')) * 1000 || 0;
  return Math.min(Math.max(header, retryBase() * 2 ** attempt), 30000) + Math.random() * retryBase() / 4;
}

// opts.waits: { rateLimitRetries, waitMs }, counted up while rate limits are waited out.
// opts.retries: how many 429s to wait out (RETRIES by default). A failed answer's error carries its upstreamStatus.
async function request(pathname, opts = {}) {
  const retries = opts.retries ?? RETRIES;
  for (let attempt = 0; ; attempt++) {
    const { res, data, text } = await send(pathname, opts);
    if (res.status === 429 && attempt < retries) {
      const delay = retryDelay(res, attempt);
      if (opts.waits) {
        opts.waits.rateLimitRetries++;
        opts.waits.waitMs += Math.round(delay);
      }
      await sleep(delay);
      continue;
    }
    if (!res.ok || data?.error) {
      const msg = data?.error?.message || text;
      // 401 bad key, 402 no credits: nothing will work until the account is fixed
      const code = res.status === 401 || res.status === 402 ? 'llm_unavailable' : 'llm_error';
      throw Object.assign(new LLMError(code, `OpenRouter ${res.status}: ${String(msg).slice(0, 300)}`), { upstreamStatus: res.status });
    }
    if (!data) throw new LLMError('llm_error', 'OpenRouter returned a non-JSON response');
    return data;
  }
}

async function send(pathname, { method = 'GET', body, timeout = timeoutMs() } = {}) {
  if (!apiKey()) throw new LLMError('llm_unavailable', 'OPENROUTER_API_KEY is not set in .env');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  let text;
  try {
    res = await fetch(baseUrl() + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
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

// Checks the key, not just the network. One try: a health check doesn't wait out a rate limit, and a 429
// still means the key works (calls wait their turn).
async function ping() {
  try {
    await request('/key', { timeout: 5000, retries: 0 });
  } catch (err) {
    if (err.upstreamStatus !== 429) throw err;
  }
  return true;
}

// What a call used, from the answer's usage block: completion tokens include reasoning. The cost is what
// OpenRouter charged (USD), null if it didn't say.
function usageOf(u = {}) {
  return {
    inputTokens: u.prompt_tokens ?? null,
    outputTokens: u.completion_tokens ?? null,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cost: typeof u.cost === 'number' ? u.cost : null,
  };
}

// Returns the raw assistant text and what the call used (see index.js). A failed call carries its rate-limit
// waits as err.usage.
async function chat({ model, messages, temperature = 0.7 }) {
  const waits = { rateLimitRetries: 0, waitMs: 0 };
  const effort = reasoningOf(model);
  let data;
  try {
    data = await request('/chat/completions', {
      method: 'POST',
      body: {
        model,
        messages,
        temperature,
        max_tokens: maxTokens(),
        response_format: { type: 'json_object' },
        usage: { include: true }, // tokens and cost in the answer
        ...(effort ? { reasoning: { effort } } : {}),
      },
      waits,
    });
  } catch (err) {
    err.usage = waits;
    throw err;
  }
  return { text: data.choices?.[0]?.message?.content ?? '', usage: { ...usageOf(data.usage), ...waits } };
}

// What changes a call's cost besides the model, kept with each AI action for the usage report
function settings(model) {
  const effort = reasoningOf(model);
  return { ...(effort ? { reasoning: effort } : {}), maxTokens: maxTokens() };
}

module.exports = { listModels, ping, chat, defaultModel, guestModel, concurrency, settings };
