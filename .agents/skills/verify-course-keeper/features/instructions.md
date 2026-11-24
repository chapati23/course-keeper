# Keep and withdraw a standing instruction

The person can state an instruction for future tasks and later withdraw it by number.

## Sub-features

- Record a standing instruction from a prompt.
- List and withdraw the numbered instruction.

## How to get to it (user POV)

Send an ordinary terminal prompt. Read the notice and open `/course-keeper`. Use `/course-keeper forget 1` for the first instruction.

## Driving it with the Claude Code terminal

Preconditions: Use a fresh model-backed fixture with a vision and an empty instruction list.

- **Record.** Enter `For every future answer, use plain text only.` Wait for the added notice. Open status and capture instruction 1. Repeat in a fresh session with checks off to cover extraction in that state.
- **Withdraw.** Enter `/course-keeper forget 1`. Confirm the response quotes the removed instruction. Open status. Verify it left the active list and appears in the withdrawn list.

## Gotchas

Extraction runs asynchronously. Slash commands and prompts shorter than 12 characters do not start extraction. The baseline loopback endpoint cannot supply the extraction result.
