# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Engineers and technical founders who run long sessions with an AI coding agent in Claude Code. They are busy with something else while the agent works and want to hear about it when the session leaves the project's intent.

## Product Purpose

Course keeper is a Claude Code plugin. At the end of each turn of the main agent it checks the session against the project's vision file and the person's standing instructions. When the session deviates, it shows an alert above the prompt. Success: the person learns about a deviation at the turn where it happens, not hours later.

## Positioning

It reports to the person and never acts on the agent: it does not deny, change or stop the agent's work. The vision names the acts to avoid, and the check cites the invariant that a session breaks.

## Operating Context

A terminal session, the desktop app or VS Code. The only interface is one alert row above the prompt, a desktop notification, and the `/course-keeper` command. The plugin is open source (MIT) and is listed on a plugin marketplace, where its icon appears at small sizes.

## Capabilities and Constraints

- The check, the standing instructions, `/course-keeper learn`, an optional anti-patterns file.
- The marketplace icon is a square PNG, 512 to 2048 pixels, under 2 MB. The first submitted icon is hard to change.
- The name "Course keeper" is written with a lowercase k.

## Brand Commitments

- A seafaring identity: steering a ship and keeping it on course.
- The logo is a pictorial mark in bold flat shapes: a ship's wheel with eight turned handles, a wide rim and a large solid hub, in cream (`#F4F0E6`) on sea green (`#0F3B36`). The icon is `.claude-plugin/icon.png`; its vector source is `docs/icon.svg`.
- The wheel must stay clearly apart from the Kubernetes logo: never seven spokes, never white on bright blue, never inside a heptagon.
- Rejected directions: abstract geometric marks, a plain glyph on a rounded tile, cropped wheels, and thin-spoke wheels close to the Kubernetes logo.

## Evidence on Hand

No screenshots of a live session yet. Measurements of the check are in the README. No testimonials, customers or usage numbers exist; do not invent any.

## Product Principles

1. Alert the person; never act on the agent.
2. Say what the session breaks, what to do instead, and show the evidence.
3. Stay silent when nothing deviates.
4. State what is measured and what is not.
