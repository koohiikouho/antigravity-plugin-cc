# Antigravity CLI (`agy`) — grounded reference

> Verified against `agy` **1.5.9–1.5.13 on Windows 11** (November 2026) and the
> official docs at <https://antigravity.google/docs/cli-overview>. This is the
> contract the plugin is built against. If a future `agy` release changes a flag,
> update this file and `plugins/antigravity/scripts/lib/agy.mjs` together.
>
> The original reference (agy 1.0.3, macOS, May 2026) described a CLI with no
> `--model` flag and only text print mode. Both are out of date.

## What `agy` is

The **Antigravity CLI** (binary: **`agy`**) is the terminal surface of Google
Antigravity. It shares config, auth and the agent core with the Antigravity IDE,
and descends from Gemini CLI: config lives under `~/.gemini/antigravity-cli/`.

## Install

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash      # → ~/.local/bin/agy

# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex             # → %LOCALAPPDATA%\agy\bin\agy.exe
```

## Auth

- First launch performs a silent keyring sign-in, or falls back to a browser
  OAuth flow. There is no API-key env var for the standard tier.
- The plugin never logs you in. Run `agy` once interactively (`! agy`) first.
- `agy models` needs a signed-in CLI but spends no quota, so `/antigravity:setup`
  uses it as its sign-in check.

## Models

`agy models` prints one `slug<TAB>name` pair per line. As of November 2026 it
lists the Gemini 4 family (`gemini-4-hydrogen-*`, `gemini-4-neon-*`,
`gemini-4-argon-*`, each with effort-encoded variants such as `-low` / `-high`),
the Pro orchestrators, `gemini-3.8-flash-*`, and some third-party models. The
list changes often and depends on the account, so **the plugin never hardcodes
or validates model names**. It passes `--model` through and lets `agy` reject
unknown ones.

- `--model <slug>` picks the model for one run. Default comes from the TUI's
  `/model` choice in `settings.json`, or the companion's `ANTIGRAVITY_CC_MODEL`
  env var.
- `--effort low|medium|high|xhigh|max` only works with a **bare** model name
  (`--model gemini-4-hydrogen --effort low`). Combining it with a slug that
  already encodes effort (`gemini-4-hydrogen-low`) is an error.

## Headless invocation (what the plugin runs)

```text
agy [--model M] [--effort E] [--mode MODE] [--sandbox] [--dangerously-skip-permissions]
    [--add-dir DIR]... [--conversation ID] --log-file PATH --print-timeout DUR
    --input-format stream-json --output-format stream-json
```

The prompt is **not** on the command line. It goes to stdin as one NDJSON line:

```json
{"event":"user","message":{"content":"<prompt>"}}
```

This avoids the Windows 32,767-character command-line limit, which the old
`agy -p "<prompt>"` form hit on any review with a sizeable diff (`ENAMETOOLONG`).
A 36K-character prompt was verified over stdin.

stdout is NDJSON:

| Event | Fields the plugin uses |
| --- | --- |
| `init` | `conversation_id` |
| `step_update` | `step_update.step_type == "agent_response"` → `text_delta` |
| `result` | `conversation_id`, `status` (`SUCCESS` / `ERROR`), `response`, `error`, `usage`, `denied_actions[]` (`{action, display_name}`, undocumented) |

### Relevant flags

| Flag | Meaning |
| --- | --- |
| `--print-timeout <dur>` | Go duration. agy's default is `0s` (no limit); the companion passes `10m` and adds a 60s process watchdog. |
| `--dangerously-skip-permissions` | Auto-approve every tool request. **Opt-in only** in the plugin (`--yolo`), never for reviews. |
| `--sandbox` | Terminal sandbox restrictions. Always on for `review` and `--read-only`. |
| `--mode accept-edits\|auto\|plan` | Execution mode. `accept-edits` denies commands headlessly; `auto` may be unavailable for the account; `plan` writes a plan doc instead of acting, so it is unsuitable for reviews. |
| `--add-dir <path>` | Extra workspace directory. Repeatable. |
| `--conversation <id>` | Resume a specific conversation. |
| `-c`, `--continue` | Resume the most recent conversation **globally**, which can be another repo's. The plugin does not use it; it resumes by this repo's last recorded conversation ID instead. |
| `--log-file <path>` | Log path; the plugin keeps it per job for diagnostics. |
| `--settings <json\|path>` | Session-only settings overrides, never saved. Read-only runs pass `{"permissions":{"deny":["write_file(*)","command(*)"]}}`. |

## Runtime behavior (verified live)

1. **Errors exit non-zero.** A bad model or a quota error gives a `result` with
   `status: "ERROR"`, a message on stderr, and exit code 1.
2. **Headless permission denials exit 0 with an empty response.** When a tool
   needs approval that print mode cannot ask for, agy auto-denies it, sets
   `denied_actions`, and prints a notice on stderr such as *"a tool required the
   "command" permission that headless mode cannot prompt for, so it was
   auto-denied"*. The fix is a rule under `permissions.allow` in
   `settings.json`, or `--dangerously-skip-permissions`. The plugin reports this
   as a denial instead of an empty success.
3. In the default mode, simple commands (`echo`, `node`) ran without approval.
   `accept-edits` mode denied them.
4. Quota errors read `RESOURCE_EXHAUSTED (code 429): Individual quota reached.
   ... Resets in <dur>`. The plugin parses the reset window.
5. **`--sandbox` is not read-only.** It only restricts the terminal. With
   `--sandbox` and a "do not modify files" prompt, agy 1.5.13 still created
   files via `write_file`. Session deny rules (`write_file(*)`, `command(*)`)
   blocked both file writes and shell commands while reads still worked. Rule
   syntax is `action(target)`; precedence is Deny > Ask > Allow. Verified on
   1.5.13; older builds may lack `--settings`.
6. Conversations persist as `~/.gemini/antigravity-cli/conversations/<id>.pb`.

## Trust the diff, not the summary

Field notes from the tetobooru project: Antigravity's prose summaries can claim
tests passed or files changed when they did not. After any `delegate` run,
check `git diff` / `git status` and re-run the tests yourself before relying on
what the response says.

## Config layout

```
~/.gemini/antigravity-cli/
  settings.json          # model defaults, permissions.allow, toolPermission, ...
  conversations/<id>.pb  # persisted threads
  log/cli-*.log          # rotating logs
```

## Cross-compatibility

`agy plugin import claude` imports Claude Code plugins into Antigravity, and
`agy plugin install` uses a Claude-Code-compatible marketplace format. This
plugin goes the other way: Claude Code → `agy`.
