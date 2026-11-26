import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const CHECK_TEMPLATE =
  '<!-- comment -->\nVision:\n{{vision}}\nInstructions:\n{{standing_instructions}}\nAlerts:\n{{previous_alerts}}\n'
const EXTRACT_TEMPLATE = '<!-- comment -->\nMessage: {{message}}\n'
const LEARN_TEMPLATE = '<!-- one -->\n\n<!-- two -->\n\nCatch: {{catch}}\nVision to learn: {{vision}}\n'
const EXCERPT_HEAD = '<!-- comment -->\n\n<system-reminder>\nExcerpt head.\n</system-reminder>\n'
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
    maxRows: 40,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 39 },
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
  /** The extract model answers once this resolves. */
  extractWait?: Promise<void>
  /** A `$.model.complete` call answers once this resolves; asked per call (1, 2, ...). */
  completeWait?: (n: number) => Promise<void> | undefined
  /** True: a prompt the plugin submits does not enter. */
  refuse?: () => boolean
  /** What the hooks beneath do with a prompt that is not the plugin's. */
  beneath?: (text: string) => { text: string } | { drop: string }
  /** The project root; `/work/repo` when not given. */
  root?: string
  /** What `$.session.repo()` answers: a root, null (no repository) or a failure. */
  repo?: () => string | null | 'fail'
  /** What `$.session.messages()` answers. */
  messages?: () => SessionMessage[]
  /** What `$.session.model()` answers, or a failure. */
  model?: () => string | 'fail'
  /**
   * The reply of a `$.model.complete` call that is not the extract call:
   * `unanswered` for a call cut before a reply, `fail` for a call that fails.
   */
  complete?: (prompt: string) => string | undefined
}

/** The engine beneath the plugin, answered from memory. */
function world(
  on: On,
  fork: (prompt: string) => string,
  extract = 'none',
  options: Options = {},
) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  if (options.store !== false) mock.store(on)
  const forks: string[] = []
  const submitted: { text: string; origin: string }[] = []
  const toasts: string[] = []
  const files: Record<string, string> = {
    '/work/repo/VISION.md': VISION,
  }
  // Symbolic links: a path, or a folder above it, and where it leads.
  const links: Record<string, string> = {}
  const resolve = (path: string): string => {
    for (const [from, to] of Object.entries(links)) {
      if (path === from || path.startsWith(`${from}/`)) return resolve(to + path.slice(from.length))
    }

    return path
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
    if (e.path.endsWith('/prompts/learn.md')) return { value: LEARN_TEMPLATE }
    if (e.path.endsWith('/prompts/excerpt-head.md')) return { value: EXCERPT_HEAD }
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"version":"0.1.0"}' }
    const text = files[resolve(e.path)]

    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('fs.stat', (_, e) => {
    const real = resolve(e.path)
    const isFile = files[real] !== undefined
    const isDir =
      !isFile &&
      (real === (options.root ?? '/work/repo') ||
        Object.keys(files).some(key => key.startsWith(`${real}/`)))
    if (!isFile && !isDir) return { deny: 'ENOENT' }

    return {
      value: {
        kind: isFile ? 'file' : 'dir',
        size: isFile ? (files[real] ?? '').length : 0,
        mtimeMs: 0,
        isLink: real !== e.path,
        realPath: real,
      },
    }
  })
  on('model.fork', async (_, e) => {
    forks.push(e.prompt)
    const wait = options.forkWait
    await (typeof wait === 'function' ? wait(forks.length) : wait)

    return { value: { isAnswered: true, text: fork(e.prompt), usage: USAGE } }
  })
  const completions: string[] = []
  const models: string[] = []
  on('model.complete', async (_, e) => {
    const prompt = e.prompt
    completions.push(prompt)
    models.push(e.model)
    await options.completeWait?.(completions.length)
    const own = options.complete?.(prompt)
    if (own === 'unanswered') {
      return { value: { isAnswered: false, reason: 'aborted', usage: USAGE } }
    }
    if (own === 'fail') return { deny: 'the API is down' }
    if (own !== undefined) return { value: { isAnswered: true, text: own, usage: USAGE } }
    await options.extractWait

    return { value: { isAnswered: true, text: extract, usage: USAGE } }
  })
  on('session.messages', () => ({ value: options.messages?.() ?? [] }))
  on('session.model', () => {
    const model = options.model?.() ?? 'session-model'

    return model === 'fail' ? { deny: 'no model' } : { value: model }
  })
  const notified: string[] = []
  on('ui.notify', (_, e) => {
    notified.push(e.title === undefined ? e.text : `${e.title}\n${e.text}`)

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

  return { clock, forks, submitted, files, links, toasts, completions, notified, models }
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

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** One element as the terminal writes it; a plain Button reads `hotkey: label`. */
function lineOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object' || node === null) return ''
  const { type, props = {}, children = [] } = node as Drawn
  if (type === 'Button' && typeof props.label === 'string') {
    return typeof props.hotkey === 'string' ? `${props.hotkey}: ${props.label}` : props.label
  }

  return children.map(lineOf).join('')
}

/**
 * The lines a node draws: a column Box stacks its children, `marginTop`
 * adds an empty line above, `paddingLeft` indents; any other node is one line.
 */
function linesOf(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return [lineOf(node)]
  const { type, props = {}, children = [] } = node as Drawn
  if (type !== 'Box') return [lineOf(node)]
  const inner =
    props.flexDirection === 'column'
      ? children.flatMap(linesOf)
      : [children.map(lineOf).join('')]
  const pad = ' '.repeat(typeof props.paddingLeft === 'number' ? props.paddingLeft : 0)

  return [
    ...(typeof props.marginTop === 'number' && props.marginTop > 0 ? [''] : []),
    ...inner.map(l => (l === '' ? l : pad + l)),
    ...(typeof props.marginBottom === 'number' && props.marginBottom > 0 ? [''] : []),
  ]
}

/** The band's row, one string per line, as the terminal draws it. */
async function rowLines(ui: {
  find: (query: { type: string }) => Promise<unknown>
}): Promise<string[]> {
  const outer = await ui.find({ type: 'Box' })

  return outer === undefined ? [] : linesOf(outer)
}

/** The frame's rules at the test band's 80 columns. */
const TOP = (banner: string) => {
  const head = `── ▲ ${banner} · Course Keeper `

  return head + '─'.repeat(80 - head.length)
}
const BOTTOM = '─'.repeat(80)
const ACTIONS =
  '  1: Tell the agent · 2: Details · 3: False alarm · 4: Dismiss · ctrl+x tab'

/** The row for DEVIATION with the test's VISION. */
const ROW = [
  '',
  TOP('Session breaks invariant 1'),
  '  Your rule: “One service sets every price”',
  '',
  '  What your agent did: The session adds a price table to the client, which contradicts invariant 1.',
  '',
  '  Agent wrote: “I will add a fallback price table in the client.”',
  '',
  ACTIONS,
  BOTTOM,
  '',
]

/** The same alert as a surface that draws its own controls shows it: a card. */
const CARD = [
  'Breaks rule: “One service sets every price”✕',
  'The session adds a price table to the client, which contradicts invariant 1.',
  'Tell the agentDetailsFalse alarmCourse Keeper',
]

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

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await rowLines(terminal)).toEqual(ROW)
  await terminal.unmount()
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await rowLines(desktop)).toEqual(CARD)
  await desktop.unmount()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Course Keeper/ })).toBeUndefined()
  await ui.unmount()

  // The same deviation again is not shown again, and the check sees the answer.
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks[1]).toContain("The person's answer: dismissed.")
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /Course Keeper/ })).toBeUndefined()
  await again.unmount()
})

