import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadRows, mergeRows, parseCsv, saveRows, serializeCsv, upsertRows } from "../src/store.ts";
import { PostRow } from "../src/types.ts";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "store-")), "data", "posts.csv");
}

function row(over: Partial<PostRow> & { id: string }): PostRow {
  return PostRow.parse({ type: "post", ...over });
}

test("csv round-trips commas, quotes, newlines, emoji and empty fields", () => {
  const rows = [
    ["a", "b,c", 'say "hi"', "line1\nline2", "crlf\r\nline", "🚀 café 日本語", ""],
    ["", "", "", "", "", "", ""],
    ["only"],
  ];
  assert.deepEqual(parseCsv(serializeCsv(rows)), rows);
});

test("parser accepts LF, CRLF, no trailing newline and a BOM", () => {
  assert.deepEqual(parseCsv("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsv("﻿a,b\n"), [["a", "b"]]);
  assert.deepEqual(parseCsv(""), []);
});

test("parser rejects an unterminated quote", () => {
  assert.throws(() => parseCsv('a,"b'), /unterminated/);
});

test("missing file loads as []", () => {
  assert.deepEqual(loadRows(tmpFile()), []);
});

test("saveRows/loadRows round-trip full rows and leave no tmp file", () => {
  const file = tmpFile();
  const rows = [
    row({ id: "1", type: "repost", target_id: "9", author: "bob", text: 'tricky, "text"\nwith 🎉', label: "keep" }),
    row({ id: "2", type: "reply", context: "ctx", status: "deleted", reviewed: "yes" }),
  ];
  saveRows(rows, file);
  assert.deepEqual(loadRows(file), rows);
  assert.deepEqual(readdirSync(path.dirname(file)), ["posts.csv"]);
  assert.equal(readFileSync(file, "utf8").charCodeAt(0), 0xfeff);
});

test("loadRows rejects invalid values with the row number", () => {
  const file = tmpFile();
  saveRows([row({ id: "1" })], file);
  const bad = readFileSync(file, "utf8").replace(",post,", ",bogus,");
  writeFileSync(file, bad);
  assert.throws(() => loadRows(file), /row 2/);
});

test("upsert does not clobber labels or status", () => {
  const file = tmpFile();
  saveRows([row({ id: "1", text: "old", label: "remove", reason: "r", topic: "t", criteria_hash: "abcd1234", reviewed: "yes", status: "failed", error: "e" })], file);
  const merged = upsertRows([row({ id: "1", text: "new" }), row({ id: "2", text: "fresh" })], file);
  assert.equal(merged.length, 2);
  const one = merged[0]!;
  assert.equal(one.text, "new");
  assert.equal(one.label, "remove");
  assert.equal(one.reason, "r");
  assert.equal(one.topic, "t");
  assert.equal(one.criteria_hash, "abcd1234");
  assert.equal(one.reviewed, "yes");
  assert.equal(one.status, "failed");
  assert.equal(one.error, "e");
  assert.deepEqual(loadRows(file), merged);
});

test("mergeRows keeps existing order, appends new ids, no duplicates", () => {
  const merged = mergeRows([row({ id: "b" }), row({ id: "a" })], [row({ id: "c" }), row({ id: "a" }), row({ id: "c" })]);
  assert.deepEqual(merged.map((r) => r.id), ["b", "a", "c"]);
});
