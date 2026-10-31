# x-unrepost

A content scrubber for your X account. You describe what to clean in a small config file. The tool reads your recent reposts, replies, quotes and posts, asks an LLM to label each one against your criteria, and removes the matches.

You bring your own X API credits and your own OpenAI (or xAI) key. Everything runs locally and your keys stay in `.env`.

## How it works

1. `scan` reads your timeline into `data/posts.csv`.
2. `classify` labels every row `remove`, `borderline` or `keep` against your criteria.
3. `delete` un-reposts or deletes the rows you chose, with a dry run first.
4. `verify` checks that deleted items are gone from your timeline.

Every command saves its progress after each item, so you can stop (Ctrl+C) and rerun it to resume.

## Limits you should know about

- **The X API only exposes your most recent ~3,200 posts.** Older items cannot be scanned or deleted by this tool.
- **Un-reposts are limited to 50 per 15 minutes.** About 1,400 reposts takes roughly 7 hours. The tool waits out each window by itself; use `caffeinate -i npm run delete` on a Mac so it does not sleep.
- Un-reposting is reversible (you can repost again). **Deleting replies, quotes and posts is permanent.**
- The LLM makes mistakes. Read the dry run before deleting anything.

## Criteria

Copy `scrub.config.example.json` to `scrub.config.json` (it is gitignored) and edit it. `mode` is either `remove` (delete posts about these topics) or `keep_only` (delete everything that is not about these topics). `instructions` (optional, up to 500 characters) adds your own rules for edge cases.

Remove politics:

```json
{ "mode": "remove", "topics": ["politics"] }
```

Remove sports and politics:

```json
{ "mode": "remove", "topics": ["sports", "politics", "celebrity gossip"] }
```

Keep only tech:

```json
{
  "mode": "keep_only",
  "topics": ["software engineering", "AI and LLMs", "coding agents", "developer tools"],
  "instructions": "Personal milestones and fitness posts are borderline. Memes about coding count as on-topic."
}
```

Labels are generic. `borderline` means the topic is part of the post but not its main subject, or the model is unsure. If you change the criteria, the next `classify` relabels everything that has not been deleted.

## Setup

Requires Node 22 or newer.

```
git clone https://github.com/cykj40/x-unrepost.git
cd x-unrepost
npm install
cp .env.example .env
cp scrub.config.example.json scrub.config.json
```

**X app.** In console.x.com create an app with user authentication set to **Read and write**, type **Web App / Automated App or Bot**, and callback URL exactly `http://127.0.0.1:8765/callback`. Copy the Client ID and Client Secret into `.env` as `X_CLIENT_ID` and `X_CLIENT_SECRET`. X API access is pay-per-use, so add credits there.

**AI key.** Create an OpenAI API key at platform.openai.com, add billing credit, and put it in `.env` as `OPENAI_API_KEY`. Set `AI_MODEL` to the model you want to use (required for OpenAI). xAI also works: set `XAI_API_KEY` (and `AI_PROVIDER=xai` if both keys are present).

## Walkthrough

Pass flags after `--` when using npm.

```
npm run auth                                        # log in to X in your browser once
npm run scan                                        # read your timeline (resumable)
npm run classify                                    # label every row
npm run status                                      # criteria, counts, stale rows, ETA
npm run delete -- --include-borderline --dry-run    # see exactly what would be removed
npm run delete -- --include-borderline              # un-repost remove + borderline reposts
npm run delete -- --types reply,post                # permanent: you must type DELETE
npm run verify                                      # confirm deleted rows are off your timeline
```

| Command | What it does |
|---|---|
| `auth` | OAuth 2.0 PKCE login. Tokens go to `.x_tokens.json` (mode 0600) and refresh automatically. |
| `scan [--fresh] [--max-pages N]` | Reads the timeline. After the first full scan it only reads new posts. `--fresh` rereads everything and costs a full scan again. |
| `classify [--limit N] [--relabel] [--config F] [--remove "a,b"] [--keep-only "a,b"] [--instructions "..."]` | Labels rows whose label is empty or was made under different criteria. The flags override the config file for one run. |
| `delete [--types repost,reply,quote,post] [--dry-run] [--include-borderline] [--limit N] [--topic NAME]` | Deletes rows labeled `remove` (and `borderline` with the flag) under the current criteria. Default type is `repost`. |
| `status` | Active criteria, counts by type, label and status, top matched topics, stale rows, scan state, and the ETA for remaining deletes. |
| `verify [--pages N]` | Reads the newest 1 to 2 pages of your timeline and lists rows marked `deleted` that still appear. Read-only. |
| `review` | Not implemented yet. Use `--include-borderline` or relabel by editing the criteria. |

## Safety model

- Nothing writes to X unless you run `delete`. `--dry-run` never sends a write request and needs no X credentials.
- `delete` only touches rows labeled under your current criteria. Rows labeled under older criteria are skipped with a warning to run `classify`.
- The default type is `repost`. Any other type prints a PERMANENT warning and requires you to type `DELETE` exactly.
- Status is saved after each item. A 404 is recorded as `gone`, other errors as `failed` (retried on the next run).
- After 5 consecutive failures, `delete` stops, saves, and exits with code 1 without touching the remaining rows. On a 402 or 403 it suggests checking your X API credits and app permissions.
- Ctrl+C finishes the current item, saves, and exits.

## Cost

These are measured figures from one account, not guarantees. Check current prices in your X console and with your AI provider.

- `scan`: about $3 for 3,200 posts.
- `classify`: about $1 for a full run over about 3,200 rows.
- Un-reposts: about 0.7 cents each.

## Never commit or share

`.env`, `.x_tokens.json`, `scrub.config.json`, and `data/`. They are in `.gitignore`.

## Development

```
npm run typecheck
npm test
```

CI runs both on every push. Tests mock `fetch` and never touch the network.

## License

MIT
