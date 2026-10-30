import { z } from "zod";
import { getAccessToken } from "./auth.ts";

const BASE_URL = "https://api.x.com";
const RATE_LIMIT_BUFFER_MS = 2000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // used when a 429 carries no reset header
const MAX_TRIES = 5; // for 5xx / network errors
const MAX_RATE_LIMIT_RETRIES = 5;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s, 8s

const TWEET_FIELDS = "created_at,referenced_tweets,in_reply_to_user_id,note_tweet,text,author_id";
const EXPANSIONS = "referenced_tweets.id,referenced_tweets.id.author_id";
const USER_FIELDS = "username";

// ---- response schemas ----

const userSchema = z.object({ id: z.string(), username: z.string() });

const tweetSchema = z.object({
  id: z.string(),
  text: z.string().default(""),
  created_at: z.string().optional(),
  author_id: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  referenced_tweets: z
    .array(z.object({ type: z.enum(["retweeted", "quoted", "replied_to"]), id: z.string() }))
    .optional(),
  note_tweet: z.object({ text: z.string() }).optional(),
});

const meSchema = z.object({ data: userSchema });

const userTweetsSchema = z.object({
  // X omits `data` entirely on an empty page.
  data: z.array(tweetSchema).default([]),
  includes: z
    .object({ tweets: z.array(tweetSchema).default([]), users: z.array(userSchema).default([]) })
    .default({ tweets: [], users: [] }),
  meta: z.object({ next_token: z.string().optional(), result_count: z.number().optional() }).default({}),
});

const unrepostSchema = z.object({ data: z.object({ retweeted: z.boolean() }) });
const deleteSchema = z.object({ data: z.object({ deleted: z.boolean() }) });

export type XTweet = z.infer<typeof tweetSchema>;
export type XUser = z.infer<typeof userSchema>;
export type UserTweetsPage = z.infer<typeof userTweetsSchema>;

// ---- errors ----

