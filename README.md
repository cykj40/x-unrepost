# x-unrepost

A content scrubber for your X account. Point it at any topic: it scans your reposts, replies, quotes and posts, labels each one with an LLM against criteria you define, and deletes the matches.

> Work in progress. The full README lands in Phase 10.

## Criteria

Copy `scrub.config.example.json` to `scrub.config.json` and edit it.

```json
{ "mode": "keep_only", "topics": ["software engineering", "AI and LLMs"] }
```

```json
{ "mode": "remove", "topics": ["politics"] }
```

```json
{ "mode": "remove", "topics": ["sports", "politics", "celebrity gossip"] }
```

## Commands

`auth`, `scan`, `classify`, `review`, `delete`, `status`. Run `npx tsx src/cli.ts --help`.

## License

MIT
