import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import type { CourseKeeperAlert, CourseKeeperDraft, CourseKeeperSession } from '../types'
import {
  CHECK_STALE_MS,
  LEARN_LIMITS,
  LIMITS,
  MAX_INSTRUCTIONS,
  MAX_INSTRUCTION_LENGTH,
  NO_ALERTS,
  NO_INSTRUCTIONS,
  NO_CATCH,
  addInstructions,
  addSentence,
  addWithdrawn,
  applyReply,
  catchText,
  clean,
  compactInstructions,
  draftText,
  earlierTurns,
  emptyRecord,
  excerptCheckPrompt,
  excerptKeepsQuote,
  failingRow,
  failingTurnAt,
  fillCheckPrompt,
  fillExtractPrompt,
  fillLearnPrompt,
  findQuote,
  forgetInstruction,
  formatAlerts,
  formatInstructions,
  holdsQuote,
  isCheckRunning,
  isPersonMessage,
  isPersonOrigin,
  learnReport,
  normalizeRecord,
  oldestKeys,
  parseCheckReply,
  parseExtractReply,
  parseLearnReply,
  personCountAt,
  removeWithdrawn,
  restoreUnsent,
  sessionExcerpt,
  shouldExtract,
  statusText,
  stripLeadingComment,
  stripLeadingComments,
  turnOf,
  turnsOf,
  untestedReport,
  withFinalAnswer,
  withoutDraft,
} from './logic'

const DEVIATION = [
  'verdict: deviation',
  'reference: invariant 2',
  'alert: The session adds a second pricing path, which contradicts invariant 2.',
  'evidence: "I will add a fallback price table in the client."',
  'note: Invariant 2 says one service sets every price. Keep the price in that service.',
].join('\n')

function alertOf(fields: Partial<CourseKeeperAlert> = {}): CourseKeeperAlert {
  return {
    reference: 'invariant 2',
    alert: 'The session adds a second pricing path.',
    evidence: 'I will add a fallback price table in the client.',
    note: 'Keep the price in one service.',
    shownAt: 1000,
    answer: null,
    ...fields,
  }
}

describe('the check reply', () => {
  test('a deviation is read field by field', () => {
    expect(parseCheckReply(DEVIATION)).toEqual({
      verdict: 'deviation',
      reference: 'invariant 2',
      alert: 'The session adds a second pricing path, which contradicts invariant 2.',
      evidence: 'I will add a fallback price table in the client.',
      note: 'Invariant 2 says one service sets every price. Keep the price in that service.',
    })
  })

  test('none is read', () => {
    expect(parseCheckReply('verdict: none')).toEqual({ verdict: 'none' })
  })

  test('code fences around the reply are ignored', () => {
    expect(parseCheckReply('```\nverdict: none\n```')).toEqual({ verdict: 'none' })
    expect(parseCheckReply('```text\n' + DEVIATION + '\n```')).toMatchObject({
      verdict: 'deviation',
      reference: 'invariant 2',
    })
  })

  test('a malformed reply is undefined', () => {
    expect(parseCheckReply('')).toBeUndefined()
    expect(parseCheckReply('I found nothing wrong.')).toBeUndefined()
    expect(parseCheckReply('verdict: maybe')).toBeUndefined()
    expect(parseCheckReply('verdict: deviation\nreference: invariant 2')).toBeUndefined()
    expect(
      parseCheckReply(DEVIATION.replace('reference: invariant 2', 'reference: rule 9')),
    ).toBeUndefined()
    expect(parseCheckReply(`${DEVIATION}\nverdict: none`)).toBeUndefined()
  })

  test('a reference without a number or a quoted instruction is malformed', () => {
    for (const reference of [
      'invariant',
      'invariant two',
      'invariants 2',
      'invariant 2x',
      'instruction',
      'instruction ""',
      'instruction " "',
      'instruction never push',
      'instruction "never push',
    ]) {
      const reply = DEVIATION.replace('reference: invariant 2', `reference: ${reference}`)
      expect([reference, parseCheckReply(reply)]).toEqual([reference, undefined])
    }
  })

  test('invariant <number> and a quoted instruction are accepted in canonical form', () => {
    for (const [reference, canonical] of [
      ['INVARIANT 12', 'invariant 12'],
      ['invariant 2.', 'invariant 2'],
      ['invariant 2 (no rounding in the exporter)', 'invariant 2'],
      ['invariant 2 and 3', 'invariant 2'],
      ['`invariant 2`', 'invariant 2'],
      ['Invariant 2: "amounts"', 'invariant 2'],
      ['instruction "never push to main"', 'instruction "never push to main"'],
      ['instruction "never push to main".', 'instruction "never push to main"'],
      ['Instruction “never push to main”', 'instruction "never push to main"'],
      ["instruction 'never use npm'", 'instruction "never use npm"'],
      ['instruction „keine npm-Pakete“', 'instruction "keine npm-Pakete"'],
      ['instruction: "never push to main"', 'instruction "never push to main"'],
      [
        'instruction "don\'t push to main" (the person\'s words)',
        'instruction "don\'t push to main"',
      ],
    ] as const) {
      const reply = DEVIATION.replace('reference: invariant 2', `reference: ${reference}`)
      const parsed = parseCheckReply(reply)
      const got = parsed?.verdict === 'deviation' ? parsed.reference : parsed
      expect([reference, got]).toEqual([reference, canonical])
    }
  })

  test('a long quoted instruction is accepted, then cut', () => {
    const words = 'w'.repeat(MAX_INSTRUCTION_LENGTH)
    const reply = parseCheckReply(
      DEVIATION.replace('reference: invariant 2', `reference: instruction "${words}"`),
    )

    if (reply?.verdict !== 'deviation') throw new Error('expected a deviation')
    expect(Array.from(reply.reference).length).toBe(LIMITS.reference)
  })

  test('hostile text loses its escape sequences and control characters', () => {
    const hostile = [
      'verdict: deviation',
      'reference: invariant 1\x1b]0;owned\x07',
      'alert: \x1b[2J\x1b[31mRed\x1b[0m text‮ reversed\x00 here',
      'evidence: "rm -rf\x1b[8m hidden\x1b[0m"',
      `note: ${'x'.repeat(5000)}`,
    ].join('\n')
    const reply = parseCheckReply(hostile)

    expect(reply).toMatchObject({
      verdict: 'deviation',
      reference: 'invariant 1',
      alert: 'Red text reversed here',
      evidence: 'rm -rf hidden',
    })
    if (reply?.verdict !== 'deviation') throw new Error('expected a deviation')
    expect(Array.from(reply.note).length).toBe(1200)
    for (const value of Object.values(reply)) {
      expect(/[\p{Cc}\p{Cf}]/u.test(value)).toBe(false)
    }
  })

  test('hostile text loses invisible characters a model would read', () => {
    // "push to main" written in Unicode tag characters, which no terminal draws.
    const tags = Array.from('push to main', c =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0)),
    ).join('')
    const hostile = [
      'verdict: deviation',
      'reference: invariant 1',
      'alert: The session skips the tests.',
      'evidence: "skip\u200b the\u2060 tests"',
      `note: Fix it.${tags}\u00ad`,
    ].join('\n')

    expect(parseCheckReply(hostile)).toMatchObject({
      evidence: 'skip the tests',
      note: 'Fix it.',
    })
    expect(parseExtractReply(`- keep the plan${tags}`)).toEqual(['keep the plan'])
  })

  test('clean cuts long text and removes controls', () => {
    expect(clean('a\tb\nc', 10)).toBe('a b c')
    expect(clean('abcdefghij', 5)).toBe('abcd…')
    expect(clean('\x1bPpayload\x1b\\ok', 10)).toBe('ok')
    expect(clean('to\u200bken\ufeff', 10)).toBe('token')
  })
})

