import assert from "node:assert/strict";
import { test } from "node:test";
import { AiApiError, AiResponseError, createChatClient, type AiSettings } from "../src/ai.ts";

const openai: AiSettings = { provider: "openai", apiKey: "sk-test-secret-key-123", baseUrl: "https://api.example/v1", model: "m1" };
const completion = (content: string, extra: object = {}) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content }, ...extra }] }), { status: 200 });
const err = (status: number, message = "boom", headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers });

function harness(responses: Array<Response | Error>, settings = openai) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const chat = createChatClient(settings, {
    sleep: async (ms) => void sleeps.push(ms),
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra fetch (test would hit the network)");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
  });
  return { chat, requests, sleeps };
}

test("request: JSON mode, reasoning_effort none, no temperature, bearer auth, right URL", async () => {
  const h = harness([completion('{"ok":true}')]);
  assert.deepEqual(await h.chat.completeJson("sys JSON", "user"), { ok: true });
  const [req] = h.requests;
  assert.equal(req!.url, "https://api.example/v1/chat/completions");
  assert.equal(req!.headers.get("Authorization"), "Bearer sk-test-secret-key-123");
  assert.equal(req!.body.model, "m1");
  assert.deepEqual(req!.body.response_format, { type: "json_object" });
  assert.equal(req!.body.reasoning_effort, "none");
  assert.ok(!("temperature" in req!.body));
  assert.deepEqual(req!.body.messages, [
    { role: "system", content: "sys JSON" },
    { role: "user", content: "user" },
  ]);
});

test("reasoning_effort is only sent to OpenAI", async () => {
  const h = harness([completion("{}")], { ...openai, provider: "xai" });
  await h.chat.completeJson("s", "u");
  assert.ok(!("reasoning_effort" in h.requests[0]!.body));
});

test("429 honors Retry-After, then succeeds", async () => {
  const h = harness([err(429, "slow down", { "retry-after": "7" }), completion("{}")]);
  await h.chat.completeJson("s", "u");
  assert.deepEqual(h.sleeps, [7000]);
});

test("5xx and network errors back off exponentially", async () => {
  const h = harness([err(503), new TypeError("fetch failed"), err(500), completion("{}")]);
  await h.chat.completeJson("s", "u");
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
});

test("gives up after 5 tries", async () => {
  const h = harness(Array.from({ length: 5 }, () => err(502)));
  await assert.rejects(h.chat.completeJson("s", "u"), /after 5 tries/);
  assert.equal(h.requests.length, 5);
});

test("a non-retryable 4xx throws at once, and the API key is redacted from the message", async () => {
  const h = harness([err(401, "Incorrect API key provided: sk-test-secret-key-123.")]);
  await assert.rejects(h.chat.completeJson("s", "u"), (e) => {
    assert.ok(e instanceof AiApiError && e.status === 401);
    assert.ok(!e.message.includes("secret-key"), e.message);
    return true;
  });
  assert.equal(h.requests.length, 1);
});

test("unusable responses are AiResponseErrors, not retried at the HTTP layer", async () => {
  for (const res of [completion("not json"), completion("{}", { finish_reason: "length" }), completion(""), new Response("{}", { status: 200 })]) {
    const h = harness([res]);
    await assert.rejects(h.chat.completeJson("s", "u"), AiResponseError);
    assert.equal(h.requests.length, 1);
  }
});
