import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkAiKey, checkXCredentials, cleanKey, commandLine, ensureGitignore, init, parseTopicSelection } from "../src/commands/init.ts";
import { projectRoot, stateDir } from "../src/config.ts";
import { PassThrough } from "node:stream";
import { ConfigError } from "../src/errors.ts";
import { readTty, type Prompter } from "../src/ui.ts";

const SECRET = "sekrit-value-123";

/** Answers questions from a script in order; records every question so tests can check what was asked. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const queue = [...answers];
  const next = async (q: string) => {
    asked.push(q);
    if (queue.length === 0) throw new ConfigError(["script ran out of answers"]);
    return queue.shift()!;
  };
  const p: Prompter = {
    ask: next,
    askSecret: next,
    askLimited: async (q, max) => {
      const a = await next(q);
      assert.ok(a.length <= max);
      return a;
    },
    close() {},
  };
  return { p, asked, left: () => queue.length };
}

type Reply = { status: number; body?: unknown };
/** Routes by URL; records requests. A reply may be a function of the request. */
function fakeFetch(routes: { x?: Reply | Error; ai?: Reply | Error }) {
  const calls: Array<{ url: string; auth: string }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "") });
    const r = url.includes("api.x.com") ? routes.x : routes.ai;
    if (r === undefined) throw new Error(`unexpected request to ${url}`);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

const goodX: Reply = { status: 400, body: { error: "invalid_request", error_description: "bad code" } };
const dir = () => mkdtempSync(path.join(tmpdir(), "init-"));
const mode = (file: string) => statSync(file).mode & 0o777;

test("guided setup on an empty folder writes a 0600 .env and a valid scrub.config.json", async () => {
  const cwd = dir();
  const { p, left } = scripted([
    "1", // guided
    "client-id-1",
    SECRET,
    "", // provider default: openai
    "sk-test-key",
    "model-x",
    "1", // mode: remove
    "1, 2, my own topic",
    "no politics rants", // instructions
    "y", // save
  ]);
  const { f, calls } = fakeFetch({ x: goodX, ai: { status: 200 } });
  const lines: string[] = [];
  await init({ prompter: p, fetch: f, cwd, packageRoot: projectRoot, log: (l) => lines.push(l) });

  const env = readFileSync(path.join(cwd, ".env"), "utf8");
  assert.match(env, /X_CLIENT_ID=client-id-1\nX_CLIENT_SECRET=sekrit-value-123\nAI_PROVIDER=openai\nOPENAI_API_KEY=sk-test-key\nAI_MODEL=model-x\n/);
  assert.equal(mode(path.join(cwd, ".env")), 0o600);
  const cfg = JSON.parse(readFileSync(path.join(cwd, "scrub.config.json"), "utf8"));
  assert.equal(cfg.mode, "remove");
  assert.equal(cfg.topics.length, 3);
  assert.equal(cfg.topics[2], "my own topic");
  assert.equal(cfg.instructions, "no politics rants");
  assert.equal(left(), 0);
  assert.equal(calls.length, 2); // one X check, one AI check
  assert.ok(calls[1]!.url.endsWith("/models/model-x"));
  const out = lines.join("\n");
  assert.ok(!out.includes(SECRET) && !out.includes("sk-test-key"), "secrets must never be printed");
  assert.match(out, /\$3 per 3,200 posts/);
  assert.match(out, /50 per 15 minutes/);
});

