#!/usr/bin/env node
import { dispatch } from "./dispatch.ts";
import { ConfigError } from "./errors.ts";

dispatch(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    for (const problem of err.problems) console.error(`error: ${problem}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
