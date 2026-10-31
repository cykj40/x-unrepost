import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError } from "./errors.ts";

/** The package root: the repo in development, the installed package directory otherwise. */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let stateDirCache: { key: string; dir: string } | undefined;

/**
 * Where state lives (`data/`, `.x_tokens.json`): `X_UNREPOST_HOME`, else `~/.x-unrepost`.
 * State kept inside the package directory by earlier versions keeps working: it is used (never moved)
 * unless the per-user directory already has state of its own.
 */
export function stateDir(): string {
  const override = process.env.X_UNREPOST_HOME?.trim();
  const key = override ?? "";
  if (stateDirCache?.key === key) return stateDirCache.dir;

  let dir: string;
  if (override) {
    dir = path.resolve(override);
  } else {
    dir = path.join(os.homedir(), ".x-unrepost");
    const hasState = (root: string) =>
      existsSync(path.join(root, "data", "posts.csv")) || existsSync(path.join(root, ".x_tokens.json"));
    if (hasState(projectRoot)) {
      if (!hasState(dir)) dir = projectRoot;
      else console.error(`note: ignoring older state in ${projectRoot}; using ${dir}`);
    }
  }
  stateDirCache = { key, dir };
  return dir;
}

/** Paths are computed on use, so X_UNREPOST_HOME can change between calls (tests rely on this). */
export const paths = {
  get dataDir() {
    return path.join(stateDir(), "data");
  },
  get postsCsv() {
    return path.join(stateDir(), "data", "posts.csv");
  },
  get scanState() {
    return path.join(stateDir(), "data", "scan_state.json");
  },
  get tokensFile() {
    return path.join(stateDir(), ".x_tokens.json");
  },
};

/** `.env` and `scrub.config.json` are read from the current directory first, then the state directory. */
export function findConfigFile(name: string): string | undefined {
  for (const dir of new Set([process.cwd(), stateDir()])) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

const BASE_URLS = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
} as const;

export const XAI_DEFAULT_MODEL = "grok-4.3";

export type AiProvider = keyof typeof BASE_URLS;

export interface Config {
  x: { clientId: string; clientSecret: string };
  ai: { provider: AiProvider; apiKey: string; baseUrl: string; model: string };
  dataDir: string;
  postsCsv: string;
  scanState: string;
  tokensFile: string;
}

// Empty values (as in .env.example) count as unset.
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined),
  z.string().optional(),
);

const envSchema = z.object({
  X_CLIENT_ID: optionalString,
  X_CLIENT_SECRET: optionalString,
  AI_PROVIDER: optionalString,
  OPENAI_API_KEY: optionalString,
  XAI_API_KEY: optionalString,
  AI_MODEL: optionalString,
});

type Env = z.infer<typeof envSchema>;

function xFrom(parsed: Env): { x?: Config["x"]; problems: string[] } {
  const problems: string[] = [];
  if (!parsed.X_CLIENT_ID) problems.push("X_CLIENT_ID is required (set it in .env)");
  if (!parsed.X_CLIENT_SECRET) problems.push("X_CLIENT_SECRET is required (set it in .env)");
  if (problems.length > 0) return { problems };
  return { x: { clientId: parsed.X_CLIENT_ID!, clientSecret: parsed.X_CLIENT_SECRET! }, problems };
}

function aiFrom(parsed: Env): { ai?: Config["ai"]; problems: string[] } {
  const problems: string[] = [];
  let provider: AiProvider | undefined;
  if (parsed.AI_PROVIDER !== undefined) {
    const p = parsed.AI_PROVIDER.toLowerCase();
    if (p === "openai" || p === "xai") provider = p;
    else problems.push(`AI_PROVIDER must be "openai" or "xai" (got "${parsed.AI_PROVIDER}")`);
  } else if (parsed.OPENAI_API_KEY) {
    provider = "openai";
  } else if (parsed.XAI_API_KEY) {
    provider = "xai";
  } else {
    problems.push("No AI key found: set OPENAI_API_KEY or XAI_API_KEY (set it in .env)");
  }

  let apiKey: string | undefined;
  let model: string | undefined;
  if (provider === "openai") {
    apiKey = parsed.OPENAI_API_KEY;
    if (!apiKey) problems.push("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    model = parsed.AI_MODEL;
    if (!model) problems.push("AI_MODEL is required when AI_PROVIDER=openai");
  } else if (provider === "xai") {
    apiKey = parsed.XAI_API_KEY;
    if (!apiKey) problems.push("XAI_API_KEY is required when AI_PROVIDER=xai");
    model = parsed.AI_MODEL ?? XAI_DEFAULT_MODEL;
  }

  if (problems.length > 0 || !provider || !apiKey || !model) return { problems };
  return { ai: { provider, apiKey, baseUrl: BASE_URLS[provider], model }, problems };
}

/** Pure: validates only the X credentials. Throws ConfigError listing every problem. */
export function parseXConfig(env: Record<string, string | undefined>): Config["x"] {
  const r = xFrom(envSchema.parse(env));
  if (!r.x) throw new ConfigError(r.problems);
  return r.x;
}

/** Pure: validates only the AI settings. Throws ConfigError listing every problem. */
export function parseAiConfig(env: Record<string, string | undefined>): Config["ai"] {
  const r = aiFrom(envSchema.parse(env));
  if (!r.ai) throw new ConfigError(r.problems);
  return r.ai;
}

/** Pure: validates everything. Throws ConfigError listing every problem. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env);
  const x = xFrom(parsed);
  const ai = aiFrom(parsed);
  const problems = [...x.problems, ...ai.problems];
  if (problems.length > 0 || !x.x || !ai.ai) throw new ConfigError(problems);
  return { x: x.x, ai: ai.ai, ...paths };
}

/** Loads `.env` (cwd first, then the state directory) once; variables already in the environment win. */
function loadEnv(): void {
  const file = findConfigFile(".env");
  if (!file) return; // a missing .env is fine; real env vars may be set instead
  try {
    process.loadEnvFile(file);
  } catch {
    // unreadable .env: fall through to env validation, which reports what is missing
  }
}

/** Commands call only the getter they need, so nothing demands keys it doesn't use. */
export function getXConfig(): Config["x"] {
  loadEnv();
  return parseXConfig(process.env);
}

export function getAiConfig(): Config["ai"] {
  loadEnv();
  return parseAiConfig(process.env);
}

/** Everything at once (X and AI); no command needs this, use getXConfig / getAiConfig. */
export function getConfig(): Config {
  loadEnv();
  return parseConfig(process.env);
}

/** Lazy: nothing is read or validated until a property is first accessed. */
export const config: Config = new Proxy({} as Config, {
  get: (_t, prop) => getConfig()[prop as keyof Config],
});
