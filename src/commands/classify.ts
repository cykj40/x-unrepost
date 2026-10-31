import { parseFlags, parsePositiveInt } from "../args.ts";

export function parseClassifyArgs(argv: string[]) {
  const v = parseFlags("classify", argv, {
    limit: { type: "string" },
    relabel: { type: "boolean" },
    config: { type: "string" },
    remove: { type: "string" },
    "keep-only": { type: "string" },
    instructions: { type: "string" },
  });
  return {
    limit: parsePositiveInt("--limit", v.limit),
    relabel: v.relabel ?? false,
    configPath: v.config,
    removeFlag: v.remove,
    keepOnlyFlag: v["keep-only"],
    instructionsFlag: v.instructions,
  };
}

export async function run(argv: string[]): Promise<void> {
  parseClassifyArgs(argv);
  console.log("classify: not implemented");
}
