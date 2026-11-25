# Inspect and answer a deviation alert

A person can inspect a quoted deviation and decide how to respond.

## Sub-features

- Trigger a check automatically or on demand.
- Inspect details, send the note, record a false alarm or dismiss the row.

## How to get to it (user POV)

Finish a main-agent turn or enter `/course-keeper check`. Read the row above the prompt. Click the row or press Ctrl+X then Tab to focus it. Status also lists session alerts.

## Driving it with the Claude Code terminal

Preconditions: Use a dedicated model-backed session. Include an invariant that forbids rich text. Ask for a bold Markdown heading and require an actual contradictory reply.

- **Automatic.** Wait for the completed turn and the alert. Capture the cited invariant and the agent's quoted words. Run status and compare its alert.
- **Manual.** In a separate fixture with automatic checks off, repeat the conflicting turn. Enter `/course-keeper check` and verify its result and the new row.
- **Details.** Focus the row and press 2 twice. The note appears and then hides.
- **Tell the agent.** Press 1, or Enter right after focusing the row. Verify one plugin-authored message matches the note and status records the answer.
- **False alarm.** On a fresh alert press 3. Verify that the button reads "Confirm false alarm" and the row stays. Press 3 again. Verify that the row closes and status records the intended act. Repeat the same act and inspect the next check for recurrence.
- **Dismiss.** On a fresh alert press 4. Verify that the row closes and status records dismissal.

## Driving it in the Claude desktop app

The desktop app, like VS Code and the phones, draws the alert as a card. Check it with a model-backed session in the app.

- **Load this checkout.** Run `claude plugin uninstall course-keeper@course-keeper`, `claude plugin marketplace remove course-keeper`, `claude plugin marketplace add <checkout>` and `claude plugin install course-keeper@course-keeper`. In the app session, enter `/reload-plugins`. Return first accepts the suggestion; press Return again only after the composer shows the command.
- **Before each keystroke,** confirm that the app shows your test session, as the global desktop computer-use rule says. The person may be typing in another session.
- **Folder picker.** The app's "Select folder" dialog is drawn by the separate process `com.apple.appkit.xpc.openAndSavePanelService`. Send its keys to that process's window; Cmd+Shift+G opens "Go to folder".
- **What to check.** The card shows the Course Keeper wheel, "Breaks rule: “…”", a ✕, one sentence, the buttons Tell the agent, Details and False alarm, and "Course Keeper" at the row's end. Details opens Instead, Agent wrote and the note under the buttons, in view. ✕ closes the alert. Check light and dark.
- **Restore.** Run `claude plugin uninstall course-keeper@course-keeper`, `claude plugin marketplace remove course-keeper` and `claude plugin install course-keeper --marketplace chapati23/course-keeper`.

## Gotchas

The baseline has no conflicting conversation or live model. A missing expected alert fails the journey. Record the actual reply and last check. Recreate the alert before testing another closing action. The desktop app and VS Code draw a card in place of the terminal alert row; `claude plugin test` cannot show how a surface paints it.
