const express = require('express');
const mongoose = require('mongoose');
const BrainstormSession = require('../models/BrainstormSession');
const llm = require('../services/llm');
const prompts = require('../services/llm/prompts');
const dictionary = require('../services/acronym/dictionary');
const { conceptKey, cleanWordList, cleanTitle } = require('../services/acronym/normalize');
const { generateEngineCandidates, candidateKey, buildPool, letterCapacity } = require('../services/acronym/engine');
const { candidateFromName } = require('../services/acronym/compose');
const { phraseParts } = require('../services/acronym/phrase');

const { ANSWER_MIN_CHARS, ANSWER_MAX_CHARS, answerLength } = require('../config/limits');

const { BRANCHES, TITLE_SOURCES, MAX_WORDS, MAX_ACRONYMS } = BrainstormSession;
const LANGUAGES = ['fr', 'en'];
const TITLE_MAX_WORDS = 5;
const NAME_CAP = 36; // "Real words only": dictionary words the LLM names, one request each (~2 s on a local 12B model)
const RANK_BATCH = 12;
const COMPOSE_CALLS = 3; // name-first: independent requests of 12 names each, sampled for variety
const FATAL = new Set(['llm_unavailable', 'llm_timeout']); // stop calling the LLM after these

const router = express.Router();

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const dbReady = () => mongoose.connection.readyState === 1;
const isId = (id) => mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(String(id));
const sessionModel = (s) => s.model || llm.defaultModel();

function requireDb(req, res, next) {
  if (!dbReady()) throw new ApiError(503, 'database_unavailable', 'MongoDB is not connected');
  next();
}

async function loadSession(id) {
  if (!isId(id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const session = await BrainstormSession.findById(id);
  if (!session) throw new ApiError(404, 'session_not_found', 'Session not found');
  return session;
}

function findWord(session, wordId) {
  const word = isId(wordId) ? session.words.id(wordId) : null;
  if (!word) throw new ApiError(404, 'word_not_found', 'Word not found');
  return word;
}

// Keys of the words' ideas: "Acronym" and "Acronyms" are the same idea.
function wordKeys(words) {
  return new Set(words.map((w) => conceptKey(w.text)));
}

function cleanText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > 60) throw new ApiError(400, 'invalid_text', 'Word text must be 1–60 characters');
  return text;
}

function newWord(branch, text, source, parentId = null) {
  return { _id: new mongoose.Types.ObjectId(), branch, text, selected: true, source, parentId };
}

async function pushWords(sessionId, words) {
  await BrainstormSession.updateOne({ _id: sessionId }, { $push: { words: { $each: words } } });
}

// A session gets one AI title, ever: made on the first Generate words with all four answers, then never redone.
// titleSource 'ai' without aiTitle: suggested before aiTitle was stored.
const NO_AI_TITLE = { aiTitle: { $in: ['', null] }, titleSource: { $ne: 'ai' } };
const hasAiTitle = (session) => !!session.aiTitle || session.titleSource === 'ai';

