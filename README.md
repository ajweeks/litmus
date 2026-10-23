# fact/check

A chat UI for Claude that fact-checks the model's replies as they stream. A cheaper model picks out the claims in each reply, checks them against web sources, and marks them in the margin. Corrections can go back to the main model, either automatically on your next turn or with a button.

Every claim is saved to a database with its verdict, sources, confidence, token cost and links to related claims. The database is shared across chats, so a claim that has already been checked is reused rather than searched again.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional: set ANTHROPIC_API_KEY for local use
npm run dev                  # http://localhost:3000
```

Without a server key, open **Settings** and paste your own Anthropic API key. It stays in the browser's localStorage, is sent with each request in an `x-anthropic-key` header, and is never stored on the server.

## How it works

```
browser ── POST /api/chat ──► Next.js route ──► main model (streamed)
   ▲                              │  each finished paragraph
   │ NDJSON: text deltas,         ▼
   │ claim updates          extractor (Haiku, structured output)
   │                              │  one task per claim, 4 at a time
   └──────────────────────────────┤
                                  ▼
                            verifier (Haiku + web search) ──► submit_verdict tool
                                  │
                                  ▼
                          SQLite: claims, sources, links
```

1. **Streaming and chunking.** The main reply is split at paragraph breaks (never inside code blocks). Extraction starts on each passage as soon as it is complete, so margin notes appear while the reply is still streaming.
2. **Extraction** (`lib/factcheck.ts` → `extractClaims`). This returns a verbatim quote, a standalone restatement and a category. It also receives recent verified claims from the database so it can flag duplicates (`duplicate_of`) and related claims (`related_ids`).
3. **Verification** (`verifyClaim`). The verifier uses Anthropic's server-side web search, then calls a strict `submit_verdict` tool with a verdict, confidence, a one-line summary, a correction and up to 3 sources with quotes. A source URL that didn't appear in the search results is flagged "not from search". Duplicates copy the earlier verdict and skip the search.
4. **Summary line** (`summarizeMessage`). Once every claim in a reply has a verdict and at least one is wrong, misleading or partly right, the checker model writes a single line of 30 words or fewer covering only the problems found. It appears under the answer and is stored on the message (`check_summary`). Re-checking a claim regenerates it.
5. **Feedback.** Unsent findings (`refuted`, `misleading`, `partially_supported`) are added to the conversation as a mid-conversation `system` message in `<fact_check_results>` tags. The main model is told to weigh them as evidence, not to obey them blindly. In testing it rejected a deliberately bogus finding. These notes appear in the transcript as collapsible rows.

### Trust, freshness and reuse

Verdicts are shared across chats, so a wrong one could spread. Reuse is deliberately conservative (`isReusable` in `lib/types.ts`). An earlier verdict is copied only if all of these hold:
- its confidence is at least 0.85;
- at least one of its sources came from an actual search;
- it hasn't expired;
- it hasn't been replaced by a newer check.

Anything else gets checked again. When that happens, the new verdict replaces the old one (`superseded_by`), whether or not they agree.

The verifier also tags each claim's **volatility**, which sets how long the verdict can be reused:
- `stable`: never expires;
- `slow`: 180 days;
- `fast`: 3 days.

It also tags each error's **importance** (`minor` / `moderate` / `major`). Errors below the "Corrections to show" setting (default: moderate) are muted. They stay out of the summary and aren't sent to the model, which avoids constant "well actually" notes about details that don't matter.

### Triage with decision models (experimental)

Decision models such as TypeSafe's Jev, Perplexity's Decider and Nace.AI's Drex return a probability over fixed options instead of generated text. Set one in Settings (any OpenRouter decision-model id, for example `~typesafe/jev-latest` or `perplexity/pplx-decider-v1.2`) along with an OpenRouter key. Each new claim then gets a probability of being accurate from OpenRouter's Decisions API (`/api/alpha/decisions`, still alpha).
- Claims above the threshold (default 90%) are marked "Not checked" and skip the web search.
- A random sample of those (default 10%) is checked anyway. Comparing those audits with the triage scores shows whether the model's probabilities are calibrated.
- Skipped claims are never reused as verdicts.
- If the API fails, the claim simply gets the full check.

### Strictness levels

Set in Settings. Each level is a block of prompt text in `lib/prompts.ts`, which is where most tuning is expected to happen.

| Level | Extracts |
|---|---|
| Facts | Empirical claims only: dates, numbers, names, attributions, scientific and technical facts |
| Facts + judgments | Also contestable claims presented as settled ("the most significant cause", "experts agree") |
| Full critique | Also misleading framing: missing caveats, cherry-picked numbers, overstated certainty |

### Verdicts

`supported` · `partially_supported` · `misleading` · `refuted` · `unverifiable`, plus `pending`, `verifying` and `error` while a check is in progress or has failed.

## Data

SQLite at `data/factcheck.db` (override with `FACTCHECK_DB_PATH`). Tables: `chats`, `messages`, `claims`, `sources`, `claim_links`.

Each claim records:

| Field | |
|---|---|
| `id`, `chatId`, `messageId` | where it came from |
| `quote`, `startOffset`, `endOffset` | exact span in the raw message text (-1 if it couldn't be located) |
| `claim`, `category`, `strictness` | standalone restatement, and how it was extracted |
| `status`, `confidence`, `summary`, `correction` | the verdict |
| `sources[]` | `url`, `title`, `quote`, `stance` (supports / contradicts / context), `retrieved` |
| `relatedIds[]`, `reusedFrom` | links to other claims across all chats |
| `inputTokens`, `outputTokens`, `searchCount`, `costUsd` | extraction share plus verification. Cost is an estimate from list prices |
| `extractorModel`, `verifierModel`, `createdAt`, `verifiedAt`, `fedBackIn` | provenance |

### API

| | |
|---|---|
| `POST /api/chat` | `{ chatId?, content, settings, correctionRequest? }` → NDJSON stream of `meta`, `text`, `message_done`, `claim`, `error`, `end` |
| `GET /api/chats`, `GET/DELETE /api/chats/:id` | chat list; a chat with its messages and claims |
| `GET /api/claims?status=&category=&model=&q=&chatId=&format=json\|jsonl&limit=` | export the claims database |
| `GET /api/claims/:id`, `POST /api/claims/:id` | read a claim; re-verify it (`{ model }`) |

The **Claims database** page (`/claims`) lists every claim. It has a text search (claims, quotes, findings, source URLs) and filters for verdict, claim type, checker model, chat, minimum confidence and "sent to model". The export links carry the filters the API supports.

## Code map

```
app/api/chat/route.ts     chat turn: persist, stream main model, run the pipeline, feed back corrections
lib/factcheck.ts          extraction, verification, concurrency, paragraph chunker
lib/prompts.ts            all prompts: strictness levels, verdict definitions, the feedback note
lib/db.ts                 storage (the only file to replace for Postgres)
lib/text.ts               fuzzy quote location shared by server offsets and browser highlighting
lib/rehypeClaims.ts       wraps quotes in <mark> inside rendered markdown, across formatting
components/MessageView.tsx  reply, highlights, margin note layout
components/ClaimNote.tsx    margin note and its detail view
```

## Deploying

- **Long requests.** The chat stream stays open until every claim in the reply is verified, which can take 20–60 s. Serverless hosts with short limits will cut it off. Results are still written to the database as they finish, and the UI polls for pending claims. A long-running Node host (Fly, Railway, a VM) is simplest. On Vercel, `maxDuration` is set to 300.
- **Bring-your-own-key.** Keys pass through the server for each request, so users have to trust the host. For a public deployment, leave `ANTHROPIC_API_KEY` unset so the server never pays for anyone else's usage.
- **Shared cloud database.** `lib/db.ts` is synchronous SQLite. For a hosted, multi-user database, port it to Postgres (for example Neon or Supabase). The rest of the app only calls its exported functions.

## Ideas for the next iteration

- An eval set of claims with known answers, to compare prompts, strictness levels and checker models
- Use `web_fetch` for direct primary-source reading (statutes, papers), with domain allow-lists per topic
- Per-user auth and a shared Postgres database
- Recheck stale verdicts after a time-to-live for claims about things that change
- Incremental extraction at sentence level instead of paragraph level, for faster first notes
