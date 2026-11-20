// Build, run and interpret `agy` print-mode invocations.
//
// Transport (verified against agy 1.5.x):
//   agy <flags> --input-format stream-json --output-format stream-json
// with the prompt written to STDIN as one NDJSON `user` event. Sending the prompt
// on stdin instead of argv avoids the Windows 32,767-char command-line limit
// (ENAMETOOLONG) that large review diffs used to hit.
//
// stdout is NDJSON: one `init` event (carries conversation_id), `step_update`
// events, and a final `result` event whose payload matches the
// `--output-format json` envelope: { conversation_id, status, response, error?,
// usage, denied_actions? }. Pre-flight failures (e.g. an unknown --model) still
// emit a `result` with status ERROR and exit 1.
//
// Tool actions that need approval are soft-denied in headless mode: agy exits 0,
// the result carries `denied_actions`, and stderr explains which permission was
// auto-denied. We surface that instead of treating it as success.

import { spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { classifyErrorText } from "./logscan.mjs";

const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve how to launch `bin`. A .mjs/.js/.cjs override (used by tests via
 * ANTIGRAVITY_CC_AGY_BIN) runs through the current node, since Windows cannot
 * execute scripts directly.
 */
export function launchSpec(bin, args = []) {
  if (/\.(mjs|cjs|js)$/i.test(String(bin))) return { cmd: process.execPath, args: [bin, ...args] };
  return { cmd: bin, args };
}

/**
 * Session-only settings that make a run actually read-only. `--sandbox` only
 * restricts the terminal, and a "do not modify files" prompt is advisory: agy
 * 1.5.13 still wrote files under both. With these rules, creating files,
 * editing existing files and shell commands were all blocked (verified live on
 * 1.5.13); reads stay allowed. agy's docs give rule precedence as
 * Deny > Ask > Allow, so the user's own allow rules should not override them
 * (documented, not tested). Read-only runs never pass --yolo.
 */
export const READ_ONLY_SETTINGS = Object.freeze({
  permissions: { deny: ["write_file(*)", "command(*)"] },
});

/**
 * @param {object} opts
 * @param {string[]} [opts.addDirs]
 * @param {boolean} [opts.yolo]            --dangerously-skip-permissions (opt-in only)
 * @param {boolean} [opts.sandbox]         --sandbox
 * @param {string}  [opts.model]           --model <slug|name> (see `agy models`)
 * @param {string}  [opts.effort]          --effort low|medium|high|xhigh|max
 * @param {string}  [opts.mode]            --mode accept-edits|auto|plan
 * @param {object}  [opts.settings]        --settings <json> (session-only settings.json overrides)
 * @param {object}  [opts.jsonSchema]      --json-schema <json> (structured final result)
 * @param {string}  [opts.conversationId]  --conversation <id>
 * @param {string}  [opts.logFile]         --log-file <path>
 * @param {string}  [opts.printTimeout]    --print-timeout <go-dur>, e.g. "10m"
 * @returns {string[]}
 */
export function buildPrintArgs(opts = {}) {
  const args = [];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.sandbox) args.push("--sandbox");
  if (opts.yolo) args.push("--dangerously-skip-permissions");
  if (opts.settings) args.push("--settings", JSON.stringify(opts.settings));
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  for (const dir of opts.addDirs || []) {
    if (dir) args.push("--add-dir", dir);
  }
  if (opts.conversationId) args.push("--conversation", opts.conversationId);
  if (opts.logFile) args.push("--log-file", opts.logFile);
  if (opts.printTimeout) args.push("--print-timeout", opts.printTimeout);
  args.push("--input-format", "stream-json", "--output-format", "stream-json");
  return args;
}

/** Encode a prompt as the single stream-json `user` event agy reads from stdin. */
export function encodePrompt(prompt) {
  return `${JSON.stringify({ event: "user", message: { content: String(prompt ?? "") } })}\n`;
}

/** Parse a Go duration string ("5m0s", "90s", "10m") to milliseconds. */
export function goDurationToMs(value, fallbackMs = 5 * 60 * 1000) {
  if (typeof value !== "string" || !value.trim()) return fallbackMs;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s)/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2];
    if (unit === "h") total += n * 3600000;
    else if (unit === "m") total += n * 60000;
    else if (unit === "s") total += n * 1000;
    else if (unit === "ms") total += n;
  }
  return matched ? total : fallbackMs;
}

