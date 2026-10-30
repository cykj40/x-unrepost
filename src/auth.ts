import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { getConfig } from "./config.ts";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const SCOPES = "tweet.read tweet.write users.read offline.access";
const HOST = "127.0.0.1";
const PORT = 8765;
export const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

const storedTokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  /** Epoch milliseconds. */
  expires_at: z.number(),
});
type StoredTokens = z.infer<typeof storedTokens>;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number(),
});

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(p: { clientId: string; state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function readTokens(file: string): StoredTokens | undefined {
  try {
    return storedTokens.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined; // missing or unreadable: treated as logged out
  }
}

/** Atomic write, mode 0600 from the moment the file exists. */
function writeTokens(file: string, tokens: StoredTokens): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}

/** Settings the token endpoints need; defaults to the validated config. */
interface AuthSettings {
  clientId: string;
  clientSecret: string;
  tokensFile: string;
}

/** Test seams: everything defaults to the real thing. */
export interface AuthDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  settings?: AuthSettings;
  /** Replaces the browser round-trip; resolves with the authorization code. */
  authorizeCode?: (state: string, authorizeUrl: string) => Promise<string>;
  login?: () => Promise<string>;
}

function resolveSettings(deps: AuthDeps): AuthSettings {
  if (deps.settings) return deps.settings;
  const cfg = getConfig();
  return { clientId: cfg.x.clientId, clientSecret: cfg.x.clientSecret, tokensFile: cfg.tokensFile };
}

/** The token endpoint answered with an HTTP error. */
class TokenHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Token request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "TokenHttpError";
    this.status = status;
  }
}

/** Network failure or a retryable status (429, 5xx). */
class TransientTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientTokenError";
  }
}

interface TokenResult {
  access_token: string;
  /** Absent if the server did not issue (or rotate) one. */
  refresh_token: string | undefined;
  expires_at: number;
}

async function requestToken(
  settings: AuthSettings,
  params: Record<string, string>,
  doFetch: typeof fetch,
): Promise<TokenResult> {
  const basic = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64");
  let res: Response;
  try {
    res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: settings.clientId }).toString(),
    });
  } catch (err) {
    throw new TransientTokenError(`network error: ${err instanceof Error ? err.message : "unknown"}`);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Only the error fields are surfaced, never the raw body.
    const e = z.object({ error: z.string().optional(), error_description: z.string().optional() }).safeParse(body);
    const detail = e.success ? [e.data.error, e.data.error_description].filter(Boolean).join(": ") : "";
    if (res.status === 429 || res.status >= 500) {
      throw new TransientTokenError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    throw new TokenHttpError(res.status, detail);
  }
  const t = tokenResponse.parse(body);
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
  };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!cmd) return;
  execFile(cmd, [url], () => {}).on("error", () => {});
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${msg}</p></body>`;

/** Waits for the redirect on /callback and resolves with the authorization code. */
function waitForCode(expectedState: string, authorizeUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, html: string) =>
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html);

      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      if (error) {
        reply(400, page("Login failed", "X reported an error. You can close this tab."));
        finish(new Error(`X denied the login: ${error}`));
      } else if (!safeEqual(state, expectedState)) {
        reply(400, page("Login failed", "State mismatch. You can close this tab."));
        finish(new Error("OAuth state mismatch; login aborted"));
      } else if (!code) {
        reply(400, page("Login failed", "No code received. You can close this tab."));
        finish(new Error("No authorization code in callback"));
      } else {
        reply(200, page("Logged in", "You can close this tab."));
        finish(undefined, code);
      }
    });

    const timer = setTimeout(() => finish(new Error("Login timed out after 5 minutes")), LOGIN_TIMEOUT_MS);

    function finish(err?: Error, code?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (err) reject(err);
      else resolve(code!);
    }

    server.on("error", (err: NodeJS.ErrnoException) =>
      finish(
        err.code === "EADDRINUSE" ? new Error(`Port ${PORT} is in use; free it and retry`) : err,
      ),
    );
    server.listen(PORT, HOST, () => {
      console.log("Opening your browser to authorize x-unrepost. If it doesn't open, visit:");
      console.log(authorizeUrl);
      openBrowser(authorizeUrl);
    });
  });
}

/** Full browser login: PKCE, local callback, code exchange, tokens saved to .x_tokens.json. */
export async function login(deps: AuthDeps = {}): Promise<string> {
  const settings = resolveSettings(deps);
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");
  const authorizeUrl = buildAuthorizeUrl({ clientId: settings.clientId, state, challenge });
  const code = await (deps.authorizeCode ?? waitForCode)(state, authorizeUrl);
  const t = await requestToken(
    settings,
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier },
    deps.fetch ?? fetch,
  );
  if (!t.refresh_token) {
    throw new Error(
      "X returned no refresh_token. Make sure the offline.access scope is allowed for your app, then run login again.",
    );
  }
  writeTokens(settings.tokensFile, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at });
  return t.access_token;
}

const REFRESH_RETRIES = 3;
const REFRESH_BACKOFF_MS = 1000; // doubles each retry: 1s, 2s, 4s

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Returns a valid access token: reuses it, refreshes it (saving the rotated refresh token), or logs in.
 * `forceRefresh` refreshes even if the token is far from expiry (use after a 401).
 * A browser login happens only when there are no tokens or X rejects the refresh with HTTP 400;
 * network errors, 429 and 5xx are retried with backoff and then thrown.
 */
export async function getAccessToken(
  opts: { forceRefresh?: boolean } = {},
  deps: AuthDeps = {},
): Promise<string> {
  const settings = resolveSettings(deps);
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const doLogin = deps.login ?? (() => login(deps));

  const stored = readTokens(settings.tokensFile);
  if (!stored) return doLogin();
  if (!opts.forceRefresh && stored.expires_at - Date.now() > REFRESH_MARGIN_MS) return stored.access_token;

  for (let attempt = 0; ; attempt++) {
    try {
      const fresh = await requestToken(
        settings,
        { grant_type: "refresh_token", refresh_token: stored.refresh_token },
        doFetch,
      );
      writeTokens(settings.tokensFile, {
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token ?? stored.refresh_token,
        expires_at: fresh.expires_at,
      });
      return fresh.access_token;
    } catch (err) {
      if (err instanceof TokenHttpError && err.status === 400) {
        console.error(`Refresh token rejected (${err.message}); logging in again`);
        return doLogin();
      }
      if (!(err instanceof TransientTokenError)) throw err; // e.g. 401 bad client credentials: login won't help
      if (attempt >= REFRESH_RETRIES) {
        throw new Error(`Could not refresh the X token after ${REFRESH_RETRIES + 1} attempts (${err.message}). Try again later.`);
      }
      const delay = REFRESH_BACKOFF_MS * 2 ** attempt;
      console.error(`Token refresh failed (${err.message}); retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
}