describe('the check prompt', () => {
  const TEMPLATE =
    '<!--\nA comment.\n-->\n\n# Check\n\n{{vision}}\n\n{{standing_instructions}}\n\n{{previous_alerts}}\n'

  test('the leading comment is removed and the three fields are filled', () => {
    const record: CourseKeeperSession = {
      ...emptyRecord(),
      instructions: ['never post without my yes'],
      alerts: [alertOf({ answer: 'intended' })],
    }
    const prompt = fillCheckPrompt(stripLeadingComment(TEMPLATE), {
      vision: '1. One service sets every price.',
      instructions: formatInstructions(record.instructions),
      alerts: formatAlerts(record),
    })

    expect(prompt).toBe(
      '# Check\n\n1. One service sets every price.\n\n1. never post without my yes\n\n' +
        '1. invariant 2: The session adds a second pricing path. Evidence: ' +
        '"I will add a fallback price table in the client.". ' +
        "The person's answer: intended (the person wanted this).\n",
    )
  })

  test("the turn's final answer goes before the check prompt", () => {
    expect(withFinalAnswer('# Check', '  I will add a price table.  ')).toBe(
      'The agent ended its latest turn with the answer below. The conversation ' +
        'above does not show this answer yet. It is part of the material to examine.\n\n' +
        '<final_answer>\nI will add a price table.\n</final_answer>\n\n# Check',
    )
    expect(withFinalAnswer('# Check', ' ')).toBe('# Check')
  })

  test('empty lists use the fixed sentences', () => {
    expect(formatInstructions([])).toBe(NO_INSTRUCTIONS)
    expect(formatInstructions([], [])).toBe(NO_INSTRUCTIONS)
    expect(formatAlerts(emptyRecord())).toBe(NO_ALERTS)
  })

  test('withdrawn instructions follow the list under their own line', () => {
    expect(formatInstructions(['ask before deleting files'], ['never post without my yes'])).toBe(
      '1. ask before deleting files\n\n' +
        'Withdrawn by the person; do not enforce these:\n- never post without my yes',
    )
    expect(formatInstructions([], ['a', 'b'])).toBe(
      `${NO_INSTRUCTIONS}\n\nWithdrawn by the person; do not enforce these:\n- a\n- b`,
    )
  })

  test('a field that holds a placeholder is not filled twice', () => {
    const prompt = fillCheckPrompt('{{vision}}|{{standing_instructions}}', {
      vision: '{{standing_instructions}} $& $1',
      instructions: 'list',
      alerts: '',
    })

    expect(prompt).toBe('{{standing_instructions}} $& $1|list')
  })

  test('the extract prompt takes the message', () => {
    expect(fillExtractPrompt('<message>\n{{message}}\n</message>', 'go $&')).toBe(
      '<message>\ngo $&\n</message>',
    )
  })
})

describe('the duplicate-alert rule', () => {
  test('the same reference and evidence is not shown again', () => {
    const record = { ...emptyRecord(), alerts: [alertOf({ answer: 'dismissed' })] }
    const reply = parseCheckReply(
      DEVIATION.replace(
        'evidence: "I will add a fallback price table in the client."',
        'evidence: "I will add a fallback   PRICE table in the client."',
      ),
    )
    const done = applyReply(record, reply, 2000)

    expect(done.shown).toBeUndefined()
    expect(done.record.current).toBeNull()
    expect(done.outcome).toBe('verdict: deviation (invariant 2), already shown')
  })

  test('the current alert counts as shown', () => {
    const record = { ...emptyRecord(), current: alertOf() }
    expect(applyReply(record, parseCheckReply(DEVIATION), 2000).shown).toBeUndefined()
  })

  test('new evidence is a new alert and replaces the current one', () => {
    const record = { ...emptyRecord(), current: alertOf({ evidence: 'other words' }) }
    const done = applyReply(record, parseCheckReply(DEVIATION), 2000)

    expect(done.shown?.shownAt).toBe(2000)
    expect(done.record.current?.evidence).toBe(
      'I will add a fallback price table in the client.',
    )
    expect(done.record.alerts).toEqual([
      alertOf({ evidence: 'other words', answer: 'replaced by a newer alert' }),
    ])
  })

  test('none and a malformed reply record the outcome alone', () => {
    expect(applyReply(emptyRecord(), { verdict: 'none' }, 5).record.lastCheck).toEqual({
      at: 5,
      outcome: 'verdict: none',
    })
    expect(applyReply(emptyRecord(), undefined, 5).outcome).toBe(
      'the reply was malformed',
    )
  })
})

