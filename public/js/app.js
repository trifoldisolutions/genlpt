// Single-page brainstorm client (vanilla JS).
import { BRANCHES, COLORS, t, errorText, applyStatic, setProvider, llmDownText } from './i18n.js';
import { createGraph } from './graph.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  health: { db: false, llm: false, defaultModel: '' },
  models: [],
  sessions: [],
  sessionQuery: '', // sidebar search box
  session: null,
  modelWarm: false,
  warming: false,
  busy: new Set(), // 'words', 'branch:who', 'word:<id>', 'acronyms', 'acronymDomains' (a run's domain checks)
  langHint: false,
  sort: 'score',
  filter: 'all',
  panel: null, // { kind: 'word' | 'branch', id, mode }
  step: 'describe', // 'describe' | 'explore' | 'acronyms'
  usage: null, // the plan's AI limits and this window's counts (services/usage.js toView)
  newAcronyms: new Set(), // ids from the last run, tagged "New" until the next run or leaving the session
};

let graph = null;
let booted = false; // first session list + session load done (the panel's empty state waits for it)

// ---------------------------------------------------------------------------
// DOM helpers (all text goes through textContent)

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const show = (el, on) => { el.hidden = !on; };

// Boxicons via Iconify (names verified against api.iconify.design).
function icon(name, size = 20, extra = '') {
  return h('iconify-icon', { icon: `boxicons:${name}`, width: String(size), height: String(size), class: extra || undefined, 'aria-hidden': 'true' });
}

function spinner(extra = '', size = 'size-4') {
  return h('span', { class: `inline-block ${size} shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${extra}`, 'aria-hidden': 'true' });
}

// Per-viewer UI preferences; storage may be unavailable.
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const mqDesktop = window.matchMedia('(min-width: 64rem)');
const isDesktop = () => mqDesktop.matches;

function toast(message, kind = 'error', ms = kind === 'error' ? 7000 : 3500) {
  const kinds = {
    error: { accent: 'border-l-red-500', icon: 'alert-circle', color: 'text-red-600' },
    ok: { accent: 'border-l-emerald-500', icon: 'check-circle', color: 'text-emerald-600' },
    info: { accent: 'border-l-sky-500', icon: 'info-circle', color: 'text-sky-600' },
  };
  const k = kinds[kind];
  const el = h('div', {
    class: `pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-md border border-l-4 border-zinc-200 bg-white px-3 py-2.5 text-base text-zinc-800 shadow-lg ${k.accent}`,
    role: kind === 'error' ? 'alert' : 'status',
  }, [icon(k.icon, 18, `mt-px ${k.color}`), h('span', { class: 'min-w-0 flex-1', text: message })]);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------------------
// API

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('network'), { code: 'network' });
  }
  // A guest's session was used: the server pushed its end back and says where it is now
  const left = res.headers.get('X-Session-Expires-In');
  if (left !== null) setSessionExpiry(path.split('/')[2], left); // /sessions/<id>/…
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || res.statusText);
    err.code = data.error || 'generic';
    err.status = res.status;
    err.data = data;
    if (err.code === 'database_unavailable') { state.health.db = false; renderBanners(); watchDb(); }
    if (err.code === 'llm_unavailable') { state.health.llm = false; renderBanners(); renderBusy(); }
    throw err;
  }
  return data;
}

function fail(err) {
  toast(errorText(err));
}

// ---------------------------------------------------------------------------
// Health, models, warm-up

async function checkHealth() {
  try {
    state.health = await api('GET', '/health');
  } catch {
    state.health = { db: false, llm: false, defaultModel: '' };
  }
  setProvider(state.health.provider);
  renderBanners();
  watchDb();
}

// Checks again and reloads whatever came back: the Retry buttons, and watchDb() while the database is down
let rechecking = null;
function recheckHealth() {
  rechecking ||= (async () => {
    const hadDb = state.health.db;
    const hadLlm = state.health.llm;
    await checkHealth();
    if (!hadDb && state.health.db) await boot({ skipHealth: true });
    else if (!hadLlm && state.health.llm) { await loadModels(); renderBusy(); warmup(); }
  })().finally(() => { rechecking = null; });
  return rechecking;
}

// A database outage is often a blip (the computer waking from sleep): while it lasts, check again every
// DB_RECHECK_MS and on coming back to the tab, so the page recovers without Retry.
const DB_RECHECK_MS = 15000;
let dbTimer = null;
function watchDb() {
  clearTimeout(dbTimer);
  if (!state.health.db) dbTimer = setTimeout(() => (document.hidden ? watchDb() : recheckHealth()), DB_RECHECK_MS);
}

async function loadModels() {
  if (!state.health.llm) { state.models = []; renderModelSelect(); return; }
  try {
    const data = await api('GET', '/models');
    state.models = data.models;
  } catch {
    state.models = [];
  }
  renderModelSelect();
}

const currentModel = () => state.session?.model || state.health.defaultModel || '';

let warmToken = 0;
async function warmup() {
  if (!state.health.llm) return;
  const token = ++warmToken;
  state.warming = true;
  state.modelWarm = false;
  renderBanners();
  try {
    await api('POST', '/llm/warmup', { model: currentModel() });
    if (token === warmToken) state.modelWarm = true;
  } catch (err) {
    if (token === warmToken) fail(err);
  } finally {
    if (token === warmToken) { state.warming = false; renderBanners(); }
  }
}

// ---------------------------------------------------------------------------
// Sessions

function sessionIdFromUrl() {
  return new URLSearchParams(location.search).get('s');
}

function setUrl(id, replace = false) {
  const url = id ? `/app?s=${encodeURIComponent(id)}` : '/app';
  history[replace ? 'replaceState' : 'pushState']({ s: id }, '', url);
}

async function loadSessions() {
  if (!state.health.db) { state.sessions = []; renderSessions(); return; }
  try {
    const { sessions, usage } = await api('GET', '/sessions');
    state.sessions = sessions.map(({ expiresInMs, ...s }) => ({ ...s, expiresAt: endIn(expiresInMs) }));
    state.usage = usage;
  } catch (err) {
    state.sessions = [];
    fail(err);
  }
  renderSessions();
  scheduleExpiry();
}

// Same test as the server's BLANK: nothing written in it, so it isn't kept
const isBlank = (s) => !s.title?.trim() && !s.words?.length && !s.acronyms?.length && !BRANCHES.some((b) => s.answers?.[b]?.trim());

async function openSession(id, { push = true } = {}) {
  await flushSave();
  const prev = state.session;
  try {
    const { session } = await api('GET', `/sessions/${id}`);
    const prevModel = currentModel();
    state.session = session;
    // Leaving a blank session drops it; if the delete fails, the next list load sweeps it
    if (prev && prev._id !== id && isBlank(prev)) {
      state.sessions = state.sessions.filter((s) => s._id !== prev._id);
      api('DELETE', `/sessions/${prev._id}`).catch(() => {});
    }
    state.langHint = false;
    state.step = session.acronyms?.length ? 'acronyms' : session.words?.length ? 'explore' : 'describe';
    state.newAcronyms = new Set();
    closePanel();
    toggleOptions(false);
    if (push) setUrl(id);
    renderAll({ resetGraph: true });
    closeDrawer();
    if (currentModel() !== prevModel || !state.modelWarm) warmup();
  } catch (err) {
    // Arriving by address or Back at a session that's gone (often a blank one, swept): open the newest, no error
    if (push || err.status !== 404) fail(err);
    if (err.status === 404) {
      state.sessions = state.sessions.filter((s) => s._id !== id);
      const fallback = state.sessions[0]?._id;
      if (fallback) return openSession(fallback, { push: false }).then(() => setUrl(fallback, true));
      state.session = null;
      setUrl(null, true);
      renderAll({ resetGraph: true });
    }
  }
}

