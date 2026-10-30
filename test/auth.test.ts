import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { REDIRECT_URI, buildAuthorizeUrl, generatePkce } from "../src/auth.ts";

test("PKCE challenge is the base64url SHA-256 of the verifier", () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(generatePkce().verifier, verifier);
});

test("authorize URL carries the required OAuth parameters", () => {
  const url = new URL(buildAuthorizeUrl({ clientId: "cid", state: "st", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), "tweet.read tweet.write users.read offline.access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st");
});

// ---- getAccessToken / login with a mocked fetch ----

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAccessToken, login, type AuthDeps } from "../src/auth.ts";

function setup(tokens?: { access_token: string; refresh_token: string; expires_at: number }) {
  const tokensFile = path.join(mkdtempSync(path.join(tmpdir(), "auth-")), ".x_tokens.json");
  if (tokens) writeFileSync(tokensFile, JSON.stringify(tokens));
  return tokensFile;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ok = (extra: object = {}) => json(200, { access_token: "new-access", expires_in: 7200, ...extra });

function harness(tokensFile: string, responses: Array<Response | Error>) {
  const calls = { fetch: 0, login: 0, sleeps: [] as number[] };
  const queue = [...responses];
  const deps: AuthDeps = {
    settings: { clientId: "cid", clientSecret: "secret", tokensFile },
    fetch: (async () => {
      calls.fetch++;
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra fetch");
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    sleep: async (ms) => void calls.sleeps.push(ms),
    login: async () => {
      calls.login++;
      return "from-login";
    },
    authorizeCode: async () => "the-code",
  };
  return { calls, deps };
}

const expired = { access_token: "old-access", refresh_token: "old-refresh", expires_at: 0 };
const fresh = () => ({ access_token: "old-access", refresh_token: "old-refresh", expires_at: Date.now() + 3_600_000 });
const saved = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("refresh rejected with 400 falls back to login", async () => {
  const file = setup(expired);
  const { calls, deps } = harness(file, [json(400, { error: "invalid_grant" })]);
  assert.equal(await getAccessToken({}, deps), "from-login");
  assert.equal(calls.login, 1);
  assert.equal(calls.fetch, 1);
});

test("network errors and 5xx retry with backoff, never login", async () => {
  const file = setup(expired);
  const { calls, deps } = harness(file, [new Error("ECONNRESET"), json(503, {}), ok({ refresh_token: "rotated" })]);
  assert.equal(await getAccessToken({}, deps), "new-access");
  assert.equal(calls.login, 0);
  assert.deepEqual(calls.sleeps, [1000, 2000]);
  assert.equal(saved(file).refresh_token, "rotated"); // rotated token persisted
});

test("persistent 5xx throws a clear error after 3 retries and never logs in", async () => {
  const file = setup(expired);
  const { calls, deps } = harness(file, [json(500, {}), json(502, {}), json(503, {}), json(504, {})]);
  await assert.rejects(getAccessToken({}, deps), /Could not refresh the X token after 4 attempts/);
  assert.equal(calls.fetch, 4);
  assert.equal(calls.login, 0);
  assert.deepEqual(calls.sleeps, [1000, 2000, 4000]);
});

test("other 4xx (bad client credentials) throws without login or retry", async () => {
  const file = setup(expired);
  const { calls, deps } = harness(file, [json(401, { error: "unauthorized_client" })]);
  await assert.rejects(getAccessToken({}, deps), /HTTP 401/);
  assert.equal(calls.login, 0);
  assert.equal(calls.fetch, 1);
});

test("a token far from expiry is reused unless forceRefresh is set", async () => {
  const file = setup(fresh());
  const reuse = harness(file, []);
  assert.equal(await getAccessToken({}, reuse.deps), "old-access");
  assert.equal(reuse.calls.fetch, 0);

  const forced = harness(file, [ok({ refresh_token: "rotated" })]);
  assert.equal(await getAccessToken({ forceRefresh: true }, forced.deps), "new-access");
  assert.equal(forced.calls.fetch, 1);
  assert.equal(saved(file).refresh_token, "rotated");
});

test("login throws a clear error, and saves nothing, when no refresh_token is returned", async () => {
  const file = setup();
  const { deps } = harness(file, [ok()]);
  await assert.rejects(login(deps), /no refresh_token.*offline\.access/s);
  assert.equal(existsSync(file), false);
});

test("login saves tokens when a refresh_token is returned", async () => {
  const file = setup();
  const { deps } = harness(file, [ok({ refresh_token: "r1" })]);
  assert.equal(await login(deps), "new-access");
  assert.equal(saved(file).refresh_token, "r1");
});
