// What each plan costs (shown in Settings → Billing), then the assumptions behind the usage report's estimates
// (npm run usage:report): how much people use the app, and what a paid plan's price has to cover. The costs
// themselves are measured; edit these freely, each report re-reads them.
const { USAGE_WINDOW_HOURS } = require('./limits');

module.exports = {
  // null: free. Provisional until the usage report's "Paid plan price" can be worked out (every plan tested).
  PLAN_PRICES: {
    guest: null,
    free: null,
    paid: { amount: 9, currency: 'USD', interval: 'month' },
  },
  // A typical usage window uses this share of each of the plan's limits; a full one uses all of them.
  TYPICAL_WINDOW_SHARE: 0.4,
  // Reformulations are limited per session, not per window: a full window is assumed to use them in this many sessions.
  REFORMULATION_SESSIONS_PER_WINDOW: 3,
  // Usage windows in a month. Light and regular are typical windows; max is every window there is, used in full.
  MONTH_WINDOWS: {
    light: 8,
    regular: 30,
    max: Math.floor((30 * 24) / USAGE_WINDOW_HOURS),
  },
  // Who one paying user's price also pays for: free users (at light use) and guest windows (typical), per month.
  FREE_USERS_PER_PAID: 20,
  GUEST_WINDOWS_PER_PAID: 50,
  // Card fees on each monthly payment (Stripe-style), and the share of the price to keep after all costs.
  PAYMENT_FEE_PCT: 0.029,
  PAYMENT_FEE_FIXED: 0.3,
  MARGIN: 0.7,
  // Hosting, database, email… in USD a month, shared among this many paying users.
  FIXED_MONTHLY: 0,
  PAYING_USERS: 100,
};
