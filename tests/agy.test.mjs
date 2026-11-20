import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrintArgs,
  encodePrompt,
  goDurationToMs,
  launchSpec,
  parseAgyStream,
  detectDenial,
  interpretRun,
  latestToolStep,
  readOnlySettings,
  READ_ONLY_SETTINGS,
} from "../plugins/antigravity/scripts/lib/agy.mjs";
import { normalizeReview } from "../plugins/antigravity/scripts/lib/review.mjs";
import { displayPath } from "../plugins/antigravity/scripts/lib/render.mjs";

test("buildPrintArgs: flags in order, stream-json last, no prompt in argv", () => {
  const args = buildPrintArgs({
    model: "gemini-4-hydrogen-low",
    mode: "accept-edits",
    sandbox: true,
    yolo: true,
    addDirs: ["/a", "/b"],
    conversationId: "conv-1",
    logFile: "/l",
    printTimeout: "5m",
  });
  assert.deepEqual(args, [
    "--model",
    "gemini-4-hydrogen-low",
    "--mode",
    "accept-edits",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--add-dir",
    "/a",
    "--add-dir",
    "/b",
    "--conversation",
    "conv-1",
    "--log-file",
    "/l",
    "--print-timeout",
    "5m",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ]);
  assert.ok(!args.includes("-p"));
  assert.ok(!args.includes("--continue"));
});

test("buildPrintArgs: no yolo / sandbox / model unless asked", () => {
  const args = buildPrintArgs({});
  assert.deepEqual(args, ["--input-format", "stream-json", "--output-format", "stream-json"]);
});

test("buildPrintArgs: settings are serialized as one --settings json arg", () => {
  const args = buildPrintArgs({ settings: { permissions: { deny: ["write_file(*)"] } } });
  assert.equal(args[args.indexOf("--settings") + 1], '{"permissions":{"deny":["write_file(*)"]}}');
});

test("encodePrompt produces one stream-json user event line", () => {
  const line = encodePrompt('say "hi"\nplease');
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), { event: "user", message: { content: 'say "hi"\nplease' } });
});

test("launchSpec runs script overrides through node, binaries directly", () => {
  assert.deepEqual(launchSpec("/x/fake.mjs", ["a"]), { cmd: process.execPath, args: ["/x/fake.mjs", "a"] });
  assert.deepEqual(launchSpec("C:/agy/bin/agy.exe", ["a"]), { cmd: "C:/agy/bin/agy.exe", args: ["a"] });
  assert.deepEqual(launchSpec("/usr/bin/agyjs", []), { cmd: "/usr/bin/agyjs", args: [] });
});

test("goDurationToMs parses composite and simple durations", () => {
  assert.equal(goDurationToMs("5m0s"), 300000);
  assert.equal(goDurationToMs("90s"), 90000);
  assert.equal(goDurationToMs("10m"), 600000);
  assert.equal(goDurationToMs("1h"), 3600000);
  assert.equal(goDurationToMs("1h30m"), 5400000);
  assert.equal(goDurationToMs("500ms"), 500);
});

test("goDurationToMs falls back on garbage", () => {
  assert.equal(goDurationToMs("not-a-duration", 123), 123);
  assert.equal(goDurationToMs("", 456), 456);
});

const CID = "abcd1234-ef56-7890-abcd-1234567890ef";
const ev = (o) => JSON.stringify(o);

test("parseAgyStream reads init, deltas and result; skips noise", () => {
  const stdout = [
    "warning: not json",
    ev({ event: "init", conversation_id: CID }),
    ev({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Hel" } }),
    ev({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "lo" } }),
    ev({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "Hello" } }),
  ].join("\n");
  const r = parseAgyStream(stdout);
  assert.equal(r.conversationId, CID);
  assert.equal(r.streamedText, "Hello");
  assert.equal(r.result.response, "Hello");
});

test("parseAgyStream accepts a bare json envelope", () => {
  const r = parseAgyStream(ev({ conversation_id: CID, status: "SUCCESS", response: "ok" }));
  assert.equal(r.result.status, "SUCCESS");
  assert.equal(r.conversationId, CID);
});

test("detectDenial reads denied_actions and the stderr notice", () => {
  const d = detectDenial(
    { denied_actions: [{ action: "command", display_name: "Run command" }] },
    "some noise\nno output produced — a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied.",
  );
  assert.deepEqual(d.actions, ["Run command"]);
  assert.match(d.notice, /auto-denied/);
  assert.equal(detectDenial({ status: "SUCCESS" }, "all fine"), null);
});

test("interpretRun: success", () => {
  const o = interpretRun({
    code: 0,
    stdout: ev({ event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "done" } }),
  });
  assert.equal(o.ok, true);
  assert.equal(o.response, "done");
  assert.equal(o.conversationId, CID);
});

test("interpretRun: soft-deny with empty response is a denied failure, not silent success", () => {
  const o = interpretRun({
    code: 0,
    stdout: ev({ event: "result", result: { status: "SUCCESS", response: "", denied_actions: [{ action: "command" }] } }),
    stderr: "a tool required the \"command\" permission that headless mode cannot prompt for, so it was auto-denied",
  });
  assert.equal(o.ok, false);
  assert.equal(o.error.kind, "denied");
});

test("interpretRun: answer plus a denial stays ok but keeps the denial", () => {
  const o = interpretRun({
    code: 0,
    stdout: ev({ event: "result", result: { status: "SUCCESS", response: "partial", denied_actions: [{ action: "command" }] } }),
  });
  assert.equal(o.ok, true);
  assert.deepEqual(o.denial.actions, ["command"]);
});

