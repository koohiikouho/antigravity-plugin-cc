import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const COMPANION = fileURLToPath(new URL("../plugins/antigravity/scripts/antigravity.mjs", import.meta.url));
// A .mjs override runs through node (launchSpec), so no chmod and it works on Windows.
const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function run(args, { mode = "success", home, cwd, extraEnv = {} } = {}) {
  cwd = cwd || tmp("agy-cwd-");
  const argvFile = join(tmp("agy-argv-"), "argv.json");
  const env = {
    ...process.env,
    ANTIGRAVITY_CC_AGY_BIN: FAKE_AGY,
    ANTIGRAVITY_CC_HOME: home || tmp("agy-home-"),
    FAKE_AGY_MODE: mode,
    FAKE_AGY_ARGV_FILE: argvFile,
    ...extraEnv,
  };
  delete env.ANTIGRAVITY_CC_MODEL;
  Object.assign(env, extraEnv);
  const stdout = execFileSync(process.execPath, [COMPANION, ...args], { cwd, env, encoding: "utf8" });
  let agyArgv = null;
  try {
    agyArgv = JSON.parse(readFileSync(argvFile, "utf8"));
  } catch {
    /* agy not invoked */
  }
  return { stdout, cwd, home: env.ANTIGRAVITY_CC_HOME, agyArgv };
}

test("setup --json reports ready and lists models", () => {
  const { stdout } = run(["setup", "--json"]);
  const data = JSON.parse(stdout);
  assert.equal(data.ready, true);
  assert.equal(data.installed, true);
  assert.equal(data.version, "9.9.9-fake");
  assert.deepEqual(data.models, ["gemini-4-hydrogen-low", "gemini-4-neon-high"]);
});

test("delegate (foreground) returns the response + conversation id, prompt via stdin", () => {
  const { stdout, agyArgv } = run(["delegate", "summarize the repo"]);
  assert.match(stdout, /Fake agy reply/);
  assert.match(stdout, /summarize the repo/);
  assert.match(stdout, /abcd1234-ef56-7890-abcd-1234567890ef/);
  assert.ok(!agyArgv.includes("summarize the repo"), "prompt must not be in argv");
  assert.ok(agyArgv.includes("stream-json"));
});

test("delegate does NOT auto-approve tools by default", () => {
  const { agyArgv } = run(["delegate", "x"]);
  assert.ok(!agyArgv.includes("--dangerously-skip-permissions"));
});

test("delegate --yolo opts in to auto-approval", () => {
  const { agyArgv } = run(["delegate", "--yolo", "x"]);
  assert.ok(agyArgv.includes("--dangerously-skip-permissions"));
});

test("--model is passed through, and ANTIGRAVITY_CC_MODEL is the default", () => {
  const a = run(["delegate", "--model", "gemini-4-neon-high", "x"]);
  assert.equal(a.agyArgv[a.agyArgv.indexOf("--model") + 1], "gemini-4-neon-high");
  const b = run(["delegate", "x"], { extraEnv: { ANTIGRAVITY_CC_MODEL: "gemini-4-hydrogen-low" } });
  assert.equal(b.agyArgv[b.agyArgv.indexOf("--model") + 1], "gemini-4-hydrogen-low");
});

test("a review diff beyond the Windows argv limit (32K) goes through", () => {
  const cwd = tmp("agy-bigdiff-");
  const g = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  g("init", "-q");
  writeFileSync(join(cwd, "big.txt"), "some changed line of code\n".repeat(4000)); // ~100KB
  g("add", "big.txt");
  const { stdout } = run(["review"], { cwd });
  assert.match(stdout, /Verdict: .*needs work/);
});

test("quota exhaustion is surfaced with the reset window", () => {
  const { stdout } = run(["delegate", "do something expensive"], { mode: "quota" });
  assert.match(stdout, /quota is exhausted/i);
  assert.match(stdout, /152h59m39s/);
});