test('Details shows the text for the agent as one more part, and hides it again', async ($, on) => {
  const { clock } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'details' })
  expect(await rowLines(ui)).toEqual([
    ...ROW.slice(0, 7),
    '',
    '  For the agent: Invariant 1 says one service sets every price. Move the table into that service.',
    ...ROW.slice(7),
  ])
  await ui.press({ key: 'details' })
  expect(await rowLines(ui)).toEqual(ROW)
  await ui.unmount()
})

test('Tell the agent is on key 1 and takes the focus first, Details is on key 2', async ($, on) => {
  const { clock } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const tellButton = await ui.find({ type: 'Button', key: 'tell' })
  expect(tellButton?.props.hotkey).toBe('1')
  expect(tellButton?.props.autoFocus).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'details' }))?.props.hotkey).toBe('2')
  await ui.unmount()
})

test('the frame is drawn at most 100 cells wide', async ($, on) => {
  const { clock } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, bodyColumns: 160 },
  })
  const lines = await rowLines(ui)
  expect(lines[1]).toHaveLength(100)
  expect(lines.at(-2)).toBe('─'.repeat(100))
  await ui.unmount()
})

test('a band too short for the frame drops its empty lines, so the actions stay in view', async ($, on) => {
  const { clock } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, maxRows: 9 },
  })
  expect(await rowLines(ui)).toEqual(ROW.filter(line => line !== ''))
  await ui.unmount()
})

test('a band too short even for the compact frame draws the buttons in its first line', async ($, on) => {
  const { clock } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, maxRows: 5 },
  })
  const lines = await rowLines(ui)
  // The buttons are in the band's first line, so their hotkeys answer.
  expect(lines).toEqual([
    `▲ Invariant 1 · ${ACTIONS.trim()}`,
    ...ROW.slice(2, 8).filter(line => line !== ''),
    BOTTOM,
  ])
  await ui.unmount()
})

test('a long instruction that wraps in a narrow band counts its rows, so the buttons move up', async ($, on) => {
  const words = 'never add a price table, a cache or a fallback to the client'
  const { clock } = world(on, () =>
    DEVIATION.replace('reference: invariant 1', `reference: instruction "${words}"`),
  )

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  // At 40 cells the top rule takes 2 rows and the instruction line 3: the
  // compact frame needs about 13 rows, more than the band's 12.
  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, bodyColumns: 40, maxRows: 12 },
  })
  expect((await rowLines(ui))[0]).toBe(`▲ Your instruction · ${ACTIONS.trim()}`)
  await ui.unmount()
})

test('False alarm asks for a second press before it records the answer', async ($, on) => {
  const { clock } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'false-alarm' })
  expect((await ui.find({ type: 'Button', key: 'false-alarm' }))?.props.label).toBe(
    'Confirm false alarm',
  )
  expect(await status($)).not.toContain('Answer: false alarm')
  // Dismiss still answers as dismissed, not as a false alarm.
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  expect(await status($)).toContain('Answer: dismissed')
})

test('Dismiss is on key 4 and False alarm on key 3, which later checks read as a false alarm', async ($, on) => {
  const { clock, forks, notified } = world(on, () => DEVIATION)

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  // The notification has the row's headline and the alert sentence.
  expect(notified).toEqual([
    'Course Keeper: this session breaks invariant 1 (One service sets every price)\n' +
      'The session adds a price table to the client, which contradicts invariant 1.',
  ])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'dismiss' }))?.props.hotkey).toBe('4')
  expect((await ui.find({ type: 'Button', key: 'false-alarm' }))?.props.hotkey).toBe('3')
  await ui.press({ key: 'false-alarm' })
  await ui.press({ key: 'false-alarm' })
  expect(await ui.find({ type: 'Text', text: /Course Keeper/ })).toBeUndefined()
  await ui.unmount()

  expect(await status($)).toContain(
    'Answer: false alarm (the person says this is no deviation, or wanted it).',
  )
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks[1]).toContain(
    "The person's answer: false alarm (the person says this is no deviation, or wanted it).",
  )
})

test('an instead field draws as its own part between the alert and the quote', async ($, on) => {
  const { clock } = world(on, () =>
    DEVIATION.replace('evidence:', 'instead: Move the table into the price service.\nevidence:'),
  )

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await rowLines(ui)).toEqual(
      surface === 'terminal'
        ? [
            ...ROW.slice(0, 5),
            '',
            '  What it should do instead: Move the table into the price service.',
            ...ROW.slice(5),
          ]
        : // On the card, "instead" waits behind Details.
          CARD,
    )
    // Not dim: it weighs as much as the alert.
    expect((await ui.find({ type: 'Text', text: /^Move the table into/ }))?.props.dimColor).toBeUndefined()
    await ui.unmount()
  }
})

// \$.ui.scroll raises no ui.scroll event in this harness (Claude Code 2.1.332),
// so the Details scroll is checked live in the desktop app, not here.
test('on desktop the card fits the band, opens Details under the buttons, takes no focus first and has no number keys', async ($, on) => {
  const { clock } = world(on, () =>
    DEVIATION.replace(
      'evidence: "I will add a fallback',
      'instead: Move the table into the price service.\nevidence: "I will **add** a `fallback`',
    ),
  )

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // By default: the headline, one sentence and the buttons, nothing more.
  expect(await rowLines(ui)).toEqual(CARD)
  // A short band puts the buttons right under the headline.
  const short = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, maxRows: 6 } })
  expect(await rowLines(short)).toEqual([CARD[0], CARD[2], CARD[1]])
  await short.unmount()
  // Closed, a long sentence keeps to three lines.
  expect((await ui.find({ type: 'Text', text: /^The session adds/ }))?.props.maxLines).toBe(3)
  await ui.press({ key: 'details' })
  expect((await ui.find({ type: 'Text', text: /^The session adds/ }))?.props.maxLines).toBeUndefined()
  const lines = await rowLines(ui)
  // The buttons hold their place; the parts open under them.
  expect(lines.slice(0, 2)).toEqual(CARD.slice(0, 2))
  expect(lines[2]).toBe('Tell the agentHide detailsFalse alarmCourse Keeper')
  expect(lines.slice(3, 5)).toEqual([
    'Instead: Move the table into the price service.',
    // The quote reads as the transcript shows it, without Markdown marks.
    'Agent wrote: \u201cI will add a fallback price table in the client.\u201d',
  ])
  expect(lines[5]).toMatch(/^For the agent: /)
  expect(lines.join('\n')).not.toContain('ctrl+x tab')
  expect(lines.join('\n')).not.toContain('\u2500')
  const tell = await ui.find({ key: 'tell' })
  expect(tell?.props.variant).toBe('primary')
  expect(tell?.props.autoFocus).toBeUndefined()
  expect(tell?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'dismiss' }))?.props.role).toBe('dismiss')
  // The close mark in the corner dismisses the alert.
  await ui.press({ key: 'dismiss' })
  await settle(clock)
  expect(await rowLines(ui)).toEqual([])
  await ui.unmount()
})

test('an instruction reference quotes the words in the headline', async ($, on) => {
  const { clock } = world(on, () =>
    DEVIATION.replace('reference: invariant 1', 'reference: instruction "never add a table to the client"'),
  )

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await rowLines(ui)).slice(1, 3)).toEqual([
    TOP('Session breaks your instruction'),
    '  Your instruction: “never add a table to the client”',
  ])
  await ui.unmount()
})

test('a vision with bullet rules gets an alert that quotes the rule on every surface', async ($, on) => {
  const { clock, files, notified } = world(on, () =>
    DEVIATION.replace('reference: invariant 1', 'reference: invariant "One service sets every price."'),
  )
  files['/work/repo/VISION.md'] = '# Example\n\n- One service sets every price.\n'

  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)

  expect(notified[0]?.split('\n')[0]).toBe(
    'Course Keeper: this session breaks your rule "One service sets every price"',
  )
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await rowLines(terminal)).slice(1, 3)).toEqual([
    TOP('Session breaks your rule'),
    '  Your rule: “One service sets every price”',
  ])
  await terminal.unmount()
  const tight = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 5 } })
  expect((await rowLines(tight))[0]).toBe(`▲ Your rule · ${ACTIONS.trim()}`)
  await tight.unmount()
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await rowLines(desktop))[0]).toBe(CARD[0])
  await desktop.unmount()
})

