# Review guide

Checks a review of this repository applies in addition to the general review instructions.

## Text that the model reads

**Trigger:** a change to `prompts/*.md`, or to a text in `hooks/` that goes into a model request (for example `formatAlerts`, `noteText`, `withFinalAnswer`).

- A change to such a text ships together with an eval run of the prompt that reads it. The PR names the run and its result.
- Exception: a tiny, very low-risk change may ship without a new eval run, because a run costs too much for it. Examples: a typo, punctuation, or how an existing value is punctuated or quoted when the code fills it in, when no text says anything new. The PR that uses the exception says so and gives the reason.
- The exception does not cover a change to the meaning of an instruction, to which fields a prompt holds, to what a field says, or to the reply format that the model must produce. It also does not cover a sentence added or removed. Those changes still need an eval run.
- The HTML comment at the start of a prompt file does not reach the model: `stripLeadingComments` removes it. A change only to that comment needs no eval run.

## Docs that describe the changed behavior

**Trigger:** a change to `hooks/` or `prompts/` that alters what Course Keeper sends to a model, stores, or shows.

- Search every Markdown file in the repository (at least `docs/reference.md`, `CONTEXT.md`, `README.md`, `docs/writing-rules.md` and `.agents/skills/**`), and the comments of the changed functions, for each sentence that describes the changed behavior. Read each hit against the new code. A sentence that names an exact form (what a model call receives, how quoted words are cleaned, which lines count as items) must state the code's actual rule, including its edge cases. (class: stale-behavior-claim-in-docs)

## Tests, verification journeys and the harness

**Trigger:** a change to a test file under `hooks/` or to `.agents/skills/verify-course-keeper/`.

- For each assertion, name the plugin change that would make it fail. An assertion is no proof when it passes while the plugin does nothing, when an earlier step already set the state, or when it runs before the screen or the log can hold the event. Start a watch before the action it watches, and wait for the end of an answer before a check that something is absent. (class: weak-test-oracle)
- A stop, cleanup, wait or log read that cannot finish its job must exit non-zero, and every caller must pass that exit on. Examples: a process still runs, a record is unwritten, an expected mark never appears, a log cannot be read. A journey must not print PASS after an incomplete step. (class: failure-counted-as-success)