function readLogSafe(file) {
  try {
    if (file && existsSync(file)) return readFileSync(file, "utf8");
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Parse agy stream-json (or a bare json envelope) from stdout. Non-JSON lines
 * are ignored.
 *
 * @returns {{ conversationId: string|null, result: object|null, streamedText: string }}
 */
export function parseAgyStream(stdout) {
  let conversationId = null;
  let result = null;
  let streamedText = "";
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.event === "init") {
      conversationId = obj.conversation_id || obj.init?.conversation_id || conversationId;
    } else if (obj.event === "step_update") {
      const s = obj.step_update || {};
      conversationId = conversationId || s.conversation_id || null;
      if (s.step_type === "agent_response" && typeof s.text_delta === "string") streamedText += s.text_delta;
    } else if (obj.event === "result") {
      result = obj.result || null;
    } else if (!obj.event && typeof obj.status === "string") {
      result = obj; // bare --output-format json envelope
    }
  }
  if (result?.conversation_id) conversationId = result.conversation_id;
  return { conversationId: conversationId || null, result, streamedText };
}

/**
 * Latest tool action from agy stream-json output, for `status` on a running
 * background job. Reads only the tail of large outputs; the first line of a
 * tail is usually partial and is dropped.
 *
 * Tool steps look like (agy 1.5.13):
 *   {"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE"|"DONE",
 *    "tool_name":"read_file","tool_info":{"parameters":{"Path":"..."}}}}
 *
 * @returns {{ tool: string, target: string|null, state: string|null, steps: number }|null}
 */
export function latestToolStep(stdout, maxBytes = 256 * 1024) {
  let text = String(stdout || "");
  let truncated = false;
  if (text.length > maxBytes) {
    text = text.slice(-maxBytes);
    truncated = true;
  }
  const lines = text.split(/\r?\n/);
  if (truncated) lines.shift();
  let last = null;
  let steps = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.includes('"tool"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const s = obj.event === "step_update" ? obj.step_update || {} : null;
    if (!s || s.step_type !== "tool") continue;
    if (s.state === "ACTIVE") steps += 1;
    const p = s.tool_info?.parameters || {};
    const target =
      [p.Path, p.CommandLine, p.Command, p.Url, p.Query, p.Pattern].find((v) => typeof v === "string" && v) ||
      Object.values(p).find((v) => typeof v === "string" && v) ||
      null;
    last = { tool: s.tool_name || s.tool_info?.name || "tool", target, state: s.state || null };
  }
  return last ? { ...last, steps } : null;
}

const DENIAL_RE = /auto-denied|was denied|cannot prompt for|user denied perm/i;

/** Extract a human-readable denial summary from the result + stderr. */
export function detectDenial(result, stderr) {
  const actions = Array.isArray(result?.denied_actions) ? result.denied_actions : [];
  const notice = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => DENIAL_RE.test(l))
    .join("\n");
  if (!actions.length && !notice) return null;
  const names = actions.map((a) => a.display_name || a.action).filter(Boolean);
  return { actions: names, notice };
}

/**
 * Turn a finished agy run into a single outcome. Shared by foreground runs and
 * by background-job reconciliation.
 *
 * @param {{stdout?: string, stderr?: string, code?: number|null, timedOut?: boolean,
 *          error?: string, logText?: string, printTimeout?: string}} run
 * @returns {{ ok: boolean, response: string, conversationId: string|null,
 *             status: string|null, denial: object|null, structured: object|null,
 *             error: {kind: string, message: string, resetsIn: string|null}|null }}
 */
export function interpretRun(run) {
  const { conversationId, result, streamedText } = parseAgyStream(run.stdout);
  const stderr = String(run.stderr || "");
  const denial = detectDenial(result, stderr);
  const response = String(result?.response ?? streamedText ?? "").trim();
  const status = result?.status || null;
  const structured = result?.structured_output && typeof result.structured_output === "object" ? result.structured_output : null;
  const base = { response, conversationId, status, denial, structured };

  if (run.error) {
    return { ...base, ok: false, error: { kind: "spawn", message: run.error, resetsIn: null } };
  }
  if (run.timedOut) {
    return {
      ...base,
      ok: false,
      error: { kind: "timeout", message: `Antigravity timed out${run.printTimeout ? ` after ${run.printTimeout}` : ""}.`, resetsIn: null },
    };
  }

  if (status === "SUCCESS" && (response || structured)) {
    return { ...base, ok: true, error: null };
  }
  if (status === "SUCCESS" && denial) {
    return {
      ...base,
      ok: false,
      error: { kind: "denied", message: denial.notice || "A tool action was auto-denied in headless mode.", resetsIn: null },
    };
  }

  // Anything else is a failure: classify the most specific text we have.
  const errText = [result?.error, stderr, run.logText].filter(Boolean).join("\n");
  const classified = classifyErrorText(errText);
  if (classified) return { ...base, ok: false, error: classified };

  if (status === "SUCCESS" && !response) {
    return { ...base, ok: true, error: null }; // genuinely empty answer
  }
  if (!result && run.code === 0 && response) {
    return { ...base, ok: true, error: null };
  }
  const message =
    result?.error ||
    firstLine(stderr) ||
    (status ? `agy finished with status ${status}` : `agy exited with code ${run.code ?? "unknown"} and no result`);
  return { ...base, ok: false, error: { kind: "backend", message, resetsIn: null } };
}