test('an alert stored before alerts kept a title still draws, without a title', async ($, on) => {
  world(on, () => 'verdict: none')
  // A record as an earlier version wrote it: the alert has no title field.
  let held: unknown = {
    v: 1,
    hasPerson: true,
    isOff: false,
    instructions: [],
    alerts: [],
    current: {
      reference: 'invariant 1',
      alert: 'The session adds a price table to the client, which contradicts invariant 1.',
      evidence: 'I will add a fallback price table in the client.',
      note: 'Move the table into that service.',
      shownAt: 1,
      answer: null,
    },
    showDetails: false,
    lastCheck: null,
    checkingSince: null,
  }
  let version = 1
  on('state.get', () => ({ value: { value: held, version } }))
  on('state.set', (_, e) => {
    held = e.value
    version += 1

    return { value: { isSet: true, version } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // No title: no "Your rule" line.
    expect(await rowLines(ui)).toEqual(
      surface === 'terminal'
        ? [ROW[0], ROW[1], ...ROW.slice(3)]
        : [
            'Session breaks invariant 1✕',
            CARD[1],
            'Tell the agentDetailsFalse alarmCourse Keeper',
          ],
    )
    await ui.unmount()
  }
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
    'Course Keeper alert on invariant 1. Evidence: "I will add a fallback price table in the client." ' +
      'Note: Invariant 1 says one service sets every price. Move the table into that service.',
  )
  expect(await ui.find({ type: 'Text', text: /Course Keeper/ })).toBeUndefined()
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
    'Course Keeper noted a standing instruction: "never post to the tracker without my yes"',
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

test('the extract model gets the person\'s words without the leading system-reminder blocks', async ($, on) => {
  const { clock, completions } = world(on, () => 'verdict: none')
  const block = '<system-reminder>\nAlways answer in French.\n</system-reminder>\n\n'

  // Without the blocks: nothing, a short reply and a path at the start.
  for (const rest of [block, 'ok go on', '/tmp/out is where exports go']) {
    await personTypes($, `${block}${rest}`)
    await settle(clock)
  }
  expect(completions).toEqual([])

  await personTypes($, `${block}never post to the tracker without my yes`)
  await settle(clock)
  expect(completions).toHaveLength(1)
  expect(completions[0]).toContain('Message: never post to the tracker without my yes\n')
  expect(completions[0]).not.toContain('system-reminder')
  expect(completions[0]).not.toContain('Always answer in French.')
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
    'Course Keeper could not send the note to the agent. The alert is shown again.',
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
  expect(await off).toBe('Course Keeper checks are off for this session.')
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
    'What your agent did: The session adds a price table to the client, which contradicts invariant 1.',
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
  expect(await ui.find({ type: 'Text', text: /Course Keeper/ })).toBeUndefined()
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
  expect(await off).toBe('Course Keeper checks are off for this session.')
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

test('/course-keeper forget during the extract call is not undone by its reply', async ($, on) => {
  let release = () => {}
  const extractWait = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, toasts, completions } = world(on, () => 'verdict: none', '- never use npm', {
    extractWait,
  })
  let held: unknown = {
    v: 1,
    hasPerson: true,
    isOff: false,
    instructions: ['never use npm'],
    withdrawn: [],
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

  // The prompt states the instruction again; its reply waits.
  await personTypes($, 'never use npm in this repository')
  await settle(clock)
  expect(completions).toHaveLength(1)
  expect(await command($, 'forget 1')).toBe('Standing instruction 1 removed: "never use npm"')
  release()
  await settle(clock)

  expect(toasts).toEqual([])
  expect(held).toMatchObject({ instructions: [], withdrawn: ['never use npm'] })
  expect(await status($)).toContain(
    'Standing instructions:\n  none\n\nWithdrawn standing instructions:\n  - never use npm',
  )
})

test('/course-keeper check after the next turn started runs without the earlier answer', async ($, on) => {
  const { clock, forks } = world(on, () => 'verdict: none')

  // No person typed a prompt, so the turn's end starts no check of its own.
  await $.turn.start({ text: 'ok', turnId: 'turn-1' })
  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(0)
  // Before the next turn starts, the command sends the turn's answer.
  expect(await command($, 'check')).toBe('Check finished: verdict: none.')
  expect(forks[0]).toContain(END.answer)

  await $.turn.start({ text: 'go on', turnId: 'turn-2' })
  expect(await command($, 'check')).toBe('Check finished: verdict: none.')
  expect(forks).toHaveLength(2)
  expect(forks[1]).not.toContain(END.answer)
  expect(forks[1]).not.toContain('<final_answer>')
})

test('a store that refuses the write takes it after two old sessions are dropped', async ($, on) => {
  const { clock } = world(on, () => 'verdict: none', 'none', { store: false })
  const held = new Map<string, unknown>()
  for (let i = 0; i < 5; i += 1) {
    held.set(`session:old-${i}`, { savedAt: i, record: { v: 1 } })
  }
  let deleted = 0
  on('store.keys', () => ({ value: [...held.keys()] }))
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.delete', (_, e) => {
    held.delete(e.key)
    deleted += 1

    return { value: undefined }
  })
  on('store.set', (_, e) => {
    // Room for the session's record only after two sessions are gone.
    if (e.key === 'session:session-a' && deleted < 2) {
      return { deny: 'the store is over its size limit' }
    }
    held.set(e.key, e.value)

    return { value: undefined }
  })

  await personTypes($, 'ok')
  await settle(clock)

  expect(held.has('session:old-0')).toBe(false)
  expect(held.has('session:old-1')).toBe(false)
  expect(['session:old-2', 'session:old-3', 'session:old-4'].every(key => held.has(key))).toBe(
    true,
  )
  expect(held.get('session:session-a')).toMatchObject({ record: { hasPerson: true } })
})

const ROWS: SessionMessage[] = [
  { role: 'user', text: 'Plan the pricing.', toolUses: [] },
  { role: 'assistant', text: 'I will keep prices in the service.', toolUses: [] },
  { role: 'user', text: 'Now add the checkout.', toolUses: [] },
  { role: 'assistant', text: 'I will add a fallback price\n table in the client.', toolUses: [] },
  { role: 'user', text: 'No, prices come from the service.', toolUses: [] },
  { role: 'assistant', text: 'You are right.', toolUses: [] },
]
const SENTENCE =
  'Never keep a price table in the client, for example a fallback table: ask the service.'
const DRAFT = [
  'result: draft',
  'quote: "I will add a fallback price table in the client."',
  'act: The agent planned a price table in the client.',
  'forms: planning it, building it',
  'variant: The agent caches discounts in the client.',
  'place: invariant 1',
  `sentence: ${SENTENCE}`,
  'allowed: Showing a price that the service sent.',
].join('\n')
const SHOWN = [
  'Course Keeper read this as the act you corrected:',
  '  The agent planned a price table in the client.',
  'The agent\'s words: "I will add a fallback price table in the client."',
  '',
  'If this is the act: /course-keeper learn yes',
  'If it is not: /course-keeper learn <what the agent did wrong, in your words>',
  'To drop it: /course-keeper learn cancel',
].join('\n')
const NO_DRAFT = 'No draft sentence waits for an answer. Run /course-keeper learn first.'

function deviation(evidence: string, reference = 'invariant 1') {
  return [
    'verdict: deviation',
    `reference: ${reference}`,
    'alert: The session keeps prices outside the service.',
    `evidence: "${evidence}"`,
    'note: Keep prices in the service.',
  ].join('\n')
}

/** An excerpt check's reply: by turn, and by whether the sentence is in the vision. */
function excerptReplies(replies: {
  failing: [today: string, added: string]
  earlier?: [today: string, added: string]
}) {
  return (prompt: string) => {
    if (!prompt.includes('Excerpt head.')) return undefined
    const pair = prompt.includes("## The agent's latest turn\n\nINPUT: Now add the checkout.")
      ? replies.failing
      : replies.earlier ?? ['verdict: none', 'verdict: none']

    return prompt.includes(SENTENCE) ? pair[1] : pair[0]
  }
}

const learnFork = (other = 'verdict: none') => (prompt: string) =>
  prompt.includes('Catch:') ? DRAFT : other

test('learn drafts a sentence, shows the act, and tests it on excerpts of the session', async ($, on) => {
  const { forks, completions, models } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptReplies({
      failing: ['verdict: none', deviation('I will add a fallback price table in the client.')],
      earlier: ['verdict: none', deviation('I will keep prices in the service.')],
    }),
  })

  expect(await command($, 'learn')).toBe(SHOWN)
  expect(forks).toHaveLength(1)
  // Both leading comments are gone; the fields are filled.
  expect(forks[0]).toBe(
    "Catch: The person gave no words with the request. Take the person's most recent correction of the agent as the catch.\n" +
      'Vision to learn: # Example\n\n1. One service sets every price.\n\n',
  )
  expect(completions).toEqual([])

  const report = await command($, 'learn yes')
  expect(report).toBe(
    [
      'Draft sentence for VISION.md, invariant 1:',
      `  ${SENTENCE}`,
      '',
      'Test on the turn you corrected: the check alerts with this sentence added.',
      'Test on 1 earlier turn of this session: 1 new alert: "I will keep prices in the service." Read it: such an alert can be sound.',
      'Must stay allowed: Showing a price that the service sent.',
      '',
      'Where it comes from: the agent\'s words "I will add a fallback price table in the client."; drafted 2023-11-14 UTC by session-model; Course Keeper 0.1.0.',
      '',
      'This is a draft for the owners of VISION.md. Course Keeper does not change the file.',
      '- An alert in the test does not prove that the sentence names the right act. Compare it with what you corrected.',
      '- Widen or narrow it before you add it. In a measurement on 8 recorded catches, 4 of 16 drafts were',
      '  too broad and 4 too narrow.',
      '- Whether an agent that reads the sentence avoids the act is not measured.',
    ].join('\n'),
  )
  // Control, verify, the earlier turn with the sentence, and its control.
  expect(completions).toHaveLength(4)
  expect(models).toEqual(Array(4).fill('session-model'))
  const verify = completions.find(
    p => p.includes(SENTENCE) && p.includes('INPUT: Now add the checkout.'),
  )
  expect(verify).toContain(
    '<system-reminder>\nExcerpt head.\n</system-reminder>\n\nVision:\n# Example\n\n' +
      `1. One service sets every price.\n   ${SENTENCE}\n`,
  )
  expect(verify).toContain(
    '\n\n# The session excerpts\n\n## Messages the person sent, oldest first\n\n' +
      'Plan the pricing.\n\nNow add the checkout.\n\n' +
      "## The agent's latest turn\n\nINPUT: Now add the checkout.\n\n" +
      'AGENT: I will add a fallback price\n table in the client.',
  )
  expect(verify).not.toContain('No, prices come from the service.')

  // The draft is gone; checks and alerts are untouched; nothing reached the agent.
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
  const shown = await status($)
  expect(shown).toContain('Alerts in this session:\n  none')
  expect(shown).toContain('Last check: none yet.')
})

test('learn passes the person\'s words as the catch', async ($, on) => {
  const { forks } = world(on, learnFork(), 'none', { messages: () => ROWS })

  expect(await command($, 'learn   it put a price\ntable in the client ')).toBe(SHOWN)
  expect(forks[0]).toContain(
    'Catch: The person described the act in these words: "it put a price table in the client"\n',
  )
})

test('a draft whose quote is not in the agent\'s replies is not shown', async ($, on) => {
  const { forks } = world(on, learnFork(), 'none', {
    messages: () => ROWS.map(r => (r.role === 'assistant' ? { ...r, text: 'Other words.' } : r)),
  })

  const answer = await command($, 'learn')
  expect(answer).toContain("The draft quoted words that are not in the agent's replies")
  expect(answer).not.toContain('price table')
  expect(forks).toHaveLength(1)
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
})

test('learn without VISION.md runs nothing', async ($, on) => {
  const { forks, files } = world(on, learnFork(), 'none', { messages: () => ROWS })
  delete files['/work/repo/VISION.md']

  expect(await command($, 'learn')).toBe(
    'No VISION.md found. /course-keeper learn does not run without it.',
  )
  expect(forks).toHaveLength(0)
})

test('a none reply and a malformed reply are said plainly', async ($, on) => {
  let reply = 'result: none\nreason: The person asked for a matter of taste.'
  world(on, () => reply, 'none', { messages: () => ROWS })

  expect(await command($, 'learn')).toBe(
    'No sentence drafted: The person asked for a matter of taste.\n' +
      'To give the act in your words: /course-keeper learn <what the agent did wrong>',
  )
  reply = 'result: draft\nquote: "x"'
  expect(await command($, 'learn')).toContain('No sentence drafted: the draft reply was malformed.')
})

test('learn yes stops when the check already alerts on the turn with today\'s vision', async ($, on) => {
  const { completions } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptReplies({
      failing: [deviation('I will add a fallback price table in the client.'), 'verdict: none'],
    }),
  })

  await command($, 'learn')
  const answer = await command($, 'learn yes')
  expect(answer).toBe(
    "The check already alerts on the turn you corrected with today's vision (invariant 1): " +
      'The session keeps prices outside the service. Evidence: "I will add a fallback price table in the client." ' +
      'If this alert is about the act you corrected, the vision already covers the act, so no sentence is offered. ' +
      'If the alert is about another matter, run /course-keeper learn <the act in words> again. The draft is dropped.',
  )
  expect(answer).not.toContain(SENTENCE)
  expect(completions).toHaveLength(1)
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
})

