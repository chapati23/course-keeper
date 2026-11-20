// Course keeper: checks the main agent's work against the project's vision
// and the person's standing instructions at the end of each turn, and
// alerts the person when the session deviates from them.
//
// Every hook passes its event on and catches its own errors. Course keeper
// never denies or rewrites a tool call and never rewrites the person's
// prompt. The only event it changes is `session.compact`, where it adds to
// the summarizer's instructions.

import type { EngineInterface, Register, SessionRepo } from 'claude-code'

import type { CourseKeeperAlert, CourseKeeperSession } from '../types'
import {
  addInstructions,
  addWithdrawn,
  addedNotice,
  answerCurrent,
  applyReply,
  compactInstructions,
  fillCheckPrompt,
  fillExtractPrompt,
  forgetInstruction,
  formatAlerts,
  formatInstructions,
  isCheckRunning,
  isPersonOrigin,
  noteText,
  normalizeRecord,
  oldestKeys,
  parseCheckReply,
  parseExtractReply,
  removeWithdrawn,
  restoreUnsent,
  shouldExtract,
  statusText,
  stripLeadingComment,
  withFinalAnswer,
  withOutcome,
} from './logic'

type $ = EngineInterface

const SESSION = { plugin: 'course-keeper', key: 'session' } as const
const STORE_PREFIX = 'session:'
const MAX_STORED_SESSIONS = 20
const USAGE =
  'Usage: /course-keeper, /course-keeper check, /course-keeper forget <n>, ' +
  '/course-keeper off, /course-keeper on'

// The main loop's latest turns as the hooks heard them. Module variables: a
// hot reload clears them, and a check then runs without the final answer and
// without the next-turn test below. A check reads them before its first wait.
let startedTurn: string | undefined
let endedTurn: { turnId: string; answer: string } | undefined

async function load(
  $: $,
  id: string,
): Promise<{ record: CourseKeeperSession; version: number }> {
  const held = await $.state.get({ ...SESSION, id })
  if (held.version > 0) {
    return { record: normalizeRecord(held.value), version: held.version }
  }
  // Nothing in `$.state` yet: a new session, or one that restarted.
  let stored: unknown
  try {
    stored = await $.store.get(STORE_PREFIX + id)
  } catch {
    stored = undefined
  }
  const record =
    typeof stored === 'object' && stored !== null && 'record' in stored
      ? stored.record
      : undefined

  // A check that was in flight before the restart is not running now.
  return { record: { ...normalizeRecord(record), checkingSince: null }, version: 0 }
}

/** The time each of these stored sessions was saved. */
async function savedTimes(
  $: $,
  keys: readonly string[],
): Promise<{ key: string; savedAt: number }[]> {
  return Promise.all(
    keys.map(async key => {
      const value = await $.store.get(key)
      const savedAt =
        typeof value === 'object' &&
        value !== null &&
        'savedAt' in value &&
        typeof value.savedAt === 'number'
          ? value.savedAt
          : 0

      return { key, savedAt }
    }),
  )
}

// The saves of this copy of the module, one after another in the order they
// were asked for, so an older snapshot never lands after a newer one.
let saving: Promise<void> = Promise.resolve()

/** Queues a write of the session's record to the store, after earlier ones. */
function save($: $, id: string, record: CourseKeeperSession): Promise<void> {
  saving = saving.then(() => saveNow($, id, record))

  return saving
}

/**
 * Writes the session's record to the store. The oldest sessions are dropped
 * before the write, so a full store cannot block it. When the store refuses
 * the write (it holds at most 4 MiB of JSON text), the oldest other session
 * is dropped and the write is tried once more; each later refusal drops one
 * more, so the store shrinks until it takes the record. Never rejects.
 */
async function saveNow($: $, id: string, record: CourseKeeperSession) {
  const own = STORE_PREFIX + id
  try {
    const value = { savedAt: await $.clock.now(), record }
    let others = (await $.store.keys()).filter(
      key => key.startsWith(STORE_PREFIX) && key !== own,
    )
    if (others.length > MAX_STORED_SESSIONS - 1) {
      const drop = oldestKeys(await savedTimes($, others), MAX_STORED_SESSIONS - 1)
      for (const key of drop) await $.store.delete(key)
      others = others.filter(key => !drop.includes(key))
    }
    try {
      await $.store.set(own, value)
    } catch {
      const [oldest] = oldestKeys(await savedTimes($, others), others.length - 1)
      if (oldest === undefined) return
      await $.store.delete(oldest)
      await $.store.set(own, value)
    }
  } catch {
    // The store failed: `$.state` still holds the record for this session.
  }
}

