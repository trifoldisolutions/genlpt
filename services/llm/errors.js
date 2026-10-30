const STATUS = {
  llm_unavailable: 503,
  ai_paused: 503, // the plan's AI budget is spent (its OpenRouter key's credit limit, or the account's credits)
  llm_timeout: 504,
  llm_error: 502,
  invalid_json: 502,
};

// extra: more fields for the JSON error body, as for ApiError (routes/api.js)
class LLMError extends Error {
  constructor(code, message, extra = null) {
    super(message || code);
    this.name = 'LLMError';
    this.code = code;
    this.status = STATUS[code] || 502;
    this.extra = extra;
  }
}

module.exports = { LLMError };
