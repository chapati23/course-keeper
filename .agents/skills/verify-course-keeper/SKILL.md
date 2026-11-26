---
name: verify-course-keeper
description: "Drive the Course Keeper plugin in an isolated Claude Code session with scripted model replies, in the terminal and through a stand-in for the Claude desktop app. Use it to prove a change to the /course-keeper command, the alert row or desktop card and their buttons, standing instructions or the learn step, and to capture evidence."
---

# Verify Course Keeper

Course Keeper is a Claude Code plugin. A person meets it in three places: the `/course-keeper` command, the alert above the prompt, and a short notice when it notes a standing instruction. This skill starts a real Claude Code session that loads the plugin from this checkout, drives it as a person does, and saves evidence.

All paths are relative to the checkout root. `control` means `.agents/skills/verify-course-keeper/control`.

Two surfaces:

| Surface | What a run is | What a pass covers |
| --- | --- | --- |
| Terminal (default) | Claude Code in a private tmux server. The harness types and reads the screen. | What a person sees and does in the terminal. |
| Desktop (`--surface desktop`) | A stand-in: the desktop app's own pinned Claude Code, with the harness in the app's role over the app's protocol. The desktop app does not start. | The card and the messages that this Claude Code returns for the desktop surface. Not what the app paints. |

VS Code, Remote Control and Slack are not driven.

## Launch

Requirements: Python 3 and Claude Code 2.1.323 or later. A terminal run also needs tmux. A desktop run needs the Claude Code build that the desktop app downloads on first use of its Code tab. Claude Code loads the TypeScript hooks directly. There is no build, no database and no seed step.

The fastest proof is a journey. A journey starts its runs, runs the doctor, drives one feature, asserts, saves evidence and always stops:

```sh
CLAUDE_BIN=/absolute/path/to/claude .agents/skills/verify-course-keeper/journeys/alerts
.agents/skills/verify-course-keeper/journeys/desktop
```

The last line is `PASS <evidence directory>`, or the journey exits non-zero and prints `FAIL`, the promise that broke, what it expected, what it saw, and the evidence directory. The journeys are `session`, `alerts`, `instructions`, `learn` (terminal) and `desktop`; [the feature map](features/README.md) says what each one proves.

To drive by hand, start a run and keep the two paths that it prints:

```sh
.agents/skills/verify-course-keeper/control start
.agents/skills/verify-course-keeper/control start --surface desktop
```

Line 1 is the run directory (`RUN` below). Line 2 is the evidence directory. A shell variable does not survive between separate tool calls; pass the run directory as a literal path. `start` returns exit 0 only when the session is usable: a terminal run accepted the workspace trust prompt for its own fixture and shows a prompt; a desktop run answered `initialize`. Then run the doctor.

What a run owns:

- a private `HOME` and `CLAUDE_CONFIG_DIR`, with a synthetic API key;
- a fixture project with a two-invariant `VISION.md` (`--vision FILE` replaces it, `--no-vision` leaves it out, `--anti-patterns FILE` adds `ANTI-PATTERNS.md`);
- a model endpoint on a loopback port that serves scripted replies and logs every request;
- a terminal run: a private tmux server on its own socket (150 by 42), with Claude Code started as `--plugin-dir <this checkout> --setting-sources "" --strict-mcp-config --tools ""`;
- a desktop run: a host process that starts the app's Claude Code in its stream-json mode, with the plugin loaded from this checkout.

Runs can run at the same time. Never drive a session that `control start` did not start. Every command refuses a directory that is not a run directory. Never start, quit or script the desktop app for a desktop run: the stand-in does not need it.

Traps at launch:

- **Launcher shims (terminal).** If `claude` on `PATH` is a wrapper (cmux installs one), set `CLAUDE_BIN` to the native executable, for example `~/.local/bin/claude`.
- **Sandboxed shells (terminal).** tmux needs a Unix socket. In a shell that forbids it, `start` says so and stops. Run terminal runs and journeys outside that sandbox. Desktop runs work inside it.
- **Which Claude Code (desktop).** `start --surface desktop` uses `--cli PATH`, else `CLAUDE_DESKTOP_BIN`, else the newest build the app verified under `~/Library/Application Support/Claude/claude-code/`. It never falls back to the terminal's Claude Code. The app's version can differ from the terminal's.

## Doctor

```sh
.agents/skills/verify-course-keeper/control doctor "$RUN"
```

It prints one line per check and exits 0 only when all hold.

