import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReviewTarget } from "../plugins/antigravity/scripts/lib/git.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "agy-git-"));
  const g = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "test");
  g("config", "core.autocrlf", "false");
  return { dir, g };
}

const count = (s, needle) => s.split(needle).length - 1;

test("staged changes are not duplicated in the uncommitted diff", () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.txt"), "one\nSTAGED_LINE\n");
  g("add", "a.txt");
  const t = resolveReviewTarget(dir, null);
  assert.equal(t.ok, true);
  assert.equal(count(t.diff, "+STAGED_LINE"), 1);
});

test("a repo with no commits yet still produces a diff", () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "new.txt"), "FIRST_FILE\n");
  g("add", "new.txt");
  writeFileSync(join(dir, "loose.txt"), "untracked\n");
  const t = resolveReviewTarget(dir, null);
  assert.equal(t.ok, true);
  assert.match(t.label, /no commits yet/);
  assert.match(t.diff, /\+FIRST_FILE/);
  assert.match(t.diff, /loose\.txt/);
});

test("clean repo reports nothing to review", () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "a.txt"), "x\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "init");
  const t = resolveReviewTarget(dir, null);
  assert.equal(t.ok, false);
  assert.match(t.reason, /no uncommitted changes/);
});
