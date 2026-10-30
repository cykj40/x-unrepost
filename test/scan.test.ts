import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scan, tweetToRow } from "../src/commands/scan.ts";
import { loadRows } from "../src/store.ts";
import type { UserTweetsPage, XTweet } from "../src/xclient.ts";

const noIncludes: UserTweetsPage["includes"] = { tweets: [], users: [] };
const tweet = (over: Partial<XTweet> & { id: string }): XTweet => ({ text: `text ${over.id}`, ...over });

test("repost: source text (note_tweet preferred), author via author_id, target_id is the source id", () => {
  const row = tweetToRow(
    tweet({ id: "1", text: "RT @bob: trunc…", referenced_tweets: [{ type: "retweeted", id: "9" }] }),
    {
      tweets: [tweet({ id: "9", text: "short", note_tweet: { text: "the full long text" }, author_id: "7" })],
      users: [{ id: "7", username: "bob" }, { id: "8", username: "other" }],
    },
  );
  assert.equal(row.type, "repost");
  assert.equal(row.target_id, "9");
  assert.equal(row.text, "the full long text");
  assert.equal(row.author, "bob");
});

test("repost with an unavailable source falls back to the RT text and prefix author", () => {
  const row = tweetToRow(
    tweet({ id: "1", text: "RT @carol: gone…", referenced_tweets: [{ type: "retweeted", id: "9" }] }),
    noIncludes,
  );
  assert.equal(row.target_id, "9");
  assert.equal(row.text, "RT @carol: gone…");
  assert.equal(row.author, "carol");
});

test("a repost wins over quote and reply", () => {
  const row = tweetToRow(
    tweet({
      id: "1",
      referenced_tweets: [{ type: "quoted", id: "2" }, { type: "replied_to", id: "3" }, { type: "retweeted", id: "4" }],
    }),
    noIncludes,
  );
  assert.equal(row.type, "repost");
  assert.equal(row.target_id, "4");
});

test("reply puts the replied-to text in context; own id is the target", () => {
  const row = tweetToRow(
    tweet({ id: "1", referenced_tweets: [{ type: "replied_to", id: "5" }] }),
    { tweets: [tweet({ id: "5", text: "parent" })], users: [] },
  );
  assert.equal(row.type, "reply");
  assert.equal(row.context, "parent");
  assert.equal(row.target_id, "1");
});

test("quote carries the quoted text and its author", () => {
  const row = tweetToRow(
    tweet({ id: "1", note_tweet: { text: "my long take" }, referenced_tweets: [{ type: "quoted", id: "6" }] }),
    { tweets: [tweet({ id: "6", text: "quoted", author_id: "7" })], users: [{ id: "7", username: "bob" }] },
  );
  assert.equal(row.type, "quote");
  assert.equal(row.text, "my long take");
  assert.equal(row.context, "quoted");
  assert.equal(row.author, "bob");
});

test("a plain tweet is a post", () => {
  const row = tweetToRow(tweet({ id: "1", created_at: "2026-01-01T00:00:00.000Z" }), noIncludes);
  assert.equal(row.type, "post");
  assert.equal(row.created_at, "2026-01-01T00:00:00.000Z");
});

// ---- paging, resume, --max-pages ----

const page = (ids: string[], next?: string): UserTweetsPage => ({
  data: ids.map((id) => tweet({ id })),
  includes: noIncludes,
  meta: next ? { next_token: next } : {},
});

function setup(pages: UserTweetsPage[], userId = "42") {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-"));
  mkdirSync(path.join(dir, "data"));
  const calls: Array<string | undefined> = [];
  const queue = [...pages];
  const client = {
    me: async () => ({ id: userId, username: "me" }),
    userTweets: async (_id: string, tokenArg?: string) => {
      calls.push(tokenArg);
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra page request");
      return next;
    },
  };
  const opts = {
    client,
    postsCsv: path.join(dir, "data", "posts.csv"),
    scanStateFile: path.join(dir, "data", "scan_state.json"),
    log: () => {},
  };
  const state = () => JSON.parse(readFileSync(opts.scanStateFile, "utf8"));
  return { opts, calls, state, queue };
}

test("pages through everything, saves each page, and marks the scan complete", async () => {
  const s = setup([page(["1", "2"], "t1"), page(["3"])]);
  const res = await scan(s.opts);
  assert.deepEqual(s.calls, [undefined, "t1"]);
  assert.equal(res.complete, true);
  assert.equal(res.totals.post, 3);
  assert.deepEqual(loadRows(s.opts.postsCsv).map((r) => r.id), ["1", "2", "3"]);
  assert.deepEqual(s.state(), { user_id: "42", complete: true });
});

test("--max-pages stops early, leaves the scan incomplete, and the next run resumes from the token", async () => {
  const s = setup([page(["1"], "t1")]);
  const first = await scan({ ...s.opts, maxPages: 1 });
  assert.equal(first.complete, false);
  assert.equal(first.pages, 1);
  assert.deepEqual(s.state(), { user_id: "42", next_token: "t1", complete: false });

  s.queue.push(page(["2"]));
  const second = await scan(s.opts);
  assert.equal(second.complete, true);
  assert.deepEqual(s.calls, [undefined, "t1"]); // resumed, did not restart
  assert.deepEqual(loadRows(s.opts.postsCsv).map((r) => r.id), ["1", "2"]); // no duplicates
});

test("--max-pages that lands exactly on the last page is still complete", async () => {
  const s = setup([page(["1"])]);
  assert.equal((await scan({ ...s.opts, maxPages: 1 })).complete, true);
});

test("--fresh ignores a saved cursor", async () => {
  const s = setup([page(["1"])]);
  writeFileSync(s.opts.scanStateFile, JSON.stringify({ user_id: "42", next_token: "old", complete: false }));
  await scan({ ...s.opts, fresh: true });
  assert.deepEqual(s.calls, [undefined]);
});

test("an unfinished scan for the same user resumes from its cursor", async () => {
  const s = setup([page(["1"])]);
  writeFileSync(s.opts.scanStateFile, JSON.stringify({ user_id: "42", next_token: "saved", complete: false }));
  await scan(s.opts);
  assert.deepEqual(s.calls, ["saved"]);
});

test("a completed scan, or a cursor from another account, starts from the top", async () => {
  const done = setup([page(["1"])]);
  writeFileSync(done.opts.scanStateFile, JSON.stringify({ user_id: "42", complete: true }));
  await scan(done.opts);
  assert.deepEqual(done.calls, [undefined]);

  const other = setup([page(["1"])]);
  writeFileSync(other.opts.scanStateFile, JSON.stringify({ user_id: "99", next_token: "x", complete: false }));
  await scan(other.opts);
  assert.deepEqual(other.calls, [undefined]);
});

test("rescanning preserves existing labels", async () => {
  const s = setup([page(["1"])]);
  await scan(s.opts);
  const labeled = loadRows(s.opts.postsCsv).map((r) => ({ ...r, label: "remove" as const }));
  const { saveRows } = await import("../src/store.ts");
  saveRows(labeled, s.opts.postsCsv);
  s.queue.push(page(["1"]));
  await scan(s.opts);
  assert.equal(loadRows(s.opts.postsCsv)[0]?.label, "remove");
});
