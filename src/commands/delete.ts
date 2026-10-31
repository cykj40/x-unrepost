import { createInterface } from "node:readline/promises";
import { parseFlags, parsePositiveInt } from "../args.ts";
import { getConfig, paths } from "../config.ts";
import { criteriaHash, loadCriteria, type Criteria } from "../criteria.ts";
import { ConfigError } from "../errors.ts";
import { loadRows, saveRows } from "../store.ts";
import { POST_TYPES, type PostRow } from "../types.ts";
import { XApiError, XClient } from "../xclient.ts";

/** X allows 50 un-reposts per 15 minutes per user. */
const PER_WINDOW = 50;
const WINDOW_MINUTES = 15;
const PREVIEW_CHARS = 80;
/** Stop after this many failed items in a row (a 404 is not a failure). */
const MAX_CONSECUTIVE_FAILURES = 5;

export function parseDeleteArgs(argv: string[]) {
  const v = parseFlags("delete", argv, {
    types: { type: "string" },
    "dry-run": { type: "boolean" },
    "include-borderline": { type: "boolean" },
    limit: { type: "string" },
    topic: { type: "string" },
  });
  const types = (v.types ?? "repost").split(",").map((t) => t.trim());
  const bad = types.filter((t) => !(POST_TYPES as readonly string[]).includes(t));
  if (bad.length > 0) {
    throw new ConfigError([`--types must be a comma list of ${POST_TYPES.join(", ")} (got "${bad.join(",")}")`]);
  }
  if (v.topic !== undefined && v.topic.trim() === "") throw new ConfigError(["--topic must not be empty"]);
  return {
    types,
    dryRun: v["dry-run"] ?? false,
    includeBorderline: v["include-borderline"] ?? false,
    limit: parsePositiveInt("--limit", v.limit),
    topic: v.topic?.trim(),
  };
}

export type DeleteArgs = ReturnType<typeof parseDeleteArgs>;

export interface Selection {
  /** Rows to act on, in CSV order, after `--topic` and `--limit`. */
  selected: PostRow[];
  /** Rows that match everything except the criteria hash. */
  stale: number;
}

