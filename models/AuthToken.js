const crypto = require('crypto');
const mongoose = require('mongoose');

const { Schema } = mongoose;

// Single-use links sent by email: confirm an address (verify) or choose a new password (reset).
// The link carries the token; only its hash is stored, so the database alone can't produce a working link.
// Issuing a new link for the same account and purpose cancels the older one. Expired ones are deleted by a TTL index.
const PURPOSES = ['verify', 'reset'];
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const AuthTokenSchema = new Schema(
  {
    _id: String, // sha256 of the token
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    purpose: { type: String, enum: PURPOSES, required: true },
    next: { type: String, default: '/app' }, // where the link leads once used
    expiresAt: { type: Date, required: true },
  },
  { collection: 'auth_tokens', versionKey: false }
);

AuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('base64url');
const live = (token, purpose) => ({ _id: hashToken(token), purpose, expiresAt: { $gt: new Date() } });

// A new link for this account; returns the token to put in it
AuthTokenSchema.statics.issue = async function issue(userId, purpose, hours, next = '/app') {
  const token = crypto.randomBytes(32).toString('base64url');
  await this.deleteMany({ userId, purpose });
  await this.create({ _id: hashToken(token), userId, purpose, next, expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000) });
  return token;
};

// The token's record while it's valid, without using it up: a page behind a link shows before anything happens
AuthTokenSchema.statics.peek = async function peek(token, purpose) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return this.findOne(live(token, purpose)).lean();
};

// Uses the token up: its record comes back once, then never again
AuthTokenSchema.statics.consume = async function consume(token, purpose) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return this.findOneAndDelete(live(token, purpose)).lean();
};

module.exports = mongoose.model('AuthToken', AuthTokenSchema);
module.exports.PURPOSES = PURPOSES;
