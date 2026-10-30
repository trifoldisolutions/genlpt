// Letter normalization shared by the engine, dictionary and API.

const LIGATURES = { 'Œ': 'OE', 'œ': 'oe', 'Æ': 'AE', 'æ': 'ae', 'ß': 'ss' };

function stripAccents(text) {
  return String(text || '')
    .replace(/[ŒœÆæß]/g, (c) => LIGATURES[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// "Équipe" → "EQUIPE"; keeps A–Z only.
function normalizeLetters(text) {
  return stripAccents(text).toUpperCase().replace(/[^A-Z]/g, '');
}

// Case- and accent-insensitive key used to dedupe words.
function wordKey(text) {
  return stripAccents(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Key for "the same idea": wordKey plus a light singular, so "Acronyms" = "Acronym" and
// "Full Names" = "Full Name" ("Process", "Bus" stay as they are).
function conceptKey(text) {
  return wordKey(text).split(' ').map((t) => (t.length > 3 && /[sx]$/.test(t) && !/ss$/.test(t) ? t.slice(0, -1) : t)).join(' ');
}

// Connectors (articles, prepositions, conjunctions) never carry an acronym letter.
// Compared lowercase with accents kept, so "Sûr" is not "sur".
const CONNECTORS = {
  fr: new Set([
    'le', 'la', 'les', "l'", 'un', 'une', 'des', 'du', 'de', "d'", 'au', 'aux', 'à',
    'en', 'dans', 'par', 'pour', 'sur', 'sous', 'avec', 'sans', 'chez', 'entre', 'contre', 'selon', 'parmi', 'dès',
    'et', 'ou', 'où', 'ni', 'que', "qu'", 'qui', 'dont',
    "s'", "n'", "c'", "j'", "m'", "t'", "jusqu'", "lorsqu'", "puisqu'",
  ]),
  en: new Set([
    'a', 'an', 'the', 'of', 'and', 'or', 'nor', 'for', 'to', 'in', 'on', 'at', 'by',
    'with', 'from', 'into', 'onto', 'upon', 'per', 'as',
  ]),
  // "y"/"o" become "e"/"u" before an i-/o- sound ("Ciencia e Innovación"); "del" and "al" are de/a + el
  es: new Set([
    'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'del', 'al',
    'a', 'ante', 'con', 'contra', 'de', 'desde', 'durante', 'en', 'entre', 'hacia', 'hasta', 'mediante',
    'para', 'por', 'según', 'sin', 'sobre', 'tras', 'como',
    'y', 'e', 'o', 'u', 'ni', 'que', 'quien', 'donde',
  ]),
  // The definite article follows its noun ("lekòl la", "machin nan"); yo marks the plural. Left out on purpose,
  // as they are also nouns: men (hand), san (blood), kont (story), pa (step), kote (place), lakay (home).
  ht: new Set([
    'la', 'a', 'an', 'lan', 'nan', 'yo', 'yon', 'on',
    'pou', 'sou', 'ak', 'avèk', 'avè', 'de', 'anba', 'ant', 'pandan', 'depi', 'jiska', 'pami', 'selon', 'apre', 'anvan', 'kòm',
    'e', 'epi', 'oswa', 'ou', 'ni', 'ki', 'ke',
  ]),
};

// Coordinators only join items of a list: "A, B et C" is an enumeration, not a name.
const COORDINATORS = {
  fr: new Set(['et', 'ou', 'où', 'ni']),
  en: new Set(['and', 'or', 'nor']),
  es: new Set(['y', 'e', 'o', 'u', 'ni']),
  ht: new Set(['ak', 'e', 'epi', 'oswa', 'ou', 'ni']),
};

const FR_ELISION = /^((?:jusqu|lorsqu|puisqu|qu|[ldsncjmt])['’])(.+)$/i;

// Splits on spaces, and French elisions off their word: "l'Unité" → ["l'", "Unité"].
function splitTokens(text, language = 'fr') {
  const out = [];
  for (const raw of String(text || '').trim().split(/\s+/)) {
    if (!raw) continue;
    const m = language === 'fr' ? raw.match(FR_ELISION) : null;
    if (m) out.push(m[1], m[2]);
    else out.push(raw);
  }
  return out;
}

const connectorKey = (token) => String(token || '').toLowerCase().replace(/’/g, "'").replace(/^[^\p{L}']+|[^\p{L}']+$/gu, '');

function isConnector(token, language = 'fr') {
  return (CONNECTORS[language] || CONNECTORS.fr).has(connectorKey(token));
}

function isCoordinator(token, language = 'fr') {
  return (COORDINATORS[language] || COORDINATORS.fr).has(connectorKey(token));
}

// Letters a word can contribute, from its first word that isn't a connector
// ("Flux vidéo" → F / FL, "L'Équipe" → E). A word made only of connectors contributes nothing.
function initials(text, language = 'fr') {
  const first = splitTokens(text, language)
    .flatMap((t) => t.split(/[-–—]+/))
    .find((w) => normalizeLetters(w) && !isConnector(w, language)) || '';
  const letters = normalizeLetters(first);
  return {
    one: letters.slice(0, 1) || null,
    two: letters.length >= 2 ? letters.slice(0, 2) : null,
  };
}

// Trim, drop empty/too long items, dedupe (by conceptKey) against each other and an existing key set.
function cleanWordList(items, existingKeys = new Set(), maxLen = 60) {
  const seen = new Set(existingKeys);
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (typeof raw !== 'string') continue;
    const text = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-•*\d.)]+/, '').trim();
    if (!text || text.length > maxLen || !normalizeLetters(text)) continue;
    const key = conceptKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text.charAt(0).toLocaleUpperCase() + text.slice(1));
  }
  return out;
}

// LLM title → at most maxWords words, without quotes, trailing punctuation or a dangling connector ("… pour les").
function cleanTitle(raw, language = 'fr', maxWords = 5) {
  if (typeof raw !== 'string') return '';
  const words = raw.replace(/["«»“”]/g, ' ').replace(/^[\s'‘’]+|[\s'‘’]+$/g, '').split(/\s+/).filter(Boolean).slice(0, maxWords);
  while (words.length && isConnector(words[words.length - 1], language)) words.pop();
  const title = words.join(' ').replace(/[\s.,;:!?…–—-]+$/, '');
  if (!normalizeLetters(title) || title.length > 120) return '';
  return title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

module.exports = { CONNECTORS, stripAccents, normalizeLetters, wordKey, conceptKey, splitTokens, isConnector, isCoordinator, initials, cleanWordList, cleanTitle };
