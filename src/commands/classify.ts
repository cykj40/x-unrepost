import { z } from "zod";
import { parseFlags, parsePositiveInt } from "../args.ts";
import { AiResponseError, createChatClient, type JsonChat } from "../ai.ts";
import { getConfig, paths } from "../config.ts";
import { criteriaHash, loadCriteria, type Criteria } from "../criteria.ts";
import { buildSystemPrompt } from "../prompt.ts";
import { loadRows, saveRows } from "../store.ts";
import type { PostRow } from "../types.ts";

const BATCH_SIZE = 20;
const MAX_TEXT_CHARS = 2000;
const MAX_CONTEXT_CHARS = 1000;
const MAX_REASON_WORDS = 12;

export function parseClassifyArgs(argv: string[]) {
  const v = parseFlags("classify", argv, {
    limit: { type: "string" },
    relabel: { type: "boolean" },
    config: { type: "string" },
    remove: { type: "string" },
    "keep-only": { type: "string" },
    instructions: { type: "string" },
  });
  return {
    limit: parsePositiveInt("--limit", v.limit),
    relabel: v.relabel ?? false,
    configPath: v.config,
    removeFlag: v.remove,
    keepOnlyFlag: v["keep-only"],
    instructionsFlag: v.instructions,
  };
}

type Label = "remove" | "borderline" | "keep";
interface Verdict {
  label: Label;
  topic: string;
  reason: string;
}

const MODEL_ERROR: Verdict = { label: "borderline", topic: "", reason: "model error" };

const envelopeSchema = z.object({ results: z.array(z.unknown()) });
const itemSchema = z.object({
  id: z.string(),
  label: z.enum(["remove", "borderline", "keep"]),
  topic: z.string().default(""),
  reason: z.string().default(""),
});

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "…" : s);

function toVerdict(item: z.infer<typeof itemSchema>): Verdict {
  return {
    label: item.label,
    topic: item.topic.trim(),
    reason: item.reason.trim().split(/\s+/).filter(Boolean).slice(0, MAX_REASON_WORDS).join(" "),
  };
}

/**
 * One model call for `batch`. Returns verdicts only for ids that came back exactly once with a valid
 * item; anything else (missing, duplicated, unknown id, bad label, unusable JSON) is left out.
 */
async function askModel(chat: JsonChat, system: string, batch: PostRow[], log: (l: string) => void): Promise<Map<string, Verdict>> {
  const user = JSON.stringify(
    batch.map((r) => ({
      id: r.id,
      type: r.type,
      author: r.author,
      text: clip(r.text, MAX_TEXT_CHARS),
      context: clip(r.context, MAX_CONTEXT_CHARS),
    })),
  );

  let raw: unknown;
  try {
    raw = await chat.completeJson(system, user);
  } catch (err) {
    if (err instanceof AiResponseError) {
      log(`  model response unusable (${err.message})`);
      return new Map();
    }
    throw err;
  }

  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    log("  model response unusable (no results array)");
    return new Map();
  }

  const wanted = new Set(batch.map((r) => r.id));
  const seen = new Map<string, number>();
  for (const item of envelope.data.results) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === "string") seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  const out = new Map<string, Verdict>();
  for (const item of envelope.data.results) {
    const parsed = itemSchema.safeParse(item);
    if (parsed.success && wanted.has(parsed.data.id) && seen.get(parsed.data.id) === 1) {
      out.set(parsed.data.id, toVerdict(parsed.data));
    }
  }
  return out;
}

/** Labels a batch; leftover ids are retried once (just those rows), then marked borderline "model error". */
async function labelBatch(chat: JsonChat, system: string, batch: PostRow[], log: (l: string) => void): Promise<{ verdicts: Map<string, Verdict>; failed: number }> {
  const verdicts = new Map<string, Verdict>();
  let pending = batch;
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    for (const [id, v] of await askModel(chat, system, pending, log)) verdicts.set(id, v);
    pending = pending.filter((r) => !verdicts.has(r.id));
    if (pending.length > 0 && attempt === 0) log(`  ${pending.length} id(s) missing or invalid; retrying once`);
  }
  for (const r of pending) verdicts.set(r.id, MODEL_ERROR);
  return { verdicts, failed: pending.length };
}

