# Write the vision

The [README](../README.md) shows a first `VISION.md` and the main advice: name the act that breaks each rule. This page adds where the file goes, the optional anti-patterns file, and the full results of the replay tests.

## The vision

Course Keeper reads `VISION.md` at the root of the repository (the main working tree), or at the project root when the session is not in a repository. Both file names can be changed ([Settings](reference.md#settings)). Without the file, Course Keeper does nothing in that project: no check runs, no standing instruction is noted, and nothing is sent to a model.

The vision is a short statement of what the project is and a numbered list of invariants: testable statements that a session must not contradict. The [Quick start](../README.md#quick-start) has an example. When the list has no numbers, an alert names an invariant by its bold lead, or else its first sentence, instead of its number. The learn step and the anti-patterns file still find an invariant only by its number.

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

[Write rules that get caught](../README.md#write-rules-that-get-caught) in the README shows a general invariant next to one with a sentence that names the act. Write that sentence from the reply in which the agent deviated, not from a summary of the incident. The sentence can stand in the invariant or in the invariant's section of `ANTI-PATTERNS.md`. In the tests below, the sentence stood in the invariant; the tests did not measure the anti-patterns file.

The advice comes from replay tests on recorded sessions of one private project (November 2026). Each test took a recorded turn in which the agent deviated. It ran the check on that turn three times. It also let the agent write its reply again ten times, with the vision added to the agent's context.

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

### False alerts

A later test, on 2026-11-25, measured false alerts. It ran the check prompt of version 0.4.0 twice on each of 8 turns from the same private project that had been judged sound, with the project's vision and anti-patterns file: 16 checks, every tool denied.

- The check raised 6 alerts in 16 checks, none of them false.
- 4 alerts were correct: those turns did break the vision as written.
- 2 alerts are unresolved: each quoted the agent's previous message, and whether it counts is the owner's call.
- Each turn raised an alert in both tries or in neither.
- The rule fixed before the run allowed at most 2 false alerts in 16. The result meets it even if both unresolved alerts were false.

The test is small: 8 turns from one project, and the author judged each alert.
