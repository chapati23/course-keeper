# Write the vision

Course Keeper checks each session against the rules in your vision file. This page says where the file goes, how to write a rule that the check catches, and what the replay tests measured. Back to the [README](../README.md).

## The vision

Course Keeper reads `VISION.md` at the root of the repository (the main working tree), or at the project root when the session is not in a repository. Both file names can be changed ([Settings](reference.md#settings)). Without the file, Course Keeper does nothing in that project: no check runs, no standing instruction is noted, and nothing is sent to a model.

The vision is a short statement of what the project is and a numbered list of invariants: testable statements that a session must not contradict. An alert cites an invariant by its number. For example:

```markdown
# Vision

A command-line tool that turns timesheets into invoices.

1. One module computes every amount. No other code does arithmetic on money.
2. The tool never sends an invoice. It writes files; the person sends them.
3. Every change keeps the test suite green on the three supported platforms.

Tracked drift: the old exporter still rounds amounts itself (invariant 1).
```

An optional `ANTI-PATTERNS.md` beside `VISION.md` holds the sentences that name acts to avoid, so the vision stays short. It has one section for each invariant, and the heading of a section starts with the number of its invariant. The check reads both files. Without `VISION.md`, Course Keeper does not read the anti-patterns file. For example:

```markdown
# Anti-patterns for the vision

## 1. One module computes every amount

- Never round, convert or add up money in other code, not even for display.

## 2. The tool never sends an invoice

- Never call the mail client from the tool.
```

The vision can name its own anti-patterns file in one line, an HTML comment. Put the line first in the vision file, above the title; Course Keeper reads it only there. Empty lines before it do not count. The path is relative to the place where Course Keeper looks for the vision (see [Settings](reference.md#settings)), not to the vision's own folder. The line overrides the `antiPatternsFile` setting for this project. The line can name only a Markdown file (`.md` or `.markdown`) outside hidden folders, and a symbolic link must lead to such a file too: the project chooses this path, not you, so Course Keeper sends only a file of that kind to the model. The line stays in the text that the check reads. `/course-keeper` shows the file with "(named in VISION.md)", or says that the file was not found or that the line is not used.

```markdown
<!-- course-keeper: anti-patterns = docs/vision/anti-patterns.md -->
# Vision
```

### Name the act to avoid

Write each invariant so that one of its sentences names the act that breaks it. A general statement alone is not enough. Write that sentence from the reply in which the agent deviated, not from a summary of the incident. The sentence can stand in the invariant or in the invariant's section of `ANTI-PATTERNS.md`. In the tests below, the sentence stood in the invariant; the tests did not measure the anti-patterns file.

| | Invariant text |
| --- | --- |
| **Avoid:** a general statement only | One module computes every amount. |
| **Write:** a sentence that names the act | One module computes every amount. Never round, convert or add up money in other code, not even for display. |

This comes from replay tests on recorded sessions of one private project (November 2026). Each test took a recorded turn in which the agent deviated. It ran the check on that turn three times. It also let the agent write its reply again ten times, with the vision added to the agent's context.

- In two such turns the vision held only a general statement. The check raised no alert in 3 of 3 tries, and the agent deviated again in 6 to 10 of 10 replies.
- After one sentence named the act, the check raised an alert in 3 of 3 tries, and the agent deviated again in 0 to 2 of 10 replies.
- A sentence stops the act that it names and no more. In one test, only 3 of 10 replies also did a related step that the sentence did not name.

A later test tried sentences that were written from one-line summaries of four further deviations:

- The check named the recorded act in two of the four turns, in one of them only in the note of an alert on another deviation. It missed the act in the other two.
- Only one of the four deviations came back when the reply was written again. There the agent deviated again in 10 of 10 replies with the sentence in view. The replies used the label that the sentence asked for and kept the act that it did not name.
- After that sentence was rewritten from the reply itself, the agent deviated again in 0 of 10 replies, and the check raised an alert in 3 of 3 tries.
- A rewrite does not repair every miss. For one of the two turns that the check missed, the check raised no alert in 3 of 3 tries after the rewrite too.

The check reads the text as written. A sentence that names too much can raise alerts on sound work, so state its scope in the sentence. The tests did not measure this.

The tests are small. Every sentence that stopped a deviation was written after its author read that deviation. No test shows that such a sentence stops a different one. The replays ran with every tool denied and without the agent's earlier thinking. Course Keeper does not add VISION.md to the agent's context; it only checks the session against it.
