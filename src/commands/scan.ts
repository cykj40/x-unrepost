import { getConfig } from "../config.ts";

export async function run(_argv: string[]): Promise<void> {
  getConfig();
  console.log("scan: not implemented");
}