describe('the standing instructions', () => {
  test('the extract reply gives up to three cleaned lines', () => {
    expect(parseExtractReply('none')).toEqual([])
    expect(parseExtractReply('- a\n- b\nnot a line\n- c\n- d')).toEqual(['a', 'b', 'c'])
    expect(parseExtractReply('- keep \x1b[31mred\x1b[0m out')).toEqual(['keep red out'])
  })

  test('an equal instruction is not added twice', () => {
    const done = addInstructions(['Never post without my yes'], [
      'never  post without my YES',
      'Ask before deleting files',
    ])

    expect(done.added).toEqual(['Ask before deleting files'])
    expect(done.list).toHaveLength(2)
  })

  test('at most 30 are kept', () => {
    const full = Array.from({ length: MAX_INSTRUCTIONS }, (_, i) => `rule ${i}`)
    expect(addInstructions(full, ['one more'])).toEqual({ list: full, added: [] })
  })

  test('each is cut to 300 characters', () => {
    const done = addInstructions([], ['y'.repeat(1000)])
    expect(Array.from(done.list[0] ?? '').length).toBe(MAX_INSTRUCTION_LENGTH)
  })

  test('forget removes one by its number', () => {
    expect(forgetInstruction(['a', 'b', 'c'], '2')).toEqual({ list: ['a', 'c'], removed: 'b' })
    expect(forgetInstruction(['a'], '0')).toBeUndefined()
    expect(forgetInstruction(['a'], '2')).toBeUndefined()
    expect(forgetInstruction(['a'], 'x')).toBeUndefined()
  })

  test('withdrawn instructions are cleaned, kept once, and only the newest 30 stay', () => {
    expect(addWithdrawn(['a', 'b'], 'A')).toEqual(['b', 'A'])
    expect(addWithdrawn([], 'keep \x1b[31mred\x1b[0m out')).toEqual(['keep red out'])
    expect(Array.from(addWithdrawn([], 'y'.repeat(1000))[0] ?? '').length).toBe(
      MAX_INSTRUCTION_LENGTH,
    )
    const full = Array.from({ length: MAX_INSTRUCTIONS }, (_, i) => `rule ${i}`)
    const next = addWithdrawn(full, 'one more')
    expect(next).toHaveLength(MAX_INSTRUCTIONS)
    expect(next[0]).toBe('rule 1')
    expect(next.at(-1)).toBe('one more')
  })

  test('an instruction stated again is no longer withdrawn', () => {
    expect(removeWithdrawn(['Never post without my yes', 'b'], ['never  post without my YES'])).toEqual(['b'])
  })

  test('the status shows withdrawn instructions under their own heading', () => {
    const text = statusText({ ...emptyRecord(), withdrawn: ['never post without my yes'] }, undefined)
    expect(text).toContain(
      'Withdrawn standing instructions:\n  - never post without my yes\n\nAlerts in this session:',
    )
    expect(statusText(emptyRecord(), undefined)).not.toContain('Withdrawn')
  })

  test('slash commands and short prompts are not sent', () => {
    expect(shouldExtract('/compact keep the plan', false, false)).toBe(false)
    expect(shouldExtract('keep the plan', true, false)).toBe(false)
    expect(shouldExtract('ok go on', false, false)).toBe(false)
    expect(shouldExtract('never post without my yes', false, true)).toBe(false)
    expect(shouldExtract('never post without my yes', false, false)).toBe(true)
  })
})

describe('the person decision', () => {
  test('composer, bridge and slack-ping are a person; every other kind is not', () => {
    expect(isPersonOrigin('composer')).toBe(true)
    expect(isPersonOrigin('bridge')).toBe(true)
    expect(isPersonOrigin('slack-ping')).toBe(true)
    for (const kind of [
      'sdk',
      'task-notification',
      'scheduled-trigger',
      'peer',
      'peer-send-message',
      'projects-relay',
      'channel',
      'coordinator',
      'observer',
      'observer-activity',
      'auto-continuation',
      'unclassified',
      'plugin',
      'a-kind-from-a-later-release',
    ]) {
      expect([kind, isPersonOrigin(kind)]).toEqual([kind, false])
    }
  })
})

describe('a note that did not reach the agent', () => {
  test('the alert is shown again', () => {
    const record = { ...emptyRecord(), alerts: [alertOf({ answer: 'told the agent' })] }

    expect(restoreUnsent(record, 1000)).toEqual({ ...emptyRecord(), current: alertOf() })
  })

  test('with a newer alert shown, the older one counts as replaced', () => {
    const record = {
      ...emptyRecord(),
      alerts: [alertOf({ answer: 'told the agent' })],
      current: alertOf({ shownAt: 2000 }),
    }

    expect(restoreUnsent(record, 1000).alerts).toEqual([
      alertOf({ answer: 'replaced by a newer alert' }),
    ])
  })

  test('another answer is left alone', () => {
    const record = { ...emptyRecord(), alerts: [alertOf({ answer: 'dismissed' })] }
    expect(restoreUnsent(record, 1000)).toBe(record)
  })
})

describe('compaction', () => {
  test('the instructions are added word for word', () => {
    expect(compactInstructions(undefined, ['never post without my yes'])).toBe(
      'Keep these standing instructions of the person word for word in the summary:\n' +
        '1. never post without my yes',
    )
    expect(compactInstructions('Focus on the plan.', ['a'])).toBe(
      'Focus on the plan.\n\nKeep these standing instructions of the person word for word in the summary:\n1. a',
    )
  })

  test('with no instructions nothing changes', () => {
    expect(compactInstructions('Focus on the plan.', [])).toBeUndefined()
  })
})

describe('stored records', () => {
  test('a value of another shape reads as an empty record', () => {
    expect(normalizeRecord(undefined)).toEqual(emptyRecord())
    expect(normalizeRecord({ instructions: ['a'] })).toEqual(emptyRecord())
    expect(normalizeRecord('text')).toEqual(emptyRecord())
  })

  test('bad fields are dropped and good ones kept', () => {
    const read = normalizeRecord({
      v: 1,
      hasPerson: true,
      isOff: 'yes',
      instructions: ['keep', 7, '\x1b[31mred\x1b[0m'],
      alerts: [alertOf({ answer: 'intended' }), { reference: 1 }],
      current: alertOf({ answer: 'dismissed' }),
      showDetails: true,
      lastCheck: { at: 'now', outcome: 'x' },
      checkingSince: 'soon',
    })

    expect(read).toEqual({
      v: 1,
      hasPerson: true,
      isOff: false,
      instructions: ['keep', 'red'],
      // The record has no withdrawn list: it was written before there was one.
      withdrawn: [],
      alerts: [alertOf({ answer: 'intended' })],
      current: alertOf(),
      showDetails: true,
      lastCheck: null,
      checkingSince: null,
    })
    expect(normalizeRecord({ v: 1, checkingSince: 7 }).checkingSince).toBe(7)
  })

  test('withdrawn instructions are read cleaned, and only the newest 30', () => {
    const many = Array.from({ length: MAX_INSTRUCTIONS + 2 }, (_, i) => `rule ${i}`)
    const read = normalizeRecord({ v: 1, withdrawn: [7, '\x1b[31mred\x1b[0m', '', ...many] })

    expect(read.withdrawn).toEqual(many.slice(-MAX_INSTRUCTIONS))
    expect(normalizeRecord({ v: 1, withdrawn: ['a', 'red\x1b[0m'] }).withdrawn).toEqual(['a', 'red'])
    expect(normalizeRecord({ v: 1, withdrawn: 'a' }).withdrawn).toEqual([])
  })

  test('an in-flight mark blocks a check until it is stale', () => {
    expect(isCheckRunning(null, 1000)).toBe(false)
    expect(isCheckRunning(1000, 1000 + CHECK_STALE_MS - 1)).toBe(true)
    expect(isCheckRunning(1000, 1000 + CHECK_STALE_MS)).toBe(false)
  })

  test('the oldest sessions are dropped first', () => {
    expect(
      oldestKeys(
        [
          { key: 'a', savedAt: 3 },
          { key: 'b', savedAt: 1 },
          { key: 'c', savedAt: 2 },
        ],
        2,
      ),
    ).toEqual(['b'])
  })
})