test("auth error gets sign-in guidance", () => {
  const { stdout } = run(["delegate", "anything"], { mode: "auth" });
  assert.match(stdout, /not authenticated/i);
  assert.match(stdout, /agy/);
});

test("headless auto-denial is reported, not returned as an empty answer", () => {
  const { stdout } = run(["delegate", "run the tests"], { mode: "denied" });
  assert.match(stdout, /auto-denied/i);
  assert.match(stdout, /permissions\.allow|--yolo/);
});

test("bad model selection explains how to pick one", () => {
  const { stdout } = run(["delegate", "--model", "gemini-9", "x"], { mode: "badmodel" });
  assert.match(stdout, /rejected the model/i);
  assert.match(stdout, /agy models/);
});

test("review runs sandboxed and never with --yolo", () => {
  const cwd = tmp("agy-review-");
  const g = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  g("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  g("add", "a.txt");
  const { stdout, agyArgv } = run(["review", "--yolo"], { cwd });
  assert.match(stdout, /Verdict/);
  assert.ok(agyArgv.includes("--sandbox"));
  assert.ok(!agyArgv.includes("--dangerously-skip-permissions"));
  assertReadOnlySettings(agyArgv);
});

// --sandbox + a prompt instruction did not stop agy 1.5.13 from writing files;
// read-only runs must carry session deny rules.
function assertReadOnlySettings(agyArgv) {
  const i = agyArgv.indexOf("--settings");
  assert.ok(i !== -1, "read-only run must pass --settings");
  const deny = JSON.parse(agyArgv[i + 1]).permissions.deny;
  assert.ok(deny.includes("write_file(*)"));
  assert.ok(deny.includes("command(*)"));
}

test("delegate --read-only denies writes and commands; plain delegate does not", () => {
  assertReadOnlySettings(run(["delegate", "--read-only", "explain"]).agyArgv);
  assert.ok(!run(["delegate", "x"]).agyArgv.includes("--settings"));
});

test("resume with no earlier conversation in this repo says so instead of using a global --continue", () => {
  const { stdout, agyArgv } = run(["resume", "keep going"]);
  assert.match(stdout, /No earlier Antigravity conversation/);
  assert.equal(agyArgv, null);
});

test("resume picks up this repo's last conversation id", () => {
  const home = tmp("agy-home-shared-");
  const cwd = tmp("agy-cwd-");
  run(["delegate", "first"], { home, cwd });
  const { agyArgv } = run(["resume", "second"], { home, cwd });
  assert.equal(agyArgv[agyArgv.indexOf("--conversation") + 1], "abcd1234-ef56-7890-abcd-1234567890ef");
  assert.ok(!agyArgv.includes("--continue"));
});

test("status renders across invocations sharing a home", () => {
  const home = tmp("agy-home-shared-");
  const cwd = tmp("agy-cwd-");
  run(["delegate", "remember me"], { home, cwd });
  const { stdout } = run(["status"], { home, cwd });
  assert.match(stdout, /Antigravity — status/);
});

test("delegate with no task prompts for input", () => {
  const { stdout } = run(["delegate"]);
  assert.match(stdout, /What should Antigravity/);
});

test("unknown subcommand prints usage", () => {
  const { stdout } = run(["frobnicate"]);
  assert.match(stdout, /Usage: node antigravity\.mjs/);
});

test("missing binary yields install guidance", () => {
  // Isolate HOME/LOCALAPPDATA so no real agy install can be found, and keep only
  // node's dir on PATH.
  const cwd = tmp("agy-cwd-");
  const isolatedHome = tmp("agy-nohome-");
  const res = spawnSync(process.execPath, [COMPANION, "delegate", "x"], {
    cwd,
    encoding: "utf8",
    env: {
      ANTIGRAVITY_CC_AGY_BIN: "/nonexistent/agy",
      PATH: dirname(process.execPath),
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      LOCALAPPDATA: isolatedHome,
      SystemRoot: process.env.SystemRoot || "",
    },
  });
  assert.match(res.stdout, /not installed/);
});

function gitRepoWithChange(prefix) {
  const cwd = tmp(prefix);
  const g = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
  g("init", "-q");
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  g("add", "a.txt");
  return cwd;
}

test("read-only runs are refused, without running agy, when agy lacks --settings", () => {
  const env = { FAKE_AGY_NO_SETTINGS: "1" };
  const d = run(["delegate", "--read-only", "explain"], { extraEnv: env });
  assert.match(d.stdout, /too old/i);
  assert.match(d.stdout, /agy update/);
  assert.equal(d.agyArgv, null, "agy must not run");
  const r = run(["review"], { cwd: gitRepoWithChange("agy-old-"), extraEnv: env });
  assert.match(r.stdout, /too old/i);
  assert.equal(r.agyArgv, null);
  // Background is refused too, and leaves no job behind.
  const b = run(["delegate", "--read-only", "--background", "explain"], { extraEnv: env });
  assert.match(b.stdout, /too old/i);
  assert.match(run(["status"], { home: b.home, cwd: b.cwd }).stdout, /No Antigravity jobs/);
  // A write-capable delegate still runs on an old agy.
  assert.match(run(["delegate", "x"], { extraEnv: env }).stdout, /Fake agy reply/);
});

test("review passes --json-schema and renders findings most severe first", () => {
  const cwd = gitRepoWithChange("agy-struct-");
  const { stdout, agyArgv } = run(["review"], { cwd });
  const schema = JSON.parse(agyArgv[agyArgv.indexOf("--json-schema") + 1]);
  assert.deepEqual(schema.required, ["verdict", "summary", "findings"]);
  assert.match(stdout, /needs work/);
  assert.ok(stdout.indexOf("[high]") < stdout.indexOf("[low]"), "high before low");
  assert.match(stdout, /`a\.txt:1`/, "paths shown relative to the repo");
  assert.match(stdout, /Fix: Fix it\./);
  assert.ok(!stdout.includes('"verdict"'), "raw JSON tail is not printed");
});

test("review falls back to prose when structured output is invalid or unsupported", () => {
  const bad = run(["review"], { cwd: gitRepoWithChange("agy-bad-"), extraEnv: { FAKE_AGY_STRUCTURED: "bad" } });
  assert.match(bad.stdout, /Fake agy reply/);
  const old = run(["review"], { cwd: gitRepoWithChange("agy-noschema-"), extraEnv: { FAKE_AGY_NO_JSON_SCHEMA: "1" } });
  assert.ok(!old.agyArgv.includes("--json-schema"));
  assert.match(old.stdout, /Fake agy reply/);
});

test("delegate never asks for structured output", () => {
  assert.ok(!run(["delegate", "x"]).agyArgv.includes("--json-schema"));
});

// ---------------------------------------------------------------------------
// Stop-time review gate
// ---------------------------------------------------------------------------
function hook(stdinObj, { home, extraEnv = {} } = {}) {
  const argvFile = join(tmp("agy-argv-"), "argv.json");
  const env = {
    ...process.env,
    ANTIGRAVITY_CC_AGY_BIN: FAKE_AGY,
    ANTIGRAVITY_CC_HOME: home,
    FAKE_AGY_ARGV_FILE: argvFile,
    FAKE_AGY_MODE: "success",
    ...extraEnv,
  };
  delete env.ANTIGRAVITY_CC_MODEL;
  // Run from an unrelated directory: the hook must use the cwd from stdin.
  const res = spawnSync(process.execPath, [COMPANION, "review-gate-hook"], {
    cwd: tmp("agy-hookcwd-"),
    env,
    input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, ...stdinObj }),
    encoding: "utf8",
  });
  let agyArgv = null;
  try {
    agyArgv = JSON.parse(readFileSync(argvFile, "utf8"));
  } catch {
    /* agy not invoked */
  }
  return { code: res.status, stdout: res.stdout, agyArgv };
}