// Best effort: '' when the model fails or a concurrent request already stored a suggestion.
async function suggestTitle(session, answers) {
  try {
    const p = prompts.projectTitle({ language: session.language, answers, maxWords: TITLE_MAX_WORDS });
    const out = await llm.chatJSON({ model: sessionModel(session), ...p });
    const title = cleanTitle(out.title, session.language, TITLE_MAX_WORDS);
    if (!title) return '';
    const r = await BrainstormSession.updateOne(
      { _id: session._id, ...NO_AI_TITLE },
      { $set: { title, aiTitle: title, titleSource: 'ai' } }
    );
    return r.matchedCount ? title : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Health & LLM

router.get('/health', async (req, res) => {
  res.json({
    db: dbReady(),
    llm: await llm.isAvailable(),
    provider: llm.providerName(),
    defaultModel: llm.defaultModel(),
  });
});

router.get('/models', async (req, res) => {
  res.json({ models: await llm.listModels(), defaultModel: llm.defaultModel() });
});

router.post('/llm/warmup', async (req, res) => {
  const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : llm.defaultModel();
  const started = Date.now();
  await llm.warmup(model);
  res.json({ ok: true, model, ms: Date.now() - started });
});

// ---------------------------------------------------------------------------
// Sessions

router.use('/sessions', requireDb);

router.get('/sessions', async (req, res) => {
  const sessions = await BrainstormSession.find({}, { title: 1, language: 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .lean();
  res.json({ sessions });
});

router.post('/sessions', async (req, res) => {
  const { language, model } = req.body || {};
  const session = await BrainstormSession.create({
    language: LANGUAGES.includes(language) ? language : 'fr',
    model: typeof model === 'string' ? model.slice(0, 200) : '',
  });
  res.status(201).json({ session });
});

router.get('/sessions/:id', async (req, res) => {
  res.json({ session: await loadSession(req.params.id) });
});

router.patch('/sessions/:id', async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const body = req.body || {};
  const $set = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.length > 120) throw new ApiError(400, 'invalid_title', 'Title must be ≤ 120 characters');
    $set.title = body.title.trim();
    $set.titleSource = $set.title ? 'user' : 'auto';
  }
  if (body.titleSource !== undefined) {
    if (!TITLE_SOURCES.includes(body.titleSource)) throw new ApiError(400, 'invalid_title_source', 'Invalid title source');
    $set.titleSource = body.titleSource;
  }
  if (body.language !== undefined) {
    if (!LANGUAGES.includes(body.language)) throw new ApiError(400, 'invalid_language', 'Language must be fr or en');
    $set.language = body.language;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.length > 200) throw new ApiError(400, 'invalid_model', 'Invalid model');
    $set.model = body.model;
  }
  if (body.answers !== undefined) {
    if (typeof body.answers !== 'object' || body.answers === null) throw new ApiError(400, 'invalid_answers', 'answers must be an object');
    for (const b of BRANCHES) {
      if (body.answers[b] === undefined) continue;
      if (typeof body.answers[b] !== 'string' || body.answers[b].length > ANSWER_MAX_CHARS) {
        throw new ApiError(400, 'invalid_answers', `answers.${b} must be a string ≤ ${ANSWER_MAX_CHARS} characters`);
      }
      // One paragraph, no stray spaces; the client tidies too but keeps a trailing space while typing.
      $set[`answers.${b}`] = body.answers[b].replace(/\s+/g, ' ').trim();
    }
  }
  const session = await BrainstormSession.findByIdAndUpdate(req.params.id, { $set }, { returnDocument: 'after', runValidators: true });
  if (!session) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ session: { _id: session._id, title: session.title, titleSource: session.titleSource, language: session.language, model: session.model, answers: session.answers, updatedAt: session.updatedAt } });
});

router.delete('/sessions/:id', async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const deleted = await BrainstormSession.findByIdAndDelete(req.params.id);
  if (!deleted) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Words

router.post('/sessions/:id/expand', async (req, res) => {
  const session = await loadSession(req.params.id);
  const requested = Array.isArray(req.body?.branches) ? req.body.branches : BRANCHES;
  const branches = BRANCHES.filter((b) => requested.includes(b) && (session.answers?.[b] || '').trim());
  if (!branches.length) throw new ApiError(422, 'no_answers', 'Answer at least one question first');
  // Drafts may be short (autosave), but generation needs every answered branch to meet the minimum.
  if (branches.some((b) => answerLength(session.answers[b]) < ANSWER_MIN_CHARS)) {
    throw new ApiError(422, 'answer_too_short', `Each answer needs at least ${ANSWER_MIN_CHARS} characters (spaces not counted)`);
  }
  if (session.words.length >= MAX_WORDS) throw new ApiError(422, 'word_limit', `A session can hold at most ${MAX_WORDS} words`);

  const answers = session.answers.toObject ? session.answers.toObject() : session.answers;
  // All four answered and no AI title yet: suggest one alongside the words.
  const wantTitle = branches.length === BRANCHES.length && !hasAiTitle(session);
  const [results, title] = await Promise.all([
    Promise.allSettled(branches.map(async (branch) => {
      const existing = session.words.map((w) => w.text);
      const p = prompts.branchExpansion({ language: session.language, branch, answers, existing: existing.slice(0, 80) });
      const out = await llm.chatJSON({ model: sessionModel(session), ...p });
      return out.words;
    })),
    wantTitle ? suggestTitle(session, answers) : '',
  ]);

  // Each idea stays in the first branch that produced it (who → what → how → why) and is never repeated
  // in another one, singular and plural counting as the same word.
  const errors = {};
  let added = [];
  const seen = wordKeys(session.words);
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      errors[branches[i]] = { error: r.reason.code || 'llm_error', message: r.reason.message };
      return;
    }
    const words = cleanWordList(r.value, seen).slice(0, 12);
    for (const t of words) seen.add(conceptKey(t));
    added.push(...words.map((t) => newWord(branches[i], t, 'llm')));
  });
  if (!added.length && Object.keys(errors).length === branches.length) throw results[0].reason;

  added = added.slice(0, MAX_WORDS - session.words.length);
  if (added.length) await pushWords(session._id, added);
  res.json({ words: added, errors, title: title || null });
});

