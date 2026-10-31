import { readFileSync } from "node:fs";
import { z } from "zod";
import { getConfig, paths } from "../config.ts";
import { parseFlags, parsePositiveInt } from "../args.ts";
import { loadRows, upsertRows, writeFileAtomic } from "../store.ts";
import { POST_TYPES, PostRow } from "../types.ts";
import { XClient, type UserTweetsPage, type XTweet } from "../xclient.ts";

const scanState = z.object({
  user_id: z.string(),
  /** Cursor for the next page; absent once pagination has ended. */
  next_token: z.string().optional(),
  complete: z.boolean(),
  /** An incremental scan stops at the first page whose ids are all already known; survives a resume. */
  incremental: z.boolean().optional(),
});
type ScanState = z.infer<typeof scanState>;

type Includes = UserTweetsPage["includes"];

const fullText = (t: XTweet): string => t.note_tweet?.text ?? t.text;

/** Maps one timeline tweet to a CSV row. Precedence: repost > reply > quote > post. */
export function tweetToRow(tweet: XTweet, includes: Includes): PostRow {
  const refs = tweet.referenced_tweets ?? [];
  const ref = (type: "retweeted" | "replied_to" | "quoted") => refs.find((r) => r.type === type);
  const included = (id: string) => includes.tweets.find((t) => t.id === id);
  const authorOf = (t: XTweet | undefined) =>
    (t?.author_id && includes.users.find((u) => u.id === t.author_id)?.username) || "";

  const base = { id: tweet.id, created_at: tweet.created_at ?? "", target_id: tweet.id, text: fullText(tweet) };

  const retweeted = ref("retweeted");
  if (retweeted) {
    const source = included(retweeted.id);
    // The repost's own text is truncated ("RT @user: ..."); fall back to it only if the source is unavailable.
    const author = authorOf(source) || /^RT @(\w+):/.exec(tweet.text)?.[1] || "";
    return PostRow.parse({
      ...base,
      type: "repost",
      target_id: retweeted.id,
      author,
      text: source ? fullText(source) : tweet.text,
    });
  }

  const replied = ref("replied_to");
  if (replied) {
    const source = included(replied.id);
    return PostRow.parse({ ...base, type: "reply", context: source ? fullText(source) : "" });
  }

  const quoted = ref("quoted");
  if (quoted) {
    const source = included(quoted.id);
    return PostRow.parse({
      ...base,
      type: "quote",
      author: authorOf(source),
      context: source ? fullText(source) : "",
    });
  }

  return PostRow.parse({ ...base, type: "post" });
}

function readState(file: string): ScanState | undefined {
  try {
    return scanState.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined; // missing or unreadable: start from the top
  }
}

function writeState(file: string, state: ScanState): void {
  writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
}

export interface ScanOptions {
  client: Pick<XClient, "me" | "userTweets">;
  postsCsv: string;
  scanStateFile: string;
  fresh?: boolean;
  maxPages?: number;
  log?: (line: string) => void;
}

export interface ScanResult {
  complete: boolean;
  pages: number;
  /** Ids written this run that were not in the CSV before. */
  newPosts: number;
  totals: Record<(typeof POST_TYPES)[number], number>;
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const log = opts.log ?? console.log;
  const user = await opts.client.me();

  // --fresh re-reads everything. Otherwise: an unfinished scan for this account resumes from its
  // cursor; a finished one goes incremental (newest first, stop at the first page of known ids).
  const saved = opts.fresh ? undefined : readState(opts.scanStateFile);
  const mine = saved && saved.user_id === user.id ? saved : undefined;
  const resuming = mine !== undefined && !mine.complete;
  const incremental = mine !== undefined && (mine.complete || mine.incremental === true);
  let token = resuming ? mine.next_token : undefined;

  const known = incremental ? new Set(loadRows(opts.postsCsv).map((r) => r.id)) : new Set<string>();
  log(
    `Scanning @${user.username} (${user.id})` +
      (resuming ? ": resuming from saved cursor" : incremental ? ": looking for new posts" : ""),
  );

  let pages = 0;
  let newPosts = 0;
  let complete = false;
  let rows: PostRow[] = [];
  for (;;) {
    const page = await opts.client.userTweets(user.id, token);
    const pageRows = page.data.map((t) => tweetToRow(t, page.includes));
    const allKnown = incremental && pageRows.every((r) => known.has(r.id));
    newPosts += pageRows.filter((r) => !known.has(r.id)).length;
    rows = upsertRows(pageRows, opts.postsCsv);
    pages++;

    token = page.meta.next_token;
    complete = token === undefined || allKnown;
    writeState(opts.scanStateFile, {
      user_id: user.id,
      next_token: complete ? undefined : token,
      complete,
      ...(incremental ? { incremental: true } : {}),
    });

    log(`page ${pages}: ${pageRows.length} tweets (${rows.length} rows total)`);
    if (allKnown) {
      log(pages === 1 ? "no new posts" : "Reached posts already in the CSV; stopping.");
      break;
    }
    if (complete) break;
    if (opts.maxPages !== undefined && pages >= opts.maxPages) break;
  }

  const totals = Object.fromEntries(POST_TYPES.map((t) => [t, rows.filter((r) => r.type === t).length])) as ScanResult["totals"];
  log(complete ? "Scan complete." : `Stopped after ${pages} page(s); run scan again to resume.`);
  log(POST_TYPES.map((t) => `${t}: ${totals[t]}`).join(", ") + ` (${rows.length} total)`);
  return { complete, pages, newPosts, totals };
}

export type ScanDeps = Partial<ScanOptions>;

/** `deps` lets tests inject a client and file paths; the CLI passes none. */
export async function run(argv: string[], deps: ScanDeps = {}): Promise<void> {
  const values = parseFlags("scan", argv, {
    fresh: { type: "boolean" },
    "max-pages": { type: "string" },
  });
  const maxPages = parsePositiveInt("--max-pages", values["max-pages"]);

  const client = deps.client ?? (getConfig(), new XClient()); // getConfig fails fast on missing credentials
  await scan({
    client,
    postsCsv: deps.postsCsv ?? paths.postsCsv,
    scanStateFile: deps.scanStateFile ?? paths.scanState,
    log: deps.log,
    fresh: values.fresh,
    maxPages,
  });
}
