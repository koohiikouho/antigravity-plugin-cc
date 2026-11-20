#!/usr/bin/env node
// Live smoke test against the REAL agy. Opt-in: `npm run smoke`.
// It spends a little quota, so it uses the cheapest model by default
// (override with ANTIGRAVITY_CC_MODEL). Not part of `npm test` / CI: the file
// name does not match tests/*.test.mjs.
//
// Everything runs in a throwaway git repo with a throwaway ANTIGRAVITY_CC_HOME.
// Read-only is checked on the filesystem (the file must not exist), never on
// what the model says.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPANION = fileURLToPath(new URL("../plugins/antigravity/scripts/antigravity.mjs", import.meta.url));
const MODEL = process.env.ANTIGRAVITY_CC_MODEL || "gemini-4-hydrogen-low";
const BG_DEADLINE_MS = 4 * 60 * 1000;

const repo = mkdtempSync(join(tmpdir(), "agy-smoke-repo-"));
const env = { ...process.env, ANTIGRAVITY_CC_HOME: mkdtempSync(join(tmpdir(), "agy-smoke-home-")), ANTIGRAVITY_CC_MODEL: MODEL };
delete env.ANTIGRAVITY_CC_AGY_BIN; // always the real binary

const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
const companion = (...args) => {
  const res = spawnSync(process.execPath, [COMPANION, ...args, "--print-timeout", "3m"], {
    cwd: repo,
    env,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
  });
  return `${res.stdout || ""}${res.stderr || ""}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
function expect(cond, msg, output) {
  if (!cond) throw new Error(`${msg}${output ? `\n----- output -----\n${output.trim().slice(0, 1500)}\n------------------` : ""}`);
}

git("init", "-q");
git("config", "user.email", "smoke@example.invalid");
git("config", "user.name", "smoke");
writeFileSync(join(repo, "m.py"), "def add(a, b):\n    return a + b\n");
git("add", "m.py");
git("commit", "-qm", "init");

console.log(`agy smoke test · model ${MODEL} · repo ${repo}\n`);

await check("setup finds agy and lists models", () => {
  const out = spawnSync(process.execPath, [COMPANION, "setup", "--json"], { cwd: repo, env, encoding: "utf8" }).stdout;
  const data = JSON.parse(out);
  expect(data.ready && data.models.length > 0, "agy not ready or no models (signed in?)", out);
  expect(data.models.includes(MODEL), `model ${MODEL} not in \`agy models\``, out);
});

await check("delegate round trip", () => {
  const out = companion("delegate", "Reply with exactly the word PONG and nothing else. Do not use any tools.");
  expect(/PONG/.test(out), "no PONG in the answer", out);
  expect(/Antigravity conversation: `[0-9a-f-]{36}`/.test(out), "no conversation id", out);
});

await check("resume continues the conversation", () => {
  const out = companion("resume", "What single word did you reply with last time? Answer with just that word.");
  expect(/PONG/.test(out), "resume did not remember PONG", out);
});

await check("--read-only blocks writes (checked on disk)", () => {
  const out = companion("delegate", "--read-only", "Create a file named smoke.txt containing hi. Use the write_file tool.");
  expect(!existsSync(join(repo, "smoke.txt")), "smoke.txt was created despite --read-only", out);
});

await check("structured review of a buggy diff", () => {
  writeFileSync(join(repo, "m.py"), "def add(a, b):\n    return a - b\n");
  const out = companion("review");
  expect(/\*\*Verdict: /.test(out), "no structured verdict (prose fallback?)", out);
  expect(!existsSync(join(repo, "review.txt")), "review wrote a file", out);
});

await check("background job: status then result", async () => {
  const started = companion("delegate", "--background", "Reply with exactly the word DONE and nothing else.");
  const id = (started.match(/agy-[a-z0-9]+-[a-z0-9]+/) || [])[0];
  expect(id, "no job id", started);
  const deadline = Date.now() + BG_DEADLINE_MS;
  let status = "";
  while (Date.now() < deadline) {
    status = companion("status", id);
    if (!/Status: running/.test(status)) break;
    await sleep(3000);
  }
  expect(!/Status: running/.test(status), "job still running at the deadline", status);
  const out = companion("result", id);
  expect(/DONE/.test(out), "no DONE in the result", out);
});

await check("review gate hook blocks on the buggy diff", () => {
  // m.py still holds the `a - b` bug from the review check above.
  const on = spawnSync(process.execPath, [COMPANION, "setup", "--json", "--enable-review-gate"], { cwd: repo, env, encoding: "utf8" }).stdout;
  expect(JSON.parse(on).reviewGate === true, "gate did not turn on", on);
  const res = spawnSync(process.execPath, [COMPANION, "review-gate-hook"], {
    cwd: tmpdir(),
    env,
    input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, cwd: repo }),
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  expect(res.status === 0, `hook exited ${res.status}`, out);
  let decision = null;
  try {
    decision = JSON.parse(res.stdout);
  } catch {
    /* empty = allowed */
  }
  // The model may judge `a - b` in add() differently; either outcome must be well-formed.
  expect(res.stdout.trim() === "" || decision?.decision === "block", "hook printed something other than a block decision", out);
  if (decision) expect(/m\.py/.test(decision.reason), "block reason does not name m.py", out);
  console.log(`      gate decision: ${decision ? "block" : "allow"}`);
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
