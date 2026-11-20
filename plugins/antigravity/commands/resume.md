---
description: Continue this repo's most recent Antigravity conversation with a follow-up.
argument-hint: "[--conversation <id>] [--background] [follow-up instruction]"
allowed-tools: Bash(node:*)
---

Push a follow-up to the most recent Antigravity conversation started from this repository (or a specific one with `--conversation <id>`). Handy right after a `/antigravity:delegate` or `/antigravity:review` when you want to keep the same thread instead of starting fresh. Conversations from other repos are never picked up; if this repo has none yet, the companion says so.

Run exactly this and show the output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity.mjs" resume $ARGUMENTS
```

Present the companion's stdout as-is. Do not summarize, reformat, or add commentary. Use the `antigravity-result-handling` skill to interpret the output (response vs quota/auth/backend error) before acting on it. If a `--background` job was started, the output includes the job id — point the user at `/antigravity:status` and `/antigravity:result` to follow it.
