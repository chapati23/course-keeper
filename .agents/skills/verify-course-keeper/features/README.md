# Course Keeper verification map

This directory is the maintained source for verifying what a person can do with Course Keeper. Read this index, then use the matching feature file as the recipe. `control` means `.agents/skills/verify-course-keeper/control`; [the skill](../SKILL.md) explains launch, doctor, evidence and cleanup.

## Baseline preconditions

- Start a run with `control start` (terminal) or `control start --surface desktop` (the desktop stand-in). It prints the run directory (`RUN`) and the evidence directory.
- `control doctor "$RUN"` exits 0 with every line `ok`.
- The fixture project holds this vision, and no `ANTI-PATTERNS.md`:
  1. **One module computes every amount.** No other code rounds money.
  2. **The tool never sends an invoice.** It writes files; the person sends them.
- Never drive a session that `control start` did not start.

## Driving conventions

- Start every recipe from a fresh run unless its preconditions say otherwise.
- Enter commands and prompts with `control send`. Treat each one as literal.
- Script every model request before the action that causes it. A typed prompt of 12 or more characters causes a main turn, a `haiku` call and a check.
- Wait on text, on the store or on the request log. Do not sleep.
- After `control send`, match answers with `--after` the newest echo, for example `--after "❯ /course-keeper off"`.
- Terminal: read the alert row with `--visible`. Claude Code clears the scrollback when the row appears.
- Desktop: read the card with `--row`, and with `control screen RUN --tree` when a detail matters.
- Press a button with `control press RUN <button>`: a digit `1` to `4` in the terminal, a part of the label or `dismiss` on a desktop run.

## Proof and skip reporting

- Capture the action and the resulting state, not only the last screen.
- Pair each visible result with a second observation: `control store`, `model-requests.jsonl`, or the fixture's files.
- End with `control requests "$RUN" --unscripted`; it must exit 0.
- Record the sub-feature ID and the entry point with every artifact.
- A scripted reply proves how Course Keeper handles a reply. It does not prove what a model would answer. Say so in the report.
- Report a path you could not reach with the command you tried and the precondition that was missing. Do not report a skipped entry point as verified through another one.
- A desktop run is a stand-in around the desktop app's own Claude Code. Report a desktop pass as "the stand-in", and report the app's painting, notifications and keyboard handling as not verified.
- Report VS Code, Remote Control and Slack as not verified.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on what the person can do. It then has exactly four H2 sections, in this order.

1. `Sub-features` lists short IDs with one line each.
2. `How to get to it (user POV)` lists every entry point a person has.
3. `Driving it with control` starts with `Preconditions:` and pairs each action with an exact command and the observable result.
4. `Gotchas` lists what can waste or invalidate a run, and what the recipe cannot show.

Keep implementation details out of the map. Name user paths, stable handles, required state, commands and observable proof.

## Features

| Feature | Journey | What a pass shows |
| --- | --- | --- |
| [Session controls](session.md) | `journeys/session` | Status, off and on answer, the switch is stored, the vision file is untouched, and slash commands send nothing to a model. |
| [Deviation alerts](alerts.md) | `journeys/alerts` | A check runs after a turn, the row shows the deviation, each of the four buttons does its job, later checks hear the answers, and a manual check runs while checks are off. |
| [Standing instructions](instructions.md) | `journeys/instructions` | A stated instruction is noted, listed, sent to later checks, alerted on, withdrawn and restored; short prompts and projects without a vision send nothing. |
| [Learn from a correction](learn.md) | `journeys/learn` | Learn finds the corrected act, shows it before the sentence, tests the sentence on session excerpts, reports the results, and writes no project file. |
| [Alerts in the desktop app](desktop.md) | `journeys/desktop` | Under the desktop app's own Claude Code, a desktop person counts, the card is returned for the desktop surface with its parts, each button does its job, and the notice and the notification call reach the app's side. A stand-in: it does not show the app. |

The first four journeys drive the terminal. `journeys/desktop` drives the stand-in and repeats the core of each feature there.

Not mapped yet: installing the plugin from the marketplace, the two file-name settings (`visionFile`, `antiPatternsFile`) and the line in the vision that names the anti-patterns file, the notification banner, the desktop app's own painting of the card, VS Code, Remote Control and Slack.
