import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deleteRows, parseDeleteArgs, run, type DeleteOptions } from "../src/commands/delete.ts";
import { criteriaHash, type Criteria } from "../src/criteria.ts";
import { loadRows, saveRows } from "../src/store.ts";
import { PostRow } from "../src/types.ts";
import { XApiError } from "../src/xclient.ts";

const criteria: Criteria = { mode: "remove", topics: ["topic alpha"] };
const hash = criteriaHash(criteria);

const row = (id: string, over: Partial<PostRow> = {}) =>
  PostRow.parse({ id, type: "repost", target_id: `src${id}`, text: `text ${id}`, label: "remove", topic: "topic alpha", criteria_hash: hash, ...over });

function setup(rows: PostRow[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "delete-"));
  mkdirSync(path.join(dir, "data"));
  const postsCsv = path.join(dir, "data", "posts.csv");
  saveRows(rows, postsCsv);
  return postsCsv;
}

type Call = { method: "me" | "unrepost" | "deleteTweet"; args: string[] };

/** A mocked client that records every call; `outcome` can return "gone" or throw per call. */
function mockClient(outcome: (call: Call) => "ok" | "gone" | Error = () => "ok") {
  const calls: Call[] = [];
  const act = async (method: "unrepost" | "deleteTweet", args: string[]) => {
    const call = { method, args };
    calls.push(call);
    const r = outcome(call);
    if (r instanceof Error) throw r;
    return r;
  };
  const client: NonNullable<DeleteOptions["client"]> = {
    async me() {
      calls.push({ method: "me", args: [] });
      return { id: "42", username: "me" };
    },
    unrepost: (userId, id) => act("unrepost", [userId, id]),
    deleteTweet: (id) => act("deleteTweet", [id]),
  };
  const writes = () => calls.filter((c) => c.method !== "me");
  return { client, calls, writes };
}

function opts(postsCsv: string, argv: string[], extra: Partial<DeleteOptions> = {}) {
  const lines: string[] = [];
  const o: DeleteOptions = { ...parseDeleteArgs(argv), criteria, postsCsv, log: (l) => lines.push(l), ...extra };
  return { o, lines };
}

test("--dry-run makes zero client calls and prints counts by label and type", async () => {
  const postsCsv = setup([row("1"), row("2", { label: "borderline" }), row("3", { type: "reply" })]);
  const { client, calls } = mockClient();
  const { o, lines } = opts(postsCsv, ["--dry-run", "--include-borderline", "--types", "repost,reply"], { client });
  const summary = await deleteRows(o);
  assert.equal(calls.length, 0);
  assert.equal(summary.attempted, 0);
  const text = lines.join("\n");
  assert.match(text, /Would delete 3 row\(s\)/);
  assert.match(text, /remove: 2, borderline: 1/);
  assert.match(text, /repost: 2, reply: 1/);
  assert.match(text, /ETA/);
  assert.deepEqual(loadRows(postsCsv).map((r) => r.status), ["", "", ""]);
});

