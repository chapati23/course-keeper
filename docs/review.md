# Review guide

Checks a review of this repository applies in addition to the general review instructions.

## Tests, verification journeys and the harness

**Trigger:** a change to a test file under `hooks/` or to `.agents/skills/verify-course-keeper/`.

- For each assertion, name the plugin change that would make it fail. An assertion is no proof when it passes while the plugin does nothing, when an earlier step already set the state, or when it runs before the screen or the log can hold the event. Start a watch before the action it watches, and wait for the end of an answer before a check that something is absent. (class: weak-test-oracle)
- A stop, cleanup, wait or log read that cannot finish its job must exit non-zero, and every caller must pass that exit on. Examples: a process still runs, a record is unwritten, an expected mark never appears, a log cannot be read. A journey must not print PASS after an incomplete step. (class: failure-counted-as-success)
