const mongoose = require('mongoose');
const { PLANS } = require('./User');

const { Schema } = mongoose;

// A payment for an account's plan, as its payment provider reports it. Written only by the payment webhook (provider
// not chosen yet), like User.subscription. Settings → Billing lists an account's payments, newest first
// (services/account.js). The provider keeps the invoices themselves; receiptUrl links to its copy.
const STATUSES = ['paid', 'pending', 'failed', 'refunded'];

const TransactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    provider: { type: String, required: true },
    providerId: { type: String, required: true }, // the provider's own id (invoice, charge…): a webhook sent twice saves it once
    plan: { type: String, enum: PLANS, required: true }, // what it paid for
    amount: { type: Number, required: true }, // in currency units, as in config/pricing.js (9 = $9.00), not cents
    currency: { type: String, required: true }, // ISO 4217: USD, CAD…
    status: { type: String, enum: STATUSES, required: true },
    date: { type: Date, required: true }, // when it was made, per the provider
    receiptUrl: String, // the provider's page for its receipt or invoice
  },
  { collection: 'transactions', versionKey: false, timestamps: true }
);

TransactionSchema.index({ userId: 1, date: -1 });
TransactionSchema.index({ provider: 1, providerId: 1 }, { unique: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
module.exports.STATUSES = STATUSES;
