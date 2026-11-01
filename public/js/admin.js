// Every admin page (views/admin/partials/foot.ejs): the header's menu with the theme in it, the server's notices as
// toasts (flash.js), and Mail's busy buttons and list. Admin's theme is its own (admin.theme), apart from the app's:
// System follows the device, live.
import './flash.js';

const KEY = 'admin.theme';
const root = document.documentElement;
const deviceDark = matchMedia('(prefers-color-scheme: dark)');
const draw = (choice) => {
  root.dataset.themeChoice = choice;
  root.dataset.theme = choice === 'system' ? (deviceDark.matches ? 'dark' : 'light') : choice;
};

document.querySelectorAll('input[name="admin-theme"]').forEach((choice) => {
  choice.checked = choice.value === (root.dataset.themeChoice || 'system');
  choice.addEventListener('change', () => {
    try { localStorage.setItem(KEY, choice.value); } catch { /* storage blocked: for this page only */ }
    draw(choice.value);
  });
});
deviceDark.addEventListener('change', () => { if (root.dataset.themeChoice === 'system') draw('system'); });

// The header's menu opens under its button, lined up with its right edge. The browser does the rest (a click outside,
// Esc); it closes when the window changes size, which would leave it adrift.
const menu = document.getElementById('admin-menu');
if (menu) {
  const button = document.querySelector('[popovertarget="admin-menu"]');
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const box = button.getBoundingClientRect();
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.right = `${Math.max(16, document.documentElement.clientWidth - box.right)}px`;
  });
  addEventListener('resize', () => { if (menu.matches(':popover-open')) menu.hidePopover(); });
}

// Forms with data-busy post normally; meanwhile the submit button shows a spinner and can't be pressed twice
document.querySelectorAll('form[data-busy]').forEach((form) => {
  const submit = form.querySelector('button[type="submit"]');
  const icon = submit.querySelector('iconify-icon');
  const spinner = document.createElement('span');
  spinner.className = 'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent';
  spinner.setAttribute('aria-hidden', 'true');
  const setBusy = (busy) => {
    submit.disabled = busy;
    submit.setAttribute('aria-busy', String(busy));
    (busy ? icon : spinner).replaceWith(busy ? spinner : icon);
  };
  form.addEventListener('submit', () => setBusy(true));
  // Coming back with the Back button restores the page as it was left: busy
  addEventListener('pageshow', (e) => { if (e.persisted && submit.disabled) setBusy(false); });
});

// Mail: each email opened is a new page, so the list keeps its place. data-place says which list it is. On a phone the
// list is hidden while an email is open: its place stays as it was.
const list = document.getElementById('mail-list');
if (list) {
  const PLACE = 'admin.mail.place';
  try {
    const saved = JSON.parse(sessionStorage.getItem(PLACE));
    if (saved?.place === list.dataset.place) list.scrollTop = saved.top;
  } catch { /* storage blocked: the list starts at the top */ }
  list.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  document.querySelector('nav[aria-label="Mailboxes"] [aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // the row that scrolls sideways, on a phone
  addEventListener('pagehide', () => {
    if (!list.offsetParent) return;
    try { sessionStorage.setItem(PLACE, JSON.stringify({ place: list.dataset.place, top: list.scrollTop })); } catch { /* storage blocked */ }
  });
}
