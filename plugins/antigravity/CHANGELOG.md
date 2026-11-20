# Changelog

All notable changes to the `antigravity` plugin are documented here.

## [0.2.0] — Unreleased

Updated for agy 1.5.x and Windows.

### Changed
- The prompt goes to agy over stdin (`--input-format stream-json`) instead of argv. Large review diffs no longer fail with `ENAMETOOLONG` on Windows.
- Output is parsed from agy's stream-json `result` event instead of scraping the log file.
- `delegate` no longer passes `--dangerously-skip-permissions` by default. Use `--yolo` to opt in; `review` never uses it.
- `resume` continues this repo's last recorded conversation instead of agy's global `--continue`, which could pick up another repo's thread.
- `review` with no `--base` no longer duplicates staged changes, and works in a repo with no commits.
- `review` and `--read-only` refuse to run, with an `agy update` hint, when `agy --help` doesn't list `--settings`. Before, they could run without the deny rules.
- Read-only runs keep your own agy permission rules. `--settings` replaces the `permissions` in agy's `settings.json`, so the plugin now copies them in and adds its deny rules on top.
- The `gemini-3-prompting` skill is now `gemini-prompting`.
- The README banner image was removed.

### Fixed
- `review` and `delegate --read-only` are now actually read-only. `--sandbox` only restricts the terminal and agy still wrote files; these runs now pass session deny rules for `write_file(*)` and `command(*)`.

### Added
- `--model <slug>` and `--effort <level>` passthrough on `delegate`, `review` and `resume`; `ANTIGRAVITY_CC_MODEL` sets a default. `/antigravity:setup` lists available models.
- Headless auto-denials (exit 0, empty answer, `denied_actions`) are reported instead of returned as an empty success.
- Model-rejection errors point at `agy models`.
- A process watchdog on top of `--print-timeout`, with process-tree kill on Windows.
- Windows fixes: `.mjs` overrides run through node, and the test suite passes on Windows.
- Structured reviews: `review` passes `--json-schema` and renders a verdict plus findings sorted by severity, with paths relative to the repo. Falls back to prose on an agy without the flag.
- Optional stop-time review gate (`/antigravity:setup --enable-review-gate`): a `Stop` hook reviews uncommitted changes and sends Claude back on "needs work". Off by default, per repo, fails open.
- `status` shows the latest tool step of running background jobs.
- `npm run smoke`: a live end-to-end check against the real agy (opt-in, uses `gemini-4-hydrogen-low`).
- CI runs the tests on Windows and macOS as well as Linux, and validates `hooks/hooks.json`.

### Grounded against
- `agy` 1.5.9–1.5.13, Windows 11, November 2026. Read-only enforcement (`--settings` deny rules) was verified on 1.5.13.

## [0.1.0] — 2026-05-31

Initial release.

### Added
- `/antigravity:setup` — detect the `agy` binary, version, and auth state; offer to install if missing.
- `/antigravity:delegate` — hand a task to Antigravity (Gemini) via the `antigravity-pair` subagent; foreground or `--background`.
- `/antigravity:review` — get a read-only, cross-model code review of your current diff (or a branch via `--base <ref>`).
- `/antigravity:resume` — continue the most recent Antigravity conversation, or a specific one with `--conversation <id>`.
- `/antigravity:status`, `/antigravity:result`, `/antigravity:cancel` — manage background jobs.
- `antigravity-pair` subagent for delegation.
- Skills: `antigravity-cli-runtime`, `antigravity-result-handling`, `gemini-3-prompting`.
- Node companion runtime (`scripts/antigravity.mjs`) driving `agy --print` with robust log scanning:
  recovers the conversation ID and surfaces quota/auth/backend errors that `agy` hides behind exit code 0.

### Grounded against
- `agy` 1.0.3 (Antigravity CLI), macOS, May 2026.
