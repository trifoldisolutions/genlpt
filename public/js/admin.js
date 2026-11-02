// Every admin page (views/admin/partials/foot.ejs): the header's menu with the theme in it, the server's notices as
// toasts (flash.js), and Mail's menu of mailboxes, busy buttons, list and form (mail-draft.js). Admin's theme is its own (admin.theme),
// apart from the app's: System follows the device, live.
import './flash.js';
import './mail-draft.js';
import { dateField } from './date-field.js';

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

// A menu opens under its button, lined up with the edge data-menu names. The browser does the rest (a click outside,
// Esc); it closes when the window changes size, which would leave it adrift, unless it's being typed in: a phone's
// keyboard changes the window's size too. A narrow screen moves it along to keep it all on screen.
document.querySelectorAll('[data-menu]').forEach((menu) => {
  const button = document.querySelector(`[popovertarget="${menu.id}"]`);
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    const box = button.getBoundingClientRect();
    const screen = document.documentElement.clientWidth;
    const EDGE = 8;
    menu.style.display = 'block'; // closed, it has no size to measure
    const room = screen - menu.offsetWidth - EDGE;
    menu.style.display = '';
    menu.style.top = `${box.bottom + 4}px`;
    if (menu.dataset.menu === 'left') menu.style.left = `${Math.max(EDGE, Math.min(box.left, room))}px`;
    else menu.style.right = `${Math.max(EDGE, Math.min(screen - box.right, room))}px`;
  });
  addEventListener('resize', () => { if (menu.matches(':popover-open') && !menu.contains(document.activeElement)) menu.hidePopover(); });
});

// Mail's filter: the two ends of a date range, neither past the other
const since = document.getElementById('mail-since');
if (since) {
  const until = document.getElementById('mail-until');
  dateField(since, { max: () => until.value });
  dateField(until, { min: () => since.value });
}

// Forms with data-busy post normally; meanwhile the submit button shows a spinner and can't be pressed twice
// (the one pressed, in a form with more than one: Send, Save as draft). It takes the button's icon's place, or goes
// before its label when it has none.
document.querySelectorAll('form[data-busy]').forEach((form) => {
  const submits = [...form.querySelectorAll('button[type="submit"]')];
  const spinner = document.createElement('span');
  spinner.className = 'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent';
  spinner.setAttribute('aria-hidden', 'true');
  let pressed = null;
  let icon = null;
  form.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return;
    pressed = e.submitter || submits[0];
    icon = pressed.querySelector('iconify-icon');
    if (icon) icon.replaceWith(spinner);
    else pressed.prepend(spinner);
    pressed.setAttribute('aria-busy', 'true');
    // After the form has gone: a button that's off when it's sent doesn't count as what sent it
    setTimeout(() => submits.forEach((button) => { button.disabled = true; }));
  });
  // Coming back with the Back button restores the page as it was left: busy
  addEventListener('pageshow', (e) => {
    if (!e.persisted || !pressed) return;
    if (icon) spinner.replaceWith(icon);
    else spinner.remove();
    pressed.removeAttribute('aria-busy');
    submits.forEach((button) => { button.disabled = false; });
    pressed = null;
  });
});

// Mail: a sent email's frame is as tall as what it holds (views/admin/mail.ejs)
document.querySelectorAll('iframe[data-fit]').forEach((frame) => {
  const fit = () => {
    const height = frame.contentDocument?.documentElement.scrollHeight;
    if (height) frame.style.height = `${height + frame.offsetHeight - frame.clientHeight}px`; // its border counts too
  };
  frame.addEventListener('load', fit);
  frame.closest('details')?.addEventListener('toggle', fit);
  addEventListener('resize', fit);
  fit();
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
  document.querySelector('nav[aria-label="Folders"] [aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // the row that scrolls sideways, on a phone
  addEventListener('pagehide', () => {
    if (!list.offsetParent) return;
    try { sessionStorage.setItem(PLACE, JSON.stringify({ place: list.dataset.place, top: list.scrollTop })); } catch { /* storage blocked */ }
  });
}
