const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const brand = require('../config/brand');
const legal = require('../config/legal');
const limits = require('../config/limits');

// The privacy policy and terms as a browser gets them, through routes/public.js and the real views
async function get(pathname, operator = brand.operator) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../views'));
  Object.assign(app.locals, { appName: brand.appName, brand: { ...brand, operator }, limits, legal });
  app.use(require('../routes/public'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${pathname}`);
    return { status: res.status, html: await res.text() };
  } finally {
    server.close();
  }
}

const pages = Object.entries(legal.PATHS).flatMap(([doc, paths]) => Object.entries(paths).map(([lang, p]) => ({ doc, lang, p })));

for (const { doc, lang, p } of pages) {
  test(`legal: ${p} renders the ${doc} document in ${lang}, linking to the other language`, async () => {
    const { status, html } = await get(p);
    assert.equal(status, 200);
    assert.match(html, new RegExp(`<html lang="${lang}">`));
    assert.ok(html.includes(`<title>${legal.TITLES[doc][lang]} · ${brand.appName}</title>`));
    const other = lang === 'en' ? 'fr' : 'en';
    assert.ok(html.includes(`href="${legal.PATHS[doc][other]}" hreflang="${other}"`));
    // The footer links to both documents, in the page's language
    for (const d of Object.keys(legal.PATHS)) assert.ok(html.includes(`href="${legal.PATHS[d][lang]}"`), `footer link to ${d}`);
    assert.doesNotMatch(html, /undefined|NaN|<%/);
    // GenLPT runs itself: the studio that built it is no party to these documents
    assert.ok(!html.includes(brand.company.name), `${brand.company.name} named`);
  });
}

test('legal: the privacy policy quotes the limits from config/limits.js', async () => {
  const { html } = await get(legal.PATHS.privacy.en);
  assert.ok(html.includes(`erased ${limits.GUEST_HOURS} hours after they were last used`));
  assert.ok(html.includes(`deleted after ${limits.UNVERIFIED_DAYS} days`));
  assert.ok(html.includes(`lasts ${limits.LOGIN_DAYS} days after your last visit`));
  assert.ok(html.includes(brand.privacyEmail));
});

test('legal: the French date writes the first of the month "1er"', async () => {
  const { html } = await get(legal.PATHS.privacy.fr);
  const [, , day] = legal.UPDATED.split('-');
  assert.match(html, day === '01' ? /Dernière mise à jour : 1er / : /Dernière mise à jour : \d+ /);
});

test('legal: the terms name the governing state and address once they are set', async () => {
  const unset = await get(legal.PATHS.terms.en, { ...brand.operator, state: null, address: null });
  assert.ok(unset.html.includes('the laws of the United States and of the state where we are based'));
  const set = await get(legal.PATHS.terms.en, { ...brand.operator, state: { en: 'Delaware', fr: 'du Delaware' }, address: '1 Main St, Dover, DE' });
  assert.ok(set.html.includes('the laws of the State of Delaware, United States'));
  assert.ok(set.html.includes('1 Main St, Dover, DE'));
  const fr = await get(legal.PATHS.terms.fr, { ...brand.operator, state: { en: 'Delaware', fr: 'du Delaware' }, address: null });
  assert.ok(fr.html.includes('les lois de l’État du Delaware, aux États-Unis'));
});
