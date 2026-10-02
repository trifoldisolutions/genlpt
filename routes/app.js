const express = require('express');

const router = express.Router();

// The single-page brainstorm tool; session id travels in ?s=<id>
router.get('/', (req, res) => {
  res.render('app/index', { shell: 'app' });
});

// Only same-origin paths, so ?next= can't bounce users to another site
const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/app');

// One auth page, two modes; each has its own URL so they can be linked to directly
const authPage = (mode, title) => (req, res) => {
  const next = safeNext(req.query.next);
  if (res.locals.user) return res.redirect(next);
  res.render('app/login', { title, mode, next, shell: 'auth' });
};

router.get('/login', authPage('login', 'Log in'));
router.get('/signup', authPage('signup', 'Sign up'));

// No server session yet; clearing it goes here once auth exists
router.post('/logout', (req, res) => {
  res.redirect('/app');
});

router.routes = [
  { method: 'GET', path: '/', label: 'Acronym brainstorm tool' },
  { method: 'GET', path: '/login', label: 'Log in' },
  { method: 'GET', path: '/signup', label: 'Sign up' },
  { method: 'POST', path: '/logout', label: 'Log out' },
];

module.exports = router;