function firstLine(s) {
  return (
    String(s || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || ""
  );
}

/**
 * Run agy synchronously (foreground) with a hard watchdog on top of agy's own
 * --print-timeout. The prompt is fed on stdin.
 */
export function runForeground({ bin, args, cwd, input, logFile, watchdogMs }) {
  const spec = launchSpec(bin, args);
  const res = spawnSync(spec.cmd, spec.args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: watchdogMs,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = Boolean(res.error && /ETIMEDOUT/i.test(String(res.error.code || res.error.message || "")));
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    code: res.status,
    signal: res.signal || null,
    timedOut,
    logText: readLogSafe(logFile),
    logFile,
    error: res.error && !timedOut ? String(res.error.message || res.error.code) : undefined,
  };
}

/**
 * Spawn agy detached for background execution. The prompt is written to
 * `inputFile` and handed to the child as its stdin, so the parent can exit
 * immediately. stdout (NDJSON) -> outputFile, stderr -> errFile.
 */
export function spawnBackground({ bin, args, cwd, input, inputFile, outputFile, errFile }) {
  writeFileSync(inputFile, input);
  const stdin = openSync(inputFile, "r");
  const out = openSync(outputFile, "a");
  const err = openSync(errFile, "a");
  const spec = launchSpec(bin, args);
  const child = spawn(spec.cmd, spec.args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: [stdin, out, err],
  });
  child.unref();
  return { pid: child.pid };
}

/** Kill a process and its children. Windows needs taskkill /T for the tree. */
export function killTree(pid) {
  if (!pid) return false;
  if (IS_WINDOWS) {
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
    return res.status === 0;
  }
  try {
    process.kill(-pid, "SIGTERM"); // detached => own process group
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

/** Quick `agy --version`. Returns version string or null. */
export function agyVersion(bin) {
  try {
    const spec = launchSpec(bin, ["--version"]);
    const res = spawnSync(spec.cmd, spec.args, { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (res.status === 0) return (res.stdout || res.stderr || "").trim().split(/\r?\n/)[0] || null;
  } catch {
    /* ignore */
  }
  return null;
}

const featureCache = new Map();

/**
 * Optional flags this agy build supports, read from `agy --help` (stdout and
 * stderr). Memoized per process only: agy self-updates, so a disk cache would
 * go stale.
 *
 * @returns {{ settings: boolean, jsonSchema: boolean }}
 */
export function agyFeatures(bin) {
  if (featureCache.has(bin)) return featureCache.get(bin);
  let text = "";
  try {
    const spec = launchSpec(bin, ["--help"]);
    const res = spawnSync(spec.cmd, spec.args, { encoding: "utf8", timeout: 15000, windowsHide: true });
    text = `${res.stdout || ""}\n${res.stderr || ""}`;
  } catch {
    /* treat as no optional features */
  }
  const features = { settings: /--settings\b/.test(text), jsonSchema: /--json-schema\b/.test(text) };
  featureCache.set(bin, features);
  return features;
}

/** `agy models` -> [{ slug, name }] or [] on failure. */
export function agyModels(bin) {
  try {
    const spec = launchSpec(bin, ["models"]);
    const res = spawnSync(spec.cmd, spec.args, { encoding: "utf8", timeout: 30000, windowsHide: true });
    if (res.status !== 0) return [];
    return String(res.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.split("\t"))
      .filter((p) => p.length >= 2 && p[0].trim())
      .map(([slug, name]) => ({ slug: slug.trim(), name: name.trim() }));
  } catch {
    return [];
  }
}

export { readLogSafe };
