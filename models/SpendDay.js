const mongoose = require('mongoose');

const { Schema } = mongoose;

// What the platform's AI cost on one day (UTC), every plan together: services/spend.js adds each AI action's cost
// once it's done, and pauses the plans past their line (DAILY_SPEND in config/limits.js). Kept KEEP_DAYS.
const KEEP_DAYS = 90;

const SpendDaySchema = new Schema(
  {
    _id: String, // the day, "2026-10-25"
    cost: Number, // USD
    byPlan: { guest: Number, free: Number, paid: Number },
    alerted: { warning: Date, guest: Date, free: Date }, // when the email for each line went out
    expiresAt: Date,
  },
  { collection: 'spend_days', versionKey: false }
);

SpendDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SpendDay', SpendDaySchema);
module.exports.KEEP_DAYS = KEEP_DAYS;