test("a bad key is rejected with a clear message, asked again, and nothing is written after giving up", async () => {
  const cwd = dir();
  const bad: Reply = { status: 400, body: { error: "invalid_client" } };
  const answers = ["1", ...Array.from({ length: 3 }, (_, i) => [`id${i}`, SECRET]).flat()];
  const { p } = scripted(answers);
  const { f } = fakeFetch({ x: bad });
  const lines: string[] = [];
  await assert.rejects(
    init({ prompter: p, fetch: f, cwd, packageRoot: projectRoot, log: (l) => lines.push(l) }),
    (e) => e instanceof ConfigError && /nothing was written/.test(e.message),
  );
  assert.match(lines.join("\n"), /X answered invalid_client \(HTTP 400\)/);
  assert.ok(!existsSync(path.join(cwd, ".env")));
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("a rejected AI key or unknown model gets its own message", async () => {
  const s = { provider: "openai" as const, apiKey: "k", model: "m" };
  assert.equal((await checkAiKey(s, fakeFetch({ ai: { status: 401 } }).f)).status, "bad");
  const unknownModel = await checkAiKey(s, fakeFetch({ ai: { status: 404 } }).f);
  assert.ok(unknownModel.status === "bad" && /model "m"/.test(unknownModel.message));
  assert.equal((await checkAiKey(s, fakeFetch({ ai: new Error("offline") }).f)).status, "unverified");
    assert.equal((await checkXCredentials("a", "b", fakeFetch({ x: goodX }).f)).status, "ok");
  assert.equal((await checkXCredentials("a", "b", fakeFetch({ x: { status: 503 } }).f)).status, "unverified");
});

test("an unverifiable key (offline) can be used only if the user says so", async () => {
  const cwd = dir();
  const { p } = scripted(["1", "id", SECRET, "n"]); // offline -> "use it anyway?" no -> asks again, then runs out
  await assert.rejects(init({ prompter: p, fetch: fakeFetch({ x: new Error("offline") }).f, cwd, packageRoot: projectRoot, log: () => {} }));
  assert.ok(!existsSync(path.join(cwd, ".env")));
});

test("manual setup copies the examples and never overwrites existing files", async () => {
  const cwd = dir();
  writeFileSync(path.join(cwd, "scrub.config.json"), '{"mine":true}');
  const { p } = scripted(["2"]);
  const lines: string[] = [];
  await init({ prompter: p, cwd, packageRoot: projectRoot, log: (l) => lines.push(l) });
  assert.ok(existsSync(path.join(cwd, ".env")));
  assert.equal(mode(path.join(cwd, ".env")), 0o600);
  assert.equal(readFileSync(path.join(cwd, "scrub.config.json"), "utf8"), '{"mine":true}');
  assert.match(lines.join("\n"), /kept your existing scrub\.config\.json/);

  // Second run: both exist now, and a hand-edited .env survives.
  writeFileSync(path.join(cwd, ".env"), "X_CLIENT_ID=mine\n");
  await init({ prompter: scripted(["manual"]).p, cwd, packageRoot: projectRoot, log: () => {} });
  assert.equal(readFileSync(path.join(cwd, ".env"), "utf8"), "X_CLIENT_ID=mine\n");
});

test("guided setup keeps an existing .env unless the user agrees to replace it", async () => {
  const cwd = dir();
  writeFileSync(path.join(cwd, ".env"), "X_CLIENT_ID=mine\n");
  const { p } = scripted(["1", "n", "1", "1", "", "y"]); // keep .env; remove; preset 1; no instructions; save
  await init({ prompter: p, fetch: fakeFetch({}).f, cwd, packageRoot: projectRoot, log: () => {} });
  assert.equal(readFileSync(path.join(cwd, ".env"), "utf8"), "X_CLIENT_ID=mine\n");
  assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, "scrub.config.json"), "utf8")), { mode: "remove", topics: [JSON.parse(readFileSync(path.join(projectRoot, "scrub.presets.json"), "utf8")).remove[0]] });
});

test("declining the final confirmation starts the topic questions over", async () => {
  const cwd = dir();
  writeFileSync(path.join(cwd, ".env"), "x\n");
  const { p } = scripted(["1", "n", "1", "first", "", "n", "2", "second", "", "y"]);
  await init({ prompter: p, fetch: fakeFetch({}).f, cwd, packageRoot: projectRoot, log: () => {} });
  assert.deepEqual(JSON.parse(readFileSync(path.join(cwd, "scrub.config.json"), "utf8")), { mode: "keep_only", topics: ["second"] });
});

