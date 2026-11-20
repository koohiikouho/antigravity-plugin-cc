#!/usr/bin/env node
// Antigravity companion for Claude Code.
//
// Thin, dependency-free runtime that drives the `agy` CLI (Google Antigravity)
// in headless print mode and manages background jobs. Each subcommand prints
// Markdown that the calling slash command / subagent relays to the user verbatim.
//
// Subcommands: setup | delegate | review | resume | status | result | cancel
//   (aliases: run, task -> delegate)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseArgs, hasFlag } from "./lib/args.mjs";
import { resolveAgyBinary, agyConfigDir } from "./lib/paths.mjs";
import {
  buildPrintArgs,
  READ_ONLY_SETTINGS,
  encodePrompt,
  interpretRun,
  runForeground,
  spawnBackground,
  goDurationToMs,
  agyVersion,
  agyModels,
  agyFeatures,
  latestToolStep,
  readLogSafe,
} from "./lib/agy.mjs";
import { resolveReviewTarget } from "./lib/git.mjs";
import { REVIEW_SCHEMA, normalizeReview } from "./lib/review.mjs";
import { createJob, writeJob, readJob, reconcile, listJobs, latestJob, cancelJob, nowIso } from "./lib/jobs.mjs";
import { readGate, writeGate, anyGateEnabled, repoKey, hashDiff, blockReason } from "./lib/gate.mjs";
import * as render from "./lib/render.mjs";

// The prompt travels on stdin, so there is no OS command-line limit; this cap
// only keeps a runaway diff from blowing the model's context.
const MAX_PROMPT_BYTES = 512 * 1024;
const DEFAULT_PRINT_TIMEOUT = "10m";
const WATCHDOG_GRACE_MS = 60_000;

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function warn(text) {
  process.stderr.write(`[antigravity-plugin-cc] ${text}\n`);
}

function requireBinaryOrExit() {
  const bin = resolveAgyBinary();
  if (!bin) {
    out(render.renderNotInstalled());
    process.exit(0);
  }
  return bin;
}