async function createSession() {
  try {
    const { session, expiresInMs } = await api('POST', '/sessions', { language: state.session?.language, model: currentModel() });
    state.sessions.unshift({ _id: session._id, title: session.title, language: session.language, updatedAt: session.updatedAt, expiresAt: endIn(expiresInMs) });
    scheduleExpiry();
    setSessionSearch(false); // so the new, untitled session isn't filtered out
    await openSession(session._id);
    $('#title').focus();
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------------------
// Guest time limit: each guest session is erased on the server a few hours after it was last used, and
// each use pushes that back. The list keeps each one's end (expiresAt, on this browser's clock) for its card.

let expiryTimer = null;

// ms: time left as the server counts it; null for a signed-in user's session, which never expires
const endIn = (ms) => (ms == null ? null : Date.now() + Number(ms));
const shortTime = (at) => (at == null ? '' : new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(at));

// The server pushed a session's end back: its card changes when the minute shown does
function setSessionExpiry(id, ms) {
  const item = state.sessions.find((s) => s._id === id);
  if (!item) return;
  const next = endIn(ms);
  const changed = shortTime(item.expiresAt) !== shortTime(next);
  item.expiresAt = next;
  if (changed) renderSessions();
  scheduleExpiry();
}

// Wakes up a second after the next guest session's end, when the server has surely let it go
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  const next = Math.min(...state.sessions.map((s) => s.expiresAt ?? Infinity));
  if (next !== Infinity) expiryTimer = setTimeout(expireSessions, Math.max(0, next - Date.now()) + 1000);
}

// Guest sessions whose time is up are gone on the server: drop them here too, the open one included
function expireSessions() {
  const gone = state.sessions.filter((s) => s.expiresAt != null && s.expiresAt <= Date.now());
  if (gone.length) {
    const ids = new Set(gone.map((s) => s._id));
    state.sessions = state.sessions.filter((s) => !ids.has(s._id));
    if (ids.has(state.session?._id)) {
      clearTimeout(saveTimer);
      pendingPatch = null;
      state.session = null;
      closePanel();
      setUrl(null, true);
      renderAll({ resetGraph: true });
    } else {
      renderSessions();
    }
    toast(gone.length === 1 ? t('guestSessionExpired', { title: gone[0].title || t('untitled') }) : t('guestSessionsExpired', { n: gone.length }), 'info', 10000);
  }
  scheduleExpiry();
}

// ---------------------------------------------------------------------------
// Guest sessions at login: this browser may still hold sessions made before logging in, and on a shared
// computer they may be someone else's. The user moves them to their account or deletes them.

// busy: 'move' | 'delete' | null
function renderGuestButtons(busy) {
  const move = $('#guest-move');
  const del = $('#guest-delete');
  setButtonBusy(move, busy === 'move', t('guestMove'), t('guestMoving'), 'folder-down-arrow');
  setButtonBusy(del, busy === 'delete', t('guestDelete'), t('guestDeleting'), 'trash');
  move.disabled = !!busy;
  del.disabled = !!busy;
}

// Signed-in users only. Resolves once the dialog closes: answered, or dismissed with Escape (asked again next visit).
async function offerGuestSessions() {
  const dialog = $('#guest-dialog');
  if (!dialog || !state.health.db) return;
  let sessions;
  try {
    ({ sessions } = await api('GET', '/guest-sessions'));
  } catch {
    return; // not worth holding up the app over; asked again next visit
  }
  if (!sessions.length) return;

  const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  $('#guest-dialog-body').textContent = sessions.length === 1 ? t('guestDialogBodyOne') : t('guestDialogBodyMany', { n: sessions.length });
  $('#guest-dialog-list').replaceChildren(...sessions.map((s) => h('li', { class: 'flex items-baseline justify-between gap-3 px-3 py-2' }, [
    h('span', { class: 'min-w-0 truncate text-base text-zinc-800', text: s.title || t('untitled') }),
    h('span', { class: 'shrink-0 text-sm text-zinc-500', text: fmt.format(new Date(s.updatedAt)) }),
  ])));
  const error = $('#guest-dialog-error');
  show(error, false);
  renderGuestButtons(null);

  let pending = null; // the request in flight, if any
  dialog.oncancel = (e) => { if (pending) e.preventDefault(); }; // Escape waits for a request in flight
  dialog.showModal();
  // { move, count } once answered (count: sessions the server actually moved or deleted), null if dismissed
  const answer = await new Promise((resolve) => {
    const answerWith = (move) => () => {
      show(error, false);
      renderGuestButtons(move ? 'move' : 'delete');
      pending = api(move ? 'POST' : 'DELETE', move ? '/guest-sessions/move' : '/guest-sessions').then(
        (r) => {
          resolve({ move, count: move ? r.moved : r.deleted });
          dialog.close();
        },
        (err) => {
          pending = null;
          error.textContent = errorText(err); // a toast would sit under the modal
          show(error, true);
          renderGuestButtons(null);
        }
      );
    };
    $('#guest-move').onclick = answerWith(true);
    $('#guest-delete').onclick = answerWith(false);
    // Some browsers close on a second Escape anyway: a request already sent still gets its answer counted
    dialog.addEventListener('close', () => (pending || Promise.resolve()).then(() => resolve(null)), { once: true });
  });

  // Nothing left to move or delete: the guest's time ran out meanwhile, or another tab already answered
  if (answer && !answer.count) toast(t('guestGone'), 'info');
  else if (answer) toast(t(answer.move ? 'guestMoved' : 'guestDeleted'), 'ok');
  if (answer?.move && answer.count) {
    await loadSessions();
    return;
  }
  // The login link keeps the address, which may still point at one of those sessions: not this account's
  if (sessions.some((s) => s._id === sessionIdFromUrl())) setUrl(null, true);
}

// source: who set it — 'auto' (derived from the "who" answer), 'ai' (suggested on Generate words), 'user'.
function setTitle(title, source) {
  state.session.title = title;
  state.session.titleSource = source;
  $('#title').value = title;
  renderGraphLabels();
}

async function renameSession(id, title) {
  const titleSource = title ? 'user' : 'auto';
  try {
    await api('PATCH', `/sessions/${id}`, { title, titleSource });
    const item = state.sessions.find((s) => s._id === id);
    if (item) { item.title = title; item.updatedAt = new Date().toISOString(); }
    if (state.session?._id === id) setTitle(title, titleSource);
    renderSessions();
  } catch (err) {
    fail(err);
  }
}

async function deleteSession(id) {
  const item = state.sessions.find((s) => s._id === id);
  if (!confirm(t('confirmDeleteSession', { title: item?.title || t('untitled') }))) return;
  try {
    await api('DELETE', `/sessions/${id}`);
    state.sessions = state.sessions.filter((s) => s._id !== id);
    if (state.session?._id === id) {
      clearTimeout(saveTimer);
      pendingPatch = null;
      state.session = null;
      if (state.sessions.length) await openSession(state.sessions[0]._id);
      else { setUrl(null); renderAll({ resetGraph: true }); }
    }
    renderSessions();
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------------------
// Autosave (debounced PATCH)

let saveTimer = null;
let pendingPatch = null;
let savePromise = null;

function setSaveStatus(key) {
  $('#save-status').textContent = key ? t(key) : '';
}

function queueSave(patch) {
  if (!state.session) return;
  pendingPatch = pendingPatch || { id: state.session._id, body: {} };
  const body = pendingPatch.body;
  if (patch.answers) body.answers = { ...(body.answers || {}), ...patch.answers };
  for (const k of ['title', 'titleSource', 'language', 'model']) if (patch[k] !== undefined) body[k] = patch[k];
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

async function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) await savePromise;
  if (!pendingPatch) return;
  const { id, body } = pendingPatch;
  pendingPatch = null;
  savePromise = api('PATCH', `/sessions/${id}`, body)
    .then(({ session }) => {
      const item = state.sessions.find((s) => s._id === id);
      if (item) {
        item.title = session.title;
        item.language = session.language;
        item.updatedAt = session.updatedAt;
        state.sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        renderSessions();
      }
      if (!pendingPatch) setSaveStatus('saved');
    })
    .catch((err) => { setSaveStatus('saveError'); fail(err); })
    .finally(() => { savePromise = null; });
  await savePromise;
}

// ---------------------------------------------------------------------------
// Words

const words = () => state.session?.words || [];
const wordById = (id) => words().find((w) => w._id === id);
// Answer limits come from config/limits.js via <body> data attributes; min ignores whitespace.
const ANSWER_MIN = Number(document.body.dataset.answerMin) || 100;
const ANSWER_MAX = Number(document.body.dataset.answerMax) || 500;
const answerText = (b) => state.session?.answers?.[b] || '';
const answerLength = (b) => answerText(b).replace(/\s/g, '').length;
const hasAnswer = (b) => answerLength(b) >= ANSWER_MIN;
const answerTooShort = (b) => { const n = answerLength(b); return n > 0 && n < ANSWER_MIN; };

function llmBusyMessage(key) {
  return state.modelWarm ? t(key) : t('loadingCold');
}

async function withBusy(key, fn) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  renderBusy();
  try {
    await fn();
  } catch (err) {
    fail(err);
  } finally {
    state.busy.delete(key);
    renderBusy();
  }
}

function addWords(list) {
  if (!list.length) return;
  state.session.words.push(...list);
  renderWords();
}

// A fresh session's first click goes all the way to acronyms (Get acronyms); after that it only adds words.
// With no runs left it can't, so the button stays "Generate words".
const getsAcronyms = () => !words().length && !state.session?.acronyms?.length && runsLeft() > 0;

async function onGenerateWords() {
  const chain = getsAcronyms();
  const added = await expandBranches(BRANCHES.filter(hasAnswer), { all: true, chain });
  if (chain && added) await generateAcronyms({ first: true });
}

// all: triggered by "Generate words", which owns the 'words' busy state even with one answered branch.
// chain: acronyms follow right away, so the words toast stays quiet. Resolves to the number of words added.
async function expandBranches(branches, { all = false, chain = false } = {}) {
  const key = branches.length === 1 && !all ? `branch:${branches[0]}` : 'words';
  let added = 0;
  await flushSave();
  await withBusy(key, async () => {
    const sid = state.session._id;
    const titleBefore = state.session.title;
    const data = await api('POST', `/sessions/${sid}/expand`, branches.length === 1 ? { branches } : {});
    state.usage = data.usage;
    if (state.session?._id !== sid) return;
    state.modelWarm = true;
    // First AI title of the session (the server makes it only once). A rename typed while it ran is newer: keep and resave it.
    if (data.title) {
      state.session.aiTitle = data.title;
      if (state.session.title === titleBefore) {
        setTitle(data.title, 'ai');
        const item = state.sessions.find((s) => s._id === sid);
        if (item) { item.title = data.title; renderSessions(); }
      } else {
        queueSave({ title: state.session.title, titleSource: state.session.titleSource });
      }
    }
    addWords(data.words);
    added = data.words.length;
    if (data.words.length && state.step === 'describe') setStep('explore');
    if (!chain || !data.words.length) toast(data.words.length ? t('wordsAdded', { n: data.words.length }) : t('noNewWords'), data.words.length ? 'ok' : 'info');
    for (const [b, e] of Object.entries(data.errors || {})) {
      toast(t('branchFailed', { branch: t(`b_${b}`), message: errorText({ code: e.error, message: e.message }) }));
    }
  });
  return added;
}

async function expandWord(id) {
  await withBusy(`word:${id}`, async () => {
    const sid = state.session._id;
    const data = await api('POST', `/sessions/${sid}/words/${id}/expand`);
    state.usage = data.usage;
    if (state.session?._id !== sid) return;
    state.modelWarm = true;
    addWords(data.words);
    toast(data.words.length ? t('wordsAdded', { n: data.words.length }) : t('noNewWords'), data.words.length ? 'ok' : 'info');
  });
}

async function addManualWord(branch, text, parentId) {
  const value = text.trim();
  if (!value) return false;
  try {
    const { word } = await api('POST', `/sessions/${state.session._id}/words`, { branch, text: value, parentId });
    addWords([word]);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

async function patchWord(id, body) {
  const w = wordById(id);
  if (!w) return;
  const before = { ...w };
  Object.assign(w, body); // optimistic
  renderWords();
  try {
    const { word } = await api('PATCH', `/sessions/${state.session._id}/words/${id}`, body);
    Object.assign(w, word);
  } catch (err) {
    Object.assign(w, before);
    fail(err);
  }
  renderWords();
}

async function deleteWord(id) {
  const w = wordById(id);
  if (!w || !confirm(t('confirmDeleteWord', { word: w.text }))) return;
  try {
    const { deleted } = await api('DELETE', `/sessions/${state.session._id}/words/${id}`);
    const gone = new Set(deleted);
    state.session.words = state.session.words.filter((x) => !gone.has(x._id));
    closePanel();
    renderWords();
  } catch (err) {
    fail(err);
  }
}

async function bulkSelect(branch, selected) {
  const affected = words().filter((w) => !branch || w.branch === branch);
  const before = affected.map((w) => w.selected);
  affected.forEach((w) => { w.selected = selected; });
  renderWords();
  try {
    await api('POST', `/sessions/${state.session._id}/words/bulk-select`, branch ? { branch, selected } : { selected });
  } catch (err) {
    affected.forEach((w, i) => { w.selected = before[i]; });
    renderWords();
    fail(err);
  }
}

// ---------------------------------------------------------------------------
// Acronyms

// first: the run Get acronyms starts on its own, with settings nobody has looked at yet.
async function generateAcronyms({ first = false } = {}) {
  setStep('acronyms'); // where the result, and the options a failure points to, are
  const minLength = Number($('#min-length').value);
  const maxLength = Number($('#max-length').value);
  if (!Number.isInteger(minLength) || !Number.isInteger(maxLength) || minLength < 2 || maxLength > 8 || minLength > maxLength) {
    toggleOptions(true);
    toast(t('lengthError'));
    return;
  }
  if (first) fitPerBranch(minLength);
  const body = {
    minLength,
    maxLength,
    realWordsOnly: $('#real-only').checked,
    allowChunks: $('#chunks').checked,
    maxPerBranch: Number($('#per-branch').value),
  };
  show($('#acronym-status'), false); // the button shows progress; the note returns with the result
  await withBusy('acronyms', async () => {
    const sid = state.session._id;
    const data = await api('POST', `/sessions/${sid}/acronyms/generate`, body).catch((err) => {
      // Fixed in the options (lengths, words per branch): open them under the error
      if (['not_enough_words', 'length_unreachable'].includes(err.code)) toggleOptions(true);
      throw err;
    });
    state.usage = data.usage;
    if (state.session?._id !== sid) return;
    state.modelWarm = true;
    // A first run's acronyms are all new: the tag only tells a run's from the ones before it
    const before = state.session.acronyms.length || state.session.lockedAcronyms;
    state.newAcronyms = new Set(before ? data.acronyms.map((a) => a._id) : []);
    state.session.acronyms.push(...data.acronyms);
    state.session.lockedAcronyms = (state.session.lockedAcronyms || 0) + data.locked;
    // The run ends with its cards, which show once their domains are checked
    await withBusy('acronymDomains', () => checkRunDomains(sid, data.acronyms));
    if (state.session?._id !== sid) return;
    renderAcronyms();
    const note = $('#acronym-status');
    note.textContent = data.acronyms.length ? t('acronymsAdded', { n: data.acronyms.length }) : t('noNewAcronyms');
    show(note, true);
    if (data.llmError && state.health.llm) toast(errorText({ code: data.llmError.error, message: data.llmError.message }));
  });
}

async function toggleFavorite(a) {
  a.favorite = !a.favorite;
  renderAcronyms();
  try {
    await api('PATCH', `/sessions/${state.session._id}/acronyms/${a._id}`, { favorite: a.favorite });
  } catch (err) {
    a.favorite = !a.favorite;
    renderAcronyms();
    fail(err);
  }
}

async function deleteAcronym(a) {
  try {
    await api('DELETE', `/sessions/${state.session._id}/acronyms/${a._id}`);
    state.session.acronyms = state.session.acronyms.filter((x) => x._id !== a._id);
    graph?.clearHighlight();
    renderAcronyms();
  } catch (err) {
    fail(err);
  }
}

async function clearAcronyms() {
  if (!confirm(t('confirmClear'))) return;
  try {
    await api('POST', `/sessions/${state.session._id}/acronyms/clear`);
    state.session.acronyms = state.session.acronyms.filter((a) => a.favorite);
    state.session.lockedAcronyms = 0; // locked ones are never favorites: cleared too
    renderAcronyms();
  } catch (err) {
    fail(err);
  }
}

// Whether each acronym's .com, .net, .org and .io are registered. A card shows only once its domains were asked
// about (domainsChecked): a run's acronyms are checked before the run ends (checkRunDomains); the others as the
// list renders, one batch at a time, in list order. Each answer is kept for the page's life. A batch whose request
// fails still shows its cards (no badges: a registry outage mustn't hide results); it, and a name the registry
// didn't answer for, is asked again on a later render, after DOMAIN_RETRY_MS.
const DOMAIN_BATCH = 10; // the server's cap per request
const DOMAIN_RETRY_MS = 60 * 1000;
// acronym id → { list: [{ name, status: 'available' | 'taken' | 'unknown' }], at, checking }
const domains = new Map();
let checkingDomains = false;

const domainsChecked = (a) => !!domains.get(a._id)?.at;

// One request for up to DOMAIN_BATCH acronyms of session sid; marked as checking before any await
async function fetchDomains(sid, batch) {
  for (const a of batch) domains.set(a._id, { list: [], ...domains.get(a._id), checking: true });
  let found = {};
  try {
    found = (await api('GET', `/sessions/${sid}/domains?ids=${batch.map((a) => a._id).join(',')}`)).domains;
  } catch { /* asked again later */ }
  for (const a of batch) domains.set(a._id, { list: found[a._id] || domains.get(a._id).list, at: Date.now() });
}

async function checkDomains(list) {
  if (checkingDomains || !state.session) return;
  const now = Date.now();
  const todo = list.filter((a) => {
    const d = domains.get(a._id);
    if (!d) return true;
    return !d.checking && (!d.list.length || d.list.some((x) => x.status === 'unknown')) && now - d.at > DOMAIN_RETRY_MS;
  }).slice(0, DOMAIN_BATCH);
  if (!todo.length) return;
  checkingDomains = true;
  await fetchDomains(state.session._id, todo);
  checkingDomains = false;
  renderAcronyms(); // shows the answers, and asks for the next batch
}

// A run's acronyms, all batches: marked first, so the list's own checks leave them alone
async function checkRunDomains(sid, list) {
  for (const a of list) domains.set(a._id, { list: [], checking: true });
  for (let i = 0; i < list.length; i += DOMAIN_BATCH) await fetchDomains(sid, list.slice(i, i + DOMAIN_BATCH));
}

// `toastOk: false` when the caller shows its own confirmation next to the button.
async function copyText(text, { toastOk = true } = {}) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'fixed -left-[9999px]' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (toastOk) toast(t('copied'), 'ok');
}

// Confirms a copy on the button itself: a green check for 1.5 s, then the copy icon again.
function flashCopied(btn, size) {
  const label = btn.getAttribute('aria-label');
  btn.replaceChildren(icon('check', size, 'text-emerald-600'));
  btn.title = t('copied');
  btn.setAttribute('aria-label', t('copied'));
  clearTimeout(btn.copiedTimer);
  btn.copiedTimer = setTimeout(() => {
    btn.replaceChildren(icon('copy', size));
    btn.title = t('copy');
    btn.setAttribute('aria-label', label);
  }, 1500);
}

// ---------------------------------------------------------------------------
// Rendering

function renderAll({ resetGraph = false } = {}) {
  applyStatic();
  renderBanners();
  renderSessions();
  const has = !!state.session;
  show($('#workspace'), has);
  show($('#session-bar'), has);
  show($('#session-meta'), has);
  // The language/model row sits in the header, so it changes the mobile peek height
  if (!isDesktop() && sheet.snap === 'peek' && sheet.height !== snapHeights().peek) setSheet('peek', { animate: false });
  show($('#steps'), has);
  show($('#wf-footer'), has && state.step !== 'describe');
  show($('#no-session'), !has);
  $('#workflow').dataset.empty = String(!has);
  renderMinimize();
  if (!has) {
    if (resetGraph) initGraph();
    renderCanvas();
    return;
  }
  $('#title').value = state.session.title;
  $('#title').placeholder = t('untitled');
  $('#language').value = state.session.language;
  renderModelSelect();
  renderQuestions();
  renderLegend();
  if (resetGraph) initGraph();
  renderGraphLabels();
  renderWords();
  renderAcronyms();
  renderBusy();
  renderStep();
  setSaveStatus('');
}

function renderBanners() {
  show($('#banner-db'), !state.health.db);
  show($('#banner-llm'), state.health.db !== undefined && !state.health.llm);
  $('#banner-llm-text').textContent = llmDownText();
  show($('#banner-warmup'), state.health.llm && state.warming);
  show($('#banner-lang'), !!state.session && state.langHint);
  if (state.session) $('#banner-lang-text').textContent = t('langHint', { lang: t(`lang_${state.session.language}`) });
  $('#new-session').disabled = !state.health.db;
  $('#session-search-btn').disabled = !state.health.db;
  document.querySelectorAll('#empty-new, #sessions-empty-new').forEach((b) => { b.disabled = !state.health.db; });
  syncPanel();
}

// The panel starts hidden and stays so until boot knows what it holds, so it never flashes up on load.
// With no sessions the sidebar's empty state is the call to action, so the panel steps aside, unless
// it has a DB/LLM banner to show or the sidebar is off screen (mobile drawer, collapsed sidebar).
function syncPanel() {
  const sidebarCta = !!$('#sessions-empty-new') && isDesktop() && $('#app').dataset.sidebar === 'expanded';
  const banner = !$('#banner-db').hidden || !$('#banner-llm').hidden;
  const visible = booted && (!!state.session || !sidebarCta || banner);
  const intro = $('#wf-intro');
  const showIntro = booted && !state.session && !sidebarCta;
  // Rebuilt only when its wording changes, so a focused button isn't swapped out from under the user
  const kind = state.sessions.length ? 'closed' : 'none';
  if (showIntro && intro.dataset.kind !== kind) {
    intro.replaceChildren(emptyState('empty-new'));
    intro.dataset.kind = kind;
  }
  show(intro, showIntro);
  if ($('#workflow').hidden === !visible) return;
  show($('#workflow'), visible);
  // The mobile sheet's peek height was measured while hidden, without the language/model row
  if (visible && !isDesktop()) setSheet(sheet.snap, { animate: false });
  else updateVisible();
}

// Case- and accent-insensitive, so "ecole" finds "École"
const fold = (str) => str.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Every word of the query must appear in the title, in any order
function filteredSessions() {
  const terms = fold(state.sessionQuery).split(/\s+/).filter(Boolean);
  if (!terms.length) return state.sessions;
  return state.sessions.filter((s) => {
    const name = fold(s.title || t('untitled'));
    return terms.every((w) => name.includes(w));
  });
}

function setSessionSearch(open) {
  const input = $('#session-search');
  $('#session-search-row').hidden = !open;
  $('#session-search-btn').setAttribute('aria-expanded', String(open));
  if (open) { input.focus(); input.select(); return; }
  input.value = '';
  if (state.sessionQuery) { state.sessionQuery = ''; renderSessions(); }
}

// Empty state shared by the sidebar list and the panel (#wf-intro): no sessions yet, or none open
function emptyState(newId) {
  const none = !state.sessions.length;
  return h('div', { class: 'flex flex-col items-center text-center' }, [
    h('span', { class: 'inline-flex size-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-500' }, icon('folder-open', 20)),
    h('p', { class: 'mt-3 text-base font-semibold text-zinc-800', text: t(none ? 'noSessionsTitle' : 'noSessionOpenTitle') }),
    h('p', { class: 'mt-1 text-sm text-zinc-500', text: t(none ? 'noSessionsBody' : 'noSessionOpenBody') }),
    h('button', { type: 'button', id: newId, class: 'btn-primary mt-4 w-full', disabled: !state.health.db, onclick: createSession }, [
      icon('plus', 20),
      h('span', { text: t('newSession') }),
    ]),
    // Guests only (the account row shows a login link); comes back here after logging in
    none && $('#account-login') && h('a', {
      href: '/app/login',
      class: 'mt-3 text-sm font-medium text-cerise-600 underline underline-offset-2 hover:text-cerise-700',
      text: t('logInForSessions'),
      onclick: (e) => { e.currentTarget.href = `/app/login?next=${encodeURIComponent(location.pathname + location.search)}`; },
    }),
  ]);
}

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  if (!state.sessions.length) {
    list.append(h('li', { class: 'px-2 py-6' }, emptyState('sessions-empty-new')));
    syncPanel();
    return;
  }
  syncPanel();
  const shown = filteredSessions();
  if (!shown.length) {
    list.append(h('li', { class: 'px-2 py-3 text-base text-zinc-400', text: t('noSessionMatch', { q: state.sessionQuery.trim() }) }));
    return;
  }
  // "10/21/26, 23:55": short enough to share the line with a guest session's "Expires at"
  const fmt = new Intl.DateTimeFormat('en-US', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const s of shown) {
    const active = state.session?._id === s._id;
    const name = s.title || t('untitled');
    const li = h('li', { class: `group relative flex items-center rounded-md ${active ? 'bg-cerise-50' : 'hover:bg-zinc-100 focus-within:bg-zinc-100'}` });
    const open = h('button', {
      type: 'button',
      class: 'block min-w-0 flex-1 rounded-md px-2 py-2 text-left',
      title: name,
      'aria-current': active ? 'true' : undefined,
      onclick: () => { if (!active) openSession(s._id); else closeDrawer(); },
    }, [
      h('span', { class: `block truncate text-base ${active ? 'font-semibold text-cerise-700' : 'font-medium text-zinc-800'} ${s.title ? '' : 'italic'}`, text: name }),
      // Last edit, and for a guest's session when it goes
      h('span', { class: 'block truncate text-sm text-zinc-600' }, [
        fmt.format(new Date(s.updatedAt)),
        s.expiresAt != null
          ? h('span', { text: ` · ${t('expiresAt', { time: shortTime(s.expiresAt) })}`, title: t('expiresAtHint', { time: shortTime(s.expiresAt) }) })
          : null,
      ]),
    ]);
    // Actions: with a mouse they float over the title's end on hover/focus (fading it out), so the title
    // gets the full row width otherwise; on touch they're always visible and sit beside it.
    const fade = active ? 'from-cerise-50' : 'from-zinc-100';
    const actions = h('div', { class: `absolute inset-y-0 right-0 flex items-center rounded-r-md bg-linear-to-l ${fade} from-75% to-transparent pl-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:static pointer-coarse:shrink-0 pointer-coarse:bg-none pointer-coarse:pl-0 pointer-coarse:opacity-100` }, [
      h('button', {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `${t('rename')}: ${name}`,
        title: t('rename'),
        onclick: () => startRename(li, s),
      }, icon('edit', 18)),
      h('button', {
        type: 'button',
        class: 'icon-btn hover:text-red-600',
        'aria-label': `${t('delete')}: ${name}`,
        title: t('delete'),
        onclick: () => deleteSession(s._id),
      }, icon('trash', 18)),
    ]);
    li.append(open, actions);
    list.append(li);
  }
}

function startRename(li, s) {
  const input = h('input', {
    type: 'text',
    maxlength: '120',
    'aria-label': t('titleLabel'),
    class: 'field py-1.5',
  });
  input.value = s.title;
  const done = (commit) => {
    if (commit && input.value.trim() !== s.title) renameSession(s._id, input.value.trim());
    else renderSessions();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.stopPropagation(); done(false); }
  });
  input.addEventListener('blur', () => done(true), { once: true });
  li.replaceChildren(h('div', { class: 'w-full p-1' }, input));
  input.focus();
  input.select();
}

