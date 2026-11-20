// Stop-time review gate: per-repository on/off state and the last reviewed diff.
// Stdlib only.
//
// State lives in `${ANTIGRAVITY_CC_HOME || ~/.antigravity-cc}/review-gate.json`:
//   { "repos": { "<git toplevel>": { enabled, lastHash, lastVerdict, lastAt } } }
// The Stop hook runs on every turn in every repo, so the common path (gate off
// everywhere) is a single file read: no git, no agy.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function gateFile(env = process.env) {
  return join(env.ANTIGRAVITY_CC_HOME || join(homedir(), ".antigravity-cc"), "review-gate.json");
}

export function readGate(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(gateFile(env), "utf8"));
    return data && typeof data.repos === "object" && data.repos ? data : { repos: {} };
  } catch {
    return { repos: {} };
  }
}

export function writeGate(state, env = process.env) {
  const file = gateFile(env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

export function anyGateEnabled(state) {
  return Object.values(state.repos).some((r) => r && r.enabled);
}

/** Git top-level of `cwd` (forward slashes), or null outside a repository. */
export function repoKey(cwd) {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  const top = res.status === 0 ? (res.stdout || "").trim() : "";
  return top ? top.replace(/\\/g, "/") : null;
}

export function hashDiff(diff) {
  return createHash("sha256").update(String(diff)).digest("hex");
}

/** Text for the Stop hook's `reason`: what Claude is told to fix before stopping. */
export function blockReason(review, displayPath = (f) => f) {
  const MAX = 10;
  const lines = [
    `Antigravity review gate: verdict "needs work" on the uncommitted changes.${review.summary ? ` ${review.summary}` : ""}`,
    "",
    "Address these findings before finishing (or explain to the user why they don't apply):",
  ];
  for (const f of review.findings.slice(0, MAX)) {
    const file = displayPath(f.file);
    const loc = file ? ` ${file}${f.line ? `:${f.line}` : ""}` : "";
    lines.push(`- [${f.severity}]${loc} — ${f.title}${f.detail ? `: ${f.detail.replace(/\s+/g, " ")}` : ""}`);
    if (f.fix) lines.push(`  Fix: ${f.fix.replace(/\s+/g, " ")}`);
  }
  if (review.findings.length > MAX) lines.push(`- …and ${review.findings.length - MAX} more.`);
  lines.push("", "The user can turn this gate off with `/antigravity:setup --disable-review-gate`.");
  return lines.join("\n");
}
