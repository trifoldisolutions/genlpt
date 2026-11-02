// The files attached to the mailbox's form (views/admin/mail.ejs). The <input type="file"> is what goes out, with the
// form. A browser forgets its files with the page, and each email opened is a new page, so they're also kept in
// IndexedDB (a file doesn't fit in sessionStorage), under this tab's name and the mailbox's, as each mailbox has its own
// draft, until it's sent or discarded. IndexedDB outlives the tab, so what's kept goes after a day, and all of it on
// signing out.

const DB = 'admin.mail';
const STORE = 'attachments';
const TAB_KEY = 'admin.mail.tab';
const KEEP_MS = 24 * 60 * 60 * 1000;

const sizeLabel = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

// A file's name on its badge: the first NAME_CHARS characters, then its extension. Anything long after the last dot, or
// with a space in it, isn't one.
const NAME_CHARS = 20;
export function shortName(filename) {
  const [, stem, extension] = /^(.+)(\.[^.\s]{1,10})$/.exec(filename) || [null, filename, ''];
  const chars = [...stem];
  return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS).join('')}…${extension}` : filename;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// One transaction; what its request found. Storage blocked: nothing, and the files last as long as the page.
async function withStore(mode, work) {
  try {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function tabName() {
  try {
    let name = sessionStorage.getItem(TAB_KEY);
    if (!name) {
      name = `${Date.now()}-${Math.random()}`;
      sessionStorage.setItem(TAB_KEY, name);
    }
    return name;
  } catch {
    return 'this-tab';
  }
}

const placeOf = (mailbox) => `${tabName()}:${mailbox}`;

// A draft sent from a page that's now showing another mailbox
export const forgetFiles = (mailbox) => withStore('readwrite', (store) => store.delete(placeOf(mailbox)));

// Signing out: nothing stays behind for whoever's next on this computer
export function forgetAllFiles() {
  try {
    sessionStorage.removeItem(TAB_KEY);
    indexedDB.deleteDatabase(DB);
  } catch { /* storage blocked: nothing was kept */ }
}

// onProblem: what's wrong with what was just added, for the form to say; null when nothing is
export function attachedFiles({ mailbox, input, button, list, template, maxFiles, maxBytes, onProblem, onChange }) {
  const place = placeOf(mailbox);
  let files = [];

  // The script's here: the button opens the input, and the list takes over from what it would show
  input.hidden = true;
  button.addEventListener('click', () => input.click());

  // The input holds what goes out; the list shows it
  function draw() {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    onChange();
    list.hidden = !files.length;
    list.replaceChildren(...files.map((file) => {
      const row = template.content.cloneNode(true);
      const name = row.querySelector('[data-name]');
      name.textContent = shortName(file.name);
      name.title = file.name;
      row.querySelector('[data-size]').textContent = sizeLabel(file.size);
      row.querySelector('button').addEventListener('click', () => {
        files = files.filter((other) => other !== file);
        draw();
        keep();
        onProblem(null);
      });
      return row;
    }));
  }

  const keep = () => withStore('readwrite', (store) => (files.length ? store.put({ files, savedAt: Date.now() }, place) : store.delete(place)));

  function add(incoming) {
    const fresh = [...incoming].filter((file) => !files.some((other) => sameFile(other, file)));
    const empty = fresh.find((file) => !file.size);
    const next = [...files, ...fresh.filter((file) => file.size)];
    let problem = empty ? `“${empty.name}” is empty or a folder, so it wasn’t attached.` : null;
    if (next.length > maxFiles) problem = `An email can carry ${maxFiles} attached files at most.`;
    else if (next.reduce((sum, file) => sum + file.size, 0) > maxBytes) problem = `These attachments are over the ${Math.floor(maxBytes / 1024 / 1024)} MB an email can carry.`;
    else files = next;
    // Choosing files replaces what's in the input, even when they're refused: put it back
    draw();
    keep();
    onProblem(problem);
    list.scrollLeft = list.scrollWidth; // what was just added is at the end of the row
  }

  function clear() {
    files = [];
    draw();
    keep();
  }

  // Back from the last page, and out with what's been left behind by tabs long closed
  async function restore() {
    const saved = await withStore('readonly', (store) => store.get(place));
    if (saved?.files?.length) {
      files = saved.files;
      draw();
    }
    withStore('readwrite', (store) => {
      store.openCursor().onsuccess = ({ target: { result: cursor } }) => {
        if (!cursor) return;
        if (Date.now() - cursor.value.savedAt > KEEP_MS) cursor.delete();
        cursor.continue();
      };
    });
  }

  // A saved draft's files, from the server, in place of whatever was here
  async function load(draftId, saved) {
    try {
      files = await Promise.all(saved.map(async ({ id, filename, contentType }) => {
        const res = await fetch(`/mail/drafts/${draftId}/files/${id}`);
        if (!res.ok) throw new Error(filename);
        return new File([await res.blob()], filename, { type: contentType || '' });
      }));
      draw();
      keep();
    } catch (err) {
      onProblem(`Couldn’t get “${err.message}” back from the draft. Open it again to try once more.`);
    }
  }

  // The row has no scrollbar to drag: a mouse's wheel moves it sideways
  list.addEventListener('wheel', (e) => {
    if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    list.scrollLeft += e.deltaY;
  }, { passive: false });

  input.addEventListener('change', () => add(input.files));
  return { add, clear, restore, load, count: () => files.length };
}
