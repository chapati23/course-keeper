import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CHECK_TEMPLATE =
  '<!-- comment -->\nVision:\n{{vision}}\nInstructions:\n{{standing_instructions}}\nAlerts:\n{{previous_alerts}}\n'
const EXTRACT_TEMPLATE = '<!-- comment -->\nMessage: {{message}}\n'
const VISION = '# Example\n\n1. One service sets every price.\n'
const DEVIATION = [
  '```',
  'verdict: deviation',
  'reference: invariant 1',
  'alert: The session adds a price table to the client, which contradicts invariant 1.',
  'evidence: "I will add a fallback price table in the client."',
  'note: Invariant 1 says one service sets every price. Move the table into that service.',
  '```',
].join('\n')
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}
const BAND = {
  plugin: 'course-keeper',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 11 },
    view: {},
  },
} as const

type Options = {
  /** False: the test answers `$.store` itself. */
  store?: boolean
  /** The fork answers once this resolves; a function is asked per fork (1, 2, ...). */
  forkWait?: Promise<void> | ((n: number) => Promise<void> | undefined)
  /** The check prompt file is read once this resolves. */
  readWait?: Promise<void>
  /** True: a prompt the plugin submits does not enter. */
  refuse?: () => boolean
  /** What the hooks beneath do with a prompt that is not the plugin's. */
  beneath?: (text: string) => { text: string } | { drop: string }
  /** The project root; `/work/repo` when not given. */
  root?: string
  /** What `$.session.repo()` answers: a root, null (no repository) or a failure. */
  repo?: () => string | null | 'fail'
}

