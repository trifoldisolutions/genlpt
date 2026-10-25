const mongoose = require('mongoose');

const { Schema } = mongoose;

// One AI usage window per subject (see services/usage.js): opened by its first AI action, gone once it ends.
const UsageSchema = new Schema(
  {
    _id: String, // "owner:<owner key>", or "ip:<hash of IP>" for guests
    startedAt: Date,
    expiresAt: Date, // startedAt + USAGE_WINDOW_HOURS
    runs: Number,
    words: Number,
    expansions: Number,
    reformulations: { type: Map, of: Number }, // per session: { <session id>: count }
  },
  { collection: 'usage_windows', versionKey: false }
);

UsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Usage', UsageSchema);
