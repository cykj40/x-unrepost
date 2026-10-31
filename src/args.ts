import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { ConfigError } from "./errors.ts";

/**
 * Strict flag parsing shared by every command: an unknown flag, a missing value, a stray positional
 * or a malformed `--flag=value` is an error (one line, exit 1), never silently ignored.
 */
export function parseFlags<const O extends ParseArgsOptionsConfig>(command: string, argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid arguments";
    // Node appends usage hints after the first sentence; keep the message to one line.
    throw new ConfigError([`${command}: ${message.split(/\.\s/)[0]!.replace(/\.$/, "")}`]);
  }
}

/** Strict positive integer: rejects "abc", "0", "-1", "1.5", "1e3" and "". */
export function parsePositiveInt(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new ConfigError([`${flag} must be a positive integer (got "${value}")`]);
  return Number(value);
}