/** The engine beneath the plugin, answered from memory. */
function world(on: On, fork: () => string, extract = 'none', options: Options = {}) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  if (options.store !== false) mock.store(on)
  const forks: string[] = []
  const submitted: { text: string; origin: string }[] = []
  const toasts: string[] = []
  const files: Record<string, string> = {
    '/work/repo/VISION.md': VISION,
  }

  on('session.id', () => ({ value: 'session-a' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.root', () => ({ value: options.root ?? '/work/repo' }))
  on('session.repo', () => {
    const root = options.repo === undefined ? '/work/repo' : options.repo()
    if (root === 'fail') return { deny: 'git failed' }

    return {
      value: root === null ? null : { root, remote: null, internal: false, name: null },
    }
  })
  on('fs.read', async (_, e) => {
    if (e.path.endsWith('/prompts/check.md')) {
      await options.readWait

      return { value: CHECK_TEMPLATE }
    }
    if (e.path.endsWith('/prompts/extract.md')) return { value: EXTRACT_TEMPLATE }
    const text = files[e.path]

    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('model.fork', async (_, e) => {
    forks.push(e.prompt)
    const wait = options.forkWait
    await (typeof wait === 'function' ? wait(forks.length) : wait)

    return { value: { isAnswered: true, text: fork(), usage: USAGE } }
  })
  const completions: string[] = []
  on('model.complete', (_, e) => {
    completions.push(e.prompt)

    return { value: { isAnswered: true, text: extract, usage: USAGE } }
  })
  const notified: string[] = []
  on('ui.notify', (_, e) => {
    notified.push(e.text)

    return { value: { isSent: false, reason: 'no-surface' } }
  })
  on('prompt.submit', (_, e) => {
    if (e.origin.kind === 'plugin' && options.refuse?.()) return { drop: 'a Stop stands' }
    const entered =
      e.origin.kind === 'plugin' || options.beneath === undefined
        ? { text: e.text }
        : options.beneath(e.text)
    if ('drop' in entered) return entered
    submitted.push({ text: entered.text, origin: e.origin.kind })

    return entered
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { clock, forks, submitted, files, toasts, completions, notified }
}

async function personTypes($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

const END = {
  answer: 'I will add a fallback price table in the client.',
  durationMs: 10,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer',
} as const

async function settle(clock: { settle: () => Promise<void> }) {
  for (let i = 0; i < 20; i += 1) await clock.settle()
}

async function command($: Engine, args: string): Promise<string> {
  const { text } = await $.command.run({
    command: 'course-keeper',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  return text ?? ''
}

async function status($: Engine): Promise<string> {
  return command($, '')
}

test('a turn ends, the check finds a deviation, the band shows it, Dismiss clears it', async ($, on) => {
  const { clock, forks } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  expect(forks).toHaveLength(1)
  // The fork's request ends before the turn's answer, so the answer comes first.
  expect(forks[0]).toContain(
    '<final_answer>\nI will add a fallback price table in the client.\n</final_answer>\n\nVision:\n# Example',
  )
  expect(forks[0]).toContain('None listed. Use what the person said in this session.')
  expect(forks[0]).toContain('Alerts:\nNone.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /contradicts invariant 1/ }))?.text).toBe(
      'The session adds a price table to the client, which contradicts invariant 1.',
    )
    expect(await ui.find({ type: 'Text', text: /Evidence/ })).toBeUndefined()
    await ui.press({ key: 'details' })
    expect((await ui.find({ type: 'Text', text: /Evidence/ }))?.text).toBe(
      'Evidence: "I will add a fallback price table in the client."',
    )
    await ui.press({ key: 'details' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Course keeper/ })).toBeUndefined()
  await ui.unmount()

  // The same deviation again is not shown again, and the check sees the answer.
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks[1]).toContain("The person's answer: dismissed.")
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /Course keeper/ })).toBeUndefined()
  await again.unmount()
})

test('Tell the agent sends the note as the plugin, not as the person', async ($, on) => {
  const { clock, submitted } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'tell' })
  await settle(clock)

  const sent = submitted.at(-1)
  expect(sent?.origin).toBe('plugin')
  expect(sent?.text).toBe(
    'Course keeper alert on invariant 1. Evidence: "I will add a fallback price table in the client.". ' +
      'Note: Invariant 1 says one service sets every price. Move the table into that service.',
  )
  expect(await ui.find({ type: 'Text', text: /Course keeper/ })).toBeUndefined()
  await ui.unmount()
})

test('no check without a person, for a subagent, after an abort, or without VISION.md', async ($, on) => {
  const { clock, forks, files } = world(on, () => DEVIATION)

  // A session that only an SDK host drives.
  await $.prompt.submit({ text: 'run the job', wait: false, origin: { kind: 'sdk' } })
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(0)
  expect(await status($)).toContain('Last check: none yet.')

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete({ ...END, agentId: 'agent-1' })
  await $.turn.complete({ ...END, isAborted: true, reason: 'aborted' })
  await $.turn.complete({ ...END, reason: 'error' })
  await settle(clock)
  expect(forks).toHaveLength(0)

  delete files['/work/repo/VISION.md']
  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(0)
})

test('a standing instruction is noted, kept through compaction, and forgotten', async ($, on) => {
  const { clock, toasts, forks } = world(
    on,
    () => 'verdict: none',
    '- never post to the tracker without my yes',
  )
  const seen: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    seen.push(e.instructions)

    return { messages: e.messages }
  })

  await personTypes($, 'never post to the tracker without my yes')
  await settle(clock)
  expect(toasts).toEqual([
    'Course keeper noted a standing instruction: "never post to the tracker without my yes"',
  ])
  await $.session.compact({
    trigger: 'manual',
    instructions: 'Focus on the plan.',
    messages: [{ role: 'user', text: 'never post to the tracker without my yes', toolUses: [] }],
  })

  expect(seen).toEqual([
    'Focus on the plan.\n\nKeep these standing instructions of the person word for word in the summary:\n' +
      '1. never post to the tracker without my yes',
  ])

  const { text } = await $.command.run({
    command: 'course-keeper',
    args: 'forget 1',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(text).toBe('Standing instruction 1 removed: "never post to the tracker without my yes"')

  // The check is told not to enforce it, though the conversation still holds it.
  expect(await status($)).toContain(
    'Standing instructions:\n  none\n\n' +
      'Withdrawn standing instructions:\n  - never post to the tracker without my yes\n\n' +
      'Alerts in this session:',
  )
  await $.turn.complete(END)
  await settle(clock)
  expect(forks[0]).toContain(
    'Instructions:\nNone listed. Use what the person said in this session.\n\n' +
      'Withdrawn by the person; do not enforce these:\n' +
      '- never post to the tracker without my yes\nAlerts:',
  )
})

test('the status lists withdrawn instructions only when there are some', async ($, on) => {
  world(on, () => 'verdict: none')

  expect(await status($)).not.toContain('Withdrawn')
})

test('without VISION.md compaction passes its event on unchanged', async ($, on) => {
  const { clock, files } = world(
    on,
    () => 'verdict: none',
    '- never post to the tracker without my yes',
  )
  const seen: (string | undefined)[] = []
  on('session.compact', (_, e) => {
    seen.push(e.instructions)

    return { messages: e.messages }
  })

  await personTypes($, 'never post to the tracker without my yes')
  await settle(clock)
  delete files['/work/repo/VISION.md']
  await $.session.compact({
    trigger: 'manual',
    instructions: 'Focus on the plan.',
    messages: [{ role: 'user', text: 'never post to the tracker without my yes', toolUses: [] }],
  })

  expect(seen).toEqual(['Focus on the plan.'])
})

test('the extract model gets the prompt as the hooks beneath let it enter, and no dropped prompt', async ($, on) => {
  const { clock, forks, completions } = world(on, () => DEVIATION, 'none', {
    beneath: text =>
      text.startsWith('drop:')
        ? { drop: 'refused beneath' }
        : { text: text.replace('KEY-0000-EXAMPLE', '[redacted]') },
  })

  await personTypes($, 'drop: never post to the tracker without my yes')
  await settle(clock)
  expect(completions).toEqual([])
  // A dropped prompt does not mark the session as having a person.
  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(0)

  await personTypes($, 'never paste KEY-0000-EXAMPLE into the tracker')
  await settle(clock)
  expect(completions).toHaveLength(1)
  expect(completions[0]).toContain('Message: never paste [redacted] into the tracker')
  expect(completions[0]).not.toContain('KEY-0000-EXAMPLE')
})

test('VISION.md comes from the main working tree in a repository, from the project root only outside one', async ($, on) => {
  let repo: string | null | 'fail' = '/work/repo'
  const { files } = world(on, () => 'verdict: none', 'none', {
    root: '/work/repo/app',
    repo: () => repo,
  })
  delete files['/work/repo/VISION.md']
  files['/work/repo/app/VISION.md'] = VISION

  expect(await status($)).toContain('VISION.md: not found.')
  repo = 'fail'
  expect(await status($)).toContain('VISION.md: not found.')
  repo = null
  expect(await status($)).toContain('VISION.md: /work/repo/app/VISION.md')
  files['/work/repo/VISION.md'] = VISION
  repo = '/work/repo'
  expect(await status($)).toContain('VISION.md: /work/repo/VISION.md')
})

test('without VISION.md a prompt is not sent for standing instructions', async ($, on) => {
  const { clock, files, toasts, completions } = world(
    on,
    () => 'verdict: none',
    '- never post to the tracker without my yes',
  )
  delete files['/work/repo/VISION.md']

  await personTypes($, 'never post to the tracker without my yes')
  await settle(clock)

  expect(completions).toEqual([])
  expect(toasts).toEqual([])
})

test('a note that does not enter is not recorded as told, and a double press sends once', async ($, on) => {
  let refuse = true
  const { clock, submitted, toasts } = world(on, () => DEVIATION, 'none', {
    refuse: () => refuse,
  })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'tell' })
  await settle(clock)
  expect(toasts.at(-1)).toBe(
    'Course keeper could not send the note to the agent. The alert is shown again.',
  )
  expect(await ui.find({ type: 'Text', text: /contradicts invariant 1/ })).toBeDefined()
  expect(await status($)).toContain('Answer: none yet.')

  refuse = false
  await Promise.all([ui.press({ key: 'tell' }), ui.press({ key: 'tell' })])
  await settle(clock)
  expect(submitted.filter(s => s.origin === 'plugin')).toHaveLength(1)
  expect(await status($)).toContain('Answer: told the agent.')
  await ui.unmount()
})

