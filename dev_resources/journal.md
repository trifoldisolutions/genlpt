# Project Journal

<!--
Entry template:

## YYYY-MM-DD
- **HH:MM** — What changed
-->

## 2026-10-25
- **09:24** — Fixed body-parser DoS (GHSA-27r3-jxmh-p828) via npm audit fix: 2.3.0 → 2.4.0. A gzip body with trailing bytes can no longer crash the server.
  - Modified: `package-lock.json`
- **09:24** — npm audit fix also patched dev-only shell-quote (concurrently), source-map-js (Tailwind CLI) and qs. npm audit: 0 issues; 83 tests pass.
  - Modified: `package-lock.json`

## 2026-10-24
- **19:15** — Domain badge row: scrollbar hidden; it still scrolls sideways by touch, trackpad or shift+wheel.
- **19:15** — Domain badges on acronym cards sit on one line, scrolling sideways (thin scrollbar) when they don't fit.
- **19:04** — Acronym cards now show only once their domain check is back; a failed check still shows the card (no badges), rechecked later.
- **19:04** — A run's button stays busy ("Checking domains…") until its acronyms' domains are checked, then the new cards appear together.
- **18:56** — Acronym cards from the latest run get a New tag (not on a session's first run); cleared by the next run or leaving the session.

## 2026-10-23
- **00:15** — Options dropdown: darker border (zinc-400/70) and a two-layer shadow so it stands out from the cards behind it.
- **00:15** — Stepper is now a flex row: fixed-width steps with flex-1 lines between, so it spreads to the panel's edges.
- **00:07** — Acronym Options is now a dropdown floating over the list (z-20); closes on Escape, outside click or tabbing out.
- **00:00** — Fresh session: Describe's button is now Get acronyms; one click makes words, then acronyms, and lands on the Acronyms step.
- **00:00** — Generate acronyms moved to a footer pinned under Explore and Acronyms, with runs left; acronym settings fold into Options.
- **00:00** — First run raises words per branch (up to 3) when 1-2 answered questions can't reach the min length; length errors open Options.

## 2026-10-22
- **13:24** — Domain badges now also check .net, .org (PIR) and .io (Identity Digital RDAP, not in the IANA list); one badge per extension.
- **13:24** — Domain badges: name only, red with a cross when taken, green with a check when free; bigger text; shown under the full name.
- **13:24** — Domain checks: 10 acronyms per request (40 lookups); 1 new test (83 passing).
- **13:09** — Acronym cards now show if their .com is free, via the registry's RDAP server (Verisign): free, no key; 404 = free, 200 = taken.
- **13:09** — GET /api/sessions/:id/domains checks up to 20 visible acronyms; answers kept in domain_checks (taken 24 h, free 1 h).
- **13:09** — Added 3 RDAP tests (82 passing).
- **12:08** — Usage meter: each AI call now records tokens (in, out, reasoning, cached), cost and time; one ai_actions record per click, kept a year.
- **12:08** — npm run usage:report adds a dated report to dev_resources/usage_reports.md: per step, per click, waste, window, month and paid price.
- **12:08** — Report assumptions (usage levels, free users per paying one, card fees, margin) live in config/pricing.js. Untested plans show — not $0.
- **12:08** — Five test briefs in dev_resources/test_briefs.md; a confirmed paid test account added to the dev database. 79 tests pass.
- **11:28** — Reformulate now works from the project idea: the AI sums it up from all 4 answers (and a set title), then rewrites the answer for its question.
- **11:28** — Reformulated answers aim for 150–450 characters, so they clear the minimum; no new facts, shorter rather than invented.
- **08:56** — Reformulate with AI under each answer now works: rewrites the saved answer clearly, keeps its facts; replaces the text undoably (Ctrl+Z).
- **08:56** — Reformulate is off for guests (sign up). Accounts get 5 per session per 5 h usage window, free and paid alike; unchanged rewrites don’t count.
- **08:56** — New POST /api/sessions/:id/answers/:branch/reformulate; counts live per session in the owner’s usage window. 69 tests pass.

## 2026-10-03
- **14:57** — Email verification via Resend: signup no longer logs in; a single-use link (24 h) confirms the address. Unconfirmed accounts go after 7 days.
- **14:57** — Signup, resend and forgot-password show the same page whether or not the email has an account; login takes as long either way.
- **14:57** — Password reset: link valid 1 h, works once; saving confirms the email and logs out other devices. Email links open a page; only its button acts.
- **14:57** — Rate limits (MongoDB counters) on login, signup and reset, per IP and per email; at most 3 account emails per address per hour.
- **14:57** — Review fixes: no 500 on empty posts, proxy-safe origin check, TRUST_PROXY validated, guest dialog reports real counts. /admin: admins only.
- **14:57** — New: npm run set-role -- <email> admin. APP_URL + EMAIL_FROM in .env. Draft copy in account_copy.md. 59 tests and 31 e2e checks pass.
- **14:28** — Agreed wording for the "email already registered" notice saved in dev_resources/account_copy.md, for task D1JUJC.
- **13:57** — Accounts live: User model (argon2id passwords, role kept apart from plan); login/signup/logout pages work; logins stored in MongoDB.
- **13:57** — Logging in leaves the guest alone: the app asks to move its sessions to the account or delete them (they may be someone else's).
- **13:57** — Moved sessions stop expiring and keep their dates. Logout clears the guest cookie, so the next person on the browser starts fresh.
- **13:57** — Auth forms refuse cross-site posts (login CSRF). New /api/guest-sessions routes. 52 tests passing; full flow checked end to end.

## 2026-10-02
- **12:06** — Guests last 3 h from their first session: cookie "<random>.<start ms>" is refused after 3 h; their next session starts a new guest.
- **12:06** — Guest sessions get expiresAt; a MongoDB TTL index erases them when the 3 h are up (tested: deleted within a minute).
- **12:06** — No guest cookie until a visitor creates a session. Guest length is GUEST_HOURS in config/limits.js.
- **12:06** — Sidebar shows "Erased at HH:MM" under Guest; when time is up the page clears and says so. 47 tests passing.
- **08:42** — Sessions now have an owner: "guest:<hash>" from a random httpOnly guest_id cookie, or "user:<id>" once auth sets req.user.
- **08:42** — Every /api/sessions query is scoped to its owner; another owner's session answers 404. Owner key never sent to clients.
- **08:42** — New middleware/owner.js (+4 tests, 43 passing). At login, guest sessions should be reassigned to the user (noted in file).
- **03:20** — MongoDB database renamed project_acronym_maker → genlpt (server.js dbName, .env, .env.example). No data existed to migrate.
- **03:20** — .env.example PORT corrected 3004 → 3001 to match project-ports.json.
- **03:08** — Project folder renamed project_acronym_maker → genlpt: package.json name, genlpt.vbs launcher, AGENTS.md path.

## 2026-10-01
- **13:14** — App renamed gava → GenLPT (Generator of Logical Phrases from Terms, found with the app itself) in config/brand.js.
- **13:02** — Answer Copy button confirms on itself: the icon turns into a green check for 1.5 s (the far-off toast was easy to miss).
- **13:00** — Answer Copy / Paste icons made smaller (14 px, tighter padding) with no gap between them.
- **12:49** — Answer Copy / Paste buttons are now icon-only (label kept as tooltip and screen-reader text).
- **12:45** — Answers: small Copy / Paste buttons under each answer, beside the counter; Paste replaces the answer (Ctrl+Z undoes it).
- **09:54** — Name-first generation: AI writes full names from kept words; code checks them, takes the letters. Dictionary flow: Real words only.
- **09:54** — Letter chunks of any length (GINIKEY = Generator of INItials from KEYwords); a chunked acronym that doesn't fit falls back to initials.
- **09:54** — Words: no idea repeated across branches, singular/plural merged (conceptKey); Why branch gives benefits, not problems.
- **09:54** — Ranker judges only whether the full name makes sense and describes the project; pronounceability dropped from prompts.
- **09:54** — OpenRouter: low reasoning effort by default (was ~60 s/call); 429 waits at least the backoff; cut connections handled. 39 tests.

## 2026-09-30
- **23:48** — OpenRouter model dropdown now lists only OPENROUTER_MODEL (+ OPENROUTER_MODELS extras), not the 300+ model catalog.
- **23:23** — OpenRouter: rate limits (429) now waited out and retried up to 5 times (Retry-After or 2→30 s backoff).
- **23:23** — OpenRouter: max_tokens 4096 per call, so credit checks no longer reserve a model's 65k-token maximum. 31 tests.
- **03:15** — OpenRouter provider (hosted models): LLM_PROVIDER=openrouter + OPENROUTER_API_KEY; default model anthropic/claude-sonnet-5.5.
- **03:15** — Hosted models name acronym candidates 6 in parallel (Ollama stays 1 at a time); model dropdown shows OpenRouter prices.
- **03:15** — A session's model missing from the current provider falls back to its default. LLM banners/errors are provider-aware. 30 tests.
- **02:44** — Word prompts now draw concrete words from each answer (Mind Map, Initials…), not generic ones (Essence, Vision, Legacy).
- **02:44** — Name prompt: reshaping must keep the meaning (Initials → Initiative rejected). Word lists: underscores become spaces. 24 tests.

## 2026-09-29
- **13:03** — Language + model selects moved from the cog popover to a compact row right above the session title; popover removed.
- **10:10** — Generate words with all 4 answers now has the AI suggest a project title (max 5 words), run alongside the word expansion.
- **10:10** — New session.titleSource (auto/ai/user): AI only replaces the "who"-derived title; a title the user typed is never overwritten.
- **10:10** — Clearing the title hands it back to auto. cleanTitle() strips quotes, trailing punctuation and dangling connectors; +1 test.
- **10:21** — AI title is now made once per session (stored in aiTitle), even over a typed title; once it exists it's never regenerated.

## 2026-09-28
- **23:51** — Acronym expansions are now real names (« Régie Autonome des Transports Parisiens »), not keyword lists.
- **23:51** — Connectors (de, des, pour, of, for…) never carry a letter: enforced in code by services/acronym/phrase.js and initials().
- **23:51** — phraseParts() rejects added/swapped words, misspelled reshapes, keyword lists and « A, B et C » enumerations.
- **23:51** — Pipeline: 36 candidates named one per LLM call (3 tries, first valid kept), then survivors ranked. LLM now required.
- **23:51** — Who branch now proposes category head nouns (Outil, Plateforme…); branch coverage is a small score bonus, no longer the main one.
- **23:51** — Acronym cards show the name with bold letter initials; hover a reshaped word to see its graph word. 23 tests passing.
- **23:51** — Fix: an acronym can no longer use the same word twice from two branches (LOLO = Lien Outil Lien Organisation).

## 2026-09-25
- **10:10** — Font switched to SUSE; type base trialed at 14px (ratio 1.2 kept).
- **10:10** — Removed duplicate loading lines under Generate words/acronyms; the busy button is the only progress indicator.
- **09:40** — Type scale: 15px base, ratio 1.2, defined once in the Tailwind theme; app text sizes shifted one step up; graph labels on the scale.
- **09:20** — UI revamp: full-bleed Cytoscape canvas with floating workflow panel (Describe · Explore · Acronyms steps) and collapsible sidebar.
- **09:20** — Theme: Be Vietnam Pro, cerise brand, zinc neutrals, radius capped at md, global enabled/disabled button cursors, Boxicons via Iconify.
- **09:20** — App name now lives in config/brand.js (app.locals.appName); /app renders a bare full-screen shell without public header/footer.
- **09:20** — Graph restyle (Obsidian-like): small circles, labels below, hover fades non-neighbors, fitToVisible() centers beside panel/sheet.
- **09:20** — Mobile: floating top bar, workflow as draggable bottom sheet (peek/half/full), node popover as action sheet, toasts above sheet.
- **09:20** — Empty canvas states with ghost graph + new fr/en copy; sidebar collapse and panel minimize persist in localStorage.
- **09:20** — Fix: Generate words with one answer now shows its own busy/disabled state (was tracked under the branch key).
- **01:05** — Acronyms now use at most 1 word per branch by default (engine, LLM prompt + id check); new "Words per branch" 1–3 setting.
- **01:05** — Added length_unreachable 422 + max-length hint in step 3; 2 new engine tests (11 passing).
- **00:46** — Built /app single-page tool: 4 questions → Cytoscape mind map → ranked acronyms, saved as brainstorm sessions.
- **00:46** — Added JSON API at /api (sessions, words, expand, acronyms) with JSON 404/error handling; BrainstormSession model.
- **00:46** — LLM layer in services/llm (provider facade + Ollama, fr/en prompts, JSON retry); warm-up endpoint.
- **00:46** — Acronym engine: dictionary coverage search (fr/en word lists), branch-coverage scoring, LLM creative + rank passes.
- **00:46** — Frontend in public/js (app, graph, i18n); fr/en UI; removed Log in nav link and /app placeholder routes.
- **00:46** — Added npm test (node:test, 9 engine tests passing); .env LLM keys + .env.example; updated landing/about.

## 2026-09-24
- **13:00** — Bootstrapped Express + EJS + Mongoose + Tailwind v4; .env on port 3004 from project-ports.json.
- **13:00** — Added Public (/), App (/app), Admin (/admin) facades; route map prints on server start.
- **13:00** — Added internal task board at /dev-resources/tasks (Task model, create/edit/delete).
- **13:00** — Added .vscode/tasks.json (tw + dev on folder open), .vbs launcher, git init.
- **12:42** — Project was created

