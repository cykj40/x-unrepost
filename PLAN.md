# x-unrepost — TypeScript Build Plan

A phased plan for building **x-unrepost** in TypeScript, one Claude Code session per phase. Each phase includes a prompt you can paste in, the files it touches, a checklist that defines "done", and a commit message. Hand off a phase only after the previous phase passes its checklist.

**What it does:** it's a content scrubber for your X account that the user points at any topic. It scans your reposts, replies, quotes and posts (the ~3,200 most recent). You tell it what to clean using a small config file. Either you name topics to remove ("politics, sports"), or you name the only topics to keep ("software, AI, coding agents") and everything else goes. An LLM labels each item `remove` / `borderline` / `keep`, you review only the borderline ones, and the tool deletes the rest. By default it only un-reposts. It deletes your own replies and posts only if you opt in. It runs locally, keeps every key in `.env`, respects X rate limits, and can be stopped and resumed at any point.

---

## Master checklist

- [x] **Phase 0** — Manual setup: X app, OpenAI key, empty GitHub repo *(you, no agent)*
- [x] **Phase 1** — Scaffold, CLAUDE.md, first push *(before any keys exist)*
- [x] **Phase 2** — Config: env validation and the scrub criteria file
- [x] **Phase 3** — Types and CSV store, with tests
- [x] **Phase 4** — OAuth 2.0 PKCE login and token refresh
- [x] **Phase 5** — X API client with rate-limit handling, with tests
- [x] **Phase 6** — `scan` command
- [x] **Phase 7** — `classify` command, with the prompt built from the criteria
- [x] **Phase 8** — `review` command *(skipped on purpose: borderline rows were deleted too)*
- [x] **Phase 9** — `delete` command *(built, tested, and run for real: 1,382 reposts un-reposted)*
- [ ] **Phase 10** — `status`, `verify`, README, final hardening
- [x] **Phase 11** — The real run *(you)*: 1,382 reposts + 66 replies/posts deleted; x.com checked
- [ ] **Phase 12** — Installable CLI and `init` setup wizard (guided or manual)
- [ ] **Phase 13** — `import-archive`, to reach posts older than the API's ~3,200

---

## Resume here (end of session 2, Sat Oct 31)

**State:** Phases 0 to 9 and 11 are done. The account is scrubbed of politics under the criteria: `delete --include-borderline` un-reposted **1,382 reposts** (1,055 remove + 327 borderline; 0 failed, 0 gone), and a second run with `--types reply,post --include-borderline` deleted **66 replies and posts permanently** (58 replies, 8 posts; decision: "I'd rather be safe than sorry", nothing held back). The user scrolled their profile on x.com and found no political content; finance and tech reposts were kept. Final `classify` shows remove 0, borderline 0, keep 1,774 (1,840 before the last delete minus 66).

**Final labels (hash `2a5d30c8`, run 2):** remove 1,096, borderline 352, keep 1,770 over 3,218 rows. The dry-run list was all reposts, all about politics; a few arguable rows (USDA/Rollins nutrition, Sec. Kennedy food, Lonsdale taxes, an Iranian-rescue post) were accepted under "if there's any doubt, delete".

**Real data:** `data/posts.csv` holds 3,222 rows after the last scan (repost 2,641, reply 525, quote 0, post 56). The 4 newest posts are not labeled yet: run `npm run classify` (costs a fraction of a cent). Note: `scan` is incremental (it stops at the first fully known page), so it does NOT re-check deleted posts. Verifying deletions means scrolling x.com, or the `verify` command planned in Phase 10. Never use `--fresh` unless you want to re-pay about $3.

**Settings:** `AI_MODEL=gpt-6.1-terra`. Criteria: `mode: remove`, topics `["politics"]`, plus the Phase 11 instructions.

**Costs measured (Oct 30-31):**
- Full scan of 3,218 posts: about $3 (about $0.001 per post read)
- Classification: about $1 per full run (two runs)
- Un-reposts: about **$10.13 for 1,382, roughly $0.0073 each** (balance went from about $26.93 to $16.80; the start figure was approximate and includes any other API calls)
- Total for this account: about $15
- Un-repost limit is **50 per 15 minutes**: the run took about 7 hours. The tool waits out the window by itself. The 5-item test used part of the first window.
- Cost of `deleteTweet` (replies/posts) is not measured yet (66 rows, one rate-limit window of about 20 minutes).

