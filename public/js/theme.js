// The theme on <html>, set before the page is drawn so a dark page never flashes light first. A classic,
// render-blocking script (the CSP allows no inline ones). The themes are in src/input.css.
//   The app (views/partials/head.ejs): Settings → General's Light, Dark or Gold, saved by app.js under pref.theme.
//   Admin (views/admin/partials/head.ejs): its own choice, kept apart from the app's, set on the script tag:
//   data-key="admin.theme" data-themes="system light dark". System follows the device; public/js/admin.js changes it.
// <html data-theme-choice> holds the choice (system included); data-theme, what's drawn.
(() => {
  const script = document.currentScript;
  const key = script?.dataset.key || 'pref.theme';
  const themes = (script?.dataset.themes || 'light dark gold').split(' '); // the first is the default
  let saved = null;
  try { saved = localStorage.getItem(key); } catch { /* storage blocked: the default */ }
  const choice = themes.includes(saved) ? saved : themes[0];
  const drawn = choice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.themeChoice = choice;
  document.documentElement.dataset.theme = drawn;
})();
