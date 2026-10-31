import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AiResponseError, type JsonChat } from "../src/ai.ts";
import { classify, run } from "../src/commands/classify.ts";
import { criteriaHash, type Criteria } from "../src/criteria.ts";
import { ConfigError } from "../src/errors.ts";
import { loadRows, saveRows } from "../src/store.ts";
import { PostRow } from "../src/types.ts";

const criteria: Criteria = { mode: "remove", topics: ["topic alpha"] };
const hash = criteriaHash(criteria);

const row = (id: string, over: Partial<PostRow> = {}) => PostRow.parse({ id, type: "post", text: `text ${id}`, ...over });

function setup(rows: PostRow[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "classify-"));
  mkdirSync(path.join(dir, "data"));
  const postsCsv = path.join(dir, "data", "posts.csv");
  saveRows(rows, postsCsv);
  return { dir, postsCsv };
}

type Item = { id: string; type: string; author: string; text: string; context: string };
type Reply = unknown | Error | ((items: Item[]) => unknown);

/** A scripted model: each call consumes the next reply; a function reply sees the batch it was sent. */
function mockChat(script: Reply[] = []) {
  const calls: Array<{ system: string; items: Item[] }> = [];
  const queue = [...script];
  const chat: JsonChat = {
    async completeJson(system, user) {
      const items = JSON.parse(user) as Item[];
      calls.push({ system, items });
      const next = queue.length > 0 ? queue.shift() : allKeep;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? (next as (i: Item[]) => unknown)(items) : next;
    },
  };
  return { chat, calls };
}

const result = (id: string, label = "keep", topic = "", reason = "r") => ({ id, label, topic, reason });
const allKeep = (items: Item[]) => ({ results: items.map((i) => result(i.id)) });
const quiet = { log: () => {} };

test("labels rows, stores the hash, clears reviewed, keeps status, and saves", async () => {
  const s = setup([row("1", { reviewed: "yes" }), row("2")]);
  const { chat } = mockChat([(items: Item[]) => ({ results: [result(items[0]!.id, "remove", "topic alpha", "about alpha"), result(items[1]!.id, "borderline", "", "unsure")] })]);
  const out = await classify({ chat, criteria, postsCsv: s.postsCsv, ...quiet });
  const rows = loadRows(s.postsCsv);
  assert.deepEqual(rows.map((r) => [r.label, r.topic, r.reason, r.criteria_hash, r.reviewed]), [
    ["remove", "topic alpha", "about alpha", hash, ""],
    ["borderline", "", "unsure", hash, ""],
  ]);
  assert.deepEqual(out.counts, { remove: 1, borderline: 1, keep: 0 });
});

test("selection: empty label or stale hash, never deleted/gone; --relabel forces all live rows", async () => {
  const rows = [
    row("empty"),
    row("stale", { label: "keep", criteria_hash: "00000000" }),
    row("current", { label: "keep", criteria_hash: hash }),
    row("deleted", { status: "deleted", label: "remove", criteria_hash: "00000000" }),
    row("gone", { status: "gone" }),
    row("failed", { status: "failed" }),
  ];
  const a = setup(rows);
  const first = mockChat();
  await classify({ chat: first.chat, criteria, postsCsv: a.postsCsv, ...quiet });
  assert.deepEqual(first.calls[0]!.items.map((i) => i.id), ["empty", "stale", "failed"]);

  const b = setup(rows);
  const forced = mockChat();
  await classify({ chat: forced.chat, criteria, postsCsv: b.postsCsv, relabel: true, ...quiet });
  assert.deepEqual(forced.calls[0]!.items.map((i) => i.id), ["empty", "stale", "current", "failed"]);
});

test("batches of 20, --limit caps the total, and the batch payload has only the five fields", async () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(String(i + 1), { author: "a", context: "c" }));
  const s = setup(rows);
  const m = mockChat();
  await classify({ chat: m.chat, criteria, postsCsv: s.postsCsv, ...quiet });
  assert.deepEqual(m.calls.map((c) => c.items.length), [20, 20, 5]);
  assert.deepEqual(Object.keys(m.calls[0]!.items[0]!), ["id", "type", "author", "text", "context"]);

  const t = setup(rows);
  const limited = mockChat();
  await classify({ chat: limited.chat, criteria, postsCsv: t.postsCsv, limit: 25, ...quiet });
  assert.deepEqual(limited.calls.map((c) => c.items.length), [20, 5]);
  assert.equal(loadRows(t.postsCsv).filter((r) => r.label).length, 25);
});

