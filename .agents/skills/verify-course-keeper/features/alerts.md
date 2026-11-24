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
- **Details.** Focus the row and press 1 twice. The note appears and then hides.
- **Tell the agent.** Press 2. Verify one plugin-authored message matches the note and status records the answer.
- **False alarm.** On a fresh alert press 3. Verify that the row closes and status records the intended act. Repeat the same act and inspect the next check for recurrence.
- **Dismiss.** On a fresh alert press 4. Verify that the row closes and status records dismissal.

## Gotchas

The baseline has no conflicting conversation or live model. A missing expected alert fails the journey. Record the actual reply and last check. Recreate the alert before testing another closing action. A VS Code session can show status but lacks the terminal alert row.
