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

The desktop app draws the alert as a card. Check it with a model-backed session in the app. The app shares the person's user profile, so the steps below change their plugin install: ask first, and record `claude plugin list` and `claude plugin marketplace list` before you start.

- **Load this checkout.** Run `claude plugin uninstall course-keeper@course-keeper`, `claude plugin marketplace remove course-keeper`, `claude plugin marketplace add <checkout>` and `claude plugin install course-keeper@course-keeper`. The app reloads the plugins of every open local session by itself, within about 15 seconds after a plugin command changes the content of `~/.claude/plugins/installed_plugins.json` (6-11 s observed with `claude plugin update` and with hand edits, on app 6.28899.6). Instead of typing in a session the person may be using, wait in `~/Library/Logs/Claude/main.log`. A command before the final install can cause its own reload, so only lines that appear after the final install count: a new `reload_plugins broadcast (installed_plugins.json changed)` line, then as many `reload_plugins applied for` lines as that broadcast counts live sessions (for example `2 of 2 live local session(s)`). `claude plugin disable` and a `touch` of the file trigger no reload. If no applied line appears within a minute, enter `/reload-plugins` in the app session: Return first accepts the suggestion; press Return again only after the composer shows the command.
- **Before each keystroke,** confirm that the app shows your test session, as the global desktop computer-use rule says. The person may be typing in another session.
- **Folder picker.** The app's "Select folder" dialog is drawn by the separate process `com.apple.appkit.xpc.openAndSavePanelService`. Send its keys to that process's window; Cmd+Shift+G opens "Go to folder".
- **What to check.** The card shows the Course Keeper wheel, "Breaks rule: “…”", a ✕, one sentence, the buttons Tell the agent, Details and False alarm, and "Course Keeper" at the row's end. Details opens the note under the buttons, in view, after Instead when the alert has that part and Agent wrote when it has a quote. ✕ closes the alert. Check light and dark.
- **Restore** what you recorded. For the usual user-scoped GitHub install: `claude plugin uninstall course-keeper@course-keeper`, `claude plugin marketplace remove course-keeper` and `claude plugin install course-keeper --marketplace chapati23/course-keeper`. Compare both lists with the recorded ones.

## Gotchas

The baseline has no conflicting conversation or live model. A missing expected alert fails the journey. Record the actual reply and last check. Recreate the alert before testing another closing action. The desktop app draws a card in place of the terminal alert row; a VS Code session can show status but no alert row was verified there. `claude plugin test` cannot show how a surface paints the card. Claude desktop app 6.28899.6 crashed its renderer 16 times on 2026-11-25 ("Claude keeps crashing"; `main.log`: `Main webview render process gone ... exitCode: 5`). Switching sessions in the Code tab reproduced the crash with Course Keeper and the one other plugin that draws above the prompt both disabled. A crash alone therefore shows no plugin fault. Mark a run that a crash interrupts inconclusive, click Reload on the crash page (it recovered the app; after several crashes the app stops reloading by itself) and repeat the journey in a fresh session. Re-check on a newer app version.