function renderModelSelect() {
  const sel = $('#model');
  const names = state.models.map((m) => m.name);
  // A model the provider doesn't offer (an Ollama one after switching to OpenRouter) shows as the
  // default, which is also what the server falls back to.
  let current = currentModel();
  if (names.length && !names.includes(current)) current = state.health.defaultModel;
  // Guests may use only the cheapest model: the others are listed but disabled, and the session shows that one
  const allowed = state.models.filter((m) => m.allowed !== false).map((m) => m.name);
  if (allowed.length && !allowed.includes(current)) current = allowed[0];
  if (current && !names.includes(current)) names.unshift(current);
  const usd = (n) => (n ? `$${n}` : 'free');
  sel.replaceChildren(...names.map((n) => {
    const m = state.models.find((x) => x.name === n);
    // Ollama: size on disk. OpenRouter: price per million tokens, input / output.
    const detail = m?.size ? ` (${(m.size / 1e9).toFixed(1)} GB)`
      : m?.price ? ` (${usd(m.price.in)} / ${usd(m.price.out)} per M)` : '';
    const locked = m?.allowed === false;
    return h('option', { value: n, text: n + detail + (locked ? ` · ${t('modelSignUp')}` : ''), disabled: locked });
  }));
  sel.value = current;
  sel.disabled = !state.health.llm || !state.session;
}

