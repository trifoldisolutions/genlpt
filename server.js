// override: .env wins over inherited env (e.g. a stale PORT injected into VS
// Code terminals), so the port always follows project-ports.json.
require('dotenv').config({ override: true });

const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const brand = require('./config/brand');
const limits = require('./config/limits');

const app = express();
const PORT = process.env.PORT || 3008;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.appName = brand.appName;
app.locals.brand = brand;
app.locals.limits = limits;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/cytoscape', express.static(path.join(__dirname, 'node_modules/cytoscape/dist')));

// Signed-in user for views ({ name, email } or null). Placeholder until auth
// is wired up: set req.user in the auth middleware and everything follows.
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

// Facades
const facades = [
  { name: 'Public', mount: '/', router: require('./routes/public') },
  { name: 'App', mount: '/app', router: require('./routes/app') },
  { name: 'Admin', mount: '/admin', router: require('./routes/admin') },
  { name: 'Dev', mount: '/dev-resources', router: require('./routes/tasks') },
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
    const error = err.type === 'entity.parse.failed' ? 'invalid_json' : status >= 500 ? 'server_error' : 'bad_request';
    return res.status(status).json({ error, message: status >= 500 ? 'Unexpected server error' : err.message });
  }
  console.error(err);
  res.status(status).send(status >= 500 ? 'Server error' : err.message);
});

// Mongo
if (process.env.MONGO_URI) {
  mongoose
    .connect(process.env.MONGO_URI, { dbName: 'project_acronym_maker' })
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.error('MongoDB connection error:', err.message));
} else {
  console.warn('MONGO_URI is not set — database features are disabled.');
}

app.listen(PORT, () => {
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
