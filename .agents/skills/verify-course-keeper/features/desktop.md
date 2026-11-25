# Alerts in the desktop app

In the Code tab of the Claude desktop app, Course Keeper draws the alert as a compact card above the prompt, not as a frame of characters. The card names the rule, says what the agent did in one sentence, and has the buttons Tell the agent, Details and False alarm, plus a ✕ that dismisses it. It has no number keys. Everything else works as in the terminal: `/course-keeper`, standing instructions, the notice and learn.

The harness does not start the desktop app. A desktop run is a **stand-in**: the harness starts the app's own pinned Claude Code and plays the app's role over the app's protocol. A pass covers what that Claude Code returns for the desktop surface. It does not cover what the app paints.

## Sub-features

- `desktop-load` loads the plugin under the Claude Code build that the desktop app pins.
- `desktop-person` counts a prompt in the app's message format as a person's, and does not count a frame without it.
- `desktop-surface` runs no check before the app attaches its surface, and runs checks after.
- `desktop-card` returns the card for the desktop surface: wheel, headline, ✕, one sentence, three buttons, brand.
- `desktop-card-short` puts the buttons before the sentence in a short band.
- `desktop-details` opens and closes Instead, Agent wrote and the note; the Details button then reads `Hide details`.
- `desktop-tell`, `desktop-false-alarm`, `desktop-dismiss` answer the alert as the terminal buttons do.
- `desktop-notice` sends the standing-instruction notice to the app as a toast message.
- `desktop-notify` hands the desktop notification to the app only when the app has turned its notification handling on.
- `desktop-commands` answers `/course-keeper`, `off`, `on`, `check`, `forget` and `learn`.

## How to get to it (user POV)

- Open a folder in the Code tab of the Claude desktop app, with Course Keeper installed and a `VISION.md` in the project.
- Type a prompt. When the turn breaks a rule, the card appears above the prompt.
- Click `Tell the agent`, `Details`, `False alarm` or the ✕.
- Type `/course-keeper` and its sub-commands in the composer.

## Driving it with control

Preconditions:

- The desktop app has run the Code tab once on this machine, so its Claude Code build is on disk. `control start --surface desktop` finds the newest verified build; `--cli PATH` or `CLAUDE_DESKTOP_BIN` names another one.
- A fresh run from `control start --surface desktop`, and `control doctor "$RUN"` exits 0 with six `ok` lines. The `version` line names the build and says whether it is the app's pinned one.
- A desktop run needs no tmux and works inside a sandboxed shell.

The whole recipe runs as `journeys/desktop` (about 25 seconds, four runs). The steps below show one alert by hand.

- **Script the turn.** As for the terminal: a `haiku` rule (`--when "Decide whether it states a standing instruction" --model haiku --text none`), a main-turn rule with `--unless "Decide whether it states a standing instruction"`, and a check rule on `<final_answer>` with a `verdict: deviation` reply in the format of `prompts/check.md`.
- **Send.** Run `control send "$RUN" "Fix the rounding bug in the invoice exporter."`, then `control wait "$RUN" "[ Tell the agent ]" --row --timeout 45`.
- **Read the card.** Run `control screen "$RUN" --row`. It prints the tree as text, one element per line:

  ```
    ⟨svg: Course Keeper⟩
    Breaks rule: “One module computes every amount”
    [ ✕ ]  ⟨role dismiss⟩
  The agent plans to round invoice totals inside the exporter, …  ⟨maxLines 3: the app shows at most 3 lines; the harness shows the whole text⟩
    [ Tell the agent ]  ⟨variant primary⟩
    [ Details ]
    [ False alarm ]
    Course Keeper
  ```

  `control screen "$RUN" --tree` prints the raw tree. No button carries a hotkey, no button has the focus first, and no text holds `ctrl+x tab`.
- **Second observation.** `control store "$RUN"` holds the alert under `current`. `control requests "$RUN"` lists the main turn, the `haiku` call and the check. `<evidence>/frames.jsonl` holds every frame in both directions; the `ui_render` request carries `maxRows 12`.
- **Details.** Run `control press "$RUN" Details`. The row gains `Instead: …`, `Agent wrote: “…”` and `For the agent: …`, the sentence loses its line limit, and the button reads `[ Hide details ]`. The store holds `"showDetails": true`. Press it again; the parts go.
- **No number keys.** Run `control press "$RUN" 1`. It exits 1 and prints `No drawn Button carries hotkey '1'` with the list of drawn buttons.
- **Tell the agent.** Script a reply for the note and a `verdict: none` check. Run `control press "$RUN" "Tell the agent"`. `control screen "$RUN" --row` prints `(nothing drawn)`. The transcript shows `▸ Prompt from the course-keeper plugin:` and the agent's answer. The next main request holds `The course-keeper plugin sent a message:`. The store records `"answer": "told the agent"`.
- **False alarm.** On a fresh alert run `control press "$RUN" "False alarm"`. The button reads `[ Confirm false alarm ]` and the card stays; the store holds `"confirmFalseAlarm": true`. Run `control press "$RUN" "Confirm false alarm"`. The card goes and the store records `"answer": "intended"`.
- **Dismiss.** On a fresh alert run `control press "$RUN" dismiss` (or `✕`). It prints `✕`. The card goes and the store records `"answer": "dismissed"`.
- **A person.** In a fresh run, `control send "$RUN" --bare "<prompt>"` sends a frame without the app's platform field. The store gets no `hasPerson`, and no `haiku` call or check follows. A normal `control send` sets `hasPerson` and starts both.
- **No surface yet.** Start with `--attach-later`. A turn records `"outcome": "did not run: no surface is attached"` and sends no check. Run `control attach "$RUN"`; it prints `surfaces: ["desktop"]`. The next turn's check runs.
- **Notice.** With a scripted `haiku` reply `- <instruction>`, run `control messages "$RUN" --type ui_toast`. One frame holds `Course Keeper noted a standing instruction: "…"`.
- **Notification.** `control messages "$RUN" --type ui_notify` prints nothing in a normal run; `<evidence>/cli-debug.log` holds one `$.ui.notify (course-keeper) … no-surface` line per alert. In a run started with `--notifications-host`, one `ui_notify` frame carries the title `Course Keeper: this session breaks invariant 1 (One module computes every amount)`.
- **Short band.** Start with `--max-rows 9`. The tree holds the buttons before the sentence.
- **Proof.** `control requests "$RUN" --unscripted` exits 0. Then `control stop "$RUN"`.

