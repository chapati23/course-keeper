---
name: verify-course-keeper
description: "Drive the Course Keeper plugin in an isolated Claude Code terminal to verify session controls, inspect an alert, or check standing instructions and learn drafts."
---

# Verify Course Keeper

## Launch

From the checkout root, run the session proof. It needs Python 3, tmux, and Claude Code 2.1.323 or later. Claude Code loads the TypeScript hooks directly. No build or database setup is required.

```sh
TMPDIR=/tmp .agents/skills/verify-course-keeper/session-proof
```

Set `CLAUDE_BIN` to the absolute path of the native Claude executable if your shell uses a launcher shim. The helper creates a private tmux server, home, profile, synthetic API key and project with one invariant. It loads this checkout through `--plugin-dir`. Each run owns a separate socket and model endpoint. The helper accepts the fresh workspace trust prompt only for its own fixture. Its first slash-command response establishes readiness.

For a model-backed journey, use a separate disposable project with the same vision and a dedicated authenticated verification profile. These journeys incur model charges. Use them only within an approved evaluation scope. With the checkout root in `repo` and the absolute paths of the dedicated profile and fixture in `profile` and `project`, start a fresh interactive terminal:

```sh
(cd "$project" && CLAUDE_CONFIG_DIR="$profile" claude --plugin-dir "$repo" --strict-mcp-config --tools '')
```

Drive only a session started for this run. The plugin needs a person-origin prompt for automatic checks. Headless print mode and SDK sessions skip that path.

## Doctor

Enter `/course-keeper`. Require the exact fixture path after `VISION.md:`, the expected session switch, and the standing-instruction and alert lists. The automated proof saves this read-only response as `doctor.txt`. A Claude welcome screen alone does not establish that the hooks loaded.

## Drive

Use [the feature map](features/README.md). Enter slash commands literally at the Claude prompt. Read the new response before the next action. For model-backed work, capture each action and response from the dedicated terminal. The repository also provides `claude plugin test .` for deterministic hook tests using a simulated engine.

## Evidence

The helper prints the absolute evidence directory before launch. It saves the command screens, status after each switch, both store snapshots, and POST paths observed at the isolated model endpoint. A passing switch run requires an empty POST list and the original vision text. Host startup can still fetch marketplace data. For a manual journey, capture the action, its visible result and a second observation of its side effect. Keep artifacts outside the disposable profile. Use synthetic conversations. A simulated model reply can test alert handling but cannot prove that the model detects a deviation.

## Cleanup

The helper closes its own tmux server and loopback listener and removes its scratch directory on success or failure. Evidence stays in the printed directory under `TMPDIR`; copy it elsewhere for long-term retention. For a manual run, enter `/exit`, confirm the session ended, and remove only the disposable profile and project created for that run.

## Helpers

`session-proof` executes launch, doctor, both session switches, evidence capture and cleanup. Exit zero and a final `PASS` identify a completed run. A timeout leaves the last screen in the evidence directory.
