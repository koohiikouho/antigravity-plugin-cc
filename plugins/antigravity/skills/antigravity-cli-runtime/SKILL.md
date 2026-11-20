---
name: antigravity-cli-runtime
description: Internal helper contract for calling the antigravity companion runtime from Claude Code
user-invocable: false
---

# antigravity-cli-runtime

Internal contract for the `antigravity:antigravity-pair` subagent. Not user-facing. This documents the one helper the subagent calls and the rule it follows.

## Primary helper

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity.mjs" delegate "<task>" [flags]
```

`delegate` hands the task to Google's Antigravity CLI (`agy`) non-interactively. The companion feeds the prompt on stdin (stream-json), so long tasks are fine. It is **write-capable by default**: it can edit files and run commands that agy's own permission rules allow. Tool requests that would need approval are auto-denied in headless mode and reported in the output. Use `--read-only` when the task should not mutate the working tree; `--sandbox` alone does not stop file edits.

## The one rule: thin forwarder

The subagent makes **exactly one** Bash call to `delegate` and returns its stdout **verbatim**.

- Do not inspect the repo, read files, run git, or pre-analyze before forwarding.
- Do not reword, summarize, truncate, or reformat the companion's output.
- Do not chain calls or call any other subcommand.
- Pass the user's task and any caller-supplied flags straight through.

The companion owns binary detection, sandboxing, timeouts, the conversation id, and error handling (quota with its reset window, auth, bad model, headless auto-denials). The subagent's job is to forward and relay.

## Flags on `delegate`

| Flag | Effect |
|------|--------|
| `--background` | Spawn a background job; returns a job id instead of blocking. |
| `--sandbox` | Run with agy's terminal sandbox. Restricts commands only; file edits still happen. |
| `--read-only` | Sandboxed, never auto-approved, and file writes and shell commands are denied. For look-but-don't-touch runs. |
| `--yolo` | Auto-approve every tool (`--dangerously-skip-permissions`). Only when the user explicitly asks; ignored with `--read-only`. |
| `--model <slug>` | Model for this run, e.g. `gemini-4-hydrogen-low`. Only when the user names one. |
| `--effort <level>` | Reasoning effort; only with a bare model name, never with an effort-encoded slug. |
| `--continue`, `-c` | Continue this repo's last Antigravity conversation. |
| `--conversation <id>` | Continue a specific conversation by id. |
| `--add-dir <path>` | Grant access to an extra directory (repeatable). |
| `--print-timeout <go-dur>` | Cap the print-mode run, e.g. `10m`, `90s`. |

## Model selection

`agy` takes `--model <slug>`; `agy models` (or `/antigravity:setup`) lists the slugs for the account. Without `--model`, agy uses the `ANTIGRAVITY_CC_MODEL` env var if set, else the default chosen with `/model` in the `agy` TUI. Only pass `--model` when the user names a model; do not invent slugs.

## Other subcommands (not for this subagent)

The companion also exposes `review`, `resume`, `status`, `result`, and `cancel`. The `antigravity:antigravity-pair` subagent **only** calls `delegate`. The others are driven by their own slash commands, not from here.