test("parseTopicSelection mixes presets and custom text without duplicates", () => {
  assert.deepEqual(parseTopicSelection("1, 3, Foo bar, foo BAR, 9", ["a", "b", "c"]), ["a", "c", "Foo bar", "9"]);
  assert.deepEqual(parseTopicSelection(" , ", ["a"]), []);
});

test("ensureGitignore appends only what is missing and only inside a git repo", () => {
  const plainDir = dir();
  assert.deepEqual(ensureGitignore(plainDir), []);
  assert.ok(!existsSync(path.join(plainDir, ".gitignore")));

  const repo = dir();
  mkdirSync(path.join(repo, ".git"));
  assert.equal(ensureGitignore(repo).length, 4);
  assert.deepEqual(ensureGitignore(repo), []);

  const partial = dir();
  writeFileSync(path.join(partial, ".gitignore"), "node_modules/\n/.env\ndata");
  assert.deepEqual(ensureGitignore(partial), [".x_tokens.json", "scrub.config.json"]);
  assert.equal(readFileSync(path.join(partial, ".gitignore"), "utf8"), "node_modules/\n/.env\ndata\n.x_tokens.json\nscrub.config.json\n");
});

// ---- X key check: reject only on a definite invalid_client ----

test("X check: invalid_client is the only rejection, and it shows X's error code but never the secret", async () => {
  const r = await checkXCredentials("my-id", SECRET, fakeFetch({ x: { status: 400, body: { error: "invalid_client", error_description: "nope" } } }).f);
  assert.ok(r.status === "bad");
  assert.match(r.message, /invalid_client \(HTTP 400\)/);
  assert.ok(!r.message.includes(SECRET));
  // the same code on a 401 is still a definite rejection
  assert.equal((await checkXCredentials("a", "b", fakeFetch({ x: { status: 401, body: { error: "invalid_client" } } }).f)).status, "bad");
});

test("X check: a valid pair (X complains about the throwaway code) is ok", async () => {
  for (const error of ["invalid_grant", "invalid_request"]) {
    assert.equal((await checkXCredentials("a", "b", fakeFetch({ x: { status: 400, body: { error } } }).f)).status, "ok");
  }
});

test("X check: network error, 429, 5xx and surprises are unverified, never a rejection", async () => {
  const cases: Array<Reply | Error> = [
    new Error("offline"),
    { status: 429, body: { error: "rate_limited" } },
    { status: 500 },
    { status: 503, body: { error: "server_error" } },
    { status: 401 }, // no error code: not a definite invalid_client
    { status: 401, body: { error: "unauthorized_client" } },
    { status: 200, body: { access_token: "x" } },
    { status: 400, body: { error: "something_new" } },
    { status: 400, body: "not an object" },
  ];
  for (const x of cases) {
    const r = await checkXCredentials("a", SECRET, fakeFetch({ x }).f);
    assert.equal(r.status, "unverified", JSON.stringify(x instanceof Error ? x.message : x));
    assert.ok(r.status === "unverified" && !r.message.includes(SECRET));
  }
});

test("X check sends trimmed credentials", async () => {
  const { f, calls } = fakeFetch({ x: goodX });
  await checkXCredentials(" id-1\n", `\u200b${SECRET}\t `, f);
  assert.equal(Buffer.from(calls[0]!.auth.replace("Basic ", ""), "base64").toString(), `id-1:${SECRET}`);
  assert.equal(cleanKey("\ufeff  abc \r\n"), "abc");
});

