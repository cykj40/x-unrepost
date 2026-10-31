import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findConfigFile } from "./config.ts";
import { ConfigError } from "./errors.ts";

export const criteriaSchema = z.object({
  mode: z.enum(["remove", "keep_only"]),
  topics: z.array(z.string().trim().min(1, "must not be empty")).min(1).max(20),
  instructions: z.string().max(500).optional(),
});

export type Criteria = z.infer<typeof criteriaSchema>;

export interface LoadCriteriaOptions {
  configPath?: string;
  removeFlag?: string;
  keepOnlyFlag?: string;
  instructionsFlag?: string;
}

const NO_CRITERIA =
  "No criteria found: run `x-unrepost init`, or create scrub.config.json (copy scrub.config.example.json) " +
  'or pass --remove "a,b" / --keep-only "a,b"';

function splitTopics(flag: string): string[] {
  return flag.split(",").map((t) => t.trim()).filter(Boolean);
}

function issueLines(source: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${source}: ${i.path.join(".") || "(root)"} ${i.message}`);
}

function readConfigFile(file: string, explicit: boolean): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return undefined;
    throw new ConfigError([`Cannot read ${file}: ${(err as Error).message}`]);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigError([`${file} is not valid JSON`]);
  }
}

/** Flags replace the file's criteria wholesale: its `instructions` are not carried over; use instructionsFlag. */
export function loadCriteria(opts: LoadCriteriaOptions = {}): Criteria {
  const { configPath, removeFlag, keepOnlyFlag, instructionsFlag } = opts;
  if (removeFlag !== undefined && keepOnlyFlag !== undefined) {
    throw new ConfigError(["Pass only one of --remove and --keep-only, not both"]);
  }

  const file = configPath ?? findConfigFile("scrub.config.json") ?? path.join(process.cwd(), "scrub.config.json");
  const fromFile = readConfigFile(file, configPath !== undefined);
  const flagMode = removeFlag !== undefined ? "remove" : keepOnlyFlag !== undefined ? "keep_only" : undefined;

  if (flagMode === undefined) {
    if (instructionsFlag !== undefined) {
      throw new ConfigError(["--instructions requires --remove or --keep-only"]);
    }
    if (fromFile === undefined) throw new ConfigError([NO_CRITERIA]);
    const result = criteriaSchema.safeParse(fromFile);
    if (!result.success) throw new ConfigError(issueLines(path.basename(file), result.error));
    return result.data;
  }

  const result = criteriaSchema.safeParse({
    mode: flagMode,
    topics: splitTopics((removeFlag ?? keepOnlyFlag)!),
    instructions: instructionsFlag,
  });
  if (!result.success) throw new ConfigError(issueLines("flags", result.error));
  return result.data;
}

/** First 8 hex chars of sha256 over canonical JSON; ignores topic order, case and duplicates. */
export function criteriaHash(c: Criteria): string {
  const canonical = JSON.stringify({
    mode: c.mode,
    topics: [...new Set(c.topics.map((t) => t.trim().toLowerCase()))].sort(),
    instructions: c.instructions?.trim() ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}
