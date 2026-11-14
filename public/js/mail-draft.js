// The form to write in, the mailbox's fourth column (views/admin/mail.ejs). It starts empty. Reply, Forward and New email
// (links with data-draft: the values to start from, worked out by routes/admin.js) fill it in where it is, without
// leaving the page. Only Discard and sending clear what's been typed or attached: filling it in leaves those alone, and
// each email opened is a new page, so the draft is kept for this tab until then. Each mailbox has its own, so that nothing
// written as one goes out as another: another mailbox shows its draft, and this one's is here on coming back. On a screen
// with no room for the column it takes the email's place when one of those links is used, and doesn't get in the way until then.
import { customSelect } from './select.js';
import { attachedFiles, forgetAllFiles, forgetFiles } from './mail-attachments.js';
import { messageEditor } from './mail-editor.js';
import { templateRows } from './mail-templates.js';

const KEY = 'admin.mail.draft';
const ASK_MS = 4000;
const keyOf = (mailbox) => `${KEY}.${mailbox}`;

// From any admin page: nothing stays behind for whoever's next on this computer
document.querySelector('form[action="/logout"]')?.addEventListener('submit', () => {
  try {
    Object.keys(sessionStorage).filter((name) => name.startsWith(KEY)).forEach((name) => sessionStorage.removeItem(name));
  } catch { /* storage blocked: nothing was kept */ }
  forgetAllFiles();
});

const form = document.getElementById('mail-form');