router.post('/sessions/:id/words', async (req, res) => {
  const session = await loadSession(req.params.id);
  const { branch, parentId } = req.body || {};
  const text = cleanText(req.body?.text);
  let wordBranch = branch;
  if (parentId) {
    wordBranch = findWord(session, parentId).branch;
  } else if (!BRANCHES.includes(branch)) {
    throw new ApiError(400, 'invalid_branch', 'branch must be one of who, what, how, why');
  }
  if (session.words.length >= MAX_WORDS) throw new ApiError(422, 'word_limit', `A session can hold at most ${MAX_WORDS} words`);
  if (wordKeys(session.words.filter((w) => w.branch === wordBranch)).has(conceptKey(text))) {
    throw new ApiError(422, 'duplicate_word', 'This word already exists in that branch');
  }
  const word = newWord(wordBranch, text, 'user', parentId || null);
  await pushWords(session._id, [word]);
  res.status(201).json({ word });
});

router.post('/sessions/:id/words/bulk-select', async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const { branch, selected } = req.body || {};
  if (typeof selected !== 'boolean') throw new ApiError(400, 'invalid_selected', 'selected must be a boolean');
  if (branch !== undefined && !BRANCHES.includes(branch)) throw new ApiError(400, 'invalid_branch', 'Invalid branch');
  const update = branch
    ? [{ $set: { 'words.$[w].selected': selected } }, { arrayFilters: [{ 'w.branch': branch }] }]
    : [{ $set: { 'words.$[].selected': selected } }, {}];
  const r = await BrainstormSession.updateOne({ _id: req.params.id }, update[0], update[1]);
  if (!r.matchedCount) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ ok: true, branch: branch || null, selected });
});

router.patch('/sessions/:id/words/:wordId', async (req, res) => {
  const session = await loadSession(req.params.id);
  const word = findWord(session, req.params.wordId);
  const $set = {};
  if (req.body?.text !== undefined) {
    const text = cleanText(req.body.text);
    const clash = session.words.some((w) => w.branch === word.branch && !w._id.equals(word._id) && conceptKey(w.text) === conceptKey(text));
    if (clash) throw new ApiError(422, 'duplicate_word', 'This word already exists in that branch');
    $set['words.$.text'] = text;
  }
  if (req.body?.selected !== undefined) {
    if (typeof req.body.selected !== 'boolean') throw new ApiError(400, 'invalid_selected', 'selected must be a boolean');
    $set['words.$.selected'] = req.body.selected;
  }
  if (!Object.keys($set).length) throw new ApiError(400, 'nothing_to_update', 'Provide text or selected');
  const updated = await BrainstormSession.findOneAndUpdate(
    { _id: session._id, 'words._id': word._id },
    { $set },
    { returnDocument: 'after', projection: { words: { $elemMatch: { _id: word._id } } } }
  );
  if (!updated?.words?.length) throw new ApiError(404, 'word_not_found', 'Word not found');
  res.json({ word: updated.words[0] });
});

router.delete('/sessions/:id/words/:wordId', async (req, res) => {
  const session = await loadSession(req.params.id);
  const root = findWord(session, req.params.wordId);
  const ids = new Set([String(root._id)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of session.words) {
      if (w.parentId && ids.has(String(w.parentId)) && !ids.has(String(w._id))) {
        ids.add(String(w._id));
        grew = true;
      }
    }
  }
  const objectIds = [...ids].map((id) => new mongoose.Types.ObjectId(id));
  await BrainstormSession.updateOne({ _id: session._id }, { $pull: { words: { _id: { $in: objectIds } } } });
  res.json({ deleted: [...ids] });
});

