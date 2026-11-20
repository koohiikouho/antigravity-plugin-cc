#!/usr/bin/env node
// Test fixture that imitates agy 1.5.x print mode closely enough to exercise
// the companion end-to-end without auth or quota.
//
// Protocol (mirrors the real CLI with --input-format/--output-format stream-json):
//   stdin : {"event":"user","message":{"content":"<prompt>"}}
//   stdout: init -> step_update (text_delta) -> result, one JSON object per line
//
// Modes via FAKE_AGY_MODE env:
//   success (default) -> SUCCESS result echoing the prompt, exit 0
//   quota             -> ERROR result with RESOURCE_EXHAUSTED, stderr line, exit 1
//   auth              -> ERROR result, "authentication required" on stderr, exit 1
//   denied            -> SUCCESS with empty response + denied_actions + stderr notice, exit 0
//   badmodel          -> ERROR result, invalid model on stderr, exit 1
// FAKE_AGY_ARGV_FILE, when set, receives the argv as JSON (for flag assertions).

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("9.9.9-fake\n");
  process.exit(0);
}
if (argv[0] === "models") {
  process.stdout.write("gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\ngemini-4-neon-high\tGemini 4 Neon (High)\n");
  process.exit(0);
}

if (process.env.FAKE_AGY_ARGV_FILE) writeFileSync(process.env.FAKE_AGY_ARGV_FILE, JSON.stringify(argv));

function valueOf(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
}

let prompt = "";
try {
  const line = readFileSync(0, "utf8").split(/\r?\n/).find((l) => l.trim());
  prompt = JSON.parse(line).message.content;
} catch {
  process.stderr.write("fake-agy: no stream-json user event on stdin\n");
  process.exit(2);
}

const convId = valueOf("--conversation") || "abcd1234-ef56-7890-abcd-1234567890ef";
const mode = process.env.FAKE_AGY_MODE || "success";
const logFile = valueOf("--log-file");
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const result = (fields) => emit({ event: "result", result: { conversation_id: convId, usage: {}, ...fields } });

if (logFile) writeFileSync(logFile, `I0101 00:00:00.000000 1 server.go:755] Created conversation ${convId}\n`);
emit({ event: "init", conversation_id: convId });

if (mode === "quota") {
  const msg =
    "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in 152h59m39s.";
  result({ status: "ERROR", response: "", error: msg });
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}
if (mode === "auth") {
  result({ status: "ERROR", response: "", error: "authentication required" });
  process.stderr.write("Error: authentication required. Run `agy` to sign in.\n");
  process.exit(1);
}
if (mode === "badmodel") {
  result({ status: "ERROR", response: "", error: `invalid model selection: ${valueOf("--model")}` });
  process.stderr.write(`Error: invalid model selection: "${valueOf("--model")}" is not recognized as a known model\n`);
  process.exit(1);
}
if (mode === "denied") {
  result({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Run command" }] });
  process.stderr.write(
    'no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n',
  );
  process.exit(0);
}

const echo = String(prompt).slice(0, 60).replace(/\s+/g, " ");
const text = `Fake agy reply. I received: "${echo}". Verdict: looks good.`;
emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: text } });
result({ status: "SUCCESS", response: text });
process.exit(0);
