# x-unrepost
CLI that scans the user's X account, labels each item with an LLM against user-defined
criteria (scrub.config.json: remove these topics, or keep only these topics), and deletes the matches.
- Read PLAN.md first. Only do the phase you're asked to do.
- Node >=20.12 ESM, TS strict. Runtime dep: zod only. No new deps without asking.
- Labels are generic: remove | borderline | keep. Never hard-code a topic in the code.
- Never read, print, or commit .env, .x_tokens.json, or data/.
- Every write to state is atomic and happens after each item. Commands must be resumable.
- No request that writes to X may run without an explicit user command. Tests mock fetch.
- Done = `npm run typecheck` and `npm test` pass.
- CLI flags: use parseFlags from src/args.ts (strict). Never parseArgs with strict: false. Validate flags before touching config or the network.
