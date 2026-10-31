import { parseFlags, parsePositiveInt } from "../args.ts";
import { ConfigError } from "../errors.ts";
import { POST_TYPES } from "../types.ts";

export function parseDeleteArgs(argv: string[]) {
  const v = parseFlags("delete", argv, {
    types: { type: "string" },
    "dry-run": { type: "boolean" },
    limit: { type: "string" },
    topic: { type: "string" },
  });
  const types = (v.types ?? "repost").split(",").map((t) => t.trim());
  const bad = types.filter((t) => !(POST_TYPES as readonly string[]).includes(t));
  if (bad.length > 0) {
    throw new ConfigError([`--types must be a comma list of ${POST_TYPES.join(", ")} (got "${bad.join(",")}")`]);
  }
  return {
    types,
    dryRun: v["dry-run"] ?? false,
    limit: parsePositiveInt("--limit", v.limit),
    topic: v.topic,
  };
}

export async function run(argv: string[]): Promise<void> {
  parseDeleteArgs(argv);
  console.log("delete: not implemented");
}
