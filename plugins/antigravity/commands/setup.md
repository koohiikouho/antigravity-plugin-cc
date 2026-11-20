---
description: Check whether the Antigravity CLI (agy) is installed and signed in, and install it if it's missing.
argument-hint: '[--enable-review-gate | --disable-review-gate]'
allowed-tools: Bash(node:*), Bash(curl:*), Bash(bash:*), Bash(powershell:*), AskUserQuestion
---

Detect the state of the Antigravity CLI. Run exactly this:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity.mjs" setup --json $ARGUMENTS
```

Read the JSON: `{ ready, installed, binaryPath, version, authedGuess, configDir, models, reviewGate }`. `models` is the list of slugs from `agy models`; an empty list usually means agy is not signed in. `reviewGate` says whether the stop-time review gate is on for this repository.

`--enable-review-gate` / `--disable-review-gate` turn the stop-time review gate on or off for the current repository; both runs below apply it (it's idempotent). Only pass them when the user asked. When the gate is on and Claude stops with uncommitted changes, Antigravity reviews them read-only and a "needs work" verdict sends Claude back to address the findings. It costs a few minutes and some agy quota per gated turn.

**If `installed` is `false`** — the `agy` binary wasn't found:
- Use `AskUserQuestion` exactly once to offer installing it. Two options, install first:
  - `Install Antigravity CLI (Recommended)`
  - `Skip for now`
- If the user picks install, run the installer for the platform. macOS / Linux:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Windows:

```bash
powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"
```

- Then rerun the detection:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity.mjs" setup --json $ARGUMENTS
```

- If the user picks skip, don't install. Move on to the output step with the original result.

**If `installed` is `true`** — don't ask about installation.

**If `installed` is `true` but `authedGuess` is `false`** — `agy` is here but you're probably not signed in. Sign-in is browser OAuth with your Google account; there's no API key, and this command never authenticates for you. Tell the user to run `agy` once interactively to finish the browser sign-in — in Claude Code, type `! agy` and complete the Google flow, then come back and run `/antigravity:setup` again.

**Final output** — present the human-readable setup by running the same command without `--json`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity.mjs" setup $ARGUMENTS
```

Show that output to the user. If installation was skipped, show the original detection result instead. Don't invent flags or claim a sign-in you didn't verify.
