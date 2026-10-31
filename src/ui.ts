import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { ConfigError } from "./errors.ts";

/** Interactive input for `init`. Implementations never echo secrets. */
export interface Prompter {
  ask(question: string): Promise<string>;
  /** Input is not echoed. */
  askSecret(question: string): Promise<string>;
  /** Free text capped at `max` characters (enforced as the user types when on a terminal). */
  askLimited(question: string, max: number): Promise<string>;
  close(): void;
}

const cancelled = () => new ConfigError(["setup cancelled"]);

type Key = { name?: string; ctrl?: boolean; meta?: boolean } | undefined;

/** The slice of a TTY the editor uses; tests pass a PassThrough with a no-op setRawMode. */
export interface TtyIo {
  stdin: NodeJS.ReadableStream & { setRawMode(mode: boolean): unknown };
  stdout: { write(chunk: string): unknown };
}

/**
 * Minimal single-line editor on a raw terminal: typing, backspace, Enter, Ctrl+C. No cursor movement.
 * Bracketed paste is switched on while reading, so a pasted newline becomes a space instead of
 * submitting the answer early.
 */
export function readTty(question: string, opts: { secret?: boolean; max?: number }, io?: TtyIo): Promise<string> {
  const { stdin, stdout } = io ?? { stdin: process.stdin as TtyIo["stdin"], stdout: process.stdout };
  return new Promise((resolve, reject) => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?2004h");
    let text = "";
    let inPaste = false;

    const render = () => {
      const counter = opts.max !== undefined ? ` (${text.length}/${opts.max})` : "";
      stdout.write(`\r\x1b[K${question.replace(/: ?$/, "")}${counter}: ${opts.secret ? "" : text}`);
    };
    const done = (settle: () => void) => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\x1b[?2004l\n");
      settle();
    };
    const append = (chars: string) => {
      let add = [...chars].filter((ch) => ch >= " " && ch !== "\x7f").join("");
      if (opts.max !== undefined && text.length + add.length > opts.max) {
        add = add.slice(0, Math.max(0, opts.max - text.length));
        stdout.write("\x07"); // bell: the limit was hit
      }
      text += add;
      render();
    };
    const onKey = (str: string | undefined, key: Key) => {
      if (key?.name === "paste-start") return void (inPaste = true);
      if (key?.name === "paste-end") return void (inPaste = false);
      if (key?.ctrl && (key.name === "c" || (key.name === "d" && text === ""))) return done(() => reject(cancelled()));
      if (key?.name === "return" || key?.name === "enter") {
        if (inPaste) return text.endsWith(" ") || text === "" ? undefined : append(" ");
        return done(() => resolve(text));
      }
      if (key?.name === "backspace") {
        text = [...text].slice(0, -1).join("");
        return render();
      }
      if (!str || key?.ctrl || key?.meta || str.startsWith("\x1b")) return; // arrows and other sequences
      append(str);
    };
    stdin.on("keypress", onKey);
    render();
  });
}

function ttyPrompter(): Prompter {
  return {
    ask: (q) => readTty(q, {}),
    askSecret: (q) => readTty(q, { secret: true }),
    askLimited: (q, max) => readTty(q, { max }),
    close() {},
  };
}

/** Line-based fallback for pipes and tests: reads whole lines in order, over buffered input. */
function linePrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string) => {
    process.stdout.write(q);
    const next = await lines.next();
    if (next.done) throw new ConfigError(["input ended before setup finished"]);
    return next.value;
  };
  return {
    ask,
    askSecret: ask,
    askLimited: async (q, max) => {
      for (;;) {
        const answer = await ask(q);
        if (answer.length <= max) return answer;
        process.stdout.write(`That is ${answer.length - max} character(s) over the ${max}-character limit.\n`);
      }
    },
    close: () => rl.close(),
  };
}

export function createPrompter(): Prompter {
  return process.stdin.isTTY && process.stdout.isTTY ? ttyPrompter() : linePrompter();
}
