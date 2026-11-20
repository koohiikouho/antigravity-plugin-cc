---
description: Cross-model code review of your changes by Antigravity (read-only, contained).
argument-hint: "[--base <ref>] [--background] [--model <slug>] [focus text]"
allowed-tools: Bash(node:*)
---

Get a second pair of eyes on your work. This runs a **read-only** review of your current changes through Antigravity and brings the findings straight back into Claude Code. It runs sandboxed and never auto-approves tools (`--yolo` is ignored here); file writes and shell commands are blocked with session-only deny rules, so it can read your code but not change it.

Run the companion and present its output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity.mjs" review $ARGUMENTS
```

Then show the review verbatim, then add a one-line summary of the most important finding (if any). Use the `antigravity-result-handling` skill to interpret the companion output first — distinguish a real review from a quota/auth/backend error so you never present an empty result as a clean review.

## What the arguments do

- **No `--base`** — reviews your **uncommitted changes** (working tree vs HEAD; in a repo with no commits yet, staged + unstaged changes). This is the default and the common case.
- **`--base <ref>`** — reviews `<ref>...HEAD` instead. Use `--base main` to review the whole branch, `--base HEAD~3` for the last three commits.
- **Trailing focus text** — anything after the flags steers the review. Point the reviewer at what you care about: `security`, `error handling`, `the new retry logic`, `concurrency bugs`.
- **`--model <slug>`** — review with a specific model, e.g. `gemini-4-neon-high`.
- **`--background`** — for large diffs, run it as a job and keep working. You get a job id back; check progress with `/antigravity:status` and pull the finished review with `/antigravity:result`.

## Examples

```
/antigravity:review
/antigravity:review --base main security and input validation
/antigravity:review --background race conditions in the worker pool
```

## Notes

- The review is contained: Antigravity sees the git diff embedded in the prompt and reports back. Large diffs are fine; the prompt goes over stdin, not the command line.
- Antigravity has a usage quota. On exhaustion the companion reports the reset time instead of an empty review.
- First time? You need to be signed in to Antigravity once. Run `/antigravity:setup` to check, and if it reports you're not authed, type `! agy` to do the one-time Google OAuth in your browser.

_Powered by Google Antigravity (`agy`)._
