// The quote button at the end of the message's toolbar (views/admin/mail.ejs) shows two rows in the message box:
// openings over what's written, closings under it, each a row that scrolls sideways. They name whom it's to, the admin
// writing and the mailbox it's from (GET /mail/templates, from config/mail.js). The one chosen of each stands out in its
// row and sits apart from the message, between it and the row: another takes its place, and choosing it again or its ×
// takes it off. The form sends them as they read (opening, closing) and the server frames the message with them
// (services/mail.js). When To or From changes, the ones chosen follow the names. The rows are asked for ahead of the
// click too, as the button is pointed at or focused, so they're usually ready to show. When they aren't, the button is
// busy until they are.

const SPINNER = 'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent';
const ONE = { openings: 'opening', closings: 'closing' }; // a row → the field and piece of the one chosen from it

export function templateRows({ form, button, chip, to, from, editor, onProblem }) {
  const found = new Map(); // what To and From say → their openings and closings
  const asking = new Map(); // what To and From say → the request on its way
  const parts = Object.fromEntries(Object.entries(ONE).map(([kind, one]) => [kind, {
    row: document.getElementById(`mail-${kind}`),
    piece: document.getElementById(`mail-${one}`),
    field: form.elements[one],
  }]));
  const chosen = { openings: null, closings: null }; // where the one chosen is in its row, when that's known
  const icon = button.querySelector('iconify-icon');
  const spinner = document.createElement('span');
  spinner.className = SPINNER;
  spinner.setAttribute('aria-hidden', 'true');

  const said = () => String(new URLSearchParams({ to: to.value.trim(), from: from.value }));

  function ask(key = said()) {
    if (found.has(key)) return Promise.resolve(found.get(key));
    if (!asking.has(key)) {
      const request = fetch(`/mail/templates?${key}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((lists) => {
          asking.delete(key);
          if (lists) found.set(key, lists);
          return lists;
        });
      asking.set(key, request);
    }
    return asking.get(key);
  }

  // Each piece shows what its field holds, and each row which of its choices that is
  function showChosen() {
    for (const [kind, { row, piece, field }] of Object.entries(parts)) {
      piece.hidden = !field.value;
      piece.querySelector('[data-text]').textContent = field.value;
      row.querySelectorAll('button[data-kind]').forEach((choice) => {
        choice.setAttribute('aria-pressed', String(Number(choice.dataset.index) === chosen[kind]));
      });
    }
  }

  // A field the script changes, said the way typing says it, so the draft is kept (mail-draft.js)
  function set(kind, text) {
    const { field } = parts[kind];
    if (field.value === text) return;
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The rows for what To and From say now. The one chosen follows the names in them; one from a draft kept or opened is
  // found by what it says, if it still says it. Each choice on a line of its own, all of it in its title.
  function use(lists) {
    for (const [kind, { row, field }] of Object.entries(parts)) {
      if (chosen[kind] !== null && lists[kind][chosen[kind]] !== undefined) set(kind, lists[kind][chosen[kind]]);
      else chosen[kind] = field.value && lists[kind].includes(field.value) ? lists[kind].indexOf(field.value) : null;
      row.querySelector('[data-list]').replaceChildren(...lists[kind].map((text, i) => {
        const choice = chip.content.firstElementChild.cloneNode(true);
        choice.textContent = text.replace(/\s*\n+\s*/g, ' ');
        choice.title = text;
        choice.dataset.kind = kind;
        choice.dataset.index = i;
        choice.dataset.text = text;
        return choice;
      }));
    }
    showChosen();
  }

  async function follow() {
    const key = said();
    const lists = await ask(key);
    if (lists && key === said()) use(lists);
  }

  const shown = () => Object.values(parts).some(({ row }) => !row.hidden);
  const showState = () => button.setAttribute('aria-expanded', String(shown()));

  function hide() {
    Object.values(parts).forEach(({ row }) => { row.hidden = true; });
    showState();
  }

  function busy(on) {
    if (on) icon.replaceWith(spinner);
    else spinner.replaceWith(icon);
    button.disabled = on;
    button.toggleAttribute('aria-busy', on);
  }

  async function show() {
    const key = said();
    if (!found.has(key)) {
      busy(true);
      const lists = await ask(key);
      busy(false);
      if (!lists) return onProblem('Couldn’t load the openings and closings. Try again.');
    }
    use(found.get(key));
    Object.values(parts).forEach(({ row }) => { row.hidden = false; });
    showState();
  }

  // The message keeps the focus while they're tried, as with the formatting buttons: a press doesn't take it, and a
  // click brings it back from wherever it was (To, say). From the keys, it stays on what was pressed, to try the next.
  const keepWriting = (e) => { if (e.target.closest('button')) e.preventDefault(); };
  const backToWriting = (e) => { if (e.detail) editor.resume(); };

  button.addEventListener('mousedown', keepWriting);
  button.addEventListener('click', (e) => {
    if (shown()) hide();
    else show();
    backToWriting(e);
  });
  button.addEventListener('pointerenter', () => ask());
  button.addEventListener('focus', () => ask());
  // From changes in Other only, by its dropdown
  for (const field of [to, from]) field.addEventListener('change', follow);

  for (const [kind, { row, piece }] of Object.entries(parts)) {
    row.addEventListener('mousedown', keepWriting);
    row.addEventListener('click', (e) => {
      const choice = e.target.closest('button[data-kind]');
      if (!choice) return;
      const i = Number(choice.dataset.index);
      const again = chosen[kind] === i;
      chosen[kind] = again ? null : i;
      set(kind, again ? '' : choice.dataset.text);
      showChosen();
      backToWriting(e);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      hide();
      editor.resume();
    });
    const remove = piece.querySelector('[data-remove]');
    remove.addEventListener('mousedown', keepWriting);
    remove.addEventListener('click', () => {
      chosen[kind] = null;
      set(kind, '');
      showChosen();
      editor.resume(); // the × is gone, from the keys too
    });
  }

  // After the form is filled in (mail-draft.js): what it holds now, for whom it's to now
  function refresh() {
    for (const [kind, { field }] of Object.entries(parts)) if (!field.value) chosen[kind] = null;
    showChosen();
    if (shown() || Object.values(parts).some(({ field }) => field.value)) follow();
  }

  return { refresh };
}
