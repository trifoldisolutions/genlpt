// Name-first candidates: the LLM writes a full name from the selected words, then the code checks it
// and derives the letters. The letters can be any initialism; what must make sense is the full name.
const { normalizeLetters, splitTokens, isConnector } = require('./normalize');
const { candidateFromIds } = require('./engine');
const { phraseParts, ROOT_LETTERS } = require('./phrase');

// Letters a word can give as a chunk: its first word as written ("Mind Maps" → MIND, "Mots-clés" → MOTS).
const chunkSource = (form) => normalizeLetters(String(form).split(/[\s\-–—]+/).find((t) => normalizeLetters(t)) || '');

// Splits an acronym into one non-empty start per word, in order: ACROKEY + [ACRONYMS, KEYWORDS] → [ACRO, KEY].
// Longer chunks are tried first. Returns the chunks, or null if the acronym can't be read that way.
function splitAcronym(acronym, sources) {
  const go = (pos, i) => {
    if (i === sources.length) return pos === acronym.length ? [] : null;
    const room = acronym.length - pos - (sources.length - i - 1); // leave a letter for each word after this one
    for (let n = Math.min(sources[i].length, room); n >= 1; n--) {
      const chunk = acronym.slice(pos, pos + n);
      if (!sources[i].startsWith(chunk)) continue;
      const rest = go(pos + n, i + 1);
      if (rest) return [chunk, ...rest];
    }
    return null;
  };
  return acronym && sources.length ? go(0, 0) : null;
}

// The ids in the order their words appear in the name, when the model listed them in another order.
function orderByName(ids, idMap, name, language) {
  const left = ids.map((id) => String(id).trim().toLowerCase()).filter((id) => idMap.has(id));
  const ordered = [];
  for (const token of splitTokens(name, language)) {
    if (isConnector(token, language)) continue;
    const letters = normalizeLetters(token);
    const i = left.findIndex((id) => letters && letters.startsWith(normalizeLetters(idMap.get(id).text).slice(0, ROOT_LETTERS)));
    if (i !== -1) ordered.push(left.splice(i, 1)[0]);
  }
  return left.length ? null : ordered;
}

// item: { fullName, ids, acronym } from the LLM; idMap: Map('w1' → { _id, branch, text }).
// The ids are the letter-carrying words. phraseParts() checks the phrase (connectors never carry a letter,
// no added word, no keyword list…). Letters: the initials, or with allowChunks the model's acronym when it
// splits into the starts of those words. Returns a candidate or null.
function candidateFromName(item, idMap, { language = 'fr', minLength = 3, maxLength = 6, maxPerBranch = Infinity, allowChunks = false, isWord = null } = {}) {
  if (!item || typeof item.fullName !== 'string' || !Array.isArray(item.ids)) return null;
  const build = (ids) => {
    const base = candidateFromIds(ids, idMap, { language, minLength: 1, maxLength: Infinity, maxPerBranch });
    return base && phraseParts(base.parts, item.fullName, language, isWord);
  };
  let parts = build(item.ids);
  if (!parts) {
    const ordered = orderByName(item.ids, idMap, item.fullName, language);
    parts = ordered && build(ordered);
  }
  if (!parts || parts.length < 2) return null;

  const fits = (s) => s.length >= minLength && s.length <= maxLength;
  // A chunked acronym that doesn't fit the length range falls back to the initials.
  const chunks = allowChunks ? splitAcronym(normalizeLetters(item.acronym || ''), parts.map((p) => chunkSource(p.form))) : null;
  if (chunks && fits(chunks.join(''))) parts = parts.map((p, i) => ({ ...p, letters: chunks[i] }));
  const letters = parts.map((p) => p.letters).join('');
  if (!fits(letters)) return null;
  return { letters, parts, branchCoverage: new Set(parts.map((p) => p.branch)).size, engineScore: null, source: 'llm' };
}

module.exports = { candidateFromName, splitAcronym, chunkSource };