const DRAFT_REPLY = [
  '```',
  'result: draft',
  'quote: "I will round the total in the exporter before it writes the file."',
  'act: The agent planned to round money in the exporter.',
  'forms: stating it, planning it, building it',
  'variant: The agent converts a currency in the report view.',
  'place: invariant 1',
  'sentence: Never round, convert or add up money outside the one module, for example the',
  '  exporter total: call the module instead.',
  'allowed: Formatting an amount that the module computed.',
  '```',
].join('\n')

function draftOf(fields: Partial<CourseKeeperDraft> = {}): CourseKeeperDraft {
  return {
    quote: 'I will round the total in the exporter before it writes the file.',
    act: 'The agent planned to round money in the exporter.',
    forms: 'stating it, planning it, building it',
    variant: 'The agent converts a currency in the report view.',
    place: 'invariant 1',
    sentence:
      'Never round, convert or add up money outside the one module, for example the exporter total: call the module instead.',
    allowed: 'Formatting an amount that the module computed.',
    draftedAt: Date.UTC(2026, 10, 23, 12),
    model: 'example-model',
    personCount: 2,
    ...fields,
  }
}

function row(
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage {
  return { role, text, toolUses: [], ...extra }
}

describe('the learn reply', () => {
  test('a draft is read field by field, fences ignored, continuation lines joined', () => {
    expect(parseLearnReply(DRAFT_REPLY)).toEqual({
      result: 'draft',
      quote: 'I will round the total in the exporter before it writes the file.',
      act: 'The agent planned to round money in the exporter.',
      forms: 'stating it, planning it, building it',
      variant: 'The agent converts a currency in the report view.',
      place: 'invariant 1',
      sentence:
        'Never round, convert or add up money outside the one module, for example the exporter total: call the module instead.',
      allowed: 'Formatting an amount that the module computed.',
    })
  })

  test('none is read with its reason', () => {
    expect(parseLearnReply('result: none\nreason: A matter of taste.')).toEqual({
      result: 'none',
      reason: 'A matter of taste.',
    })
  })

  test('the first occurrence of a field wins, and a repeat drops its continuation', () => {
    const reply = parseLearnReply(
      `${DRAFT_REPLY}\nact: A second act.\n  more of it\nplace: new\nresult: none`,
    )
    expect(reply).toMatchObject({
      result: 'draft',
      act: 'The agent planned to round money in the exporter.',
      place: 'invariant 1',
    })
  })

  test('a malformed reply is undefined', () => {
    expect(parseLearnReply('')).toBeUndefined()
    expect(parseLearnReply('result: maybe')).toBeUndefined()
    for (const field of ['quote', 'act', 'place', 'sentence']) {
      const reply = DRAFT_REPLY.split('\n')
        .filter(line => !line.startsWith(`${field}:`))
        .join('\n')
      expect([field, parseLearnReply(reply)]).toEqual([field, undefined])
    }
    for (const place of ['invariant', 'invariant two', 'rule 1', '']) {
      const reply = DRAFT_REPLY.replace('place: invariant 1', `place: ${place}`)
      expect([place, parseLearnReply(reply)]).toEqual([place, undefined])
    }
    expect(parseLearnReply(DRAFT_REPLY.replace('sentence: Never', 'sentence: Do not'))).toBeUndefined()
    expect(parseLearnReply(DRAFT_REPLY.replace('sentence: Never', 'sentence: Nevertheless'))).toBeUndefined()
  })

  test('place and sentence are read in canonical form', () => {
    for (const [place, canonical] of [
      ['Invariant 03', 'invariant 3'],
      ['`invariant 2` (the exporter)', 'invariant 2'],
      ['new', 'new'],
      ['NEW invariant', 'new'],
    ] as const) {
      const reply = parseLearnReply(DRAFT_REPLY.replace('place: invariant 1', `place: ${place}`))
      expect([place, reply?.result === 'draft' ? reply.place : reply]).toEqual([place, canonical])
    }
    expect(
      parseLearnReply(DRAFT_REPLY.replace('sentence: Never', 'sentence: never')),
    ).toMatchObject({ result: 'draft' })
  })

  test('one pair of quote marks is stripped from the quote', () => {
    for (const [quote, read] of [
      ['"a b"', 'a b'],
      ['“a b”', 'a b'],
      ['a b', 'a b'],
      ['""a b""', '"a b"'],
    ] as const) {
      const reply = parseLearnReply(
        DRAFT_REPLY.replace(/^quote: .*$/m, () => `quote: ${quote}`),
      )
      expect([quote, reply?.result === 'draft' ? reply.quote : reply]).toEqual([quote, read])
    }
  })

  test('every field is cleaned and cut to its limit', () => {
    const reply = parseLearnReply(
      [
        'result: draft',
        `quote: "${'q'.repeat(2000)}"`,
        'act: \x1b[31mred\x1b[0m act​',
        `forms: ${'f'.repeat(2000)}`,
        `variant: ${'v'.repeat(2000)}`,
        'place: new',
        `sentence: Never ${'s'.repeat(2000)}`,
        `allowed: ${'a'.repeat(2000)}`,
      ].join('\n'),
    )
    if (reply?.result !== 'draft') throw new Error('expected a draft')
    expect(reply.act).toBe('red act')
    for (const name of ['quote', 'forms', 'variant', 'sentence', 'allowed'] as const) {
      expect([name, Array.from(reply[name]).length]).toEqual([name, LEARN_LIMITS[name]])
    }
    const none = parseLearnReply(`result: none\nreason: ${'r'.repeat(2000)}`)
    expect(none?.result === 'none' && Array.from(none.reason).length).toBe(LEARN_LIMITS.reason)
  })
})

describe('the learn prompt', () => {
  test('both leading comments are removed', () => {
    expect(stripLeadingComments('<!-- a -->\n\n<!--\nb\n-->\n\n<x>\n')).toBe('<x>\n')
    expect(stripLeadingComments('<x>')).toBe('<x>')
  })

  test('the catch is the person\'s words, cleaned and cut, or the fixed sentence', () => {
    expect(catchText('')).toBe(NO_CATCH)
    expect(catchText('  \n ')).toBe(NO_CATCH)
    expect(catchText('it rounded\nmoney \x1b[31min the exporter')).toBe(
      'The person described the act in these words: "it rounded money in the exporter"',
    )
    expect(catchText('w'.repeat(1000))).toBe(
      `The person described the act in these words: "${'w'.repeat(599)}…"`,
    )
  })

  test('the two fields are filled in one pass', () => {
    expect(
      fillLearnPrompt('{{catch}}|{{vision}}', { catch: '{{vision}} $&', vision: 'v' }),
    ).toBe('{{vision}} $&|v')
  })
})

describe('the quote test', () => {
  const rows = [
    row('user', 'Plan the export.'),
    row('assistant', 'I will round the total\n  in the exporter before it writes the file.'),
    row('user', 'I will round the total in the exporter'),
    row('assistant', 'Done: I will round the total in the exporter.'),
  ]

  test('the quote is found in an assistant row, with whitespace collapsed', () => {
    expect(findQuote(rows, 'round the total in the exporter before it writes')).toBe(1)
    expect(findQuote(rows, 'I will round the total in the exporter')).toBe(3)
  })

  test('nothing else is loosened, and a user row does not count', () => {
    expect(findQuote(rows, 'Round the total in the exporter before')).toBe(-1)
    expect(findQuote(rows, 'round the total in the exporter, before')).toBe(-1)
    expect(findQuote(rows.slice(0, 1), 'Plan the export.')).toBe(-1)
    expect(findQuote(rows, '  ')).toBe(-1)
  })

  test('the failing reply comes before the correction, not from the answer that repeats it', () => {
    const corrected = [
      row('user', 'Fix the build.'),
      row('assistant', 'I will delete the failing tests.'),
      row('user', 'No, never delete tests.'),
      row('assistant', 'You are right, I said I will delete the failing tests. I will restore them.'),
    ]
    expect(findQuote(corrected, 'I will delete the failing tests.')).toBe(3)
    expect(failingRow(corrected, 'I will delete the failing tests.')).toBe(1)
    // Only the newest turn holds the quote: the person ran the command at once.
    expect(failingRow(corrected.slice(0, 2), 'I will delete the failing tests.')).toBe(1)
    expect(failingRow(corrected, 'I will restore them.')).toBe(3)
    expect(failingRow(corrected, 'Other words.')).toBe(-1)
    expect(failingRow(corrected, ' ')).toBe(-1)
  })

  test('the failing turn is kept by its person message, so a later repeat does not move it', () => {
    const later = [
      row('assistant', 'Hello.'),
      row('user', 'Fix the build.'),
      row('assistant', 'I will delete the failing tests.'),
      row('user', 'No, never delete tests.'),
      row('assistant', 'You are right.'),
      row('user', 'What did you say?'),
      row('assistant', 'I said: I will delete the failing tests.'),
      row('user', 'Go on.'),
    ]
    expect(personCountAt(later, 0)).toBe(0)
    expect(personCountAt(later, 1)).toBe(1)
    expect(personCountAt(later, 5)).toBe(3)
    // The rule of the draft picks the repeat; the stored number does not.
    expect(failingRow(later, 'I will delete the failing tests.')).toBe(6)
    expect(failingTurnAt(later, 1, 'I will delete the failing tests.')).toEqual({ start: 1, end: 2 })
    expect(failingTurnAt(later, 0, 'Hello.')).toEqual({ start: 0, end: 0 })
    // The turn at that person message no longer holds the quote, or is gone.
    expect(failingTurnAt(later, 2, 'I will delete the failing tests.')).toBeUndefined()
    expect(failingTurnAt(later, 9, 'I will delete the failing tests.')).toBeUndefined()
    expect(failingTurnAt(later.slice(1), 0, 'Hello.')).toBeUndefined()
  })

  test('holdsQuote collapses whitespace and nothing else', () => {
    expect(holdsQuote('AGENT: I will round\n  the total.', 'round the total')).toBe(true)
    expect(holdsQuote('AGENT: I will round the total.', 'Round the total')).toBe(false)
    expect(holdsQuote('AGENT: text', ' ')).toBe(false)
  })
})

describe('turns and excerpts', () => {
  const summary = 'This session is being continued from a previous conversation. Earlier work: a plan.'
  const rows: SessionMessage[] = [
    row('assistant', 'Hello.'),
    row('user', 'Plan the export.'),
    row('assistant', 'I will read the file.', {
      toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }],
    }),
    row('user', '', { toolResults: [{ tool_use_id: 't1', text: 'file text', isError: false }] }),
    row('assistant', 'I will round the total in the exporter.'),
    row('user', '<task-notification>done</task-notification>'),
    row('user', summary),
    row('user', 'Plan the export.'),
    row('assistant', ''),
    row('user', 'No, the module computes every amount.'),
    row('assistant', 'You are right.'),
  ]

  test('a person message is a user row with text and no tool results, not a notice or a summary', () => {
    expect(rows.map(r => isPersonMessage(r))).toEqual([
      false, true, false, false, false, false, false, true, false, true, false,
    ])
  })

  test('each person message starts a turn, and a turn ends at its last assistant row', () => {
    expect(turnsOf(rows)).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 4 },
      { start: 7, end: 8 },
      { start: 9, end: 10 },
    ])
    expect(turnOf(rows, 4)).toEqual({ start: 1, end: 4 })
    expect(turnsOf([])).toEqual([])
    expect(turnsOf([row('user', 'Plan the export.'), row('user', '<notice>')])).toEqual([
      { start: 0, end: 1 },
    ])
  })

  test('the rows of a command after the failing reply are not part of its turn', () => {
    const command: SessionMessage[] = [
      row('user', 'Add the checkout.'),
      row('assistant', 'I will add a price table in the client.'),
      row('user', '<command-name>/course-keeper</command-name><command-args>learn it kept prices in the client</command-args>'),
      row('user', '<local-command-stdout>Course keeper read this as the act you corrected</local-command-stdout>'),
    ]
    const turn = turnOf(command, 1)
    expect(turn).toEqual({ start: 0, end: 1 })
    const text = sessionExcerpt(command, turn)
    expect(text).not.toContain('command-name')
    expect(text).not.toContain('local-command-stdout')
    expect(text).toContain("## The agent's latest turn\n\nINPUT: Add the checkout.\n\nAGENT: I will add a price table in the client.")
  })

  test('a user row right after tool results is inside the agent\'s turn, not a person message', () => {
    const skill: SessionMessage[] = [
      row('user', 'Plan the export.'),
      row('assistant', '', { toolUses: [{ tool_use_id: 's', tool: 'Skill', input: { skill: 'x' } }] }),
      row('user', '', { toolResults: [{ tool_use_id: 's', text: 'Launching skill: x', isError: false }] }),
      row('user', 'Base directory for this skill: /x. Always round totals.'),
      row('assistant', 'I will round the total in the exporter.'),
      row('user', '[Request interrupted by user]'),
      row('user', 'Stop rounding.'),
      row('assistant', 'Stopped.'),
    ]
    expect(skill.map((r, k) => isPersonMessage(r, skill[k - 1]))).toEqual([
      true, false, false, false, false, true, true, false,
    ])
    expect(turnsOf(skill)).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 5 },
      { start: 6, end: 7 },
    ])
    const text = sessionExcerpt(skill, { start: 0, end: 4 })
    expect(text).toContain('## Messages the person sent, oldest first\n\nPlan the export.\n\n##')
    expect(text).toContain('INPUT: Base directory for this skill')
  })

  test('earlier turns hold an assistant row, newest first, at most three', () => {
    expect(earlierTurns(rows, { start: 9, end: 10 })).toEqual([
      { start: 7, end: 8 },
      { start: 1, end: 4 },
      { start: 0, end: 0 },
    ])
    expect(earlierTurns(rows, { start: 9, end: 10 }, 1)).toEqual([{ start: 7, end: 8 }])
    expect(earlierTurns(rows, { start: 1, end: 4 })).toEqual([{ start: 0, end: 0 }])
    expect(earlierTurns(rows.slice(1), { start: 0, end: 3 })).toEqual([])
  })

  test('the excerpt of a turn', () => {
    expect(sessionExcerpt(rows, { start: 1, end: 6 })).toBe(
      [
        '## Summary that replaced the earlier conversation',
        '',
        summary,
        '',
        '## Messages the person sent, oldest first',
        '',
        'Plan the export.',
        '',
        "## The agent's latest turn",
        '',
        'INPUT: Plan the export.',
        '',
        'AGENT: I will read the file.\n[tool call Read: {"file_path":"a.ts"}]',
        '',
        'INPUT: [tool result: file text]',
        '',
        'AGENT: I will round the total in the exporter.',
        '',
        'INPUT: <task-notification>done</task-notification>',
      ].join('\n'),
    )
  })

  test('person messages come in order up to the turn\'s first row, repeats included', () => {
    const text = sessionExcerpt(rows, { start: 9, end: 10 })
    expect(text).toContain(
      '## Messages the person sent, oldest first\n\nPlan the export.\n\nPlan the export.\n\n' +
        'No, the module computes every amount.\n\n##',
    )
    // A message repeated to reinstate an instruction keeps its later place.
    const again: SessionMessage[] = [
      row('user', 'Never use npm.'),
      row('assistant', 'Noted.'),
      row('user', 'Use npm this once.'),
      row('assistant', 'Done.'),
      row('user', 'Never use npm.'),
      row('assistant', 'Noted again.'),
    ]
    expect(sessionExcerpt(again, { start: 4, end: 5 })).toContain(
      '## Messages the person sent, oldest first\n\n' +
        'Never use npm.\n\nUse npm this once.\n\nNever use npm.\n\n##',
    )
    expect(text).toContain("## The agent's latest turn\n\nINPUT: No, the module computes every amount.\n\nAGENT: You are right.")
    expect(sessionExcerpt(rows, { start: 0, end: 0 })).toBe(
      '## Messages the person sent, oldest first\n\n(none in this part of the session)\n\n' +
        "## The agent's latest turn\n\nAGENT: Hello.",
    )
  })

  test('long parts are cut', () => {
    const long: SessionMessage[] = [
      row('user', `${summary} ${'s'.repeat(50000)}`),
      row('user', 'p'.repeat(5000)),
      row('assistant', 'a'.repeat(70000), {
        toolUses: [{ tool_use_id: 't', tool: 'Bash', input: { command: 'c'.repeat(3000) } }],
      }),
      row('user', '', { toolResults: [{ tool_use_id: 't', text: 'r'.repeat(3000), isError: false }] }),
    ]
    const text = sessionExcerpt(long, { start: 1, end: 3 })
    const summaryPart = text.split('\n\n## Messages')[0] ?? ''
    expect(summaryPart).toContain('\n[... cut ...]\n')
    expect(summaryPart.length).toBe(
      '## Summary that replaced the earlier conversation\n\n'.length + 28000 + 15 + 12000,
    )
    const people = text.split('## Messages the person sent, oldest first\n\n')[1]?.split('\n\n##')[0]
    expect(people).toBe('p'.repeat(3000))
    expect(text).toContain('\n\n[... middle of the turn left out ...]\n\n')
    expect(text).toContain(`[tool result: ${'r'.repeat(1500)}]`)
    const turn = text.split("## The agent's latest turn\n\n")[1] ?? ''
    expect(turn.length).toBe(20000 + 41 + 40000)
  })

  test('only the agent rows that the excerpt keeps of a turn count for the quote', () => {
    const quote = 'I will round the total.'
    const turn = { start: 0, end: 1 }
    expect(excerptKeepsQuote([row('user', 'Plan.'), row('assistant', quote)], turn, quote)).toBe(true)
    // The person's message and an input row hold the words; the agent's row does not.
    expect(
      excerptKeepsQuote([row('user', `You wrote: ${quote}`), row('assistant', 'Other words.')], turn, quote),
    ).toBe(false)
    expect(
      excerptKeepsQuote(
        [
          row('assistant', '', { toolUses: [{ tool_use_id: 't', tool: 'Read', input: {} }] }),
          row('user', '', { toolResults: [{ tool_use_id: 't', text: quote, isError: false }] }),
        ],
        turn,
        quote,
      ),
    ).toBe(false)
    // A long turn: words in the cut middle do not count, words in the kept
    // head and tail do, and a person message with them does not help.
    const middle: SessionMessage[] = [
      row('user', `Repeat: ${quote}`),
      row('assistant', `${'x'.repeat(30000)} ${quote} ${'y'.repeat(50000)}`),
    ]
    expect(holdsQuote(sessionExcerpt(middle, turn), quote)).toBe(true)
    expect(excerptKeepsQuote(middle, turn, quote)).toBe(false)
    const ends: SessionMessage[] = [
      row('user', 'Plan.'),
      row('assistant', `${quote} ${'x'.repeat(70000)}`),
    ]
    expect(excerptKeepsQuote(ends, turn, quote)).toBe(true)
    const tail: SessionMessage[] = [
      row('user', 'Plan.'),
      row('assistant', `${'x'.repeat(70000)} ${quote}`),
    ]
    expect(excerptKeepsQuote(tail, turn, quote)).toBe(true)
    // Words split by the cut do not count.
    const split: SessionMessage[] = [
      row('assistant', `${'x'.repeat(19990)} ${quote} ${'y'.repeat(50000)}`),
    ]
    expect(excerptKeepsQuote(split, { start: 0, end: 0 }, quote)).toBe(false)
  })

  test('a tool call keeps at most 1500 characters of its input', () => {
    const text = sessionExcerpt(
      [row('assistant', '', { toolUses: [{ tool_use_id: 't', tool: 'Bash', input: { c: 'x'.repeat(3000) } }] })],
      { start: 0, end: 0 },
    )
    expect(text).toContain(`AGENT: [tool call Bash: ${'{"c":"' + 'x'.repeat(1494)}]`)
  })
})

