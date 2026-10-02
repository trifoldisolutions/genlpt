// Ollama provider: plain fetch against the local HTTP API.
const { LLMError } = require('./errors');

const baseUrl = () => (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 180000;

// Ollama serves requests one at a time: parallel ones would only queue and burn their timeout.
const concurrency = 1;

const defaultModel = () => process.env.OLLAMA_MODEL || 'huihui_ai/gemma-4-abliterated:12b';

async function request(pathname, { method = 'GET', body, timeout = timeoutMs() } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(baseUrl() + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new LLMError('llm_timeout', `Ollama did not answer within ${timeout} ms`);
    throw new LLMError('llm_unavailable', `Cannot reach Ollama at ${baseUrl()}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* keep raw text */ }
    throw new LLMError('llm_error', `Ollama ${res.status}: ${String(msg).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMError('llm_error', 'Ollama returned a non-JSON response');
  }
}

async function listModels() {
  const data = await request('/api/tags', { timeout: 5000 });
  return (data.models || []).map((m) => ({ name: m.name, size: m.size }));
}

async function ping() {
  await request('/api/version', { timeout: 3000 });
  return true;
}

// Returns the raw assistant text.
async function chat({ model, messages, temperature = 0.7 }) {
  const data = await request('/api/chat', {
    method: 'POST',
    body: {
      model,
      messages,
      stream: false,
      format: 'json',
      think: false,
      keep_alive: '30m',
      options: { temperature },
    },
  });
  return data.message?.content ?? '';
}

// An empty chat request loads the model into memory.
async function warmup(model) {
  await request('/api/chat', { method: 'POST', body: { model, messages: [], keep_alive: '30m' } });
}

module.exports = { listModels, ping, chat, warmup, defaultModel, concurrency };