const dot = (b, extra = 'size-2.5') => h('span', { class: `inline-block shrink-0 rounded-full ${extra}`, style: { background: COLORS[b] }, 'aria-hidden': 'true' });

// Answers are one paragraph: line breaks and runs of spaces become a single space, leading space goes.
// While typing, one trailing space survives so the next word can follow; `final` (blur) trims it.
function tidyAnswer(value, final = false) {
  const text = value.replace(/\s+/g, ' ').trimStart();
  return final ? text.trimEnd() : text;
}

// Tidies the textarea in place, keeping the caret where it was relative to the text.
function tidyField(ta, final = false) {
  const clean = tidyAnswer(ta.value, final);
  if (clean !== ta.value) {
    const caret = Math.min(tidyAnswer(ta.value.slice(0, ta.selectionStart)).length, clean.length);
    ta.value = clean;
    if (document.activeElement === ta) ta.setSelectionRange(caret, caret);
  }
  return clean;
}

// Collapse pasted whitespace before it lands, so maxlength doesn't cut text that tidying would have made fit.
// insertText keeps the paste undoable and fires input, which tidies the joins.
function onAnswerPaste(e) {
  const ta = e.target;
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  const room = ANSWER_MAX - ta.value.length + (ta.selectionEnd - ta.selectionStart);
  if (document.execCommand('insertText', false, text.replace(/\s+/g, ' ').slice(0, Math.max(0, room)))) e.preventDefault();
}

// Puts text in place of the whole answer. insertText keeps it undoable (Ctrl+Z) and fires input, which saves it.
function replaceAnswer(ta, text) {
  ta.focus();
  ta.select();
  if (!document.execCommand('insertText', false, text)) {
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Replaces the answer with the clipboard text, tidied like a typed paste.
async function pasteAnswer(ta) {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast(t('pasteFailed'));
    return;
  }
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, ANSWER_MAX);
  if (clean) replaceAnswer(ta, clean);
}

// The AI rewrites the saved answer (an account's share per session: services/usage.js); it replaces the text
// like a paste, so Ctrl+Z brings the old one back. The answer is read-only meanwhile (renderReformulate).
async function reformulateAnswer(b) {
  await flushSave();
  await withBusy(`reformulate:${b}`, async () => {
    const sid = state.session._id;
    const data = await api('POST', `/sessions/${sid}/answers/${b}/reformulate`);
    state.usage = data.usage;
    if (state.session?._id !== sid) return;
    state.modelWarm = true;
    if (data.answer === answerText(b)) {
      toast(t('reformulateSame'), 'info');
      return;
    }
    const ta = $(`#answer-${b}`);
    ta.readOnly = false; // still busy here; renderReformulate would only unlock it afterwards
    replaceAnswer(ta, data.answer);
    toast(t('reformulated'), 'ok');
  });
}

// Small icon-only Copy / Paste / Reformulate button under an answer; the label is its tooltip.
function answerTool(name, label, onclick) {
  return h('button', {
    type: 'button',
    title: label,
    class: 'btn-ghost p-0.5 text-zinc-500 pointer-coarse:p-1.5',
    onclick,
  }, icon(name, 14));
}

function renderQuestions() {
  const wrap = $('#questions');
  wrap.replaceChildren();
  for (const b of BRANCHES) {
    const id = `answer-${b}`;
    const ta = h('textarea', {
      id,
      rows: '3',
      maxlength: String(ANSWER_MAX),
      'aria-describedby': `${id}-count`,
      placeholder: t(`ph_${b}`),
      class: 'field mt-1.5 min-h-20 flex-1 resize-none',
      oninput: (e) => onAnswerInput(b, e.isComposing ? e.target.value : tidyField(e.target)),
      onpaste: onAnswerPaste,
      onblur: (e) => { const v = tidyField(e.target, true); if (v !== answerText(b)) onAnswerInput(b, v); },
    });
    // Answers saved before tidying existed get cleaned (and saved) on open.
    ta.value = tidyAnswer(answerText(b), true);
    if (ta.value !== answerText(b)) {
      state.session.answers[b] = ta.value;
      queueSave({ answers: { [b]: ta.value } });
    }
    const copy = answerTool('copy', t('copy'), async (e) => {
      const btn = e.currentTarget;
      await copyText(answerText(b), { toastOk: false });
      flashCopied(btn, 14);
    });
    copy.dataset.answerCopy = b;
    copy.setAttribute('aria-label', `${t('copy')}: ${t(`q_${b}`)}`);
    const paste = answerTool('paste', t('paste'), () => pasteAnswer(ta));
    paste.setAttribute('aria-label', `${t('paste')}: ${t(`q_${b}`)}`);
    const reformulate = answerTool('sparkles', t('reformulate'), () => reformulateAnswer(b));
    reformulate.dataset.answerReformulate = b;
    reformulate.setAttribute('aria-label', `${t('reformulate')}: ${t(`q_${b}`)}`);
    wrap.append(h('div', { class: 'flex flex-1 flex-col' }, [
      h('label', { for: id, class: 'flex min-w-0 items-center gap-2 text-base font-medium text-zinc-800' }, [dot(b), t(`q_${b}`)]),
      ta,
      h('div', { class: 'mt-1 flex items-center' }, [
        copy,
        paste,
        reformulate,
        h('p', { id: `${id}-count`, 'data-answer-count': b, class: 'ml-auto text-right text-xs tabular-nums' }),
      ]),
    ]));
    renderAnswerCount(b);
  }
}

