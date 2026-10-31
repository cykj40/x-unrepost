import { chmodSync, constants, copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseFlags } from "../args.ts";
import { projectRoot, stateDir, XAI_DEFAULT_MODEL, type AiProvider } from "../config.ts";
import { criteriaSchema, type Criteria } from "../criteria.ts";
import { ConfigError } from "../errors.ts";
import { writeFileAtomic } from "../store.ts";
import { createPrompter, type Prompter } from "../ui.ts";

const MAX_INSTRUCTIONS = 500;
const MAX_KEY_ATTEMPTS = 3;
const GITIGNORE_ENTRIES = [".env", ".x_tokens.json", "scrub.config.json", "data/"];
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REDIRECT_URI = "http://127.0.0.1:8765/callback";
const AI_BASE_URLS: Record<AiProvider, string> = { openai: "https://api.openai.com/v1", xai: "https://api.x.ai/v1" };

// ---- key checks (no secret is ever returned in a message) ----

export type Check = { status: "ok" } | { status: "bad"; message: string } | { status: "unverified"; message: string };

/** Pasted keys often carry a trailing newline, spaces or a zero-width character. */
export const cleanKey = (v: string) => v.replace(/^[\s\u200b\ufeff]+|[\s\u200b\ufeff]+$/g, "");

/**
 * Checks a Client ID/Secret pair without logging in: sends a token request with a throwaway
 * authorization code. A valid pair gets a "bad code" error (invalid_grant / invalid_request); only an
 * explicit `invalid_client` counts as a rejection. Anything else is "unverified", never a rejection.
 */
export async function checkXCredentials(clientId: string, clientSecret: string, doFetch: typeof fetch = fetch): Promise<Check> {
  const basic = Buffer.from(`${cleanKey(clientId)}:${cleanKey(clientSecret)}`).toString("base64");
  let res: Response;
  try {
    res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "x-unrepost-key-check",
        redirect_uri: REDIRECT_URI,
        code_verifier: "x-unrepost-key-check",
        client_id: cleanKey(clientId),
      }).toString(),
    });
  } catch {
    return { status: "unverified", message: "could not reach X" };
  }
  const body: unknown = await res.json().catch(() => undefined);
  const error = z.object({ error: z.string() }).safeParse(body);
  const code = error.success ? error.data.error : undefined;
  if (code === "invalid_client") {
    return {
      status: "bad",
      message: `X answered invalid_client (HTTP ${res.status}): the Client ID or Secret was not accepted. Check both under your app's Keys and tokens in console.x.com.`,
    };
  }
  if (res.status === 400 && (code === "invalid_grant" || code === "invalid_request")) return { status: "ok" };
  const what = code ? `${code}, HTTP ${res.status}` : `HTTP ${res.status}, no error code`;
  return { status: "unverified", message: `X gave an unexpected answer (${what})` };
}

/** Checks an AI key and model with a free request for the model's metadata. */
export async function checkAiKey(
  s: { provider: AiProvider; apiKey: string; model: string },
  doFetch: typeof fetch = fetch,
): Promise<Check> {
  let res: Response;
  try {
    res = await doFetch(`${AI_BASE_URLS[s.provider]}/models/${encodeURIComponent(s.model)}`, {
      headers: { Authorization: `Bearer ${s.apiKey}` },
    });
  } catch {
    return { status: "unverified", message: `could not reach ${s.provider}` };
  }
  if (res.ok) return { status: "ok" };
  if (res.status === 401 || res.status === 403) {
    return { status: "bad", message: `${s.provider} rejected the API key (HTTP ${res.status}). Check that you copied all of it.` };
  }
  if (res.status === 404) return { status: "bad", message: `${s.provider} does not know the model "${s.model}". Check the spelling.` };
  return { status: "unverified", message: `${s.provider} answered HTTP ${res.status}` };
}

// ---- files ----

