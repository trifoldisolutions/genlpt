// The AI models the platform offers, as OpenRouter ids (https://openrouter.ai/models). The first is the default;
// guests get the one marked guest (else the first), and every other plan may pick any. Nothing is looked up at
// OpenRouter: what's here is what's sent, and a wrong id shows as OpenRouter's error on the first call.
// The privacy policy promises that no provider trains on users' answers or publishes them. OpenRouter enforces it,
// not this code: the account's Settings → Privacy → Data Training has all four switches off. A model whose only
// providers train fails on OpenRouter ("No endpoints found matching your data policy"); GET /api/v1/models/user, with
// one of the plans' keys, lists the ones the account allows.
//   reasoning  the effort asked of a model that thinks before answering (one it offers, per its OpenRouter page:
//              none, low, medium, high…). Thinking is billed as output; left out, the model uses its own
//              default (Luna Pro's is medium: ~7k tokens and ~60 s a call).
const MODELS = [
  { id: 'openai/gpt-6-luna-pro', reasoning: 'low', guest: true },
];

module.exports = { MODELS };
