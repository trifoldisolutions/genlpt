# Usage reports

What the AI costs, measured on the actions recorded while testing. Each report covers the actions since the one
before it; the newest is first. Add one with `npm run usage:report -- --label "what was tested"`.
The estimates rest on the assumptions in `config/pricing.js`.

<!-- reports -->

## 2026-10-22 12:56

- **Period:** 2026-10-22 12:49 → 2026-10-22 12:56
- **Clicks:** 6, making 15 AI calls, for $0.0174 in all
- **Tokens:** 64,956 in, 21,817 out (16,065 of them reasoning)
- **Models:** openai/gpt-6-luna-pro ($0.10 in, $0.50 out per million tokens)
- **Settings:** openrouter, reasoning low, max output 4096

### Per step

Each kind of AI call, averaged per call. Output includes reasoning.

| Step | Calls | Input | Output | Reasoning | Cost | Total | Time | Slowest |
|---|---|---|---|---|---|---|---|---|
| Branch words | 4 | 3,373 | 782 | 687 | $0.000728 | $0.0029 | 18.7 s | 21.5 s |
| Session title | 1 | 2,428 | 130 | 81 | $0.000308 | $0.000308 | 7.8 s | 7.8 s |
| Name writing | 3 | 7,924 | 4,307 | 3,578 | $0.0029 | $0.0088 | 89.2 s | 97.6 s |
| Scoring | 3 | 3,875 | 1,051 | 287 | $0.000913 | $0.0027 | 23.8 s | 31.7 s |
| Reformulation | 4 | 3,410 | 622 | 411 | $0.000652 | $0.0026 | 7.1 s | 8.1 s |

### Per click

What one click costs, and how long the user waits for it. Calls: average AI calls per click.

| Click | Plan | Clicks | Given back | Calls | Cost | Priciest | Wait | Longest |
|---|---|---|---|---|---|---|---|---|
| Generate words | paid | 1 | 0 | 5.0 | $0.0032 | $0.0032 | 21.5 s | 21.5 s |
| Generate acronyms (letter chunks) | paid | 1 | 0 | 6.0 | $0.0116 | $0.0116 | 129.8 s | 129.8 s |
| Reformulate an answer | paid | 4 | 0 | 1.0 | $0.000652 | $0.000674 | 7.1 s | 8.1 s |

### Where the output goes

Output tokens usually cost several times more than input. Reasoning is the model thinking before it answers; answer text is what it writes back.

| Step | Output | Reasoning | Answer text | Share |
|---|---|---|---|---|
| Branch words | 3,128 | 2,746 | 382 | 14.3% |
| Session title | 130 | 81 | 49 | 0.6% |
| Name writing | 12,920 | 10,734 | 2,186 | 59.2% |
| Scoring | 3,152 | 860 | 2,292 | 14.4% |
| Reformulation | 2,487 | 1,644 | 843 | 11.4% |

### Spent without a result for the user

- **Failed calls:** 0, $0
- **JSON retries:** 0, $0: answers that weren't valid JSON, asked again
- **Given-back clicks:** 0, $0: failed or added nothing, so they didn't count against the user's limits
- **Rate-limit waits:** 0 retries, 0 ms waited
- **Locked acronyms:** 0 of 24 kept were hidden until an upgrade; their share of scoring: about $0

### One usage window per plan

A typical window uses 40% of each limit; a full one uses all of them, at the average click or at the priciest click seen. Reformulations are limited per session, so a full window assumes 3 sessions.

| Plan | Limits per window | Typical | Full | Full, priciest clicks |
|---|---|---|---|---|
| guest | 2 acronym runs · 4 word runs · 10 expansions · 0 reformulations a session | — | — | — |
| free | 5 acronym runs · 10 word runs · 30 expansions · 5 reformulations a session | — | — | — |
| paid | 30 acronym runs · 60 word runs · 200 expansions · 5 reformulations a session | $0.22 (partial) | $0.55 (partial) | $0.55 (partial) |

**Not tested yet:** guest, free.

**Partial**, leaving out what isn't tested yet: paid without Expand a word.

### One user for a month

Light and regular are typical windows. Max opens every window there is (144 a month) and uses each in full: nothing in the limits stops it today.

| Plan | Light (8 windows) | Regular (30) | Max (144) |
|---|---|---|---|
| guest | — | — | — |
| free | — | — | — |
| paid | $1.76 (partial) | $6.60 (partial) | $79.24 (partial) |

### Paid plan price

The price needs every plan tested: guest, free not yet.

<!-- until: 2026-10-22T16:56:34.698Z -->