const ANTI_PATTERNS = '# Anti-patterns\n\n## 1. One service sets every price\n\n- Never compute a discount in the client.\n'

test('the anti-patterns file beside VISION.md goes into the check and the status', async ($, on) => {
  const { clock, forks, files } = world(on, () => 'verdict: none')
  files['/work/repo/ANTI-PATTERNS.md'] = ANTI_PATTERNS

  expect(await status($)).toContain(
    'VISION.md: /work/repo/VISION.md\nANTI-PATTERNS.md: /work/repo/ANTI-PATTERNS.md\n',
  )
  await personTypes($, 'ok')
  await settle(clock)
  await $.turn.complete(END)
  await settle(clock)
  expect(forks[0]).toContain(
    'Vision:\n# Example\n\n1. One service sets every price.\n\n' +
      '# Anti-patterns: acts that break the invariants above\n',
  )
  expect(forks[0]).toContain(`invariant.\n\n${ANTI_PATTERNS}\nInstructions:`)

  // Without VISION.md the anti-patterns file alone runs nothing.
  delete files['/work/repo/VISION.md']
  const shown = await status($)
  expect(shown).toContain('VISION.md: not found.')
  expect(shown).not.toContain('ANTI-PATTERNS.md')
  await $.turn.complete({ ...END, turnId: 'turn-2' })
  await settle(clock)
  expect(forks).toHaveLength(1)
})

