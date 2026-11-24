# Draft a vision sentence from a correction

The person can inspect the act the plugin found, test a proposed sentence or discard the draft.

## Sub-features

- Find the corrected act with or without a hint.
- Test the sentence on session excerpts or cancel the draft.

## How to get to it (user POV)

Enter `/course-keeper learn` after correcting an unflagged reply. Add the act as a command argument to give a hint. Enter `/course-keeper learn yes` or `/course-keeper learn cancel` to answer.

## Driving it with the Claude Code terminal

Preconditions: Use a model-backed fixture with an actual unflagged agent reply and a subsequent correction. Record the vision file checksum and the anti-patterns file checksum if present.

- **Find.** Enter `/course-keeper learn`. Match the displayed act and quote against the earlier reply.
- **Cancel.** Enter `/course-keeper learn cancel`, then `/course-keeper learn yes`. Verify the response says no draft waits.
- **Give a hint.** For a reply that added unsolicited totals, enter `/course-keeper learn added unsolicited totals`. Verify the matched words before accepting.
- **Accept.** Enter `/course-keeper learn yes`. Capture the proposed sentence, destination and results on the corrected turn and earlier turns. Compare the project file checksums with the originals.

## Gotchas

The baseline has no correction or model. Without the quoted reply, a draft cannot be tested. If the current vision already flags the target act, record the covered result. A sentence-generation proof still requires an uncovered correction.
