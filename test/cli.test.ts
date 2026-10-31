import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { projectRoot } from "../src/config.ts";
import { dispatch, type CommandModule, type CommandName } from "../src/dispatch.ts";
import { ConfigError } from "../src/errors.ts";

function spyLoaders() {
  const received: Array<{ command: string; argv: string[] }> = [];
  const make = (command: string) => async (): Promise<CommandModule> => ({
    run: async (argv) => void received.push({ command, argv }),
  });
  const names: CommandName[] = ["init", "auth", "scan", "classify", "review", "delete", "status", "verify"];
  const loaders = Object.fromEntries(names.map((n) => [n, make(n)])) as Record<CommandName, () => Promise<CommandModule>>;
  return { received, loaders };
}

// Regression: the old top-level parser swallowed `--max-pages` and left only positionals.
test("dispatch hands every flag after the command to the command untouched", async () => {
  for (const argv of [["--max-pages", "1"], ["--max-pages=1"], ["--fresh", "--max-pages", "2"], ["--bogus"]]) {
    const { received, loaders } = spyLoaders();
    await dispatch(["scan", ...argv], loaders);
    assert.deepEqual(received, [{ command: "scan", argv }]);
  }
});

test("an unknown command is a one-line error", async () => {
  const { loaders } = spyLoaders();
  await assert.rejects(dispatch(["frobnicate"], loaders), (e) => e instanceof ConfigError && e.problems.length === 1);
});

test("an unknown top-level flag is an error", async () => {
  const { loaders } = spyLoaders();
  await assert.rejects(dispatch(["--nope"], loaders), ConfigError);
});

test("--help prints help and runs no command", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const { received, loaders } = spyLoaders();
  await dispatch(["--help"], loaders);
  await dispatch(["scan", "--help"], loaders);
  await dispatch([], loaders);
  assert.equal(log.mock.callCount(), 3);
  assert.deepEqual(received, []);
});

test("the real CLI exits 1 with one error line for bad flags, before any network or config access", () => {
  const cli = path.join(projectRoot, "src", "cli.ts");
  for (const args of [["scan", "--bogus"], ["scan", "--max-pages", "abc"], ["scan", "--max-pages"], ["scan", "extra"], ["status", "--x"]]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1, `${args.join(" ")}: expected exit 1`);
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines.length, 1, `${args.join(" ")}: expected one stderr line, got ${JSON.stringify(r.stderr)}`);
    assert.match(lines[0]!, /^error: /);
  }
});
