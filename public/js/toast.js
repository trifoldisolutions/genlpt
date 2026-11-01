// Toasts: a short message in the corner that goes away on its own. Shared by the app (app.js) and the server-drawn
// pages (flash.js). Each page puts its own #toasts where they belong (the app's sits above the mobile sheet); a page
// without one gets a plain bottom-right one.

const KINDS = {
  error: { accent: 'border-l-red-500', icon: 'alert-circle', color: 'text-red-600' },
  ok: { accent: 'border-l-emerald-500', icon: 'check-circle', color: 'text-emerald-600' },
  info: { accent: 'border-l-sky-500', icon: 'info-circle', color: 'text-sky-600' },
};

function container() {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'pointer-events-none fixed inset-x-3 bottom-4 z-[60] flex flex-col items-center gap-2 sm:left-auto sm:right-4 sm:items-end';
    box.setAttribute('aria-live', 'assertive');
    document.body.append(box);
  }
  return box;
}

export function toast(message, kind = 'error', ms = kind === 'error' ? 7000 : 3500) {
  const k = KINDS[kind] || KINDS.error;
  const el = document.createElement('div');
  el.className = `pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-md border border-l-4 border-zinc-200 bg-surface px-3 py-2.5 text-base text-zinc-800 shadow-lg ${k.accent}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = document.createElement('iconify-icon');
  Object.entries({ icon: `boxicons:${k.icon}`, width: '18', height: '18', class: `mt-px ${k.color}`, 'aria-hidden': 'true' }).forEach(([name, value]) => icon.setAttribute(name, value));
  const text = document.createElement('span');
  text.className = 'min-w-0 flex-1';
  text.textContent = message;
  el.append(icon, text);
  // Over an open dialog, the toasts go inside it: everything outside a modal is drawn under it, and inert.
  // They're still fixed to the viewport there, and go back to <body> when it closes (app.js, bindStatic).
  const box = container();
  const host = document.querySelector('dialog[open]') || document.body;
  if (box.parentElement !== host) host.append(box);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}
