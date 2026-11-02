// A date field in the app's own look, over a native <input type="date"> that stays the source of truth: it holds the
// value, goes out with the form and gets the 'change' event (like select.js over a <select>). The button takes the input's
// place in its parent. The calendar opens as a popover in the top layer, placed under the button (above it when there's
// no room below), and inside the input's parent, so that clicking it doesn't count as clicking out of a popover it's in.
// Options: min() and max(), the first and last days that can be chosen, asked each time ('' for none): the other end of
// a range, whose days between are tinted.
// Keyboard, on a day: arrows by day and week, Home and End to the week's ends, Page Up and Down by month (with Shift, by
// year). Esc closes the calendar only.
// Days are YYYY-MM-DD strings throughout, as the input holds them: they sort, and no time zone can move them.

const GAP = 4; // px between the button and the calendar
const EDGE = 8; // px the calendar keeps from the screen's edges
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const inUtc = (options) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options });
const MONTH = inUtc({ month: 'long', year: 'numeric' });
const SHORT = inUtc({ dateStyle: 'medium' });
const FULL = inUtc({ dateStyle: 'full' });

const asDate = (day) => new Date(`${day}T00:00:00Z`);
const asDay = (date) => date.toISOString().slice(0, 10);

export const addDays = (day, n) => asDay(new Date(asDate(day).getTime() + n * 24 * 60 * 60 * 1000));

// The same day of another month, or its last day when that month is shorter
export function addMonths(day, n) {
  const date = asDate(day);
  const first = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n + 1, 0)).getUTCDate();
  return asDay(new Date(first + (Math.min(date.getUTCDate(), last) - 1) * 24 * 60 * 60 * 1000));
}

