import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { criteriaHash, loadCriteria } from "../src/criteria.ts";
import { ConfigError } from "../src/errors.ts";

function fixture(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "criteria-")), "scrub.config.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

test("flag overrides file mode and topics", () => {
  const configPath = fixture({ mode: "keep_only", topics: ["software"], instructions: "extra" });
  const c = loadCriteria({ configPath, removeFlag: " sports , politics " });
  assert.equal(c.mode, "remove");
  assert.deepEqual(c.topics, ["sports", "politics"]);
  assert.equal(c.instructions, undefined);
});

test("--instructions supplies instructions for a flag override", () => {
  const configPath = fixture({ mode: "keep_only", topics: ["software"], instructions: "extra" });
  const c = loadCriteria({ configPath, removeFlag: "sports", instructionsFlag: "per-run rule" });
  assert.equal(c.instructions, "per-run rule");
});

test("--instructions without a mode flag is an error", () => {
  const configPath = fixture({ mode: "remove", topics: ["x"] });
  assert.throws(() => loadCriteria({ configPath, instructionsFlag: "y" }), ConfigError);
});

test("--keep-only sets keep_only mode", () => {
  const configPath = fixture({ mode: "remove", topics: ["x"] });
  assert.equal(loadCriteria({ configPath, keepOnlyFlag: "ai" }).mode, "keep_only");
});

test("both flags is an error", () => {
  assert.throws(() => loadCriteria({ removeFlag: "a", keepOnlyFlag: "b" }), ConfigError);
});

test("an explicit config path that does not exist is an error", () => {
  const configPath = path.join(tmpdir(), "does-not-exist.json");
  assert.throws(() => loadCriteria({ configPath, removeFlag: "a" }), ConfigError);
});

test("no file and no flag points at the example", () => {
  // Hermetic: an empty working directory and an empty state home, whatever exists on this machine.
  const empty = mkdtempSync(path.join(tmpdir(), "criteria-empty-"));
  const oldCwd = process.cwd();
  const oldHome = process.env.X_UNREPOST_HOME;
  process.chdir(empty);
  process.env.X_UNREPOST_HOME = empty;
  try {
    assert.throws(
      () => loadCriteria(),
      (e) => e instanceof ConfigError && e.problems.join(" ").includes("scrub.config.example.json"),
    );
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.X_UNREPOST_HOME;
    else process.env.X_UNREPOST_HOME = oldHome;
  }
});

test("scrub.config.json is found in the working directory, then in the state home", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "criteria-cwd-"));
  const home = mkdtempSync(path.join(tmpdir(), "criteria-home-"));
  writeFileSync(path.join(home, "scrub.config.json"), JSON.stringify({ mode: "remove", topics: ["from home"] }));
  const oldCwd = process.cwd();
  const oldHome = process.env.X_UNREPOST_HOME;
  process.chdir(cwd);
  process.env.X_UNREPOST_HOME = home;
  try {
    assert.deepEqual(loadCriteria().topics, ["from home"]);
    writeFileSync(path.join(cwd, "scrub.config.json"), JSON.stringify({ mode: "remove", topics: ["from cwd"] }));
    assert.deepEqual(loadCriteria().topics, ["from cwd"]);
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.X_UNREPOST_HOME;
    else process.env.X_UNREPOST_HOME = oldHome;
  }
});

test("invalid file yields one line per problem", () => {
  const configPath = fixture({ mode: "nope", topics: [] });
  assert.throws(
    () => loadCriteria({ configPath }),
    (e) => e instanceof ConfigError && e.problems.length === 2,
  );
});

test("hash ignores topic order and case", () => {
  const a = criteriaHash({ mode: "remove", topics: ["Sports", "politics"] });
  const b = criteriaHash({ mode: "remove", topics: ["politics", "sports"] });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("hash changes with mode, topics, or instructions", () => {
  const base = criteriaHash({ mode: "remove", topics: ["a"] });
  assert.notEqual(base, criteriaHash({ mode: "keep_only", topics: ["a"] }));
  assert.notEqual(base, criteriaHash({ mode: "remove", topics: ["a", "b"] }));
  assert.notEqual(base, criteriaHash({ mode: "remove", topics: ["a"], instructions: "x" }));
});
