// Bot check on signup: Cloudflare Turnstile. The page shows Cloudflare's widget (most visitors never see it),
// which puts a token in the form; before making an account the server asks Cloudflare whether that token is
// genuine (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
// Without TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY there's no check (local dev, tests): rate limits only.
// The answer's action and hostname aren't compared: signup is the only form with the widget, and Cloudflare
// already limits the site key to the hostnames set for it in its dashboard.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;
const TOKEN_MAX_CHARS = 2048; // Cloudflare's own limit: anything longer can't be a token

// Our own setup is wrong (a missing or revoked secret): retrying won't help, so signups stop until it's fixed
const SETUP_ERRORS = ['missing-input-secret', 'invalid-input-secret', 'bad-request'];

// The site key for the widget, or null when the check is off
function turnstileSiteKey() {
  const { TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY } = process.env;
  return TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY ? TURNSTILE_SITE_KEY : null;
}

// What a form's token says about the visitor: 'ok', 'missing' (the check never finished: too quick, or its
// script was blocked), 'failed' (not a person, or the token was used or expired), or 'unavailable' (our setup).
// When Cloudflare can't answer, the signup goes ahead (logged): a visitor can't cause that, and rate limits still hold.
async function checkTurnstile(token, ip, fetchImpl = fetch) {
  if (!turnstileSiteKey()) return 'ok';
  if (typeof token !== 'string' || !token) return 'missing';
  if (token.length > TOKEN_MAX_CHARS) return 'failed';
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A refusal comes with its error codes whatever the status (a wrong secret is a 400), so the answer is read first
    const answer = await res.json().catch(() => null);
    if (typeof answer?.success !== 'boolean') throw new Error(`HTTP ${res.status}, not a siteverify answer`);
    if (answer.success) return 'ok';
    const codes = answer['error-codes'] || [];
    if (codes.some((code) => SETUP_ERRORS.includes(code))) {
      console.error(`[turnstile] Cloudflare refused our request (${codes.join(', ')}): check TURNSTILE_SECRET_KEY. Signups are blocked until it's fixed.`);
      return 'unavailable';
    }
    if (codes.includes('internal-error')) throw new Error('internal-error');
    return 'failed';
  } catch (err) {
    console.error(`[turnstile] Cloudflare couldn't check a signup, let through: ${err.message}`);
    return 'ok';
  }
}

module.exports = { turnstileSiteKey, checkTurnstile };
