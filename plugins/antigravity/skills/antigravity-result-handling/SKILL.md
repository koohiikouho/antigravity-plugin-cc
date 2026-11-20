---
name: antigravity-result-handling
description: "How to interpret Antigravity companion output — successful responses, auto-denials, quota/auth/model/backend errors, and applying file changes"
user-invocable: false
---

# Reading Antigravity companion output

The companion (`scripts/antigravity.mjs`) wraps the `agy` binary and returns Markdown on stdout. Your job is to read that output and turn it into something useful for the developer. This is what to do for each case.

Two things to remember before anything else:

- **`delegate` is write-capable.** Unless the call used `--read-only` or `--sandbox`, Antigravity may have already edited files or run commands in the repo. Changes can be on disk right now. Verify with `git diff` / `git status` before you describe or trust them. Antigravity's summaries have claimed tests passed or files changed when they had not, so re-run the tests yourself before reporting them green.
- **Every finished response carries a conversation id footer.** That id is what enables `/antigravity:resume` and the raw `agy --conversation <id>`. Always surface it when present.

---

## Case 1 — Normal response

The common case: Antigravity answered.

1. **Lead with Antigravity's answer.** Put the substance first. Don't bury it under your own preamble or restate the contract. The developer asked Antigravity a question — give them the answer.
2. **If it touched files, verify before you summarize.** Run `git diff` (or `git status` for new/deleted files) and describe what actually changed, not what the output claims changed. If the diff is large, summarize by file and intent. If a change looks wrong or risky, say so plainly and point at the exact hunk.
3. **If it ran commands**, note what ran and the outcome.
4. **Surface the conversation id footer.** Tell the developer they can continue this thread with `/antigravity:resume` (or `agy --conversation <id>` directly). This matters most when the task is half-done or worth iterating on.

If `delegate` ran with `--read-only` or `--sandbox`, there are no on-disk changes to verify — the response is advisory only. Say that, so the developer knows nothing was applied.

### Structured reviews

`/antigravity:review` usually prints `**Verdict: …**` (ship / ship with nits / needs work), a summary, then `## Findings` most severe first as `**[severity]** \`file:line\` — title`, each with detail and often `Fix:`. Relay it as is, then name the most important finding. The verdict is Antigravity's opinion: check a `critical`/`high` finding against the code before you act on it. A prose review instead of this shape means agy lacks `--json-schema` or returned a bad shape; treat it like any other answer.

### "Your agy is too old"

`review` and `--read-only` need agy's `--settings` flag to stay read-only. Without it the companion refuses and prints an `agy update` step. Nothing ran. Tell the user to run `agy update`, then retry. Don't re-run without `--read-only` to get around it unless the user agrees that the run may write files.

### Review gate blocks

When the stop-time review gate is on (`/antigravity:setup --enable-review-gate`), a Stop hook can send you back with `Antigravity review gate: verdict "needs work"` and a findings list. Treat it like a review the user asked for: check each finding against the code, fix the real ones, and tell the user which you skipped and why. The hook does not run again while you are continuing from it, and the same diff is not reviewed twice.

---

## Case 1b — Headless auto-denial

In print mode agy cannot ask for permission, so a tool request that needs approval is **auto-denied**. The companion shows `⚠️ Headless mode auto-denied: <action>` under the answer, or reports that no answer was produced.

- Tell the developer which action was denied and that the answer may be incomplete.
- For `delegate`, the fixes are an allow rule under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, or re-running with `--yolo` (auto-approves every tool; only in a trusted repo). Don't add `--yolo` yourself.
- For `review` / `--read-only` runs, denials are expected. The plugin itself adds deny rules for file writes and commands, which agy reports as a "user-configured deny rule". Don't send the user to their own `settings.json` for these; suggest `/antigravity:delegate` without `--read-only` if the task really needs to change files or run commands.

---

## Case 2 — Quota exhausted (RESOURCE_EXHAUSTED / 429)

On quota exhaustion `agy` returns an error result. The companion surfaces it with the reset window, like:

```
RESOURCE_EXHAUSTED (429) ... Resets in <dur>
```

When you see this:

- Tell the developer their Antigravity quota is exhausted, and quote the reset window (`Resets in <dur>`).
- Offer the realistic options: **wait** for the reset, try a different model with `--model` (quotas can differ per model), or **switch to another Google account** and re-auth (`! agy`).
- Make clear **Claude can keep working in the meantime** — the quota limit is on Antigravity/Gemini, not on you. Don't stall the developer waiting on a second model.


---

## Case 3 — Not authenticated

Auth is Google OAuth via keyring/browser — there's no key the plugin can set, and the plugin never logs anyone in. If the output indicates the user has never signed in (or `setup` reported `authedGuess: false` and a call produced an auth error):

- Tell the developer to run **`agy` once interactively**. Inside Claude Code that means typing **`! agy`** to drop into the Antigravity TUI, completing the browser sign-in, then exiting.
- After that, `delegate` / `review` / `resume` will work headlessly. Re-run the original command.

Don't try to authenticate for them and don't ask for credentials.

---

## Case 4 — Model rejected

If agy rejects `--model` (unknown slug, or `--effort` combined with an effort-encoded slug), relay the message and point at `/antigravity:setup` or `agy models` for valid slugs. Don't guess a replacement model.

---

## Case 5 — Backend or timeout error

Other failures — backend errors, network issues, or a print run that hit `--print-timeout` before finishing — should be surfaced verbatim, not swallowed.

- Show the error the companion reported.
- If it timed out, suggest a longer budget: re-run with **`--print-timeout`** set higher (Go duration, e.g. `10m`, `20m`), or run it **`--background`** and pick the result up later with `/antigravity:status` and `/antigravity:result`.
- If a conversation id is present in the output, mention that `/antigravity:resume` can pick the thread back up rather than starting over.

---

## The conversation id footer

When the companion can recover a conversation id (from agy's stream-json output), it prints it in a footer. Treat it as the thread handle:

- `/antigravity:resume <follow-up>` continues this repo's most recent conversation, or a specific one with `--conversation <id>`.
- `agy --conversation <id>` opens the same thread directly in the TUI.

Pass the id along whenever the work isn't obviously finished — it's the cheapest way for the developer to keep going with the same context.

---

## Quick reference

| Signal in output | What it means | What you do |
|---|---|---|
| Answer text + (maybe) diff | Normal response | Lead with the answer; `git diff` to verify any file edits; surface conversation id |
| `**Verdict: …**` + `## Findings` | Structured review | Relay; verify high-severity findings against the code |
| `Your agy is too old for …` | No `--settings`, nothing ran | Tell them to `agy update` |
| `Headless mode auto-denied: ...` | A tool needed approval | Say what was denied; suggest `permissions.allow` or `--yolo` (delegate only) |
| `RESOURCE_EXHAUSTED (429) ... Resets in <dur>` | Quota gone | Report reset window; suggest wait, another model or account; note Claude can continue |
| `agy rejected the model selection` | Bad `--model` / `--effort` | Point at `agy models`; don't guess |
| Auth error / never signed in | Not logged into Google | Tell them to run `! agy` once, then re-run |
| Backend error / timeout | Run failed or ran out of time | Surface verbatim; suggest higher `--print-timeout` or `--background` |
| Conversation id footer | Thread handle | Offer `/antigravity:resume` or `agy --conversation <id>` |

Always remember `delegate` writes by default — when in doubt, check `git diff`.
