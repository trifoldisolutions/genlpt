// A dropdown in the app's own look, over a native <select> that stays the source of truth: it holds the value,
// the options and the disabled state, and gets the 'change' event, so code reads and listens to the select as
// before. After changing the select from code (value, options, disabled, title), call the returned sync().
// The combobox takes the select's place in its parent. The list opens as a popover, in the top layer, so no
// panel or dialog clips it, placed under the combobox (above it when there's no room below).
// Options: compact (the quiet small look of the session's language/model row); fit (as wide as the widest
// option, like a native select, instead of the current one's width).
// Keyboard and screen readers follow WAI-ARIA's select-only combobox:
// https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/

const TYPE_AHEAD_MS = 500;
const GAP = 4; // px between the combobox and the list
const EDGE = 8; // px the list keeps from the screen's edges

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

export function customSelect(select, { compact = false, fit = false } = {}) {
  const { id } = select;
  const label = document.querySelector(`label[for="${id}"]`);

  // Not a <button>: Enter and Space would click it on top of what the keys already do
  const trigger = el('div', `${compact ? 'meta-select' : 'field'} select-trigger group`);
  trigger.id = `${id}-combobox`;
  trigger.tabIndex = 0;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${id}-listbox`);
  const value = el('span', fit ? 'grid min-w-0' : 'min-w-0 truncate');
  trigger.append(value, icon('chevron-down', compact ? 16 : 18, 'shrink-0 text-zinc-500 transition-transform group-aria-expanded:rotate-180'));

  const list = el('ul', 'select-list');
  list.id = `${id}-listbox`;
  list.hidden = true;
  list.tabIndex = -1;
  list.popover = 'manual';
  list.dataset.compact = String(compact);
  list.setAttribute('role', 'listbox');
  if (label) {
    label.id ||= `${id}-label`;
    label.removeAttribute('for'); // the select it named is hidden now
    label.addEventListener('click', () => trigger.focus());
    trigger.setAttribute('aria-labelledby', label.id);
    list.setAttribute('aria-labelledby', label.id);
  }
  // The select's hint, read with the combobox now that the select is hidden
  const hint = select.getAttribute('aria-describedby');
  if (hint) trigger.setAttribute('aria-describedby', hint);
  // Clicking an option keeps focus on the combobox, so it doesn't blur (and close) first
  list.addEventListener('mousedown', (e) => e.preventDefault());

  select.hidden = true;
  select.parentElement.append(trigger, list);

  let options = [];
  let items = [];
  let built = ''; // the options the items were built from
  let active = -1;
  const isOpen = () => !list.hidden;
  const enabled = (j) => !!options[j] && !options[j].disabled;
  const firstEnabled = () => options.findIndex((_, j) => enabled(j));
  const lastEnabled = () => options.findLastIndex((_, j) => enabled(j));
  // The next option that can be chosen from `from` in direction `dir`, or `from` at the end of the list
  function step(from, dir) {
    for (let j = from + dir; j >= 0 && j < options.length; j += dir) if (enabled(j)) return j;
    return from;
  }

  // Options can change after the dropdown is made (the model list): rebuilt when they do
  function build() {
    options = [...select.options];
    const key = options.map((o) => [o.value, o.textContent, o.disabled].join('\u0000')).join('\u0001');
    if (key === built) return;
    built = key;
    items = options.map((option, i) => {
      const item = el('li', 'select-option');
      item.id = `${id}-option-${i}`;
      item.setAttribute('role', 'option');
      if (option.disabled) item.setAttribute('aria-disabled', 'true');
      item.append(el('span', 'min-w-0 truncate', option.textContent), icon('check', 18, 'shrink-0'));
      item.addEventListener('mousemove', () => { if (enabled(i)) setActive(i); });
      item.addEventListener('click', () => { if (enabled(i)) choose(i); });
      return item;
    });
    list.replaceChildren(...items);
    if (isOpen()) setActive(enabled(active) ? active : firstEnabled());
  }

  function setActive(i) {
    active = i;
    items.forEach((item, j) => { item.dataset.active = String(j === i); });
    if (i < 0) return trigger.removeAttribute('aria-activedescendant');
    trigger.setAttribute('aria-activedescendant', items[i].id);
    items[i].scrollIntoView({ block: 'nearest' });
  }

  // Under the combobox, at least as wide, kept on screen; above it when it doesn't fit below but does above
  function place() {
    const r = trigger.getBoundingClientRect();
    list.style.minWidth = `${r.width}px`;
    const { width, height } = list.getBoundingClientRect();
    const up = r.bottom + GAP + height > window.innerHeight - EDGE && r.top - GAP - height >= EDGE;
    list.style.left = `${Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE))}px`;
    list.style.top = `${up ? r.top - GAP - height : r.bottom + GAP}px`;
  }

  // The list stays where it was placed, so it closes when the page scrolls under it or the window resizes
  function onViewportChange(e) {
    if (e.type === 'resize' || !list.contains(e.target)) close();
  }

  function open(at = select.selectedIndex) {
    if (select.disabled || firstEnabled() < 0) return;
    list.hidden = false;
    list.showPopover?.();
    place();
    trigger.setAttribute('aria-expanded', 'true');
    setActive(enabled(at) ? at : firstEnabled());
    window.addEventListener('resize', onViewportChange);
    document.addEventListener('scroll', onViewportChange, true);
  }

  function close() {
    if (list.matches(':popover-open')) list.hidePopover();
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    setActive(-1);
    window.removeEventListener('resize', onViewportChange);
    document.removeEventListener('scroll', onViewportChange, true);
  }

  function choose(i) {
    close();
    trigger.focus();
    if (i < 0 || i === select.selectedIndex) return;
    select.selectedIndex = i;
    sync();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Typing jumps to the next option starting with what was typed (letters typed quickly add up)
  let typed = '';
  let typedTimer = null;
  function typeAhead(e) {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    clearTimeout(typedTimer);
    typedTimer = setTimeout(() => { typed = ''; }, TYPE_AHEAD_MS);
    typed += e.key.toLowerCase();
    const from = isOpen() ? active : select.selectedIndex;
    const start = typed.length === 1 ? from + 1 : from; // a new letter moves on; more letters refine
    const order = items.map((_, k) => (Math.max(0, start) + k) % items.length);
    const match = order.find((j) => enabled(j) && options[j].textContent.trim().toLowerCase().startsWith(typed));
    if (match === undefined) return;
    if (isOpen()) setActive(match);
    else open(match);
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  trigger.addEventListener('blur', close);
  trigger.addEventListener('keydown', (e) => {
    if (!isOpen()) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) open();
      else if (e.key === 'Home') open(firstEnabled());
      else if (e.key === 'End') open(lastEnabled());
      else return typeAhead(e);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') setActive(step(active, 1));
    else if (e.key === 'ArrowUp') setActive(step(active, -1));
    else if (e.key === 'Home' || e.key === 'PageUp') setActive(firstEnabled());
    else if (e.key === 'End' || e.key === 'PageDown') setActive(lastEnabled());
    else if (e.key === 'Enter' || (e.key === ' ' && !typed)) choose(active);
    else if (e.key === 'Escape') {
      e.stopPropagation(); // closes the list only, not a dialog it's in
      close();
    } else if (e.key === 'Tab') return close();
    else return typeAhead(e);
    e.preventDefault();
  });

  function sync() {
    build();
    const current = select.selectedIndex;
    if (fit) {
      // Every option's text in one grid cell, only the current one visible: the widest sets the width
      value.replaceChildren(...options.map((o, j) => {
        const text = el('span', 'truncate', o.textContent);
        text.style.gridArea = '1 / 1';
        if (j !== current) text.style.visibility = 'hidden';
        return text;
      }));
    } else {
      value.textContent = options[current]?.textContent || '';
    }
    items.forEach((item, j) => item.setAttribute('aria-selected', String(j === current)));
    // Without a <label>, the select's own aria-label and title name the combobox
    if (!label) {
      const name = select.getAttribute('aria-label');
      if (name) { trigger.setAttribute('aria-label', name); list.setAttribute('aria-label', name); }
    }
    if (select.title) trigger.title = select.title;
    else trigger.removeAttribute('title');
    if (select.disabled && isOpen()) close();
    // No tabindex at all while disabled: with -1 a click would still focus it (and show the focus ring)
    if (select.disabled) trigger.removeAttribute('tabindex');
    else trigger.tabIndex = 0;
    trigger.setAttribute('aria-disabled', String(select.disabled));
  }

  sync();
  return { sync };
}