test("guided setup trims pasted keys, and an unverified key is used only after the user agrees", async () => {
  const cwd = dir();
  const { p, left } = scripted([
    "1",
    "  id-2  ", `${SECRET}\n `, // pasted with stray whitespace
    "y", // X could not be verified (503) -> use anyway
    "xai",
    "  ai-key  ", "", // xai, default model
    "1", "1", "", "y",
  ]);
  const { f, calls } = fakeFetch({ x: { status: 503 }, ai: { status: 200 } });
  await init({ prompter: p, fetch: f, cwd, packageRoot: projectRoot, log: () => {} });
  assert.equal(left(), 0);
  const env = readFileSync(path.join(cwd, ".env"), "utf8");
  assert.match(env, /^X_CLIENT_ID=id-2\nX_CLIENT_SECRET=sekrit-value-123\nAI_PROVIDER=xai\nXAI_API_KEY=ai-key\n$/);
  assert.equal(calls[1]!.auth, "Bearer ai-key");
});

test("declining an unverified key asks for the keys again instead of saving", async () => {
  const cwd = dir();
  const { p } = scripted(["1", "id", SECRET, "n", "id", SECRET, "y", "openai", "k", "m", "1", "1", "", "y"]);
  await init({ prompter: p, fetch: fakeFetch({ x: new Error("offline"), ai: { status: 200 } }).f, cwd, packageRoot: projectRoot, log: () => {} });
  assert.match(readFileSync(path.join(cwd, ".env"), "utf8"), /X_CLIENT_ID=id\n/);
});

// ---- the instructions field: the exact string survives the editor and the saved file ----

const INSTRUCTIONS =
  "Politics: elections, politicians, parties, government policy fights, partisan commentary, culture-war topics, taking sides in geopolitical conflicts, presidential and administration statements or actions. NOT political: stocks, finance, investing, company news (Palantir), AI and tech industry debates, even if a government is mentioned. A reply is political only if it takes a political stance. Link-only reposts: political or government accounts are political; tech or finance accounts, keep.";

test("the 494-character instructions string is saved exactly as entered", async () => {
  assert.equal(INSTRUCTIONS.length, 494);
  assert.ok(INSTRUCTIONS.includes("culture-war topics, taking sides"));
  const cwd = dir();
  writeFileSync(path.join(cwd, ".env"), "x\n");
  const { p } = scripted(["1", "n", "1", "1", INSTRUCTIONS, "y"]);
  await init({ prompter: p, cwd, packageRoot: projectRoot, log: () => {} });
  const saved = JSON.parse(readFileSync(path.join(cwd, "scrub.config.json"), "utf8"));
  assert.equal(saved.instructions, INSTRUCTIONS);
});

function tty() {
  const stdin = Object.assign(new PassThrough(), { setRawMode: (_m: boolean) => {} });
  const out: string[] = [];
  return { stdin, io: { stdin, stdout: { write: (c: string) => void out.push(c) } }, out };
}

test("the raw-mode editor returns the pasted string exactly: whole, per character, split anywhere, bracketed", async () => {
  const wraps = [(s: string) => s, (s: string) => `\x1b[200~${s}\x1b[201~`];
  for (const wrap of wraps) {
    const input = wrap(INSTRUCTIONS);
    const splits = [0, 1, input.indexOf(", taking"), input.indexOf(",") + 1, input.indexOf(" taking"), input.length];
    for (const at of splits) {
      const t = tty();
      const result = readTty("Extra instructions", { max: 500 }, t.io);
      t.stdin.write(input.slice(0, at));
      await new Promise((r) => setImmediate(r));
      t.stdin.write(input.slice(at) + "\r");
      assert.equal(await result, INSTRUCTIONS, `split at ${at}`);
    }
  }
  const t = tty();
  const result = readTty("Extra instructions", { max: 500 }, t.io);
  for (const ch of INSTRUCTIONS) t.stdin.write(ch);
  t.stdin.write("\r");
  assert.equal(await result, INSTRUCTIONS);
  assert.ok(t.out.some((o) => o.includes("(494/500)")), "the counter shows 494/500");
});

