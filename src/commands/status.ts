import { existsSync } from "node:fs";
import { parseFlags } from "../args.ts";
import { paths } from "../config.ts";
import { criteriaHash, loadCriteria, type Criteria } from "../criteria.ts";
import { ConfigError } from "../errors.ts";
import { loadRows } from "../store.ts";
import type { PostRow } from "../types.ts";
import { formatEta } from "./delete.ts";
import { readState } from "./scan.ts";

const live = (r: PostRow) => r.status !== "deleted" && r.status !== "gone";

export interface StatusInput {
  rows: PostRow[];
  /** Undefined when no criteria could be loaded. */
  criteria?: Criteria;
  criteriaProblem?: string;
  /** Undefined when there is no scan state. */
  scanComplete?: boolean;
}

export function buildStatus(input: StatusInput): string[] {
  const { rows, criteria } = input;
  const out: string[] = [];
  const hash = criteria ? criteriaHash(criteria) : undefined;

  if (criteria) {
    out.push(
      `Criteria: mode=${criteria.mode}, topics: ${criteria.topics.join(", ")}, instructions: ${criteria.instructions ? "yes" : "no"} (hash ${hash})`,
    );
  } else {
    out.push(`Criteria: not available (${input.criteriaProblem ?? "unknown"})`);
  }
  out.push(
    `Scan: ${input.scanComplete === undefined ? "no scan state yet" : input.scanComplete ? "complete (scan only reads new posts)" : "incomplete (run scan to resume)"}`,
    `Rows: ${rows.length}`,
  );
  if (rows.length === 0) return out;

  // type × label × status
  const groups = new Map<string, number>();
  for (const r of rows) {
    const key = [r.type, r.label || "unlabeled", r.status || "pending"].join("\t");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  out.push("", ["type".padEnd(7), "label".padEnd(11), "status".padEnd(9), "rows"].join("  "));
  for (const [key, n] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [type, label, status] = key.split("\t") as [string, string, string];
    out.push([type.padEnd(7), label.padEnd(11), status.padEnd(9), String(n)].join("  "));
  }

  const unlabeled = rows.filter((r) => live(r) && r.label === "").length;
  out.push("");
  if (hash !== undefined) {
    const stale = rows.filter((r) => live(r) && r.label !== "" && r.criteria_hash !== hash).length;
    out.push(`Stale (labeled under different criteria): ${stale}${stale > 0 ? ". Run classify to relabel them" : ""}`);
  }
  out.push(`Unlabeled: ${unlabeled}${unlabeled > 0 ? ". Run classify" : ""}`);

  const current = hash === undefined ? [] : rows.filter((r) => live(r) && r.label !== "" && r.criteria_hash === hash);
  const topics = new Map<string, { topic: string; count: number }>();
  for (const r of current) {
    const key = r.topic.toLowerCase();
    if (!key) continue;
    const e = topics.get(key) ?? { topic: r.topic, count: 0 };
    e.count++;
    topics.set(key, e);
  }
  const top = [...topics.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  out.push(`Top matched topics: ${top.length > 0 ? top.map((t) => `${t.topic} (${t.count})`).join(", ") : "none"}`);

  // Remaining deletes under the current criteria, split the way `delete` splits them.
  const remaining = (label: string) => current.filter((r) => r.label === label);
  const part = (label: string) => {
    const rs = remaining(label);
    const reposts = rs.filter((r) => r.type === "repost").length;
    return `${rs.length} (${reposts} reposts, ${rs.length - reposts} other)`;
  };
  out.push(
    `Remaining to delete: remove ${part("remove")}, borderline ${part("borderline")}`,
    `ETA at 50 per 15 min: reposts labeled remove ${formatEta(remaining("remove").filter((r) => r.type === "repost").length)}; ` +
      `with borderline ${formatEta(current.filter((r) => r.label !== "keep" && r.type === "repost").length)}`,
  );
  const failed = rows.filter((r) => r.status === "failed").length;
  if (failed > 0) out.push(`Failed: ${failed} (delete retries them)`);
  return out;
}

export interface StatusDeps {
  postsCsv?: string;
  scanStateFile?: string;
  criteria?: Criteria;
  log?: (line: string) => void;
}

export async function run(argv: string[], deps: StatusDeps = {}): Promise<void> {
  parseFlags("status", argv, {});
  const postsCsv = deps.postsCsv ?? paths.postsCsv;
  let criteria = deps.criteria;
  let criteriaProblem: string | undefined;
  if (!criteria) {
    try {
      criteria = loadCriteria();
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      criteriaProblem = err.problems[0];
    }
  }
  const scanState = readState(deps.scanStateFile ?? paths.scanState);
  const log = deps.log ?? console.log;
  for (const line of buildStatus({ rows: existsSync(postsCsv) ? loadRows(postsCsv) : [], criteria, criteriaProblem, scanComplete: scanState?.complete })) {
    log(line);
  }
}
