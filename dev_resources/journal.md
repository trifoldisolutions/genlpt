# Project Journal

<!--
Entry template:

## YYYY-MM-DD
- **HH:MM** — What changed
-->

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