test("the editor caps input at the limit, handles backspace, turns a pasted newline into a space, and cancels on Ctrl+C", async () => {
  let t = tty();
  let result = readTty("q", { max: 5 }, t.io);
  t.stdin.write("abcdefgh\r");
  assert.equal(await result, "abcde");

  t = tty();
  result = readTty("q", {}, t.io);
  t.stdin.write("abc\x7f\x7fxy\r");
  assert.equal(await result, "axy");

  t = tty();
  result = readTty("q", {}, t.io);
  t.stdin.write("\x1b[200~topics,\r\ntaking\x1b[201~\r");
  assert.equal(await result, "topics, taking");

  t = tty();
  result = readTty("q", { secret: true }, t.io);
  t.stdin.write(`${SECRET}\r`);
  assert.equal(await result, SECRET);
  assert.ok(!t.out.join("").includes(SECRET), "a secret is never echoed");

  t = tty();
  result = readTty("q", {}, t.io);
  t.stdin.write("\x03");
  await assert.rejects(result, ConfigError);
});

// ---- final screen per launch mode ----

const home = () => stateDir();

test("final screen, launched through npm run: npm run commands, -- before flags, run from the repo", async () => {
  const cwd = dir();
  writeFileSync(path.join(cwd, ".env"), "x\n");
  const lines: string[] = [];
  await init({ prompter: scripted(["1", "n", "1", "1", "", "y"]).p, cwd, packageRoot: projectRoot, viaNpm: true, log: (l) => lines.push(l) });
  const screen = lines.slice(lines.indexOf("\nNext:")).join("\n");
  assert.equal(
    screen,
    [
      "\nNext:",
      "  npm run auth                 log in to X in your browser (once)",
      "  npm run scan                 read your timeline: about $3 per 3,200 posts (measured on one account)",
      "  npm run classify             label every row",
      "  npm run delete -- --dry-run  see what would be removed",
      "Un-reposts are limited to 50 per 15 minutes, so 1,400 reposts takes about 7 hours.",
      `Run these from the repo folder. .env and scrub.config.json are read from the current folder, then from ${home()}.`,
    ].join("\n"),
  );
  assert.ok(!screen.includes("x-unrepost auth"));
});

test("final screen, launched directly: x-unrepost commands", async () => {
  const cwd = dir();
  writeFileSync(path.join(cwd, ".env"), "x\n");
  const lines: string[] = [];
  await init({ prompter: scripted(["1", "n", "1", "1", "", "y"]).p, cwd, packageRoot: projectRoot, viaNpm: false, log: (l) => lines.push(l) });
  const screen = lines.slice(lines.indexOf("\nNext:")).join("\n");
  assert.equal(
    screen,
    [
      "\nNext:",
      "  x-unrepost auth              log in to X in your browser (once)",
      "  x-unrepost scan              read your timeline: about $3 per 3,200 posts (measured on one account)",
      "  x-unrepost classify          label every row",
      "  x-unrepost delete --dry-run  see what would be removed",
      "Un-reposts are limited to 50 per 15 minutes, so 1,400 reposts takes about 7 hours.",
      `Run x-unrepost from this folder. .env and scrub.config.json are read from the current folder, then from ${home()}.`,
    ].join("\n"),
  );
  assert.ok(!screen.includes("npm run"));
});

test("manual setup closing lines follow the launch mode too", async () => {
  for (const viaNpm of [true, false]) {
    const lines: string[] = [];
    await init({ prompter: scripted(["2"]).p, cwd: dir(), packageRoot: projectRoot, viaNpm, log: (l) => lines.push(l) });
    const out = lines.join("\n");
    assert.equal(out.includes("Then run: npm run auth"), viaNpm);
    assert.equal(out.includes("Then run: x-unrepost auth"), !viaNpm);
  }
});

test("commandLine puts -- before flags only for npm run", () => {
  assert.equal(commandLine(true, "delete", "--dry-run"), "npm run delete -- --dry-run");
  assert.equal(commandLine(true, "scan"), "npm run scan");
  assert.equal(commandLine(false, "delete", "--dry-run"), "x-unrepost delete --dry-run");
});
