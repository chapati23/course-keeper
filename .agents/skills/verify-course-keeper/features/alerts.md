# Inspect and answer a deviation alert

When a check finds a deviation, an alert appears above the prompt. In the terminal it is a framed row. It names the invariant or the instruction, says what the agent did and what it should do instead, and quotes the agent. The person answers with one of four buttons. Course Keeper never acts on the agent unless the person presses `Tell the agent`.

This file covers the terminal row. The desktop app draws the same alert as a card: see [Alerts in the desktop app](desktop.md).

## Sub-features

- `alert-auto` runs a check at the end of each main-agent turn and shows the row.
- `alert-status` lists the session's alerts and the last check in `/course-keeper`.
- `alert-details` shows and hides the note for the agent (key `2`).
- `alert-tell` sends the note to the agent as a message from the plugin (key `1`).
- `alert-false-alarm` asks for a second press, then records a false alarm that later checks are told about (key `3`).
- `alert-dismiss` closes the row (key `4`).
- `alert-manual` runs a check on demand with `/course-keeper check`, also while checks are off.

## How to get to it (user POV)

- Let a main-agent turn end with an answer. The check runs after the turn.
- Enter `/course-keeper check`.
- Press ctrl+x, then tab, to give the row the keyboard. Then press `1`, `2`, `3` or `4`. A click on the row also gives it the keyboard; the harness does not click.
- Enter `/course-keeper` to read the alerts and the answers.

## Driving it with control

Preconditions:

- A fresh terminal run from `control start` with the default vision, and `control doctor "$RUN"` exits 0.
- Every model request has a scripted reply. Write the check reply in the exact format at the end of `prompts/check.md`.

The whole recipe runs as `journeys/alerts`. The steps below show one alert by hand; the journey repeats the pattern with a fresh alert for each closing button.

- **Script the turn.** Run `control reply "$RUN" --when "Decide whether it states a standing instruction" --model haiku --text none`. Run `control reply "$RUN" --when "Fix the rounding bug" --unless "Decide whether it states a standing instruction" --times 1 --text "I will round the invoice totals in the exporter. That is a one-line fix."`. Put a `verdict: deviation` reply with `reference: invariant 1`, `alert:`, `instead:`, `evidence: "I will round the invoice totals in the exporter."` and `note:` in a file, and run `control reply "$RUN" --when "<final_answer>" --times 1 --file <file>`. Each call prints its rule number.
- **Automatic check.** Run `control send "$RUN" "Fix the rounding bug in the invoice exporter."`, then `control wait "$RUN" 'Agent wrote: “I will round the invoice totals in the exporter.”' --visible --timeout 45 --save row-1`. The row shows `Session breaks invariant 1 · Course Keeper`, `Your rule: “One module computes every amount”`, `What your agent did:`, `What it should do instead:`, the quote, and `1: Tell the agent · 2: Details · 3: False alarm · 4: Dismiss · ctrl+x tab`.
- **What the check was sent.** Run `control requests "$RUN"`. It lists the main turn, the `haiku` call and the check, each with its rule. In `<evidence>/model-requests.jsonl` the check's `last_user` holds the vision text, the `<final_answer>` block with the agent's answer, and `# The check`.
- **Status.** Enter `/course-keeper`. It lists `1. invariant 1: <alert> Instead: <instead>. Answer: none yet.` and `Last check: <time> UTC, verdict: deviation (invariant 1).` `control store "$RUN"` holds the alert under `current` with `"answer": null`.
- **Details.** Run `control press "$RUN" 2`; it gives the row the keyboard, presses the key and prints `Details`. Run `control wait "$RUN" "For the agent:" --visible`. The store holds `"showDetails": true`. Press `2` again and wait with `--gone`; the store holds `false`.
- **Tell the agent.** Script a reply for the note first (`--when "Course Keeper alert on invariant 1"`), and a `verdict: none` for the check that follows. Run `control press "$RUN" 1`. The row closes. The screen shows `Prompt from the course-keeper plugin` and the agent's answer. The next main request's `last_user` holds `The course-keeper plugin sent a message:` and then `Course Keeper alert on invariant 1. Evidence: "…". Note: …`. The store lists the alert under `alerts` with `"answer": "told the agent"`.
- **False alarm.** On a fresh alert run `control press "$RUN" 3`, then `control wait "$RUN" "3: Confirm false alarm" --visible`. The row stays and the store holds `"confirmFalseAlarm": true`. Press `3` again. The row closes and the store records `"answer": "intended"`. Run one more scripted turn. Its check request lists the alert under `## Alerts the person has already received in this session` with `The person's answer: false alarm (the person says this is no deviation, or wanted it).`
- **Dismiss.** On a fresh alert run `control press "$RUN" 4`. The row closes and the store records `"answer": "dismissed"`.
- **Manual check.** Enter `/course-keeper off`. Run a scripted turn. No check request follows it, no row appears, and the store holds `"outcome": "did not run: checks are off"`. Script the check reply, then enter `/course-keeper check`. The answer reads `Check finished: verdict: deviation (invariant 2).` and the row appears while `isOff` stays `true`.
- **Proof.** Run `control requests "$RUN" --unscripted`. It prints nothing and exits 0. Compare the fixture's `VISION.md` with `<evidence>/vision.md`.

## Gotchas

- A scripted check reply proves how Course Keeper handles a reply. It does not prove that a model detects the deviation. Say so in every report that rests on this journey.
- The row uses curly quotation marks around the rule and the quote. Copy them from this file; a straight `"` does not match.
- The quote in the row drops the agent's Markdown marks (`**`, `_`, backticks). The stored evidence keeps them.
- Claude Code clears the terminal scrollback when the row appears. Read the row with `--visible`. Do not count earlier echoes in the history.
- Focus shows only as inverse video on one button. `control focus` reads it and prints the focused button; `control press` uses it. After a press of `2`, the focus stays on `2: Details`.
- The journey asserts that `1: Tell the agent` has the focus first on a fresh row. It cannot tell whether that comes from the button's `autoFocus` or from its place as the first button: in Claude Code 2.1.332 the row focuses the first button either way.
- With an empty prompt, the number keys pressed the buttons even without ctrl+x tab. `docs/reference.md` says to give the row the keyboard first. The recipes follow the documented path.
- Each closing button needs a fresh alert. A check reply that repeats an alert the person already answered is not a fresh alert; change the agent's words and the quote.
- A `--when` that matches nothing gets the default reply `OK.`. The check then records `the reply was malformed` and no row appears. `control requests "$RUN" --unscripted` shows such requests.
- `--when "<final_answer>"` matches every check. Use `--times 1`, or match the full block `<final_answer>`, newline, the agent's answer, newline, `</final_answer>`, as `journeys/alerts` does.
- A main-turn rule keyed on the prompt needs `--unless "Decide whether it states a standing instruction"`. The `haiku` request quotes the same prompt and can take the rule first.
- No `haiku` call follows the note of `Tell the agent`. That shows a fact about Claude Code 2.1.332: it does not call the plugin's prompt hook for a prompt that a plugin submits. The plugin's own guard for that case cannot be reached by a person.
- A check needs an attached surface and a prompt from a person. `claude -p`, sessions that a program drives through the Agent SDK, and subagents get no check.
- No alert row was verified in VS Code. There `/course-keeper` lists the alert.
- The desktop notification that accompanies an alert is not observed on the terminal. [The desktop journey](desktop.md) observes the notification call, not the banner.