// Below the minimum: non-space count vs. min (amber). Otherwise: total length vs. max (amber near the cap).
function renderAnswerCount(b) {
  const el = document.querySelector(`[data-answer-count="${b}"]`);
  if (!el) return;
  const n = answerLength(b);
  const total = answerText(b).length;
  if (n < ANSWER_MIN) {
    el.textContent = t('answerMin', { n, min: ANSWER_MIN });
    el.className = `ml-auto text-right text-xs tabular-nums ${n ? 'text-amber-600' : 'text-zinc-400'}`;
  } else {
    el.textContent = `${total}/${ANSWER_MAX}`;
    el.className = `ml-auto text-right text-xs tabular-nums ${total >= ANSWER_MAX * 0.9 ? 'text-amber-600' : 'text-zinc-400'}`;
  }
  const copy = document.querySelector(`[data-answer-copy="${b}"]`);
  if (copy) copy.disabled = !answerText(b).trim();
  renderReformulate(b);
}

// An answer's "Reformulate with AI": guests can't (sign up), accounts get the plan's share per session and
// window. The tooltip says which, or how many are left.
function renderReformulate(b) {
  const btn = document.querySelector(`[data-answer-reformulate="${b}"]`);
  if (!btn) return;
  const u = state.usage;
  const busy = state.busy.has(`reformulate:${b}`);
  const left = reformulationsLeft();
  btn.replaceChildren(busy ? spinner('', 'size-3.5') : icon('sparkles', 14));
  btn.setAttribute('aria-busy', String(busy));
  btn.title = busy ? t('reformulating')
    : !u ? t('reformulate')
      : u.plan === 'guest' ? t('reformulateSignUp')
        : left ? t('reformulateLeft', { left, limit: u.reformulations.limit })
          : t('reformulateNone', { time: resetTime() });
  btn.disabled = busy || !left || !state.health.llm || !answerText(b).trim();
  const ta = $(`#answer-${b}`);
  if (ta) ta.readOnly = busy;
}

function onAnswerInput(branch, value) {
  state.session.answers[branch] = value;
  const patch = { answers: { [branch]: value } };
  // Placeholder title until the AI suggests one; paused during Generate words so it can't overwrite that suggestion.
  if (branch === 'who' && state.session.titleSource === 'auto' && !state.busy.has('words')) {
    const suggestion = value.trim().replace(/\s+/g, ' ').slice(0, 60);
    const title = suggestion ? suggestion.charAt(0).toLocaleUpperCase() + suggestion.slice(1) : '';
    setTitle(title, 'auto');
    patch.title = title;
    patch.titleSource = 'auto';
  }
  queueSave(patch);
  renderAnswerCount(branch);
  renderBusy();
}

function renderLegend() {
  $('#legend').replaceChildren(...BRANCHES.map((b) => h('li', { class: 'flex items-center gap-1.5' }, [dot(b, 'size-2'), t(`b_${b}`)])));
}

function initGraph() {
  if (!window.cytoscape) return;
  if (graph) { graph.cy.destroy(); graph = null; }
  graph = createGraph($('#graph'), {
    onWordTap: (id) => {
      closePanel();
      const w = wordById(id);
      if (w) patchWord(id, { selected: !w.selected });
    },
    onWordMenu: (id) => openPanel({ kind: 'word', id }),
    onBranchTap: (b) => openPanel({ kind: 'branch', id: b }),
    onViewportChange: () => closePanel(),
    onBackgroundTap: () => { if (!isDesktop() && sheet.snap !== 'peek') setSheet('peek'); },
    getVisibleRect: visibleRect,
  });
}

function renderGraphLabels() {
  if (!graph || !state.session) return;
  const branches = Object.fromEntries(BRANCHES.map((b) => [b, t(`b_${b}`)]));
  graph.setLabels({ root: state.session.title || t('project'), branches });
}

// Canvas: the real graph once there are words, otherwise the ghost graph + copy.
function renderCanvas() {
  const hasWords = !!state.session && words().length > 0;
  $('#graph').classList.toggle('invisible', !hasWords);
  show($('#canvas-ui'), hasWords);
  show($('#canvas-empty'), !hasWords);
  if (!hasWords) {
    $('#canvas-empty-title').textContent = t(state.session ? 'mapTitle' : 'emptyTitle');
    $('#canvas-empty-body').textContent = t(state.session ? 'mapBody' : 'emptyBody');
  }
}

function renderWords() {
  const list = words();
  const selected = list.filter((w) => w.selected).length;
  $('#selected-count').textContent = t('selectedCount', { n: selected });
  const allOn = list.length > 0 && selected === list.length;
  const sa = $('#select-all');
  sa.textContent = allOn ? t('deselectAll') : t('selectAll');
  sa.disabled = !list.length;
  sa.onclick = () => bulkSelect(null, !allOn);
  renderCanvas();
  renderPerBranchHint();
  renderStepsDone();
  graph?.syncWords(list);
  renderWordList();
  if (state.panel) renderPanel();
}

// Chunks of any length (name-first) have no ceiling on the acronym's length
const chunksStretch = () => $('#chunks').checked && !$('#real-only').checked;

// Longest acronym reachable with the selected words under a words-per-branch cap of n. With "Real words only"
// the dictionary search takes chunks of 2 letters. Mirrors the server's letterCapacity().
function letterReach(n) {
  const selected = words().filter((w) => w.selected);
  const count = BRANCHES.reduce((sum, b) => sum + Math.min(n, selected.filter((w) => w.branch === b).length), 0);
  return count * ($('#chunks').checked ? 2 : 1);
}

function renderPerBranchHint() {
  const n = Number($('#per-branch').value);
  $('#per-branch-hint').textContent = chunksStretch() ? t('perBranchHintChunks', { n }) : t('perBranchHint', { n, max: letterReach(n) });
}

// For the first run only: with one or two questions answered, one word per branch can't reach the min
// length, so allow more (up to 3) rather than fail where the user hasn't seen the settings.
function fitPerBranch(minLength) {
  if (chunksStretch()) return;
  const sel = $('#per-branch');
  let n = Number(sel.value);
  while (n < 3 && letterReach(n) < minLength) n++;
  if (String(n) === sel.value) return;
  sel.value = String(n);
  renderPerBranchHint();
}

function wordChip(w) {
  const color = COLORS[w.branch];
  const tone = w.selected ? { background: color, color: '#fff' } : { background: '#fff', color: '#71717a' };
  const toggle = h('button', {
    type: 'button',
    'aria-pressed': String(w.selected),
    class: 'rounded-l-full py-1 pl-3 pr-1.5 text-sm font-medium',
    style: tone,
    text: w.text,
    onclick: () => patchWord(w._id, { selected: !w.selected }),
  });
  const menu = h('button', {
    type: 'button',
    'aria-label': `${t('wordMenu')}: ${w.text}`,
    title: t('wordMenu'),
    'aria-haspopup': 'dialog',
    class: 'inline-flex items-center rounded-r-full py-1 pl-0.5 pr-2',
    style: tone,
    onclick: (e) => openPanel({ kind: 'word', id: w._id, anchor: e.currentTarget }),
  }, icon('dots-horizontal-rounded', 16));
  return h('li', {
    class: `inline-flex rounded-full border ${w.selected ? '' : 'border-dashed'}`,
    style: { borderColor: color },
  }, [toggle, menu]);
}

function renderWordList() {
  const wrap = $('#word-list');
  const list = words();
  wrap.replaceChildren(...(list.length ? [] : [h('p', { class: 'text-base text-zinc-500', text: t('noWords') })]));
  for (const b of BRANCHES) {
    const branchWords = list.filter((w) => w.branch === b);
    const input = h('input', {
      type: 'text',
      maxlength: '60',
      placeholder: t('addWordPh'),
      'aria-label': `${t('addWord')} (${t(`b_${b}`)})`,
      class: 'field min-w-0 flex-1 self-stretch py-0 text-sm',
    });
    const form = h('form', {
      class: 'mt-2 flex items-center gap-1.5',
      onsubmit: async (e) => {
        e.preventDefault();
        if (await addManualWord(b, input.value)) { input.value = ''; wrap.querySelector(`[data-add="${b}"]`)?.focus(); }
      },
    }, [
      renderBranchMore(h('button', { type: 'button', 'data-branch-more': b, class: 'icon-btn border border-zinc-300', onclick: () => expandBranches([b]) })),
      input,
      h('button', { type: 'submit', class: 'icon-btn border border-zinc-300', 'aria-label': `${t('add')} (${t(`b_${b}`)})`, title: t('add') }, icon('plus', 18)),
    ]);
    input.dataset.add = b;
    const allOn = branchWords.length && branchWords.every((w) => w.selected);
    wrap.append(h('div', {}, [
      h('div', { class: 'flex items-center justify-between gap-2' }, [
        h('h3', { class: 'flex items-center gap-2 text-base font-medium text-zinc-800' }, [
          dot(b),
          t(`b_${b}`),
          h('span', { class: 'text-sm font-normal text-zinc-400', text: `${branchWords.filter((w) => w.selected).length}/${branchWords.length}` }),
        ]),
        branchWords.length ? h('button', {
          type: 'button',
          class: 'btn-ghost py-1 text-sm',
          text: allOn ? t('deselectAll') : t('selectAll'),
          onclick: () => bulkSelect(b, !allOn),
        }) : null,
      ]),
      branchWords.length ? h('ul', { class: 'mt-2 flex flex-wrap gap-1.5' }, branchWords.map(wordChip)) : null,
      form,
    ]));
  }
}

// Bold the first N letters of a word (skipping accents/punctuation when counting).
function partNode(p) {
  const n = (p.letters || '').length;
  let count = 0;
  let cut = 0;
  const text = p.text || '';
  for (let i = 0; i < text.length && count < n; i++) {
    const base = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/[a-z]/i.test(base) || /[œæ]/i.test(text[i])) count++;
    cut = i + 1;
  }
  return h('span', {}, [
    h('strong', { class: 'font-bold', style: { color: COLORS[p.branch] || '#18181b' }, text: text.slice(0, cut) }),
    text.slice(cut),
  ]);
}

