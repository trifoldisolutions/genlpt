// The theme (Settings → General) on <html>, set before the page is drawn so a dark page never flashes light first.
// A classic, render-blocking script on every page (views/partials/head.ejs), since the CSP allows no inline ones.
// app.js changes it, and saves it under the same key; the themes are in src/input.css.
(() => {
  const THEMES = ['light', 'dark', 'gold']; // the first is the default
  let saved = null;
  try { saved = localStorage.getItem('pref.theme'); } catch { /* storage blocked: the default */ }
  document.documentElement.dataset.theme = THEMES.includes(saved) ? saved : THEMES[0];
})();
