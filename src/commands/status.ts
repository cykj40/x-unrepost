import { parseFlags } from "../args.ts";

export async function run(argv: string[]): Promise<void> {
  parseFlags("status", argv, {});
  console.log("status: not implemented");
}