/** Adds missing entries to an existing .gitignore, or creates one inside a git repo. Returns what it added. */
export function ensureGitignore(dir: string, entries: string[] = GITIGNORE_ENTRIES): string[] {
  const file = path.join(dir, ".gitignore");
  const exists = existsSync(file);
  if (!exists && !existsSync(path.join(dir, ".git"))) return [];
  const current = exists ? readFileSync(file, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim().replace(/^\//, "").replace(/\/$/, "")));
  const missing = entries.filter((e) => !have.has(e.replace(/\/$/, "")));
  if (missing.length > 0) {
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${current}${sep}${missing.join("\n")}\n`);
  }
  return missing;
}

/** Mode 0600 from the moment the file exists; atomic via tmp + rename. */
function writeSecretFile(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
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

/** Copies src to dest unless dest exists. Returns whether it copied. */
function copyIfMissing(src: string, dest: string): boolean {
  try {
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// ---- topics ----

const presetsSchema = z.object({ remove: z.array(z.string()).default([]), keep_only: z.array(z.string()).default([]) });

function loadPresets(root: string): z.infer<typeof presetsSchema> {
  try {
    return presetsSchema.parse(JSON.parse(readFileSync(path.join(root, "scrub.presets.json"), "utf8")));
  } catch {
    return { remove: [], keep_only: [] }; // presets are a convenience; typing your own always works
  }
}

/** "1, 3, my own topic" -> preset 1, preset 3, and "my own topic". Numbers outside the list are typed text. */
export function parseTopicSelection(input: string, presets: string[]): string[] {
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const n = /^\d+$/.test(token) ? Number(token) : NaN;
    const topic = n >= 1 && n <= presets.length ? presets[n - 1]! : token;
    if (!out.some((t) => t.toLowerCase() === topic.toLowerCase())) out.push(topic);
  }
  return out;
}

// ---- the wizard ----

export interface InitDeps {
  prompter?: Prompter;
  fetch?: typeof fetch;
  /** Where .env and scrub.config.json are written. */
  cwd?: string;
  /** Where the example files and presets are read from. */
  packageRoot?: string;
  log?: (line: string) => void;
}

async function yesNo(p: Prompter, question: string, dflt: boolean): Promise<boolean> {
  for (;;) {
    const a = (await p.ask(`${question} ${dflt ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (a === "") return dflt;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}

const plain = (v: string) => v.length > 0 && !/[\s"'#\\]/.test(v);

/** Asks until the value passes `check`; gives up after a few tries so a typo loop cannot run forever. */
async function askChecked<T>(p: Prompter, log: (l: string) => void, ask: () => Promise<T>, check: (v: T) => Promise<Check>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const value = await ask();
    const result = await check(value);
    if (result.status === "ok") return value;
    if (result.status === "unverified") {
      if (await yesNo(p, `Could not verify (${result.message}). Use it anyway?`, false)) return value;
    } else {
      log(`That did not work: ${result.message}`);
    }
  }
  throw new ConfigError([`Gave up after ${MAX_KEY_ATTEMPTS} tries; nothing was written. Run init again when you have the keys.`]);
}

async function askSecretValue(p: Prompter, question: string): Promise<string> {
  for (;;) {
    const v = cleanKey(await p.askSecret(question));
    if (plain(v)) return v;
    console.log("It must be non-empty with no spaces or quotes. Paste it again.");
  }
}

async function setupCredentials(p: Prompter, log: (l: string) => void, doFetch: typeof fetch): Promise<string> {
  log("\nX credentials: console.x.com -> your app -> Keys and tokens -> OAuth 2.0 Client ID and Client Secret.");
  const x = await askChecked(
    p,
    log,
    async () => {
      let id = "";
      while (!plain(id)) id = cleanKey(await p.ask("X Client ID: "));
      return { id, secret: await askSecretValue(p, "X Client Secret (hidden): ") };
    },
    (v) => checkXCredentials(v.id, v.secret, doFetch),
  );

  let provider: AiProvider | "" = "";
  while (provider === "") {
    const a = (await p.ask("AI provider, openai or xai [openai]: ")).trim().toLowerCase() || "openai";
    if (a === "openai" || a === "xai") provider = a;
  }
  log(
    provider === "openai"
      ? "\nOpenAI key: platform.openai.com -> API keys (billing credit needed). The model name is yours to choose."
      : "\nxAI key: console.x.ai -> API keys.",
  );
  const ai = await askChecked(
    p,
    log,
    async () => {
      const apiKey = await askSecretValue(p, `${provider === "openai" ? "OpenAI" : "xAI"} API key (hidden): `);
      let model = "";
      for (;;) {
        model = cleanKey(await p.ask(provider === "openai" ? "Model name: " : `Model name [${XAI_DEFAULT_MODEL}]: `));
        if (provider === "xai" && model === "") break;
        if (plain(model)) break;
      }
      return { apiKey, model };
    },
    (v) => checkAiKey({ provider: provider as AiProvider, apiKey: v.apiKey, model: v.model || XAI_DEFAULT_MODEL }, doFetch),
  );

  return [
    `X_CLIENT_ID=${x.id}`,
    `X_CLIENT_SECRET=${x.secret}`,
    `AI_PROVIDER=${provider}`,
    provider === "openai" ? `OPENAI_API_KEY=${ai.apiKey}` : `XAI_API_KEY=${ai.apiKey}`,
    ...(ai.model ? [`AI_MODEL=${ai.model}`] : []),
    "",
  ].join("\n");
}

async function setupCriteria(p: Prompter, log: (l: string) => void, presets: z.infer<typeof presetsSchema>): Promise<Criteria> {
  for (;;) {
    log("\nWhat should be cleaned up?");
    log("  1) remove: delete posts about the topics you list");
    log("  2) keep_only: delete everything that is NOT about the topics you list");
    let mode: Criteria["mode"] | undefined;
    while (!mode) {
      const a = (await p.ask("Choose 1 or 2: ")).trim();
      mode = a === "1" || a === "remove" ? "remove" : a === "2" || a === "keep_only" ? "keep_only" : undefined;
    }

    const list = presets[mode];
    if (list.length > 0) log(`\nPresets: ${list.map((t, i) => `${i + 1}) ${t}`).join("  ")}`);
    let topics: string[] = [];
    for (;;) {
      topics = parseTopicSelection(await p.ask("Topics (preset numbers and/or your own, comma-separated): "), list);
      if (topics.length >= 1 && topics.length <= 20) break;
      log("Enter between 1 and 20 topics.");
    }

    const instructions = (await p.askLimited("Extra instructions for edge cases, optional", MAX_INSTRUCTIONS)).trim();
    const parsed = criteriaSchema.safeParse({ mode, topics, ...(instructions ? { instructions } : {}) });
    if (!parsed.success) {
      log(`Invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      continue;
    }
    log(`\nscrub.config.json:\n${JSON.stringify(parsed.data, null, 2)}`);
    if (await yesNo(p, "Save this?", true)) return parsed.data;
    log("Starting over.");
  }
}

export async function init(deps: InitDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const cwd = deps.cwd ?? process.cwd();
  const root = deps.packageRoot ?? projectRoot;
  const doFetch = deps.fetch ?? fetch;
  const p = deps.prompter ?? createPrompter();
  const envFile = path.join(cwd, ".env");
  const configFile = path.join(cwd, "scrub.config.json");

  try {
    log("x-unrepost setup");
    log("  1) Guided setup: enter your keys and topics here; keys are checked as you go");
    log("  2) Manual setup: copy the example files and edit them yourself");
    let guided: boolean | undefined;
    while (guided === undefined) {
      const a = (await p.ask("Choose 1 or 2: ")).trim().toLowerCase();
      guided = a === "1" || a === "guided" ? true : a === "2" || a === "manual" ? false : undefined;
    }

    if (!guided) {
      const copied = [
        [".env.example", ".env", true],
        ["scrub.config.example.json", "scrub.config.json", false],
      ] as const;
      for (const [from, to, secret] of copied) {
        const created = copyIfMissing(path.join(root, from), path.join(cwd, to));
        if (created && secret) chmodSync(path.join(cwd, to), 0o600);
        log(created ? `created ${to}` : `kept your existing ${to} (not overwritten)`);
      }
      reportGitignore(cwd, log);
      log("\nNow edit:");
      log("  .env                  X_CLIENT_ID, X_CLIENT_SECRET, your AI key, and AI_MODEL (required for openai)");
      log("  scrub.config.json     mode, topics, and optional instructions");
      log(`Then run: x-unrepost auth   (x-unrepost reads these from the current folder or ${stateDir()})`);
      return;
    }

    if (!existsSync(envFile) || (await yesNo(p, "An existing .env is in this folder. Replace it?", false))) {
      const env = await setupCredentials(p, log, doFetch);
      writeSecretFile(envFile, env);
      log("saved .env (mode 0600)");
    } else {
      log("kept your existing .env");
    }

    if (!existsSync(configFile) || (await yesNo(p, "An existing scrub.config.json is in this folder. Replace it?", false))) {
      const criteria = await setupCriteria(p, log, loadPresets(root));
      writeFileAtomic(configFile, JSON.stringify(criteria, null, 2) + "\n");
      log("saved scrub.config.json");
    } else {
      log("kept your existing scrub.config.json");
    }
    reportGitignore(cwd, log);

    log("\nNext:");
    log("  x-unrepost auth       log in to X in your browser (once)");
    log("  x-unrepost scan       read your timeline: about $3 per 3,200 posts (measured on one account)");
    log("  x-unrepost classify   label every row");
    log("  x-unrepost delete --dry-run");
    log("Un-reposts are limited to 50 per 15 minutes, so 1,400 reposts takes about 7 hours.");
    log(`Run x-unrepost from this folder, or move .env and scrub.config.json into ${stateDir()}.`);
  } finally {
    p.close();
  }
}

function reportGitignore(dir: string, log: (l: string) => void): void {
  const added = ensureGitignore(dir);
  if (added.length > 0) log(`added to .gitignore: ${added.join(", ")}`);
  else if (!existsSync(path.join(dir, ".gitignore")) && !existsSync(path.join(dir, ".git"))) {
    log("note: this folder is not a git repo; if it becomes one, keep .env, .x_tokens.json, scrub.config.json and data/ out of it");
  }
}

export async function run(argv: string[], deps: InitDeps = {}): Promise<void> {
  parseFlags("init", argv, {});
  await init(deps);
}

