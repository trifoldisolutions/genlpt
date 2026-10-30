// Usage metering. Every LLM call made while handling a request is recorded on that request's meter, found
// through AsyncLocalStorage, so nothing is passed along. routes/api.js opens a meter for each AI action and
// saves it as an AiAction (models/AiAction.js); npm run usage:report reads those back.
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

// Runs fn with `meter` ({ calls: [], plan }) as the current meter, for everything fn starts (awaited or not).
// plan: the plan the request is on, so its calls go through that plan's key.
const run = (meter, fn) => store.run(meter, fn);

const current = () => store.getStore();

// One provider call: { step, model, retry, ok, error, ms, inputTokens, outputTokens, reasoningTokens,
// cachedTokens, cost, rateLimitRetries, waitMs }. Outside a meter (scripts, tests) nothing is kept.
function record(call) {
  store.getStore()?.calls.push(call);
}

const sum = (calls, key) => calls.reduce((n, c) => n + (c[key] || 0), 0);

// The calls' sums, stored on the AiAction for the report
function totals(calls) {
  return {
    cost: sum(calls, 'cost'),
    inputTokens: sum(calls, 'inputTokens'),
    outputTokens: sum(calls, 'outputTokens'),
    reasoningTokens: sum(calls, 'reasoningTokens'),
  };
}

module.exports = { run, current, record, totals };
