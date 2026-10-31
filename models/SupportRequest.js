const mongoose = require('mongoose');
const { SUPPORT_MESSAGE_MAX_CHARS } = require('../config/limits');

const { Schema } = mongoose;

// A message sent from Settings → Help center (POST /api/support). Each one is also emailed to the support inbox
// (services/support.js), with the sender's address as Reply-To; this copy is the record when that email fails
// (emailed: false). The context is what the app knew when it was sent, so nobody has to ask for it. An account's
// requests go with its data export and its deletion (services/account.js).
const TOPICS = ['billing', 'account', 'usage', 'sessions', 'words', 'other'];

const SupportRequestSchema = new Schema(
  {
    ref: { type: String, required: true }, // "K7Q2XM": what the sender and the inbox both quote
    topic: { type: String, enum: TOPICS, required: true },
    message: { type: String, required: true, maxlength: SUPPORT_MESSAGE_MAX_CHARS },
    email: { type: String, required: true, maxlength: 254 }, // where the reply goes: the account's, or the one a guest typed
    userId: { type: Schema.Types.ObjectId, default: null }, // null: a guest
    owner: String, // "user:<id>" or "guest:<id>": whose sessions these are (middleware/owner.js)
    plan: String,
    subscription: { status: String, currentPeriodEnd: Date, cancelAtPeriodEnd: Boolean }, // as the account had it
    transactionId: Schema.Types.ObjectId, // the payment it's about (billing), one of the account's own
    sessionId: Schema.Types.ObjectId, // the session open when it was sent, one of the sender's own
    userAgent: String,
    emailed: { type: Boolean, default: false },
  },
  { collection: 'support_requests', versionKey: false, timestamps: true }
);

SupportRequestSchema.index({ ref: 1 }, { unique: true });
SupportRequestSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportRequest', SupportRequestSchema);
module.exports.TOPICS = TOPICS;
