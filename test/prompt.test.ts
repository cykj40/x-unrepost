import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Criteria } from "../src/criteria.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

// Plain-file snapshots (node:test's snapshot API needs Node 22+; the project supports 20.12).
// Regenerate with: UPDATE_SNAPSHOTS=1 npm test
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function matchesSnapshot(name: string, actual: string): void {
  const file = path.join(fixtures, name);
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(file, actual + "\n");
    return;
  }
  assert.equal(actual + "\n", readFileSync(file, "utf8"), `${name} changed; run UPDATE_SNAPSHOTS=1 npm test if intended`);
}

const remove: Criteria = { mode: "remove", topics: ["topic alpha", "topic beta"], instructions: "Example extra rule." };
const keepOnly: Criteria = { mode: "keep_only", topics: ["topic alpha", "topic beta"], instructions: "Example extra rule." };

test("snapshot: mode remove", () => {
  matchesSnapshot("prompt-remove.txt", buildSystemPrompt(remove));
});

test("snapshot: mode keep_only", () => {
  matchesSnapshot("prompt-keep_only.txt", buildSystemPrompt(keepOnly));
});

test("the template encodes the label rules for each mode", () => {
  const r = buildSystemPrompt(remove);
  assert.match(r, /"remove": the post's main subject is one of the topics/);
  assert.match(r, /"keep": the post's main subject is not one of the topics/);
  const k = buildSystemPrompt(keepOnly);
  assert.match(k, /"keep": the post's main subject is one of the topics/);
  assert.match(k, /"remove": the post is clearly off-topic/);
  for (const p of [r, k]) {
    assert.match(p, /Judge a repost or quote by what it says, not by who wrote it/);
    assert.match(p, /When in doubt, answer "borderline"/);
    assert.match(p, /at most 12 words/);
  }
});

test("instructions are included and flagged as taking priority; omitted when absent", () => {
  assert.match(buildSystemPrompt(remove), /take priority[^\n]*\nExample extra rule\./);
  assert.doesNotMatch(buildSystemPrompt({ mode: "remove", topics: ["x"] }), /Extra rules from the user/);
});

test("no topic is hard-coded: swapping the topics only changes the topic lines", () => {
  const a = buildSystemPrompt({ mode: "remove", topics: ["ZZTOPIC1", "ZZTOPIC2"] });
  const b = buildSystemPrompt({ mode: "remove", topics: ["YYTOPIC1", "YYTOPIC2"] });
  assert.equal(a.replaceAll("ZZTOPIC", "YYTOPIC"), b);
});
