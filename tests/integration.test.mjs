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
  assert.match(stdout, /Fake agy reply/);
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
  assert.match(stdout, /Fake agy reply/);
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
