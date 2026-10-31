// Answer length limits for the four "Describe" questions (shared with the client via <body> data attributes).
// min counts characters excluding whitespace; max counts every character (matches the textarea maxlength).
const ANSWER_MIN_CHARS = 100;
const ANSWER_MAX_CHARS = 500;

const answerLength = (value) => String(value || '').replace(/\s/g, '').length;

// How many layers "Expand" can add under a branch's own words (shared with the client like the answer limits).
// With 2: Network → Grid → Cells, and Cells can't be expanded. Each layer drifts further from the project.
const EXPAND_DEPTH = 2;

// A guest (no account) is erased after this long without activity (any request on their sessions pushes it
// back); their next session then starts a new guest.
const GUEST_HOURS = 3;

// AI usage, Anthropic-style: a window opens on someone's first AI action and everything resets
// USAGE_WINDOW_HOURS later. Per window, by plan (admin is a role, not a plan: admins get their plan's limits):
//   runs        "Generate acronyms"
//   words       "Generate words" and a branch's "More words"
//   expansions  a word's "Expand"
//   reformulations  an answer's "Reformulate with AI", counted per session (0: guests need an account)
//   shown      acronyms visible per run, best first; the rest are kept but locked until an upgrade (null: all)
//   composeCalls, rankMax  the AI work in one run: requests for names, and how many of those get scored (null: all)
//   realWords   "Real words only" (up to ~40 AI calls a run)
//   chunks      "Allow letter chunks"
//   allModels   false: only the cheapest listed model
const USAGE_WINDOW_HOURS = 5;
const PLAN_LIMITS = {
  guest: { runs: 2, words: 4, expansions: 10, reformulations: 0, shown: 3, composeCalls: 1, rankMax: 12, realWords: false, chunks: false, allModels: false },
  free: { runs: 5, words: 10, expansions: 30, reformulations: 5, shown: 6, composeCalls: 2, rankMax: 24, realWords: false, chunks: true, allModels: true },
  paid: { runs: 30, words: 60, expansions: 200, reformulations: 5, shown: null, composeCalls: 3, rankMax: null, realWords: true, chunks: true, allModels: true },
};
// Guests are also counted per IP: clearing cookies makes a new guest, not new runs. Room for a few people on one IP.
const GUEST_IP_LIMITS = { runs: 6, words: 12, expansions: 30 };

// What the whole platform may spend on AI in a day (USD, every plan together; days run midnight to midnight UTC).
// Past a plan's pause line its AI actions are refused until the next day: guests first, then free accounts. Paid
// accounts are never paused here (their own OpenRouter key's credit limit caps them). The first time a day's spend
// crosses the warning or a pause line, an email goes to ALERT_EMAIL (or, without it, every admin).
const DAILY_SPEND = {
  warning: 30,
  pause: { guest: 40, free: 50 },
};

// A signed-in user stays logged in this long after their last visit.
const LOGIN_DAYS = 30;

// New passwords (signup, reset): at least PASSWORD_MIN_EACH of each kind of character, so 12 characters at least
// (the kinds don't overlap). public/js/password.js counts them, for the page and the server alike; symbol:
// punctuation and symbols, not spaces. Existing passwords keep working: logging in checks only the max. The max
// only keeps hashing cheap (argon2 takes any length).
const PASSWORD_MIN_EACH = { lower: 3, upper: 3, digit: 3, symbol: 3 };
const PASSWORD_MAX_CHARS = 200;

// Links in account emails: how long each stays valid (each works once, and a newer one replaces it).
const VERIFY_LINK_HOURS = 24;
const RESET_LINK_HOURS = 1;
// An account whose email is never confirmed is deleted after this long.
const UNVERIFIED_DAYS = 7;

// Settings → Help center's contact form: a message's length, in characters (spaces count)
const SUPPORT_MESSAGE_MIN_CHARS = 20;
const SUPPORT_MESSAGE_MAX_CHARS = 2000;

// At most `limit` hits per window of `minutes`. Ip: per connection. Email: per address typed, account or not,
// so a limit never hints at whether an account exists. Mail: account emails one address can receive,
// whatever triggered them; past it nothing is sent, silently (the page stays the same). Support: messages from
// Help center, per connection and per account.
const RATE_LIMITS = {
  loginIp: { limit: 20, minutes: 15 },
  loginEmail: { limit: 10, minutes: 15 },
  signupIp: { limit: 10, minutes: 60 }, // signups and "Send a new email"
  forgotIp: { limit: 10, minutes: 60 },
  mailHour: { limit: 3, minutes: 60 },
  mailDay: { limit: 10, minutes: 24 * 60 },
  supportHour: { limit: 5, minutes: 60 },
  supportDay: { limit: 10, minutes: 24 * 60 },
};

module.exports = {
  ANSWER_MIN_CHARS,
  ANSWER_MAX_CHARS,
  answerLength,
  EXPAND_DEPTH,
  GUEST_HOURS,
  USAGE_WINDOW_HOURS,
  PLAN_LIMITS,
  GUEST_IP_LIMITS,
  DAILY_SPEND,
  LOGIN_DAYS,
  PASSWORD_MIN_EACH,
  PASSWORD_MAX_CHARS,
  VERIFY_LINK_HOURS,
  RESET_LINK_HOURS,
  UNVERIFIED_DAYS,
  SUPPORT_MESSAGE_MIN_CHARS,
  SUPPORT_MESSAGE_MAX_CHARS,
  RATE_LIMITS,
};
