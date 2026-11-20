// Render companion output as Markdown that Claude relays to the user verbatim.

import { realpathSync } from "node:fs";

function ensureTrailingNewline(s) {
  return s.endsWith("\n") ? s : `${s}\n`;
}

function resumeFooter({ conversationId, jobId } = {}) {
  const lines = [];
  if (conversationId) {
    lines.push("", "---", `Antigravity conversation: \`${conversationId}\``);
    lines.push("Continue this thread: `/antigravity:resume <follow-up>`  ·  reopen in the TUI: `agy --conversation " + conversationId + "`");
  }
  if (jobId) {
    lines.push(`Job: \`${jobId}\``);
  }
  return lines;
}

function denialHint(meta = {}) {
  if (meta.readOnly) {
    return "This was a read-only run: the plugin denies file writes and commands for it (a \"user-configured deny rule\" in agy's words). Re-run with `/antigravity:delegate` without `--read-only` if it needs to change files or run commands.";
  }
  return "Allow the action with a rule under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, or re-run with `--yolo` to auto-approve every tool (only in a repo you trust).";
}

function denialLines(denial, meta = {}) {
  if (!denial) return [];
  const what = denial.actions?.length ? denial.actions.join(", ") : "a tool action";
  const lines = ["", `> ⚠️ Headless mode auto-denied: **${what}**. The answer may be incomplete.`];
  if (denial.notice) lines.push(`> ${denial.notice.split("\n")[0]}`);
  lines.push(`> ${denialHint(meta)}`);
  return lines;
}

