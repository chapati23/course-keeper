---
status: accepted
---

# The Course Keeper alerts the person and never acts on the agent by itself

A check is one model reply about a long session, and it can be wrong. So the Course Keeper only
shows an alert to the person. The note reaches the agent only when the person presses
"Tell the agent", and the plugin never denies, changes or stops the agent's work. The person
keeps the decision, and a wrong alert costs one key press.

## Considered options

- **Send the note to the agent automatically.** Rejected. A wrong note steers the agent away
  from work that the person wanted, and nobody sees it happen.
- **Deny the tool call or stop the turn.** Rejected. The check runs at the end of a turn, after
  the action. A stop on a wrong alert also halts work that the person asked for.

## Consequences

- A session without a person gets no check: nobody could read the alert.
- How often the check is right is not measured yet (2026-11-20). When it is, an automatic note
  that the person switches on is the first change to consider. It needs a new decision record.
