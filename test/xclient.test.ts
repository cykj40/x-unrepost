import assert from "node:assert/strict";
import { test } from "node:test";
import { XApiError, XClient } from "../src/xclient.ts";

const NOW = 1_800_000_000_000; // fixed clock, ms
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const limits = (remaining: number, resetInSec: number) => ({
  "x-rate-limit-limit": "50",
  "x-rate-limit-remaining": String(remaining),
  "x-rate-limit-reset": String(NOW / 1000 + resetInSec),
});
const UNREPOST_OK = { data: { retweeted: false } };

function harness(responses: Array<Response | Error>) {
  const events: string[] = [];
  const auth: string[] = [];
  const tokenCalls: Array<{ forceRefresh?: boolean } | undefined> = [];
  const urls: string[] = [];
  const queue = [...responses];
  const client = new XClient({
    now: () => NOW,
    sleep: async (ms) => void events.push(`sleep:${ms}`),
    getToken: async (o) => {
      tokenCalls.push(o);
      return o?.forceRefresh ? "refreshed" : "initial";
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      events.push("fetch");
      urls.push(String(input));
      auth.push(new Headers(init?.headers).get("Authorization") ?? "");
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra fetch (test would hit the network)");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
  });
  return { client, events, auth, tokenCalls, urls };
}

test("429 sleeps until reset (+2s) then retries successfully", async () => {
  const h = harness([json(429, {}, limits(0, 30)), json(200, UNREPOST_OK)]);
  assert.equal(await h.client.unrepost("1", "99"), "ok");
  assert.deepEqual(h.events, ["fetch", "sleep:32000", "fetch"]);
});

test("remaining=0 makes the NEXT call sleep before it is sent", async () => {
  const h = harness([json(200, UNREPOST_OK, limits(0, 10)), json(200, UNREPOST_OK, limits(49, 900))]);
  await h.client.unrepost("1", "101");
  await h.client.unrepost("1", "102"); // same endpoint bucket, different tweet id
  assert.deepEqual(h.events, ["fetch", "sleep:12000", "fetch"]);
});

test("a different endpoint is not delayed by another bucket being empty", async () => {
  const h = harness([json(200, UNREPOST_OK, limits(0, 10)), json(200, { data: { deleted: true } })]);
  await h.client.unrepost("1", "101");
  await h.client.deleteTweet("5");
  assert.deepEqual(h.events, ["fetch", "fetch"]);
});

test("401 forces one token refresh and retries with the new token", async () => {
  const h = harness([json(401, {}), json(200, UNREPOST_OK)]);
  await h.client.unrepost("1", "99");
  assert.deepEqual(h.tokenCalls, [undefined, { forceRefresh: true }]);
  assert.deepEqual(h.auth, ["Bearer initial", "Bearer refreshed"]);
});

test("a second 401 throws instead of looping", async () => {
  const h = harness([json(401, {}), json(401, {})]);
  await assert.rejects(h.client.unrepost("1", "99"), (e) => e instanceof XApiError && e.status === 401);
  assert.equal(h.tokenCalls.length, 2);
});

test("404 on either delete returns 'gone' without throwing", async () => {
  const h = harness([json(404, { title: "Not Found" }), json(404, { title: "Not Found" })]);
  assert.equal(await h.client.unrepost("1", "99"), "gone");
  assert.equal(await h.client.deleteTweet("5"), "gone");
});

test("404 on a read still throws", async () => {
  const h = harness([json(404, { title: "Not Found Error" })]);
  await assert.rejects(h.client.me(), (e) => e instanceof XApiError && e.status === 404);
});

test("5xx and network errors retry with exponential backoff", async () => {
  const h = harness([json(503, {}), new TypeError("fetch failed"), json(500, {}), json(200, UNREPOST_OK)]);
  assert.equal(await h.client.unrepost("1", "99"), "ok");
  assert.deepEqual(h.events.filter((e) => e.startsWith("sleep")), ["sleep:1000", "sleep:2000", "sleep:4000"]);
});

test("gives up after 5 tries", async () => {
  const h = harness(Array.from({ length: 5 }, () => json(502, {})));
  await assert.rejects(h.client.deleteTweet("5"), (e) => e instanceof XApiError && e.status === 502);
  assert.equal(h.events.filter((e) => e === "fetch").length, 5);
  assert.deepEqual(h.events.filter((e) => e.startsWith("sleep")), ["sleep:1000", "sleep:2000", "sleep:4000", "sleep:8000"]);
});

test("persistent network errors give up after 5 tries", async () => {
  const h = harness(Array.from({ length: 5 }, () => new TypeError("fetch failed")));
  await assert.rejects(h.client.me(), /Gave up after 5 tries/);
  assert.equal(h.events.filter((e) => e === "fetch").length, 5);
});

test("userTweets sends the expected query and parses includes", async () => {
  const page = {
    data: [{ id: "1", text: "RT @bob: trunc", referenced_tweets: [{ type: "retweeted", id: "9" }] }],
    includes: { tweets: [{ id: "9", text: "full", author_id: "7" }], users: [{ id: "7", username: "bob" }] },
    meta: { next_token: "abc", result_count: 1 },
  };
  const h = harness([json(200, page)]);
  const res = await h.client.userTweets("42", "tok");
  assert.equal(res.meta.next_token, "abc");
  assert.equal(res.includes.users[0]?.username, "bob");
  const url = new URL(h.urls[0]!);
  assert.equal(url.pathname, "/2/users/42/tweets");
  assert.equal(url.searchParams.get("max_results"), "100");
  assert.equal(url.searchParams.get("pagination_token"), "tok");
  assert.equal(url.searchParams.get("expansions"), "referenced_tweets.id,referenced_tweets.id.author_id");
});

test("an empty page (no data key) parses", async () => {
  const h = harness([json(200, { meta: { result_count: 0 } })]);
  const res = await h.client.userTweets("42");
  assert.deepEqual(res.data, []);
});

test("me() validates the response shape", async () => {
  const ok = harness([json(200, { data: { id: "1", username: "u" } })]);
  assert.deepEqual(await ok.client.me(), { id: "1", username: "u" });
  const bad = harness([json(200, { nope: true })]);
  await assert.rejects(bad.client.me(), /Unexpected response shape/);
});
