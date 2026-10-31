const helmet = require('helmet');

// Security headers on every response, from helmet's defaults: CSP, HSTS, nosniff, frame and referrer rules…
// The CSP only lets in what the pages load from other sites: the Iconify script (views/partials/head.ejs),
// the icons it fetches, Google Fonts (helmet already allows https: styles and fonts), and the bot check (signup, guests' support messages).
// A page that starts loading something new from another site needs it added here, or the browser blocks it.

// Iconify's icon API, and the backup hosts it tries when that one is down
const ICONIFY_API = ['https://api.iconify.design', 'https://api.simplesvg.com', 'https://api.unisvg.com'];
// Cloudflare Turnstile (views/app/auth/login.ejs, Help center in public/js/app.js): its script, and its frame
const TURNSTILE = 'https://challenges.cloudflare.com';

const securityHeaders = ({ production = process.env.NODE_ENV === 'production' } = {}) =>
  helmet({
    contentSecurityPolicy: {
      directives: {
        // The iconify-icon package only: jsDelivr serves every npm package, so allowing the whole host would allow any script
        'script-src': ["'self'", 'https://cdn.jsdelivr.net/npm/iconify-icon@2/', TURNSTILE],
        'connect-src': ["'self'", ...ICONIFY_API],
        'frame-src': ["'self'", TURNSTILE],
        // Over plain http (e.g. a phone on the dev machine's LAN address) the upgrade would break every script and stylesheet
        'upgrade-insecure-requests': production ? [] : null,
      },
    },
  });

module.exports = { securityHeaders };