test('a check in flight blocks the next one', async ($, on) => {
  let release = () => {}
  const forkWait = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, forks } = world(on, () => 'verdict: none', 'none', { forkWait })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks).toHaveLength(1)
  expect(await status($)).toContain('did not run: a check was already running.')

  release()
  await settle(clock)
  await $.turn.complete({ ...END, turnId: 'turn-3' })
  await settle(clock)
  expect(forks).toHaveLength(2)
  expect(await status($)).toContain('verdict: none.')
})

test('an in-flight mark left in state by an earlier copy blocks until it is stale', async ($, on) => {
  const { clock, forks } = world(on, () => 'verdict: none')
  // `$.state` as a hot reload leaves it: the record outlives the copy that
  // wrote it, its in-flight mark included, and no check runs.
  let held: unknown = {
    v: 1,
    hasPerson: true,
    isOff: false,
    instructions: [],
    alerts: [],
    current: null,
    showDetails: false,
    lastCheck: null,
    checkingSince: clock.now() - 1000,
  }
  let version = 1
  on('state.get', () => ({ value: { value: held, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) {
      return { value: { isSet: false, version } }
    }
    held = e.value
    version += 1

    return { value: { isSet: true, version } }
  })

  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(0)
  expect(await status($)).toContain('did not run: a check was already running.')

  held = { ...(held as object), checkingSince: clock.now() - 10 * 60 * 1000 }
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks).toHaveLength(1)
})