/** Reads, changes and writes the session's record; retries when beaten. */
async function change(
  $: $,
  id: string,
  fn: (record: CourseKeeperSession) => CourseKeeperSession,
): Promise<CourseKeeperSession> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { record, version } = await load($, id)
    const next = fn(record)
    if (next === record) return record
    const written = await $.state.set({ ...SESSION, id }, next, {
      ifVersion: version,
    })
    if (written.isSet) {
      // Not awaited: `$.state` holds the record now, and a slow store does
      // not hold up this change or the saves queued after it.
      void save($, id, next)

      return next
    }
  }
  throw new Error('course keeper: the session record kept changing')
}

async function readPrompt($: $, name: 'check' | 'extract'): Promise<string> {
  return stripLeadingComment(await $.fs.read(`${$.plugin.root}/prompts/${name}.md`))
}

/**
 * VISION.md at the repository's main working tree; at the project root only
 * when the session is in no repository. When `repo()` fails, whether there
 * is a repository is unknown, and there is no vision.
 */
async function readVision($: $): Promise<{ path: string; text: string } | undefined> {
  let repo: SessionRepo | null
  try {
    repo = await $.session.repo()
  } catch {
    return undefined
  }
  const dir = repo === null ? await $.session.root() : repo.root
  const path = `${dir.replace(/\/+$/, '')}/VISION.md`
  try {
    return { path, text: await $.fs.read(path) }
  } catch {
    // Missing or unreadable.
    return undefined
  }
}

async function record($: $, id: string, outcome: string): Promise<string> {
  const now = await $.clock.now()
  let text = outcome
  await change($, id, r => {
    const done = withOutcome(r, outcome, now)
    text = done.outcome

    return done.record
  })

  return text
}

/**
 * One check. From a turn it runs only in a session where a person typed a
 * prompt, a surface is attached and checks are on; from `/course-keeper
 * check` it runs at once. Resolves the outcome.
 */
async function check($: $, trigger: 'turn' | 'command'): Promise<string> {
  // Read before the first wait: from a turn, this is that turn's end.
  const turn = endedTurn
  const id = await $.session.id()

  if (trigger === 'turn') {
    const { record: held } = await load($, id)
    if (!held.hasPerson) return 'did not run: no person has typed a prompt'
    if (held.isOff) return record($, id, 'did not run: checks are off')
    if ((await $.session.surfaces()).length === 0) {
      return record($, id, 'did not run: no surface is attached')
    }
  }

  // At most one check in flight per session. The mark lives in `$.state`, so
  // a hot reload keeps it; a mark older than CHECK_STALE_MS counts as lost.
  const started = await $.clock.now()
  let isBusy = false
  await change($, id, r => {
    isBusy = isCheckRunning(r.checkingSince, started)

    return isBusy ? r : { ...r, checkingSince: started }
  })
  if (isBusy) return record($, id, 'did not run: a check was already running')

  try {
    return await runCheck($, id, trigger, turn, started)
  } catch {
    return record($, id, 'did not run: course keeper failed (a prompt file or a call)')
  } finally {
    await change($, id, r =>
      r.checkingSince === started ? { ...r, checkingSince: null } : r,
    ).catch(() => undefined)
  }
}

