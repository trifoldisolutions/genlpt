const mongoose = require('mongoose');

const { Schema } = mongoose;

// One counter per limit, subject and time window (see middleware/rateLimit.js); gone once its window ends.
const RateLimitSchema = new Schema(
  {
    _id: String, // "<limit>:<hash of IP or email>:<window start ms>"
    count: Number, // no default: the first $inc creates it
    expiresAt: Date,
  },
  { collection: 'rate_limits', versionKey: false }
);

RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimit', RateLimitSchema);
