# Course Keeper

A Claude Code plugin that checks a coding session against the project's vision and the person's standing instructions, and alerts the person when the session deviates from them.

## Language

### What a session is held to

**Vision**:
The project's short statement of what it is and what every change must keep true, kept by default as `VISION.md` at the repository root.
_Avoid_: mission, north star, principles

**Invariant**:
One testable statement in the vision that a session must not contradict, usually numbered. An alert cites it by its number, or by its own words when the vision has no numbers.
_Avoid_: rule, principle, guideline

**Anti-patterns file**:
An optional file, kept by default as `ANTI-PATTERNS.md` beside the vision, that holds the sentences that name acts to avoid, in one section for each invariant. An act named there breaks that invariant.
_Avoid_: examples, appendix, rule book

**Standing instruction**:
A goal or an instruction that the person stated in a session and that stays in force beyond the task it was given with.
_Avoid_: preference, constraint, reminder

**Tracked drift**:
An existing departure from an invariant that the project's owners know about and have recorded.
_Avoid_: exception, known issue, violation

### What happens in a session

**Deviation**:
A new action or decision in a session that contradicts an invariant or a standing instruction. Tracked drift is not a deviation.
_Avoid_: drift, violation, misalignment

**Check**:
One comparison of a session's work with the vision and the standing instructions.
_Avoid_: scan, review, audit

**Alert**:
The short message shown to the person when a check finds a deviation. It cites the invariant by its number or quotes the standing instruction.
_Avoid_: warning, notification, heads-up

**Note**:
The text of an alert passed on to the agent at the person's request.
_Avoid_: correction, nudge, feedback

**Catch**:
A deviation that the person corrected in a session and that no alert flagged first.
_Avoid_: miss, false negative, incident

**Draft sentence**:
One sentence that starts with "Never" and names the act of a catch, offered to the owners of the vision. Course Keeper does not add it to the vision.
_Avoid_: rule, fix, patch

### Who is involved

**Person**:
The human who directs a session and receives its alerts.
_Avoid_: user, operator, human

**Agent**:
The AI that does a session's work.
_Avoid_: model, assistant, worker

**Course Keeper**:
The component that runs checks and raises alerts. It reports to the person and does not act on the agent's work.
_Avoid_: observer, advisor, monitor, sidecar, guard