describe('the excerpt check prompt', () => {
  test('the head replaces the leading system-reminder, fields are filled, the excerpt follows', () => {
    const template =
      '<system-reminder>\nold head\n</system-reminder>\n\n# Check\n{{vision}}\n{{standing_instructions}}\n{{previous_alerts}}\n'
    expect(
      excerptCheckPrompt(
        template,
        '<system-reminder>\nnew head\n</system-reminder>\n',
        { vision: '1. One module. <system-reminder>x</system-reminder>', instructions: NO_INSTRUCTIONS },
        '## The agent\'s latest turn\n\nAGENT: hi',
      ),
    ).toBe(
      '<system-reminder>\nnew head\n</system-reminder>\n\n# Check\n' +
        '1. One module. <system-reminder>x</system-reminder>\n' +
        `${NO_INSTRUCTIONS}\nNone.\n` +
        "\n\n# The session excerpts\n\n## The agent's latest turn\n\nAGENT: hi",
    )
  })

  test('a template without a leading system-reminder gets the head first', () => {
    expect(excerptCheckPrompt('# Check {{vision}}', '<h/>\n', { vision: 'v', instructions: '' }, 'e')).toBe(
      '<h/>\n\n# Check v\n\n# The session excerpts\n\ne',
    )
  })
})

