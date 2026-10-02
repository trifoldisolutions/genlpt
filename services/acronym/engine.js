// Deterministic acronym candidate generation + scoring (no LLM).
const { initials, conceptKey } = require('./normalize');

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U', 'Y']);
const NODE_BUDGET = 1500; // max search nodes per dictionary word (keeps 2–8 letters + chunks < 2 s)

// words: [{ _id, branch, text }] → pool entries with contributable letters
function buildPool(words, language = 'fr') {
  return words
    .map((w) => ({ id: String(w._id ?? w.id), branch: w.branch, text: w.text, ...initials(w.text, language) }))
    .filter((w) => w.one);
}

// Words sharing (branch, one, two) are interchangeable, so the search works on these groups.
function groupPool(pool) {
  const groups = new Map();
  for (const w of pool) {
    const key = `${w.branch}|${w.one}|${w.two || ''}`;
    if (!groups.has(key)) groups.set(key, { branch: w.branch, one: w.one, two: w.two, words: [] });
    groups.get(key).words.push(w);
  }
  return [...groups.values()];
}

function pronounceability(letters) {
  const s = letters.toUpperCase();
  if (s.length < 2) return 0;
  let alternations = 0;
  let run = 1;
  let maxConsRun = VOWELS.has(s[0]) ? 0 : 1;
  let maxVowRun = VOWELS.has(s[0]) ? 1 : 0;
  for (let i = 1; i < s.length; i++) {
    const v = VOWELS.has(s[i]);
    const pv = VOWELS.has(s[i - 1]);
    if (v !== pv) { alternations++; run = 1; } else run++;
    if (v) maxVowRun = Math.max(maxVowRun, run); else maxConsRun = Math.max(maxConsRun, run);
  }
  let score = 10 + 10 * (alternations / (s.length - 1));
  if (maxConsRun >= 3) score -= 10;
  if (maxVowRun >= 3) score -= 5;
  if (![...s].some((c) => VOWELS.has(c))) score -= 10;
  return Math.max(0, Math.min(20, score));
}

function lengthPreference(n) {
  if (n >= 4 && n <= 6) return 20;
  if (n === 3 || n === 7) return 10;
  return 0;
}

// Branch coverage is a small bonus (5 per branch, max 20) next to length (≤20) and sound (≤20):
// whether the expansion reads as a real name is judged later, on the written phrase.
function engineScore(letters, branchCoverage) {
  return Math.round(branchCoverage * 5 + lengthPreference(letters.length) + pronounceability(letters));
}

// Letter → groups lookup, built once per generation run.
function indexGroups(groups, allowChunks) {
  const byLetter = new Map();
  const byChunk = new Map();
  for (const g of groups) {
    if (!byLetter.has(g.one)) byLetter.set(g.one, []);
    byLetter.get(g.one).push(g);
    if (allowChunks && g.two) {
      if (!byChunk.has(g.two)) byChunk.set(g.two, []);
      byChunk.get(g.two).push(g);
    }
  }
  return { byLetter, byChunk, allowChunks };
}

// Can `target` be spelled left-to-right by distinct words? Returns the assignment with the
// best branch coverage (ties → fewer 2-letter chunks), or null.
// `groups` is either groupPool() output or a prebuilt indexGroups() result.
// `maxPerBranch` caps how many words one branch may contribute (1 = one word per branch).
function coverWord(target, groups, { allowChunks = false, maxBranches = 4, maxPerBranch = Infinity } = {}) {
  const index = Array.isArray(groups) ? indexGroups(groups, allowChunks) : groups;
  const { byLetter, byChunk } = index;
  allowChunks = index.allowChunks;

  const used = new Map(); // group → count
  const branchCounts = {};
  const stack = [];
  let best = null;
  let nodes = 0;
  const ceiling = Math.min(maxBranches, 4);

  const distinctBranches = () => Object.keys(branchCounts).filter((b) => branchCounts[b] > 0).length;

  function visit(pos) {
    if (++nodes > NODE_BUDGET) return;
    const coverage = distinctBranches();
    if (pos === target.length) {
      const chunks = stack.filter((s) => s.letters.length === 2).length;
      if (!best || coverage > best.coverage || (coverage === best.coverage && chunks < best.chunks)) {
        best = { coverage, chunks, steps: stack.slice() };
      }
      return;
    }
    // Upper bound on reachable coverage; prune if it can't beat the best found.
    const bound = Math.min(ceiling, coverage + (target.length - pos));
    if (best && (bound < best.coverage || (bound === best.coverage && best.chunks === 0))) return;

    const options = [];
    for (const g of byLetter.get(target[pos]) || []) options.push({ g, letters: g.one });
    if (allowChunks && pos + 2 <= target.length) {
      for (const g of byChunk.get(target.slice(pos, pos + 2)) || []) options.push({ g, letters: g.two });
    }
    // Prefer branches not used yet, then single letters.
    options.sort((a, b) =>
      ((branchCounts[a.g.branch] ? 1 : 0) - (branchCounts[b.g.branch] ? 1 : 0)) ||
      (a.letters.length - b.letters.length));

    for (const opt of options) {
      const n = used.get(opt.g) || 0;
      if (n >= opt.g.words.length) continue;
      if ((branchCounts[opt.g.branch] || 0) >= maxPerBranch) continue;
      used.set(opt.g, n + 1);
      branchCounts[opt.g.branch] = (branchCounts[opt.g.branch] || 0) + 1;
      stack.push(opt);
      visit(pos + opt.letters.length);
      stack.pop();
      branchCounts[opt.g.branch]--;
      used.set(opt.g, n);
      if (best && best.coverage === ceiling && best.chunks === 0) return;
    }
  }

  visit(0);
  if (!best) return null;

  // Turn group steps into concrete, distinct words.
  const taken = new Map();
  const parts = best.steps.map(({ g, letters }) => {
    const i = taken.get(g) || 0;
    taken.set(g, i + 1);
    const w = g.words[i];
    return { wordId: w.id, text: w.text, branch: w.branch, letters };
  });
  return { parts, branchCoverage: best.coverage };
}

