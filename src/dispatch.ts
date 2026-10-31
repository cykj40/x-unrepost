import { parseArgs } from "node:util";
import { ConfigError } from "./errors.ts";

export type CommandModule = { run: (argv: string[]) => Promise<void> };

export const commands = {
  init: "Set up .env and scrub.config.json (guided or manual)",
  auth: "Log in to X (OAuth 2.0 PKCE) and verify the account",
  scan: "Fetch your recent posts, reposts, replies and quotes into data/posts.csv",
  classify: "Label each row remove / borderline / keep against your criteria",
  review: "Interactively resolve borderline rows (not implemented yet)",
  delete: "Un-repost or delete rows labeled remove",
  status: "Show criteria, counts and remaining work",
  verify: "Check the timeline for rows marked deleted that still appear",
} as const;

export type CommandName = keyof typeof commands;

export const loaders: Record<CommandName, () => Promise<CommandModule>> = {
  init: () => import("./commands/init.ts"),
  auth: () => import("./commands/auth.ts"),
  scan: () => import("./commands/scan.ts"),
  classify: () => import("./commands/classify.ts"),
  review: () => import("./commands/review.ts"),
  delete: () => import("./commands/delete.ts"),
  status: () => import("./commands/status.ts"),
  verify: () => import("./commands/verify.ts"),
};

function isCommand(name: string): name is CommandName {
  return Object.hasOwn(commands, name);
}

export function helpText(): string {
  return [
    "x-unrepost: scrub your X account by topic",
    "",
    "Usage: x-unrepost <command> [options]",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, desc]) => `  ${name.padEnd(9)}${desc}`),
    "",
    "Options:",
    "  -h, --help   Show help",
    "",
    "Via npm, put flags after --:  npm run scan -- --max-pages 1",
  ].join("\n");
}

/**
 * Routes `<command> [flags...]`. The command name is the first argument and everything after it is
 * handed to the command untouched: only that command knows its flags, and it parses them strictly.
 */
export async function dispatch(args: string[], load: Record<CommandName, () => Promise<CommandModule>> = loaders): Promise<void> {
  const [head, ...rest] = args;

  if (head === undefined) {
    console.log(helpText());
    return;
  }
  if (head.startsWith("-")) {
    let help: boolean | undefined;
    try {
      help = parseArgs({ args: [head], options: { help: { type: "boolean", short: "h" } }, strict: true }).values.help;
    } catch {
      throw new ConfigError([`Unknown option: ${head} (run with --help)`]);
    }
    if (help) console.log(helpText());
    return;
  }
  if (!isCommand(head)) throw new ConfigError([`Unknown command: ${head} (run with --help)`]);

  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(helpText());
    return;
  }
  const mod = await load[head]();
  await mod.run(rest);
}