if (form) {
  const chooser = document.getElementById('mail-from'); // Other only: a mailbox sends from its own address
  const picker = chooser && customSelect(chooser);
  const FIELDS = ['to', 'cc', 'subject', 'body', 'opening', 'closing', 't', 'answering', 'forwarding', 'd', 'key', ...(chooser ? ['from'] : [])];
  const columns = document.getElementById('mail-columns');
  const column = document.getElementById('mail-writing');
  const rows = document.getElementById('mail-attachment-choices');
  const rowTemplate = document.getElementById('mail-attachment-choice');
  const field = (name) => form.elements[name];
  const mailbox = field('box').value;
  let choices = JSON.parse(form.dataset.choices || '[]');

  const clearProblem = () => form.querySelector('[role="alert"]')?.remove();
  function showProblem(text) {
    let note = form.querySelector('[role="alert"]');
    if (!note) {
      note = document.createElement('p');
      note.setAttribute('role', 'alert');
      note.className = 'rounded-md bg-red-50 px-3 py-2 text-base text-red-800';
      field('box').before(note);
    }
    note.textContent = text;
    note.scrollIntoView({ block: 'nearest' });
  }

  // Cancel and the X throw away what's been typed and attached, and Cancel sits right beside Send. With anything to lose
  // they ask first, on Cancel: a second click within a few seconds goes ahead.
  const cancel = document.getElementById('mail-cancel');
  let asking = null;
  function stopAsking() {
    clearTimeout(asking);
    asking = null;
    cancel.textContent = 'Cancel';
    delete cancel.dataset.asking;
  }
  function askToDiscard() {
    cancel.textContent = 'Discard draft?';
    cancel.dataset.asking = 'true';
    cancel.focus();
    asking = setTimeout(stopAsking, ASK_MS);
  }

  // Send waits for a message. A forward's is optional: the email forwarded is what it says. Save as draft waits for
  // anything at all to save.
  const send = form.querySelector('button[type="submit"]:not([data-save])');
  const saveDraft = form.querySelector('button[data-save]');
  const hasWork = () => !editor.isEmpty() || files.count() > 0 || !!field('opening').value || !!field('closing').value;
  function showSendState() {
    const waiting = editor.isEmpty() && !field('forwarding').value;
    send.disabled = waiting;
    send.title = waiting ? 'Write a message first' : '';
    const nothing = !hasWork() && !field('to').value.trim() && !field('cc').value.trim() && !field('subject').value.trim();
    saveDraft.disabled = nothing;
    saveDraft.title = nothing ? 'Nothing to save yet' : 'Keep it in Drafts to finish later';
  }

  const files = attachedFiles({
    mailbox,
    input: document.getElementById('mail-file-input'),
    button: document.getElementById('mail-attach'),
    list: document.getElementById('mail-files'),
    template: document.getElementById('mail-file'),
    maxFiles: Number(form.dataset.maxFiles),
    maxBytes: Number(form.dataset.maxBytes),
    onProblem: (text) => (text ? showProblem(text) : clearProblem()),
    onChange: () => {
      showSendState();
      stopAsking();
    },
  });

  const editor = messageEditor({
    textarea: field('body'),
    format: field('format'),
    box: document.getElementById('mail-editor-box'),
    editor: document.getElementById('mail-editor'),
    onFiles: (pasted) => files.add(pasted),
    onChange: () => {
      showSendState();
      stopAsking();
    },
  });

  const templates = templateRows({
    form,
    button: document.getElementById('mail-templates-button'),
    chip: document.getElementById('mail-template'),
    to: field('to'),
    from: field('from'),
    editor,
    onProblem: showProblem,
  });

  // The signature the address adds
  const signatures = JSON.parse(form.dataset.signatures || '{}');
  const signatureRow = document.getElementById('mail-signature');
  function showSignature() {
    const address = field('from').value;
    signatureRow.hidden = !address;
    const text = signatureRow.querySelector('[data-signature]');
    text.textContent = signatures[address] || 'None';
    text.title = text.textContent;
  }

  const read = () => ({
    ...Object.fromEntries(FIELDS.map((name) => [name, field(name).value])),
    choices,
    attachments: [...form.querySelectorAll('[name="attachments"]:checked')].map((box) => box.value),
  });
  const save = () => {
    try { sessionStorage.setItem(keyOf(mailbox), JSON.stringify(read())); } catch { /* storage blocked: it lasts as long as the page */ }
  };
  const saved = (box = mailbox) => {
    try { return JSON.parse(sessionStorage.getItem(keyOf(box))); } catch { return null; }
  };
  const forgetDraft = (box = mailbox) => {
    try { sessionStorage.removeItem(keyOf(box)); } catch { /* storage blocked: nothing was kept */ }
  };

  function fill(draft) {
    FIELDS.forEach((name) => { field(name).value = draft[name] ?? ''; });
    picker?.sync();
    showSignature();
    editor.set(field('body').value);
    choices = draft.choices || [];
    rows.replaceChildren(...choices.map((choice) => {
      const row = rowTemplate.content.cloneNode(true);
      const box = row.querySelector('input');
      box.value = choice.id;
      box.checked = (draft.attachments || []).includes(choice.id);
      row.querySelector('[data-name]').textContent = choice.filename;
      row.querySelector('[data-size]').textContent = choice.size;
      return row;
    }));
    rows.closest('fieldset').hidden = !choices.length;
    const mode = draft.forwarding ? 'forward' : draft.answering ? 'reply' : 'new';
    form.querySelectorAll('[data-when]').forEach((el) => { el.hidden = el.dataset.when !== mode; });
    templates.refresh(); // named for whom it's to now
    clearProblem();
  }

  // Sent: the draft is done. Its mailbox is the address's, as the page may be showing another: a new email sent from Other
  // as Privacy opens at Privacy, whose own draft stays. "done" comes off the address, so a reload doesn't clear what's written next.
  const url = new URL(location.href);
  const savedFiles = JSON.parse(form.dataset.savedFiles || '[]');
  const finished = ['sent', 'forwarded', 'drafted'].includes(url.searchParams.get('done')) ? url.searchParams.get('box') || mailbox : null;
  if (finished) {
    forgetDraft(finished);
    forgetFiles(finished);
  }
  if (savedFiles.length) {
    files.load(field('d').value, savedFiles);
  } else if (form.dataset.filled === 'true' && url.searchParams.has('d')) {
    files.clear(); // a saved draft, opened, with none
  } else if (finished !== mailbox) {
    files.restore();
  }
  if (url.searchParams.has('done')) {
    url.searchParams.delete('done');
    url.searchParams.delete('n');
    history.replaceState(null, '', url);
  }

  // The page's own form comes first: it's the one that was just sent back with a problem, or asked for by address
  const draft = saved();
  if (form.dataset.filled === 'true') {
    const problem = !!form.querySelector('[role="alert"]');
    editor.set(field('body').value || draft?.body);
    templates.refresh();
    save();
    if (!problem && field('to').value) editor.focus();
  } else if (draft) {
    fill(draft);
  }
  showSendState();

  form.addEventListener('input', () => {
    save();
    showSendState();
  });
  form.addEventListener('change', save); // the dropdown says so with 'change' only
  field('from').addEventListener('change', () => {
    clearProblem();
    showSignature();
  });

  // In Other, the dropdown hides the select, and a browser won't send a form or say why over a hidden field it finds missing
  form.addEventListener('submit', (e) => {
    if (field('from').value || e.submitter?.hasAttribute('data-save')) return; // a draft can wait for one
    e.preventDefault();
    showProblem('Choose the address to send from.');
    document.getElementById('mail-from-combobox').focus();
  });

  // Discarding a saved draft deletes it too, so the list that has it has to start over
  async function deleteSaved(id) {
    const res = await fetch(`/mail/drafts/${id}/delete`, { method: 'POST' }).catch(() => null);
    if (!res?.ok) return showProblem('Couldn’t delete the saved draft. Try again.');
    const next = new URL(location.href);
    next.searchParams.delete('d');
    next.searchParams.set('done', 'draft-deleted');
    location.assign(next);
  }

  document.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    // Opening a saved draft takes the place of its mailbox's: not over something else being written there
    const opening = e.target.closest('[data-open-draft]');
    if (opening && opening.dataset.openDraft !== field('d').value) {
      const here = opening.dataset.box === mailbox;
      const kept = here ? null : saved(opening.dataset.box);
      if (here ? hasWork() : kept?.body && kept.d !== opening.dataset.openDraft) {
        e.preventDefault();
        columns.dataset.writing = 'true';
        return showProblem(here ? 'Save or cancel what you’re writing before opening a draft.' : `Save or cancel what you’re writing in ${opening.dataset.boxLabel} before opening this draft.`);
      }
    }
    const link = e.target.closest('[data-draft], [data-draft-discard], [data-draft-close]');
    if (!link) return;
    e.preventDefault();
    if ('draftClose' in link.dataset) {
      columns.dataset.writing = 'false';
    } else if ('draftDiscard' in link.dataset) {
      const savedId = field('d').value;
      if (!asking && (savedId || hasWork())) return askToDiscard();
      stopAsking();
      fill({ key: field('key').value });
      forgetDraft();
      files.clear();
      columns.dataset.writing = 'false';
      if (savedId) deleteSaved(savedId);
    } else {
      fill({ ...JSON.parse(link.dataset.draft), body: field('body').value, opening: field('opening').value, closing: field('closing').value, d: field('d').value });
      save();
      columns.dataset.writing = 'true';
      (field('to').value ? editor : field('to')).focus();
    }
  });

  // Files dropped on the column attach. Dropped anywhere else they do nothing, instead of the browser leaving for them.
  const DROPPING = ['ring-2', 'ring-inset', 'ring-cerise-500'];
  const holdsFiles = (e) => e.dataTransfer?.types.includes('Files');
  addEventListener('dragover', (e) => {
    if (!holdsFiles(e)) return;
    e.preventDefault();
    const over = column.contains(e.target);
    column.classList.toggle(DROPPING[0], over);
    column.classList.toggle(DROPPING[1], over);
    column.classList.toggle(DROPPING[2], over);
    e.dataTransfer.dropEffect = over ? 'copy' : 'none';
  });
  addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) column.classList.remove(...DROPPING);
  });
  addEventListener('drop', (e) => {
    if (!holdsFiles(e)) return;
    e.preventDefault();
    column.classList.remove(...DROPPING);
    if (column.contains(e.target)) files.add(e.dataTransfer.files);
  });
}