test("saves after every batch: a failure in batch 2 keeps batch 1's labels", async () => {
  const s = setup(Array.from({ length: 25 }, (_, i) => row(String(i + 1))));
  const m = mockChat([allKeep, new Error("boom")]);
  await assert.rejects(classify({ chat: m.chat, criteria, postsCsv: s.postsCsv, ...quiet }), /boom/);
  assert.equal(loadRows(s.postsCsv).filter((r) => r.label === "keep").length, 20);
});

test("missing ids: only the leftovers are retried once, then marked borderline 'model error'", async () => {
  const s = setup([row("1"), row("2"), row("3")]);
  const m = mockChat([
    { results: [result("1")] }, // 2 and 3 missing
    { results: [result("2", "remove", "topic alpha")] }, // 3 still missing
  ]);
  const out = await classify({ chat: m.chat, criteria, postsCsv: s.postsCsv, ...quiet });
  assert.deepEqual(m.calls.map((c) => c.items.map((i) => i.id)), [["1", "2", "3"], ["2", "3"]]);
  const byId = Object.fromEntries(loadRows(s.postsCsv).map((r) => [r.id, r]));
  assert.equal(byId["1"]!.label, "keep");
  assert.equal(byId["2"]!.label, "remove");
  assert.deepEqual([byId["3"]!.label, byId["3"]!.reason, byId["3"]!.criteria_hash], ["borderline", "model error", hash]);
  assert.equal(out.modelErrors, 1);
});

test("duplicates, unknown ids, invalid labels and numeric ids all count as missing", async () => {
  const s = setup([row("1"), row("2"), row("3"), row("4")]);
  const m = mockChat([
    {
      results: [
        result("1"), result("1", "remove"), // duplicate: neither is trusted
        result("2", "maybe"),               // invalid label
        { id: 3, label: "keep" },           // numeric id would lose precision
        result("999"),                      // not in the batch
        result("4"),
      ],
    },
    allKeep,
  ]);
  await classify({ chat: m.chat, criteria, postsCsv: s.postsCsv, ...quiet });
  assert.deepEqual(m.calls[1]!.items.map((i) => i.id), ["1", "2", "3"]);
  assert.deepEqual(loadRows(s.postsCsv).map((r) => r.label), ["keep", "keep", "keep", "keep"]);
});

test("unusable model output (bad JSON, wrong shape) is retried once, then 'model error'", async () => {
  const s = setup([row("1")]);
  const m = mockChat([new AiResponseError("did not return valid JSON"), { nope: true }]);
  const out = await classify({ chat: m.chat, criteria, postsCsv: s.postsCsv, ...quiet });
  assert.equal(m.calls.length, 2);
  assert.equal(out.modelErrors, 1);
  assert.equal(loadRows(s.postsCsv)[0]!.reason, "model error");
});

test("reason is cut to 12 words", async () => {
  const s = setup([row("1")]);
  const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
  const m = mockChat([{ results: [result("1", "keep", "", long)] }]);
  await classify({ chat: m.chat, criteria, postsCsv: s.postsCsv, ...quiet });
  assert.equal(loadRows(s.postsCsv)[0]!.reason.split(" ").length, 12);
});

test("same criteria twice is a no-op; changed criteria relabel everything live", async () => {
  const s = setup([row("1"), row("2"), row("3", { status: "deleted", label: "remove", criteria_hash: "00000000" })]);
  await classify({ chat: mockChat().chat, criteria, postsCsv: s.postsCsv, ...quiet });

  const again = mockChat();
  await classify({ chat: again.chat, criteria, postsCsv: s.postsCsv, ...quiet });
  assert.equal(again.calls.length, 0);

  const changed = mockChat();
  await classify({ chat: changed.chat, criteria: { mode: "remove", topics: ["topic beta"] }, postsCsv: s.postsCsv, ...quiet });
  assert.deepEqual(changed.calls[0]!.items.map((i) => i.id), ["1", "2"]);
  assert.match(changed.calls[0]!.system, /topic beta/);
  assert.equal(loadRows(s.postsCsv)[2]!.label, "remove"); // deleted row untouched
});