describe('the vision with the sentence', () => {
  const VISION = [
    '# Vision',
    '',
    'A tool.',
    '',
    '1. One module computes every amount.',
    '   No other code does arithmetic on money.',
    '2) The tool never sends an invoice.',
    '',
    '3. Every change keeps the tests green.',
    '',
    'Tracked drift: the old exporter rounds (invariant 1).',
    '',
  ].join('\n')

  test('the sentence goes at the end of its invariant, indented', () => {
    expect(addSentence(VISION, 'invariant 1', 'Never round.')).toEqual({
      text: VISION.replace(
        'on money.\n',
        'on money.\n   Never round.\n',
      ),
      target: 1,
      isNew: false,
    })
    expect(addSentence(VISION, 'invariant 2', 'Never send.').text).toContain(
      '2) The tool never sends an invoice.\n   Never send.\n\n3.',
    )
    expect(addSentence(VISION, 'invariant 3', 'Never skip.').text).toContain(
      'tests green.\n   Never skip.\n\nTracked drift',
    )
  })

  test('new, or an invariant the vision lacks, is appended after the highest number', () => {
    const appended = `${VISION.trimEnd()}\n\n4. Never guess.\n`
    expect(addSentence(VISION, 'new', 'Never guess.')).toEqual({ text: appended, target: 4, isNew: true })
    expect(addSentence(VISION, 'invariant 9', 'Never guess.')).toEqual({
      text: appended,
      target: 4,
      isNew: true,
    })
    expect(addSentence('# Vision\n\nA tool.', 'new', 'Never guess.')).toEqual({
      text: '# Vision\n\nA tool.\n\n1. Never guess.\n',
      target: 1,
      isNew: true,
    })
  })
})