// The 42 days a month's page shows, Sunday first: always six weeks, so the calendar keeps its height from month to month
export function monthPage(day) {
  const first = `${day.slice(0, 7)}-01`;
  const start = addDays(first, -asDate(first).getUTCDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

// The day the input's nearest to when it isn't allowed
export const clampDay = (day, low, high) => (low && day < low ? low : high && day > high ? high : day);

const today = () => {
  const now = new Date();
  return asDay(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name, size, className = '') {
  const node = el('iconify-icon', className);
  node.setAttribute('icon', `boxicons:${name}`);
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function button(className, text) {
  const node = el('button', className, text);
  node.type = 'button'; // inside a form: choosing a day doesn't send it
  return node;
}

export function dateField(input, { min = () => '', max = () => '' } = {}) {
  const label = document.querySelector(`label[for="${input.id}"]`);

  const trigger = button('field select-trigger');
  const value = el('span', 'min-w-0 truncate');
  trigger.append(value, icon('calendar', 18, 'shrink-0 text-zinc-500'));
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');

  const calendar = el('div', 'date-calendar');
  calendar.popover = 'manual';
  calendar.hidden = true;
  calendar.setAttribute('role', 'dialog');

  if (label) {
    label.id ||= `${input.id}-label`;
    label.removeAttribute('for'); // the input it named is hidden now
    label.addEventListener('click', () => trigger.focus());
    trigger.setAttribute('aria-labelledby', `${label.id} ${input.id}-value`);
    value.id = `${input.id}-value`;
    calendar.setAttribute('aria-labelledby', label.id);
  }

  const previous = button('icon-btn size-8 pointer-coarse:size-10');
  previous.setAttribute('aria-label', 'Previous month');
  previous.title = 'Previous month';
  previous.append(icon('chevron-left', 18));
  const next = button('icon-btn size-8 pointer-coarse:size-10');
  next.setAttribute('aria-label', 'Next month');
  next.title = 'Next month';
  next.append(icon('chevron-right', 18));
  const month = el('span', 'text-base font-semibold text-zinc-900');
  month.setAttribute('aria-live', 'polite');
  const top = el('div', 'flex items-center justify-between');
  top.append(previous, month, next);

  const weekdays = el('div', 'mt-1 grid grid-cols-7');
  WEEKDAYS.forEach((name) => {
    const heading = el('span', 'py-1 text-center text-xs font-medium text-zinc-500', name[0]);
    heading.title = name;
    weekdays.append(heading);
  });
  const days = el('div', 'grid grid-cols-7 gap-0.5');

  const goToday = button('btn-ghost px-2 py-1 text-sm font-medium', 'Today');
  const clear = button('btn-ghost px-2 py-1 text-sm font-medium', 'Clear');
  const bottom = el('div', 'mt-1 flex justify-between border-t border-zinc-200 pt-1');
  bottom.append(goToday, clear);

  calendar.append(top, weekdays, days, bottom);
  input.hidden = true;
  input.parentElement.append(trigger, calendar);

  let cursor = ''; // the day the keys are on; its month is the page showing
  const isOpen = () => !calendar.hidden;

  function draw() {
    const low = min();
    const high = max();
    const chosen = input.value;
    const [rangeFrom, rangeTo] = chosen && low ? [low, chosen] : chosen && high ? [chosen, high] : ['', ''];
    month.textContent = MONTH.format(asDate(cursor));
    days.replaceChildren(...monthPage(cursor).map((day) => {
      const cell = button('date-day', String(Number(day.slice(8))));
      cell.dataset.day = day;
      cell.tabIndex = day === cursor ? 0 : -1;
      cell.dataset.outside = String(day.slice(0, 7) !== cursor.slice(0, 7));
      cell.dataset.range = String(!!rangeFrom && day >= rangeFrom && day <= rangeTo);
      cell.setAttribute('aria-label', FULL.format(asDate(day)));
      cell.setAttribute('aria-pressed', String(day === chosen));
      if (day === today()) cell.setAttribute('aria-current', 'date');
      cell.disabled = clampDay(day, low, high) !== day;
      return cell;
    }));
    previous.disabled = !!low && cursor.slice(0, 7) <= low.slice(0, 7);
    next.disabled = !!high && cursor.slice(0, 7) >= high.slice(0, 7);
    goToday.disabled = clampDay(today(), low, high) !== today();
    clear.disabled = !chosen;
  }

  const focusCursor = () => days.querySelector(`[data-day="${cursor}"]`)?.focus();

  function moveTo(day) {
    cursor = clampDay(day, min(), max());
    draw();
    focusCursor();
  }

  // Under the button and kept on screen; above it when it doesn't fit below but does above
  function place() {
    const r = trigger.getBoundingClientRect();
    const { width, height } = calendar.getBoundingClientRect();
    const up = r.bottom + GAP + height > window.innerHeight - EDGE && r.top - GAP - height >= EDGE;
    calendar.style.left = `${Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE))}px`;
    calendar.style.top = `${up ? r.top - GAP - height : r.bottom + GAP}px`;
  }

  const onOutside = (e) => {
    if (!calendar.contains(e.target) && !trigger.contains(e.target)) close();
  };

  function open() {
    cursor = clampDay(input.value || today(), min(), max());
    calendar.hidden = false;
    calendar.showPopover?.();
    draw();
    place();
    trigger.setAttribute('aria-expanded', 'true');
    focusCursor();
    document.addEventListener('pointerdown', onOutside);
    window.addEventListener('resize', place);
  }

  function close() {
    if (!isOpen()) return;
    if (calendar.matches(':popover-open')) calendar.hidePopover();
    calendar.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside);
    window.removeEventListener('resize', place);
  }

  function sync() {
    value.textContent = input.value ? SHORT.format(asDate(input.value)) : 'Any date';
    value.classList.toggle('text-zinc-400', !input.value);
  }

  function choose(day) {
    close();
    trigger.focus();
    if (day === input.value) return;
    input.value = day;
    sync();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // A month's arrow keeps the focus, unless that was as far as it goes
  function turnPage(by, arrow) {
    cursor = clampDay(addMonths(cursor, by), min(), max());
    draw();
    if (arrow.disabled) focusCursor();
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  previous.addEventListener('click', () => turnPage(-1, previous));
  next.addEventListener('click', () => turnPage(1, next));
  goToday.addEventListener('click', () => choose(today()));
  clear.addEventListener('click', () => choose(''));
  days.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-day]');
    if (cell && !cell.disabled) choose(cell.dataset.day);
  });
  days.addEventListener('keydown', (e) => {
    const weekday = asDate(cursor).getUTCDay();
    const steps = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      Home: () => addDays(cursor, -weekday),
      End: () => addDays(cursor, 6 - weekday),
      PageUp: () => addMonths(cursor, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(cursor, e.shiftKey ? 12 : 1),
    };
    if (!steps[e.key]) return;
    e.preventDefault();
    moveTo(steps[e.key]());
  });
  calendar.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); // closes the calendar only, not a popover it's in
    e.stopPropagation();
    close();
    trigger.focus();
  });
  // Tabbed out of it
  calendar.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !calendar.contains(e.relatedTarget) && e.relatedTarget !== trigger) close();
  });
  // Whatever it's in closes: so does it
  input.closest('[popover]')?.addEventListener('beforetoggle', (e) => {
    if (e.newState === 'closed') close();
  });

  sync();
  return { sync };
}
