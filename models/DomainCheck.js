const mongoose = require('mongoose');

const { Schema } = mongoose;

// One registry answer per domain name, shared by every session (see services/domains.js); gone at expiresAt,
// so the next look asks the registry again.
const DomainCheckSchema = new Schema(
  {
    _id: String, // the domain name, e.g. "sera.com"
    status: { type: String, enum: ['available', 'taken'], required: true },
    checkedAt: Date,
    expiresAt: Date,
  },
  { collection: 'domain_checks', versionKey: false }
);

DomainCheckSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('DomainCheck', DomainCheckSchema);
