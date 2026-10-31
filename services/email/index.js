// Account emails go out through Resend's API (https://resend.com/docs/api-reference/emails/send-email).
// Without RESEND_API_KEY they're printed to the console instead (local dev, tests), links included.
// In production nothing is printed without a key: the links would end up in the logs.

const brand = require('../../config/brand');

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10 * 1000;

const sender = () => process.env.EMAIL_FROM || `${brand.appName} <no-reply@genlpt.com>`;

// Absolute links for emails always start from APP_URL, never from the request's Host header:
// a forged Host would otherwise put an attacker's site in a reset link (and send them the token).
const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3008}`).replace(/\/+$/, '');
const link = (path) => `${appUrl()}${path}`;

// Never throws: a failure is logged and the visitor sees the same page either way. Returns whether it went out.
// replyTo: where a reply goes instead of the sender (a support request's sender)
async function sendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[email] RESEND_API_KEY is not set: email not sent');
      return false;
    }
    console.log(`\n[email] To: ${to}${replyTo ? `\n[email] Reply-To: ${replyTo}` : ''}\n[email] Subject: ${subject}\n\n${text}\n`);
    return true;
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sender(), to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return true;
    console.error(`[email] Resend refused "${subject}": ${res.status} ${(await res.text()).slice(0, 300)}`);
  } catch (err) {
    console.error(`[email] sending "${subject}" failed: ${err.message}`);
  }
  return false;
}

module.exports = { sendEmail, link };