router.post('/sessions/:id/words/:wordId/expand', async (req, res) => {
  const session = await loadSession(req.params.id);
  const seed = findWord(session, req.params.wordId);
  if (session.words.length >= MAX_WORDS) throw new ApiError(422, 'word_limit', `A session can hold at most ${MAX_WORDS} words`);
  const answers = session.answers.toObject ? session.answers.toObject() : session.answers;
  const existing = session.words.map((w) => w.text);
  const p = prompts.wordExpansion({ language: session.language, branch: seed.branch, seed: seed.text, answers, existing: existing.slice(0, 80) });
  const out = await llm.chatJSON({ model: sessionModel(session), ...p });
  const words = cleanWordList(out.words, wordKeys(session.words))
    .slice(0, 8)
    .slice(0, MAX_WORDS - session.words.length)
    .map((t) => newWord(seed.branch, t, 'llm', seed._id));
  if (words.length) await pushWords(session._id, words);
  res.json({ words });
});

// ---------------------------------------------------------------------------
// Acronyms

function intInRange(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2 || n > 8) throw new ApiError(400, 'invalid_length', 'Lengths must be integers between 2 and 8');
  return n;
}

// Name-first (the default): the LLM writes full names from the selected words, and candidateFromName()
// checks each one and takes its letters. A failed request is skipped; if all fail, the error is thrown.
async function composePass({ session, answers, selected, opts }) {
  const idMap = new Map();
  const idWords = selected.map((w, i) => {
    const id = `w${i + 1}`;
    idMap.set(id, w);
    return { id, branch: w.branch, text: w.text };
  });
  const p = prompts.composeNames({ language: session.language, answers, idWords, ...opts });
  const errors = [];
  const lists = await llm.mapLimit(Array.from({ length: COMPOSE_CALLS }), llm.concurrency(), async () => {
    try {
      const out = await llm.chatJSON({ model: sessionModel(session), ...p });
      return Array.isArray(out.names) ? out.names.slice(0, 20) : [];
    } catch (err) {
      errors.push(err);
      return [];
    }
  });
  if (errors.length === COMPOSE_CALLS) throw errors[0];
  const isWord = (w) => dictionary.isWord(session.language, w);
  const dict = dictionary.getSet(session.language);
  const found = [];
  for (const item of lists.flat()) {
    const c = candidateFromName(item, idMap, { ...opts, language: session.language, isWord });
    if (!c) continue;
    c.isRealWord = dict.has(c.letters);
    found.push(c);
  }
  return { found, proposed: lists.flat().length, error: errors[0] || null };
}

// One request per candidate (a small model enumerates when given a list): the LLM proposes 3 names
// and the first that passes phraseParts() is kept. Candidates without a valid name are dropped.
// Requests run llm.concurrency() at a time: one for Ollama (queued ones would burn their timeout), several when hosted.
async function namePass({ session, answers, candidates }) {
  const errors = [];
  let answered = 0;
  let stop = false; // after a fatal error (LLM gone, timeout), skip the remaining calls
  const isWord = (w) => dictionary.isWord(session.language, w);
  const results = await llm.mapLimit(candidates, llm.concurrency(), async (c) => {
    if (stop) return null;
    try {
      const p = prompts.nameAcronym({ language: session.language, answers, candidate: c });
      const out = await llm.chatJSON({ model: sessionModel(session), ...p });
      answered++;
      for (const name of Array.isArray(out.names) ? out.names.slice(0, 5) : []) {
        const parts = phraseParts(c.parts, name, session.language, isWord);
        if (parts) return { ...c, parts };
      }
    } catch (err) {
      errors.push(err);
      if (FATAL.has(err.code)) stop = true;
    }
    return null;
  });
  return { named: results.filter(Boolean), errors, answered };
}

// Scores the named candidates. One the LLM rejects is dropped; one it can't score keeps a null score,
// since its name already passed the rules.
async function rankPass({ session, answers, candidates }) {
  let error = null;
  const batches = [];
  for (let i = 0; i < candidates.length; i += RANK_BATCH) batches.push(candidates.slice(i, i + RANK_BATCH));
  const ranked = await llm.mapLimit(batches, llm.concurrency(), async (batch) => {
    const byId = new Map();
    if (!error || !FATAL.has(error.code)) {
      try {
        const p = prompts.rankAcronyms({ language: session.language, answers, candidates: batch });
        const out = await llm.chatJSON({ model: sessionModel(session), ...p });
        for (const r of Array.isArray(out.results) ? out.results : []) {
          if (r && typeof r.id === 'string') byId.set(r.id.trim().toLowerCase(), r);
        }
      } catch (err) {
        error = err;
      }
    }
    return batch.flatMap((c, j) => {
      const r = byId.get(`a${j + 1}`);
      if (r?.keep === false) return [];
      const score = Number(r?.score);
      return [{
        ...c,
        score: r && Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
        rationale: typeof r?.rationale === 'string' ? r.rationale.slice(0, 240) : '',
        tagline: typeof r?.tagline === 'string' ? r.tagline.slice(0, 160) : '',
      }];
    });
  });
  return { ranked: ranked.flat(), error };
}

