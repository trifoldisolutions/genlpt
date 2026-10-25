const mongoose = require('mongoose');

const { Schema } = mongoose;

// One AI action someone took (Generate words, Expand, Generate acronyms, Reformulate) with every LLM call it
// made: what it cost and how long it took. Written by routes/api.js (see services/llm/meter.js), read by
// npm run usage:report. Kept a year: long enough to price the plans on real use.
const KINDS = ['words', 'expansions', 'runs', 'reformulations']; // the usage kinds of services/usage.js
const VARIANTS = ['default', 'chunks', 'realWords']; // runs: the options that change how much AI a run uses
const KEEP_DAYS = 365;

const CallSchema = new Schema(
  {
    step: String, // the prompt: words, title, expand, compose, name, rank, reformulate
    model: String,
    retry: Boolean, // a second try after an answer that wasn't valid JSON
    ok: Boolean,
    error: String,
    ms: Number,
    inputTokens: Number,
    outputTokens: Number, // reasoning included
    reasoningTokens: Number,
    cachedTokens: Number,
    cost: Number, // USD; null when the provider didn't say and no price is known
    rateLimitRetries: Number,
    waitMs: Number, // part of ms: time spent waiting out rate limits
  },
  { _id: false }
);

const AiActionSchema = new Schema(
  {
    kind: { type: String, enum: KINDS, required: true },
    variant: { type: String, enum: [...VARIANTS, null], default: null },
    plan: String, // guest, free or paid
    owner: String,
    sessionId: Schema.Types.ObjectId,
    provider: String,
    settings: Schema.Types.Mixed, // the provider's at the time, e.g. { reasoning: 'low', maxTokens: 4096 }
    status: Number, // the HTTP status sent
    error: String,
    counted: Boolean, // false: given back (it failed or added nothing), so it cost us but not the user's limits
    result: Schema.Types.Mixed, // what it produced, e.g. { words: 9 } or { scored, kept, visible, locked }
    ms: Number, // from the click's request to the response: what the user waited
    calls: [CallSchema],
    // Sums over calls
    cost: Number,
    inputTokens: Number,
    outputTokens: Number,
    reasoningTokens: Number,
  },
  { collection: 'ai_actions', versionKey: false, timestamps: { createdAt: true, updatedAt: false } }
);

AiActionSchema.index({ createdAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 60 * 60 });

const AiAction = mongoose.model('AiAction', AiActionSchema);

module.exports = AiAction;
module.exports.KINDS = KINDS;
module.exports.VARIANTS = VARIANTS;
