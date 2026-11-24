# Inspect and switch session checks

A person can see which vision the plugin reads and turn automatic checks off or on for the current session.

## Sub-features

- Read the current status.
- Turn automatic checks off.
- Restore automatic checks.

## How to get to it (user POV)

At the Claude Code terminal prompt, enter `/course-keeper`, `/course-keeper off` or `/course-keeper on`.

## Driving it with session-proof

Preconditions: Start a fresh terminal through the helper in [Launch](../SKILL.md#launch).

- **Status.** Enter `/course-keeper`. Verify the fixture's absolute vision path and initial on state.
- **Off.** Enter `/course-keeper off`. Read the acknowledgement. Run status again. Verify the off state and the true value of `isOff` in the plugin store.
- **On.** Enter `/course-keeper on`. Verify the acknowledgement, the new on status and the false value in the store.

## Gotchas

The switch controls automatic checks for one session. The manual check command and standing-instruction extraction have separate entry points.
