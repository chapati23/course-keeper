# Reference

Install, settings, the alert, the command, what is sent to the model, cost and limits. Back to the [README](../README.md).

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

In the Code tab of the Claude desktop app: click **Plugins** (or **Customize**) in the sidebar, then **Add** › **Add marketplace** › **Add from a repository**. Enter `chapati23/course-keeper` and click **Sync**. Then click **+** next to the prompt box and choose **Add plugins**; if the menu shows **Plugins** instead, choose **Plugins** › **Browse plugins**, or **Manage plugins** when **Browse plugins** is missing. Select Course Keeper and choose a scope. The terminal and the desktop app's local sessions read the same settings files: at user scope a plugin installed in one is on in the other for every project, and at project or local scope for that repository only ([plugin install docs](https://code.claude.com/docs/en/plugins/install#choose-an-install-scope)). The desktop app runs its own copy of Claude Code; `/status` in a session shows its version.

## Settings

Course Keeper has two settings. Claude Code asks for them when you install the plugin. To change them later, use the plugin's rows in the `/config` menu.

A value applies to every project on your machine. Claude Code keeps plugin settings in your user settings and ignores them in a project's settings files ([settings reference](https://code.claude.com/docs/en/settings-reference#pluginconfigs)), so you cannot give one project its own file name this way. To choose the anti-patterns file for one project, put the line `<!-- course-keeper: anti-patterns = <path> -->` first in its vision (see [The vision](writing-rules.md#the-vision)). No such line exists for the vision file itself.

| Setting | Default | The file it names |
| --- | --- | --- |
| `visionFile` | `VISION.md` | The file that holds the vision. |
| `antiPatternsFile` | `ANTI-PATTERNS.md` | The optional file that holds the acts to avoid. |

Each value is a path relative to the place where Course Keeper looks for the vision: the root of the repository (the main working tree), or the project root outside a repository. Change a name when the project already has a file of that name that is about something else. An empty value, an absolute path, or a path with `..` or a backslash counts as the default. Course Keeper does not read a file that leads outside the project through a symbolic link; such a file counts as not found. When both settings lead to the same file, Course Keeper reads it as the vision only. The rest of this page uses the default names.

## What you see

When a check finds a deviation, a row above the prompt shows it, as in [the screenshots in the README](../README.md).

The top rule names the invariant, or says that the session breaks your instruction. The next line quotes the invariant's title, or the words of the standing instruction. The title is the invariant's bold lead in VISION.md, or else its first sentence, as the check read it; without a title the line is left out. Each part below starts with its heading in bold. The parts give what the agent did, what the invariant or the instruction asks for instead, and the evidence: what the agent wrote, in quotation marks. The "instead" part is left out when the check gave no such text. An empty line separates the frame from the transcript above and the prompt below. The frame is at most 100 columns wide. When it would not fit the space above the prompt, it drops its empty lines; when it still does not fit, the buttons move into its first line. Either way the buttons stay in view, and their keys work. The quote drops the agent's Markdown marks (`**`, `_`, backticks), so it reads as the transcript shows it.

In the Claude desktop app, and on any surface that draws its own controls, the alert is a compact card instead of a frame of characters. Its one strong line, after the Course Keeper wheel, names the rule ("Breaks rule: “…”"), with a ✕ at its right end that dismisses the alert. One sentence says what the agent did; a long one is cut after three lines until Details opens. Under it are the buttons "Tell the agent" (the main one), Details and False alarm, with Course Keeper in small type at the row's right end. In a short band the buttons come right under the headline, so they stay in view. Details opens what the agent should do instead, what it wrote and the note under the buttons, and scrolls them into view. The card has no number keys, and no button has the focus first, so a stray Enter sends nothing.

The row has four buttons:

- `1 Tell the agent` sends the note to the agent as a message from the plugin. In the terminal it has the focus first, so Enter presses it.
- `2 Details` shows or hides one more part: the note, the text that "Tell the agent" sends.
- `3 False alarm` asks you to press it again ("Confirm false alarm"). The second press closes the alert and records that this is no deviation, or that you wanted it. Later checks are told so, and do not raise it again.
- `4 Dismiss` closes the alert.

In the terminal, press ctrl+x tab (or click the row) to give the row the keyboard, then press a number. In the desktop app, click a button. Course Keeper also raises a desktop notification. In the terminal, the notification is raised. In the desktop app, it arrives only when the app has turned on notifications for the session; otherwise only the row shows the alert. Its title is "Course Keeper: this session breaks invariant 1 (One module computes every amount)", and its text is the sentence about the deviation.

Course Keeper also notes standing instructions: goals or instructions you state in a prompt that stay in force beyond one task. It shows a short notice when it adds one.

## The command

