// Every admin page (views/admin/partials/foot.ejs): the theme switch in the header, and the server's notices as
// toasts (flash.js). Admin's theme is its own (admin.theme), apart from the app's: System follows the device, live.
import './flash.js';

const KEY = 'admin.theme';
const root = document.documentElement;
const deviceDark = matchMedia('(prefers-color-scheme: dark)');
const draw = (choice) => {
  root.dataset.themeChoice = choice;
  root.dataset.theme = choice === 'system' ? (deviceDark.matches ? 'dark' : 'light') : choice;
};

const select = document.getElementById('admin-theme');
if (select) {
  select.value = root.dataset.themeChoice || 'system';
  select.addEventListener('change', () => {
    try { localStorage.setItem(KEY, select.value); } catch { /* storage blocked: for this page only */ }
    draw(select.value);
  });
}
deviceDark.addEventListener('change', () => { if (root.dataset.themeChoice === 'system') draw('system'); });
