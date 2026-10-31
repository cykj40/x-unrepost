import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildStatus, run } from "../src/commands/status.ts";
import { verify } from "../src/commands/verify.ts";
import { criteriaHash, type Criteria } from "../src/criteria.ts";
import { saveRows } from "../src/store.ts";
import { PostRow } from "../src/types.ts";
import type { XClient } from "../src/xclient.ts";

const criteria: Criteria = { mode: "remove", topics: ["topic alpha"] };
const hash = criteriaHash(criteria);
const row = (id: string, over: Partial<PostRow> = {}) =>
  PostRow.parse({ id, type: "repost", created_at: `2026-01-0${id}T00:00:00Z`, text: id, ...over });

test("status reports counts, stale and unlabeled rows, topics, scan state and ETA", () => {
  const rows = [
    row("1", { label: "remove", topic: "Topic Alpha", criteria_hash: hash }),
    row("2", { label: "remove", topic: "topic alpha", criteria_hash: hash }),
    row("3", { label: "borderline", criteria_hash: hash }),
    row("4", { label: "keep", criteria_hash: hash }),
    row("5", { label: "remove", criteria_hash: "deadbeef" }),
    row("6"),
    row("7", { label: "remove", criteria_hash: hash, status: "deleted" }),
    row("8", { type: "reply", label: "remove", topic: "topic alpha", criteria_hash: hash, status: "failed", error: "x" }),
  ];
  const text = buildStatus({ rows, criteria, scanComplete: true }).join("\n");
  assert.match(text, /mode=remove.*hash/);
  assert.match(text, /Scan: complete/);
  assert.match(text, /Stale .*: 1/);
  assert.match(text, /Unlabeled: 1/);
  assert.match(text, /Top matched topics: Topic Alpha \(3\)/);
  assert.match(text, /remove 3 \(2 reposts, 1 other\), borderline 1 \(1 reposts, 0 other\)/);
  assert.match(text, /reposts labeled remove 1 min; with borderline 1 min/);
  assert.match(text, /repost\s+remove\s+deleted\s+1/);
  assert.match(text, /Failed: 1/);
});

test("status works with no criteria and no rows; run reads files and takes no flags", async () => {
  assert.match(buildStatus({ rows: [], criteriaProblem: "no config" }).join("\n"), /not available \(no config\)[\s\S]*no scan state yet/);
  const dir = mkdtempSync(path.join(tmpdir(), "status-"));
  mkdirSync(path.join(dir, "data"));
  const postsCsv = path.join(dir, "data", "posts.csv");
  saveRows([row("1", { label: "keep", criteria_hash: hash })], postsCsv);
  const lines: string[] = [];
  await run([], { postsCsv, scanStateFile: path.join(dir, "none.json"), criteria, log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /Rows: 1/);
});

function mockTimeline(pages: string[][]) {
  let calls = 0;
  const client: Pick<XClient, "me" | "userTweets"> = {
    async me() {
      return { id: "42", username: "me" };
    },
    async userTweets() {
      const ids = pages[calls]!;
      calls++;
      return {
        data: ids.map((id) => ({ id, text: "", created_at: `2026-01-0${id}T00:00:00Z` })),
        includes: { tweets: [], users: [] },
        meta: calls < pages.length ? { next_token: `t${calls}` } : {},
      };
    },
  };
  return { client, calls: () => calls };
}

function csv(rows: PostRow[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-"));
  const file = path.join(dir, "posts.csv");
  saveRows(rows, file);
  return file;
}

test("verify flags a deleted row that still appears on the timeline", async () => {
  const postsCsv = csv([row("3", { status: "deleted" }), row("4", { status: "deleted" }), row("5")]);
  const { client } = mockTimeline([["5", "4"], ["2"]]);
  const lines: string[] = [];
  const result = await verify({ client, postsCsv, pages: 2, log: (l) => lines.push(l) });
  assert.deepEqual(result.stillPresent.map((r) => r.id), ["4"]);
  assert.match(lines.join("\n"), /1 row\(s\) marked deleted still appear/);
});

test("verify reports clean when nothing deleted shows up, and ignores rows older than the fetched range", async () => {
  const postsCsv = csv([row("1", { status: "deleted" }), row("4", { status: "deleted" })]);
  const { client, calls } = mockTimeline([["5", "3"], ["2"]]);
  const result = await verify({ client, postsCsv, pages: 1, log: () => {} });
  assert.equal(calls(), 1); // only the requested page is read
  assert.equal(result.stillPresent.length, 0);
  assert.equal(result.checked, 1); // row 1 is older than the oldest fetched tweet: out of range
});