async function runCheck(
  $: $,
  id: string,
  trigger: 'turn' | 'command',
  turn: { turnId: string; answer: string } | undefined,
  started: number,
): Promise<string> {
  const vision = await readVision($)
  if (vision === undefined) return record($, id, 'did not run: no VISION.md found')

  const template = await readPrompt($, 'check')
  const { record: held } = await load($, id)
  const prompt = fillCheckPrompt(template, {
    vision: vision.text,
    instructions: formatInstructions(held.instructions, held.withdrawn),
    alerts: formatAlerts(held),
  })
  // `/course-keeper off` may have come during the waits above. A check that
  // a turn started stops here; one the person asked for runs anyway.
  if (trigger === 'turn' && held.isOff) {
    return record($, id, 'did not run: checks are off')
  }
  // The fork sends the main thread's last request again. If the next turn
  // started during the waits above, that request is the next turn's, not
  // the one this check is for: skip, and let the next turn's end check it.
  // Nothing waits between these tests and the fork.
  if (turn !== undefined && startedTurn !== undefined && startedTurn !== turn.turnId) {
    return record($, id, 'did not run: the next turn started first')
  }
  const reply = await $.model.fork({
    prompt: withFinalAnswer(prompt, turn?.answer ?? ''),
  })

  if (!reply.isAnswered) {
    return record(
      $,
      id,
      reply.reason === 'nothing-to-fork'
        ? 'did not run: nothing to fork yet'
        : `did not run: the fork ended with ${reply.reason}`,
    )
  }

  const parsed = parseCheckReply(reply.text)
  const now = await $.clock.now()
  let outcome = ''
  let shown: string | undefined
  await change($, id, r => {
    // A check that took longer than CHECK_STALE_MS lost its in-flight mark,
    // and a newer check may have started and shown its own alert since.
    if (r.checkingSince !== started) {
      const done = withOutcome(r, 'did not run: a newer check replaced this one', now)
      outcome = done.outcome
      shown = undefined

      return done.record
    }
    const done = applyReply(r, parsed, now)
    outcome = done.outcome
    shown = done.shown?.alert

    return done.record
  })
  if (shown !== undefined) {
    try {
      await $.ui.notify(shown, { title: 'Course keeper' })
    } catch {
      // No notification on this surface, or it was refused: the band shows it.
    }
  }

  return outcome
}

/** At a person's prompt: mark the session, then look for standing instructions. */
async function notePrompt(
  $: $,
  text: string,
  isCommand: boolean,
  isMeta: boolean,
): Promise<void> {
  const id = await $.session.id()
  await change($, id, r => (r.hasPerson ? r : { ...r, hasPerson: true }))
  if (!shouldExtract(text, isCommand, isMeta)) return
  // Without a vision no check runs, so nothing would use the instruction:
  // in such a project course keeper sends nothing to any model.
  if ((await readVision($)) === undefined) return

  const template = await readPrompt($, 'extract')
  const reply = await $.model.complete({
    model: 'haiku',
    prompt: fillExtractPrompt(template, text),
  })
  if (!reply.isAnswered) return
  const candidates = parseExtractReply(reply.text)
  if (candidates.length === 0) return

  let added: string[] = []
  await change($, id, r => {
    const done = addInstructions(r.instructions, candidates)
    added = done.added

    // An instruction the person states again is no longer withdrawn.
    return added.length === 0
      ? r
      : {
          ...r,
          instructions: done.list,
          withdrawn: removeWithdrawn(r.withdrawn ?? [], added),
        }
  })
  if (added.length > 0) $.ui.toast(addedNotice(added))
}

async function runCommand($: $, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const id = await $.session.id()

  switch (verb.toLowerCase()) {
    case '': {
      const vision = await readVision($)
      const { record: held } = await load($, id)

      return statusText(held, vision?.path)
    }
    case 'check':
      return `Check finished: ${await check($, 'command')}.`
    case 'off':
      await change($, id, r => (r.isOff ? r : { ...r, isOff: true }))

      return 'Course keeper checks are off for this session.'
    case 'on':
      await change($, id, r => (r.isOff ? { ...r, isOff: false } : r))

      return 'Course keeper checks are on for this session.'
    case 'forget': {
      let removed: string | undefined
      await change($, id, r => {
        const done = forgetInstruction(r.instructions, rest[0] ?? '')
        removed = done?.removed

        // Kept, so the check is told not to enforce it from the conversation.
        return done === undefined
          ? r
          : {
              ...r,
              instructions: done.list,
              withdrawn: addWithdrawn(r.withdrawn ?? [], done.removed),
            }
      })

      return removed === undefined
        ? `No standing instruction ${rest[0] ?? ''}. ${USAGE}`
        : `Standing instruction ${rest[0]} removed: "${removed}"`
    }
    default:
      return USAGE
  }
}

/** Answers the current alert, if it is still the one the person saw. */
async function answer(
  $: $,
  id: string,
  shownAt: number,
  kind: 'intended' | 'dismissed',
) {
  return change($, id, r =>
    r.current?.shownAt === shownAt ? answerCurrent(r, kind) : r,
  )
}

/**
 * "Tell the agent": records the answer, then sends the note. Only the press
 * that answered the alert sends it, so a second quick press sends nothing.
 * When the note does not enter the session, the alert is shown again.
 */
