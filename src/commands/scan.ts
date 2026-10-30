import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { getConfig, paths } from "../config.ts";
import { ConfigError } from "../errors.ts";
import { upsertRows, writeFileAtomic } from "../store.ts";
import { POST_TYPES, PostRow } from "../types.ts";
import { XClient, type UserTweetsPage, type XTweet } from "../xclient.ts";

const scanState = z.object({
  user_id: z.string(),
  /** Cursor for the next page; absent once pagination has ended. */
  next_token: z.string().optional(),
  complete: z.boolean(),
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
  totals: Record<(typeof POST_TYPES)[number], number>;
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const log = opts.log ?? console.log;
  const user = await opts.client.me();

  // Resume only an unfinished scan for the same account. A finished scan starts over
  // from the newest post; upserts merge, so existing labels and status are kept.
  const saved = opts.fresh ? undefined : readState(opts.scanStateFile);
  let token = saved && saved.user_id === user.id && !saved.complete ? saved.next_token : undefined;
  log(`Scanning @${user.username} (${user.id})${token ? ": resuming from saved cursor" : ""}`);

  let pages = 0;
  let complete = false;
  let rows: PostRow[] = [];
  for (;;) {
    const page = await opts.client.userTweets(user.id, token);
    const pageRows = page.data.map((t) => tweetToRow(t, page.includes));
    rows = upsertRows(pageRows, opts.postsCsv);
    token = page.meta.next_token;
    complete = token === undefined;
    writeState(opts.scanStateFile, { user_id: user.id, next_token: token, complete });
    pages++;

    log(`page ${pages}: ${pageRows.length} tweets (${rows.length} rows total)`);
    if (complete) break;
    if (opts.maxPages !== undefined && pages >= opts.maxPages) break;
  }

  const totals = Object.fromEntries(POST_TYPES.map((t) => [t, rows.filter((r) => r.type === t).length])) as ScanResult["totals"];
  log(complete ? "Scan complete." : `Stopped after ${pages} page(s); run scan again to resume.`);
  log(POST_TYPES.map((t) => `${t}: ${totals[t]}`).join(", ") + ` (${rows.length} total)`);
  return { complete, pages, totals };
}

export async function run(argv: string[]): Promise<void> {
  let values: { fresh?: boolean; "max-pages"?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { fresh: { type: "boolean" }, "max-pages": { type: "string" } },
      strict: true,
    }));
  } catch (err) {
    throw new ConfigError([err instanceof Error ? err.message : "invalid arguments"]);
  }

  let maxPages: number | undefined;
  if (values["max-pages"] !== undefined) {
    maxPages = Number(values["max-pages"]);
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new ConfigError(["--max-pages must be a positive integer"]);
  }

  getConfig(); // fail fast on missing credentials
  await scan({
    client: new XClient(),
    postsCsv: paths.postsCsv,
    scanStateFile: paths.scanState,
    fresh: values.fresh,
    maxPages,
  });
}