**Decisions:**
- Delete anything in doubt (`--include-borderline`); skip `review`.
- Finance, stocks, company news and AI/tech industry content is NOT political and must be kept.
- Un-reposts are reversible; replies and posts are permanent and need a typed `DELETE`.
- Honesty rule for the README and any public claims: state only what we measured or verified. No speed comparisons with paid tools. Say plainly: the API window is about 3,200 recent posts, un-reposts are rate-limited to 50 per 15 minutes, and users bring their own X credits and OpenAI key.

**Do next:**
1. Send the cost of the 66 permanent deletes (balance before/after) so the README can quote a real figure; not measured yet.
2. Commit and push any uncommitted work (`feat: delete command` was the Phase 9 commit). Check `git status` shows no `.env`, `.x_tokens.json`, `scrub.config.json` or `data/`.
3. Phase 10, then 12, then 13.

**Open items to fix later (Phase 10):**
- The test script glob needs Node 22+ (raise `engines.node` or point at `test/`).
- `auth` and `classify` validate the whole env, so each needs keys it doesn't use. Relax that for public users.
- The stale comment in `src/ai.ts` (about line 61) should say the GPT-6 family.
- Make the skipped config test hermetic (it depends on a real `scrub.config.json`).
- Add a `verify` command: read the first page or two of the timeline (about $0.10-0.20) and flag any row marked deleted that still appears.
- If `classify` ever fails with a 400 about `response_format`, switch to structured outputs (`json_schema`).
- `.env` contains live keys. Keep the tab closed when sharing screenshots.

---

## Locked decisions (every phase follows these)

| Area | Decision |
|---|---|
| Runtime | Node **≥ 22**, ESM (`"type": "module"`), TypeScript `strict` |
| Run | `tsx` runs the source directly with no build step. `tsc --noEmit` is the typecheck |
| Runtime deps | **`zod` only.** Use native `fetch`, `node:http`, `node:crypto`, `node:readline/promises`, `node:util` `parseArgs`, `node:test` |
| Env loading | `process.loadEnvFile()` (built into Node), no `dotenv` |
| **Criteria** | `scrub.config.json`: `mode` (`remove` or `keep_only`), `topics[]`, and optional `instructions`. You can override it per run with `classify --remove "a,b"` or `--keep-only "a,b"`. The repo commits `scrub.config.example.json`; your own `scrub.config.json` is gitignored |
| **Labels** | `remove` / `borderline` / `keep`. These are generic and never topic-specific |
| **Criteria hash** | Each labeled row stores a short hash of the criteria it was labeled under. If you change the criteria, `classify` relabels automatically |
| State | `data/posts.csv` (the source of truth) and `data/scan_state.json` (pagination cursor). Writes are atomic: write a tmp file, then rename |
| Tokens | `.x_tokens.json`, file mode `0600`, gitignored |
| Resumability | Every command skips rows that are already done. State is saved after **every** item or page |
| AI | Raw `fetch` to an OpenAI-compatible `/chat/completions` endpoint, so OpenAI and xAI share one client |
| CLI flags | Every command parses flags with `parseFlags` from `src/args.ts` (`parseArgs` with `strict: true`, no positionals). An unknown or malformed flag is a one-line error and exit 1, never silently ignored. Never call `parseArgs` with `strict: false`. Commands validate their flags **before** touching config or the network |
| Safety | `delete` defaults to `--types repost`. Any other type means you must type `DELETE` to confirm. `--dry-run` never sends a request that writes |

### X API facts the agents need (verified Oct 2026 against docs.x.com)

- **Authorize:** `https://x.com/i/oauth2/authorize`. **Token:** `POST https://api.x.com/2/oauth2/token`. The app is a confidential client ("Web App"), so the token request uses HTTP Basic auth with `client_id:client_secret`
- **Scopes:** `tweet.read tweet.write users.read offline.access`. Without `offline.access` you get no refresh token. Access tokens last about 2 hours. Refresh tokens **rotate**, so save the new one every time you refresh
- **Callback:** `http://127.0.0.1:8765/callback`. This must exactly match the URL in the console
- `GET /2/users/me` returns the user's id and username
- `GET /2/users/:id/tweets` takes `max_results=100` and `pagination_token`, and caps out around 3,200 posts. Request:
  - `tweet.fields=created_at,referenced_tweets,in_reply_to_user_id,note_tweet,text`
  - `expansions=referenced_tweets.id,referenced_tweets.id.author_id`
  - `user.fields=username`
