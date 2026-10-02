// UI strings for the tool page. The UI is English-only; the session language only steers the LLM.

export const BRANCHES = ['who', 'what', 'how', 'why'];

export const COLORS = {
  who: '#6366f1',
  what: '#10b981',
  how: '#f59e0b',
  why: '#0ea5e9',
};

const STRINGS = {
  sessions: 'Sessions',
  newSession: 'New session',
  untitled: 'Untitled session',
  rename: 'Rename',
  delete: 'Delete',
  save: 'Save',
  cancel: 'Cancel',
  confirmDeleteSession: 'Delete the session “{title}”? This cannot be undone.',
  noSessions: 'No sessions yet.',
  emptyTitle: 'Your ideas, mapped.',
  emptyBody: 'Answer four questions. Your words branch out here, and the acronyms hiding in them follow.',
  mapTitle: 'Your map starts here.',
  mapBody: 'Generate words to watch them branch out.',
  intro: 'Create a session to begin.',
  noSession: 'No session',
  openSessions: 'Open menu',
  closeSessions: 'Close',
  collapseSidebar: 'Hide menu',
  settings: 'Settings',
  account: 'Account',
  guest: 'Guest',
  logIn: 'Log in',
  logOut: 'Log out',
  minimize: 'Minimize',
  expandPanel: 'Expand',
  resizeSheet: 'Resize panel',
  steps: 'Steps',
  stepDone: 'done',
  mapControls: 'Map controls',
  sessionActions: 'Actions',
  titleLabel: 'Session title',
  language: 'Language',
  model: 'Model',
  saving: 'Saving…',
  saved: 'Saved',
  saveError: 'Save failed',
  llmDown: 'Local LLM unavailable (Ollama). You can still add words by hand.',
  llmDownOpenRouter: 'OpenRouter unavailable: check OPENROUTER_API_KEY in .env and your credits. You can still add words by hand.',
  dbDown: 'Database unavailable (MongoDB). Nothing is saved.',
  retry: 'Retry',
  modelLoading: 'Loading model… up to a minute.',
  langHint: 'New words will be in {lang}. Existing words stay.',
  lang_fr: 'French',
  lang_en: 'English',
  dismiss: 'Dismiss',
  step1: 'Describe',
  step1Help: 'Empty answers are skipped. Others need at least 100 characters, not counting spaces.',
  answerMin: '{n}/{min} characters min.',
  step2: 'Explore',
  step2Help: 'Click to select · right-click or long-press for the menu.',
  step3: 'Acronyms',
  q_who: 'Who or what is it?',
  q_what: 'What does it do?',
  q_how: 'How does it work?',
  q_why: 'Why does it exist? What problem does it solve?',
  ph_who: 'e.g. A mobile app for local farmers',
  ph_what: 'e.g. Connects farmers directly with nearby buyers',
  ph_how: 'e.g. A marketplace with automatically planned delivery routes',
  ph_why: 'e.g. Cut out middlemen so farmers earn more and food travels less',
  b_who: 'Who',
  b_what: 'What',
  b_how: 'How',
  b_why: 'Why',
  project: 'Project',
  generateWords: 'Generate words',
  moreWords: 'More words',
  moreWordsNeedAnswer: 'More words: the answer needs at least {min} characters',
  regenerate: 'More words',
  generatingWords: 'Generating words…',
  loadingCold: 'Loading the model — the first request can take up to a minute.',
  wordsAdded: '{n} word(s) added.',
  noNewWords: 'No new words (all already present).',
  branchFailed: 'Failed for “{branch}”: {message}',
  fit: 'Fit',
  zoomIn: 'Zoom +',
  zoomOut: 'Zoom −',
  relayout: 'Re-layout',
  selectAll: 'Select all',
  deselectAll: 'Deselect all',
  selectedCount: '{n} word(s) selected',
  wordList: 'Word list',
  noWords: 'No words yet. Generate some or add them by hand.',
  addWord: 'Add word',
  addWordPh: 'New word',
  add: 'Add',
  expand: 'Expand',
  expanding: 'Finding related words…',
  select: 'Select',
  deselect: 'Deselect',
  wordMenu: 'Word actions',
  minLength: 'Min length',
  maxLength: 'Max length',
  realWordsOnly: 'Real words only',
  allowChunks: 'Allow letter chunks (ACROKEY = Acronyms from Keywords)',
  perBranch: 'Words per branch',
  perBranchHint: '{n} word(s) max per branch → {max} letters max.',
  perBranchHintChunks: '{n} word(s) max per branch; a word can give several letters.',
  generateAcronyms: 'Generate acronyms',
  generatingAcronyms: 'Finding and ranking acronyms…',
  acronymsAdded: '{n} new acronym(s).',
  noNewAcronyms: 'No new acronyms found. Try other words or settings.',
  sortBy: 'Sort by',
  sortScore: 'Score',
  sortLength: 'Length',
  sortNewest: 'Newest',
  filterAll: 'All',
  filterFav: 'Favorites',
  filterReal: 'Real words',
  clearNonFav: 'Clear non-favorites',
  confirmClear: 'Delete all non-favorite acronyms?',
  noAcronyms: 'No acronyms yet. Select words, then generate.',
  noAcronymsFiltered: 'No acronyms match this filter.',
  realWord: 'Real word',
  invented: 'Invented',
  branchesCovered: '{n}/4 branches',
  favorite: 'Favorite',
  copy: 'Copy',
  copied: 'Copied!',
  paste: 'Paste',
  pasteFailed: 'Couldn’t read the clipboard. Paste with Ctrl+V instead.',
  scoreNone: 'unscored',
  confirmDeleteWord: 'Delete “{word}” and its child words?',
  lengthError: 'Min length must be ≤ max length (between 2 and 8).',
  errors: {
    database_unavailable: 'Database unavailable.',
    llm_unavailable: 'Local LLM unavailable — is Ollama running?',
    llm_unavailable_openrouter: 'OpenRouter unavailable — check OPENROUTER_API_KEY in .env and your credits.',
    llm_timeout: 'The model took too long to answer.',
    llm_error: 'Model error.',
    invalid_json: 'The model returned an unreadable answer. Try again.',
    not_enough_words: 'Not enough selected words for this minimum length.',
    length_unreachable: 'Minimum length is out of reach with this words-per-branch limit. Lower the min length, allow letter chunks, or allow more words per branch.',
    no_answers: 'Answer at least one question first.',
    answer_too_short: 'Each answer needs at least 100 characters (not counting spaces).',
    word_limit: 'This session reached its 400-word limit.',
    acronym_limit: 'This session reached its 500-acronym limit. Clear non-favorites.',
    duplicate_word: 'This word already exists in that branch.',
    session_not_found: 'Session not found.',
    word_not_found: 'Word not found.',
    acronym_not_found: 'Acronym not found.',
    invalid_text: 'A word must be 1–60 characters.',
    network: 'Cannot reach the server.',
    generic: 'Something went wrong.',
  },
};

export function t(key, vars = {}) {
  const value = key.split('.').reduce((o, k) => (o ? o[k] : undefined), STRINGS);
  const str = typeof value === 'string' ? value : key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// Some messages depend on the LLM provider (ollama | openrouter), set from /api/health.
let provider = 'ollama';
export function setProvider(name) {
  provider = name || 'ollama';
}

export function llmDownText() {
  return t(provider === 'openrouter' ? 'llmDownOpenRouter' : 'llmDown');
}

export function errorText(err) {
  const code = err?.code;
  const known = code && (STRINGS.errors[`${code}_${provider}`] || STRINGS.errors[code]);
  return known || err?.message || STRINGS.errors.generic;
}

// Fill static elements: data-i18n (text), data-i18n-ph (placeholder), data-i18n-aria / data-i18n-title.
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