export interface ClassifyOptions {
  chat: JsonChat;
  criteria: Criteria;
  postsCsv: string;
  limit?: number;
  relabel?: boolean;
  log?: (line: string) => void;
}

export interface ClassifySummary {
  labeled: number;
  modelErrors: number;
  counts: Record<Label, number>;
  topTopics: Array<{ topic: string; count: number }>;
}

export async function classify(opts: ClassifyOptions): Promise<ClassifySummary> {
  const log = opts.log ?? console.log;
  const hash = criteriaHash(opts.criteria);
  const rows = loadRows(opts.postsCsv);
  const live = (r: PostRow) => r.status !== "deleted" && r.status !== "gone";

  const todoAll = rows.filter((r) => live(r) && (opts.relabel || r.label === "" || r.criteria_hash !== hash));
  const todo = opts.limit !== undefined ? todoAll.slice(0, opts.limit) : todoAll;

  const c = opts.criteria;
  log(
    `Criteria: mode=${c.mode}, topics: ${c.topics.join(", ")}, instructions: ${c.instructions ? "yes" : "no"} (hash ${hash})`,
  );
  log(`${todo.length} of ${rows.length} rows to label${todo.length < todoAll.length ? ` (limited from ${todoAll.length})` : ""}`);

  const system = buildSystemPrompt(opts.criteria);
  let modelErrors = 0;
  const batches = Math.ceil(todo.length / BATCH_SIZE);
  for (let i = 0; i < batches; i++) {
    const batch = todo.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    log(`batch ${i + 1}/${batches} (${batch.length} rows)`);
    const { verdicts, failed } = await labelBatch(opts.chat, system, batch, log);
    modelErrors += failed;
    for (const row of batch) {
      const v = verdicts.get(row.id)!;
      row.label = v.label;
      row.topic = v.topic;
      row.reason = v.reason;
      row.criteria_hash = hash;
      row.reviewed = "";
    }
    saveRows(rows, opts.postsCsv); // after every batch: a crash or Ctrl+C loses at most one batch
  }

  // Summary covers every live row labeled under the current criteria, not just this run.
  const current = rows.filter((r) => live(r) && r.label !== "" && r.criteria_hash === hash);
  const counts: Record<Label, number> = { remove: 0, borderline: 0, keep: 0 };
  const topics = new Map<string, { topic: string; count: number }>();
  for (const r of current) {
    counts[r.label as Label]++;
    const key = r.topic.toLowerCase();
    if (!key) continue;
    const entry = topics.get(key) ?? { topic: r.topic, count: 0 };
    entry.count++;
    topics.set(key, entry);
  }
  const topTopics = [...topics.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  log(`remove: ${counts.remove}, borderline: ${counts.borderline}, keep: ${counts.keep} (${current.length} labeled under current criteria)`);
  if (modelErrors > 0) log(`${modelErrors} row(s) marked borderline after model errors; rerun classify to retry them`);
  log(topTopics.length > 0 ? `Top topics: ${topTopics.map((t) => `${t.topic} (${t.count})`).join(", ")}` : "Top topics: none");
  return { labeled: todo.length, modelErrors, counts, topTopics };
}

export interface ClassifyDeps {
  chat?: JsonChat;
  postsCsv?: string;
  log?: (line: string) => void;
}

/** `deps` lets tests inject a chat client and a CSV path; the CLI passes none. */
export async function run(argv: string[], deps: ClassifyDeps = {}): Promise<void> {
  const args = parseClassifyArgs(argv);
  const criteria = loadCriteria({
    configPath: args.configPath,
    removeFlag: args.removeFlag,
    keepOnlyFlag: args.keepOnlyFlag,
    instructionsFlag: args.instructionsFlag,
  });
  const chat = deps.chat ?? createChatClient(getConfig().ai);
  await classify({
    chat,
    criteria,
    postsCsv: deps.postsCsv ?? paths.postsCsv,
    limit: args.limit,
    relabel: args.relabel,
    log: deps.log,
  });
}
