import { z } from "zod";

export const POST_TYPES = ["repost", "reply", "quote", "post"] as const;

export const PostRow = z.object({
  id: z.string().min(1),
  type: z.enum(POST_TYPES),
  created_at: z.string().default(""),
  /** Source tweet id for reposts, else the row's own id. */
  target_id: z.string().default(""),
  /** Original author username for reposts/quotes. */
  author: z.string().default(""),
  text: z.string().default(""),
  /** Replied-to or quoted text. */
  context: z.string().default(""),
  label: z.enum(["", "remove", "borderline", "keep"]).default(""),
  reason: z.string().default(""),
  /** The matched topic, or ''. */
  topic: z.string().default(""),
  criteria_hash: z.string().default(""),
  reviewed: z.enum(["", "yes"]).default(""),
  status: z.enum(["", "deleted", "failed", "gone"]).default(""),
  error: z.string().default(""),
});

export type PostRow = z.infer<typeof PostRow>;

/** CSV column order. */
export const COLUMNS = Object.keys(PostRow.shape) as (keyof PostRow)[];
