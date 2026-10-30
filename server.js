// override: .env wins over inherited env (e.g. a stale PORT injected into VS
// Code terminals), so the port always follows project-ports.json.
require('dotenv').config({ override: true });

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const brand = require('./config/brand');
const limits = require('./config/limits');
const { sessions, loadUser } = require('./middleware/auth');
const { securityHeaders } = require('./middleware/headers');
const { requestLog } = require('./middleware/requestLog');
const { turnstileSiteKey } = require('./services/turnstile');
const runs = require('./services/runs');
const { PLAN_OFFERS } = require('./services/usage');

const app = express();
const PORT = process.env.PORT || 3008;

// Don't tell visitors the server runs Express (helmet would remove the header; this stops it being set at all)
app.disable('x-powered-by');

// Behind proxies that terminate HTTPS (most hosts), Express must trust them: the login cookie is only set
// over HTTPS, and rate limits need the visitor's real IP. Only a count of proxies is accepted: trusting
// every hop ("true") would let anyone pick their IP with an X-Forwarded-For header and dodge rate limits.
const { TRUST_PROXY, APP_URL } = process.env;
if (/^\d+$/.test(TRUST_PROXY || '')) app.set('trust proxy', Number(TRUST_PROXY));
else if (TRUST_PROXY) console.warn(`TRUST_PROXY must be how many proxies sit in front (usually 1), not "${TRUST_PROXY}": ignored.`);
if (process.env.NODE_ENV === 'production') {
  if (!TRUST_PROXY) console.warn('TRUST_PROXY is not set: behind an HTTPS proxy, logins will silently fail.');
  if (!APP_URL) console.warn('APP_URL is not set: links in account emails will point to localhost.');
  if (!turnstileSiteKey()) console.warn('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are not both set: signups have no bot check, only rate limits.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.appName = brand.appName;
app.locals.brand = brand;
app.locals.limits = limits;
app.locals.planOffers = PLAN_OFFERS;

app.use(securityHeaders());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/cytoscape', express.static(path.join(__dirname, 'node_modules/cytoscape/dist')));
// After static files, so only pages and API calls are logged; before the body parsers, so malformed bodies are too
app.use(requestLog());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Signed-in user: req.user for routes, res.locals.user ({ name, email, … } or null) for views
app.use(sessions, loadUser);

// Facades
const facades = [
  { name: 'Public', mount: '/', router: require('./routes/public') },
  { name: 'App', mount: '/app', router: require('./routes/app') },
  { name: 'Admin', mount: '/admin', router: require('./routes/admin') },
  { name: 'API', mount: '/api', router: require('./routes/api') },
];

facades.forEach(({ mount, router }) => app.use(mount, router));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}` });
  }
  res.status(404).render('public/404', { title: 'Not found' });
});

// Errors raised before reaching a router (e.g. malformed JSON bodies)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (req.path.startsWith('/api/')) {
    if (status >= 500) console.error('[api]', err);
    const error = err.type === 'entity.parse.failed' ? 'invalid_json' : status >= 500 ? 'server_error' : 'bad_request';
    return res.status(status).json({ error, message: status >= 500 ? 'Unexpected server error' : err.message });
  }
  console.error(err);
  res.status(status).send(status >= 500 ? 'Server error' : err.message);
});

// Mongo
if (process.env.MONGO_URI) {
  mongoose
    .connect(process.env.MONGO_URI, { dbName: 'genlpt' })
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.error('MongoDB connection error:', err.message));
} else {
  console.warn('MONGO_URI is not set — database features are disabled.');
}

const server = app.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\nServer running at ${base}\n`);
  facades.forEach(({ name, mount, router }) => {
    console.log(`[${name}]`);
    (router.routes || []).forEach(({ method, path: p, label }) => {
      const full = (mount === '/' ? '' : mount) + (p === '/' && mount !== '/' ? '' : p);
      console.log(`  ${method.padEnd(6)} ${base}${full || '/'} — ${label}`);
    });
  });
  console.log('');
});

// Hosts send SIGTERM before stopping the server, on each deploy: acronym runs going on get SHUTDOWN_GRACE_MS to
// end, and the rest are ended as interrupted and not counted (services/runs.js). Keep it under the host's own
// grace period, after which it kills the server anyway.
process.on('SIGTERM', async () => {
  const graceMs = Number(process.env.SHUTDOWN_GRACE_MS) || 25000;
  console.log(`SIGTERM: stopping once acronym runs end (at most ${graceMs / 1000} s)`);
  server.close();
  await runs.shutdown(graceMs);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
});