router.post('/sessions/:id/acronyms/generate', async (req, res) => {
  const session = await loadSession(req.params.id);
  const body = req.body || {};
  const opts = {
    minLength: intInRange(body.minLength, 3),
    maxLength: intInRange(body.maxLength, 6),
    realWordsOnly: body.realWordsOnly === true,
    allowChunks: body.allowChunks === true,
    maxPerBranch: body.maxPerBranch === undefined ? 1 : Number(body.maxPerBranch),
  };
  if (opts.minLength > opts.maxLength) throw new ApiError(400, 'invalid_length', 'minLength must be ≤ maxLength');
  if (![1, 2, 3].includes(opts.maxPerBranch)) throw new ApiError(400, 'invalid_per_branch', 'maxPerBranch must be 1, 2 or 3');
  if (session.acronyms.length >= MAX_ACRONYMS) throw new ApiError(422, 'acronym_limit', `A session can hold at most ${MAX_ACRONYMS} acronyms`);

  const selected = session.words.filter((w) => w.selected);
  // Name-first with letter chunks: a few words can give many letters. Otherwise each word gives one (or two) letters.
  const stretch = opts.allowChunks && !opts.realWordsOnly;
  const minWords = stretch ? 2 : opts.minLength;
  if (selected.length < minWords) {
    throw new ApiError(422, 'not_enough_words', `Select at least ${minWords} words`);
  }
  const capacity = letterCapacity(buildPool(selected, session.language), opts);
  if (!stretch && capacity < opts.minLength) {
    throw new ApiError(422, 'length_unreachable', `With these words and ${opts.maxPerBranch} word(s) per branch, acronyms can have at most ${capacity} letters`);
  }
  // Every acronym needs an LLM-written full name, so there is no offline mode.
  if (!(await llm.isAvailable())) throw new llm.LLMError('llm_unavailable', 'The LLM is needed to write the acronyms’ full names');
  const answers = session.answers.toObject ? session.answers.toObject() : session.answers;

  const existing = new Set(session.acronyms.map((a) => candidateKey(a)));
  const fresh = (list) => list.filter((c) => {
    const key = candidateKey(c);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  });
  const timings = {};
  const stats = {};
  let llmError = null;
  let named = [];

  if (opts.realWordsOnly) {
    // 1a. Real words only: dictionary words the initials can spell, then the LLM names each one
    let t0 = Date.now();
    const engine = generateEngineCandidates({
      words: selected,
      dictionary: dictionary.getRange(session.language, opts.minLength, opts.maxLength),
      language: session.language,
      exclude: existing,
      ...opts,
    });
    timings.engineMs = Date.now() - t0;
    const shortlist = fresh(engine).slice(0, NAME_CAP);
    Object.assign(stats, { engine: engine.length, shortlist: shortlist.length });
    if (shortlist.length) {
      t0 = Date.now();
      const pass = await namePass({ session, answers, candidates: shortlist });
      timings.nameMs = Date.now() - t0;
      if (!pass.answered && pass.errors.length) throw pass.errors[0];
      if (pass.errors.length) llmError = pass.errors[0];
      named = pass.named;
    }
  } else {
    // 1b. Default, name-first: the LLM writes full names, the code checks them and takes their letters
    const t0 = Date.now();
    const pass = await composePass({ session, answers, selected, opts });
    timings.composeMs = Date.now() - t0;
    if (pass.error) llmError = pass.error;
    named = fresh(pass.found);
    Object.assign(stats, { proposed: pass.proposed, valid: pass.found.length });
  }
  stats.named = named.length;

  // 2. LLM ranking: keeps names that make sense and describe the project
  let candidates = [];
  if (named.length) {
    const t0 = Date.now();
    const { ranked, error } = await rankPass({ session, answers, candidates: named });
    timings.rankMs = Date.now() - t0;
    if (error) llmError = llmError || error;
    candidates = ranked;
  }

  // 3. Append
  const room = MAX_ACRONYMS - session.acronyms.length;
  const acronyms = candidates.slice(0, room).map((c) => ({
    _id: new mongoose.Types.ObjectId(),
    letters: c.letters,
    parts: c.parts.map((p) => ({ wordId: new mongoose.Types.ObjectId(p.wordId), text: p.text, branch: p.branch, letters: p.letters, lead: p.lead, form: p.form })),
    isRealWord: !!c.isRealWord,
    branchCoverage: c.branchCoverage,
    engineScore: c.engineScore,
    score: c.score ?? null,
    rationale: c.rationale || '',
    tagline: c.tagline || '',
    source: c.source,
    favorite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  if (acronyms.length) {
    await BrainstormSession.updateOne({ _id: session._id }, { $push: { acronyms: { $each: acronyms } } });
  }

  res.json({
    acronyms,
    llmError: llmError ? { error: llmError.code || 'llm_error', message: llmError.message } : null,
    stats: { ...stats, kept: acronyms.length, ...timings },
  });
});

router.patch('/sessions/:id/acronyms/:acronymId', async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.acronymId)) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  if (typeof req.body?.favorite !== 'boolean') throw new ApiError(400, 'invalid_favorite', 'favorite must be a boolean');
  const r = await BrainstormSession.updateOne(
    { _id: req.params.id, 'acronyms._id': req.params.acronymId },
    { $set: { 'acronyms.$.favorite': req.body.favorite } }
  );
  if (!r.matchedCount) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  res.json({ ok: true, favorite: req.body.favorite });
});