/** Successful agy response (delegate / resume / review). The model text leads. */
export function renderResponse(responseText, meta = {}) {
  const body = (responseText || "").trim();
  const header = meta.title ? [`# 🛰️ Antigravity — ${meta.title}`, ""] : ["# 🛰️ Antigravity", ""];
  const lines = [
    ...header,
    body || "_(Antigravity returned an empty response.)_",
    ...denialLines(meta.denial, meta),
    ...resumeFooter(meta),
  ];
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

/** Show `file` relative to `cwd` when it lives inside it (agy reports absolute paths). */
export function displayPath(file, cwd) {
  const f = String(file || "");
  if (!f || !cwd) return f;
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const nf = norm(f);
  // agy may report the resolved path (macOS: /var → /private/var), so try both.
  const roots = [String(cwd)];
  try {
    roots.push(realpathSync(String(cwd)));
  } catch {
    // cwd gone or unreadable: compare against it as given
  }
  for (const root of roots) {
    const prefix = `${norm(root)}/`;
    const ci = /^[a-z]:\//i.test(prefix); // Windows paths compare case-insensitively
    const head = nf.slice(0, prefix.length);
    if (ci ? head.toLowerCase() === prefix.toLowerCase() : head === prefix) return nf.slice(prefix.length);
  }
  return f;
}

const VERDICT_LABEL = {
  ship: "✅ ship",
  "ship-with-nits": "🟡 ship with nits",
  "needs-work": "🔴 needs work",
};

/** Structured review (from --json-schema). Findings arrive sorted, most severe first. */
export function renderReview(review, meta = {}) {
  const header = meta.title ? `# 🛰️ Antigravity — ${meta.title}` : "# 🛰️ Antigravity — review";
  const lines = [header, "", `**Verdict: ${VERDICT_LABEL[review.verdict] || review.verdict}**`];
  if (review.summary) lines.push("", review.summary);
  if (review.findings.length) {
    lines.push("", `## Findings (${review.findings.length})`);
    for (const f of review.findings) {
      const file = displayPath(f.file, meta.cwd);
      const loc = file ? ` \`${file}${f.line ? `:${f.line}` : ""}\`` : "";
      lines.push("", `- **[${f.severity}]**${loc} — ${f.title}`);
      if (f.detail) lines.push(`  ${f.detail.replace(/\n/g, "\n  ")}`);
      if (f.fix) {
        if (f.fix.includes("\n")) lines.push("  Fix:", "", "  ```", ...f.fix.split("\n").map((l) => `  ${l}`), "  ```");
        else lines.push(`  Fix: ${f.fix}`);
      }
    }
  } else {
    lines.push("", "No findings.");
  }
  if (review.nextSteps.length) {
    lines.push("", "## Next steps");
    for (const step of review.nextSteps) lines.push(`- ${step}`);
  }
  lines.push(...denialLines(meta.denial, meta), ...resumeFooter(meta));
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

/** agy is too old for a feature the run needs. */
export function renderNeedsUpdate(what) {
  const isReview = what === "review";
  return ensureTrailingNewline(
    [
      `# 🛰️ Antigravity — ${isReview ? "review" : "read-only run"}`,
      "",
      `**Your agy is too old for ${isReview ? "a read-only review" : "`--read-only`"}.** The plugin enforces read-only runs with session deny rules (\`--settings\`), and this agy build doesn't list that flag in \`agy --help\`.`,
      "",
      "Update it, then retry:",
      "",
      "```bash",
      "agy update",
      "```",
      "",
      "Nothing was run: the plugin won't start a \"read-only\" job it can't keep read-only.",
    ].join("\n"),
  );
}

/** Quota / auth / backend error, with concrete next steps. */
export function renderError(error, meta = {}) {
  const lines = [`# 🛰️ Antigravity — ${meta.title || "error"}`, ""];
  if (!error) {
    lines.push("Antigravity returned no output and no recognizable error was found (stdout, stderr or log).");
    if (meta.logFile) lines.push("", `Log: \`${meta.logFile}\``);
    return ensureTrailingNewline(lines.join("\n").trimEnd());
  }

  if (error.kind === "quota") {
    lines.push(`**Antigravity quota is exhausted.** ${error.message}`);
    if (error.resetsIn) lines.push("", `Quota resets in **${error.resetsIn}**.`);
    lines.push(
      "",
      "What to do:",
      "- Wait for the reset, or switch the active Google account used by `agy`.",
      "- Meanwhile, Claude Code can keep handling the task itself.",
    );
  } else if (error.kind === "auth") {
    lines.push("**Antigravity is not authenticated.**");
    lines.push("", "Run this once in your shell to sign in, then retry:", "", "```bash", "agy", "```");
    lines.push("(In Claude Code you can run it inline by typing `! agy`.)");
  } else if (error.kind === "denied") {
    lines.push("**Antigravity produced no answer: a tool action was auto-denied in headless mode.**");
    if (error.message) lines.push("", "```text", error.message, "```");
    lines.push("", denialHint(meta));
  } else if (error.kind === "model") {
    lines.push("**agy rejected the model selection.**", "", "```text", error.message, "```");
    lines.push(
      "",
      "Use a slug from `agy models` (e.g. `gemini-4-hydrogen-low`, `gemini-4-neon-high`). Slugs already encode effort, so drop `--effort` when using one.",
    );
  } else if (error.kind === "timeout") {
    lines.push(`**${error.message}**`, "", "Try `--print-timeout 20m`, or run with `--background`.");
  } else if (error.kind === "cancelled") {
    lines.push("**The job was cancelled.**");
  } else if (error.kind === "spawn") {
    lines.push("**Could not start `agy`.**", "", "```text", error.message, "```");
  } else {
    lines.push("**Antigravity backend error.**", "", "```text", error.message, "```");
  }

  if (meta.partialResponse) {
    lines.push("", "Partial response before the failure:", "", meta.partialResponse.trim());
  }

  if (meta.conversationId) lines.push("", `Conversation: \`${meta.conversationId}\``);
  if (meta.logFile) lines.push(`Log: \`${meta.logFile}\``);
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

export function renderNotInstalled() {
  const lines = [
    "# 🛰️ Antigravity — not installed",
    "",
    "The `agy` binary was not found.",
    "",
    "Install it (official Google installer):",
    "",
    "```bash",
    "# macOS / Linux",
    "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    "# Windows (PowerShell)",
    "irm https://antigravity.google/cli/install.ps1 | iex",
    "```",
    "",
    "Then run `/antigravity:setup` again. If `agy` is installed in a custom path, set",
    "`ANTIGRAVITY_CC_AGY_BIN=/full/path/to/agy`.",
  ];
  return ensureTrailingNewline(lines.join("\n"));
}

export function renderSetup(report) {
  const lines = [
    "# 🛰️ Antigravity — setup",
    "",
    `Status: ${report.ready ? "✅ ready" : "⚠️ needs attention"}`,
    "",
    "Checks:",
    `- agy binary: ${report.binary.detail}`,
    `- version: ${report.version || "unknown"}`,
    `- config dir: ${report.configDir.detail}`,
    `- auth: ${report.auth.detail}`,
    "",
  ];
  if (report.models?.length) {
    lines.push("Models (pass with `--model <slug>`):");
    for (const m of report.models) lines.push(`- \`${m.slug}\` — ${m.name}`);
    lines.push("");
  }
  const gate = report.reviewGate;
  if (gate) {
    let state = gate.enabled ? "on" : "off";
    if (!gate.repo) state = "n/a (not a git repository)";
    else if (gate.enabled && !gate.supported) state = "on, but inactive: this agy lacks `--settings` / `--json-schema` (run `agy update`)";
    lines.push(`Review gate (this repo): ${state}${gate.lastVerdict ? ` · last verdict: ${gate.lastVerdict}` : ""}`);
    lines.push(
      gate.enabled
        ? "- Turn it off with `/antigravity:setup --disable-review-gate`."
        : "- `/antigravity:setup --enable-review-gate` reviews uncommitted changes whenever Claude stops, and sends Claude back on \"needs work\".",
    );
    lines.push("");
  }
  if (report.gateNote) lines.push(report.gateNote, "");
  if (report.nextSteps.length) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) lines.push(`- ${step}`);
  }
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

export function renderBackgroundStarted(job) {
  const lines = [
    `# 🛰️ Antigravity — started in background`,
    "",
    `Job \`${job.id}\` (${job.kind}) is running${job.model ? ` on \`${job.model}\`` : ""}.`,
    job.title ? `Task: ${job.title}` : "",
    "",
    "Check on it:",
    `- \`/antigravity:status ${job.id}\` — progress`,
    `- \`/antigravity:result ${job.id}\` — final output`,
    `- \`/antigravity:cancel ${job.id}\` — stop it`,
  ].filter(Boolean);
  return ensureTrailingNewline(lines.join("\n"));
}

function progressText(progress, cwd) {
  if (!progress) return "";
  const target = progress.target ? ` \`${displayPath(progress.target, cwd)}\`` : "";
  const verb = progress.state === "ACTIVE" ? "now" : "last";
  return `${verb}: ${progress.tool}${target} (${progress.steps} tool step${progress.steps === 1 ? "" : "s"})`;
}

function jobLine(job) {
  const bits = [`\`${job.id}\``, job.status];
  if (job.kind) bits.push(job.kind);
  if (job.title) bits.push(job.title);
  if (job.status === "running" && job.progress) bits.push(progressText(job.progress, job.cwd));
  return `- ${bits.join(" · ")}`;
}

export function renderStatus(jobs) {
  const lines = ["# 🛰️ Antigravity — status", ""];
  const running = jobs.filter((j) => j.status === "running");
  const finished = jobs.filter((j) => j.status !== "running");

  if (running.length) {
    lines.push("Running:");
    for (const j of running) lines.push(jobLine(j));
    lines.push("");
  }
  if (finished.length) {
    lines.push("Recent:");
    for (const j of finished.slice(0, 8)) {
      lines.push(jobLine(j) + (j.conversationId ? ` · conv \`${j.conversationId}\`` : ""));
    }
  }
  if (!running.length && !finished.length) {
    lines.push("No Antigravity jobs recorded for this repository yet.");
  }
  return ensureTrailingNewline(lines.join("\n").trimEnd());
}

export function renderJobStatus(job) {
  const lines = [
    `# 🛰️ Antigravity — job ${job.id}`,
    "",
    `Status: ${job.status}`,
    job.title ? `Task: ${job.title}` : "",
    job.conversationId ? `Conversation: \`${job.conversationId}\`` : "",
    `Started: ${job.startedAt}`,
    job.finishedAt ? `Finished: ${job.finishedAt}` : "",
    job.error ? `Error: ${job.error}` : "",
    job.denial ? `Auto-denied: ${job.denial.actions?.join(", ") || "a tool action"}` : "",
    job.status === "running" && job.progress ? `Progress: ${progressText(job.progress, job.cwd)}` : "",
  ].filter(Boolean);
  if (job.status === "running") {
    lines.push("", `Get the result when done: \`/antigravity:result ${job.id}\``);
  } else {
    lines.push("", `See full output: \`/antigravity:result ${job.id}\``);
  }
  return ensureTrailingNewline(lines.join("\n"));
}

export function renderCancel(result, job) {
  const lines = [`# 🛰️ Antigravity — cancel`, ""];
  if (result.cancelled) lines.push(`Cancelled job \`${job.id}\`.`);
  else lines.push(`Could not cancel \`${job?.id ?? "?"}\`: ${result.reason}.`);
  return ensureTrailingNewline(lines.join("\n"));
}

export { ensureTrailingNewline };
