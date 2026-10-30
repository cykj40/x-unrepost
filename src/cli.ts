import { parseArgs } from "node:util";
import { ConfigError } from "./errors.ts";

type CommandModule = { run: (argv: string[]) => Promise<void> };

const commands = {
  auth: "Log in to X (OAuth 2.0 PKCE) and verify the account",
  scan: "Fetch your recent posts, reposts, replies and quotes into data/posts.csv",
  classify: "Label each row remove / borderline / keep against your criteria",
  review: "Interactively resolve borderline rows",
  delete: "Un-repost or delete rows labeled remove",
  status: "Show criteria, counts and remaining work",
} as const;

type CommandName = keyof typeof commands;

const loaders: Record<CommandName, () => Promise<CommandModule>> = {
  auth: () => import("./commands/auth.ts"),
  scan: () => import("./commands/scan.ts"),
  classify: () => import("./commands/classify.ts"),
  review: () => import("./commands/review.ts"),
  delete: () => import("./commands/delete.ts"),
  status: () => import("./commands/status.ts"),
};

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}

function printHelp(): void {
  const lines = [
    "x-unrepost: scrub your X account by topic",
    "",
    "Usage: x-unrepost <command> [options]",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, desc]) => `  ${name.padEnd(9)}${desc}`),
    "",
    "Options:",
    "  -h, --help   Show help",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: false,
  });

  const [name, ...rest] = positionals;
  if (!name || (values.help && !name)) {
    printHelp();
    return;
  }
  if (!isCommand(name)) {
    console.error(`Unknown command: ${name}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const mod = await loaders[name]();
  await mod.run(values.help ? [...rest, "--help"] : rest);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    for (const problem of err.problems) console.error(`error: ${problem}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