test('a full store drops the oldest session and takes the write', async ($, on) => {
  const { clock } = world(on, () => DEVIATION, 'none', { store: false })
  // 20 stored sessions, and a store that refuses a write that takes it past
  // its size limit, as the engine's does at 4 MiB of JSON text.
  const held = new Map<string, unknown>()
  for (let i = 0; i < 20; i += 1) {
    held.set(`session:old-${i}`, { savedAt: i, record: { v: 1, pad: 'x'.repeat(400) } })
  }
  const size = () => JSON.stringify([...held]).length
  // Full: dropping the oldest session before a write makes room for the
  // session's first record, not for the alert it stores later.
  const LIMIT = size()
  on('store.keys', () => ({ value: [...held.keys()] }))
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.delete', (_, e) => {
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.set', (_, e) => {
    const before = held.get(e.key)
    held.set(e.key, e.value)
    if (size() <= LIMIT) return { value: undefined }
    if (before === undefined) held.delete(e.key)
    else held.set(e.key, before)

    return { deny: 'the store is over its size limit' }
  })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  expect(held.has('session:session-a')).toBe(true)
  expect(held.has('session:old-0')).toBe(false)
  expect(held.has('session:old-1')).toBe(false)
  expect(held.size).toBeLessThanOrEqual(20)
})

test('a check whose turn the next turn overtook does not fork', async ($, on) => {
  let release = () => {}
  const readWait = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, forks } = world(on, () => DEVIATION, 'none', { readWait })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.start({ text: 'ok', turnId: 'turn-1' })
  await $.turn.complete(END)
  // A queued prompt starts the next turn while the check still waits.
  await $.turn.start({ text: 'go on', turnId: 'turn-2' })
  release()
  await settle(clock)

  expect(forks).toHaveLength(0)
  expect(await status($)).toContain('did not run: the next turn started first.')
})

test('the store keeps the newest record when an older save is slow', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock } = world(on, () => 'verdict: none', 'none', { store: false })
  const held = new Map<string, unknown>()
  let writes = 0
  on('store.keys', () => ({ value: [...held.keys()] }))
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.delete', (_, e) => {
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.set', async (_, e) => {
    writes += 1
    // The first write stalls until the test lets it through.
    if (writes === 1) await gate
    held.set(e.key, e.value)

    return { value: undefined }
  })

  // First save: the session has a person. Second save: checks are off.
  await personTypes($, 'ok')
  await settle(clock)
  // The answer waits for the saves, so it comes after the release.
  const off = command($, 'off')
  await settle(clock)
  release()
  expect(await off).toBe('Course keeper checks are off for this session.')
  await settle(clock)

  expect(writes).toBe(2)
  expect(held.get('session:session-a')).toMatchObject({
    record: { hasPerson: true, isOff: true },
  })
})