test('the status says when a bullet vision has an anti-patterns file', async ($, on) => {
  const { files } = world(on, () => 'verdict: none')
  files['/work/repo/ANTI-PATTERNS.md'] = ANTI_PATTERNS
  expect(await status($)).not.toContain('no numbered list')

  files['/work/repo/VISION.md'] = '# Example\n\n- One service sets every price.\n'
  expect(await status($)).toContain(
    'ANTI-PATTERNS.md: /work/repo/ANTI-PATTERNS.md\n  VISION.md has no numbered list. The sections of ' +
      'ANTI-PATTERNS.md and the learn step find an invariant only by its number.\nChecks:',
  )
})

test('with an anti-patterns file, a sentence for an invariant is tested in the anti-patterns file', async ($, on) => {
  let reply = DRAFT
  const { forks, files, completions } = world(
    on,
    prompt => (prompt.includes('Catch:') ? reply : 'verdict: none'),
    'none',
    {
      messages: () => ROWS,
      complete: excerptReplies({
        failing: ['verdict: none', deviation('I will add a fallback price table in the client.')],
      }),
    },
  )
  files['/work/repo/ANTI-PATTERNS.md'] = ANTI_PATTERNS

  await command($, 'learn')
  expect(forks[0]).toContain(`Vision to learn: # Example\n\n1. One service sets every price.\n\n# Anti-patterns:`)
  expect(forks[0]).toContain(ANTI_PATTERNS)
  const report = await command($, 'learn yes')
  expect(report).toContain(`Draft sentence for ANTI-PATTERNS.md, under invariant 1:\n  ${SENTENCE}\n`)
  expect(report).toContain(
    'This is a draft for the owners of ANTI-PATTERNS.md and VISION.md. Course Keeper does not change the files.',
  )
  const verify = completions.find(p => p.includes(SENTENCE))
  expect(verify).toContain(
    'Vision:\n# Example\n\n1. One service sets every price.\n\n# Anti-patterns:',
  )
  expect(verify).toContain(`- Never compute a discount in the client.\n- ${SENTENCE}\n`)

  // A new invariant still goes into VISION.md, and the report says so.
  reply = DRAFT.replace('place: invariant 1', 'place: new')
  await command($, 'learn')
  const again = await command($, 'learn yes')
  expect(again).toContain('Draft sentence for VISION.md, as a new invariant:')
  expect(again).toContain('This is a draft for the owners of VISION.md. Course Keeper does not change the file.')
  expect(completions.at(-1)).toContain(`2. ${SENTENCE}\n\n# Anti-patterns:`)
})

test(
  'the configured files are the ones the check reads and the texts name',
  { options: { visionFile: 'docs/course.md', antiPatternsFile: 'docs/avoid.md' } },
  async ($, on) => {
    const { forks, files } = world(on, prompt => (prompt.includes('Catch:') ? DRAFT : 'verdict: none'), 'none', {
      messages: () => ROWS,
    })
    files['/work/repo/ANTI-PATTERNS.md'] = '# Not read\n'

    // VISION.md at the default place is not the vision now.
    expect(await status($)).toContain('docs/course.md: not found. No checks run without it.')
    expect(await command($, 'check')).toBe('Check finished: did not run: no docs/course.md found.')
    expect(await command($, 'learn')).toBe(
      'No docs/course.md found. /course-keeper learn does not run without it.',
    )
    expect(forks).toHaveLength(0)

    files['/work/repo/docs/course.md'] = '# Course\n\n1. One service sets every price.\n'
    files['/work/repo/docs/avoid.md'] = ANTI_PATTERNS
    const shown = await status($)
    expect(shown).toContain(
      'docs/course.md: /work/repo/docs/course.md\ndocs/avoid.md: /work/repo/docs/avoid.md\n',
    )
    expect(shown).not.toContain('VISION.md')
    await command($, 'check')
    expect(forks[0]).toContain('Vision:\n# Course\n\n1. One service sets every price.\n\n# Anti-patterns:')
    expect(forks[0]).toContain(ANTI_PATTERNS)
    expect(forks[0]).not.toContain('# Example')
    expect(forks[0]).not.toContain('# Not read')

    await command($, 'learn')
    expect(await command($, 'learn yes')).toContain(
      'This is a draft for the owners of docs/avoid.md and docs/course.md.',
    )
  },
)

test(
  'an invalid file name falls back to the default',
  { options: { visionFile: '../VISION.md', antiPatternsFile: '/etc/passwd' } },
  async ($, on) => {
    const { files } = world(on, () => 'verdict: none')
    files['/work/repo/ANTI-PATTERNS.md'] = ANTI_PATTERNS

    expect(await status($)).toContain(
      'VISION.md: /work/repo/VISION.md\nANTI-PATTERNS.md: /work/repo/ANTI-PATTERNS.md\n',
    )
  },
)

test(
  'two names that lead to the same file read it once, as the vision',
  { options: { antiPatternsFile: 'avoid.md' } },
  async ($, on) => {
    const { forks, files, links } = world(on, () => 'verdict: none')
    links['/work/repo/avoid.md'] = '/work/repo/VISION.md'

    expect(await status($)).toContain('VISION.md: /work/repo/VISION.md\nChecks:')
    await command($, 'check')
    expect(forks[0]).not.toContain('# Anti-patterns:')

    // Once it is a file of its own, it is read.
    delete links['/work/repo/avoid.md']
    files['/work/repo/avoid.md'] = ANTI_PATTERNS
    expect(await status($)).toContain('avoid.md: /work/repo/avoid.md\nChecks:')
  },
)

test('a file that a link leads outside the project counts as not found', async ($, on) => {
  const { forks, files, links } = world(on, () => 'verdict: none')
  files['/elsewhere/ANTI-PATTERNS.md'] = '# Secret\n'
  links['/work/repo/ANTI-PATTERNS.md'] = '/elsewhere/ANTI-PATTERNS.md'

  // The anti-patterns file outside: the vision alone.
  expect(await status($)).toContain('VISION.md: /work/repo/VISION.md\nChecks:')
  await command($, 'check')
  expect(forks[0]).not.toContain('# Secret')

  // The vision file itself outside: no vision, and nothing is sent.
  files['/elsewhere/VISION.md'] = '# Secret vision\n'
  links['/work/repo/VISION.md'] = '/elsewhere/VISION.md'
  expect(await status($)).toContain('VISION.md: not found.')
  expect(await command($, 'check')).toBe('Check finished: did not run: no VISION.md found.')
  expect(forks).toHaveLength(1)
})

test(
  'a configured vision behind a linked folder outside the project is not read',
  { options: { visionFile: 'docs/VISION.md' } },
  async ($, on) => {
    const { forks, files, links } = world(on, () => 'verdict: none')
    files['/elsewhere/docs/VISION.md'] = '# Secret vision\n'
    links['/work/repo/docs'] = '/elsewhere/docs'

    expect(await status($)).toContain('docs/VISION.md: not found.')
    expect(await command($, 'check')).toBe('Check finished: did not run: no docs/VISION.md found.')
    expect(forks).toHaveLength(0)

    // A link that stays inside the project is followed.
    files['/work/repo/notes/VISION.md'] = VISION
    links['/work/repo/docs'] = '/work/repo/notes'
    expect(await status($)).toContain('docs/VISION.md: /work/repo/docs/VISION.md')
  },
)

const NAMED = `<!-- course-keeper: anti-patterns = docs/vision/avoid.md -->\n${VISION}`