test("prints the criteria line, the row count, label counts and the top 5 topics", async () => {
  const rows = ["a", "a", "a", "b", "b", "c", "d", "e", "f"].map((t, i) => row(String(i + 1)));
  const topics = ["Alpha", "alpha", "ALPHA", "b", "b", "c", "d", "e", "f"];
  const s = setup(rows);
  const m = mockChat([(items: Item[]) => ({ results: items.map((it, i) => result(it.id, i < 5 ? "remove" : "keep", topics[i])) })]);
  const lines: string[] = [];
  const out = await classify({ chat: m.chat, criteria: { mode: "remove", topics: ["x", "y"], instructions: "i" }, postsCsv: s.postsCsv, log: (l) => lines.push(l) });
  assert.match(lines[0]!, /^Criteria: mode=remove, topics: x, y, instructions: yes \(hash [0-9a-f]{8}\)$/);
  assert.equal(lines[1], "9 of 9 rows to label");
  assert.ok(lines.some((l) => l.startsWith("remove: 5, borderline: 0, keep: 4 (9 labeled")));
  assert.equal(out.topTopics.length, 5);
  assert.deepEqual(out.topTopics[0], { topic: "Alpha", count: 3 }); // case-insensitive grouping
  assert.ok(lines.at(-1)!.startsWith("Top topics: Alpha (3), b (2)"));
});

// ---- run(argv): flag handling ----

function runSetup(config?: unknown) {
  const s = setup([row("1")]);
  const configPath = path.join(s.dir, "scrub.config.json");
  if (config) writeFileSync(configPath, JSON.stringify(config));
  return { ...s, configPath };
}

test("run: --remove overrides the file and reaches the prompt; no instructions carry over", async () => {
  const s = runSetup({ mode: "keep_only", topics: ["from file"], instructions: "file rule" });
  const m = mockChat();
  await run(["--config", s.configPath, "--remove", "flag topic"], { chat: m.chat, postsCsv: s.postsCsv, ...quiet });
  const system = m.calls[0]!.system;
  assert.match(system, /Mode: remove/);
  assert.match(system, /flag topic/);
  assert.doesNotMatch(system, /from file|file rule/);
});

test("run: --keep-only and --instructions", async () => {
  const s = runSetup({ mode: "remove", topics: ["from file"] });
  const m = mockChat();
  await run(["--config", s.configPath, "--keep-only", "ai", "--instructions", "per-run rule"], { chat: m.chat, postsCsv: s.postsCsv, ...quiet });
  assert.match(m.calls[0]!.system, /Mode: keep_only/);
  assert.match(m.calls[0]!.system, /per-run rule/);
});

test("run: uses the config file when no flags are given", async () => {
  const s = runSetup({ mode: "remove", topics: ["file topic"] });
  const m = mockChat();
  await run(["--config", s.configPath], { chat: m.chat, postsCsv: s.postsCsv, ...quiet });
  assert.match(m.calls[0]!.system, /file topic/);
});

test("run: --relabel and --limit are honored", async () => {
  const s = setup([row("1"), row("2")]);
  const cfg = path.join(s.dir, "c.json");
  writeFileSync(cfg, JSON.stringify(criteria));
  await run(["--config", cfg], { chat: mockChat().chat, postsCsv: s.postsCsv, ...quiet });
  const forced = mockChat();
  await run(["--config", cfg, "--relabel", "--limit", "1"], { chat: forced.chat, postsCsv: s.postsCsv, ...quiet });
  assert.deepEqual(forced.calls[0]!.items.map((i) => i.id), ["1"]);
});

test("run: bad flags and criteria error out before any model call", async () => {
  const s = runSetup({ mode: "remove", topics: ["t"] });
  const base = ["--config", s.configPath];
  for (const extra of [["--remove", "a", "--keep-only", "b"], ["--instructions", "x"], ["--limit", "abc"], ["--bogus"]]) {
    const m = mockChat();
    await assert.rejects(run([...base, ...extra], { chat: m.chat, postsCsv: s.postsCsv, ...quiet }), ConfigError, extra.join(" "));
    assert.equal(m.calls.length, 0);
  }
});