test("--dry-run needs no client at all (run with no credentials)", async () => {
  const postsCsv = setup([row("1")]);
  const lines: string[] = [];
  await run(["--dry-run"], { criteria, postsCsv, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /Would delete 1 row/);
});

test("rows labeled under a different criteria hash are skipped with a warning", async () => {
  const postsCsv = setup([row("1"), row("2", { criteria_hash: "deadbeef" })]);
  const { client, writes } = mockClient();
  const { o, lines } = opts(postsCsv, [], { client });
  const summary = await deleteRows(o);
  assert.equal(summary.stale, 1);
  assert.deepEqual(writes().map((c) => c.args[1]), ["src1"]);
  assert.match(lines.join("\n"), /skipping 1 row\(s\) labeled under different criteria.*classify/);
  assert.equal(loadRows(postsCsv)[1]!.status, "");
});

test("--include-borderline adds exactly the borderline rows", async () => {
  const rows = [row("1"), row("2", { label: "borderline" }), row("3", { label: "keep" }), row("4", { label: "borderline", reviewed: "yes" }), row("5", { label: "" })];
  const without = mockClient();
  await deleteRows(opts(setup(rows), [], { client: without.client }).o);
  assert.deepEqual(without.writes().map((c) => c.args[1]), ["src1"]);

  const withB = mockClient();
  await deleteRows(opts(setup(rows), ["--include-borderline"], { client: withB.client }).o);
  assert.deepEqual(withB.writes().map((c) => c.args[1]), ["src1", "src2", "src4"]);
});

test("--types reply requires typing DELETE; wrong input aborts with nothing deleted", async () => {
  const rows = [row("1", { type: "reply" }), row("2")];
  const postsCsv = setup(rows);
  const wrong = mockClient();
  const prompts: string[] = [];
  const { o } = opts(postsCsv, ["--types", "repost,reply"], {
    client: wrong.client,
    confirm: async (p) => (prompts.push(p), "delete"),
  });
  const summary = await deleteRows(o);
  assert.equal(summary.aborted, true);
  assert.equal(prompts.length, 1);
  assert.equal(wrong.calls.length, 0);
  assert.deepEqual(loadRows(postsCsv).map((r) => r.status), ["", ""]);

  const right = mockClient();
  const ok = await deleteRows(opts(postsCsv, ["--types", "repost,reply"], { client: right.client, confirm: async () => "DELETE" }).o);
  assert.equal(ok.aborted, false);
  assert.deepEqual(right.writes().map((c) => [c.method, ...c.args]), [
    ["deleteTweet", "1"],
    ["unrepost", "42", "src2"],
  ]);
});

test("repost-only runs never ask for confirmation", async () => {
  const { client } = mockClient();
  const { o } = opts(setup([row("1")]), [], {
    client,
    confirm: async () => assert.fail("must not prompt for reposts"),
  });
  assert.equal((await deleteRows(o)).deleted, 1);
});

test("a 404 sets status gone", async () => {
  const postsCsv = setup([row("1")]);
  const { client } = mockClient(() => "gone");
  const summary = await deleteRows(opts(postsCsv, [], { client }).o);
  assert.equal(summary.gone, 1);
  assert.equal(loadRows(postsCsv)[0]!.status, "gone");
});

test("a failure sets status failed with the message and continues; failed rows are retried", async () => {
  const postsCsv = setup([row("1"), row("2")]);
  const first = mockClient((c) => (c.args[1] === "src1" ? new XApiError(403, "forbidden\nnope") : "ok"));
  const summary = await deleteRows(opts(postsCsv, [], { client: first.client }).o);
  assert.equal(summary.failed, 1);
  assert.equal(summary.deleted, 1);
  const saved = loadRows(postsCsv);
  assert.equal(saved[0]!.status, "failed");
  assert.match(saved[0]!.error, /forbidden nope/);
  assert.equal(saved[1]!.status, "deleted");

  const second = mockClient();
  await deleteRows(opts(postsCsv, [], { client: second.client }).o);
  assert.deepEqual(second.writes().map((c) => c.args[1]), ["src1"]);
  const after = loadRows(postsCsv)[0]!;
  assert.equal(after.status, "deleted");
  assert.equal(after.error, "");
});

test("rerunning skips finished rows", async () => {
  const postsCsv = setup([row("1"), row("2", { status: "deleted" }), row("3", { status: "gone" }), row("4")]);
  const { client, writes } = mockClient();
  await deleteRows(opts(postsCsv, [], { client }).o);
  assert.deepEqual(writes().map((c) => c.args[1]), ["src1", "src4"]);
  const again = mockClient();
  const summary = await deleteRows(opts(postsCsv, [], { client: again.client }).o);
  assert.equal(again.calls.length, 0);
  assert.equal(summary.attempted, 0);
});

test("--limit stops after N and --topic filters on the matched topic", async () => {
  const postsCsv = setup([row("1"), row("2", { topic: "Other" }), row("3"), row("4")]);
  const limited = mockClient();
  await deleteRows(opts(postsCsv, ["--limit", "2"], { client: limited.client }).o);
  assert.deepEqual(limited.writes().map((c) => c.args[1]), ["src1", "src2"]);

  const topical = mockClient();
  await deleteRows(opts(postsCsv, ["--topic", "other"], { client: topical.client }).o);
  assert.deepEqual(topical.writes().map((c) => c.args[1]), []); // src2 already handled above
  const fresh = setup([row("1"), row("2", { topic: "Other" })]);
  const only = mockClient();
  await deleteRows(opts(fresh, ["--topic", "other"], { client: only.client }).o);
  assert.deepEqual(only.writes().map((c) => c.args[1]), ["src2"]);
});

test("a stop request finishes the current item, saves, and exits cleanly", async () => {
  const postsCsv = setup([row("1"), row("2"), row("3")]);
  const { client, writes } = mockClient();
  let stop = false;
  const wrapped: typeof client = {
    ...client,
    async unrepost(u, id) {
      const r = await client.unrepost(u, id);
      stop = true; // SIGINT arrives while the first item is in flight
      return r;
    },
  };
  const summary = await deleteRows(opts(postsCsv, [], { client: wrapped, shouldStop: () => stop }).o);
  assert.equal(summary.interrupted, true);
  assert.equal(writes().length, 1);
  assert.deepEqual(loadRows(postsCsv).map((r) => r.status), ["deleted", "", ""]);
});

const failing = (status = 500) => new XApiError(status, "boom");

test("5 consecutive failures stop the run and leave the rest untouched", async () => {
  const postsCsv = setup(Array.from({ length: 8 }, (_, i) => row(String(i + 1))));
  const { client, writes } = mockClient(() => failing());
  const { o, lines } = opts(postsCsv, [], { client });
  const summary = await deleteRows(o);
  assert.equal(summary.tripped, true);
  assert.equal(writes().length, 5);
  assert.deepEqual(loadRows(postsCsv).map((r) => r.status), ["failed", "failed", "failed", "failed", "failed", "", "", ""]);
  const text = lines.join("\n");
  assert.match(text, /Last error: .*boom/);
  assert.match(text, /rerun the same command to resume/);
  assert.doesNotMatch(text, /check your X API credits/);
});

test("a 402 or 403 as the last error adds the credits/permissions hint", async () => {
  for (const status of [402, 403]) {
    const { client } = mockClient(() => failing(status));
    const { o, lines } = opts(setup(Array.from({ length: 6 }, (_, i) => row(String(i + 1)))), [], { client });
    await deleteRows(o);
    assert.match(lines.join("\n"), /check your X API credits and app permissions/);
  }
});

test("a success in between resets the failure count", async () => {
  // fail x4, ok, fail x4, ok: never 5 in a row
  const pattern = [1, 1, 1, 1, 0, 1, 1, 1, 1, 0];
  let n = 0;
  const { client, writes } = mockClient(() => (pattern[n++] ? failing() : "ok"));
  const postsCsv = setup(pattern.map((_, i) => row(String(i + 1))));
  const summary = await deleteRows(opts(postsCsv, [], { client }).o);
  assert.equal(summary.tripped, false);
  assert.equal(writes().length, 10);
});

test("a 404 (gone) is not a failure and does not trip the breaker", async () => {
  // Ten gone rows never trip it; a gone between failures leaves the streak at 4, not 5.
  const gone = mockClient(() => "gone");
  const many = await deleteRows(opts(setup(Array.from({ length: 10 }, (_, i) => row(String(i + 1)))), [], { client: gone.client }).o);
  assert.equal(many.tripped, false);
  assert.equal(many.failed, 0);

  const pattern = ["f", "f", "f", "g", "f", "ok"];
  let n = 0;
  const { client } = mockClient(() => {
    const p = pattern[n++];
    return p === "f" ? failing() : p === "g" ? "gone" : "ok";
  });
  const summary = await deleteRows(opts(setup(pattern.map((_, i) => row(String(i + 1)))), [], { client }).o);
  assert.equal(summary.tripped, false);
  assert.equal(summary.failed, 4);
});
