// Named so the test runner (node --test, which runs every *-test.js) never picks it up: it really sends an email.
// Sends a test of the daily AI spend alert (the real warning email, marked [Test]) to check it reaches its inbox:
//   npm run alert:test                          to ALERT_EMAIL, the way the app sends alerts
//   npm run alert:test -- alerts@genlpt.com     to the addresses given instead (production's, say)
// It goes through Resend with this .env's RESEND_API_KEY. Without ALERT_EMAIL the app emails the admins (ADMINS):
// name an address instead.

require('dotenv').config({ override: true, quiet: true });
const { sendEmail } = require('../services/email');
const { spendAlert } = require('../services/email/templates');
const { alertAddresses } = require('../services/spend');
const { DAILY_SPEND } = require('../config/limits');

async function main() {
  const given = process.argv.slice(2).flatMap((arg) => arg.split(',')).map((s) => s.trim()).filter(Boolean);
  const to = given.length ? given : alertAddresses();
  if (!to.length) {
    console.error('ALERT_EMAIL is not set in .env: name an address instead, e.g. npm run alert:test -- alerts@genlpt.com');
    process.exitCode = 1;
    return;
  }
  // Without a key, outside production, sendEmail prints the email instead of sending it: that would test nothing
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set in .env, so nothing can be sent.');
    process.exitCode = 1;
    return;
  }
  const { warning } = DAILY_SPEND;
  const email = spendAlert({ line: 'warning', cost: warning, byPlan: { guest: warning * 0.6, free: warning * 0.4 }, limits: DAILY_SPEND, test: true });
  for (const address of to) {
    if (await sendEmail({ to: address, ...email })) {
      console.log(`Sent to ${address}. Check that it arrives, and not in spam.`);
    } else {
      console.error(`Not sent to ${address}: see the error above.`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
