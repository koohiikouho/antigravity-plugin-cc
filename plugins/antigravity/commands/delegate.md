---
description: Hand a task to Antigravity (Gemini) and get the result back inside Claude Code.
argument-hint: "[--background|--wait] [--sandbox|--read-only] [--continue] [--conversation <id>] [--model <slug>] [--effort <level>] [--yolo] [--add-dir <path>] [what Antigravity should build, investigate, or fix]"
allowed-tools: AskUserQuestion, Agent
---

Hand the user's task to Antigravity via the `antigravity:antigravity-pair` subagent, and show them exactly what came back.

The user's full request is:

$ARGUMENTS

## What to do

1. **If the request has no actual task** (empty, or only execution flags like `--background`/`--wait`/`--sandbox` with nothing to do), ask what Antigravity should work on with `AskUserQuestion`, then continue. Don't guess a task.

2. **Read the execution flags, then strip them from the task text.** `--background` and `--wait` control how *you* run the subagent — they are not part of the natural-language task and must NOT be forwarded as task text:
   - `--background` → invoke the subagent in the **background**.
   - `--wait` or neither flag → invoke the subagent in the **foreground** (default). `--wait` is just the explicit name for the default; it's a Claude-side hint and `agy` never sees it.
   Everything else — the task description plus companion flags `--sandbox`, `--read-only`, `--continue`, `--conversation <id>`, `--model <slug>`, `--effort <level>`, `--yolo`, `--add-dir <path>` — is forwarded to the subagent verbatim as its prompt.

3. **Invoke the `antigravity:antigravity-pair` subagent inline via the Agent tool** (`subagent_type: "antigravity:antigravity-pair"`), passing the cleaned request as the prompt. Run this command inline — do not call it as a Skill — so the Agent tool stays in scope. The subagent makes a single `delegate` call to the companion and returns its stdout.

4. **Return the subagent's stdout verbatim as your final response.** No summary, no paraphrase, no reformatting — the companion's output is the answer.

## Things to surface to the user (only when relevant)

- `delegate` is **write-capable by default**: Antigravity can edit files and run whatever agy's permission rules allow. Anything that needs approval is auto-denied in headless mode and reported. For a look-but-don't-touch run, point out `--read-only`: it blocks file writes and shell commands. `--sandbox` alone only restricts the terminal and does not stop file edits.
- `--yolo` auto-approves every tool (`--dangerously-skip-permissions`). It is off by default; only mention it when a run was auto-denied, and only in a repo the user trusts.
- `--model <slug>` picks the model (list them with `/antigravity:setup` or `agy models`). Pass `--effort` only with a bare model name, not an effort-encoded slug like `gemini-4-hydrogen-low`.
- A follow-up like "continue", "resume", or "keep going" on the same thread can pass `--continue` (or `--conversation <id>` to target a specific conversation).
- If the companion reports that `agy` is missing or you're not signed in, tell the user to run `/antigravity:setup` first.
- Once the output is back, use the `antigravity-result-handling` skill to interpret it — if Antigravity edited files, verify the changes with `git diff` and re-run any tests it claims pass; if it returned a quota, auth, model or auto-denial error, relay it clearly instead of treating the result as success.