// Longest acronym the pool can spell under the per-branch cap.
function letterCapacity(pool, { allowChunks = false, maxPerBranch = Infinity } = {}) {
  const perBranch = {};
  for (const w of pool) perBranch[w.branch] = (perBranch[w.branch] || 0) + 1;
  const words = Object.values(perBranch).reduce((sum, n) => sum + Math.min(n, maxPerBranch), 0);
  return words * (allowChunks ? 2 : 1);
}

// The same word can sit in several branches ("Lien" in who and how, "Acronym" and "Acronyms");
// an acronym uses it once.
function hasRepeatedWord(parts) {
  return new Set(parts.map((p) => conceptKey(p.text))).size < parts.length;
}

function letterIndex(c) {
  return c.charCodeAt(0) - 65;
}

// Stable pseudo-random tie-breaker so equal scores don't all sort alphabetically.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Dictionary pass: every dictionary word that the selected words can spell.
// `exclude` holds candidateKey()s already in the session so repeat runs surface new ones.
function generateEngineCandidates({ words, dictionary, language = 'fr', minLength = 3, maxLength = 6, allowChunks = false, maxPerBranch = Infinity, limit = 120, exclude = null }) {
  const pool = buildPool(words, language);
  const groups = indexGroups(groupPool(pool), allowChunks);
  const maxBranches = new Set(pool.map((w) => w.branch)).size;
  const maxLetters = letterCapacity(pool, { allowChunks, maxPerBranch });

  // Letter supply for the fast multiset pre-filter.
  const supply = new Array(26).fill(0);
  const firsts = new Array(26).fill(false);
  for (const w of pool) {
    supply[letterIndex(w.one)]++;
    firsts[letterIndex(w.one)] = true;
    if (allowChunks && w.two) supply[letterIndex(w.two[1])]++;
  }

  const counts = new Array(26);
  const results = [];
  for (const target of dictionary) {
    const n = target.length;
    if (n < minLength || n > maxLength) continue;
    if (n > maxLetters) continue;
    if (!firsts[letterIndex(target[0])]) continue;
    counts.fill(0);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const k = letterIndex(target[i]);
      if (k < 0 || k > 25 || ++counts[k] > supply[k]) { ok = false; break; }
    }
    if (!ok) continue;

    const found = coverWord(target, groups, { maxBranches, maxPerBranch });
    if (!found || hasRepeatedWord(found.parts)) continue;
    const candidate = {
      letters: target,
      parts: found.parts,
      isRealWord: true,
      branchCoverage: found.branchCoverage,
      engineScore: engineScore(target, found.branchCoverage),
      source: 'engine',
    };
    if (exclude && exclude.has(candidateKey(candidate))) continue;
    results.push(candidate);
  }

  results.sort((a, b) => b.engineScore - a.engineScore || hash(a.letters) - hash(b.letters));
  return results.slice(0, limit);
}

// Validate an LLM-proposed ordered id list; the code, not the LLM, computes the letters.
// idMap: Map('w1' → { _id, branch, text }). Returns a candidate or null.
function candidateFromIds(ids, idMap, { language = 'fr', minLength = 3, maxLength = 6, maxPerBranch = Infinity } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const seen = new Set();
  const perBranch = {};
  const parts = [];
  for (const raw of ids) {
    const id = String(raw).trim().toLowerCase();
    if (seen.has(id) || !idMap.has(id)) return null;
    seen.add(id);
    const w = idMap.get(id);
    perBranch[w.branch] = (perBranch[w.branch] || 0) + 1;
    if (perBranch[w.branch] > maxPerBranch) return null;
    const { one } = initials(w.text, language);
    if (!one) return null;
    parts.push({ wordId: String(w._id ?? w.id), text: w.text, branch: w.branch, letters: one });
  }
  const letters = parts.map((p) => p.letters).join('');
  if (letters.length < minLength || letters.length > maxLength || hasRepeatedWord(parts)) return null;
  const branchCoverage = new Set(parts.map((p) => p.branch)).size;
  return { letters, parts, branchCoverage, engineScore: engineScore(letters, branchCoverage), source: 'llm' };
}

function candidateKey(c) {
  return `${c.letters}|${c.parts.map((p) => String(p.wordId)).join(',')}`;
}

module.exports = {
  buildPool,
  groupPool,
  indexGroups,
  coverWord,
  letterCapacity,
  pronounceability,
  engineScore,
  generateEngineCandidates,
  candidateFromIds,
  candidateKey,
};
