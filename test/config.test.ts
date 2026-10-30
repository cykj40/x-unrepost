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
