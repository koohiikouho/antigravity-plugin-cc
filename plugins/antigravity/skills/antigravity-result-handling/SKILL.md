---
name: antigravity-result-handling
description: "How to interpret Antigravity companion output — successful responses, auto-denials, quota/auth/model/backend errors, and applying file changes"
user-invocable: false
---

# Reading Antigravity companion output

- **`delegate` writes by default.** Unless it ran with `--read-only` or `--sandbox`, files may already be changed. Check `git diff` / `git status` and describe what actually changed. Re-run tests yourself; Antigravity has claimed passes that didn't happen. A `--read-only` run changed nothing: say so.
- **Lead with Antigravity's answer**, then your checks. Surface the conversation id footer when the work isn't finished.

| Signal in output | What you do |
|---|---|
| Answer text | Relay it; verify any file edits with `git diff`. |
| `**Verdict: …**` + `## Findings` | Relay as is, name the top finding. Check `critical`/`high` findings against the code before acting. Prose instead means an older agy; treat it as a normal answer. |
| `Antigravity review gate: verdict "needs work"` | Check each finding against the code, fix the real ones, tell the user which you skipped and why. |
| `Your agy is too old for …` | Nothing ran. Tell them to `agy update`. Don't re-run without `--read-only` unless the user agrees the run may write files. |
| `Headless mode auto-denied: …` | Say what was denied; the answer may be incomplete. For `delegate`: a `permissions.allow` rule in `~/.gemini/antigravity-cli/settings.json`, or `--yolo` in a trusted repo; never add `--yolo` yourself. For `review` / `--read-only`, denials of writes and commands are the plugin's own rules: suggest `/antigravity:delegate` if the task needs them. |
| `RESOURCE_EXHAUSTED (429) … Resets in <dur>` | Quote the reset window. Options: wait, another `--model`, or another Google account (`! agy`). Don't retry in a loop; offer to keep working yourself. |
| Auth error / never signed in | Tell them to type `! agy` once and finish the browser sign-in, then re-run. Never try to sign in for them or ask for credentials. |
| `agy rejected the model selection` | Point at `/antigravity:setup` or `agy models`. Don't guess a model. |
| Backend error / timeout | Show the error as is. For timeouts: a higher `--print-timeout` (e.g. `20m`) or `--background`, then `/antigravity:status` and `/antigravity:result`. |
| Conversation id footer | `/antigravity:resume <follow-up>` (or `--conversation <id>`) continues it; `agy --conversation <id>` opens it in the TUI. |
