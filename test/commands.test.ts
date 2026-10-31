import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run as runAuth } from "../src/commands/auth.ts";
import { parseClassifyArgs, run as runClassify } from "../src/commands/classify.ts";
import { parseDeleteArgs, run as runDelete } from "../src/commands/delete.ts";
import { parseReviewArgs, run as runReview } from "../src/commands/review.ts";
import { run as runScan } from "../src/commands/scan.ts";
import { run as runStatus } from "../src/commands/status.ts";
import { ConfigError } from "../src/errors.ts";
import type { UserTweetsPage, XTweet } from "../src/xclient.ts";

const oneLineConfigError = (e: unknown) => e instanceof ConfigError && e.problems.length === 1;

// ---- scan: run(argv) with a mocked client ----

const tweet = (id: string): XTweet => ({ id, text: `t${id}` });
const page = (ids: string[], next?: string): UserTweetsPage => ({
  data: ids.map(tweet),
  includes: { tweets: [], users: [] },
  meta: next ? { next_token: next } : {},
});

function scanSetup() {
  const dir = mkdtempSync(path.join(tmpdir(), "cmd-"));
  mkdirSync(path.join(dir, "data"));
  const tokens: Array<string | undefined> = [];
  let meCalls = 0;
  const pages = [page(["1"], "t1"), page(["2"], "t2"), page(["3"])];
  const client = {
    me: async () => (meCalls++, { id: "42", username: "me" }),
    userTweets: async (_id: string, token?: string) => {
      tokens.push(token);
      const next = pages[tokens.length - 1];
      if (!next) throw new Error("unexpected extra page request");
      return next;
    },
  };
  const deps = {
    client,
    postsCsv: path.join(dir, "data", "posts.csv"),
    scanStateFile: path.join(dir, "data", "scan_state.json"),
    log: () => {},
  };
  return { deps, tokens, meCalls: () => meCalls, stateFile: deps.scanStateFile };
}

test("scan: `--max-pages 1` reaches scan() and stops after one page", async () => {
  const s = scanSetup();
  await runScan(["--max-pages", "1"], s.deps);
  assert.deepEqual(s.tokens, [undefined]);
  assert.equal(JSON.parse(readFileSync(s.stateFile, "utf8")).complete, false);
});

test("scan: `--max-pages=1` reaches scan() and stops after one page", async () => {
  const s = scanSetup();
  await runScan(["--max-pages=1"], s.deps);
  assert.deepEqual(s.tokens, [undefined]);
});

test("scan: no flag runs the whole scan", async () => {
  const s = scanSetup();
  await runScan([], s.deps);
  assert.equal(s.tokens.length, 3);
});

test("scan: `--fresh` ignores a saved cursor", async () => {
  const s = scanSetup();
  writeFileSync(s.stateFile, JSON.stringify({ user_id: "42", next_token: "old", complete: false }));
  await runScan(["--fresh"], s.deps);
  assert.deepEqual(s.tokens, [undefined, "t1", "t2"]);
});

test("scan: without --fresh the saved cursor is used", async () => {
  const s = scanSetup();
  writeFileSync(s.stateFile, JSON.stringify({ user_id: "42", next_token: "old", complete: false }));
  await runScan(["--max-pages", "1"], s.deps);
  assert.deepEqual(s.tokens, ["old"]);
});

test("scan: bad flags error out before any client call", async () => {
  for (const argv of [["--bogus"], ["--max-pages", "abc"], ["--max-pages=abc"], ["--max-pages"], ["--max-pages=0"], ["--max-pages="], ["--max-pages", "1.5"], ["--fresh=yes"], ["extra"]]) {
    const s = scanSetup();
    await assert.rejects(runScan(argv, s.deps), oneLineConfigError, argv.join(" "));
    assert.equal(s.meCalls(), 0, `${argv.join(" ")}: client must not be called`);
    assert.equal(s.tokens.length, 0);
  }
});

// ---- the other commands: flags are declared with the right types; anything else is an error ----

test("classify: every documented flag parses", () => {
  const a = parseClassifyArgs(["--limit", "40", "--relabel", "--config", "c.json", "--remove", "a,b", "--instructions", "x"]);
  assert.deepEqual(a, { limit: 40, relabel: true, configPath: "c.json", removeFlag: "a,b", keepOnlyFlag: undefined, instructionsFlag: "x" });
  assert.equal(parseClassifyArgs(["--keep-only=ai", "--limit=5"]).keepOnlyFlag, "ai");
  assert.equal(parseClassifyArgs([]).relabel, false);
});

test("classify: unknown flag and bad --limit error", async () => {
  await assert.rejects(runClassify(["--bogus"]), oneLineConfigError);
  await assert.rejects(runClassify(["--limit", "abc"]), oneLineConfigError);
  await assert.rejects(runClassify(["--limit=0"]), oneLineConfigError);
  await assert.rejects(runClassify(["--relabel=yes"]), oneLineConfigError);
  await assert.rejects(runClassify(["--remove"]), oneLineConfigError);
});

test("review: --label parses, defaults to borderline, rejects bad values", async () => {
  assert.equal(parseReviewArgs([]).label, "borderline");
  assert.equal(parseReviewArgs(["--label", "remove"]).label, "remove");
  assert.equal(parseReviewArgs(["--label=keep"]).label, "keep");
  await assert.rejects(runReview(["--label", "bogus"]), oneLineConfigError);
  await assert.rejects(runReview(["--bogus"]), oneLineConfigError);
  await assert.rejects(runReview(["--label"]), oneLineConfigError);
});

test("delete: every documented flag parses; types default to repost", async () => {
  assert.deepEqual(parseDeleteArgs([]), {
    types: ["repost"],
    dryRun: false,
    includeBorderline: false,
    limit: undefined,
    topic: undefined,
  });
  assert.deepEqual(parseDeleteArgs(["--types", "repost,reply", "--dry-run", "--include-borderline", "--limit=3", "--topic", "sports"]), {
    types: ["repost", "reply"],
    dryRun: true,
    includeBorderline: true,
    limit: 3,
    topic: "sports",
  });
  await assert.rejects(runDelete(["--types", "bogus"]), oneLineConfigError);
  await assert.rejects(runDelete(["--limit", "abc"]), oneLineConfigError);
  await assert.rejects(runDelete(["--dry-run=1"]), oneLineConfigError);
  await assert.rejects(runDelete(["--bogus"]), oneLineConfigError);
  await assert.rejects(runDelete(["--include-borderline=yes"]), oneLineConfigError);
  await assert.rejects(runDelete(["--topic", " "]), oneLineConfigError);
});

test("status and auth take no flags", async () => {
  await assert.rejects(runStatus(["--bogus"]), oneLineConfigError);
  await assert.rejects(runStatus(["extra"]), oneLineConfigError);
  await assert.rejects(runAuth(["--bogus"]), oneLineConfigError); // fails at parsing, before any login or network
});