test("interpretRun: quota error on result + stderr, non-zero exit", () => {
  const o = interpretRun({
    code: 1,
    stdout: ev({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h2m3s." } }),
  });
  assert.equal(o.ok, false);
  assert.equal(o.error.kind, "quota");
  assert.equal(o.error.resetsIn, "1h2m3s");
});

test("interpretRun: bad model and effort conflict are model errors", () => {
  const a = interpretRun({ code: 1, stderr: 'invalid model selection: "gemini-9" is not recognized as a known model' });
  assert.equal(a.error.kind, "model");
  const b = interpretRun({ code: 1, stderr: "--model gemini-4-hydrogen-low conflicts with --effort low" });
  assert.equal(b.error.kind, "model");
});

test("interpretRun: non-zero exit with no result is a backend error with stderr", () => {
  const o = interpretRun({ code: 3, stdout: "", stderr: "panic: something odd\nstack..." });
  assert.equal(o.ok, false);
  assert.equal(o.error.kind, "backend");
  assert.match(o.error.message, /panic: something odd/);
});

test("interpretRun: spawn error and timeout win over everything", () => {
  assert.equal(interpretRun({ error: "spawn ENOENT" }).error.kind, "spawn");
  const t = interpretRun({ timedOut: true, printTimeout: "10m" });
  assert.equal(t.error.kind, "timeout");
  assert.match(t.error.message, /10m/);
});

// Lines shaped like a live agy 1.5.13 run (paths shortened).
const toolEv = (state, tool, params) =>
  ev({ event: "step_update", step_update: { step_type: "tool", state, tool_name: tool, tool_info: { name: tool, parameters: params } } });

test("latestToolStep reports the most recent tool action and counts steps", () => {
  const out = [
    ev({ event: "init", conversation_id: CID }),
    toolEv("ACTIVE", "read_file", { Path: "C:\\repo\\m.py" }),
    toolEv("DONE", "read_file", { Path: "C:\\repo\\m.py" }),
    toolEv("ACTIVE", "run_command", { CommandLine: "npm test" }),
  ].join("\n");
  assert.deepEqual(latestToolStep(out), { tool: "run_command", target: "npm test", state: "ACTIVE", steps: 2 });
  assert.equal(latestToolStep(ev({ event: "init" })), null);
});

test("latestToolStep drops a partial first line when reading a tail", () => {
  const out = `${"x".repeat(50)}\n${toolEv("ACTIVE", "write_file", { Path: "/r/a" })}\n`;
  const r = latestToolStep(out, out.length - 10); // cut inside the junk line
  assert.equal(r.tool, "write_file");
});

test("interpretRun carries structured_output, and it alone counts as success", () => {
  const o = interpretRun({
    code: 0,
    stdout: ev({ event: "result", result: { status: "SUCCESS", response: "", structured_output: { verdict: "ship" } } }),
  });
  assert.equal(o.ok, true);
  assert.deepEqual(o.structured, { verdict: "ship" });
});

test("normalizeReview validates, defaults and sorts", () => {
  assert.equal(normalizeReview(null), null);
  assert.equal(normalizeReview({ verdict: "maybe" }), null);
  const r = normalizeReview({
    verdict: "needs-work",
    summary: " s ",
    findings: [
      { severity: "low", file: "a", title: "t1", detail: "d" },
      { severity: "bogus", title: "", line: -2 },
      { severity: "critical", file: "b", line: 4, title: "t2", detail: "d" },
    ],
  });
  assert.deepEqual(r.findings.map((f) => f.severity), ["critical", "low", "low"]);
  assert.equal(r.findings[2].title, "(untitled finding)");
  assert.equal(r.findings[2].line, null);
  assert.equal(r.summary, "s");
});

test("displayPath relativizes paths inside cwd, case-insensitively on Windows drives", () => {
  assert.equal(displayPath("C:\\Repo\\src\\a.js", "c:/repo"), "src/a.js");
  assert.equal(displayPath("/home/u/repo/a.js", "/home/u/repo/"), "a.js");
  assert.equal(displayPath("/home/u/other/a.js", "/home/u/repo"), "/home/u/other/a.js");
  assert.equal(displayPath("/home/u/Repo/a.js", "/home/u/repo"), "/home/u/Repo/a.js");
});

test("readOnlySettings: no settings.json gives the plugin deny rules alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
  assert.deepEqual(readOnlySettings(dir), { permissions: { deny: [...READ_ONLY_SETTINGS.permissions.deny] } });
});

test("readOnlySettings: keeps the user's permissions and adds the deny rules", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ theme: "dark", permissions: { allow: ["read_file(*)"], deny: ["read_file(.env)", "command(*)"] } }),
  );
  const s = readOnlySettings(dir);
  assert.deepEqual(s.permissions.allow, ["read_file(*)"]);
  assert.deepEqual(s.permissions.deny, ["read_file(.env)", "command(*)", "write_file(*)"]);
  assert.equal(s.theme, undefined, "only permissions are carried over");
});

test("readOnlySettings: invalid settings.json is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-cfg-"));
  writeFileSync(join(dir, "settings.json"), "{not json");
  assert.deepEqual(readOnlySettings(dir).permissions.deny, [...READ_ONLY_SETTINGS.permissions.deny]);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ permissions: { deny: "nope" } }));
  assert.deepEqual(readOnlySettings(dir).permissions.deny, [...READ_ONLY_SETTINGS.permissions.deny]);
});
