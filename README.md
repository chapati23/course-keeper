# Course keeper

Course keeper is a Claude Code plugin. At the end of each turn of the main agent, it checks the session against the project's vision and the person's standing instructions. When the session deviates from them, it shows an alert above the prompt.

Course keeper reports to the person. It does not deny, change or stop the agent's work ([the decision and its reason](docs/adr/0001-alert-the-person-never-act-on-the-agent.md)).

## The vision

Course keeper reads `VISION.md` at the root of the repository (the main working tree), or at the project root when the session is not in a repository. Both file names can be changed ([Settings](#settings)). Without the file, course keeper does nothing in that project: no check runs, no standing instruction is noted, and nothing is sent to a model.

The vision is a short statement of what the project is and a numbered list of invariants: testable statements that a session must not contradict. An alert cites an invariant by its number. For example:

```markdown
# Vision

A command-line tool that turns timesheets into invoices.

1. One module computes every amount. No other code does arithmetic on money.
2. The tool never sends an invoice. It writes files; the person sends them.
3. Every change keeps the test suite green on the three supported platforms.

Tracked drift: the old exporter still rounds amounts itself (invariant 1).
```

An optional `ANTI-PATTERNS.md` beside `VISION.md` holds the sentences that name acts to avoid, so the vision stays short. It has one section for each invariant, and the heading of a section starts with the number of its invariant. The check reads both files. Without `VISION.md`, course keeper does not read the anti-patterns file. For example:

```markdown
# Anti-patterns for the vision

## 1. One module computes every amount

- Never round, convert or add up money in other code, not even for display.

## 2. The tool never sends an invoice

- Never call the mail client from the tool.
```

### Name the act to avoid

Write each invariant so that one of its sentences names the act that breaks it. A general statement alone is not enough. Write that sentence from the reply in which the agent deviated, not from a summary of the incident. The sentence can stand in the invariant or in the invariant's section of `ANTI-PATTERNS.md`. In the tests below, the sentence stood in the invariant; the tests did not measure the anti-patterns file.

| Invariant | Text |
| --- | --- |
| General statement only | One module computes every amount. |
| Names the act | One module computes every amount. Never round, convert or add up money in other code, not even for display. |

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

The tests are small. Every sentence that stopped a deviation was written after its author read that deviation. No test shows that such a sentence stops a different one. The replays ran with every tool denied and without the agent's earlier thinking. Course keeper does not add VISION.md to the agent's context; it only checks the session against it.

## Install

At the prompt of a terminal session:

```
/plugin install course-keeper --marketplace chapati23/course-keeper
```

From a shell:

```
claude plugin install course-keeper --marketplace chapati23/course-keeper
```

Answer `y` to add the marketplace, then choose a scope. Update with `claude plugin update course-keeper`, then run `/reload-plugins` or start a new session.

## Settings

Course keeper has two settings. Claude Code asks for them when you install the plugin. To change them later, use the plugin's rows in the `/config` menu.

| Setting | Default | The file it names |
| --- | --- | --- |
| `visionFile` | `VISION.md` | The file that holds the vision. |
| `antiPatternsFile` | `ANTI-PATTERNS.md` | The optional file that holds the acts to avoid. |

Each value is a path relative to the place where course keeper looks for the vision: the root of the repository (the main working tree), or the project root outside a repository. Change a name when the project already has a file of that name that is about something else. An empty value, an absolute path, or a path with `..` or a backslash counts as the default. Course keeper does not read a file that leads outside the project through a symbolic link; such a file counts as not found. When both settings lead to the same file, course keeper reads it as the vision only. The rest of this page uses the default names.

## What you see

When a check finds a deviation, a row above the prompt shows it. For example, in the timesheet project above:

```
▲ Course keeper: this session breaks invariant 1 (One module computes every amount)
- The session rounds the total in the exporter, which contradicts invariant 1.
- Instead: call the one module for the total.
- Evidence: "I will round the total in the exporter before it writes the file."
1: Details · 2: Tell the agent · 3: False alarm · 4: Dismiss
```

The first line names the invariant and its title, or quotes the standing instruction. The title is the invariant's bold lead in VISION.md, or else its first sentence, as the check read it. The next lines give one sentence about the deviation, what the invariant or the instruction asks for instead, and the evidence, a quote from the agent. The "Instead" line is left out when the check gave no such text. The row has four buttons:

- `1 Details` shows or hides one more line: the note, the text that "Tell the agent" sends.
- `2 Tell the agent` sends the note to the agent as a message from the plugin.
- `3 False alarm` closes the alert and records that this is no deviation, or that you wanted it. Later checks are told so, and do not raise it again.
- `4 Dismiss` closes the alert.

Press ctrl+x tab (or click the row) to give the row the keyboard, then press a number. Course keeper also raises a desktop notification where Claude Code offers one. It has the first line of the row as its title and the sentence about the deviation as its text.

Course keeper also notes standing instructions: goals or instructions you state in a prompt that stay in force beyond one task. It shows a short notice when it adds one.

## The command

- `/course-keeper` shows whether a VISION.md and a ANTI-PATTERNS.md were found, the standing instructions with their numbers, the alerts of this session with your answers, and the result of the last check.
- `/course-keeper forget <n>` removes standing instruction n. Later checks are told not to enforce it.
- `/course-keeper check` runs a check now.
- `/course-keeper off` and `/course-keeper on` switch the checks for this session. Standing instructions are still noted while checks are off.
- `/course-keeper learn` drafts one sentence for the vision after you corrected the agent on something that no alert flagged. When the project has a ANTI-PATTERNS.md, a sentence for an existing invariant is for that invariant's section of ANTI-PATTERNS.md; a sentence for a new invariant is always for VISION.md. A copy of the session finds the agent's reply that you corrected and drafts a sentence that starts with "Never". Course keeper first shows the act and the agent's words, not the sentence. When the agent's words are not found word for word in its replies, it shows nothing of the draft. `/course-keeper learn <what the agent did wrong>` names the act in your words.
- `/course-keeper learn yes` accepts the act. Course keeper tests the sentence on excerpts of this session and shows it with the results: whether the check alerts on the turn you corrected with the sentence added, and whether it raises new alerts on up to 3 earlier turns. When the check already alerts on that turn with today's vision, on the invariant that the sentence would join, no sentence is offered. An alert of today's vision on another matter of that turn does not stop the test; the results name it. `/course-keeper learn cancel` drops the draft. A learn step in flight then keeps nothing.
- Course keeper never writes VISION.md or ANTI-PATTERNS.md and sends nothing to the agent. The draft is for the owners of the vision.

## What is sent to the model, and when

- **A check**, at the end of each main-agent turn that ends with an answer. Course keeper asks one question over a copy of the session: the session's own model gets the conversation as the main thread last sent it, plus the agent's final answer of the turn (the copy does not hold it yet) and the check prompt (`prompts/check.md`) with the text of VISION.md and of ANTI-PATTERNS.md (if there is one), the standing instructions and this session's alerts. The copy has no tools and gives one reply. At most one check runs at a time in a session.
- **A standing-instruction check**, at each prompt you type that is not a slash command and has at least 12 characters. The `haiku` model gets `prompts/extract.md` and your whole prompt as it entered the session (after any other plugin changed or dropped it), and nothing else. This happens only in a project that has a VISION.md. It also happens while checks are off for the session.
- **Tell the agent** sends the note to the agent only when you press the button.
- **A learn step**, only when you run `/course-keeper learn`. The session's own model gets a copy of the session (a fork, as for a check, with the agent's final answer of the last turn) with the learn prompt (`prompts/learn.md`), the text of VISION.md and of ANTI-PATTERNS.md (if there is one) and your words, if you gave any. After `/course-keeper learn yes`, separate calls send excerpts of the session to the session's model: the summary that replaced the earlier conversation, if there is one, all your messages up to that turn in order, and the rows of one turn. Each call also holds the check prompt (`prompts/check.md`, with `prompts/excerpt-head.md` in place of its head), and the text of VISION.md and of ANTI-PATTERNS.md (if there is one), with or without the draft sentence. It holds no list of standing instructions: the list held now can hold one that your correction created. Your messages in the excerpt show what was in force at that turn. It holds the instructions you withdrew with `/course-keeper forget`, and the check is told not to enforce them.

Course keeper keeps the standing instructions and alerts of the last 20 sessions in its store, a file under your Claude Code configuration directory. It sends them nowhere else.

## What it costs

Both calls are billed to the session's credentials and count in `/usage`. A check asks the API to serve the conversation from the session's prompt cache; when that cache entry has lapsed, or after `/model`, it pays for the whole conversation again. The standing-instruction check is one `haiku` call per prompt; it holds your whole prompt, so a long paste costs more. A learn step is one fork, then up to 8 excerpt calls on the session's model. No prompt cache serves an excerpt call, so each one pays for its whole excerpt. Cost figures in Claude Code are estimates.

## Limits

- The plugin API of Claude Code is early access and can change between releases. The plugin needs Claude Code 2.1.323 or later.
- VS Code has no row above the prompt. There, and on any surface without the row, an alert still exists: `/course-keeper` shows it.
- Sessions without a person are skipped: `claude -p`, the Agent SDK, sessions that another session drives, and subagents. A session counts as having a person once a prompt arrives from the terminal prompt, from Remote Control, or from its owner in Slack.
- A check reads only the conversation and the vision. It cannot read files or run commands, and it can be wrong. You decide.
- The learn step tests a sentence only on excerpts of this session: the turn you corrected and up to 3 earlier turns. An alert in the test does not prove that the sentence names the right act. Whether an agent that reads the sentence avoids the act is not measured.
- The learn step finds the turn you corrected by the agent's words: the last reply that holds them before your last message, or your last turn when no earlier reply holds them. The draft keeps that turn by the number of your messages up to its start, and `/course-keeper learn yes` tests that turn. When that turn no longer holds the agent's words (a compaction can remove it), `/course-keeper learn yes` keeps nothing.
- An excerpt holds at most 60000 characters of a turn and leaves out the middle of a longer one. When the agent's words fall in that middle, the sentence is shown as not tested and the draft is dropped.
- The learn test tells each excerpt check not to enforce the instructions withdrawn with `/course-keeper forget` up to now. This also applies to an instruction withdrawn after the tested turn.

## Turn it off

- Checks for one session: `/course-keeper off`.
- Everything for a project: remove or rename `VISION.md`.
- Everything everywhere: `claude plugin disable course-keeper`, or `claude plugin uninstall course-keeper`.