function gatedRepo(prefix) {
  const cwd = gitRepoWithChange(prefix);
  const home = tmp("agy-gatehome-");
  const s = run(["setup", "--json", "--enable-review-gate"], { cwd, home });
  assert.equal(JSON.parse(s.stdout).reviewGate, true);
  return { cwd, home };
}

test("review gate: off by default, the hook does nothing and never runs agy", () => {
  const cwd = gitRepoWithChange("agy-gateoff-");
  const h = hook({ cwd }, { home: tmp("agy-gatehome-") });
  assert.equal(h.code, 0);
  assert.equal(h.stdout, "");
  assert.equal(h.agyArgv, null);
});

test("review gate: needs-work blocks the stop with the findings, read-only", () => {
  const { cwd, home } = gatedRepo("agy-gateblock-");
  const h = hook({ cwd }, { home });
  assert.equal(h.code, 0);
  const decision = JSON.parse(h.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /needs work/);
  assert.match(decision.reason, /\[high\] a\.txt:1 — Real bug/);
  assert.ok(decision.reason.indexOf("[high]") < decision.reason.indexOf("[low]"));
  assert.match(decision.reason, /--disable-review-gate/);
  for (const flag of ["--sandbox", "--settings", "--json-schema"]) assert.ok(h.agyArgv.includes(flag), flag);
  assert.ok(!h.agyArgv.includes("--dangerously-skip-permissions"));

  // Same diff again: already gated, agy is not run a second time.
  const again = hook({ cwd }, { home });
  assert.equal(again.stdout, "");
  assert.equal(again.agyArgv, null);
  // A changed diff is reviewed again.
  writeFileSync(join(cwd, "a.txt"), "hello again\n");
  assert.ok(hook({ cwd }, { home }).agyArgv);
});