function clampPrompt(prompt) {
  const buf = Buffer.from(prompt, "utf8");
  if (buf.length <= MAX_PROMPT_BYTES) return prompt;
  return `${buf.subarray(0, MAX_PROMPT_BYTES).toString("utf8")}\n\n[...truncated by antigravity-plugin-cc: prompt exceeded ${MAX_PROMPT_BYTES} bytes...]`;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
function cmdSetup(parsed) {
  const gateNote = applyGateToggle(parsed);
  const bin = resolveAgyBinary();
  const configDir = agyConfigDir();
  const configExists = existsSync(configDir);
  const installationId = existsSync(join(configDir, "installation_id"));
  const hasConversations =
    existsSync(join(configDir, "conversations")) &&
    safeReaddir(join(configDir, "conversations")).some((f) => f.endsWith(".pb"));

  const version = bin ? agyVersion(bin.path) : null;
  // `agy models` needs a signed-in CLI but spends no quota; an empty list is a
  // strong hint that sign-in is missing.
  const models = bin ? agyModels(bin.path) : [];
  const authedGuess = models.length > 0 || (configExists && (installationId || hasConversations));

  const report = {
    ready: Boolean(bin),
    binary: { found: Boolean(bin), detail: bin ? `${bin.path} (${bin.source})` : "not found" },
    version,
    configDir: { exists: configExists, detail: configExists ? configDir : `${configDir} (missing)` },
    auth: {
      detail: !bin
        ? "n/a (install agy first)"
        : authedGuess
          ? "looks configured"
          : "no signed-in session detected — run `! agy` once to sign in",
    },
    models,
    reviewGate: gateStatus(bin),
    gateNote,
    nextSteps: [],
  };

  if (!bin) {
    report.nextSteps.push("Install agy (see the install block below), then rerun `/antigravity:setup`.");
  } else if (!authedGuess) {
    report.nextSteps.push("Run `! agy` once to complete the browser sign-in, then you're ready.");
  } else {
    report.nextSteps.push("You're set. Try `/antigravity:review` or `/antigravity:delegate <task>`.");
  }

  if (hasFlag(parsed, "json")) {
    out(
      JSON.stringify(
        {
          ready: report.ready,
          installed: report.binary.found,
          binaryPath: bin?.path ?? null,
          version,
          authedGuess,
          configDir,
          models: models.map((m) => m.slug),
          reviewGate: report.reviewGate.enabled,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!bin) {
    out(`${render.renderNotInstalled()}${gateNote ? `\n${gateNote}\n` : ""}`);
    return;
  }
  out(render.renderSetup(report));
}

/** `setup --enable-review-gate` / `--disable-review-gate`, for the current repository. */
function applyGateToggle(parsed) {
  const enable = hasFlag(parsed, "enable-review-gate");
  const disable = hasFlag(parsed, "disable-review-gate");
  if (!enable && !disable) return null;
  if (enable && disable) return "Pass only one of `--enable-review-gate` / `--disable-review-gate`. Nothing changed.";
  const key = repoKey(process.cwd());
  if (!key) return "The review gate is per repository, and this directory is not inside a git repository. Nothing changed.";
  const state = readGate();
  state.repos[key] = { ...(state.repos[key] || {}), enabled: enable };
  writeGate(state);
  return enable
    ? `Review gate enabled for \`${key}\`. When Claude finishes a turn with uncommitted changes here, Antigravity reviews them (read-only) and sends Claude back to work on a "needs work" verdict. Each turn's review can take a few minutes and uses agy quota.`
    : `Review gate disabled for \`${key}\`.`;
}

function gateStatus(bin) {
  const key = repoKey(process.cwd());
  const entry = key ? readGate().repos[key] : null;
  const features = bin ? agyFeatures(bin.path) : { settings: false, jsonSchema: false };
  return {
    repo: key,
    enabled: Boolean(entry?.enabled),
    supported: Boolean(features.settings && features.jsonSchema),
    lastVerdict: entry?.lastVerdict || null,
    lastAt: entry?.lastAt || null,
  };
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// delegate / resume / review (shared core)
// ---------------------------------------------------------------------------

/** Most recent conversation id recorded by a job started from `cwd`. */
function latestConversationId(cwd) {
  const job = listJobs(cwd).find((j) => j.conversationId);
  return job ? job.conversationId : null;
}

function runAgyTask(parsed, { kind, title, prompt, readOnly, resume }) {
  const bin = requireBinaryOrExit();
  const cwd = process.cwd();

  // Read-only depends on session deny rules (--settings). Refuse rather than
  // run a "read-only" job that can still write files. Checked before createJob
  // so a refusal leaves no orphaned job, foreground or background.
  const features = agyFeatures(bin.path);
  if (readOnly && !features.settings) {
    out(render.renderNeedsUpdate(kind === "review" ? "review" : "--read-only"));
    return;
  }

  const sandbox = hasFlag(parsed, "sandbox") || Boolean(readOnly);
  // Auto-approving every tool is opt-in, and never allowed for read-only runs.
  let yolo = hasFlag(parsed, "yolo");
  if (yolo && readOnly) {
    warn("--yolo is ignored for read-only runs (review / --read-only).");
    yolo = false;
  }

  // `agy --continue` resumes the most recent conversation *globally*, which may
  // belong to another repo. Resolve the thread from this repo's own jobs instead.
  let conversationId = parsed.valued.conversation || null;
  if (!conversationId && (resume || hasFlag(parsed, "continue"))) {
    conversationId = latestConversationId(cwd);
    if (!conversationId) {
      out(
        "# 🛰️ Antigravity — resume\n\nNo earlier Antigravity conversation was recorded for this repository. " +
          "Start one with `/antigravity:delegate <task>`, or pass `--conversation <id>`.",
      );
      return;
    }
  }

  const printTimeout = parsed.valued["print-timeout"] || DEFAULT_PRINT_TIMEOUT;
  const timeoutMs = goDurationToMs(printTimeout, goDurationToMs(DEFAULT_PRINT_TIMEOUT));
  const watchdogMs = timeoutMs > 0 ? timeoutMs + WATCHDOG_GRACE_MS : undefined;
  const addDirs = [cwd, ...(parsed.repeated["add-dir"] || [])];
  const model = parsed.valued.model || process.env.ANTIGRAVITY_CC_MODEL || null;
  const effort = parsed.valued.effort || null;
  const mode = parsed.valued.mode || null;

  const finalPrompt = clampPrompt(prompt);
  const background = hasFlag(parsed, "background");

  const job = createJob({ kind, title, prompt: finalPrompt, cwd, conversationId });
  job.model = model;
  job.yolo = yolo;
  job.readOnly = Boolean(readOnly);
  if (watchdogMs) job.deadline = new Date(Date.parse(job.startedAt) + watchdogMs).toISOString();

  const args = buildPrintArgs({
    model,
    effort,
    mode,
    sandbox,
    yolo,
    settings: readOnly ? READ_ONLY_SETTINGS : undefined,
    // Older agy without --json-schema still gets a prose review.
    jsonSchema: kind === "review" && features.jsonSchema ? REVIEW_SCHEMA : undefined,
    addDirs,
    conversationId,
    logFile: job.paths.log,
    printTimeout,
  });
  const input = encodePrompt(finalPrompt);

  if (background) {
    const { pid } = spawnBackground({
      bin: bin.path,
      args,
      cwd,
      input,
      inputFile: job.paths.input,
      outputFile: job.paths.output,
      errFile: job.paths.err,
    });
    job.pid = pid;
    writeJob(job);
    out(render.renderBackgroundStarted(job));
    return;
  }

  const result = runForeground({ bin: bin.path, args, cwd, input, logFile: job.paths.log, watchdogMs });
  const outcome = interpretRun({ ...result, printTimeout });

  job.conversationId = outcome.conversationId || job.conversationId;
  job.finishedAt = nowIso();
  job.status = outcome.ok ? "done" : "failed";
  job.error = outcome.error ? outcome.error.message : null;
  job.errorKind = outcome.error?.kind || null;
  job.denial = outcome.denial;
  writeJob(job);

  out(renderOutcome(outcome, job, { yolo, readOnly }));
}

function renderOutcome(outcome, job, { yolo, readOnly } = {}) {
  const meta = {
    title: job.title,
    conversationId: job.conversationId,
    logFile: job.paths.log,
    denial: outcome.denial,
    cwd: job.cwd,
    yolo,
    readOnly,
  };
  if (outcome.ok) {
    // A structured review renders on its own; agy's `response` repeats it as a
    // trailing JSON line, so it is not printed too. Bad shapes fall back to prose.
    const review = job.kind === "review" ? normalizeReview(outcome.structured) : null;
    if (review) return render.renderReview(review, meta);
    return render.renderResponse(outcome.response, meta);
  }
  return render.renderError(outcome.error, { ...meta, partialResponse: outcome.response });
}

function cmdDelegate(parsed) {
  const task = parsed.text;
  if (!task) {
    out(
      "# 🛰️ Antigravity — delegate\n\nWhat should Antigravity work on? Pass the task, e.g.\n`/antigravity:delegate investigate why the auth tests fail and propose a fix`.",
    );
    return;
  }
  runAgyTask(parsed, { kind: "delegate", title: truncate(task, 80), prompt: task, readOnly: hasFlag(parsed, "read-only") });
}

function cmdResume(parsed) {
  const followUp = parsed.text || "Continue from where you left off.";
  runAgyTask(parsed, {
    kind: "delegate",
    title: truncate(followUp, 80),
    prompt: followUp,
    resume: true,
    readOnly: hasFlag(parsed, "read-only"),
  });
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------
function cmdReview(parsed) {
  requireBinaryOrExit();
  const cwd = process.cwd();
  const base = parsed.valued.base || null;
  const focus = parsed.text;

  const target = resolveReviewTarget(cwd, base);
  if (!target.ok) {
    out(`# 🛰️ Antigravity — review\n\nNothing to review: ${target.reason}.`);
    return;
  }

  const prompt = buildReviewPrompt(target, focus);
  // Reviews are read-only: sandboxed, never auto-approved, and with session deny
  // rules for file writes and commands (READ_ONLY_SETTINGS).
  runAgyTask(parsed, {
    kind: "review",
    title: `review ${target.label}`,
    prompt,
    readOnly: true,
  });
}

function buildReviewPrompt(target, focus) {
  return [
    "You are a meticulous senior code reviewer. Review ONLY the changes below. Do not modify any files.",
    focus ? `\nReviewer focus: ${focus}` : "",
    "\nReturn a concise review with:",
    "1. Verdict (ship / ship with nits / needs work).",
    "2. The most important issues first, each as: severity (critical/high/medium/low), file:line, what's wrong, and a concrete fix.",
    "3. Anything risky around correctness, security, error handling, concurrency, or data loss.",
    "4. A short list of suggested next steps.",
    `\nReview target: ${target.label}`,
    target.stat ? `\nDiffstat:\n${target.stat}` : "",
    "\nUnified diff:\n",
    "```diff",
    target.diff,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// review gate (Stop hook)
// ---------------------------------------------------------------------------
const GATE_PRINT_TIMEOUT = "8m"; // + WATCHDOG_GRACE_MS stays under the hook's 600s timeout

/**
 * Called by hooks/hooks.json on Stop. Prints nothing (allow) or one JSON object
 * `{"decision":"block","reason":...}` on stdout. Fails open: any missing piece
 * (no agy, too old, quota, auth, timeout, bad output) lets Claude stop.
 */
function cmdReviewGateHook() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    /* no or bad stdin: treat as empty */
  }
  // Claude is already continuing because of a Stop hook: never loop.
  if (input.stop_hook_active) return;

  const state = readGate();
  if (!anyGateEnabled(state)) return; // fast path: one file read, no git, no agy

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const key = repoKey(cwd);
  const entry = key ? state.repos[key] : null;
  if (!entry?.enabled) return;

  const bin = resolveAgyBinary();
  if (!bin) return;
  const features = agyFeatures(bin.path);
  if (!features.settings || !features.jsonSchema) return;

  const target = resolveReviewTarget(cwd, null);
  if (!target.ok) return;
  const hash = hashDiff(target.diff);
  if (entry.lastHash === hash) return; // this exact diff was already gated

  const args = buildPrintArgs({
    model: process.env.ANTIGRAVITY_CC_MODEL || null,
    sandbox: true,
    settings: READ_ONLY_SETTINGS,
    jsonSchema: REVIEW_SCHEMA,
    addDirs: [cwd],
    printTimeout: GATE_PRINT_TIMEOUT,
  });
  const run = runForeground({
    bin: bin.path,
    args,
    cwd,
    input: encodePrompt(clampPrompt(buildReviewPrompt(target, null))),
    watchdogMs: goDurationToMs(GATE_PRINT_TIMEOUT) + WATCHDOG_GRACE_MS,
  });
  const outcome = interpretRun({ ...run, printTimeout: GATE_PRINT_TIMEOUT });
  const review = outcome.ok ? normalizeReview(outcome.structured) : null;
  if (!review) return; // no usable verdict: don't record, don't block

  const fresh = readGate(); // re-read: setup may have run meanwhile
  fresh.repos[key] = { ...(fresh.repos[key] || entry), lastHash: hash, lastVerdict: review.verdict, lastAt: nowIso() };
  writeGate(fresh);

  if (review.verdict === "needs-work") {
    out(JSON.stringify({ decision: "block", reason: blockReason(review, (f) => render.displayPath(f, cwd)) }));
  }
}

// ---------------------------------------------------------------------------
// status / result / cancel
// ---------------------------------------------------------------------------
function cmdStatus(parsed) {
  const id = parsed.positionals.find((p) => p.startsWith("agy-"));
  if (id) {
    const job = readJob(id);
    if (!job) {
      out(`# 🛰️ Antigravity — status\n\nNo job \`${id}\` found.`);
      return;
    }
    reconcile(job);
    out(render.renderJobStatus(withProgress(job)));
    return;
  }
  out(render.renderStatus(listJobs(process.cwd()).map(withProgress)));
}

/** Attach the latest tool step to a running background job (read from its output file). */
function withProgress(job) {
  if (job.status !== "running") return job;
  return { ...job, progress: latestToolStep(readLogSafe(job.paths.output)) };
}

function cmdResult(parsed) {
  const id = parsed.positionals.find((p) => p.startsWith("agy-"));
  const job = id ? readJob(id) : latestJob(process.cwd());
  if (!job) {
    out(`# 🛰️ Antigravity — result\n\nNo ${id ? `job \`${id}\`` : "recent jobs"} found for this repository.`);
    return;
  }
  reconcile(job);
  if (job.status === "running") {
    out(render.renderJobStatus(withProgress(job)));
    return;
  }

  const outcome = interpretRun({
    stdout: readLogSafe(job.paths.output),
    stderr: readLogSafe(job.paths.err),
    logText: readLogSafe(job.paths.log),
    code: null,
    timedOut: job.errorKind === "timeout",
  });
  if (job.status === "cancelled") {
    out(render.renderError({ kind: "cancelled", message: "The job was cancelled.", resetsIn: null }, {
      title: job.title,
      conversationId: job.conversationId,
      partialResponse: outcome.response,
    }));
    return;
  }
  // Foreground jobs keep no output file; fall back to the recorded status.
  if (!readLogSafe(job.paths.output) && job.status === "failed") {
    out(render.renderError({ kind: job.errorKind || "backend", message: job.error || "failed", resetsIn: null }, {
      title: job.title,
      conversationId: job.conversationId,
      logFile: job.paths.log,
    }));
    return;
  }
  job.conversationId = job.conversationId || outcome.conversationId;
  out(renderOutcome(outcome, job, { yolo: job.yolo, readOnly: job.readOnly ?? job.kind === "review" }));
}

function cmdCancel(parsed) {
  const id = parsed.positionals.find((p) => p.startsWith("agy-"));
  const job = id ? readJob(id) : listJobs(process.cwd()).find((j) => j.status === "running");
  if (!job) {
    out(`# 🛰️ Antigravity — cancel\n\nNo running job ${id ? `\`${id}\`` : ""} to cancel.`);
    return;
  }
  const result = cancelJob(job);
  out(render.renderCancel(result, job));
}

// ---------------------------------------------------------------------------
function truncate(s, n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function usage() {
  out(
    [
      "antigravity companion — drive the Antigravity CLI (agy) from Claude Code",
      "",
      "Usage: node antigravity.mjs <subcommand> [args]",
      "  setup [--json] [--enable-review-gate | --disable-review-gate]",
      "  delegate <task> [--background] [--model <slug>] [--effort <lvl>] [--mode <m>] [--yolo] [--sandbox] [--read-only]",
      "                  [--continue] [--conversation <id>] [--add-dir <p>] [--print-timeout <dur>]",
      "  review [--base <ref>] [--background] [--model <slug>] [focus text...]",
      "  resume <follow-up> [--conversation <id>] [--background] [--model <slug>]",
      "  status [job-id]",
      "  result [job-id]",
      "  cancel [job-id]",
      "",
      "Models: run `agy models` for the slugs (e.g. gemini-4-hydrogen-low, gemini-4-neon-high).",
      "Set a default with ANTIGRAVITY_CC_MODEL.",
    ].join("\n"),
  );
}

function main() {
  const [, , sub, ...rest] = process.argv;
  const parsed = parseArgs(rest);
  switch (sub) {
    case "setup":
      return cmdSetup(parsed);
    case "delegate":
    case "run":
    case "task":
      return cmdDelegate(parsed);
    case "review":
      return cmdReview(parsed);
    case "resume":
      return cmdResume(parsed);
    case "status":
      return cmdStatus(parsed);
    case "result":
      return cmdResult(parsed);
    case "cancel":
      return cmdCancel(parsed);
    case "review-gate-hook":
      try {
        return cmdReviewGateHook();
      } catch (e) {
        warn(`review gate skipped: ${e?.message || e}`); // fail open
        return;
      }
    default:
      return usage();
  }
}

main();