router.delete('/sessions/:id/acronyms/:acronymId', async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.acronymId)) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  const r = await BrainstormSession.updateOne(
    { _id: req.params.id, 'acronyms._id': req.params.acronymId },
    { $pull: { acronyms: { _id: req.params.acronymId } } }
  );
  if (!r.matchedCount) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  res.json({ ok: true });
});

router.post('/sessions/:id/acronyms/clear', async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const r = await BrainstormSession.updateOne({ _id: req.params.id }, { $pull: { acronyms: { favorite: { $ne: true } } } });
  if (!r.matchedCount) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// JSON 404 + error handler for everything under /api

router.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof ApiError || err instanceof llm.LLMError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
  }
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return res.status(400).json({ error: 'validation_error', message: err.message });
  }
  console.error('[api]', err);
  res.status(500).json({ error: 'server_error', message: 'Unexpected server error' });
});

router.routes = [
  { method: 'GET', path: '/health', label: 'DB + LLM health' },
  { method: 'GET', path: '/models', label: 'List LLM models' },
  { method: 'POST', path: '/llm/warmup', label: 'Load a model into memory' },
  { method: 'GET', path: '/sessions', label: 'List sessions' },
  { method: 'POST', path: '/sessions', label: 'Create session' },
  { method: 'GET', path: '/sessions/:id', label: 'Get session' },
  { method: 'PATCH', path: '/sessions/:id', label: 'Update session' },
  { method: 'DELETE', path: '/sessions/:id', label: 'Delete session' },
  { method: 'POST', path: '/sessions/:id/expand', label: 'LLM words for branches' },
  { method: 'POST', path: '/sessions/:id/words', label: 'Add manual word' },
  { method: 'PATCH', path: '/sessions/:id/words/:wordId', label: 'Rename / (de)select word' },
  { method: 'POST', path: '/sessions/:id/words/bulk-select', label: 'Bulk (de)select words' },
  { method: 'DELETE', path: '/sessions/:id/words/:wordId', label: 'Delete word + descendants' },
  { method: 'POST', path: '/sessions/:id/words/:wordId/expand', label: 'LLM child words' },
  { method: 'POST', path: '/sessions/:id/acronyms/generate', label: 'Generate acronyms' },
  { method: 'PATCH', path: '/sessions/:id/acronyms/:acronymId', label: 'Toggle favorite' },
  { method: 'DELETE', path: '/sessions/:id/acronyms/:acronymId', label: 'Delete acronym' },
  { method: 'POST', path: '/sessions/:id/acronyms/clear', label: 'Clear non-favorites' },
];

module.exports = router;