// A part as written in the expansion: its connectors (never bold), then the word with its letter(s)
// in bold. A reshaped word shows its graph word on hover ("Autonome ← Autonomie").
function phrasePart(p) {
  const node = partNode({ ...p, text: p.form });
  const bare = (s) => (s || '').toLowerCase().replace(/[^\p{L}]/gu, ''); // "Partage," is not reshaped
  if (bare(p.form) !== bare(p.text)) {
    node.title = `${p.form.replace(/[,;.]+$/, '')} ← ${p.text}`;
    node.className = 'underline decoration-zinc-300 decoration-dotted underline-offset-4';
  }
  if (!p.lead) return [node];
  return [p.lead, /['’]$/.test(p.lead) ? '' : ' ', node];
}

function sortedAcronyms() {
  let list = [...(state.session?.acronyms || [])];
  if (state.filter === 'fav') list = list.filter((a) => a.favorite);
  if (state.filter === 'real') list = list.filter((a) => a.isRealWord);
  const scoreOf = (a) => (a.score ?? -1);
  if (state.sort === 'score') list.sort((a, b) => scoreOf(b) - scoreOf(a) || (b.engineScore || 0) - (a.engineScore || 0));
  if (state.sort === 'length') list.sort((a, b) => a.letters.length - b.letters.length || scoreOf(b) - scoreOf(a));
  if (state.sort === 'newest') list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list;
}

function badge(text, cls) {
  return h('span', { class: `rounded-full px-2 py-0.5 text-xs font-medium ${cls}`, text });
}

// The acronym's domain names (checkDomains), each an icon and its name: none until the first check, or when
// the request failed. The icon and color say free (green, check) or taken (red, cross); screen readers get
// the word.
function domainBadges(a) {
  const d = domains.get(a._id);
  const item = (cls, title, children) => h('span', { class: `inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium ${cls}`, title }, children);
  if (!d?.list.length) return d?.checking ? [item('text-zinc-500', null, [spinner('', 'size-3.5'), t('domainChecking')])] : [];
  const looks = {
    available: ['text-emerald-700', 'check-circle'],
    taken: ['text-red-600', 'x-circle'],
    unknown: ['text-zinc-500', 'help-circle'],
  };
  return d.list.map(({ name, status }) => {
    const [cls, iconName] = looks[status] || looks.unknown;
    return item(cls, t(`domain.${status}Hint`), [icon(iconName, 16), name, h('span', { class: 'sr-only', text: ` ${t(`domain.${status}`)}` })]);
  });
}

function acronymCard(a) {
  // Acronyms from before expansions were written only have their words: show those as a list.
  const phrased = a.parts.every((p) => p.form);
  const expansion = h('p', { class: 'mt-0.5 text-base text-zinc-600' });
  a.parts.forEach((p, i) => {
    if (i) expansion.append(phrased ? ' ' : ' · ');
    expansion.append(...(phrased ? phrasePart(p) : [partNode(p)]));
  });
  const branchesUsed = a.branchCoverage || new Set(a.parts.map((p) => p.branch)).size;
  const domainRow = domainBadges(a);
  const copyValue = `${a.letters} — ${expansion.textContent}`;
  const ids = a.parts.map((p) => p.wordId);
  const scoreCls = a.score == null ? 'bg-zinc-100 text-zinc-400' : a.score >= 70 ? 'bg-emerald-50 text-emerald-700' : a.score >= 40 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
  const li = h('li', {
    class: `rounded-md border bg-white p-3 transition-colors ${a.favorite ? 'border-amber-300 hover:border-amber-500 focus-within:border-amber-500' : 'border-zinc-200 hover:border-cerise-400 focus-within:border-cerise-400'}`,
    onmouseenter: () => graph?.highlight(ids),
    onmouseleave: () => graph?.clearHighlight(),
    onfocusin: () => graph?.highlight(ids),
    onfocusout: () => graph?.clearHighlight(),
  }, [
    h('div', { class: 'flex items-start justify-between gap-2' }, [
      h('p', { class: 'min-w-0 break-all text-2xl font-bold tracking-wide' }, a.parts.map((p) => h('span', { style: { color: COLORS[p.branch] }, text: p.letters }))),
      h('div', { class: 'flex shrink-0 items-center gap-1.5' }, [
        state.newAcronyms.has(a._id) ? badge(t('newAcronym'), 'bg-cerise-50 text-cerise-700') : null,
        h('span', { class: `rounded-md px-1.5 py-0.5 text-sm font-semibold ${scoreCls}`, text: a.score == null ? t('scoreNone') : `${a.score}/100` }),
      ]),
    ]),
    expansion,
    domainRow.length ? h('div', { class: 'mt-1.5' }, [
      h('p', { class: 'text-sm text-zinc-500', text: t('domainAvailability') }),
      // One line; scrolls sideways (no scrollbar) when the names don't fit
      h('div', { class: 'mt-0.5 flex items-center gap-x-3 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' }, domainRow),
    ]) : null,
    a.rationale ? h('p', { class: 'mt-2 text-base text-zinc-700', text: a.rationale }) : null,
    a.tagline ? h('p', { class: 'mt-1 text-base italic text-zinc-500', text: `“${a.tagline}”` }) : null,
    h('div', { class: 'mt-2 flex items-center gap-1' }, [
      h('div', { class: 'flex min-w-0 flex-1 flex-wrap gap-1' }, [
        a.isRealWord ? badge(t('realWord'), 'bg-sky-50 text-sky-700') : badge(t('invented'), 'bg-zinc-100 text-zinc-600'),
        badge(t('branchesCovered', { n: branchesUsed }), 'bg-zinc-100 text-zinc-600'),
        badge(a.source === 'llm' ? 'LLM' : 'dict', 'bg-zinc-50 text-zinc-400'),
      ]),
      h('button', {
        type: 'button',
        'aria-pressed': String(a.favorite),
        'aria-label': `${t('favorite')}: ${a.letters}`,
        title: t('favorite'),
        class: `icon-btn ${a.favorite ? 'text-amber-500' : 'hover:text-amber-500'}`,
        onclick: () => toggleFavorite(a),
      }, icon(a.favorite ? 'star-filled' : 'star', 18)),
      h('button', {
        type: 'button',
        'aria-label': `${t('copy')}: ${a.letters}`,
        title: t('copy'),
        class: 'icon-btn',
        onclick: () => copyText(copyValue),
      }, icon('copy', 18)),
      h('button', {
        type: 'button',
        'aria-label': `${t('delete')}: ${a.letters}`,
        title: t('delete'),
        class: 'icon-btn hover:text-red-600',
        onclick: () => deleteAcronym(a),
      }, icon('trash', 18)),
    ]),
  ]);
  return li;
}

// The way to more: guests sign up (and come back to this session), free users subscribe (not built yet)
function upgradeCta(label, cls) {
  if (state.usage?.plan === 'guest') {
    return h('a', {
      href: '/app/signup',
      class: cls,
      text: label,
      onclick: (e) => { e.currentTarget.href = `/app/signup?next=${encodeURIComponent(location.pathname + location.search)}`; },
    });
  }
  return h('button', { type: 'button', class: cls, text: label, onclick: () => toast(t('subscribeSoon'), 'info') });
}

// Acronyms past this plan's share of each run: the server only says how many
function lockedCard(n) {
  const guest = state.usage?.plan === 'guest';
  return h('li', { class: 'rounded-md border border-dashed border-zinc-300 p-4 text-center' }, [
    h('p', { class: 'flex items-center justify-center gap-1.5 text-sm text-zinc-500' }, [icon('lock', 14), t('lockedAcronyms', { n })]),
    // Secondary: "Generate acronyms" is the panel's one primary button
    upgradeCta(t(guest ? 'signUpToSeeMore' : 'subscribeToSeeMore'), 'btn-ghost mt-3 w-full justify-center border border-zinc-200 py-2.5 font-medium text-zinc-700'),
  ]);
}

function renderAcronyms() {
  const all = state.session?.acronyms || [];
  const list = sortedAcronyms();
  const locked = state.filter === 'all' ? state.session?.lockedAcronyms || 0 : 0;
  checkDomains(list); // first: marks this batch as checking, for the cards below
  const shown = list.filter(domainsChecked);
  // A run's own wait shows on its button; otherwise one line says more cards are coming
  const pending = shown.length < list.length && !state.busy.has('acronyms');
  $('#acronym-list').replaceChildren(
    ...shown.map(acronymCard),
    ...(pending ? [h('li', { class: 'flex items-center justify-center gap-2 py-3 text-sm text-zinc-500' }, [spinner('', 'size-3.5'), t('checkingDomains')])] : []),
    ...(locked ? [lockedCard(locked)] : []),
  );
  renderAcronymEmpty();
  $('#clear-acronyms').disabled = !all.some((a) => !a.favorite) && !state.session?.lockedAcronyms;
  $('#sort').value = state.sort;
  document.querySelectorAll('#filters [data-filter]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
  });
  renderStepsDone();
}

// Hidden while a run fills the list: the button shows the progress
function renderAcronymEmpty() {
  const empty = $('#acronym-empty');
  const shown = sortedAcronyms().length || (state.filter === 'all' && state.session?.lockedAcronyms);
  empty.textContent = state.session?.acronyms?.length ? t('noAcronymsFiltered') : t('noAcronyms');
  show(empty, !shown && !state.busy.has('acronyms'));
}

// A busy button is disabled by its caller; this only swaps its content.
function setButtonBusy(btn, busy, label, busyLabel, iconName = null) {
  btn.replaceChildren(...(busy ? [spinner(), busyLabel] : [iconName ? icon(iconName, 18) : null, label].filter(Boolean)));
  btn.setAttribute('aria-busy', String(busy));
}

// Icon-only "more words" button in a branch's add-word row (Explore step).
function renderBranchMore(btn) {
  const b = btn.dataset.branchMore;
  const own = state.busy.has(`branch:${b}`);
  const label = hasAnswer(b) ? `${t('moreWords')} (${t(`b_${b}`)})` : t('moreWordsNeedAnswer', { min: ANSWER_MIN });
  btn.replaceChildren(own ? spinner() : icon('sparkles', 18));
  btn.setAttribute('aria-busy', String(own));
  btn.setAttribute('aria-label', own ? t('generatingWords') : label);
  btn.title = own ? t('generatingWords') : label;
  btn.disabled = !state.health.llm || own || state.busy.has('words') || !hasAnswer(b);
  return btn;
}

function renderBusy() {
  if (!state.session) return;
  const llm = state.health.llm;
  const wordsBusy = state.busy.has('words');
  const gen = $('#generate-words');
  setButtonBusy(gen, wordsBusy, t(getsAcronyms() ? 'getAcronyms' : 'generateWords'), t('generatingWords'), 'sparkles');
  gen.disabled = !llm || wordsBusy || !BRANCHES.some(hasAnswer) || BRANCHES.some(answerTooShort);

  document.querySelectorAll('[data-branch-more]').forEach(renderBranchMore);
  BRANCHES.forEach(renderReformulate);

  const acr = state.busy.has('acronyms');
  const btn = $('#generate-acronyms');
  setButtonBusy(btn, acr, t('generateAcronyms'), t(state.busy.has('acronymDomains') ? 'checkingDomains' : 'generatingAcronyms'), 'sparkles');
  btn.disabled = !llm || acr || !words().some((w) => w.selected) || runsLeft() === 0;
  renderAcronymEmpty();
  renderUsage();
  renderPeekAction();
  if (state.panel) renderPanel();
}

// ---------------------------------------------------------------------------
// AI usage: runs left in the plan's window (services/usage.js), and what the plan includes

let usageTimer = null;

const usageOpen = () => !!state.usage?.resetAt && new Date(state.usage.resetAt) > Date.now();
const runsLeft = () => (state.usage ? Math.max(0, state.usage.runs.limit - (usageOpen() ? state.usage.runs.used : 0)) : Infinity);
// The open session's reformulations left in the window (0 for guests, or before the usage is known)
const reformulationsLeft = () => {
  const r = state.usage?.reformulations;
  return r ? Math.max(0, r.limit - (usageOpen() ? r.used[state.session?._id] || 0 : 0)) : 0;
};
const resetTime = () => (usageOpen() ? new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(new Date(state.usage.resetAt)) : '');

// "1 of 2 runs left · resets at 14:30" under Generate acronyms. With none left, the button waits for the reset.
function renderUsage() {
  const line = $('#usage-runs');
  const u = state.usage;
  clearTimeout(usageTimer);
  show(line, !!u);
  if (!u) return;
  const open = usageOpen();
  if (open) usageTimer = setTimeout(renderBusy, new Date(u.resetAt) - Date.now() + 1000); // the window ends on its own
  const left = runsLeft();
  const time = resetTime();
  line.replaceChildren(left ? t(open ? 'runsLeftReset' : 'runsLeft', { left, limit: u.runs.limit, time }) : t('runsNone', { time }));
  if (!left && u.plan !== 'paid') {
    line.append(' · ', upgradeCta(t(u.plan === 'guest' ? 'signUpForRuns' : 'subscribeForRuns'), 'font-medium text-cerise-600 hover:underline'));
  }
  for (const [id, allowed] of [['real-only', u.realWords], ['chunks', u.chunks]]) {
    const box = $(`#${id}`);
    box.disabled = !allowed;
    if (!allowed) box.checked = false;
    show($(`#${id}-plan`), !allowed);
  }
}

// ---------------------------------------------------------------------------
// Workflow panel: steps, settings, minimize, peek action

function setStep(step) {
  state.step = step;
  if (step !== 'acronyms') toggleOptions(false);
  renderStep();
}

function renderStep() {
  document.querySelectorAll('#steps [data-step]').forEach((tab) => {
    const on = tab.dataset.step === state.step;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('[data-step-panel]').forEach((p) => show(p, p.dataset.stepPanel === state.step));
  show($('#wf-footer'), !!state.session && state.step !== 'describe');
  renderStepsDone();
  renderPeekAction();
}

// A step is done once it has produced something: words for Describe, acronyms for Explore.
// Acronyms is the last step, so it never shows as done.
function renderStepsDone() {
  const done = { describe: words().length > 0, explore: !!state.session?.acronyms?.length, acronyms: false };
  document.querySelectorAll('#steps [data-step]').forEach((tab) => {
    const on = done[tab.dataset.step];
    tab.dataset.done = String(on);
    tab.querySelector('.step-status').textContent = on ? ` (${t('stepDone')})` : '';
  });
}

// Mobile peek: the current step's primary action, as an icon button in the sheet header.
function renderPeekAction() {
  const btn = $('#peek-action');
  if (!state.session) return;
  const describe = state.step === 'describe';
  const source = describe ? $('#generate-words') : $('#generate-acronyms');
  const busy = describe ? state.busy.has('words') : state.busy.has('acronyms');
  const label = t(!describe ? 'generateAcronyms' : getsAcronyms() ? 'getAcronyms' : 'generateWords');
  btn.replaceChildren(busy ? spinner() : icon('sparkles', 20));
  btn.disabled = source.disabled;
  btn.setAttribute('aria-busy', String(busy));
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function onPeekAction() {
  if (state.step === 'describe') $('#generate-words').click();
  else $('#acronym-form').requestSubmit();
}

// Acronym options dropdown: floats over the list. Closed by Escape, a click outside, or tabbing out of it.
function toggleOptions(open = $('#options-menu').hidden) {
  show($('#options-menu'), open);
  $('#options-btn').setAttribute('aria-expanded', String(open));
}

// Profile popup (signed-in users only; guests get a plain link to the login page)
function toggleAccount(open = $('#account-menu').hidden) {
  show($('#account-menu'), open);
  $('#account-btn').setAttribute('aria-expanded', String(open));
  if (open) $('#account-menu button').focus();
}

const panelMinimized = () => $('#workflow').dataset.min === 'true';

function renderMinimize() {
  const min = panelMinimized();
  const btn = $('#wf-min');
  const label = min ? t('expandPanel') : t('minimize');
  btn.replaceChildren(icon(min ? 'chevrons-down' : 'chevrons-up', 20));
  btn.setAttribute('aria-expanded', String(!min));
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function setMinimized(min) {
  $('#workflow').dataset.min = String(min);
  prefs.set('ui.panelMin', min ? '1' : '0');
  renderMinimize();
  updateVisible();
}

// ---------------------------------------------------------------------------
// Canvas visible area (canvas minus the workflow panel / sheet)

function visibleRect() {
  const stage = $('#stage');
  const w = stage.clientWidth;
  const hgt = stage.clientHeight;
  if (isDesktop()) {
    if (panelMinimized()) return { x: 0, y: 0, w, h: hgt };
    const wf = $('#workflow');
    const left = wf.offsetLeft + wf.offsetWidth;
    return { x: left, y: 0, w: Math.max(0, w - left), h: hgt };
  }
  const top = $('#topbar').offsetHeight;
  return { x: 0, y: top, w, h: Math.max(0, hgt - top - sheet.height) };
}

function updateVisible({ refit = true } = {}) {
  const r = visibleRect();
  Object.assign($('#canvas-empty').style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, right: 'auto', bottom: 'auto' });
  if (refit) graph?.visibleChanged({ animate: true });
}

// ---------------------------------------------------------------------------
// Mobile bottom sheet (peek / half / full)

const sheet = { snap: 'peek', height: 0, drag: null, ignoreClickUntil: 0 };
let safeBottom = 0;

function measureSafeBottom() {
  const probe = h('div', { style: { position: 'fixed', visibility: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' } });
  document.body.append(probe);
  safeBottom = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
}

function snapHeights() {
  const vh = window.innerHeight;
  // Peek shows the header: title row, plus the language/model row when a session is open
  return { peek: 96 + $('#session-meta').offsetHeight + safeBottom, half: Math.round(vh * 0.5), full: Math.round(vh * 0.9) };
}

function applySheetHeight(px, { animate = true, refit = true } = {}) {
  sheet.height = px;
  $('#workflow').classList.toggle('sheet-anim', animate);
  document.documentElement.style.setProperty('--sheet-h', `${px}px`);
  updateVisible({ refit });
}

function setSheet(snap, { animate = true } = {}) {
  sheet.snap = snap;
  applySheetHeight(snapHeights()[snap], { animate });
}

const SNAPS = ['peek', 'half', 'full'];

function cycleSheet() {
  setSheet(SNAPS[(SNAPS.indexOf(sheet.snap) + 1) % SNAPS.length]);
}

function bindSheet() {
  const handle = $('#sheet-handle');
  handle.addEventListener('pointerdown', (e) => {
    if (isDesktop()) return;
    handle.setPointerCapture(e.pointerId);
    sheet.drag = { y: e.clientY, h: sheet.height, moved: false };
  });
  handle.addEventListener('pointermove', (e) => {
    const d = sheet.drag;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 4) d.moved = true;
    if (!d.moved) return;
    const { peek, full } = snapHeights();
    applySheetHeight(Math.min(full, Math.max(peek, d.h + dy)), { animate: false, refit: false });
  });
  const end = (cancelled) => {
    const d = sheet.drag;
    if (!d) return;
    sheet.drag = null;
    sheet.ignoreClickUntil = Date.now() + 400;
    if (!d.moved) { if (!cancelled) cycleSheet(); return; }
    const hs = snapHeights();
    const nearest = Object.keys(hs).sort((a, b) => Math.abs(hs[a] - sheet.height) - Math.abs(hs[b] - sheet.height))[0];
    setSheet(nearest);
  };
  handle.addEventListener('pointerup', () => end(false));
  handle.addEventListener('pointercancel', () => end(true));
  // Keyboard activation (pointer taps are handled above).
  handle.addEventListener('click', () => { if (Date.now() > sheet.ignoreClickUntil) cycleSheet(); });
}

// ---------------------------------------------------------------------------
// Floating action panel (node popover)

function openPanel({ kind, id, anchor = null }) {
  state.panel = { kind, id, anchor, mode: 'menu' };
  graph?.setActive(kind === 'word' ? id : `b-${id}`);
  renderPanel();
  const first = $('#panel').querySelector('button, input');
  first?.focus({ preventScroll: true });
}

function closePanel() {
  if (!state.panel) return;
  const anchor = state.panel.anchor;
  state.panel = null;
  graph?.setActive(null);
  show($('#panel'), false);
  if (anchor && document.body.contains(anchor)) anchor.focus({ preventScroll: true });
}

const PANEL_ROW = 'flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left text-base';

function panelButton(text, iconName, onclick, { danger = false, disabled = false } = {}) {
  return h('button', {
    type: 'button',
    disabled,
    class: `${PANEL_ROW} ${danger ? 'text-red-600 enabled:hover:bg-red-50' : 'text-zinc-800 enabled:hover:bg-zinc-100'}`,
    onclick,
  }, [icon(iconName, 18, danger ? '' : 'text-zinc-500'), text]);
}

function panelBusyButton(text, iconName, busyText, busy, disabled, onclick) {
  return h('button', {
    type: 'button',
    disabled: disabled || busy,
    'aria-busy': String(busy),
    class: `${PANEL_ROW} text-zinc-800 enabled:hover:bg-zinc-100`,
    onclick,
  }, busy ? [spinner('text-cerise-600'), busyText] : [icon(iconName, 18, 'text-zinc-500'), text]);
}

function panelInput(value, placeholder, onSubmit) {
  const input = h('input', {
    type: 'text',
    maxlength: '60',
    placeholder,
    'aria-label': placeholder,
    class: 'field min-w-0 flex-1 py-1.5',
  });
  input.value = value;
  return h('form', {
    class: 'flex gap-1.5 p-1',
    onsubmit: (e) => { e.preventDefault(); onSubmit(input.value); },
  }, [input, h('button', { type: 'submit', class: 'btn-primary px-3 py-1.5 text-sm', text: t('save') })]);
}

function panelHeader(branch, text) {
  return h('p', { class: 'flex items-center gap-2 px-2 pb-1.5 pt-1 font-semibold text-zinc-900' }, [
    dot(branch),
    h('span', { class: 'truncate', text }),
  ]);
}

function renderPanel() {
  const panel = $('#panel');
  const p = state.panel;
  if (!p || !state.session) { show(panel, false); return; }
  const llm = state.health.llm;
  let content;
  let rect;

  if (p.kind === 'word') {
    const w = wordById(p.id);
    if (!w) { closePanel(); return; }
    const busy = state.busy.has(`word:${w._id}`);
    const header = panelHeader(w.branch, w.text);
    if (p.mode === 'rename') {
      content = [header, panelInput(w.text, t('rename'), async (v) => {
        if (v.trim() && v.trim() !== w.text) await patchWord(w._id, { text: v.trim() });
        p.mode = 'menu';
        renderPanel();
      })];
    } else {
      content = [
        header,
        panelButton(w.selected ? t('deselect') : t('select'), w.selected ? 'checkbox' : 'checkbox-checked', () => patchWord(w._id, { selected: !w.selected })),
        panelButton(t('rename'), 'edit', () => { p.mode = 'rename'; renderPanel(); $('#panel input')?.select(); }),
        panelBusyButton(t('expand'), 'git-branch', llmBusyMessage('expanding'), busy, !llm, () => expandWord(w._id)),
        panelButton(t('delete'), 'trash', () => deleteWord(w._id), { danger: true }),
      ];
    }
    rect = p.anchor && document.body.contains(p.anchor) ? p.anchor.getBoundingClientRect() : graph?.nodeClientRect(w._id);
  } else {
    const b = p.id;
    const busy = state.busy.has(`branch:${b}`) || state.busy.has('words');
    const branchWords = words().filter((w) => w.branch === b);
    const header = panelHeader(b, t(`q_${b}`));
    if (p.mode === 'add') {
      content = [header, panelInput('', t('addWordPh'), async (v) => {
        if (await addManualWord(b, v)) { renderPanel(); $('#panel input')?.focus(); }
      })];
    } else {
      content = [
        header,
        panelBusyButton(t('moreWords'), 'sparkles', llmBusyMessage('generatingWords'), state.busy.has(`branch:${b}`), !llm || busy || !hasAnswer(b), () => expandBranches([b])),
        panelButton(t('addWord'), 'plus', () => { p.mode = 'add'; renderPanel(); $('#panel input')?.focus(); }),
        panelButton(t('selectAll'), 'check-square', () => bulkSelect(b, true), { disabled: !branchWords.length }),
        panelButton(t('deselectAll'), 'square', () => bulkSelect(b, false), { disabled: !branchWords.length }),
      ];
    }
    rect = graph?.nodeClientRect(`b-${b}`);
  }

  panel.replaceChildren(...content);
  panel.setAttribute('aria-label', p.kind === 'word' ? t('wordMenu') : t(`b_${p.id}`));
  show(panel, true);

  // Mobile: action sheet anchored above the workflow sheet.
  if (!isDesktop()) {
    Object.assign(panel.style, { left: '0.5rem', right: '0.5rem', top: 'auto', bottom: `${sheet.height + 8}px`, width: 'auto' });
    return;
  }
  Object.assign(panel.style, { right: 'auto', bottom: 'auto', width: '' });
  if (!rect) return;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = rect.right + 8;
  if (left + pw > vw - 8) left = Math.max(8, rect.left - pw - 8);
  let top = rect.top;
  if (top + ph > vh - 8) top = Math.max(8, vh - ph - 8);
  panel.style.left = `${Math.max(8, left)}px`;
  panel.style.top = `${Math.max(8, top)}px`;
}

// ---------------------------------------------------------------------------
// Sidebar: drawer below lg, collapsible column at lg+

function openDrawer() {
  $('#sidebar').classList.remove('-translate-x-full');
  show($('#drawer-backdrop'), true);
}

function closeDrawer() {
  $('#sidebar').classList.add('-translate-x-full');
  show($('#drawer-backdrop'), false);
}

function initSidebar() {
  const saved = prefs.get('ui.sidebar');
  const expanded = saved ? saved === 'expanded' : window.matchMedia('(min-width: 80rem)').matches;
  $('#app').dataset.sidebar = expanded ? 'expanded' : 'collapsed';
  const min = prefs.get('ui.panelMin') === '1';
  $('#workflow').dataset.min = String(min);
}

function setSidebar(expanded) {
  $('#app').dataset.sidebar = expanded ? 'expanded' : 'collapsed';
  prefs.set('ui.sidebar', expanded ? 'expanded' : 'collapsed');
  syncPanel();
  (expanded ? $('#sidebar-collapse') : $('#drawer-open')).focus();
}

// ---------------------------------------------------------------------------
// Wiring

function bindStatic() {
  $('#new-session').addEventListener('click', createSession);
  $('#session-search-btn').addEventListener('click', () => setSessionSearch($('#session-search-row').hidden));
  $('#session-search-close').addEventListener('click', () => { setSessionSearch(false); $('#session-search-btn').focus(); });
  $('#session-search').addEventListener('input', (e) => { state.sessionQuery = e.target.value; renderSessions(); });
  $('#session-search').addEventListener('keydown', (e) => {
    // Enter opens the top match; Escape closes the search without closing the drawer
    if (e.key === 'Enter') { e.preventDefault(); $('#session-list li > button')?.click(); }
    if (e.key === 'Escape') { e.stopPropagation(); setSessionSearch(false); $('#session-search-btn').focus(); }
  });
  $('#drawer-open').addEventListener('click', () => (isDesktop() ? setSidebar(true) : openDrawer()));
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#sidebar-collapse').addEventListener('click', () => setSidebar(false));
  $('#wf-min').addEventListener('click', () => setMinimized(!panelMinimized()));
  $('#account-btn')?.addEventListener('click', () => toggleAccount());
  // Come back to the same session after logging in
  $('#account-login')?.addEventListener('click', (e) => {
    e.currentTarget.href = `/app/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  });
  $('#peek-action').addEventListener('click', onPeekAction);
  bindSheet();

  const tabs = [...document.querySelectorAll('#steps [data-step]')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => setStep(tab.dataset.step));
    tab.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      setStep(next.dataset.step);
      next.focus();
    });
  });

  // Clearing the title hands it back to the "who" placeholder.
  $('#title').addEventListener('input', (e) => {
    const title = e.target.value;
    state.session.title = title;
    state.session.titleSource = title.trim() ? 'user' : 'auto';
    renderGraphLabels();
    queueSave({ title, titleSource: state.session.titleSource });
  });

  $('#language').addEventListener('change', (e) => {
    const lang = e.target.value;
    state.session.language = lang;
    state.langHint = words().length > 0;
    queueSave({ language: lang });
    renderBanners();
  });

  $('#model').addEventListener('change', (e) => {
    state.session.model = e.target.value;
    queueSave({ model: e.target.value });
    warmup();
  });

  $('#banner-lang-close').addEventListener('click', () => { state.langHint = false; renderBanners(); });
  document.querySelectorAll('.banner-retry').forEach((b) => b.addEventListener('click', async () => {
    await recheckHealth();
    if (!state.health.db || !state.health.llm) toast(state.health.db ? llmDownText() : t('dbDown'));
  }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.health.db) recheckHealth(); });

  $('#generate-words').addEventListener('click', onGenerateWords);

  document.querySelectorAll('[data-graph]').forEach((b) => b.addEventListener('click', () => {
    if (!graph) return;
    closePanel();
    const action = b.dataset.graph;
    if (action === 'fit') graph.fit();
    if (action === 'zoom-in') graph.zoom(1.25);
    if (action === 'zoom-out') graph.zoom(0.8);
    if (action === 'relayout') graph.relayout();
  }));

  $('#acronym-form').addEventListener('submit', (e) => { e.preventDefault(); generateAcronyms(); });
  $('#options-btn').addEventListener('click', () => toggleOptions());
  // Tabbing past the last option would land under the menu (sort, filters): close it
  $('#acronym-options').addEventListener('focusout', (e) => {
    if (e.relatedTarget && !$('#acronym-options').contains(e.relatedTarget)) toggleOptions(false);
  });
  $('#per-branch').addEventListener('change', renderPerBranchHint);
  $('#chunks').addEventListener('change', renderPerBranchHint);
  $('#real-only').addEventListener('change', renderPerBranchHint);
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderAcronyms(); });
  document.querySelectorAll('#filters [data-filter]').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderAcronyms(); }));
  $('#clear-acronyms').addEventListener('click', clearAcronyms);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#account-menu') && !$('#account-menu').hidden) { toggleAccount(false); $('#account-btn').focus(); return; }
    if (!$('#options-menu').hidden) { toggleOptions(false); $('#options-btn').focus(); return; }
    if (state.panel) { closePanel(); return; }
    closeDrawer();
    if (!isDesktop() && sheet.snap !== 'peek') setSheet('peek');
  });
  document.addEventListener('pointerdown', (e) => {
    if ($('#account-menu') && !$('#account-menu').hidden && !e.target.closest('#account-menu, #account-btn')) toggleAccount(false);
    if (!$('#options-menu').hidden && !e.target.closest('#acronym-options')) toggleOptions(false);
    if (!state.panel) return;
    const panel = $('#panel');
    if (panel.contains(e.target) || e.target.closest('#graph') || state.panel.anchor?.contains(e.target)) return;
    closePanel();
  });

  // Canvas area resizes (viewport, sidebar collapse): resize Cytoscape and refit if untouched.
  new ResizeObserver(() => {
    if (!isDesktop() && !sheet.drag) applySheetHeight(snapHeights()[sheet.snap], { animate: false, refit: false });
    updateVisible();
  }).observe($('#stage'));
  mqDesktop.addEventListener('change', () => { closePanel(); closeDrawer(); syncPanel(); updateVisible(); });
  window.addEventListener('resize', () => closePanel());

  window.addEventListener('popstate', () => {
    const id = sessionIdFromUrl();
    if (id && id !== state.session?._id) openSession(id, { push: false });
  });
  $('#graph').addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('beforeunload', () => {
    if (!pendingPatch) return;
    fetch(`/api/sessions/${pendingPatch.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingPatch.body),
      keepalive: true,
    });
  });
}

async function boot({ skipHealth = false } = {}) {
  if (!skipHealth) await checkHealth();
  await Promise.all([loadModels(), loadSessions()]);
  await offerGuestSessions(); // before opening one: the address may point at a guest session about to move
  const id = sessionIdFromUrl() || state.sessions[0]?._id;
  if (id && state.health.db) {
    await openSession(id, { push: false });
    if (!sessionIdFromUrl() && state.session) setUrl(state.session._id, true);
  } else {
    renderAll({ resetGraph: true });
    warmup();
  }
  booted = true;
  syncPanel();
}

initSidebar();
measureSafeBottom();
setSheet('peek', { animate: false });
applyStatic();
renderMinimize();
bindStatic();
boot();