test('/course-keeper off during a check stops its fork; /course-keeper check still runs', async ($, on) => {
  let release = () => {}
  const readWait = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, forks } = world(on, () => 'verdict: none', 'none', { readWait })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  // The check waits for its prompt file while the person turns checks off.
  await command($, 'off')
  release()
  await settle(clock)

  expect(forks).toHaveLength(0)
  expect(await status($)).toContain('did not run: checks are off.')
  expect(await command($, 'check')).toBe('Check finished: verdict: none.')
  expect(forks).toHaveLength(1)
})

test('a check that lost its in-flight mark does not replace a newer alert', async ($, on) => {
  let release = () => {}
  const firstFork = new Promise<void>(resolve => {
    release = resolve
  })
  const OLDER = DEVIATION.replace(
    'alert: The session adds a price table to the client, which contradicts invariant 1.',
    'alert: The session hard-codes a price in the client, which contradicts invariant 1.',
  ).replace(
    'evidence: "I will add a fallback price table in the client."',
    'evidence: "I will hard-code the price in the client."',
  )
  // The newer check's fork answers first, the older one's last.
  let replies = 0
  const { clock, forks } = world(on, () => (++replies === 1 ? DEVIATION : OLDER), 'none', {
    forkWait: n => (n === 1 ? firstFork : undefined),
  })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  // The first check's mark goes stale, so the next turn's check runs.
  await clock.advance(6 * 60 * 1000)
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks).toHaveLength(2)
  release()
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /contradicts invariant 1/ }))?.text).toBe(
    'The session adds a price table to the client, which contradicts invariant 1.',
  )
  await ui.unmount()
  // The dropped reply leaves the newer check's outcome in the status.
  const shown = await status($)
  expect(shown).toMatch(/Last check: [^\n]*, verdict: deviation \(invariant 1\)\./)
  expect(shown).not.toContain('a newer check replaced this one')
})

test('/course-keeper off during the fork of a turn check shows nothing', async ($, on) => {
  let release = () => {}
  const forkWait = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, forks, notified } = world(on, () => DEVIATION, 'none', { forkWait })

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(1)
  // The person turns checks off while the fork runs; then it finds a deviation.
  await command($, 'off')
  release()
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Course keeper/ })).toBeUndefined()
  await ui.unmount()
  expect(notified).toEqual([])
  expect(await status($)).toContain('did not run: checks are off.')
})

test('/course-keeper off answers only after the store holds the change', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock } = world(on, () => 'verdict: none', 'none', { store: false })
  const held = new Map<string, unknown>()
  on('store.keys', () => ({ value: [...held.keys()] }))
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.delete', (_, e) => {
    held.delete(e.key)

    return { value: undefined }
  })
  on('store.set', async (_, e) => {
    // Every write stalls until the test lets it through.
    await gate
    held.set(e.key, e.value)

    return { value: undefined }
  })

  let storedAtAnswer: unknown
  let isAnswered = false
  const off = command($, 'off').then(text => {
    storedAtAnswer = held.get('session:session-a')
    isAnswered = true

    return text
  })
  await settle(clock)
  expect(isAnswered).toBe(false)
  release()
  expect(await off).toBe('Course keeper checks are off for this session.')
  expect(storedAtAnswer).toMatchObject({ record: { isOff: true } })
})

test('a withdrawn instruction stated again is no longer withdrawn when the list is full', async ($, on) => {
  const { clock, toasts } = world(on, () => 'verdict: none', '- never use npm')
  let held: unknown = {
    v: 1,
    hasPerson: true,
    isOff: false,
    instructions: Array.from({ length: 30 }, (_, i) => `instruction number ${i + 1}`),
    withdrawn: ['never use npm'],
    alerts: [],
    current: null,
    showDetails: false,
    lastCheck: null,
    checkingSince: null,
  }
  let version = 1
  on('state.get', () => ({ value: { value: held, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) {
      return { value: { isSet: false, version } }
    }
    held = e.value
    version += 1

    return { value: { isSet: true, version } }
  })
  expect(await status($)).toContain('Withdrawn standing instructions:\n  - never use npm')

  await personTypes($, 'never use npm in this repository')
  await settle(clock)

  // The list is full, so nothing is added and no notice shows.
  expect(toasts).toEqual([])
  expect(await status($)).not.toContain('Withdrawn')
  expect(held).toMatchObject({ withdrawn: [] })
})
