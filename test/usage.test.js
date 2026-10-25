const test = require('node:test');
const assert = require('node:assert/strict');
const { planOf, toView, rankRun, splitAcronyms } = require('../services/usage');
const { PLAN_LIMITS } = require('../config/limits');
const { reformulateAnswer, QUESTIONS } = require('../services/llm/prompts');

const HOUR = 60 * 60 * 1000;

test('the plan comes from the account: none is a guest, admin is a role and gets its plan', () => {
  assert.equal(planOf({ user: null }), 'guest');
  assert.equal(planOf({ user: { plan: 'free' } }), 'free');
  assert.equal(planOf({ user: { plan: 'paid' } }), 'paid');
  assert.equal(planOf({ user: { plan: 'free', role: 'admin' } }), 'free');
});

test('limits grow with the plan', () => {
  const { guest, free, paid } = PLAN_LIMITS;
  for (const k of ['runs', 'words', 'expansions', 'composeCalls']) {
    assert.ok(guest[k] < free[k] && free[k] < paid[k], k);
  }
  assert.deepEqual([guest.shown, free.shown, paid.shown], [3, 6, null]);
  assert.deepEqual([guest.realWords, free.realWords, paid.realWords], [false, false, true]);
  assert.deepEqual([guest.chunks, free.chunks, paid.chunks], [false, true, true]);
  assert.deepEqual([guest.allModels, free.allModels, paid.allModels], [false, true, true]);
  // Reformulating needs an account, and then every account gets the same share per session
  assert.deepEqual([guest.reformulations, free.reformulations, paid.reformulations], [0, 5, 5]);
});

test('reformulations are counted per session, in the open window only', () => {
  const now = Date.now();
  const window = { expiresAt: new Date(now + HOUR), runs: 0, reformulations: { s1: 2, s2: 5 } };
  assert.deepEqual(toView('free', window, now).reformulations, { used: { s1: 2, s2: 5 }, limit: 5 });
  assert.deepEqual(toView('free', { ...window, expiresAt: new Date(now - 1) }, now).reformulations, { used: {}, limit: 5 });
  // A window opened before reformulations existed
  assert.deepEqual(toView('paid', { expiresAt: new Date(now + HOUR), runs: 1 }, now).reformulations, { used: {}, limit: 5 });
  assert.deepEqual(toView('guest', null, now).reformulations, { used: {}, limit: 0 });
});

test('the reformulation prompt rewrites one answer from the project idea: all answers, plus the title if any', () => {
  const answers = { who: 'A naming tool', what: 'it make acronym for project', how: '', why: '' };
  for (const language of ['fr', 'en']) {
    const p = reformulateAnswer({ language, branch: 'what', answers, title: 'Acronym Studio', minChars: 100, maxChars: 500 });
    assert.ok(p.user.includes('A naming tool'), language); // another answer, as context
    assert.ok(p.user.includes('it make acronym for project'), language);
    assert.ok(p.user.includes(QUESTIONS[language].what), language);
    assert.ok(p.user.includes('Acronym Studio'), language);
    assert.ok(/150\D+450/.test(p.user), language); // past the minimum, under the cap
    assert.ok(p.user.includes('{"idea": "...", "answer": "..."}'), language);
    assert.ok(!reformulateAnswer({ language, branch: 'what', answers, minChars: 100, maxChars: 500 }).user.includes('Acronym Studio'));
  }
});

test('the view counts the open window, and nothing before it opens or after it ends', () => {
  const now = Date.now();
  const window = { expiresAt: new Date(now + HOUR), runs: 1, words: 2, expansions: 0 };
  const open = toView('guest', window, now);
  assert.equal(open.plan, 'guest');
  assert.deepEqual(open.runs, { used: 1, limit: 2 });
  assert.deepEqual(open.words, { used: 2, limit: 4 });
  assert.equal(open.resetAt, window.expiresAt);

  const none = toView('free', null, now);
  assert.deepEqual(none.runs, { used: 0, limit: 5 });
  assert.equal(none.resetAt, null);

  const ended = toView('guest', { ...window, expiresAt: new Date(now - 1) }, now);
  assert.deepEqual(ended.runs, { used: 0, limit: 2 });
  assert.equal(ended.resetAt, null);
});

test('a run is ranked best first: score, unscored last, then the engine score', () => {
  const ranked = rankRun([
    { letters: 'C', score: null, engineScore: 9 },
    { letters: 'A', score: 80, engineScore: 1 },
    { letters: 'B', score: 80, engineScore: 5 },
    { letters: 'D', score: 20 },
  ]);
  assert.deepEqual(ranked.map((c) => `${c.letters}${c.rank}`), ['B0', 'A1', 'D2', 'C3']);
});

test('each plan sees its share of every run; the rest is only counted', () => {
  const run = (n) => Array.from({ length: n }, (_, rank) => ({ rank }));
  const acronyms = [...run(10), ...run(4)]; // two runs
  assert.deepEqual(
    [splitAcronyms(acronyms, 'guest').locked, splitAcronyms(acronyms, 'free').locked, splitAcronyms(acronyms, 'paid').locked],
    [14 - 6, 14 - 10, 0]
  );
  assert.equal(splitAcronyms(acronyms, 'guest').visible.length, 6);
});

test('acronyms from before ranks existed stay visible', () => {
  assert.deepEqual(splitAcronyms([{ letters: 'OLD' }, { rank: 7 }], 'guest'), { visible: [{ letters: 'OLD' }], locked: 1 });
});
