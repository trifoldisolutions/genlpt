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
const { resolveOwner, ensureOwner, guestOwner, clearGuest, keepGuest, GUEST_TTL_MS } = require('../middleware/owner');
const usage = require('../services/usage');
const domains = require('../services/domains');
const meter = require('../services/llm/meter');
const AiAction = require('../models/AiAction');

const { ANSWER_MIN_CHARS, ANSWER_MAX_CHARS, answerLength } = require('../config/limits');

const { BRANCHES, TITLE_SOURCES, MAX_WORDS, MAX_ACRONYMS } = BrainstormSession;
const LANGUAGES = ['fr', 'en'];
const TITLE_MAX_WORDS = 5;
const NAME_CAP = 36; // "Real words only": dictionary words the LLM names, one request each (~2 s on a local 12B model)
const RANK_BATCH = 12;
const DOMAIN_BATCH = 10; // acronyms per domain check request (each new name is a registry lookup, 4 per acronym)
const FATAL = new Set(['llm_unavailable', 'llm_timeout']); // stop calling the LLM after these

const router = express.Router();

// extra: more fields for the JSON error body
class ApiError extends Error {
  constructor(status, code, message, extra = null) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const dbReady = () => mongoose.connection.readyState === 1;
const isId = (id) => mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(String(id));
// Guests always get the cheapest model, whatever the session says; other plans pick any listed one
const modelFor = async (req, session) => (usage.limitsOf(req).allModels ? session.model || llm.defaultModel() : llm.cheapestModel());

// Counts one AI action (usage.take) or refuses with 429 usage_limit. A request that then fails gives it back,
// and so does one that adds nothing: call the returned giveBack(). req.usage is the count to send the page.
// sessionId: for a kind counted per session (reformulations).
async function useAi(req, res, kind, sessionId = null) {
  const r = await usage.take(req, kind, sessionId);
  if (!r.ok) {
    throw new ApiError(429, 'usage_limit', `No ${kind} left until ${r.resetAt.toISOString()}`, { kind, resetAt: r.resetAt, plan: usage.planOf(req) });
  }
  req.usage = r.view;
  if (req.meter) req.meter.counted = true;
  let given = false;
  const giveBack = async () => {
    if (given) return;
    given = true;
    if (req.meter) req.meter.counted = false;
    await usage.giveBack(r.taken, r.path);
    req.usage = await usage.view(req);
  };
  res.on('finish', () => { if (res.statusCode >= 400) giveBack().catch(() => {}); });
  return giveBack;
}

// An AI action's route: every LLM call it makes is metered (services/llm/meter.js) and, once the response is
// sent, saved as one AiAction with its cost, tokens and time, for npm run usage:report. The route may set
// req.meter.variant and req.meter.result; useAi and the error handler fill in the rest. No call, no record.
function metered(kind) {
  return (req, res, next) => {
    const started = Date.now();
    const sessionId = isId(req.params.id) ? req.params.id : null;
    req.meter = { calls: [], counted: false, variant: null, result: null, error: null };
    res.on('finish', () => {
      const m = req.meter;
      if (!m.calls.length || !dbReady()) return;
      AiAction.create({
        kind,
        variant: m.variant,
        plan: usage.planOf(req),
        owner: req.owner,
        sessionId,
        provider: llm.providerName(),
        settings: llm.settings(),
        status: res.statusCode,
        error: m.error,
        counted: m.counted && res.statusCode < 400,
        result: m.result,
        ms: Date.now() - started,
        calls: m.calls,
        ...meter.totals(m.calls),
      }).catch((err) => console.error('[usage meter]', err.message));
    });
    meter.run(req.meter, next);
  };
}

// The session as this viewer may see it: acronyms past their plan's share stay on the server, counted
function forViewer(req, session) {
  const json = session.toJSON();
  const { visible, locked } = usage.splitAcronyms(json.acronyms, usage.planOf(req));
  return { ...json, acronyms: visible, lockedAcronyms: locked };
}

function requireDb(req, res, next) {
  if (!dbReady()) throw new ApiError(503, 'database_unavailable', 'MongoDB is not connected');
  next();
}

// Every session query goes through this: someone else's session is a plain 404, as if it didn't exist.
// No owner (a guest before their first session, or after their time is up) owns nothing. A guest's session
// past its expiresAt is gone too, even before MongoDB's TTL monitor (about once a minute) deletes it.
function owned(req, filter = {}) {
  if (!req.owner) throw new ApiError(404, 'session_not_found', 'Session not found');
  return { ...filter, owner: req.owner, ...(req.user ? {} : { expiresAt: { $gt: new Date() } }) };
}

// Ms until a guest's session is erased (null for a signed-in user's), for the page's countdown on its card
const expiresInMs = (expiresAt) => (expiresAt ? Math.max(0, new Date(expiresAt) - Date.now()) : null);

// Activity keeps a guest's session: a request on it pushes its end to GUEST_HOURS from now, and the cookie
// with it (that session is now the guest's last to go). At most once per TOUCH_MS, so a busy page doesn't
// write each time; and without touching updatedAt, which orders the list by real changes. The page gets
// the session's time left in X-Session-Expires-In, to keep its card in step.
const TOUCH_MS = Math.min(60 * 1000, GUEST_TTL_MS / 10);
async function touchGuest(req, res, next) {
  const id = req.path.split('/')[1]; // /sessions/<id>/…
  if (req.user || !req.owner || !isId(id)) return next();
  const now = Date.now();
  const expiresAt = new Date(now + GUEST_TTL_MS);
  const touched = await BrainstormSession.findOneAndUpdate(
    { _id: id, owner: req.owner, expiresAt: { $gt: new Date(now), $lt: new Date(expiresAt.getTime() - TOUCH_MS) } },
    { $set: { expiresAt } },
    { timestamps: false, projection: { expiresAt: 1 } }
  ).lean();
  if (touched) keepGuest(req, res);
  const session = touched ? { expiresAt } : await BrainstormSession.findOne(owned(req, { _id: id }), { expiresAt: 1 }).lean();
  if (session) res.set('X-Session-Expires-In', String(expiresInMs(session.expiresAt)));
  next();
}

async function loadSession(req) {
  const { id } = req.params;
  if (!isId(id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const session = await BrainstormSession.findOne(owned(req, { _id: id }));
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
async function suggestTitle(session, answers, model) {
  try {
    const p = prompts.projectTitle({ language: session.language, answers, maxWords: TITLE_MAX_WORDS });
    const out = await llm.chatJSON({ model, ...p });
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

// allowed: whether this viewer's plan may use the model (guests: the cheapest only)
router.get('/models', async (req, res) => {
  const models = await llm.listModels();
  const only = usage.limitsOf(req).allModels ? null : await llm.cheapestModel();
  res.json({ models: models.map((m) => ({ ...m, allowed: !only || m.name === only })), defaultModel: llm.defaultModel() });
});

router.post('/llm/warmup', async (req, res) => {
  const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : llm.defaultModel();
  const started = Date.now();
  await llm.warmup(model);
  res.json({ ok: true, model, ms: Date.now() - started });
});

// ---------------------------------------------------------------------------
// Sessions

// Nothing written in it: no title, answers, words or acronyms (a language or model change alone doesn't count).
// Such sessions aren't kept: they're swept whenever the list loads, and the page drops one as soon as it's left.
const BLANK = {
  title: { $in: ['', null] },
  ...Object.fromEntries(BRANCHES.map((b) => [`answers.${b}`, { $in: ['', null] }])),
  words: { $size: 0 },
  acronyms: { $size: 0 },
};

router.use('/sessions', requireDb, resolveOwner, touchGuest);

router.get('/sessions', async (req, res) => {
  if (!req.owner) return res.json({ sessions: [], usage: await usage.view(req) });
  await BrainstormSession.deleteMany(owned(req, BLANK));
  const sessions = await BrainstormSession.find(owned(req), { title: 1, language: 1, updatedAt: 1, expiresAt: 1 })
    .sort({ updatedAt: -1 })
    .lean();
  res.json({
    sessions: sessions.map(({ expiresAt, ...s }) => ({ ...s, expiresInMs: expiresInMs(expiresAt) })),
    usage: await usage.view(req),
  });
});

// A guest with only blank sessions (or none left) starts over as a new guest: nothing of theirs is worth
// keeping. (Their AI usage still counts on the IP's window, so starting over doesn't reset it.)
async function restartBlankGuest(req, res, next) {
  if (!req.user && req.owner && !(await BrainstormSession.exists(owned(req, { $nor: [BLANK] })))) {
    await BrainstormSession.deleteMany({ owner: req.owner, ...BLANK });
    req.owner = null; // ensureOwner makes the new guest
  }
  next();
}

router.post('/sessions', restartBlankGuest, ensureOwner, async (req, res) => {
  const { language, model } = req.body || {};
  const expiresAt = req.user ? undefined : new Date(Date.now() + GUEST_TTL_MS);
  if (expiresAt) keepGuest(req, res); // the guest's last session to go, now (a new guest has just had the cookie)
  const session = await BrainstormSession.create({
    owner: req.owner,
    expiresAt,
    language: LANGUAGES.includes(language) ? language : 'fr',
    model: !usage.limitsOf(req).allModels ? await llm.cheapestModel() : typeof model === 'string' ? model.slice(0, 200) : '',
  });
  res.status(201).json({ session, expiresInMs: expiresInMs(expiresAt) });
});

router.get('/sessions/:id', async (req, res) => {
  res.json({ session: forViewer(req, await loadSession(req)) });
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
    if (!usage.limitsOf(req).allModels && body.model !== (await llm.cheapestModel())) {
      throw new ApiError(403, 'model_not_allowed', 'Guests use the cheapest model');
    }
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
  const session = await BrainstormSession.findOneAndUpdate(owned(req, { _id: req.params.id }), { $set }, { returnDocument: 'after', runValidators: true });
  if (!session) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ session: { _id: session._id, title: session.title, titleSource: session.titleSource, language: session.language, model: session.model, answers: session.answers, updatedAt: session.updatedAt } });
});

router.delete('/sessions/:id', async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const deleted = await BrainstormSession.findOneAndDelete(owned(req, { _id: req.params.id }));
  if (!deleted) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ ok: true });
});

// The model's answer, tidied like a typed one. Past ANSWER_MAX_CHARS it ends at the last sentence that fits
// (when that keeps most of it), else at the last word.
function fitAnswer(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= ANSWER_MAX_CHARS) return text;
  const cut = text.slice(0, ANSWER_MAX_CHARS + 1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')) + 1;
  const word = cut.lastIndexOf(' ');
  return cut.slice(0, sentence > ANSWER_MAX_CHARS / 2 ? sentence : word > 0 ? word : ANSWER_MAX_CHARS).trim();
}

// An answer rewritten by the AI from its saved text, in light of the project's idea: all four answers, plus a
// title the user or AI gave (an auto title is only the start of "who"). The page puts it in place (undoably),
// which saves it like typing; the session isn't changed here. Needs an account: each session gets the plan's
// reformulations per window.
router.post('/sessions/:id/answers/:branch/reformulate', metered('reformulations'), async (req, res) => {
  if (!usage.limitsOf(req).reformulations) {
    throw new ApiError(403, 'upgrade_required', 'Reformulating needs an account', { feature: 'reformulations' });
  }
  const session = await loadSession(req);
  const { branch } = req.params;
  if (!BRANCHES.includes(branch)) throw new ApiError(400, 'invalid_branch', 'branch must be one of who, what, how, why');
  const answers = session.answers.toObject ? session.answers.toObject() : session.answers;
  const original = (answers[branch] || '').trim();
  if (!original) throw new ApiError(422, 'no_answer', 'Write an answer first');
  const giveBack = await useAi(req, res, 'reformulations', session._id);
  const p = prompts.reformulateAnswer({
    language: session.language,
    branch,
    answers,
    title: session.titleSource === 'auto' ? '' : session.title,
    minChars: ANSWER_MIN_CHARS,
    maxChars: ANSWER_MAX_CHARS,
  });
  const out = await llm.chatJSON({ model: await modelFor(req, session), ...p });
  const answer = fitAnswer(out.answer);
  if (!answer) throw new llm.LLMError('invalid_json', 'The model returned no answer');
  if (answer === original) await giveBack(); // nothing changed: not counted
  req.meter.result = { changed: answer !== original };
  res.json({ answer, usage: req.usage });
});

// ---------------------------------------------------------------------------
// Guest sessions after login: the browser may still carry a guest from before, and on a shared computer
// its sessions may be someone else's. The signed-in user decides: move them to their account, or delete them.
// Either way the guest is then forgotten. These are the only queries by the guest's key while signed in.

router.use('/guest-sessions', requireDb, resolveOwner, (req, res, next) => {
  if (!req.user) throw new ApiError(401, 'not_signed_in', 'Log in first');
  next();
});

router.get('/guest-sessions', async (req, res) => {
  const guest = guestOwner(req);
  if (guest) await BrainstormSession.deleteMany({ owner: guest, ...BLANK }); // nothing in them worth moving
  const sessions = guest
    ? await BrainstormSession.find({ owner: guest, expiresAt: { $gt: new Date() } }, { title: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).lean()
    : [];
  if (!sessions.length) clearGuest(req, res); // nothing to decide (or an expired guest): forget it now
  res.json({ sessions });
});

// They stop expiring and keep their dates, so the list order stays the same
router.post('/guest-sessions/move', async (req, res) => {
  const guest = guestOwner(req);
  const r = guest
    ? await BrainstormSession.updateMany({ owner: guest, expiresAt: { $gt: new Date() } }, { $set: { owner: req.owner }, $unset: { expiresAt: 1 } }, { timestamps: false })
    : { modifiedCount: 0 };
  clearGuest(req, res);
  res.json({ moved: r.modifiedCount });
});

router.delete('/guest-sessions', async (req, res) => {
  const guest = guestOwner(req);
  const r = guest ? await BrainstormSession.deleteMany({ owner: guest }) : { deletedCount: 0 };
  clearGuest(req, res);
  res.json({ deleted: r.deletedCount });
});

// ---------------------------------------------------------------------------
// Words

router.post('/sessions/:id/expand', metered('words'), async (req, res) => {
  const session = await loadSession(req);
  const requested = Array.isArray(req.body?.branches) ? req.body.branches : BRANCHES;
  const branches = BRANCHES.filter((b) => requested.includes(b) && (session.answers?.[b] || '').trim());
  if (!branches.length) throw new ApiError(422, 'no_answers', 'Answer at least one question first');
  // Drafts may be short (autosave), but generation needs every answered branch to meet the minimum.
  if (branches.some((b) => answerLength(session.answers[b]) < ANSWER_MIN_CHARS)) {
    throw new ApiError(422, 'answer_too_short', `Each answer needs at least ${ANSWER_MIN_CHARS} characters (spaces not counted)`);
  }
  if (session.words.length >= MAX_WORDS) throw new ApiError(422, 'word_limit', `A session can hold at most ${MAX_WORDS} words`);
  const giveBack = await useAi(req, res, 'words');
  const model = await modelFor(req, session);

  const answers = session.answers.toObject ? session.answers.toObject() : session.answers;
  // All four answered and no AI title yet: suggest one alongside the words.
  const wantTitle = branches.length === BRANCHES.length && !hasAiTitle(session);
  const [results, title] = await Promise.all([
    Promise.allSettled(branches.map(async (branch) => {
      const existing = session.words.map((w) => w.text);
      const p = prompts.branchExpansion({ language: session.language, branch, answers, existing: existing.slice(0, 80) });
      const out = await llm.chatJSON({ model, ...p });
      return out.words;
    })),
    wantTitle ? suggestTitle(session, answers, model) : '',
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
  else await giveBack();
  req.meter.result = { branches: branches.length, words: added.length, title: !!title };
  res.json({ words: added, errors, title: title || null, usage: req.usage });
});

router.post('/sessions/:id/words', async (req, res) => {
  const session = await loadSession(req);
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
  const r = await BrainstormSession.updateOne(owned(req, { _id: req.params.id }), update[0], update[1]);
  if (!r.matchedCount) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ ok: true, branch: branch || null, selected });
});

router.patch('/sessions/:id/words/:wordId', async (req, res) => {
  const session = await loadSession(req);
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
  const session = await loadSession(req);
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

router.post('/sessions/:id/words/:wordId/expand', metered('expansions'), async (req, res) => {
  const session = await loadSession(req);
  const seed = findWord(session, req.params.wordId);
  if (session.words.length >= MAX_WORDS) throw new ApiError(422, 'word_limit', `A session can hold at most ${MAX_WORDS} words`);
  const giveBack = await useAi(req, res, 'expansions');
  const answers = session.answers.toObject ? session.answers.toObject() : session.answers;
  const existing = session.words.map((w) => w.text);
  const p = prompts.wordExpansion({ language: session.language, branch: seed.branch, seed: seed.text, answers, existing: existing.slice(0, 80) });
  const out = await llm.chatJSON({ model: await modelFor(req, session), ...p });
  const words = cleanWordList(out.words, wordKeys(session.words))
    .slice(0, 8)
    .slice(0, MAX_WORDS - session.words.length)
    .map((t) => newWord(seed.branch, t, 'llm', seed._id));
  if (words.length) await pushWords(session._id, words);
  else await giveBack();
  req.meter.result = { words: words.length };
  res.json({ words, usage: req.usage });
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
// checks each one and takes its letters. `calls` independent requests (the plan's composeCalls), sampled
// for variety. A failed request is skipped; if all fail, the error is thrown.
async function composePass({ session, answers, selected, opts, model, calls }) {
  const idMap = new Map();
  const idWords = selected.map((w, i) => {
    const id = `w${i + 1}`;
    idMap.set(id, w);
    return { id, branch: w.branch, text: w.text };
  });
  const p = prompts.composeNames({ language: session.language, answers, idWords, ...opts });
  const errors = [];
  const lists = await llm.mapLimit(Array.from({ length: calls }), llm.concurrency(), async () => {
    try {
      const out = await llm.chatJSON({ model, ...p });
      return Array.isArray(out.names) ? out.names.slice(0, 20) : [];
    } catch (err) {
      errors.push(err);
      return [];
    }
  });
  if (errors.length === calls) throw errors[0];
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
async function namePass({ session, answers, candidates, model }) {
  const errors = [];
  let answered = 0;
  let stop = false; // after a fatal error (LLM gone, timeout), skip the remaining calls
  const isWord = (w) => dictionary.isWord(session.language, w);
  const results = await llm.mapLimit(candidates, llm.concurrency(), async (c) => {
    if (stop) return null;
    try {
      const p = prompts.nameAcronym({ language: session.language, answers, candidate: c });
      const out = await llm.chatJSON({ model, ...p });
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
async function rankPass({ session, answers, candidates, model }) {
  let error = null;
  const batches = [];
  for (let i = 0; i < candidates.length; i += RANK_BATCH) batches.push(candidates.slice(i, i + RANK_BATCH));
  const ranked = await llm.mapLimit(batches, llm.concurrency(), async (batch) => {
    const byId = new Map();
    if (!error || !FATAL.has(error.code)) {
      try {
        const p = prompts.rankAcronyms({ language: session.language, answers, candidates: batch });
        const out = await llm.chatJSON({ model, ...p });
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

router.post('/sessions/:id/acronyms/generate', metered('runs'), async (req, res) => {
  const session = await loadSession(req);
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
  const plan = usage.limitsOf(req);
  if (opts.realWordsOnly && !plan.realWords) throw new ApiError(403, 'upgrade_required', '"Real words only" is for paid plans', { feature: 'realWords' });
  if (opts.allowChunks && !plan.chunks) throw new ApiError(403, 'upgrade_required', 'Letter chunks need an account', { feature: 'chunks' });
  req.meter.variant = opts.realWordsOnly ? 'realWords' : opts.allowChunks ? 'chunks' : 'default';
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
  const giveBack = await useAi(req, res, 'runs');
  const model = await modelFor(req, session);
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
      const pass = await namePass({ session, answers, candidates: shortlist, model });
      timings.nameMs = Date.now() - t0;
      if (!pass.answered && pass.errors.length) throw pass.errors[0];
      if (pass.errors.length) llmError = pass.errors[0];
      named = pass.named;
    }
  } else {
    // 1b. Default, name-first: the LLM writes full names, the code checks them and takes their letters
    const t0 = Date.now();
    const pass = await composePass({ session, answers, selected, opts, model, calls: plan.composeCalls });
    timings.composeMs = Date.now() - t0;
    if (pass.error) llmError = pass.error;
    named = fresh(pass.found);
    Object.assign(stats, { proposed: pass.proposed, valid: pass.found.length });
  }
  stats.named = named.length;

  // 2. LLM ranking: keeps names that make sense and describe the project (the plan's rankMax are scored, the rest dropped)
  let candidates = [];
  if (named.length) {
    const t0 = Date.now();
    const { ranked, error } = await rankPass({ session, answers, candidates: named.slice(0, plan.rankMax ?? named.length), model });
    timings.rankMs = Date.now() - t0;
    if (error) llmError = llmError || error;
    candidates = ranked;
  }

  // 3. Append, best first: each one's rank decides who sees it (usage.splitAcronyms)
  const room = MAX_ACRONYMS - session.acronyms.length;
  const acronyms = usage.rankRun(candidates).slice(0, room).map((c) => ({
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
    rank: c.rank,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  if (acronyms.length) {
    await BrainstormSession.updateOne({ _id: session._id }, { $push: { acronyms: { $each: acronyms } } });
  } else {
    await giveBack(); // a run that finds nothing doesn't count
  }

  const { visible, locked } = usage.splitAcronyms(acronyms, usage.planOf(req));
  // scored: sent to the scoring calls; kept: stored (the rest were rejected there); locked: kept but hidden
  req.meter.result = { named: named.length, scored: Math.min(named.length, plan.rankMax ?? named.length), kept: acronyms.length, visible: visible.length, locked };
  res.json({
    acronyms: visible,
    locked,
    usage: req.usage,
    llmError: llmError ? { error: llmError.code || 'llm_error', message: llmError.message } : null,
    stats: { ...stats, kept: acronyms.length, ...timings },
  });
});

router.patch('/sessions/:id/acronyms/:acronymId', async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.acronymId)) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  if (typeof req.body?.favorite !== 'boolean') throw new ApiError(400, 'invalid_favorite', 'favorite must be a boolean');
  const r = await BrainstormSession.updateOne(
    owned(req, { _id: req.params.id, 'acronyms._id': req.params.acronymId }),
    { $set: { 'acronyms.$.favorite': req.body.favorite } }
  );
  if (!r.matchedCount) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  res.json({ ok: true, favorite: req.body.favorite });
});

router.delete('/sessions/:id/acronyms/:acronymId', async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.acronymId)) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  const r = await BrainstormSession.updateOne(
    owned(req, { _id: req.params.id, 'acronyms._id': req.params.acronymId }),
    { $pull: { acronyms: { _id: req.params.acronymId } } }
  );
  if (!r.matchedCount) throw new ApiError(404, 'acronym_not_found', 'Acronym not found');
  res.json({ ok: true });
});

router.post('/sessions/:id/acronyms/clear', async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, 'session_not_found', 'Session not found');
  const r = await BrainstormSession.updateOne(owned(req, { _id: req.params.id }), { $pull: { acronyms: { favorite: { $ne: true } } } });
  if (!r.matchedCount) throw new ApiError(404, 'session_not_found', 'Session not found');
  res.json({ ok: true });
});

// Whether each acronym's .com, .net, .org and .io are registered (services/domains.js): ?ids=<acronym id>,…
// (the first DOMAIN_BATCH). Only this session's acronyms the viewer can see, others left out:
// { domains: { <acronym id>: [{ name, status }, …] } }
router.get('/sessions/:id/domains', async (req, res) => {
  const session = await loadSession(req);
  const ids = new Set(String(req.query.ids || '').split(',').filter(isId).slice(0, DOMAIN_BATCH));
  const { visible } = usage.splitAcronyms(session.acronyms, usage.planOf(req));
  const names = visible
    .filter((a) => ids.has(String(a._id)))
    .map((a) => [String(a._id), domains.domainsFor(a.letters)]);
  const statuses = await domains.check(names.flatMap(([, list]) => list));
  res.json({ domains: Object.fromEntries(names.map(([id, list]) => [id, list.map((name) => ({ name, status: statuses[name] }))])) });
});

// ---------------------------------------------------------------------------
// JSON 404 + error handler for everything under /api

router.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `No API route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (req.meter) req.meter.error = err.code || 'server_error';
  if (err instanceof ApiError || err instanceof llm.LLMError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
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
  { method: 'POST', path: '/sessions/:id/answers/:branch/reformulate', label: 'LLM rewrite of an answer (accounts)' },
  { method: 'GET', path: '/guest-sessions', label: 'Guest sessions left in this browser (signed in)' },
  { method: 'POST', path: '/guest-sessions/move', label: 'Move guest sessions to the account' },
  { method: 'DELETE', path: '/guest-sessions', label: 'Delete guest sessions' },
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
  { method: 'GET', path: '/sessions/:id/domains', label: 'Are each acronym’s .com/.net/.org/.io registered (RDAP)' },
];

module.exports = router;
