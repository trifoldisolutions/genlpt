const express = require('express');
const legal = require('../config/legal');
const { RATE_LIMITS } = require('../config/limits');
const AiAction = require('../models/AiAction');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('public/index');
});

router.get('/about', (req, res) => {
  res.render('public/about', { title: 'About' });
});

// The privacy policy and terms, each in English and French (views/public/legal/<doc>.<lang>.ejs, in the
// views/public/legal.ejs layout). The numbers they quote that aren't in config/limits.js come with them.
// French writes the first of the month "1er", which Intl doesn't
const updatedOn = (lang) => new Intl.DateTimeFormat(lang === 'fr' ? 'fr-CA' : 'en-US', { dateStyle: 'long', timeZone: 'UTC' })
  .format(new Date(`${legal.UPDATED}T00:00:00Z`))
  .replace(/^1 /, lang === 'fr' ? '1er ' : '1 ');
const rateLimitHours = Math.max(...Object.values(RATE_LIMITS).map((r) => r.minutes)) / 60;

const legalRoutes = [];
for (const [doc, paths] of Object.entries(legal.PATHS)) {
  for (const [lang, path] of Object.entries(paths)) {
    const other = lang === 'en' ? 'fr' : 'en';
    router.get(path, (req, res) => {
      res.render('public/legal', {
        title: legal.TITLES[doc][lang],
        doc,
        lang,
        other: { lang: other, href: paths[other] },
        updated: updatedOn(lang),
        aiLogDays: AiAction.KEEP_DAYS,
        rateLimitHours,
      });
    });
    legalRoutes.push({ method: 'GET', path, label: `${legal.TITLES[doc].en} (${lang})` });
  }
}

router.routes = [
  { method: 'GET', path: '/', label: 'Landing page' },
  { method: 'GET', path: '/about', label: 'About page' },
  ...legalRoutes,
];

module.exports = router;
