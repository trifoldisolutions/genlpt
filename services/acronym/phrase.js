// Validates an LLM-written name ("Régie Autonome des Transports Parisiens") against the acronym's
// parts. Every letter comes from a selected word, in order, possibly reshaped; connectors never
// carry a letter; no other word may be added; a keyword list or an enumeration is not a name.
const { normalizeLetters, splitTokens, isConnector, isCoordinator } = require('./normalize');

const ROOT_LETTERS = 3; // a reshaped word keeps this many leading letters of the original
// From this many letter-carrying words, a name needs a preposition or article linking a head to its
// complements: without one it is a keyword list ("Outil Partage Unité Simplicité") or an enumeration
// ("Vitalité, Engagement, Lien et Événements"). Spanish links with de/para like French; English stacks nouns
// more readily ("International Business Machines"). Haitian Creole puts a possessor right after its noun, with
// no linking word ("Bank Repiblik Ayiti"), so a noun chain is grammatical there.
const CONNECTOR_NEEDED_FROM = { fr: 3, en: 4, es: 3, ht: 5 };

// Connectors and letterless tokens ("&", "–") carry no letter.
const isFiller = (token, language) => !normalizeLetters(token) || isConnector(token, language);
const sameRoot = (token, original) => normalizeLetters(token).startsWith(normalizeLetters(original).slice(0, ROOT_LETTERS));
// A reshaped word must be a real word ("Bénovoles" is not); a graph word used as is always passes.
const spelledOk = (token, original, isWord) => !isWord
  || normalizeLetters(token) === normalizeLetters(original)
  || token.split(/[-–—]+/).filter((s) => normalizeLetters(s)).every((s) => isWord(s));

// Joins tokens, without a space after an elision ("l'" + "Unité" → "l'Unité").
function joinTokens(tokens) {
  return tokens.reduce((s, t) => (s ? s + (/['’]$/.test(s) ? '' : ' ') + t : t), '');
}

const capitalize = (s) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

// parts: [{ text, letters, … }] in acronym order; name: the full name as one string;
// isWord (optional): letters → boolean, to check the spelling of reshaped words.
// Returns the parts with { lead, form } added (lead = connectors before the word, form = the word
// as written), or null if the name breaks a rule.
function phraseParts(parts, name, language = 'fr', isWord = null) {
  if (typeof name !== 'string' || !parts.length) return null;
  const acronym = parts.map((p) => p.letters).join('');
  const unquote = (s) => s.replace(/^[«“"'\s]+|[»”"'.\s]+$/g, '');
  const clean = unquote(unquote(name).replace(new RegExp(`^${acronym}\\s*[:=–—-]\\s*`, 'i'), '')); // "« OPUS : Outil de … »"
  const originals = parts.map((p) => splitTokens(p.text, language).filter((t) => !isFiller(t, language)));
  if (originals.some((o) => !o.length)) return null;

  const out = parts.map((p) => ({ ...p, lead: [], form: [] }));
  const used = parts.map(() => 0); // words of each graph word already written
  let i = -1; // part being written
  let pending = []; // connectors not yet attached to a word
  for (const token of splitTokens(clean, language)) {
    if (isFiller(token, language)) {
      pending.push(token);
      continue;
    }
    if (i >= 0 && used[i] < originals[i].length && sameRoot(token, originals[i][used[i]])) {
      // a further word of a multi-word graph word ("Chemins de fer")
      if (!spelledOk(token, originals[i][used[i]], isWord)) return null;
      out[i].form.push(...pending, token);
      used[i]++;
    } else {
      // the next letter-carrying word: same letter(s) and root as its graph word
      i++;
      if (i >= parts.length) return null; // a word was added
      if (!normalizeLetters(token).startsWith(parts[i].letters) || !sameRoot(token, originals[i][0])) return null;
      if (!spelledOk(token, originals[i][0], isWord)) return null;
      // "Harmonie, Outil…": a comma straight between two words, with no connector, is an enumeration
      const comma = i > 0 && (/[,;]$/.test(out[i - 1].form.at(-1)) || pending.some((t) => /^[,;]$/.test(t)));
      if (comma && !pending.some((t) => isConnector(t, language))) return null;
      out[i].lead = pending;
      out[i].form = [token];
      used[i] = 1;
    }
    pending = [];
  }
  if (i !== parts.length - 1) return null; // a word is missing
  if (pending.some((t) => normalizeLetters(t))) return null; // the name can't end on a connector

  const linked = splitTokens(clean, language).some((t) => isConnector(t, language) && !isCoordinator(t, language));
  if (!linked && parts.length >= (CONNECTOR_NEEDED_FROM[language] || 3)) return null;

  return out.map((p) => ({ ...p, lead: joinTokens(p.lead).toLowerCase(), form: capitalize(joinTokens(p.form)) }));
}

// The name as written: each part's connectors, then its word ("Régie Autonome des Transports Parisiens").
function phraseText(parts) {
  return parts.map((p) => (p.lead ? p.lead + (/['’]$/.test(p.lead) ? '' : ' ') : '') + p.form).join(' ');
}

module.exports = { phraseParts, phraseText, ROOT_LETTERS, CONNECTOR_NEEDED_FROM };
