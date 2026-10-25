const express = require('express');

const router = express.Router();

// Admins only (role 'admin': npm run set-role -- <email> admin). Signed out: the login page, then back here.
// Signed in without the role: a plain 404, so the page isn't advertised to every account.
router.use((req, res, next) => {
  if (req.user?.role === 'admin') return next();
  if (!req.user) return res.redirect(`/app/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.status(404).render('public/404', { title: 'Not found' });
});

router.get('/', (req, res) => {
  res.render('admin/index', { title: 'Admin' });
});

router.routes = [
  { method: 'GET', path: '/', label: 'Admin index (admins only)' },
];

module.exports = router;