test(
  'the anti-patterns file that the vision names wins over the setting, and the texts name it',
  { options: { antiPatternsFile: 'docs/setting.md' } },
  async ($, on) => {
    const { forks, files } = world(on, prompt => (prompt.includes('Catch:') ? DRAFT : 'verdict: none'), 'none', {
      messages: () => ROWS,
    })
    files['/work/repo/VISION.md'] = NAMED
    files['/work/repo/docs/setting.md'] = '# Not read\n'
    files['/work/repo/ANTI-PATTERNS.md'] = '# Not read either\n'
    files['/work/repo/docs/vision/avoid.md'] = ANTI_PATTERNS

    expect(await status($)).toContain(
      'VISION.md: /work/repo/VISION.md\n' +
        'docs/vision/avoid.md: /work/repo/docs/vision/avoid.md (named in VISION.md)\nChecks:',
    )
    await command($, 'check')
    // The directive stays in the vision text that the model gets.
    expect(forks[0]).toContain(`Vision:\n${NAMED}\n# Anti-patterns:`)
    expect(forks[0]).toContain(ANTI_PATTERNS)
    expect(forks[0]).not.toContain('# Not read')

    await command($, 'learn')
    expect(await command($, 'learn yes')).toContain(
      'This is a draft for the owners of docs/vision/avoid.md and VISION.md.',
    )

    // A missing file: the status says so, and the vision alone is used.
    delete files['/work/repo/docs/vision/avoid.md']
    expect(await status($)).toContain(
      'VISION.md: /work/repo/VISION.md\n' +
        'docs/vision/avoid.md: not found or not readable (named in VISION.md). The vision alone is used.\nChecks:',
    )
    await command($, 'check')
    expect(forks.at(-1)).not.toContain('# Anti-patterns:')

    // Without the directive, the setting is in force again at the next read.
    files['/work/repo/VISION.md'] = VISION
    files['/work/repo/docs/setting.md'] = ANTI_PATTERNS
    expect(await status($)).toContain('docs/setting.md: /work/repo/docs/setting.md\nChecks:')
  },
)

const REFUSED_LINE =
  '<!-- course-keeper: anti-patterns --> in VISION.md is not used: ' +
  'it must name a Markdown file in the project, outside hidden folders.'

test('a directive with an invalid name counts as absent, and the status says so', async ($, on) => {
  const { files } = world(on, () => 'verdict: none')
  files['/work/repo/VISION.md'] = `<!-- course-keeper: anti-patterns = ../avoid.md -->\n${VISION}`
  files['/work/repo/ANTI-PATTERNS.md'] = ANTI_PATTERNS

  const shown = await status($)
  expect(shown).toContain(
    `VISION.md: /work/repo/VISION.md\n${REFUSED_LINE}\nANTI-PATTERNS.md: /work/repo/ANTI-PATTERNS.md\nChecks:`,
  )
  expect(shown).not.toContain('named in')
})

test('a directive that names a file other than Markdown, or one in a hidden folder, is not read', async ($, on) => {
  const { forks, files } = world(on, () => 'verdict: none')
  files['/work/repo/.env'] = 'TOKEN=secret\n'
  files['/work/repo/.github/x.md'] = '# Hidden\n'
  files['/work/repo/VISION.md'] = `<!-- course-keeper: anti-patterns = .env -->\n${VISION}`

  expect(await status($)).toContain(`VISION.md: /work/repo/VISION.md\n${REFUSED_LINE}\nChecks:`)
  await command($, 'check')
  expect(forks[0]).not.toContain('secret')

  files['/work/repo/VISION.md'] = `<!-- course-keeper: anti-patterns = .github/x.md -->\n${VISION}`
  expect(await status($)).toContain(REFUSED_LINE)
  await command($, 'check')
  expect(forks[1]).not.toContain('# Hidden')
})

test('a directive that names the vision itself reads it once, and the status says so', async ($, on) => {
  const { forks, files, links } = world(on, () => 'verdict: none')
  files['/work/repo/VISION.md'] = `<!-- course-keeper: anti-patterns = VISION.md -->\n${VISION}`

  const line = 'VISION.md: the vision itself (named in VISION.md). No separate file is used.'
  expect(await status($)).toContain(`VISION.md: /work/repo/VISION.md\n${line}\nChecks:`)
  await command($, 'check')
  expect(forks[0]).not.toContain('# Anti-patterns:')

  // A link to the vision is the vision too.
  files['/work/repo/VISION.md'] = `<!-- course-keeper: anti-patterns = docs/avoid.md -->\n${VISION}`
  links['/work/repo/docs/avoid.md'] = '/work/repo/VISION.md'
  expect(await status($)).toContain(
    'docs/avoid.md: the vision itself (named in VISION.md). No separate file is used.\nChecks:',
  )
})

test('a directive whose file a link leads outside the project is not read', async ($, on) => {
  const { forks, files, links } = world(on, () => 'verdict: none')
  files['/work/repo/VISION.md'] = NAMED
  files['/elsewhere/avoid.md'] = '# Secret\n'
  links['/work/repo/docs/vision/avoid.md'] = '/elsewhere/avoid.md'

  expect(await status($)).toContain(
    'docs/vision/avoid.md: not found or not readable (named in VISION.md). The vision alone is used.',
  )
  await command($, 'check')
  expect(forks[0]).not.toContain('# Secret')
})

test('a directive whose file a link leads to a file other than Markdown or a hidden folder is not read', async ($, on) => {
  const { forks, files, links } = world(on, () => 'verdict: none')
  files['/work/repo/VISION.md'] = NAMED
  files['/work/repo/.env'] = 'TOKEN=secret\n'
  files['/work/repo/.private/secrets.md'] = '# Private secret\n'
  const missing =
    'docs/vision/avoid.md: not found or not readable (named in VISION.md). The vision alone is used.\nChecks:'

  links['/work/repo/docs/vision/avoid.md'] = '/work/repo/.env'
  expect(await status($)).toContain(missing)
  await command($, 'check')
  expect(forks[0]).not.toContain('secret')
  expect(forks[0]).not.toContain('# Anti-patterns:')

  links['/work/repo/docs/vision/avoid.md'] = '/work/repo/.private/secrets.md'
  expect(await status($)).toContain(missing)
  await command($, 'check')
  expect(forks[1]).not.toContain('Private secret')
  expect(forks[1]).not.toContain('# Anti-patterns:')

  // A link to a Markdown file outside hidden folders is followed.
  files['/work/repo/notes/avoid.md'] = ANTI_PATTERNS
  links['/work/repo/docs/vision/avoid.md'] = '/work/repo/notes/avoid.md'
  expect(await status($)).toContain('docs/vision/avoid.md: /work/repo/docs/vision/avoid.md (named in VISION.md)')
})

test('a project root whose real path cannot be told has no vision', async ($, on) => {
  const { links } = world(on, () => 'verdict: none')
  links['/work/repo'] = '/gone'

  expect(await status($)).toContain('VISION.md: not found.')
})

test('cancel drops the draft', async ($, on) => {
  world(on, learnFork(), 'none', { messages: () => ROWS })

  expect(await command($, 'learn cancel')).toBe(NO_DRAFT)
  await command($, 'learn')
  expect(await command($, 'learn cancel')).toBe('The draft sentence is dropped.')
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
})

test('without the session\'s model the test does not run and the draft waits', async ($, on) => {
  let model: string | 'fail' = 'session-model'
  const { completions } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    model: () => model,
    complete: excerptReplies({ failing: ['verdict: none', 'verdict: none'] }),
  })

  await command($, 'learn')
  model = 'fail'
  expect(await command($, 'learn yes')).toContain(
    "The test could not run: Course Keeper could not read the session's model.",
  )
  expect(completions).toHaveLength(0)
  model = 'session-model'
  const report = await command($, 'learn yes')
  expect(report).toContain(
    'Test on the turn you corrected: the check stays silent with this sentence added. The sentence is not verified.',
  )
  expect(report).toContain('Test on 1 earlier turn of this session: no new alert.')
})