describe('the learn answers', () => {
  test('the draft shows the act and the quote, not the sentence', () => {
    const text = draftText(draftOf())
    expect(text).toBe(
      [
        'Course keeper read this as the act you corrected:',
        '  The agent planned to round money in the exporter.',
        'The agent\'s words: "I will round the total in the exporter before it writes the file."',
        '',
        'If this is the act: /course-keeper learn yes',
        'If it is not: /course-keeper learn <what the agent did wrong, in your words>',
        'To drop it: /course-keeper learn cancel',
      ].join('\n'),
    )
    expect(text).not.toContain('Never')
  })

  const alert = (reference: string, evidence = 'e') =>
    ({
      kind: 'reply',
      reply: { verdict: 'deviation', reference, alert: 'a', evidence, note: 'n' },
    }) as const
  const silent = { kind: 'reply', reply: { verdict: 'none' } } as const

  test('the report of a verified sentence', () => {
    expect(
      learnReport({
        draft: draftOf(),
        target: 1,
        isNew: false,
        control: silent,
        verify: alert('invariant 1'),
        earlier: { tested: 2, newAlerts: [], noResults: [] },
        version: '0.1.0',
      }),
    ).toBe(
      [
        'Draft sentence for VISION.md, invariant 1:',
        '  Never round, convert or add up money outside the one module, for example the exporter total: call the module instead.',
        '',
        'Test on the turn you corrected: the check alerts with this sentence added.',
        'Test on 2 earlier turns of this session: no new alert.',
        'Must stay allowed: Formatting an amount that the module computed.',
        '',
        'Where it comes from: the agent\'s words "I will round the total in the exporter before it writes the file."; drafted 2026-11-23 UTC by example-model; course keeper 0.1.0.',
        '',
        'This is a draft for the owners of VISION.md. Course keeper does not change the file.',
        '- An alert in the test does not prove that the sentence names the right act. Compare it with what you corrected.',
        '- Widen or narrow it before you add it. In a measurement on 8 recorded catches, 4 of 16 drafts were',
        '  too broad and 4 too narrow.',
        '- Whether an agent that reads the sentence avoids the act is not measured.',
      ].join('\n'),
    )
  })

  test('the other outcomes', () => {
    const report = (input: Partial<Parameters<typeof learnReport>[0]>) =>
      learnReport({
        draft: draftOf({ allowed: '', model: '' }),
        target: 4,
        isNew: true,
        control: silent,
        verify: silent,
        earlier: { tested: 0, newAlerts: [], noResults: [] },
        ...input,
      })

    const plain = report({})
    expect(plain).toContain('Draft sentence for VISION.md, as a new invariant:\n')
    expect(plain).toContain(
      'Test on the turn you corrected: the check stays silent with this sentence added. The sentence is not verified.',
    )
    expect(plain).toContain('Test on earlier turns of this session: no earlier turn to test.')
    expect(plain).not.toContain('Must stay allowed')
    expect(plain).toContain("drafted 2026-11-23 UTC by the session's model.\n")
    expect(report({ verify: { kind: 'no result', reason: 'the reply was malformed' } })).toContain(
      'Test on the turn you corrected: no result (the reply was malformed).',
    )
    expect(report({ verify: alert('invariant 2') })).toContain(
      'the check alerts on invariant 2, not on invariant 4, with this sentence added. The sentence is not verified.',
    )
    expect(report({ control: { kind: 'no result', reason: 'the call failed' } })).toContain(
      "Check with today's vision on the turn you corrected: no result (the call failed).",
    )
    // Today's check alerts elsewhere on the turn: another matter, one line.
    expect(
      report({
        control: {
          kind: 'reply',
          reply: { verdict: 'deviation', reference: 'instruction "no new files"', alert: 'a', evidence: 'e', note: 'n' },
        },
      }),
    ).toContain(
      'as a new invariant:\n  Never round, convert or add up money outside the one module, for example the exporter total: call the module instead.\n\n' +
        'With today\'s vision the check alerts on this turn on instruction "no new files", another matter: "a".\n' +
        'Test on the turn you corrected:',
    )
    expect(plain).not.toContain('another matter')
    expect(
      report({ earlier: { tested: 3, newAlerts: ['x', 'y'], noResults: ['the call failed'] } }),
    ).toContain(
      'Test on 3 earlier turns of this session: 2 new alerts: "x"; "y". Read them: such an alert can be sound. No result on 1 of them (the call failed).',
    )
    expect(report({ earlier: { tested: 1, newAlerts: ['x'], noResults: [] } })).toContain(
      'Test on 1 earlier turn of this session: 1 new alert: "x". Read it: such an alert can be sound.',
    )
    expect(
      report({ earlier: { tested: 2, newAlerts: [], noResults: ['a', 'b'] } }),
    ).toContain('Test on 2 earlier turns of this session: no result (a).')
    expect(report({ earlier: { tested: 2, newAlerts: [], noResults: ['a'] } })).toContain(
      'Test on 2 earlier turns of this session: no new alert. No result on 1 of them (a).',
    )
  })

  test('the answer for a turn too long for the test shows the sentence as not tested', () => {
    expect(untestedReport({ draft: draftOf(), target: 1, isNew: false, version: '0.1.0' })).toBe(
      [
        "The turn you corrected is too long for the test. The agent's words fall in the part that the excerpt leaves out, so the sentence could not be tested. The draft is dropped.",
        '',
        'Draft sentence for VISION.md, invariant 1 (not tested):',
        '  Never round, convert or add up money outside the one module, for example the exporter total: call the module instead.',
        'Must stay allowed: Formatting an amount that the module computed.',
        '',
        'Where it comes from: the agent\'s words "I will round the total in the exporter before it writes the file."; drafted 2026-11-23 UTC by example-model; course keeper 0.1.0.',
        '',
        'This is a draft for the owners of VISION.md. Course keeper does not change the file.',
        '- An alert in the test does not prove that the sentence names the right act. Compare it with what you corrected.',
        '- Widen or narrow it before you add it. In a measurement on 8 recorded catches, 4 of 16 drafts were',
        '  too broad and 4 too narrow.',
        '- Whether an agent that reads the sentence avoids the act is not measured.',
      ].join('\n'),
    )
    expect(
      untestedReport({ draft: draftOf({ allowed: '' }), target: 4, isNew: true }),
    ).toContain('as a new invariant (not tested):\n  Never round')
  })
})

