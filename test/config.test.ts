import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { ConfigError } from "../src/errors.ts";

const x = { X_CLIENT_ID: "id", X_CLIENT_SECRET: "secret" };

test("infers openai from OPENAI_API_KEY", () => {
  const c = parseConfig({ ...x, OPENAI_API_KEY: "k", AI_MODEL: "m" });
  assert.equal(c.ai.provider, "openai");
  assert.equal(c.ai.baseUrl, "https://api.openai.com/v1");
});

test("infers xai from XAI_API_KEY and defaults the model", () => {
  const c = parseConfig({ ...x, XAI_API_KEY: "k" });
  assert.equal(c.ai.provider, "xai");
  assert.equal(c.ai.model, "grok-4.3");
});

test("prefers openai when both keys are set", () => {
  const c = parseConfig({ ...x, OPENAI_API_KEY: "a", XAI_API_KEY: "b", AI_MODEL: "m" });
  assert.equal(c.ai.provider, "openai");
  assert.equal(c.ai.apiKey, "a");
});

test("explicit AI_PROVIDER wins over inference", () => {
  const c = parseConfig({ ...x, AI_PROVIDER: "xai", OPENAI_API_KEY: "a", XAI_API_KEY: "b" });
  assert.equal(c.ai.provider, "xai");
});

test("openai without AI_MODEL fails", () => {
  assert.throws(
    () => parseConfig({ ...x, OPENAI_API_KEY: "k" }),
    (e) => e instanceof ConfigError && e.problems.includes("AI_MODEL is required when AI_PROVIDER=openai"),
  );
});

test("empty env reports X_CLIENT_ID is required", () => {
  assert.throws(
    () => parseConfig({}),
    (e) => e instanceof ConfigError && e.problems.some((p) => p.startsWith("X_CLIENT_ID is required")),
  );
});

test("empty-string values count as unset", () => {
  assert.throws(() => parseConfig({ ...x, OPENAI_API_KEY: "", XAI_API_KEY: "" }), ConfigError);
});

test("each command's config needs only its own keys", async () => {
  const { parseAiConfig, parseXConfig } = await import("../src/config.ts");
  assert.deepEqual(parseXConfig({ X_CLIENT_ID: "a", X_CLIENT_SECRET: "b" }), { clientId: "a", clientSecret: "b" });
  assert.equal(parseAiConfig({ OPENAI_API_KEY: "k", AI_MODEL: "m" }).model, "m");
  assert.throws(() => parseXConfig({ OPENAI_API_KEY: "k", AI_MODEL: "m" }), (e) => e instanceof ConfigError && e.problems.length === 2);
  assert.throws(() => parseAiConfig({ X_CLIENT_ID: "a", X_CLIENT_SECRET: "b" }), (e) => e instanceof ConfigError && e.problems.length === 1);
});

test("state lives in X_UNREPOST_HOME when set", async () => {
  const { paths, stateDir } = await import("../src/config.ts");
  const old = process.env.X_UNREPOST_HOME;
  process.env.X_UNREPOST_HOME = "/tmp/xu-home-test";
  try {
    assert.equal(stateDir(), "/tmp/xu-home-test");
    assert.equal(paths.postsCsv, "/tmp/xu-home-test/data/posts.csv");
    assert.equal(paths.tokensFile, "/tmp/xu-home-test/.x_tokens.json");
  } finally {
    if (old === undefined) delete process.env.X_UNREPOST_HOME;
    else process.env.X_UNREPOST_HOME = old;
  }
});