- **Un-repost:** `DELETE /2/users/:id/retweets/:source_tweet_id`. Use the **source** tweet id, not the id of the RT itself. Limit: **50 per 15 minutes per user**
- **Delete your own post:** `DELETE /2/tweets/:id`
- **Rate-limit headers:** `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset` (a Unix timestamp in seconds). A `429` means sleep until the reset time plus a small buffer
- A repost's own `text` is truncated (`RT @user: …`). Take the full text from `includes.tweets` through `referenced_tweets[type=retweeted].id`. Long posts keep their full text in `note_tweet.text`
- **Cost:** X API access is pay-per-use. Check the price per post read and per delete in console.x.com before Phase 6

### AI facts

- **Primary provider: OpenAI.** Base URL `https://api.openai.com/v1`, model `gpt-6-luna` (set through `AI_MODEL`, which is **required** for OpenAI so no model name is hard-coded that might go stale). Per OpenAI's docs (Oct 2026): $0.10 per 1M input tokens, $0.50 per 1M output, 1M-token context, supports Chat Completions, described as the most efficient model for focused, high-volume tasks. `gpt-6.1-terra` ($1.00 / $5.00) is the step up if Luna's labels turn out too noisy
- These are reasoning models. The default reasoning effort is `medium`, so **always send `reasoning_effort: "none"`** (it's a listed option for Luna and Terra; `minimal` is not). The docs don't say whether `temperature` is accepted, so **leave it out**. **The agent should verify both, and whether `response_format: { type: "json_object" }` works, against the model page at developers.openai.com before coding them.** If JSON mode is rejected, use structured outputs (`json_schema`) instead
- Secondary provider: xAI, base URL `https://api.x.ai/v1`, model `grok-4.3`. xAI retired `grok-3` and the `grok-4-fast` models on May 15, 2026
- Use `response_format: { type: "json_object" }` and validate every response with zod

---

## Phase 0 — Manual setup (you)

- [ ] console.x.com → create a new app (Production) → copy the **Client ID** and **Client Secret** into a password manager
- [ ] User authentication settings: **Read and write**, **Web App / Automated App or Bot**, callback `http://127.0.0.1:8765/callback`, and the website set to your repo URL
- [ ] Add credits or a paid tier if X requires it for write access
- [ ] Create an OpenAI API key at platform.openai.com → API keys, and add billing credit
- [ ] github.com/new → `x-unrepost`, **Public**, no README, .gitignore, or license
- [ ] On your Mac: `mkdir x-unrepost && cd x-unrepost`, put this `PLAN.md` inside, and open the folder in Cursor or Claude Code

---

## Phase 1 — Scaffold and CLAUDE.md

**Prompt:**
> Read PLAN.md. Do Phase 1 only. Scaffold a Node ≥20.12 ESM TypeScript CLI named x-unrepost following the "Locked decisions" table. Create package.json (deps: zod; devDeps: typescript, tsx, @types/node; scripts: `typecheck` = `tsc --noEmit`, `test` = `node --import tsx --test test/**/*.test.ts`, and `scan`/`classify`/`review`/`delete`/`status`/`auth` that each run `tsx src/cli.ts <cmd>`), a strict tsconfig, .gitignore, .env.example, scrub.config.example.json, LICENSE (MIT), a README stub, and CLAUDE.md. `src/cli.ts` uses `node:util` parseArgs, prints help, and dispatches to stub command modules in `src/commands/` that print "not implemented". Install deps, run typecheck, and stop. Don't implement any feature logic.

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `scrub.config.example.json`, `LICENSE`, `README.md`, `CLAUDE.md`, `src/cli.ts`, `src/commands/{auth,scan,classify,review,delete,status}.ts`

**.gitignore must include:** `node_modules/`, `dist/`, `.env`, `.x_tokens.json`, `data/`, `*.csv`, `scrub.config.json`

**.env.example:**
```
X_CLIENT_ID=
X_CLIENT_SECRET=
AI_PROVIDER=openai         # openai | xai
OPENAI_API_KEY=
XAI_API_KEY=
AI_MODEL=gpt-6-luna        # required for openai; optional for xai (default grok-4.3)
```

**scrub.config.example.json:**
```json
{
  "mode": "keep_only",
  "topics": ["software engineering", "AI and LLMs", "coding agents", "developer tools"],
  "instructions": "Personal milestones and fitness posts are borderline. Memes about coding count as on-topic."
}
```
Other examples to include in the README: `{"mode":"remove","topics":["politics"]}` and `{"mode":"remove","topics":["sports","politics","celebrity gossip"]}`.

**CLAUDE.md content (keeps every later session aligned):**
```
# x-unrepost
CLI that scans the user's X account, labels each item with an LLM against user-defined
criteria (scrub.config.json: remove these topics, or keep only these topics), and deletes the matches.
- Read PLAN.md first. Only do the phase you're asked to do.
- Node >=22 ESM, TS strict. Runtime dep: zod only. No new deps without asking.
- Labels are generic: remove | borderline | keep. Never hard-code a topic in the code.
- Never read, print, or commit .env, .x_tokens.json, or data/.
- Every write to state is atomic and happens after each item. Commands must be resumable.
- No request that writes to X may run without an explicit user command. Tests mock fetch.
- Done = `npm run typecheck` and `npm test` pass.
```

**Done when:**
- [ ] `npm run typecheck` passes
- [ ] `npx tsx src/cli.ts --help` lists all 6 commands
- [ ] `git status` shows no secrets
- [ ] First push:
  ```
  git init && git add . && git commit -m "chore: scaffold" && git branch -M main
  git remote add origin https://github.com/cykj40/x-unrepost.git && git push -u origin main
  ```
- [ ] **Only now** `cp .env.example .env` and `cp scrub.config.example.json scrub.config.json`, then fill them in. Run `git status` again: neither file may appear

---

## Phase 2 — Config and scrub criteria

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 2 only. Create `src/config.ts`: call `process.loadEnvFile()` inside a try/catch (a missing .env is OK), then validate with zod. Export a typed `config` object: `x.clientId`, `x.clientSecret`, `ai.provider`, `ai.apiKey`, `ai.baseUrl`, `ai.model`, and fixed paths (`dataDir`, `postsCsv`, `scanState`, `tokensFile`). If `AI_PROVIDER` is unset, infer it from whichever key is present, preferring openai if both are set. If `AI_MODEL` is missing for openai, fail. The default for xai is `grok-4.3`.
> Create `src/criteria.ts`: a zod schema `{ mode: 'remove' | 'keep_only', topics: string[] (1–20, each trimmed and non-empty), instructions?: string (≤500 chars) }`. Add `loadCriteria({ configPath?, removeFlag?, keepOnlyFlag? })`. The flags override the file, and passing both flags is an error. If there's no file and no flag, print a helpful error that points to `scrub.config.example.json`. Add `criteriaHash(c)`: the first 8 hex chars of a sha256 over canonical JSON (topics lowercased and sorted).
> On error, print one readable line per problem with no stack trace and exit 1. Load config lazily, so `--help` works without a .env. Tests: provider inference, flag-over-file precedence, both-flags error, and a hash that ignores topic order and case.

**Done when:**
- [ ] Empty env + `npm run scan` prints a clear "X_CLIENT_ID is required" error and exits 1
- [ ] `--help` still works with no .env
- [ ] `["Sports","politics"]` and `["politics","sports"]` produce the same hash
- [ ] Tests pass and typecheck is clean
- [ ] Commit: `feat: config and scrub criteria`

---

## Phase 3 — Types and CSV store

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 3 only. Create `src/types.ts` with a zod `PostRow` schema and inferred type. Columns: `id`, `type` (repost|reply|quote|post), `created_at`, `target_id` (source tweet id for reposts, else the row's own id), `author` (original author username for reposts/quotes), `text`, `context` (replied-to or quoted text), `label` (''|remove|borderline|keep), `reason`, `topic` (the matched topic, or ''), `criteria_hash`, `reviewed` (''|yes), `status` (''|deleted|failed|gone), `error`. Create `src/store.ts` with a dependency-free RFC 4180 CSV parser/serializer (quotes, commas, CRLF/LF, embedded newlines, UTF-8 and emoji), plus `loadRows()`, `saveRows()` (atomic tmp+rename, creates `data/`), and `upsertRows()` (merge by id, existing labels/status preserved). Tests: round-trip edge cases, a missing file returns [], an upsert doesn't clobber labels.

**Done when:**
- [ ] A round-trip test covers commas, quotes, newlines, emoji, and empty fields
- [ ] The atomic write is proven: no `.tmp` file is left behind
- [ ] The output opens cleanly in Numbers or Excel (check by hand with one fixture)
- [ ] Commit: `feat: CSV store`

---

## Phase 4 — OAuth 2.0 PKCE

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 4 only. Create `src/auth.ts` using the X OAuth facts in PLAN.md. `login()`: generate a PKCE verifier and S256 challenge plus a random `state`, start a `node:http` server on 127.0.0.1:8765 that handles `/callback`, open the browser (`open` on macOS, `xdg-open` on Linux, otherwise print the URL), verify `state`, exchange the code using Basic auth, save tokens with `expires_at` to `.x_tokens.json` with mode 0600, show a "you can close this tab" page, and shut the server down. Add a 5-minute timeout. `getAccessToken()`: if the token is within 60s of expiry, refresh it and save the **rotated** refresh token; if the refresh fails, fall back to `login()`. Wire up the `auth` command to run login, then call `GET /2/users/me` and print `Logged in as @username (id)`. Never log tokens.

**Done when:**
- [ ] `npm run auth` opens the browser once and prints `Logged in as @cyjkcodes`
- [ ] Running it again without deleting the token file doesn't open the browser
- [ ] Setting `expires_at` to 0 by hand → the next run refreshes silently and the file holds a new refresh token
- [ ] `ls -l .x_tokens.json` shows `-rw-------`
- [ ] Commit: `feat: OAuth2 PKCE login and refresh`

---

## Phase 5 — X API client

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 5 only. Create `src/xclient.ts` with an `XClient` class that takes the token provider from Phase 4. Add `request(method, path, opts)`: attach the bearer token, read the x-rate-limit-* headers, and if `remaining === 0` sleep until the reset time plus 2s before the next call. On 429, sleep until the reset time and retry. On 401, refresh once and retry. On 5xx or network errors, retry with exponential backoff (up to 5 tries). Print a one-line countdown to stderr while sleeping. Validate responses with zod. Methods: `me()`, `userTweets(userId, paginationToken?)`, `unrepost(userId, sourceTweetId)`, `deleteTweet(id)`. A 404 on either delete method returns `'gone'` and does not throw. Inject `fetch` and `sleep` so tests can mock them. Tests: 429→wait→success, remaining=0 pre-sleep, 401→refresh, 404→'gone', 5xx backoff.

**Done when:**
- [ ] All 5 behaviors are covered by tests that use a mocked fetch and fake timers. No real network calls
- [ ] Commit: `feat: rate-limited X client`

---

## Phase 6 — `scan`

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 6 only. Implement `src/commands/scan.ts`. Get the user via `me()`, then page through `userTweets` (resume from `pagination_token` in `data/scan_state.json` unless `--fresh` is passed). For each tweet, find its type from `referenced_tweets` (retweeted→repost, replied_to→reply, quoted→quote, none→post; a repost wins if more than one applies). For a repost, set `target_id` to the source id, and set `text`/`author` from `includes.tweets` and `includes.users`. Prefer `note_tweet.text`. For a reply or quote, put the referenced text into `context` when it's available. After **each page**, upsert the rows and save the next token. When pagination ends, mark the scan complete. Print progress per page and a final count by type. Add a `--max-pages N` flag that stops after N pages and leaves the scan marked incomplete, so the next run resumes from the saved token. Use `author_id` with `includes.users` to set a repost's `author`.

**Done when:**
- [ ] First run `npm run scan -- --max-pages 1` (100 posts, cheap). Spot-check 5 reposts against x.com: full text, correct author, `target_id` matches the original post
- [ ] Then `npm run scan` finishes the rest from the saved token
- [ ] Ctrl+C mid-scan, then rerun → it picks up where it stopped with no duplicate ids
- [ ] Type counts look right (expect around 1,355 reposts)
- [ ] Commit: `feat: scan command`

---

## Phase 7 — `classify`

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 7 only. Create `src/ai.ts`: an OpenAI-compatible chat client over fetch using `config.ai`, with JSON output, `reasoning_effort: "none"`, no `temperature` parameter (follow the AI facts in PLAN.md and confirm JSON mode vs structured outputs against OpenAI's docs for `AI_MODEL`), and retries on 429 and 5xx. Create `src/prompt.ts` with `buildSystemPrompt(criteria)`. It must produce a prompt from the criteria using the label rules below and must never hard-code a topic. Implement `classify`: load the criteria (accept `--config`, `--remove`, `--keep-only`) and compute its hash. Take rows where `label` is empty **or** `criteria_hash` differs from the current hash, skipping rows whose `status` is deleted or gone. Send them in batches of 20 as `[{id, type, author, text, context}]`, and expect `{"results":[{"id","label","topic","reason"}]}`. Validate with zod. Every input id must come back exactly once; if not, retry that batch once, then mark the leftover rows `borderline` with reason "model error". Write the label, topic, reason and criteria_hash, clear `reviewed`, and save after each batch. Before the run, print the active criteria in one line and how many rows will be (re)labeled. Flags: `--limit N` and `--relabel` (forces every row). At the end, print counts per label and the top 5 matched topics. Test `buildSystemPrompt` for both modes with a snapshot.

**Label rules (the prompt template must encode these):**
- **`mode: remove`:** `remove` = the post's main subject is one of the topics. `keep` = it isn't. `borderline` = the topic is part of the post but not its main subject, or you're unsure.
- **`mode: keep_only`:** `keep` = the post's main subject is one of the topics. `remove` = it's clearly off-topic. `borderline` = mixed, ambiguous, or personal posts that aren't clearly either.
- Judge a repost or quote by what it says, not by who wrote it.
- `topic` = the topic from the list that matched (or the best short description of an off-topic subject in `keep_only` mode).
- `instructions` from the config are added to the prompt as extra rules from the user, and they take priority on edge cases.
- When in doubt → **`borderline`**. `reason` is at most 12 words.

**Done when:**
- [ ] `npm run classify -- --limit 40`, then read all 40 labels in the CSV. If more than 2 look wrong, add an `instructions` line and rerun (the changed hash relabels them automatically)
- [ ] Changing `topics` in `scrub.config.json` → the next `classify` relabels everything that isn't deleted
- [ ] `--remove "sports"` overrides the file for one run
- [ ] The full run finishes. Rerunning with the same criteria is a no-op
- [ ] Commit: `feat: criteria-driven classification`

---

## Phase 8 — `review` (optional: skip it if you delete borderline rows too)

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 8 only. Implement `review` with `node:readline/promises`. Loop over rows where `label=borderline` and `reviewed` is empty. Show the active criteria at the top, then for each item: the type, date, author, text, context, the AI's topic and reason, and a link (`https://x.com/i/status/<target_id>`). Keys: `r` = remove, `k` = keep, `s` = skip, `u` = undo the last answer, `q` = quit. Save after each answer and set `reviewed=yes`. Show progress as `12/87`. Add a `--label remove` flag so you can also check items the AI marked for removal.

**Done when:**
- [ ] Quitting partway and rerunning resumes on the next unreviewed item
- [ ] Undo works
- [ ] Commit: `feat: interactive review`

---

## Phase 9 — `delete`

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 9 only. Implement `delete`. Select rows with `label=remove` (plus `label=borderline` when `--include-borderline` is passed; borderline rows the user already reviewed were relabeled remove or keep, so they follow their new label), a `criteria_hash` equal to the current criteria (warn and skip rows labeled under different criteria, and tell the user to run classify), `type` in `--types` (default `repost`), and `status` not `deleted` or `gone`. `--dry-run`: print a table of what would be deleted (type, topic, the first 80 chars) plus the count and ETA (50 per 15 min), and make **no** write calls. A real run: if `--types` includes anything other than repost, print a warning that this is PERMANENT and require the user to type `DELETE` exactly. Reposts use `unrepost(userId, target_id)`. Everything else uses `deleteTweet(id)`. Set `status` after each item (deleted, gone on a 404, or failed with the error message) and save immediately. Add `--limit N` and `--topic <name>` (delete only rows whose matched topic is this one). Handle SIGINT by finishing the current item, saving, and exiting cleanly. Print a running count and the ETA.

**Done when:**
- [ ] `--dry-run` makes zero write calls (prove it with a test against a mocked client)
- [ ] `--dry-run` prints counts split by label and type; with `--include-borderline` the total equals remove + borderline for the chosen `--types`
- [ ] Rows with a stale criteria hash are skipped, with a warning
- [ ] `npm run delete -- --limit 1` un-reposts exactly one item. Confirm it on x.com
- [ ] `--types repost,reply` refuses to continue without `DELETE` typed in
- [ ] Ctrl+C mid-run, then rerun → it skips finished items
- [ ] Commit: `feat: delete command`

---

## Phase 10 — `status`, README, hardening

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 10 only. Also implement `verify`: fetch the first 1-2 pages of the user's timeline and report any row marked `deleted` in the CSV that still appears (cost about $0.10-0.20), since `scan` is incremental and never re-checks deletions. Implement `status`: the active criteria, counts by type × label × status, the top matched topics, how many rows are stale (hash mismatch), whether the scan is complete, and an ETA for the remaining deletes. Write README.md for public users: what the tool does, the content-scrubber idea with 3 example configs (remove politics, remove sports and politics, keep only tech), X app setup, the OpenAI key, install (`npm install`), the command walkthrough, rate limits and runtime, a cost note using the measured numbers in "Resume here" (scan about $3 per 3,200 posts, classify about $1, un-repost about 0.7 cents each), the safety model, the files you must never commit, and how to re-verify. Add a GitHub Actions workflow that runs typecheck and tests on push. Review the whole codebase for: tokens or keys in logs, writes that aren't atomic, any write path that a dry run can reach, hard-coded topics, and unhandled promise rejections. Fix what you find and list the fixes. Also fix the test script: `node --test` globs need Node 22+, so either raise `engines.node` to `>=22` or point the script at the `test/` directory.

**Done when:**
- [ ] CI is green on GitHub
- [ ] `grep -rni "politic" src/` returns nothing (no hard-coded topics)
- [ ] `grep -rn "access_token\|apiKey" src/` shows no logging of secrets
- [ ] A fresh clone, followed by the README steps, works on a second terminal or machine
- [ ] README claims only what was measured or verified: no speed comparisons with other tools; it states the ~3,200-post API window, the 50-per-15-minute un-repost limit (about 7 hours for 1,400 reposts), and that users bring their own X credits and OpenAI key
- [ ] `verify` flags a deleted row that still appears on the timeline (test with a mocked client)
- [ ] Commit: `docs: README, status, verify, CI`

---

## Phase 11 — The real run (you)

**My config (`scrub.config.json`): political reposts and replies**
```json
{
  "mode": "remove",
  "topics": ["politics"],
  "instructions": "Politics: elections, politicians, parties, government policy fights, partisan commentary, culture-war topics, taking sides in geopolitical conflicts, presidential and administration statements or actions. NOT political: stocks, finance, investing, company news (Palantir), AI and tech industry debates, even if a government is mentioned. A reply is political only if it takes a political stance. Link-only reposts: political or government accounts are political; tech or finance accounts, keep."
}
```

```
npm run auth
npm run scan
npm run classify
npm run review                                      # optional: skip it if you delete anything in doubt
npm run delete -- --include-borderline --dry-run    # check the full list first
npm run delete -- --include-borderline              # step 1: reposts only, remove + borderline (you can re-repost)
npm run delete -- --types reply                     # step 2 (optional): replies (PERMANENT, type DELETE)
npm run scan && npm run classify                    # picks up new posts only (incremental); does NOT re-check deletions
# verify: scroll your profile on x.com, or use `npm run verify` once Phase 10 adds it. `scan --fresh` costs about $3
```
Actual result: 1,382 reposts un-reposted in about 7 hours at 50 per 15 min, about $10. Replies and posts are still to decide.

- [ ] Want a different cleanup later? Edit `scrub.config.json` and rerun `classify`. It relabels only what's left
- [ ] Stop your Mac from sleeping during long runs: `caffeinate -i npm run delete`
- [ ] Never commit or share `.env`, `.x_tokens.json`, `scrub.config.json`, or `data/`

---

## Phase 12 — Installable CLI and `init` wizard

**Goal:** people run `npx x-unrepost` or `npm i -g x-unrepost` instead of cloning the repo, and a setup wizard replaces hand-editing files.

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 12 only. (1) Packaging: add a `bin` entry and a build (`tsc` to `dist/`, with a shebang on the entry) so `x-unrepost <command>` works; keep `tsx` for development. Move state (`data/`, `.x_tokens.json`) to a per-user directory (`~/.x-unrepost/`, overridable with `X_UNREPOST_HOME`), and keep reading `.env` and `scrub.config.json` from the current directory or that home. Existing repo-local state must keep working (migrate or detect it, never lose data). (2) `x-unrepost init`: first ask **Guided setup** or **Manual setup**. *Manual*: copy `.env.example` and `scrub.config.example.json` into place (never overwrite), print what to fill in, and stop. *Guided*: ask for the X Client ID and Secret (secret input hidden) and the OpenAI key, with a one-line note on where each comes from; check each key with a real call (X `me`, a tiny OpenAI request) so typos fail now; write `.env` with mode 0600; make sure `.gitignore` covers it. Then build `scrub.config.json`: ask remove vs keep_only, the topics (offer presets like politics, sports, crypto, or type your own), and optional extra instructions (enforce the 500-character limit as the user types), show the final config, and ask for confirmation. End by printing the next command and the expected cost of a scan (about $3 per 3,200 posts) and the 50-per-15-minute un-repost limit. Use `node:readline/promises` only; no new dependencies without asking. Never print or log secrets.

**Done when:**
- [ ] `npm run build` produces `dist/`; `node dist/cli.js --help` works
- [ ] `npm pack` then installing the tarball in a temp folder lets `x-unrepost --help` run
- [ ] `init` guided mode on an empty folder produces a working `.env` (0600) and `scrub.config.json`; a bad key is rejected with a clear message
- [ ] `init` manual mode never overwrites existing files
- [ ] Existing repo-local `data/` and tokens still work
- [ ] Tests pass and typecheck is clean
- [ ] Commit: `feat: installable CLI and init wizard`

---

## Phase 13 — `import-archive`

**Goal:** reach posts older than the API's ~3,200 limit. X lets users download a data archive (it can take 24-48 hours to arrive); it contains every post ID. The rest of the pipeline (classify, delete) works by ID, so it needs no changes.

**Prompt:**
> Read PLAN.md and CLAUDE.md. Do Phase 13 only. Add `x-unrepost import-archive <path>` that reads the `tweet.js` (or `tweets.js`) file from an unzipped X archive (strip the `window.YTD.tweets.part0 = ` prefix, then parse the JSON), and upserts rows into `posts.csv` without clobbering existing labels or statuses. Determine the type from the archive fields (retweet, reply, quote, post) and fill `id`, `created_at`, `text`, and `target_id` as best the archive allows. Archive text for retweets is truncated: mark such rows so `classify` can still label them, and note that un-reposting needs the source tweet id (verify the archive provides it; if it only gives the retweet's own id, find out whether the delete endpoint accepts that or whether a lookup is needed, and ask before choosing). Print counts by type and how many rows are new. Make no network calls. Tests: a small fixture archive, the prefix stripping, upsert-without-clobber.

**Done when:**
- [ ] Importing a real archive adds posts the API scan never reached, with no duplicate ids
- [ ] Re-importing is a no-op
- [ ] `classify` and `delete --dry-run` work on imported rows
- [ ] Commit: `feat: import X archive`

---

## Handoff rules (for every agent session)

1. Start each session with: *"Read PLAN.md and CLAUDE.md. Do Phase N only."*
2. Give the agent one phase per session. Start a fresh session for each phase so context stays clean.
3. Don't start the next phase until every box in this phase's "Done when" list is checked. Commit after each phase.
4. If an agent wants to add a dependency or change a locked decision, it has to ask first.
5. Phases 4, 6 and 9 touch your real account. Run those yourself and watch them. Don't hand them to an agent working unattended.
