// Generate acronyms runs outlast what hosts allow a request (one took 130 s; many cut at 30–100 s), so a run goes
// on after its request is answered (routes/api.js) and the page polls it. Its state is the session's `run`
// (models/BrainstormSession.js), but its work lives in the memory of the server that started it, so:
//  - while a run goes on, its server beats every BEAT_MS (run.beatAt). A run whose beat is older than STALE_MS lost
//    its server (a crash, a kill): whichever request notices ends it as interrupted. This holds with any number of
//    servers, the new and old ones of a deploy included.
//  - a server asked to stop (SIGTERM, which hosts send on each deploy) takes no new run and gives the ones going a
//    grace period to end, then ends the rest as interrupted before it exits.
// A run ends once: done, failed and interrupted are each set only on a run still running, and only the request that
// ended it gives back what it hadn't delivered yet (run.counted: the usage windows each count went into).
const BrainstormSession = require('../models/BrainstormSession');
const usage = require('./usage');

const BEAT_MS = 15 * 1000;
const STALE_MS = 4 * BEAT_MS;

// Whether a session's run is marked running but its server stopped beating
const isStale = (run, now = Date.now()) => run?.status === 'running' && !(new Date(run.beatAt).getTime() >= now - STALE_MS);

// Ends session sessionId's run as interrupted and gives its count back: run runId (this server's own, at shutdown),
// or else the session's run if it's stale. Returns whether this call ended it.
async function interrupt(sessionId, runId = null) {
  const filter = runId
    ? { _id: sessionId, 'run._id': runId, 'run.status': 'running' }
    : { _id: sessionId, 'run.status': 'running', 'run.beatAt': { $not: { $gte: new Date(Date.now() - STALE_MS) } } };
  const before = await BrainstormSession.findOneAndUpdate(
    filter,
    { $set: { 'run.status': 'interrupted', 'run.finishedAt': new Date() } },
    { timestamps: false, projection: { run: 1 } }
  ).lean();
  for (const c of [].concat(before?.run?.counted || [])) await usage.giveBack(c.windows, c.path);
  return !!before;
}

// This server's runs going on: run id → { sessionId, done, onInterrupt }
const active = new Map();
let stopping = false;

const accepting = () => !stopping;

// Runs work() as run runId of session sessionId, beating while it goes. onInterrupt(): what else to do if shutdown()
// has to end it (save its AI action).
async function keep(sessionId, runId, work, onInterrupt) {
  const beat = setInterval(() => {
    BrainstormSession.updateOne(
      { _id: sessionId, 'run._id': runId, 'run.status': 'running' },
      { $set: { 'run.beatAt': new Date() } },
      { timestamps: false }
    ).catch((err) => console.error('[runs] beat:', err.message));
  }, BEAT_MS);
  const done = work();
  active.set(String(runId), { sessionId, done, onInterrupt });
  try {
    return await done;
  } finally {
    clearInterval(beat);
    active.delete(String(runId));
  }
}

// Takes no new run, gives this server's runs up to graceMs to end, then ends the rest as interrupted
async function shutdown(graceMs) {
  stopping = true;
  if (active.size) {
    await Promise.race([
      Promise.allSettled([...active.values()].map((r) => r.done)),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }
  await Promise.all([...active].map(async ([runId, r]) => {
    if (await interrupt(r.sessionId, runId)) await r.onInterrupt();
  }));
}

module.exports = { BEAT_MS, STALE_MS, isStale, interrupt, keep, accepting, shutdown };
