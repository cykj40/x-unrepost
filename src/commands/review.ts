import { parseFlags } from "../args.ts";
import { ConfigError } from "../errors.ts";

const LABELS = ["remove", "borderline", "keep"] as const;
type Label = (typeof LABELS)[number];

export function parseReviewArgs(argv: string[]): { label: Label } {
  const v = parseFlags("review", argv, { label: { type: "string" } });
  const label = v.label ?? "borderline";
  if (!(LABELS as readonly string[]).includes(label)) {
    throw new ConfigError([`--label must be one of ${LABELS.join(", ")} (got "${label}")`]);
  }
  return { label: label as Label };
}

export async function run(argv: string[]): Promise<void> {
  parseReviewArgs(argv);
  console.log("review: not implemented");
}
