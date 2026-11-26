# Inspect and switch session checks

A person can see which vision file Course Keeper reads, and can turn the automatic checks off or on for the current session. The switch is kept in the plugin's store. These commands send nothing to a model.

## Sub-features

- `session-status` shows the vision file, the switch, the standing instructions, the alerts and the last check.
- `session-off` turns the automatic checks off for this session.
- `session-on` turns them on again.
- `session-no-vision` shows that Course Keeper does nothing in a project without a vision file.

## How to get to it (user POV)

- Enter `/course-keeper` at the Claude Code prompt.
- Enter `/course-keeper off`.
- Enter `/course-keeper on`.

## Driving it with control

Preconditions:

- A fresh run from `control start`, and `control doctor "$RUN"` exits 0.
- No prompt was typed yet. The fixture holds the default vision with two invariants.

The whole recipe runs as `journeys/session`. The steps below are the same steps by hand.

- **Status.** Run `control send "$RUN" "/course-keeper"`, then `control wait "$RUN" "Last check:" --after "❯ /course-keeper" --save status-fresh`. The answer starts with `course-keeper: VISION.md: <run>/scratch/project/VISION.md` and holds `Checks: on for this session.`, `Standing instructions:` with `none`, `Alerts in this session:` with `none`, and `Last check: none yet.`
- **Off.** Run `control send "$RUN" "/course-keeper off"`, then `control wait "$RUN" "Course Keeper checks are off for this session." --after "❯ /course-keeper off"`. Enter `/course-keeper` again. The answer holds `Checks: off for this session.`
- **Off, stored.** Run `control store "$RUN" --save store-off`. The record holds `"isOff": true`.
- **On.** Run `control send "$RUN" "/course-keeper on"`, then wait for `Course Keeper checks are on for this session.` Status holds `Checks: on for this session.` and `control store "$RUN"` holds `"isOff": false`.
- **Nothing sent.** Run `control requests "$RUN"`. It prints nothing and exits 0: slash commands alone start no model request. The journey asserts an empty request log.
- **Vision untouched.** Compare `<run>/scratch/project/VISION.md` with `<evidence>/vision.md`. They are the same.
- **No vision.** Start a second run with `control start --no-vision`. `control doctor` passes on the status line `VISION.md: not found. No checks run without it.` `/course-keeper check` answers `Check finished: did not run: no VISION.md found.` `journeys/session` does not run this step; [the standing-instruction journey](instructions.md) asserts the status line and that a prompt there starts no plugin request.

## Gotchas

- `control doctor` types `/course-keeper` itself. The screen then holds two status answers. Match the answer after the newest echo with `--after`.
- The switch stops only the automatic check at the end of a turn. `/course-keeper check` still runs a check, and standing instructions are still noted. [Deviation alerts](alerts.md) and [Standing instructions](instructions.md) prove those paths.
- `journeys/session` runs no turn. It cannot show that the switch stops a check. `journeys/alerts` step 6 shows that.
- `off`, `on` and `forget` wait for the store before they answer. Other writes do not, so poll `control store` after them. Before the first write, `control store` prints `null`.