### In the real desktop app (not automated)

To see how the app paints the card, use a model-backed session in the app. This costs model usage and changes the person's plugin install, because the app shares the person's user profile. Ask first, and record `claude plugin list` and `claude plugin marketplace list` before you start.

- **Load this checkout.** Run `claude plugin uninstall course-keeper@course-keeper`, `claude plugin marketplace remove course-keeper`, `claude plugin marketplace add <checkout>` and `claude plugin install course-keeper@course-keeper`. In the app session, enter `/reload-plugins`. Return first accepts the suggestion; press Return again only after the composer shows the command.
- **Before each keystroke,** confirm that the app shows your test session, as the global desktop computer-use rule says. The person may be typing in another session.
- **Folder picker.** The app's "Select folder" dialog is drawn by the separate process `com.apple.appkit.xpc.openAndSavePanelService`. Send its keys to that process's window; Cmd+Shift+G opens "Go to folder".
- **What to check.** The card shows the Course Keeper wheel, "Breaks rule: “…”", a ✕, one sentence, the buttons Tell the agent, Details and False alarm, and "Course Keeper" at the row's end. Details opens the note under the buttons, in view, after Instead when the alert has that part and Agent wrote when it has a quote. ✕ closes the alert. Check light and dark.
- **Restore** what you recorded. For the usual user-scoped GitHub install: `claude plugin uninstall course-keeper@course-keeper`, `claude plugin marketplace remove course-keeper` and `claude plugin install course-keeper --marketplace chapati23/course-keeper`. Compare both lists with the recorded ones.

## Gotchas

- **Say "stand-in" in every report.** A pass of `journeys/desktop` shows the tree and the frames that the app's Claude Code returns. It does not show the app.
- **What the stand-in cannot show:** how the app lays out and colors the card, the three-line cut of the sentence, whether the ✕ gets a native close control, the scroll that brings the opened Details into view, the in-app toast, the macOS notification banner, keyboard focus, and clicks. Use the real-app steps above for these.
- **What the stand-in sets up that the app does not.** These stay unverified until a run in the real app covers them:
  - a synthetic API key and a local model endpoint, in place of the app's sign-in and API host;
  - the plugin loaded from this checkout through `CLAUDE_CODE_PLUGIN_DIRS`, in place of an install from a marketplace;
  - an environment without the person's shell variables, and with non-essential traffic off, so server-side feature gates keep their offline defaults;
  - a shorter `initialize` request and argument list than the app sends (no model, effort or settings);
  - `bodyColumns` set by `--columns` (96 by default), where the app measures the width; `maxRows` 12 is the app's value;
  - the surface attached right after start, or on `control attach`; the app attaches when the session view is on screen;
  - `--notifications-host`, which sets by hand what the app sets only under a server-side gate.
- `control screen` text on a desktop run is the harness's own rendering of the tree. The marker line above the row says so. Assert on `--tree` when a detail matters.
- `control press` on a desktop run sends the same message the app sends for a click. `control focus` and `control keys` refuse a desktop run.
- The desktop app pins its own Claude Code version, which can differ from the terminal's. On 2026-11-25 the app pinned 2.1.330 and the terminal ran 2.1.332; the trees were identical on both. Run `journeys/desktop --cli <path>` to try another build.
- The short-band layout needs `maxRows` below 10. The app sends 12, so the app does not use that layout today.
- On the wire the ✕ button carries the label `✕`, although the plugin gives it a text child and no label. The journey accepts both.
- `docs/reference.md` says that Details scrolls the opened parts into view. No scroll message reaches the stand-in, so that promise is not verified here.
- Recorded behavior, not a promise: when a prompt arrives with a leading system-reminder block (`control send --reminder`), the standing-instruction call receives the reminder text together with the person's words. Whether the app adds such a block to ordinary prompts is not known.
- The unit tests (`claude plugin test .`) draw the card on a simulated engine. They cannot show how a surface paints it either.