async function tell($: $, id: string, shownAt: number) {
  let alert: CourseKeeperAlert | undefined
  await change($, id, r => {
    alert = r.current?.shownAt === shownAt ? r.current : undefined

    return alert === undefined ? r : answerCurrent(r, 'told the agent')
  })
  if (alert === undefined) return

  let isSent = false
  try {
    // Framed by the engine as "The course-keeper plugin sent a message",
    // never as the person's words.
    const result = await $.prompt.submit({ text: noteText(alert) })
    isSent = result.drop === undefined
  } catch {
    isSent = false
  }
  if (isSent) return

  await change($, id, r => restoreUnsent(r, shownAt))
  $.ui.toast('Course keeper could not send the note to the agent. The alert is shown again.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      // A literal name, so that validate reads the command.run hook below as
      // answering its own command.
      await $.command.register({
        name: 'course-keeper',
        description:
          'Course keeper: show the vision, standing instructions and alerts',
        argumentHint: '[check | forget <n> | off | on]',
      })
    } catch {
      // Without the command, the band still shows alerts.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // The hooks beneath decide first: a prompt they drop starts nothing, and
    // one they rewrite (a secret redacted, say) is read as it entered.
    const entered = await next(e)
    try {
      if (entered.drop === undefined && isPersonOrigin(e.origin.kind)) {
        // Not awaited: the prompt does not wait for course keeper.
        void notePrompt(
          $,
          entered.text,
          e.command !== undefined,
          e.isMeta === true,
        ).catch(() => undefined)
      }
    } catch {
      // Ignore: course keeper never holds up a prompt.
    }

    return entered
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) startedTurn = e.turnId

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        endedTurn = { turnId: e.turnId, answer: e.answer }
        if (e.reason === 'answer' && !e.isAborted) {
          // Not awaited: the turn ends while the check runs.
          void check($, 'turn').catch(() => undefined)
        }
      }
    } catch {
      // Ignore: course keeper never holds up a turn.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    let passed = e
    try {
      if (e.agentId === undefined) {
        const { record: held } = await load($, await $.session.id())
        const instructions = compactInstructions(e.instructions, held.instructions)
        // Without a vision course keeper does nothing in the project.
        if (instructions !== undefined && (await readVision($)) !== undefined) {
          passed = { ...e, instructions }
        }
      }
    } catch {
      passed = e
    }

    return next(passed)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'course-keeper' }, async ($, e) => ({
    text: await runCommand($, e.args),
    isTextDisplayOnly: true,
  })).catch(() => ({
    text: 'Course keeper could not run that command.',
    isTextDisplayOnly: true,
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let tree: JSX.Element | undefined
    try {
      if (!e.props.hasSurvey) {
        const id = await $.session.id()
        const { record: held } = await load($, id)
        const shown = held.current
        if (shown !== null) {
          const { Box, Button, Text } = $.ui.resolve(e)
          const at = shown.shownAt
          tree = (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text color="warning">▲ </Text>
                <Text bold>Course keeper</Text>
                <Text dimColor> · {shown.reference}</Text>
              </Box>
              <Text>{shown.alert}</Text>
              {held.showDetails && <Text dimColor>Evidence: "{shown.evidence}"</Text>}
              {held.showDetails && <Text dimColor>Note: {shown.note}</Text>}
              <Box flexDirection="row" gap={2}>
                <Button
                  key="details"
                  plain
                  hotkey="1"
                  label="Details"
                  onPress={() =>
                    change($, id, r =>
                      r.current?.shownAt === at
                        ? { ...r, showDetails: !r.showDetails }
                        : r,
                    ).catch(() => undefined)
                  }
                />
                <Button
                  key="tell"
                  plain
                  hotkey="2"
                  label="Tell the agent"
                  onPress={() => tell($, id, at).catch(() => undefined)}
                />
                <Button
                  key="intended"
                  plain
                  hotkey="3"
                  label="Intended"
                  onPress={() =>
                    answer($, id, at, 'intended').catch(() => undefined)
                  }
                />
                <Button
                  key="dismiss"
                  plain
                  hotkey="0"
                  label="Dismiss"
                  role="dismiss"
                  onPress={() =>
                    answer($, id, at, 'dismissed').catch(() => undefined)
                  }
                />
              </Box>
            </Box>
          )
        }
      }
    } catch {
      tree = undefined
    }

    return tree ?? next(e)
  }).catch(($, e, next) => next(e))
}