test("review gate: stop_hook_active never re-runs the review (no loop)", () => {
  const { cwd, home } = gatedRepo("agy-gateactive-");
  const h = hook({ cwd, stop_hook_active: true }, { home });
  assert.equal(h.stdout, "");
  assert.equal(h.agyArgv, null);
});

test("review gate: ship lets Claude stop", () => {
  const { cwd, home } = gatedRepo("agy-gateship-");
  const h = hook({ cwd }, { home, extraEnv: { FAKE_AGY_VERDICT: "ship" } });
  assert.ok(h.agyArgv, "agy ran");
  assert.equal(h.stdout, "");
  assert.match(run(["setup"], { cwd, home }).stdout, /Review gate \(this repo\): on · last verdict: ship/);
});

test("review gate fails open: quota, bad output, old agy", () => {
  const { cwd, home } = gatedRepo("agy-gatefail-");
  const q = hook({ cwd }, { home, extraEnv: { FAKE_AGY_MODE: "quota" } });
  assert.equal(q.code, 0);
  assert.equal(q.stdout, "");
  const bad = hook({ cwd }, { home, extraEnv: { FAKE_AGY_STRUCTURED: "bad" } });
  assert.equal(bad.stdout, "");
  // Neither run recorded the diff, so a later good run still reviews it.
  assert.ok(hook({ cwd }, { home }).stdout.includes('"block"'));
  writeFileSync(join(cwd, "a.txt"), "changed\n");
  const old = hook({ cwd }, { home, extraEnv: { FAKE_AGY_NO_JSON_SCHEMA: "1" } });
  assert.equal(old.stdout, "");
  assert.equal(old.agyArgv, null);
});

test("setup --disable-review-gate turns it off; outside a repo it changes nothing", () => {
  const { cwd, home } = gatedRepo("agy-gatetoggle-");
  assert.equal(JSON.parse(run(["setup", "--json", "--disable-review-gate"], { cwd, home }).stdout).reviewGate, false);
  assert.equal(hook({ cwd }, { home }).agyArgv, null);
  assert.match(run(["setup", "--enable-review-gate"], { home }).stdout, /not inside a git repository/);
});
