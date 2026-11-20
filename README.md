# Course keeper

Course keeper is a Claude Code plugin. At the end of each turn of the main agent, it checks the session against the project's vision and the person's standing instructions. When the session deviates from them, it shows an alert above the prompt.

Course keeper reports to the person. It does not deny, change or stop the agent's work.

## The vision

Course keeper reads `VISION.md` at the root of the repository (the main working tree), or at the project root when the session is not in a repository. Without the file, course keeper does nothing in that project: no check runs, no standing instruction is noted, and nothing is sent to a model.

The vision is a short statement of what the project is and a numbered list of invariants: testable statements that a session must not contradict. An alert cites an invariant by its number. For example:

```markdown
# Vision

A command-line tool that turns timesheets into invoices.

1. One module computes every amount. No other code does arithmetic on money.
2. The tool never sends an invoice. It writes files; the person sends them.
3. Every change keeps the test suite green on the three supported platforms.

Tracked drift: the old exporter still rounds amounts itself (invariant 1).
```

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

## What you see

When a check finds a deviation, a row above the prompt shows the invariant or the instruction, one sentence about the deviation, and four buttons:

- `1 Details` shows or hides the evidence (a quote from the agent) and the note.
- `2 Tell the agent` sends the note to the agent as a message from the plugin.
- `3 Intended` records that you wanted this, so the check does not raise it again.
- `0 Dismiss` closes the alert.

Press ctrl+x tab (or click the row) to give the row the keyboard, then press a number. Course keeper also raises a desktop notification where Claude Code offers one.

Course keeper also notes standing instructions: goals or instructions you state in a prompt that stay in force beyond one task. It shows a short notice when it adds one.

## The command

- `/course-keeper` shows whether a VISION.md was found, the standing instructions with their numbers, the alerts of this session with your answers, and the result of the last check.
- `/course-keeper forget <n>` removes standing instruction n.
- `/course-keeper check` runs a check now.
- `/course-keeper off` and `/course-keeper on` switch the checks for this session. Standing instructions are still noted while checks are off.

## What is sent to the model, and when

- **A check**, at the end of each main-agent turn that ends with an answer. Course keeper asks one question over a copy of the session: the session's own model gets the conversation as the main thread last sent it, plus the agent's final answer of the turn (the copy does not hold it yet) and the check prompt (`prompts/check.md`) with the text of VISION.md, the standing instructions and this session's alerts. The copy has no tools and gives one reply. At most one check runs at a time in a session.
- **A standing-instruction check**, at each prompt you type that is not a slash command and has at least 12 characters. The `haiku` model gets `prompts/extract.md` and your whole prompt, and nothing else. This happens only in a project that has a VISION.md. It also happens while checks are off for the session.
- **Tell the agent** sends the note to the agent only when you press the button.

Course keeper keeps the standing instructions and alerts of the last 20 sessions in its store, a file under your Claude Code configuration directory. It sends them nowhere else.

## What it costs

Both calls are billed to the session's credentials and count in `/usage`. A check asks the API to serve the conversation from the session's prompt cache; when that cache entry has lapsed, or after `/model`, it pays for the whole conversation again. The standing-instruction check is one `haiku` call per prompt; it holds your whole prompt, so a long paste costs more. Cost figures in Claude Code are estimates.

## Limits

- The plugin API of Claude Code is early access and can change between releases. The plugin needs Claude Code 2.1.323 or later.
- VS Code has no row above the prompt. There, and on any surface without the row, an alert still exists: `/course-keeper` shows it.
- Sessions without a person are skipped: `claude -p`, the Agent SDK, sessions that another session drives, and subagents. A session counts as having a person once a prompt arrives from the terminal prompt, from Remote Control, or from its owner in Slack.
- A check reads only the conversation and the vision. It cannot read files or run commands, and it can be wrong. You decide.

## Turn it off

- Checks for one session: `/course-keeper off`.
- Everything for a project: remove or rename `VISION.md`.
- Everything everywhere: `claude plugin disable course-keeper`, or `claude plugin uninstall course-keeper`.
