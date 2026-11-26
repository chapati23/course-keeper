# Keep and withdraw a standing instruction

When a person states a goal or an instruction that holds beyond one task, Course Keeper notes it, shows a short notice, lists it in `/course-keeper`, and holds later turns to it. The person withdraws an instruction by its number.

## Sub-features

- `instr-record` notes an instruction from a typed prompt and shows the notice.
- `instr-list` lists the instructions with numbers in `/course-keeper`.
- `instr-enforce` sends the list to each later check, and alerts on an instruction.
- `instr-skip` sends nothing for a prompt under 12 characters, a prompt that starts with `/`, or a project without a vision file.
- `instr-off` still notes instructions while checks are off.
- `instr-forget` withdraws instruction n with `/course-keeper forget <n>`; later checks are told not to enforce it.
- `instr-restate` makes a withdrawn instruction active again when the person states it again.
- `instr-compact` asks the summarizer of `/compact` to keep the instructions word for word.

## How to get to it (user POV)

- Type an ordinary prompt that states an instruction, for example `From now on, never push to main without my yes.`
- Read the notice at the top right of the terminal.
- Enter `/course-keeper` to read the numbered list.
- Enter `/course-keeper forget <n>`.
- Enter `/compact`, with or without focus text.

## Driving it with control

Preconditions:

- A fresh run from `control start` with the default vision, and `control doctor "$RUN"` exits 0.
- The model decides what counts as an instruction. Script the `haiku` reply: `none`, or one line per instruction that starts with `- `.

The whole recipe runs as `journeys/instructions` (about 70 seconds, two runs). The steps below show the core by hand.

- **Script the turn.** Run `control reply "$RUN" --when "Decide whether it states a standing instruction" --times 1 --text "- never push to main without my yes"`. Run `control reply "$RUN" --when "From now on, never push" --unless "Decide whether it states a standing instruction" --times 1 --text "Understood."`. Run `control reply "$RUN" --when "<final_answer>" --times 1 --text "verdict: none"`.
- **Record.** Run `control send "$RUN" "From now on, never push to main without my yes."`, then `control wait "$RUN" "noted a standing" --visible --timeout 20 --save notice`. The notice reads `Course Keeper noted a standing instruction: "never push to main without my yes"` in a box titled `course-keeper`. It stays about 4 seconds.
- **What was sent.** `control requests "$RUN"` lists three requests: the main turn, a `haiku` request and the check. In `model-requests.jsonl` the `haiku` request is not streamed, and the text between `<message>` and `</message>` is exactly the typed prompt.
- **List.** Enter `/course-keeper`. The answer holds `Standing instructions:` and `1. never push to main without my yes`. `control store "$RUN"` holds it under `instructions`.
- **Enforce.** Run one more scripted turn. Its check request holds the line `1. never push to main without my yes` under `## The person's standing instructions`.
- **Alert on it.** Script a check reply with `reference: instruction "never push to main without my yes"`. The row shows `Session breaks your instruction · Course Keeper` and `Your instruction: "never push to main without my yes"`. Status shows `Last check: <time> UTC, verdict: deviation (instruction "never push to main without my yes").`
- **Forget.** Enter `/course-keeper forget 1`. The answer reads `Standing instruction 1 removed: "never push to main without my yes"`. Status shows `Withdrawn standing instructions:` and `- never push to main without my yes`. The store holds it under `withdrawn`. The next check request holds `Withdrawn by the person; do not enforce these:` and the instruction.
- **Forget a missing number.** Enter `/course-keeper forget 9`. The answer starts `No standing instruction 9. Usage:`. The store does not change.
- **Restate.** Type the instruction again, with the same scripted `haiku` reply. The notice appears, the instruction is active again, and `withdrawn` is empty.
- **No call.** Type `  Never merge` (11 characters after trimming). No `haiku` request appears. Type `Never rebase` (12 characters). One appears.
- **Checks off.** Enter `/course-keeper off`, then type an instruction. The `haiku` request and the notice still appear; no check request follows.
- **No vision.** In a run from `control start --no-vision`, type an instruction. `control requests` lists only the main turn. Status reads `VISION.md: not found. No checks run without it.`

The journey also covers these: an instruction that is already active is not added twice, a four-line `haiku` reply adds three instructions, a forget during the `haiku` call wins, and `/compact` after the vision file was deleted carries no instruction.

## Gotchas

- A scripted `haiku` reply proves how Course Keeper handles the reply. It does not prove that the model recognises a standing instruction.
- A main-turn rule keyed on the prompt needs `--unless "Decide whether it states a standing instruction"`. The `haiku` request quotes the same prompt and can arrive first.
- The notice is a toast. It is not in the transcript and it leaves after about 4 seconds, so wait for it directly after `control send`. Claude Code cuts it to three lines of 40 columns; assert the full text in the store and in status.
- The 12-character rule and the leading `/` rule use the trimmed prompt. Claude Code keeps leading spaces of a typed prompt and drops trailing ones.
- A typed text that starts with `/` and is no command, such as `/tmp/out is where every export goes`, reaches the plugin as a prompt. `/nosuchcommand …` does not: Claude Code answers `Unknown command`.
- Claude Code calls the plugin's prompt hook for none of these: the plugin's own commands, `/compact`, and the note that `Tell the agent` sends. The plugin's guards for those cases cannot be reached by a person; only `claude plugin test .` covers them.
- After two compactions with no turn between, `/compact` answers `Not enough messages to compact.`
- Not covered: a full list (30 instructions), and the desktop notification.