- `/course-keeper` shows whether a VISION.md and a ANTI-PATTERNS.md were found, the standing instructions with their numbers, the alerts of this session with your answers, and the result of the last check. After a `/course-keeper forget`, it also shows the withdrawn instructions in a list "Withdrawn standing instructions:".
- `/course-keeper forget <n>` removes standing instruction n. Later checks are told not to enforce it.
- `/course-keeper check` runs a check now.
- `/course-keeper off` and `/course-keeper on` switch the checks for this session. Standing instructions are still noted while checks are off.
- `/course-keeper learn` drafts one sentence for the vision after you corrected the agent on something that no alert flagged. When the project has a ANTI-PATTERNS.md, a sentence for an existing invariant is for that invariant's section of ANTI-PATTERNS.md; a sentence for a new invariant is always for VISION.md. A copy of the session finds the agent's reply that you corrected and drafts a sentence that starts with "Never". Course Keeper first shows the act and the agent's words, not the sentence. When the agent's words are not found word for word in its replies, it shows nothing of the draft. `/course-keeper learn <what the agent did wrong>` names the act in your words.
- `/course-keeper learn yes` accepts the act. Course Keeper tests the sentence on excerpts of this session and shows it with the results: whether the check alerts on the turn you corrected with the sentence added, and whether it raises new alerts on up to 3 earlier turns. When the check already alerts on that turn with today's vision, on the invariant that the sentence would join, no sentence is offered. An alert of today's vision on another matter of that turn does not stop the test; the results name it. `/course-keeper learn cancel` drops the draft. A learn step in flight then keeps nothing.
- Course Keeper never writes VISION.md or ANTI-PATTERNS.md and sends nothing to the agent. The draft is for the owners of the vision.

## What is sent to the model, and when

- **A check**, at the end of each main-agent turn that ends with an answer. Course Keeper asks one question over a copy of the session: the session's own model gets the conversation as the main thread last sent it, plus the agent's final answer of the turn (the copy does not hold it yet) and the check prompt (`prompts/check.md`) with the text of VISION.md and of ANTI-PATTERNS.md (if there is one), the standing instructions and this session's alerts. The copy has no tools and gives one reply. At most one check runs at a time in a session.
- **A standing-instruction check**, at each prompt you type that has at least 12 characters without the spaces at its start and end, and that does not start with `/` after those spaces. A prompt that starts with a path, such as "/tmp/out is where exports go", gets no such check. The `haiku` model gets `prompts/extract.md` and your whole prompt as it entered the session (after any other plugin changed or dropped it), and nothing else. One prompt adds at most three standing instructions. An instruction that is equal to one in force, apart from case and spacing, is not added again. This happens only in a project that has a VISION.md. It also happens while checks are off for the session.
- **Tell the agent** sends the note to the agent only when you press the button.
- **A learn step**, only when you run `/course-keeper learn`. The session's own model gets a copy of the session (a fork, as for a check, with the agent's final answer of the last turn) with the learn prompt (`prompts/learn.md`), the text of VISION.md and of ANTI-PATTERNS.md (if there is one) and your words, if you gave any. After `/course-keeper learn yes`, separate calls send excerpts of the session to the session's model: the summary that replaced the earlier conversation, if there is one, all your messages up to that turn in order, and the rows of one turn. Each call also holds the check prompt (`prompts/check.md`, with `prompts/excerpt-head.md` in place of its head), and the text of VISION.md and of ANTI-PATTERNS.md (if there is one), with or without the draft sentence. It holds no list of standing instructions: the list held now can hold one that your correction created. Your messages in the excerpt show what was in force at that turn. It holds the instructions you withdrew with `/course-keeper forget`, and the check is told not to enforce them.

Course Keeper keeps the standing instructions and alerts of the last 20 sessions in its store, a file under your Claude Code configuration directory. It sends them nowhere else. When you run `/compact` in a project with a VISION.md, Course Keeper asks the summarizer to keep the standing instructions word for word.

## What it costs

Both calls are billed to the session's credentials and count in `/usage`. A check asks the API to serve the conversation from the session's prompt cache; when that cache entry has lapsed, or after `/model`, it pays for the whole conversation again. The standing-instruction check is one `haiku` call per prompt; it holds your whole prompt, so a long paste costs more. A learn step is one fork, then up to 8 excerpt calls on the session's model. No prompt cache serves an excerpt call, so each one pays for its whole excerpt. Cost figures in Claude Code are estimates.

## Limits

- The plugin API of Claude Code is early access and can change between releases. The plugin needs Claude Code 2.1.323 or later.
- VS Code has no row above the prompt. There, and on any surface without the row, an alert still exists: `/course-keeper` shows it.
- In the desktop app, a plugin you install on your computer for yourself (user or local scope) does not reach cloud sessions, and no plugin runs in WSL sessions.
- Sessions without a person are skipped: `claude -p`, sessions that a program drives through the Agent SDK, sessions that another session drives, and subagents. A session counts as having a person once a prompt arrives from the terminal prompt, from the Code tab of the Claude desktop app, from Remote Control, or from its owner in Slack. The desktop app also runs Claude Code through the Agent SDK, but a prompt that you type there counts.
- A check reads only the conversation and the vision. It cannot read files or run commands, and it can be wrong. You decide.
- The learn step tests a sentence only on excerpts of this session: the turn you corrected and up to 3 earlier turns. An alert in the test does not prove that the sentence names the right act. Whether an agent that reads the sentence avoids the act is not measured.
- The learn step finds the turn you corrected by the agent's words: the last reply that holds them before your last message, or your last turn when no earlier reply holds them. The draft keeps that turn by the number of your messages up to its start, and `/course-keeper learn yes` tests that turn. When that turn no longer holds the agent's words (a compaction can remove it), `/course-keeper learn yes` keeps nothing.
- An excerpt holds at most 60000 characters of a turn and leaves out the middle of a longer one. When the agent's words fall in that middle, the sentence is shown as not tested and the draft is dropped.
- The learn test tells each excerpt check not to enforce the instructions withdrawn with `/course-keeper forget` up to now. This also applies to an instruction withdrawn after the tested turn.
