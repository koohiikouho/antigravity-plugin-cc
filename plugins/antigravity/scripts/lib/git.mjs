// Resolve the code-review target and produce a diff to hand to agy.
// Stdlib only (spawns git synchronously).

import { spawnSync } from "node:child_process";

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: res.status === 0,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

export function isGitRepo(cwd) {
  return git(["rev-parse", "--is-inside-work-tree"], cwd).stdout === "true";
}

/**
 * Resolve what to review.
 *  - base provided  -> diff base...HEAD (branch review) + any uncommitted changes
 *  - no base        -> uncommitted changes (staged + unstaged) vs HEAD
 *
 * @returns {{ ok: boolean, label: string, diff: string, stat: string, reason?: string }}
 */
export function resolveReviewTarget(cwd, base) {
  if (!isGitRepo(cwd)) {
    return { ok: false, label: "(not a git repo)", diff: "", stat: "", reason: "not a git repository" };
  }

  if (base) {
    const exists = git(["rev-parse", "--verify", "--quiet", base], cwd).ok;
    if (!exists) {
      return { ok: false, label: base, diff: "", stat: "", reason: `base ref "${base}" not found` };
    }
    const range = `${base}...HEAD`;
    const diff = git(["diff", "--no-color", range], cwd).stdout;
    const stat = git(["diff", "--stat", range], cwd).stdout;
    const working = git(["diff", "--no-color", "HEAD"], cwd).stdout;
    const combined = [diff, working ? `\n# Uncommitted working-tree changes:\n${working}` : ""].join("");
    return {
      ok: combined.trim().length > 0,
      label: `${base}...HEAD (+ working tree)`,
      diff: combined,
      stat,
      reason: combined.trim().length === 0 ? "no changes against base" : undefined,
    };
  }

  // Uncommitted changes, plus untracked file names. `git diff HEAD` already
  // contains staged + unstaged changes, so staged changes are not appended again.
  // A repo with no commits has no HEAD: diff the index against the empty tree
  // (staged) and the working tree against the index (unstaged) instead.
  const hasHead = git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd).ok;
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd).stdout;
  const parts = [];
  let stat;
  if (hasHead) {
    const tracked = git(["diff", "--no-color", "HEAD"], cwd).stdout;
    stat = git(["diff", "--stat", "HEAD"], cwd).stdout;
    if (tracked) parts.push(tracked);
  } else {
    const staged = git(["diff", "--no-color", "--cached"], cwd).stdout;
    const unstaged = git(["diff", "--no-color"], cwd).stdout;
    stat = [git(["diff", "--stat", "--cached"], cwd).stdout, git(["diff", "--stat"], cwd).stdout].filter(Boolean).join("\n");
    if (staged) parts.push(staged);
    if (unstaged) parts.push(`\n# Unstaged changes:\n${unstaged}`);
  }
  if (untracked) parts.push(`\n# Untracked files (not shown in diff):\n${untracked}`);
  const diff = parts.join("\n");

  return {
    ok: diff.trim().length > 0,
    label: hasHead ? "uncommitted changes (HEAD)" : "uncommitted changes (no commits yet)",
    diff,
    stat,
    reason: diff.trim().length === 0 ? "no uncommitted changes to review" : undefined,
  };
}
