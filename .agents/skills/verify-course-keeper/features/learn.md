# Draft a vision sentence from a correction

After the person corrected the agent on something that no alert flagged, `/course-keeper learn` finds the act, shows it, and on `learn yes` tests one draft sentence on excerpts of the session. It reports the results. It never writes the vision or the anti-patterns file and it sends nothing to the agent.

## Sub-features

- `learn-find` finds the corrected act and shows the act and the agent's words, not the sentence.
- `learn-hint` takes the act in the person's words: `/course-keeper learn <words>`.
- `learn-cancel` drops the waiting draft.
- `learn-test` tests the sentence on the corrected turn and on up to 3 earlier turns, and prints the report.
- `learn-place` offers a sentence for an existing invariant for the anti-patterns file when the project has one, and a sentence for a new invariant always for the vision file.
- `learn-refuse` shows nothing of a draft whose quote is not in the agent's replies, or whose sentence does not start with `Never`.
- `learn-covered` offers no sentence when today's vision already alerts on that invariant.
- `learn-limits` keeps nothing when the corrected turn is gone or too long for the test.
- `learn-no-write` leaves the project files, the alerts and the last check as they were.

## How to get to it (user POV)

- Correct the agent in a prompt, then enter `/course-keeper learn`.
- Enter `/course-keeper learn <what the agent did wrong>`.
- Enter `/course-keeper learn yes`.
- Enter `/course-keeper learn cancel`.

## Driving it with control

Preconditions:

- A run from `control start` with the default vision, and `control doctor "$RUN"` exits 0.
- A staged session: some sound turns, one turn with the act, then the person's correction as a typed prompt. Script every check as `verdict: none` and every `haiku` call as `none`.
- Wait for each turn's check before the next prompt. The learn step reads the session as the plugin last saw it.

The whole recipe runs as `journeys/learn` (about 60 seconds, four runs: default vision, with `--anti-patterns`, with `--no-vision`, and one for compaction and long turns). The steps below show the core by hand.

- **Script the draft.** Put a reply in the form at the end of `prompts/learn.md` in a file: `result: draft`, `quote:` with words that stand in the agent's reply, `act:`, `forms:`, `variant:`, `place: invariant 1`, `sentence: Never …`, `allowed:`. Run `control reply "$RUN" --when "# Learn from a catch" --times 1 --file <file>`.
- **Find.** Enter `/course-keeper learn`. The answer reads `Course Keeper read this as the act you corrected:`, the act, `The agent's words: "<quote>"`, and three lines on what to enter next. It does not hold the sentence. `control store "$RUN"` holds the draft under `learn`. `control requests "$RUN"` shows one new request, the learn fork; its last user message holds the vision text and the `<final_answer>` block.
- **Cancel.** Enter `/course-keeper learn cancel`. The answer reads `The draft sentence is dropped.` Enter `/course-keeper learn yes`. The answer reads `No draft sentence waits for an answer. Run /course-keeper learn first.` No request was sent.
- **Hint.** Script a draft again and enter `/course-keeper learn <words>`. The fork's last user message holds `The person described the act in these words: "<words>"`.
- **Script the test.** The excerpt calls are not streamed and hold `This is a check that the Course Keeper plugin runs on a coding session`. Each ends with `## The agent's latest turn`, `INPUT: <prompt>` and `AGENT: <reply>`. Script the call that holds the sentence and `AGENT: <the corrected reply>` as a deviation on invariant 1. Script the calls for the earlier turns, and the first call (the corrected turn with today's vision, add `--unless "<sentence>"`), as `verdict: none`.
- **Accept.** Enter `/course-keeper learn yes`. The report reads `Draft sentence for VISION.md, invariant 1:`, the sentence, `Test on the turn you corrected: the check alerts with this sentence added.`, `Test on 3 earlier turns of this session: no new alert.`, `Must stay allowed: …`, `Where it comes from: …`, and three closing notes. `control requests "$RUN"` shows 5 excerpt calls for a session with 3 or more earlier turns. The store holds no draft afterwards.
- **Nothing written.** Compare the fixture's `VISION.md` with `<evidence>/vision.md`. List the project directory: no `ANTI-PATTERNS.md` appeared. No main-turn request follows any learn step.
- **Proof.** Run `control requests "$RUN" --unscripted`. It exits 0.

Other answers the journey asserts, each with its exact text:

- `The draft quoted words that are not in the agent's replies, so it is not shown.`
- `No sentence drafted: <reason>` and `No sentence drafted: the draft reply was malformed.`
- `The check already alerts on the turn you corrected with today's vision (invariant 1): …`
- `With today's vision the check alerts on this turn on invariant 2, another matter: …`
- `Test on the turn you corrected: the check stays silent with this sentence added. The sentence is not verified.`
- `Test on 3 earlier turns of this session: 1 new alert: "…". Read it: such an alert can be sound.`
- `No result on 1 of them (the reply was malformed).`
- `Draft sentence for ANTI-PATTERNS.md, under invariant 1:` in a run with `--anti-patterns`.
- `No VISION.md found. /course-keeper learn does not run without it.` in a run with `--no-vision`.
- `No sentence drafted: the fork ended with aborted.` after Escape during a delayed learn fork.
- `The turn you corrected is no longer in the session (a compaction can remove it).`
- `The turn you corrected is too long for the test.`

## Gotchas

- A scripted draft proves how Course Keeper carries, places, tests and reports a sentence. It does not prove that the model finds the right act or writes a good sentence.
- The quote must stand in an agent reply, compared with runs of whitespace as one space. Words that only the person wrote do not count.
- Tell the excerpt calls apart by content: the sentence text, and the `AGENT: <reply>` of the tested turn. The calls for the earlier turns run at the same time, so their order in the log changes between runs.
- The call with today's vision for an earlier turn is sent only when the call with the sentence alerted on that turn.
- A plain `/compact` in Claude Code 2.1.332 keeps the earlier turns in what the plugin reads. To remove the corrected turn, use `/rewind`, pick the message, and choose `2. Summarize from here`. `docs/reference.md` says that a compaction can remove the turn.
- A typed command runs only after the previous command has answered. The answers `A learn step is already running in this session.` and `The learn step in flight is cancelled.` cannot be reached by typing. Escape aborts the plugin's own model call instead.
- The harness starts Claude Code with no tools. No turn has a tool call, so that part of an excerpt is not tested.
- `coveredText` and the "another matter" line put a period after the closing quote; a quote that ends with a period shows `.".`. Assert the real text.