describe('the pending draft in the record', () => {
  test('a valid draft is kept, cleaned; an old record has none', () => {
    expect(normalizeRecord({ v: 1, learn: draftOf() }).learn).toEqual(draftOf())
    expect('learn' in normalizeRecord({ v: 1 })).toBe(false)
    expect('learningSince' in normalizeRecord({ v: 1 })).toBe(false)
    expect(normalizeRecord({ v: 1, learningSince: 5 }).learningSince).toBe(5)
    expect(normalizeRecord({ v: 1, learn: draftOf({ act: 'a\x1b[31mct' }) }).learn?.act).toBe('act')
    expect(normalizeRecord({ v: 1, learn: draftOf({ personCount: 0 }) }).learn?.personCount).toBe(0)
  })

  test('a draft of another shape is dropped', () => {
    for (const bad of [
      'text',
      { ...draftOf(), sentence: 'Do not round.' },
      { ...draftOf(), place: 'somewhere' },
      { ...draftOf(), quote: '' },
      { ...draftOf(), draftedAt: 'now' },
      { ...draftOf(), model: 7 },
      // Written before the draft kept its turn, or of another shape.
      { ...draftOf(), personCount: undefined },
      { ...draftOf(), personCount: -1 },
      { ...draftOf(), personCount: 1.5 },
      { ...draftOf(), personCount: '2' },
    ]) {
      expect('learn' in normalizeRecord({ v: 1, learn: bad })).toBe(false)
    }
  })

  test('withoutDraft removes it and leaves the rest', () => {
    const record = { ...emptyRecord(), learn: draftOf() }
    expect(withoutDraft(record)).toEqual(emptyRecord())
    const empty = emptyRecord()
    expect(withoutDraft(empty)).toBe(empty)
  })
})