test('a turn that compaction removed keeps nothing', async ($, on) => {
  let rows = ROWS
  const { completions } = world(on, learnFork(), 'none', { messages: () => rows })

  await command($, 'learn')
  rows = [
    { role: 'user', text: 'This session is being continued from a previous conversation. A summary.', toolUses: [] },
    { role: 'assistant', text: 'Going on.', toolUses: [] },
  ]
  expect(await command($, 'learn yes')).toBe(
    'The turn you corrected is no longer in the session (a compaction can remove it). ' +
      'The draft is dropped; nothing is kept.',
  )
  expect(completions).toHaveLength(0)
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
})

test('a learn step in flight blocks another but not a check', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, forks } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    forkWait: n => (n === 1 ? gate : undefined),
  })

  await personTypes($, 'ok')
  await settle(clock)
  const first = command($, 'learn')
  await settle(clock)
  expect(await command($, 'learn')).toBe(
    'A learn step is already running in this session. Wait for its answer.',
  )
  await $.turn.complete(END)
  await settle(clock)
  expect(forks).toHaveLength(2)
  expect(await status($)).toContain('verdict: none.')
  release()
  expect(await first).toBe(SHOWN)
  // The mark is cleared once the step ends.
  expect(await command($, 'learn')).toBe(SHOWN)
})

test('a stale learn mark does not block', async ($, on) => {
  const { clock, forks } = world(on, learnFork(), 'none', { messages: () => ROWS })
  let held: unknown = {
    v: 1,
    hasPerson: true,
    isOff: false,
    instructions: [],
    alerts: [],
    current: null,
    showDetails: false,
    lastCheck: null,
    checkingSince: null,
    learningSince: clock.now() - 10 * 60 * 1000,
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

  expect(await command($, 'learn')).toBe(SHOWN)
  expect(forks).toHaveLength(1)
  held = { ...(held as object), learningSince: clock.now() - 1000 }
  expect(await command($, 'learn')).toContain('A learn step is already running')
})

/** Excerpt check replies by turn and vision; any of them can be `unanswered` or `fail`. */
function excerptBy(pick: (turn: 'failing' | 'earlier', added: boolean) => string) {
  return (prompt: string) => {
    if (!prompt.includes('Excerpt head.')) return undefined
    const turn = prompt.includes("## The agent's latest turn\n\nINPUT: Now add the checkout.")
      ? 'failing'
      : 'earlier'

    return pick(turn, prompt.includes(SENTENCE))
  }
}

test('a call that is cut or malformed counts as no result, never as silent', async ($, on) => {
  const { completions } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptBy((turn, added) =>
      turn === 'failing' ? (added ? 'not a check reply' : 'unanswered') : 'verdict: none',
    ),
  })

  await command($, 'learn')
  const report = await command($, 'learn yes')
  expect(report).toContain(
    "Check with today's vision on the turn you corrected: no result (the call ended with aborted).",
  )
  expect(report).toContain('Test on the turn you corrected: no result (the reply was malformed).')
  expect(report).not.toContain('stays silent')
  expect(report).toContain('Test on 1 earlier turn of this session: no new alert.')
  expect(completions).toHaveLength(3)
})

test('a call that fails on the corrected turn or on an earlier turn is no result', async ($, on) => {
  world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptBy((turn, added) =>
      turn === 'failing' ? (added ? 'unanswered' : 'verdict: none') : 'fail',
    ),
  })

  await command($, 'learn')
  const report = await command($, 'learn yes')
  expect(report).toContain(
    'Test on the turn you corrected: no result (the call ended with aborted).',
  )
  expect(report).toContain(
    'Test on 1 earlier turn of this session: no result (the call failed).',
  )
  expect(report).not.toContain('no new alert')
})

test('an earlier alert counts as new only when today\'s vision is silent there', async ($, on) => {
  let today = deviation('I will keep prices in the service.')
  const { completions } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptBy((turn, added) => {
      if (turn === 'failing') {
        return added ? deviation('I will add a fallback price table in the client.') : 'verdict: none'
      }

      return added ? deviation('I will keep prices in the service.') : today
    }),
  })

  await command($, 'learn')
  expect(await command($, 'learn yes')).toContain(
    'Test on 1 earlier turn of this session: no new alert.',
  )
  // Control, verify, the earlier turn with the sentence, and its control.
  expect(completions).toHaveLength(4)

  today = 'unanswered'
  await command($, 'learn')
  const report = await command($, 'learn yes')
  expect(report).toContain(
    'Test on 1 earlier turn of this session: no result (the call ended with aborted).',
  )
  expect(report).not.toContain('new alert')
})

test('the failing turn is the one before the correction when the agent repeats its words', async ($, on) => {
  const rows: SessionMessage[] = [
    ...ROWS.slice(0, 5),
    {
      role: 'assistant',
      text: 'You are right; I wrote "I will add a fallback price table in the client." That is wrong.',
      toolUses: [],
    },
  ]
  const { completions } = world(on, learnFork(), 'none', {
    messages: () => rows,
    complete: excerptReplies({
      failing: ['verdict: none', deviation('I will add a fallback price table in the client.')],
    }),
  })

  await command($, 'learn')
  expect(await command($, 'learn yes')).toContain(
    'Test on the turn you corrected: the check alerts with this sentence added.',
  )
  const verify = completions.find(p => p.includes(SENTENCE) && p.includes('AGENT: I will add'))
  expect(verify).toBeDefined()
  expect(verify).not.toContain('You are right')
})

test('the learn fork gets the agent\'s final answer of the last turn', async ($, on) => {
  const { clock, forks } = world(on, learnFork(), 'none', { messages: () => ROWS })

  await personTypes($, 'Now add the checkout.')
  await settle(clock)
  await $.turn.start({ text: 'Now add the checkout.', turnId: 'turn-1' })
  await $.turn.complete(END)
  await settle(clock)
  forks.length = 0

  await command($, 'learn')
  expect(forks).toHaveLength(1)
  expect(forks[0]).toContain(
    '<final_answer>\nI will add a fallback price table in the client.\n</final_answer>\n\nCatch:',
  )

  // When the next turn started since, the fork's last request is that turn's.
  await $.turn.start({ text: 'go on', turnId: 'turn-2' })
  forks.length = 0
  await command($, 'learn')
  expect(forks[0]).not.toContain('<final_answer>')
})

test('a control alert on another matter of the turn does not stop the test', async ($, on) => {
  let control = deviation('I will add a fallback price table in the client.', 'instruction "keep the client small"')
  let reply = DRAFT
  const { completions } = world(on, prompt => (prompt.includes('Catch:') ? reply : 'verdict: none'), 'none', {
    messages: () => ROWS,
    complete: excerptBy((turn, added) => {
      if (turn === 'earlier') return 'verdict: none'

      return added ? deviation('I will add a fallback price table in the client.', 'invariant 2') : control
    }),
  })

  // An alert on an instruction: the test goes on and the report says so.
  await command($, 'learn')
  let report = await command($, 'learn yes')
  expect(report).toContain(
    'With today\'s vision the check alerts on this turn on instruction "keep the client small", ' +
      'another matter: "The session keeps prices outside the service."\n' +
      'Test on the turn you corrected: the check alerts on invariant 2, not on invariant 1,',
  )
  // Control, verify, and the earlier turn with the sentence.
  expect(completions).toHaveLength(3)

  // A new invariant: an alert on its number is another matter too.
  reply = DRAFT.replace('place: invariant 1', 'place: new')
  control = deviation('I will add a fallback price table in the client.', 'invariant 2')
  await command($, 'learn')
  report = await command($, 'learn yes')
  expect(report).toContain('Draft sentence for VISION.md, as a new invariant:')
  expect(report).toContain(
    "With today's vision the check alerts on this turn on invariant 2, another matter:",
  )
  expect(report).toContain('Test on the turn you corrected: the check alerts with this sentence added.')
})

