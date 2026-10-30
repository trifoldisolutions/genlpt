const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Acronym runs, end to end: the real API router on a throwaway database (genlpt_test, emptied before and after),
// with a fake OpenRouter. Skipped without a MongoDB at TEST_MONGO_URI (default: the local one).
const MONGO = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
const TEST_DB = 'genlpt_test';

// The fake answers every call after fake.delay ms, or fails them all (fake.fail)
const fake = { delay: 0, fail: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each words call gets the next of these lists, so concurrent branches never share one
const WORD_LISTS = [
  ['Students', 'Teachers', 'Parents'], ['Learning', 'Research', 'Reading'], ['Online', 'Together', 'Locally'],
  ['Growth', 'Success', 'Inclusion'], ['Library', 'Classroom', 'Museum'], ['Freedom', 'Justice', 'Wisdom'],
];
let wordCalls = 0;

// Rank: keeps them all, scored in order. Compose: one name per mix of a word from each branch, connected by "for".
// Anything else (words, title): a word list and a title, each prompt reading the key it asks for.
function answerFor(messages) {
  const text = messages.map((m) => m.content).join('\n');
  const ids = [...text.matchAll(/^(a\d+) /gm)].map((m) => m[1]);
  if (ids.length) return { results: ids.map((id, i) => ({ id, keep: true, score: 90 - i, rationale: 'Fits.', tagline: 'A tagline.' })) };
  const groups = [];
  for (const line of text.split('\n')) {
    if (/^\[.+\]$/.test(line.trim())) groups.push([]);
    const m = line.match(/^(w\d+): (.+)$/);
    if (m && groups.length) groups[groups.length - 1].push({ id: m[1], text: m[2] });
  }
  if (!groups.length) return { words: WORD_LISTS[wordCalls++ % WORD_LISTS.length], title: 'Reading Buddies' };
  let mixes = [[]];
  for (const group of groups.filter((g) => g.length)) mixes = mixes.flatMap((mix) => group.map((w) => [...mix, w])).slice(0, 20);
  const names = mixes.map((mix) => ({
    fullName: `${mix.slice(0, -1).map((w) => w.text).join(' ')} for ${mix[mix.length - 1].text}`,
    ids: mix.map((w) => w.id),
  }));
  return { names };
}

const fakeServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url.endsWith('/key')) return send(200, { data: {} });
  await sleep(fake.delay);
  if (fake.fail) return send(500, { error: { message: 'fake failure' } });
  const content = JSON.stringify(answerFor(JSON.parse(raw).messages));
  send(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 } });
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// One guest (their own cookies) calling the API
function guest(base) {
  const jar = new Map();
  return async (method, path, body) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, data: await res.json() };
  };
}

const OPTS = { minLength: 3, maxLength: 6, maxPerBranch: 1 };
const WORDS = { who: ['Students', 'Teachers'], what: ['Learning', 'Research'], how: ['Online', 'Together'], why: ['Growth', 'Success'] };

// Every answer past the 100-character minimum, so all four branches get words (and the session its AI title)
const ANSWER = 'A reading program that pairs volunteer students with refugee children every week, at school and at the public library nearby.';

