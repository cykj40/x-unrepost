import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigError } from "./errors.ts";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dataDir = path.join(projectRoot, "data");

const BASE_URLS = {
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
} as const;

const XAI_DEFAULT_MODEL = "grok-4.3";

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

/** Pure: validates an env-like object. Throws ConfigError listing every problem. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const parsed = envSchema.parse(env);

  if (!parsed.X_CLIENT_ID) problems.push("X_CLIENT_ID is required (set it in .env)");
  if (!parsed.X_CLIENT_SECRET) problems.push("X_CLIENT_SECRET is required (set it in .env)");

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

  if (problems.length > 0 || !provider || !apiKey || !model) throw new ConfigError(problems);

  return {
    x: { clientId: parsed.X_CLIENT_ID!, clientSecret: parsed.X_CLIENT_SECRET! },
    ai: { provider, apiKey, baseUrl: BASE_URLS[provider], model },
    dataDir,
    postsCsv: path.join(dataDir, "posts.csv"),
    scanState: path.join(dataDir, "scan_state.json"),
    tokensFile: path.join(projectRoot, ".x_tokens.json"),
  };
}

let cached: Config | undefined;

/** Loads .env (if present) and validates on first call. */
export function getConfig(): Config {
  if (!cached) {
    try {
      process.loadEnvFile(path.join(projectRoot, ".env"));
    } catch {
      // a missing .env is fine; real env vars may be set instead
    }
    cached = parseConfig(process.env);
  }
  return cached;
}

/** Lazy: nothing is read or validated until a property is first accessed. */
export const config: Config = new Proxy({} as Config, {
  get: (_t, prop) => getConfig()[prop as keyof Config],
});