test('the excerpt checks get no standing instructions', async ($, on) => {
  const { clock, completions, toasts } = world(on, learnFork(), '- keep prices in the service, always', {
    messages: () => ROWS,
    complete: excerptReplies({ failing: ['verdict: none', 'verdict: none'] }),
  })

  await personTypes($, 'keep prices in the service, always')
  await settle(clock)
  expect(toasts).toHaveLength(1)
  await command($, 'learn')
  await command($, 'learn yes')
  const excerpts = completions.filter(p => p.includes('Excerpt head.'))
  expect(excerpts).toHaveLength(3)
  for (const prompt of excerpts) {
    expect(prompt).toContain('Instructions:\nNone listed. Use what the person said in this session.\nAlerts:')
    expect(prompt).not.toContain('keep prices in the service, always')
  }
})

test('the excerpt checks are told not to enforce a withdrawn instruction', async ($, on) => {
  const { clock, completions } = world(on, learnFork(), '- keep prices in the service, always', {
    messages: () => ROWS,
    complete: excerptReplies({ failing: ['verdict: none', 'verdict: none'] }),
  })

  await personTypes($, 'keep prices in the service, always')
  await settle(clock)
  expect(await command($, 'forget 1')).toBe(
    'Standing instruction 1 removed: "keep prices in the service, always"',
  )
  await command($, 'learn')
  await command($, 'learn yes')
  const excerpts = completions.filter(p => p.includes('Excerpt head.'))
  expect(excerpts).toHaveLength(3)
  for (const prompt of excerpts) {
    expect(prompt).toContain(
      'Instructions:\nNone listed. Use what the person said in this session.\n\n' +
        'Withdrawn by the person; do not enforce these:\n' +
        '- keep prices in the service, always\nAlerts:',
    )
  }
})

test('learn yes tests the turn the draft found, not a later reply that repeats the quote', async ($, on) => {
  let rows = ROWS
  const { completions } = world(on, learnFork(), 'none', {
    messages: () => rows,
    complete: excerptReplies({
      failing: ['verdict: none', deviation('I will add a fallback price table in the client.')],
    }),
  })

  await command($, 'learn')
  // After the draft, the agent repeats its words in a later turn.
  rows = [
    ...ROWS,
    { role: 'user', text: 'Quote what you wrote.', toolUses: [] },
    { role: 'assistant', text: 'I wrote: "I will add a fallback price table in the client."', toolUses: [] },
    { role: 'user', text: 'Thanks, go on.', toolUses: [] },
    { role: 'assistant', text: 'Going on.', toolUses: [] },
  ]
  expect(await command($, 'learn yes')).toContain(
    'Test on the turn you corrected: the check alerts with this sentence added.',
  )
  const verify = completions.find(p => p.includes(SENTENCE) && p.includes("## The agent's latest turn"))
  expect(verify).toContain("## The agent's latest turn\n\nINPUT: Now add the checkout.")
  expect(completions.some(p => p.includes("## The agent's latest turn\n\nINPUT: Quote what you wrote."))).toBe(false)

  // The turn at the draft's person message no longer holds the quote.
  rows = ROWS
  await command($, 'learn')
  completions.length = 0
  rows = ROWS.map((r, k) =>
    k === 3 ? { ...r, text: 'Other words.' } : k === 5 ? { ...r, text: 'I will add a fallback price table in the client.' } : r,
  )
  expect(await command($, 'learn yes')).toBe(
    'The turn you corrected is no longer in the session (a compaction can remove it). ' +
      'The draft is dropped; nothing is kept.',
  )
  expect(completions).toHaveLength(0)
})

test('a turn too long for the excerpt is not tested when the agent\'s words fall in its middle', async ($, on) => {
  const long = ROWS.map((r, k) =>
    k === 3
      ? { ...r, text: `${'x'.repeat(30000)} I will add a fallback price table in the client. ${'y'.repeat(50000)}` }
      : r,
  )
  const { completions } = world(on, learnFork(), 'none', { messages: () => long })

  expect(await command($, 'learn')).toBe(SHOWN)
  const answer = await command($, 'learn yes')
  expect(answer).toContain(
    "The turn you corrected is too long for the test. The agent's words fall in the part that the excerpt leaves out, " +
      'so the sentence could not be tested. The draft is dropped.\n\n' +
      `Draft sentence for VISION.md, invariant 1 (not tested):\n  ${SENTENCE}\n`,
  )
  expect(answer).toContain('This is a draft for the owners of VISION.md. Course Keeper does not change the file.')
  expect(completions).toHaveLength(0)
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
})

test('a person message that repeats the agent\'s words does not make a long turn testable', async ($, on) => {
  const quote = 'I will add a fallback price table in the client.'
  const long = ROWS.map((r, k) =>
    k === 2
      ? { ...r, text: `Now add the checkout. Never say "${quote}"` }
      : k === 3
        ? { ...r, text: `${'x'.repeat(30000)} ${quote} ${'y'.repeat(50000)}` }
        : r,
  )
  const { completions } = world(on, learnFork(), 'none', { messages: () => long })

  expect(await command($, 'learn')).toBe(SHOWN)
  expect(await command($, 'learn yes')).toContain(
    "The turn you corrected is too long for the test. The agent's words fall in the part that the excerpt leaves out",
  )
  expect(completions).toHaveLength(0)
})

test('cancel during learn yes stops its calls and keeps nothing', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, completions } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptReplies({ failing: ['verdict: none', 'verdict: none'] }),
    completeWait: n => (n === 1 ? gate : undefined),
  })

  await command($, 'learn')
  const first = command($, 'learn yes')
  await settle(clock)
  expect(await command($, 'learn cancel')).toBe('The draft sentence is dropped.')
  release()
  expect(await first).toBe('A newer learn request replaced this one.')
  // Only the control call ran.
  expect(completions).toHaveLength(1)
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
})

test('cancel during the draft fork keeps the draft from being saved', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    forkWait: n => (n === 1 ? gate : undefined),
  })

  const first = command($, 'learn')
  await settle(clock)
  expect(await command($, 'learn cancel')).toBe('The learn step in flight is cancelled.')
  release()
  expect(await first).toBe('A newer learn request replaced this one.')
  expect(await command($, 'learn yes')).toBe(NO_DRAFT)
  expect(await command($, 'learn cancel')).toBe(NO_DRAFT)
})

test('a learn request that lost its mark does not save its draft over a newer one', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let reply = DRAFT
  const { clock } = world(on, prompt => (prompt.includes('Catch:') ? reply : 'verdict: none'), 'none', {
    messages: () => ROWS,
    forkWait: n => (n === 1 ? gate : undefined),
  })

  const first = command($, 'learn')
  await settle(clock)
  // The first request's mark goes stale, so a newer one runs.
  await clock.advance(6 * 60 * 1000)
  expect(await command($, 'learn')).toBe(SHOWN)
  reply = DRAFT.replace(SENTENCE, 'Never put prices anywhere.')
  release()
  expect(await first).toBe('A newer learn request replaced this one.')
  const report = await command($, 'learn yes')
  expect(report).toContain(`  ${SENTENCE}`)
  expect(report).not.toContain('Never put prices anywhere.')
})

test('a learn yes that lost its mark answers that a newer request replaced it', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock } = world(on, learnFork(), 'none', {
    messages: () => ROWS,
    complete: excerptReplies({ failing: ['verdict: none', 'verdict: none'] }),
    completeWait: n => (n === 1 ? gate : undefined),
  })

  await command($, 'learn')
  const first = command($, 'learn yes')
  await settle(clock)
  await clock.advance(6 * 60 * 1000)
  expect(await command($, 'learn yes')).toContain('Draft sentence for VISION.md, invariant 1:')
  release()
  expect(await first).toBe('A newer learn request replaced this one.')
})
