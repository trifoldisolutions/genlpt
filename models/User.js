const crypto = require('crypto');
const mongoose = require('mongoose');
const argon2 = require('argon2');

const { Schema } = mongoose;

// What someone may do (admin pages) is kept apart from what they paid for: an admin can be on any plan.
const ROLES = ['user', 'admin'];
const PLANS = ['free', 'paid'];

// Written only by the payment webhook (provider not chosen yet); copied from the provider as-is.
const SubscriptionSchema = new Schema(
  {
    provider: String,
    customerId: String,
    subscriptionId: String,
    status: String, // the provider's own: active, trialing, past_due, canceled…
    startedAt: Date, // when the subscription began
    currentPeriodEnd: Date, // when it renews, or ends if cancelAtPeriodEnd
    cancelAtPeriodEnd: Boolean, // canceled, but paid up until currentPeriodEnd
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, default: '', trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false }, // argon2id; load with .select('+passwordHash')
    emailVerifiedAt: { type: Date, default: null }, // set by the confirmation link (or a password reset); needed to log in
    deleteAfter: Date, // unconfirmed accounts only: deleted at this time (TTL index) unless the email gets confirmed
    role: { type: String, enum: ROLES, default: 'user' },
    plan: { type: String, enum: PLANS, default: 'free' },
    subscription: SubscriptionSchema,
  },
  {
    timestamps: true,
    collection: 'users',
    toJSON: { transform: (doc, ret) => { delete ret.passwordHash; return ret; } },
  }
);

UserSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0 });

UserSchema.statics.hashPassword = (password) => argon2.hash(password);

// False for a wrong password, and for a stored hash argon2 can't read
UserSchema.methods.checkPassword = function checkPassword(password) {
  return argon2.verify(this.passwordHash, password).catch(() => false);
};

// A login with an email that has no account still checks the password against a decoy hash,
// so the answer takes as long as for a real account and doesn't reveal which emails are registered
let decoy = null;
UserSchema.statics.checkNobody = async function checkNobody(password) {
  decoy ||= argon2.hash(crypto.randomBytes(16).toString('hex'));
  await argon2.verify(await decoy, password).catch(() => false);
  return false;
};

const User = mongoose.model('User', UserSchema);

module.exports = User;
module.exports.ROLES = ROLES;
module.exports.PLANS = PLANS;