Terminal run:

- `tmux`: the server on the run's socket is alive and its pane still runs the Claude process that `start` launched;
- `version`: Claude Code is 2.1.323 or later;
- `endpoint`: the loopback port answers with this run's token, so the port is ours;
- `plugin`: `/course-keeper` shows `VISION.md: <run>/scratch/project/VISION.md`, so the hooks loaded from this checkout.

Desktop run: `host` (the host and the Claude Code it started are alive), `version` (the number, and whether this is the app's pinned build), `endpoint`, `initialize` (the `course-keeper` command and the plugin UI capability are present), `surfaces` (`["desktop"]`, or "not attached yet" after `--attach-later`), and `plugin`.

A welcome screen alone does not show that the hooks loaded. The doctor changes no plugin state, but it enters `/course-keeper`, so that command is in the conversation afterwards. Run the doctor first whenever a step behaves oddly.

## Drive

Type what a person types, script what the model answers, and read the result. Use [the feature map](features/README.md) for the recipe of each feature.

| Command | What it does |
| --- | --- |
| `control send RUN TEXT` | Enters `TEXT` as a person does: typed at the terminal prompt, or sent in the app's message format on a desktop run. Returns when the session took it. |
| `control press RUN <button>` | Presses one drawn button of the alert and prints its label. Terminal: the hotkey `1` to `4` or a part of the label. Desktop: a part of the label, or `dismiss` for the ✕. Exits 1 and lists the drawn buttons when there is no such button. |
| `control wait RUN TEXT [--after MARK] [--visible] [--gone] [--timeout S] [--save LABEL]` | Polls the screen for `TEXT`. `--after` matches only after the last `MARK`, and fails when `MARK` never appears. `--visible` (terminal) reads the visible pane only; `--row` (desktop) reads the alert only. |
| `control screen RUN [--visible \| --row] [--tree] [--save LABEL]` | Prints what the person is shown. On a desktop run this is the harness's text of the transcript and of the card; `--tree` prints the raw card. |
| `control reply RUN --when SUBSTRING (--text T \| --file F) [--model M] [--unless S] [--times N] [--delay S]` | Adds a scripted reply for model requests whose last user message holds `SUBSTRING`. Prints `rule N`. |
| `control requests RUN [--unscripted] [--save LABEL]` | Lists the model requests the endpoint received and the rule that answered each. `--unscripted` lists only requests that no rule matched, and requests to a path the endpoint does not know, and exits 1 when there is one. It also exits 1 when it cannot read the request log. |
| `control store RUN [--save LABEL]` | Prints the plugin's stored record for the session. |
| `control keys RUN KEY...`, `control focus RUN` | Terminal only: send tmux key names; give the row the keyboard. |
| `control attach RUN`, `control messages RUN [--type T]` | Desktop only: attach the desktop surface after `--attach-later`; list the messages the session sent to the app, such as `ui_toast` and `ui_notify`. |

Stable handles:

- Commands: `/course-keeper`, `/course-keeper check`, `/course-keeper off`, `/course-keeper on`, `/course-keeper forget <n>`, `/course-keeper learn`, `/course-keeper learn <words>`, `/course-keeper learn yes`, `/course-keeper learn cancel`.
- Terminal row buttons: `1: Tell the agent`, `2: Details`, `3: False alarm` (then `3: Confirm false alarm`), `4: Dismiss`.
- Desktop card buttons: `Tell the agent`, `Details` (then `Hide details`), `False alarm` (then `Confirm false alarm`), and the ✕.
- A command answer starts with `course-keeper:` under the echo `❯ /course-keeper …`. An agent answer starts with `⏺`.

How to script the model. The plugin's own requests carry stable text in the last user message:

| Request | Model | `--when` marker | Reply format |
| --- | --- | --- | --- |
| Main turn | session model, streaming | the person's prompt; add `--unless "Decide whether it states a standing instruction"` | the agent's answer |
| Standing-instruction call | `haiku`, not streaming | `Decide whether it states a standing instruction` | `none`, or lines that start with `- ` (`prompts/extract.md`) |
| Check | session model, streaming | `<final_answer>` with the agent's answer; the prompt also holds `# The check` | `verdict: none`, or the deviation form at the end of `prompts/check.md` |
| Learn draft | session model, streaming | `# Learn from a catch` | the forms at the end of `prompts/learn.md` |
| Learn excerpt check | session model, not streaming | `This is a check that the Course Keeper plugin runs on a coding session` | as for a check |

The first rule that matches wins. A request that matches no rule gets `OK.`; the plugin then records a malformed reply. A typed prompt of 12 or more characters starts three requests: the main turn, the `haiku` call and, when the turn ends, the check. Script all three.

The repository also has unit tests on a simulated engine: `claude plugin test .` from the checkout root. They are faster and cover branches that no person can reach, but they do not start Claude Code.

## Evidence

Everything lands in the evidence directory, `<system temp>/ckv-<8 hex>/evidence`:

- `actions.log`: every `start`, `send`, `press`, `reply` and `stop`, with times and the run's pids and port;
- `model-requests.jsonl`: every request the endpoint received, with its full body, the rule that answered and the last user message; no headers, so no key;
- screens saved with `--save`, and `launch.txt`, `doctor.txt`, `final-screen.txt`, `model-requests.txt`;
- store snapshots saved with `control store --save`;
- `run-marker.json`, which marks the directory as a run of this harness;
- `vision.md`, the seed of the fixture's vision file;
- a desktop run: `frames.jsonl` (every message between the host and Claude Code, both directions), `spawn.json` (the arguments and environment of the Claude Code process) and `cli-debug.log`.

Proof standards:

- Drive the person's path: typed prompts, slash commands and button presses. Do not write the store, call plugin functions or use a test-only path.
- Capture the action and the resulting state, not only the last screen.
- Pair each visible result with a second observation of its side effect: `control store`, the request log, or the fixture's files.
- The only mock is the scripted model reply. The model API is a boundary that already isolates an external system.
- State the limit in every report: a scripted reply proves how Course Keeper handles a reply. It does not prove that a model detects a deviation, notes an instruction or drafts a good sentence.
- For a desktop run, state the second limit too: the run is a stand-in. It proves what the app's Claude Code returns for the desktop surface. It does not prove the app's painting, its notifications or its keyboard handling. [Alerts in the desktop app](features/desktop.md) lists what the stand-in sets up that the app does not.
- End each proof with `control requests RUN --unscripted`. A request that got the default reply means the script, not the plugin, decided the outcome.
- Where the feature promises to write nothing, compare the fixture's `VISION.md` with `vision.md` and list the project directory.

Evidence holds absolute paths of this machine and the full body of every model request. Check it before you post it outside the machine.

What the harness does not observe: network traffic of Claude Code to hosts other than its own endpoint, notification banners, mouse clicks, and anything inside the desktop app.

Two proofs need a real session and are outside the journeys. Both cost model usage and need the person's approval:

- Whether a real model detects a deviation: a session against a real model in a disposable project with a dedicated verification profile.
- How the desktop app paints the card: the real-app steps in [Alerts in the desktop app](features/desktop.md). They change the person's plugin install.

## Cleanup

```sh
.agents/skills/verify-course-keeper/control stop "$RUN"
```

`stop` saves the final screen and the request listing, stops the session it started (the tmux server through its own socket, or the host and its Claude Code), stops the endpoint through an authenticated request to its own port, and removes `scratch/`. It never kills by process name, and it signals a recorded pid only while that pid is still the process that `start` recorded. It keeps the evidence directory and prints its path. A second `stop` is harmless. Run `stop` after every failed attempt too.

When a process of the run is still alive after that, `stop` exits 1, names the process and keeps `scratch/`, so that a later `stop` can try again. A journey then fails with `cleanup: every process of the run stopped`.

Every run stops itself when its time to live ends (`--ttl MINUTES`, 30 by default). The time counts from `start`, not from the last action, so a run in use stops too. The run then does the same teardown as `stop` and writes `ttl-expired.txt`. For a longer hand-driven session, start with a larger `--ttl`.

Evidence directories accumulate under the system temp directory as `ckv-*`. Copy what a report cites to a lasting place. Delete old ones by hand.

## Helpers

- `control`: the session controller for both surfaces. `control --help` prints every command and a block of notes.
- `desktop_host.py`: the host that a desktop run uses. `control` starts it; do not run it by hand.
- `journeys/session`, `journeys/alerts`, `journeys/instructions`, `journeys/learn`, `journeys/desktop`: one executable proof per feature. Each prints `step <name>` lines and ends with `PASS <evidence directory>`. `journeys/desktop --cli PATH` runs the desktop proof on another Claude Code build.
- `journeys/lib.py`: shared code for the journeys. Read it before you write a new journey; a journey calls `control` as subprocesses, as an agent does.
