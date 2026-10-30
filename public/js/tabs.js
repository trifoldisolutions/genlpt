// One tab per session, in this browser. Tabs tell each other which session they have open (BroadcastChannel):
// opening one that another tab has makes this tab stand aside ("open in another tab"); Use here takes it over, and
// the other tab saves its pending edits, then stands aside in turn. Two tabs on one session would each run their
// own AI actions on it (twice the cost, words repeated) and save over each other's edits.
// Another browser or device isn't seen: the server's one-job-per-session lock covers those (services/runs.js).

const ASK_MS = 100; // how long opening a session waits for another tab to say it has it (they answer in a few ms)
const RELEASE_MS = 3000; // how long Use here waits for the other tab to save and let go

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// release(): saves what this tab hasn't yet, before it lets a session go. onLost(sid): this tab no longer has sid.
export function sessionTabs({ release, onLost }) {
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('genlpt-session-tabs') : null;
  const me = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  let held = null; // the session this tab has
  let asking = null; // { sid, at, taken } while this tab asks whether another one has sid
  const releases = new Map(); // sid → resolve, while Use here waits for the other tab

  const post = (message) => channel?.postMessage({ ...message, from: me });
  const lose = (sid) => {
    held = null;
    onLost(sid);
  };

  channel?.addEventListener('message', async ({ data: m }) => {
    if (m.type === 'ask') {
      // This tab has it, or asked for it first (two tabs opening it at once, like a restored window): it stays here
      const first = asking?.sid === m.sid && (asking.at < m.at || (asking.at === m.at && me < m.from));
      if (held === m.sid || first) post({ type: 'mine', sid: m.sid, to: m.from });
    } else if (m.type === 'mine' && m.to === me) {
      if (asking?.sid === m.sid) asking.taken = true;
      else if (held === m.sid) lose(m.sid); // this tab asked again on coming back (see below): the other one has it now
    } else if (m.type === 'take' && held === m.sid) {
      await release();
      lose(m.sid);
      post({ type: 'released', sid: m.sid, to: m.from });
    } else if (m.type === 'released' && m.to === me) {
      releases.get(m.sid)?.();
    }
  });

  // A tab the browser froze in the background missed the others' asks: coming back, it checks it still has its session
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && held) post({ type: 'ask', sid: held, at: Date.now() });
  });

  return {
    // Opening session sid: true if this tab has it now, false if another tab does
    async claim(sid) {
      if (!channel || held === sid) {
        held = sid;
        return true;
      }
      held = null;
      const ask = { sid, at: Date.now(), taken: false };
      asking = ask;
      post({ type: 'ask', sid, at: ask.at });
      await sleep(ASK_MS);
      if (asking !== ask) return !ask.taken; // another session was opened meanwhile
      asking = null;
      if (!ask.taken) held = sid;
      return !ask.taken;
    },
    // Use here: the tab that has sid saves and lets go (or doesn't answer in time: it was closed, or is frozen)
    async take(sid) {
      if (channel) {
        const released = new Promise((resolve) => {
          releases.set(sid, resolve);
          setTimeout(resolve, RELEASE_MS);
        });
        post({ type: 'take', sid });
        await released;
        releases.delete(sid);
      }
      held = sid;
    },
  };
}