/** Pure row selection shared by the dry run and the real run. */
export function selectRows(rows: PostRow[], hash: string, args: Pick<DeleteArgs, "types" | "includeBorderline" | "topic" | "limit">): Selection {
  const labels = args.includeBorderline ? ["remove", "borderline"] : ["remove"];
  const topic = args.topic?.toLowerCase();
  let stale = 0;
  const matched: PostRow[] = [];
  for (const r of rows) {
    if (!labels.includes(r.label) || !args.types.includes(r.type)) continue;
    if (r.status === "deleted" || r.status === "gone") continue;
    if (r.criteria_hash !== hash) {
      stale++;
      continue;
    }
    if (topic !== undefined && r.topic.toLowerCase() !== topic) continue;
    matched.push(r);
  }
  return { selected: args.limit !== undefined ? matched.slice(0, args.limit) : matched, stale };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function formatEta(count: number): string {
  const minutes = Math.ceil((count * WINDOW_MINUTES) / PER_WINDOW);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function tally(rows: PostRow[], key: "label" | "type"): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r[key], (counts.get(r[key]) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}: ${n}`).join(", ");
}

function printDryRun(selected: PostRow[], log: (line: string) => void): void {
  log(["type".padEnd(7), "label".padEnd(10), "topic".padEnd(20), "text"].join("  "));
  for (const r of selected) {
    log(
      [
        r.type.padEnd(7),
        r.label.padEnd(10),
        r.topic.slice(0, 20).padEnd(20),
        oneLine(r.text).slice(0, PREVIEW_CHARS),
      ].join("  "),
    );
  }
  log(`Would delete ${selected.length} row(s). By label: ${tally(selected, "label")}. By type: ${tally(selected, "type")}.`);
  log(`ETA at ${PER_WINDOW} per ${WINDOW_MINUTES} min: ${formatEta(selected.length)}. Dry run: nothing was sent to X.`);
}

export interface DeleteOptions extends DeleteArgs {
  client?: Pick<XClient, "me" | "unrepost" | "deleteTweet">;
  criteria: Criteria;
  postsCsv: string;
  /** Asks the user for typed confirmation and returns what they typed. */
  confirm?: (prompt: string) => Promise<string>;
  /** Polled between items; true means finish up and exit cleanly. */
  shouldStop?: () => boolean;
  log?: (line: string) => void;
}

export interface DeleteSummary {
  attempted: number;
  deleted: number;
  gone: number;
  failed: number;
  stale: number;
  aborted: boolean;
  interrupted: boolean;
  /** True when the circuit breaker stopped the run. */
  tripped: boolean;
}

export async function deleteRows(opts: DeleteOptions): Promise<DeleteSummary> {
  const log = opts.log ?? console.log;
  const hash = criteriaHash(opts.criteria);
  const rows = loadRows(opts.postsCsv);
  const { selected, stale } = selectRows(rows, hash, opts);
  const summary: DeleteSummary = { attempted: 0, deleted: 0, gone: 0, failed: 0, stale, aborted: false, interrupted: false, tripped: false };

  if (stale > 0) {
    log(`Warning: skipping ${stale} row(s) labeled under different criteria. Run classify first to relabel them.`);
  }
  if (opts.dryRun) {
    printDryRun(selected, log);
    return summary;
  }
  if (selected.length === 0) {
    log("Nothing to delete.");
    return summary;
  }

  if (opts.types.some((t) => t !== "repost")) {
    log(`WARNING: ${selected.length} row(s) will be deleted. Deleting replies, quotes and posts is PERMANENT and cannot be undone.`);
    const confirm = opts.confirm ?? (() => Promise.resolve(""));
    if ((await confirm("Type DELETE to continue: ")) !== "DELETE") {
      log("Aborted: nothing was deleted.");
      summary.aborted = true;
      return summary;
    }
  }

  const client = opts.client;
  if (!client) throw new Error("delete: no X client");
  // The user id is only needed to un-repost.
  const userId = selected.some((r) => r.type === "repost") ? (await client.me()).id : "";

  let consecutiveFailures = 0;
  let lastStatus: number | undefined;
  for (const [i, row] of selected.entries()) {
    if (opts.shouldStop?.()) {
      summary.interrupted = true;
      log("Interrupted: progress is saved; rerun delete to continue.");
      break;
    }
    try {
      const result = row.type === "repost" ? await client.unrepost(userId, row.target_id) : await client.deleteTweet(row.id);
      row.status = result === "gone" ? "gone" : "deleted";
      row.error = "";
      summary[result === "gone" ? "gone" : "deleted"]++;
      // A 404 is neither a failure nor a success: it leaves the streak as it is.
      if (result === "ok") consecutiveFailures = 0;
    } catch (err) {
      row.status = "failed";
      row.error = oneLine(err instanceof Error ? err.message : String(err));
      summary.failed++;
      consecutiveFailures++;
      lastStatus = err instanceof XApiError ? err.status : undefined;
    }
    summary.attempted++;
    saveRows(rows, opts.postsCsv); // after every item: a crash or Ctrl+C loses nothing
    log(
      `[${i + 1}/${selected.length}] ${row.type} ${row.id}: ${row.status}${row.error ? ` (${row.error})` : ""}` +
        ` | deleted ${summary.deleted}, gone ${summary.gone}, failed ${summary.failed} | ETA ${formatEta(selected.length - i - 1)}`,
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      summary.tripped = true;
      log(`Stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last error: ${row.error}`);
      if (lastStatus === 402 || lastStatus === 403) {
        log("check your X API credits and app permissions");
      }
      log("State is saved; rerun the same command to resume.");
      break;
    }
  }
  return summary;
}

async function promptLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // A closed stdin (no TTY, Ctrl+D) must not hang: treat it as an empty answer.
    const closed = new Promise<string>((resolve) => rl.once("close", () => resolve("")));
    return await Promise.race([rl.question(prompt), closed]);
  } finally {
    rl.close();
  }
}

export interface DeleteDeps {
  client?: DeleteOptions["client"];
  criteria?: Criteria;
  postsCsv?: string;
  confirm?: DeleteOptions["confirm"];
  shouldStop?: DeleteOptions["shouldStop"];
  log?: (line: string) => void;
}

/** `deps` lets tests inject a client, criteria, a CSV path and a confirmation; the CLI passes none. */
export async function run(argv: string[], deps: DeleteDeps = {}): Promise<void> {
  const args = parseDeleteArgs(argv); // validate every flag before touching config or the network
  const criteria = deps.criteria ?? loadCriteria();

  let stopRequested = false;
  const onSigint = () => {
    stopRequested = true;
    console.log("\nSIGINT: finishing the current item, then exiting (Ctrl+C again to quit now).");
  };
  if (!deps.shouldStop) process.once("SIGINT", onSigint);

  try {
    const summary = await deleteRows({
      ...args,
      criteria,
      // A dry run never needs credentials or a client.
      client: deps.client ?? (args.dryRun ? undefined : (getConfig(), new XClient())),
      postsCsv: deps.postsCsv ?? paths.postsCsv,
      confirm: deps.confirm ?? promptLine,
      shouldStop: deps.shouldStop ?? (() => stopRequested),
      log: deps.log,
    });
    if (summary.aborted || summary.tripped) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
