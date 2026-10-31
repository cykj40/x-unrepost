import { parseFlags, parsePositiveInt } from "../args.ts";
import { getXConfig, paths } from "../config.ts";
import { loadRows } from "../store.ts";
import type { PostRow } from "../types.ts";
import { XClient } from "../xclient.ts";

const DEFAULT_PAGES = 2;

export function parseVerifyArgs(argv: string[]) {
  const v = parseFlags("verify", argv, { pages: { type: "string" } });
  return { pages: parsePositiveInt("--pages", v.pages) ?? DEFAULT_PAGES };
}

export interface VerifyOptions {
  client: Pick<XClient, "me" | "userTweets">;
  postsCsv: string;
  pages: number;
  log?: (line: string) => void;
}

export interface VerifyResult {
  pages: number;
  fetched: number;
  /** Rows marked deleted that the timeline fetch could cover. */
  checked: number;
  /** Rows marked deleted that still appear on the timeline. */
  stillPresent: PostRow[];
}

/**
 * Read-only: fetches the newest pages of the timeline and reports rows marked `deleted` that are still
 * there. `scan` is incremental and never re-checks deletions, so this is the way to confirm them.
 */
export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const log = opts.log ?? console.log;
  const user = await opts.client.me();

  const onTimeline = new Set<string>();
  let oldest: string | undefined;
  let exhausted = false;
  let token: string | undefined;
  let pages = 0;
  while (pages < opts.pages) {
    const page = await opts.client.userTweets(user.id, token);
    pages++;
    for (const t of page.data) {
      onTimeline.add(t.id);
      if (t.created_at !== undefined && (oldest === undefined || t.created_at < oldest)) oldest = t.created_at;
    }
    token = page.meta.next_token;
    if (token === undefined) {
      exhausted = true;
      break;
    }
  }

  // A deleted row older than the oldest fetched tweet is simply out of range, not proven gone.
  const deleted = loadRows(opts.postsCsv).filter((r) => r.status === "deleted");
  const covered = deleted.filter((r) => exhausted || (oldest !== undefined && r.created_at >= oldest));
  const stillPresent = covered.filter((r) => onTimeline.has(r.id));

  log(`Fetched ${onTimeline.size} tweets from ${pages} page(s) of @${user.username}'s timeline.`);
  log(`${covered.length} of ${deleted.length} deleted row(s) fall within that range.`);
  if (stillPresent.length === 0) {
    log("None of them appear on the timeline.");
  } else {
    log(`${stillPresent.length} row(s) marked deleted still appear on the timeline:`);
    for (const r of stillPresent) log(`  ${r.type} ${r.id} https://x.com/i/status/${r.target_id}`);
  }
  return { pages, fetched: onTimeline.size, checked: covered.length, stillPresent };
}

export interface VerifyDeps {
  client?: VerifyOptions["client"];
  postsCsv?: string;
  log?: (line: string) => void;
}

export async function run(argv: string[], deps: VerifyDeps = {}): Promise<void> {
  const { pages } = parseVerifyArgs(argv);
  const client = deps.client ?? (getXConfig(), new XClient());
  const result = await verify({ client, postsCsv: deps.postsCsv ?? paths.postsCsv, pages, log: deps.log });
  if (result.stillPresent.length > 0) process.exitCode = 1;
}
