import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "./config.ts";
import { COLUMNS, PostRow } from "./types.ts";

const BOM = "﻿"; // lets Excel/Numbers read the file as UTF-8

/** RFC 4180 parser. Handles quotes, "" escapes, CRLF/LF and newlines inside quoted fields. */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new Error("CSV parse error: unterminated quoted field");
  if (fieldStarted || field !== "" || row.length > 0) endRow();
  return rows;
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serializes with CRLF line endings and a trailing newline, per RFC 4180. */
export function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.map(escapeField).join(",") + "\r\n").join("");
}

/** Reads rows from disk; a missing file is an empty store. */
export function loadRows(file: string = paths.postsCsv): PostRow[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const [header, ...body] = parseCsv(raw);
  if (!header) return [];
  return body.map((cells, i) => {
    const record: Record<string, string> = {};
    header.forEach((name, col) => {
      record[name] = cells[col] ?? "";
    });
    const parsed = PostRow.safeParse(record);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ");
      throw new Error(`${path.basename(file)} row ${i + 2}: ${detail}`);
    }
    return parsed.data;
  });
}

/** Atomic: writes a tmp file next to the target (creating its directory), then renames it into place. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}

export function saveRows(rows: PostRow[], file: string = paths.postsCsv): void {
  const csv = serializeCsv([[...COLUMNS], ...rows.map((r) => COLUMNS.map((c) => r[c]))]);
  writeFileAtomic(file, BOM + csv);
}

// Fields set by classify/review/delete; an upsert from a scan must never overwrite them.
const PRESERVED = ["label", "reason", "topic", "criteria_hash", "reviewed", "status", "error"] as const;

/** Pure merge by id. Existing rows keep their order and their labels/status; new ids are appended. */
export function mergeRows(existing: PostRow[], incoming: PostRow[]): PostRow[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const order = existing.map((r) => r.id);
  for (const row of incoming) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      order.push(row.id);
      continue;
    }
    const merged = { ...row };
    for (const key of PRESERVED) (merged as Record<string, string>)[key] = prev[key];
    byId.set(row.id, merged);
  }
  return order.map((id) => byId.get(id)!);
}

/** Loads, merges `incoming` by id, saves atomically, and returns the merged rows. */
export function upsertRows(incoming: PostRow[], file: string = paths.postsCsv): PostRow[] {
  const merged = mergeRows(loadRows(file), incoming);
  saveRows(merged, file);
  return merged;
}