/** A non-retryable HTTP error from the X API. Never contains tokens. */
export class XApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`X API request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "XApiError";
    this.status = status;
  }
}

// ---- client ----

type GetToken = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface XClientOptions {
  /** Defaults to getAccessToken from src/auth.ts. */
  getToken?: GetToken;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
}

interface Bucket {
  remaining: number;
  /** Epoch milliseconds. */
  resetAt: number;
}

export interface RequestOptions<T> {
  query?: Record<string, string | undefined>;
  schema: z.ZodType<T>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class XClient {
  private readonly getToken: GetToken;
  private readonly doFetch: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: XClientOptions = {}) {
    this.getToken = opts.getToken ?? ((o) => getAccessToken(o));
    this.doFetch = opts.fetch ?? fetch;
    this.sleepFn = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  async request<T>(method: string, path: string, opts: RequestOptions<T>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    // X limits are per endpoint; ids in the path are folded so all unreposts share one bucket.
    const bucketKey = `${method} ${url.pathname.replace(/\/\d+/g, "/:id")}`;

    let refreshed = false;
    let transientFailures = 0;
    let rateLimitHits = 0;
    let forceRefresh = false;

    for (;;) {
      await this.waitForBucket(bucketKey);

      let res: Response;
      try {
        const token = await this.getToken(forceRefresh ? { forceRefresh: true } : undefined);
        forceRefresh = false;
        res = await this.doFetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (err instanceof XApiError) throw err;
        // Auth failures from getToken are not network blips; only fetch failures are retried.
        if (!isNetworkError(err)) throw err;
        await this.backoff(++transientFailures, `network error (${errorMessage(err)})`);
        continue;
      }

      this.recordRateLimit(bucketKey, res);

      if (res.ok) {
        const body: unknown = await res.json().catch(() => undefined);
        const parsed = opts.schema.safeParse(body);
        if (!parsed.success) {
          throw new Error(`Unexpected response shape from ${method} ${url.pathname}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        }
        return parsed.data;
      }

      if (res.status === 429) {
        if (++rateLimitHits > MAX_RATE_LIMIT_RETRIES) throw new XApiError(429, "rate limit retries exhausted");
        const bucket = this.buckets.get(bucketKey);
        const waitMs = (bucket ? bucket.resetAt - this.now() : DEFAULT_WINDOW_MS) + RATE_LIMIT_BUFFER_MS;
        this.buckets.delete(bucketKey);
        await this.sleep(Math.max(waitMs, RATE_LIMIT_BUFFER_MS), "rate limited (429)");
        continue;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        forceRefresh = true;
        continue;
      }

      if (res.status >= 500) {
        transientFailures++;
        if (transientFailures >= MAX_TRIES) throw new XApiError(res.status, `gave up after ${MAX_TRIES} tries`);
        await this.backoff(transientFailures, `server error (HTTP ${res.status})`, false);
        continue;
      }

      throw new XApiError(res.status, await errorDetail(res));
    }
  }

  // ---- endpoints ----

  async me(): Promise<XUser> {
    return (await this.request("GET", "/2/users/me", { schema: meSchema })).data;
  }

  async userTweets(userId: string, paginationToken?: string): Promise<UserTweetsPage> {
    return this.request("GET", `/2/users/${encodeURIComponent(userId)}/tweets`, {
      schema: userTweetsSchema,
      query: {
        max_results: "100",
        pagination_token: paginationToken,
        "tweet.fields": TWEET_FIELDS,
        expansions: EXPANSIONS,
        "user.fields": USER_FIELDS,
      },
    });
  }

  /** Un-reposts by the SOURCE tweet id (not the id of the repost itself). */
  async unrepost(userId: string, sourceTweetId: string): Promise<"ok" | "gone"> {
    try {
      const res = await this.request(
        "DELETE",
        `/2/users/${encodeURIComponent(userId)}/retweets/${encodeURIComponent(sourceTweetId)}`,
        { schema: unrepostSchema },
      );
      if (res.data.retweeted) throw new Error("X reported the post is still reposted");
      return "ok";
    } catch (err) {
      if (err instanceof XApiError && err.status === 404) return "gone";
      throw err;
    }
  }

  async deleteTweet(id: string): Promise<"ok" | "gone"> {
    try {
      const res = await this.request("DELETE", `/2/tweets/${encodeURIComponent(id)}`, { schema: deleteSchema });
      if (!res.data.deleted) throw new Error("X reported the post was not deleted");
      return "ok";
    } catch (err) {
      if (err instanceof XApiError && err.status === 404) return "gone";
      throw err;
    }
  }

  // ---- rate limiting and sleeping ----

  private recordRateLimit(key: string, res: Response): void {
    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    if (res.headers.get("x-rate-limit-remaining") === null || res.headers.get("x-rate-limit-reset") === null) return;
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    this.buckets.set(key, { remaining, resetAt: reset * 1000 });
  }

  /** If the last response said the bucket is empty, wait for its reset (+2s) before calling again. */
  private async waitForBucket(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.remaining > 0) return;
    this.buckets.delete(key);
    const waitMs = bucket.resetAt - this.now() + RATE_LIMIT_BUFFER_MS;
    if (waitMs > 0) await this.sleep(waitMs, "rate limit reached");
  }

  private async backoff(failures: number, reason: string, checkLimit = true): Promise<void> {
    if (checkLimit && failures >= MAX_TRIES) throw new Error(`Gave up after ${MAX_TRIES} tries: ${reason}`);
    await this.sleep(BACKOFF_BASE_MS * 2 ** (failures - 1), reason);
  }

  /** Sleeps once; meanwhile prints a one-line countdown to stderr (a live line on a TTY). */
  private async sleep(ms: number, reason: string): Promise<void> {
    const until = this.now() + ms;
    const line = (left: number) => `${reason}: waiting ${formatDuration(left)}`;
    let timer: NodeJS.Timeout | undefined;
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${line(ms)}   `);
      timer = setInterval(() => {
        process.stderr.write(`\r${line(Math.max(0, until - this.now()))}   `);
      }, 1000);
      timer.unref();
    } else {
      process.stderr.write(`${line(ms)}\n`);
    }
    try {
      await this.sleepFn(ms);
    } finally {
      if (timer) {
        clearInterval(timer);
        process.stderr.write("\r\x1b[K");
      }
    }
  }
}

// ---- helpers ----

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && err.name === "FetchError") || isErrnoError(err);
}

function isErrnoError(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

function formatDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

async function errorDetail(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined);
  const parsed = z.object({ title: z.string().optional(), detail: z.string().optional() }).safeParse(body);
  return parsed.success ? [parsed.data.title, parsed.data.detail].filter(Boolean).join(": ") : "";
}