async function sessionWithAnswers(api) {
  const { data } = await api('POST', '/sessions', { language: 'en' });
  const id = data.session._id;
  const r = await api('PATCH', `/sessions/${id}`, { answers: { who: ANSWER, what: ANSWER, how: ANSWER, why: ANSWER } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return id;
}

async function sessionWithWords(api) {
  const { data } = await api('POST', '/sessions', { language: 'en' });
  const id = data.session._id;
  for (const [branch, list] of Object.entries(WORDS)) {
    for (const text of list) assert.equal((await api('POST', `/sessions/${id}/words`, { branch, text })).status, 201);
  }
  return id;
}

// Asks about a run until it's over, as the page does
async function poll(api, id, runId) {
  for (let i = 0; i < 200; i++) {
    const r = await api('GET', `/sessions/${id}/acronyms/runs/${runId}`);
    if (!(r.status === 200 && r.data.status === 'running')) return r;
    await sleep(25);
  }
  throw new Error('the run never ended');
}

test('a run is stale once marked running with no beat for STALE_MS', () => {
  const runs = require('../services/runs');
  const now = Date.now();
  assert.equal(runs.isStale(null, now), false);
  assert.equal(runs.isStale({ status: 'done', beatAt: new Date(0) }, now), false);
  assert.equal(runs.isStale({ status: 'running', beatAt: new Date(now - runs.BEAT_MS) }, now), false);
  assert.equal(runs.isStale({ status: 'running', beatAt: new Date(now - runs.STALE_MS - 1) }, now), true);
  assert.equal(runs.isStale({ status: 'running' }, now), true); // never beat
});

test('acronym runs: answered at once, polled to the end, and ended once however they end', { timeout: 60000 }, async (t) => {
  const fakePort = await listen(fakeServer);
  process.env.OPENROUTER_URL = `http://127.0.0.1:${fakePort}/api/v1`;
  process.env.OPENROUTER_GENLPT_GUEST = 'test-key';
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(MONGO, { dbName: TEST_DB, serverSelectionTimeoutMS: 1500 });
  } catch {
    fakeServer.close();
    t.skip(`no MongoDB at ${MONGO}`);
    return;
  }
  await mongoose.connection.dropDatabase();
  const express = require('express');
  const BrainstormSession = require('../models/BrainstormSession');
  const AiAction = require('../models/AiAction');
  const runs = require('../services/runs');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/api'));
  const server = http.createServer(app);
  const base = `http://127.0.0.1:${await listen(server)}`;
  const actions = async (id, n) => {
    for (let i = 0; i < 40; i++) {
      const list = await AiAction.find({ sessionId: id }).sort({ createdAt: 1 }).lean();
      if (list.length >= n) return list;
      await sleep(25);
    }
    return AiAction.find({ sessionId: id }).lean();
  };

  try {
    await t.test('the request answers at once; the run goes on, one at a time, and its result is polled', async () => {
      fake.delay = 300;
      const api = guest(base);
      const id = await sessionWithWords(api);
      const started = Date.now();
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      assert.equal(r.status, 202);
      assert.equal(r.data.run.status, 'running');
      assert.ok(Date.now() - started < fake.delay, 'answered before the first LLM call could end');
      const runId = r.data.run._id;

      const again = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      assert.equal(again.status, 409);
      assert.equal(again.data.error, 'run_in_progress');
      assert.deepEqual(again.data.run, { _id: runId, status: 'running', phase: 'acronyms' }, 'the run to wait for instead');

      const during = (await api('GET', `/sessions/${id}`)).data.session;
      assert.deepEqual(during.run, { _id: runId, status: 'running', phase: 'acronyms' }, 'only its id, status and phase reach the page');
      assert.equal(during.acronyms.length, 0);

      const done = await poll(api, id, runId);
      assert.equal(done.status, 200);
      assert.equal(done.data.status, 'done');
      assert.equal(done.data.acronyms.length, 3, 'a guest sees 3 per run');
      assert.ok(done.data.locked > 0);
      assert.equal(done.data.usage.runs.used, 1, 'counted once: the refused second start was given back');

      const after = (await api('GET', `/sessions/${id}`)).data.session;
      assert.equal(after.run.status, 'done');
      assert.deepEqual(after.acronyms.map((a) => a._id), done.data.acronyms.map((a) => a._id));
      assert.equal(after.lockedAcronyms, done.data.locked);
      assert.ok(after.lastRunAt);

      const [action] = await actions(id, 1);
      assert.equal(action.status, 200);
      assert.equal(action.counted, true);
      assert.equal(action.calls.length, 2, 'compose and rank, metered after the answer');
      assert.ok(action.ms >= 2 * fake.delay);
    });

    await t.test('a failed run answers the error its request would have had, and is given back', async () => {
      fake.delay = 0;
      fake.fail = true;
      const api = guest(base);
      const id = await sessionWithWords(api);
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      const failed = await poll(api, id, r.data.run._id);
      fake.fail = false;
      assert.equal(failed.status, 502);
      assert.equal(failed.data.error, 'llm_error');
      assert.equal((await api('GET', '/usage')).data.usage.runs.used, 0);
      const [action] = await actions(id, 1);
      assert.equal(action.status, 502);
      assert.equal(action.counted, false);
    });

    await t.test('a run whose server stopped beating is ended as interrupted, given back, and frees the session', async () => {
      fake.delay = 500;
      const api = guest(base);
      const id = await sessionWithWords(api);
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      const runId = r.data.run._id;
      await BrainstormSession.updateOne({ _id: id }, { $set: { 'run.beatAt': new Date(Date.now() - runs.STALE_MS - 1000) } });

      assert.equal((await api('GET', `/sessions/${id}`)).data.session.run.status, 'interrupted', 'opening the session ends it');
      assert.equal((await api('GET', '/usage')).data.usage.runs.used, 0);
      const gone = await api('GET', `/sessions/${id}/acronyms/runs/${runId}`);
      assert.equal(gone.status, 503);
      assert.equal(gone.data.error, 'run_interrupted');

      // Its work, still going here, can't end it a second time: no acronyms, no second give-back
      await sleep(3 * fake.delay);
      const session = await BrainstormSession.findById(id).lean();
      assert.equal(session.run.status, 'interrupted');
      assert.equal(session.acronyms.length, 0);
      assert.equal((await api('GET', '/usage')).data.usage.runs.used, 0);
      const [action] = await actions(id, 1);
      assert.equal(action.status, 503);
      assert.equal(action.error, 'run_interrupted');
      assert.equal(action.counted, false);

      fake.delay = 0;
      const next = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      assert.equal(next.status, 202, 'the session takes a new run');
      assert.equal((await poll(api, id, next.data.run._id)).data.status, 'done');
    });

    await t.test('"Get acronyms" makes the words then the acronyms as one job, which a second tab waits for', async () => {
      fake.delay = 200;
      const api = guest(base);
      const id = await sessionWithAnswers(api);
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, { ...OPTS, words: true });
      assert.equal(r.status, 202);
      assert.equal(r.data.run.phase, 'words');
      const runId = r.data.run._id;
      const second = await api('POST', `/sessions/${id}/acronyms/generate`, { ...OPTS, words: true });
      assert.equal(second.status, 409, 'no second batch of words');
      assert.deepEqual(second.data.run, { _id: runId, status: 'running', phase: 'words' });

      const phases = new Set();
      let done;
      for (let i = 0; i < 200 && !done; i++) {
        const p = await api('GET', `/sessions/${id}/acronyms/runs/${runId}`);
        if (p.data.status === 'running') phases.add(p.data.phase);
        else done = p;
        await sleep(25);
      }
      assert.deepEqual([...phases], ['words', 'acronyms']);
      assert.equal(done.data.status, 'done');
      assert.ok(done.data.acronyms.length > 0);
      assert.equal(done.data.noWords, false);

      const session = (await api('GET', `/sessions/${id}`)).data.session;
      assert.equal(session.words.length, 12, 'one batch: 3 words a branch');
      assert.equal(session.title, 'Reading Buddies');
      const lastRun = new Date(session.lastRunAt).getTime();
      assert.ok(session.words.every((w) => parseInt(w._id.slice(0, 8), 16) * 1000 <= lastRun), 'none count as new since the run');
      const { usage: u } = (await api('GET', '/usage')).data;
      assert.deepEqual([u.words.used, u.runs.used], [1, 1]);
      const list = await actions(id, 2);
      assert.deepEqual(list.map((a) => [a.kind, a.status, a.counted]).sort(), [['runs', 200, true], ['words', 200, true]]);
    });

    await t.test('"Get acronyms" cut off during its words gives back both counts and adds no words', async () => {
      fake.delay = 500;
      const api = guest(base);
      const id = await sessionWithAnswers(api);
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, { ...OPTS, words: true });
      await BrainstormSession.updateOne({ _id: id }, { $set: { 'run.beatAt': new Date(Date.now() - runs.STALE_MS - 1000) } });
      const cut = await api('GET', `/sessions/${id}/acronyms/runs/${r.data.run._id}`);
      assert.equal(cut.data.error, 'run_interrupted');
      await sleep(3 * fake.delay); // its words come back here, too late to be kept
      assert.equal((await BrainstormSession.findById(id).lean()).words.length, 0);
      const { usage: u } = (await api('GET', '/usage')).data;
      assert.deepEqual([u.words.used, u.runs.used], [0, 0]);
    });

    await t.test('"Get acronyms" whose acronyms fail keeps its words, counted, and gives the run back', async () => {
      fake.delay = 0;
      const api = guest(base);
      const id = await sessionWithAnswers(api);
      // One word a branch can't give 8 letters: found out once the words are there
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, { minLength: 8, maxLength: 8, maxPerBranch: 1, words: true });
      assert.equal(r.status, 202);
      const failed = await poll(api, id, r.data.run._id);
      assert.equal(failed.status, 422);
      assert.equal(failed.data.error, 'length_unreachable');
      assert.equal((await api('GET', `/sessions/${id}`)).data.session.words.length, 12);
      const { usage: u } = (await api('GET', '/usage')).data;
      assert.deepEqual([u.words.used, u.runs.used], [1, 0]);
    });

    await t.test('runs are only seen by their owner', async () => {
      const api = guest(base);
      const id = await sessionWithWords(api);
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      await poll(api, id, r.data.run._id);
      assert.equal((await guest(base)('GET', `/sessions/${id}/acronyms/runs/${r.data.run._id}`)).status, 404);
      const bad = await api('GET', `/sessions/${id}/acronyms/runs/nope`);
      assert.equal(bad.status, 404);
      assert.equal(bad.data.error, 'run_not_found');
    });

    // Last: the server stays stopping
    await t.test('a stopping server ends the runs past its grace period, gives them back, and starts no new one', async () => {
      fake.delay = 1000;
      const api = guest(base);
      const id = await sessionWithWords(api);
      const r = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      await runs.shutdown(100);
      const cut = await api('GET', `/sessions/${id}/acronyms/runs/${r.data.run._id}`);
      assert.equal(cut.status, 503);
      assert.equal(cut.data.error, 'run_interrupted');
      assert.equal((await api('GET', '/usage')).data.usage.runs.used, 0);
      const refused = await api('POST', `/sessions/${id}/acronyms/generate`, OPTS);
      assert.equal(refused.status, 503);
      assert.equal(refused.data.error, 'server_restarting');
      await sleep(3 * fake.delay); // its work ends here before the database goes
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.close();
    fakeServer.close();
  }
});
