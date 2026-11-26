import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import type { CourseKeeperAlert, CourseKeeperDraft, CourseKeeperSession } from '../types'
import {
  ANTI_PATTERNS_HEADING,
  ANTI_PATTERNS_NOTE,
  CHECK_STALE_MS,
  DEFAULT_ANTI_PATTERNS_FILE,
  DEFAULT_FILE_NAMES,
  DEFAULT_VISION_FILE,
  LEARN_LIMITS,
  LIMITS,
  MAX_INSTRUCTIONS,
  MAX_INSTRUCTION_LENGTH,
  NO_ALERTS,
  NO_INSTRUCTIONS,
  NO_CATCH,
  addAntiPattern,
  addDraftSentence,
  addInstructions,
  addSentence,
  addWithdrawn,
  alertBanner,
  alertHeadline,
  alertRule,
  alertSubject,
  antiPatternsDirective,
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
  quotedRow,
  wasShown,
  hasNumberedItems,
  invariantTitle,
  fileName,
  fencedLines,
  fileNames,
  isCheckRunning,
  isMarkdownOutsideHidden,
  isMarkdownOutsideHiddenUnder,
  isUnderRoot,
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
  visionField,
  withFinalAnswer,
  withoutDraft,
  withoutLeadingReminders,
  plainQuote,
  quotedSentence,
  retried,
  noteText,
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
  test('escaped quotes in the evidence come back plain', () => {
    const reply = DEVIATION.replace(
      /evidence: .*/,
      String.raw`evidence: "vat = round(total * Decimal(\"0.19\"), 2)\" and \"total_with_vat = total + vat"`,
    )

    expect(parseCheckReply(reply)).toMatchObject({
      evidence: 'vat = round(total * Decimal("0.19"), 2)" and "total_with_vat = total + vat',
    })
  })

  test('a double backslash stays, so a quoted network path keeps its text', () => {
    const reply = DEVIATION.replace(/evidence: .*/, String.raw`evidence: "copy it to \\server\share"`)

    expect(parseCheckReply(reply)).toMatchObject({ evidence: String.raw`copy it to \\server\share` })
  })

  test('an alert stored with escaped quotes before 0.6.1 is not raised again', () => {
    const record = {
      ...normalizeRecord(undefined),
      alerts: [alertOf({ evidence: String.raw`call Decimal(\"0.19\") here` })],
    }

    expect(wasShown(record, 'invariant 2', 'call Decimal("0.19") here')).toBe(true)
  })

    test('a backslash that is not before a quote stays', () => {
    const reply = DEVIATION.replace(/evidence: .*/, String.raw`evidence: "split on \n and \d+ here"`)

    expect(parseCheckReply(reply)).toMatchObject({
      evidence: String.raw`split on \n and \d+ here`,
    })
  })

  test('a deviation is read field by field', () => {
    expect(parseCheckReply(DEVIATION)).toEqual({
      verdict: 'deviation',
      reference: 'invariant 2',
      alert: 'The session adds a second pricing path, which contradicts invariant 2.',
      evidence: 'I will add a fallback price table in the client.',
      note: 'Invariant 2 says one service sets every price. Keep the price in that service.',
    })
  })

  test('a reply without instead is a deviation without the field', () => {
    expect(parseCheckReply(DEVIATION)).not.toHaveProperty('instead')
    expect(parseCheckReply(DEVIATION.replace('evidence:', 'instead:  \nevidence:'))).not.toHaveProperty(
      'instead',
    )
  })

  test('instead is read cleaned and cut to 160 characters', () => {
    const reply = DEVIATION.replace('evidence:', 'instead: Keep the price in \x1b[31mthe service.\nevidence:')
    expect(parseCheckReply(reply)).toMatchObject({ instead: 'Keep the price in the service.' })
    const long = parseCheckReply(DEVIATION.replace('evidence:', `instead: ${'word '.repeat(60)}\nevidence:`))
    const instead = long?.verdict === 'deviation' ? long.instead : undefined
    expect(Array.from(instead ?? '').length).toBeLessThanOrEqual(LIMITS.instead)
    expect(instead?.endsWith('…')).toBe(true)
  })

  test('an instead line is its own field, never a continuation of the alert', () => {
    const reply = [
      'verdict: deviation',
      'reference: invariant 2',
      'alert: The session adds a second pricing path,',
      '  which contradicts invariant 2.',
      'instead: Keep the price in the one service.',
      'evidence: "I will add a fallback price table in the client."',
      'note: Keep the price in that service.',
    ].join('\n')

    expect(parseCheckReply(reply)).toMatchObject({
      alert: 'The session adds a second pricing path, which contradicts invariant 2.',
      instead: 'Keep the price in the one service.',
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
      ['instruction "never push to main" (the person wrote "main")', 'instruction "never push to main"'],
      ["instruction 'keep users' data private'", `instruction "keep users' data private"`],
    ] as const) {
      const reply = DEVIATION.replace('reference: invariant 2', `reference: ${reference}`)
      const parsed = parseCheckReply(reply)
      const got = parsed?.verdict === 'deviation' ? parsed.reference : parsed
      expect([reference, got]).toEqual([reference, canonical])
    }
  })

  test("an invariant's quoted words are accepted in canonical form, without bold marks or the end period", () => {
    for (const [reference, canonical] of [
      ['invariant "One service sets every price"', 'invariant "One service sets every price"'],
      ['invariant "One service sets every price."', 'invariant "One service sets every price"'],
      ['Invariant: “One service sets every price.”', 'invariant "One service sets every price"'],
      ['`invariant "**The tool never sends an invoice.**"`', 'invariant "The tool never sends an invoice"'],
      ["invariant 'Keine Rundung im Export'", 'invariant "Keine Rundung im Export"'],
      ['invariant "One service sets every price" (the second bullet)', 'invariant "One service sets every price"'],
      [String.raw`invariant "Use \"strict\" mode."`, 'invariant "Use "strict" mode"'],
      ['invariant “Use "strict" mode.”', 'invariant "Use "strict" mode"'],
      ['invariant "Use "strict" mode." (the third bullet)', 'invariant "Use "strict" mode"'],
      ['invariant "**One service sets every price**."', 'invariant "One service sets every price"'],
      ['invariant "Wait for the build..."', 'invariant "Wait for the build..."'],
      ['invariant "**Wait for the build...**."', 'invariant "Wait for the build..."'],
      [
        'invariant "One service sets every price" (the model wrote "a price table")',
        'invariant "One service sets every price"',
      ],
      [
        String.raw`invariant "Use \"strict\" mode" (as in "strict mode")`,
        'invariant "Use "strict" mode"',
      ],
      ["invariant 'Don't round the export' (the 'export' bullet)", `invariant "Don't round the export"`],
      ['invariant "Never pass "--force" to Git."', 'invariant "Never pass "--force" to Git"'],
      ["invariant 'Keep users' data private'", `invariant "Keep users' data private"`],
      ['invariant “Treat “off” as disabled.” (the “flags” bullet)', 'invariant "Treat “off” as disabled"'],
      ['invariant "Never select columns with SELECT *."', 'invariant "Never select columns with SELECT *"'],
      [String.raw`invariant "Paths end in \\" (the root)`, String.raw`invariant "Paths end in \\"`],
    ] as const) {
      const reply = DEVIATION.replace('reference: invariant 2', `reference: ${reference}`)
      const parsed = parseCheckReply(reply)
      const got = parsed?.verdict === 'deviation' ? parsed.reference : parsed
      expect([reference, got]).toEqual([reference, canonical])
    }
  })

  test('invariant words that are empty, unquoted or unclosed are malformed', () => {
    for (const reference of [
      'invariant ""',
      'invariant: " "',
      'invariant "."',
      'invariant "**.**"',
      'invariant one service sets every price',
      'invariant "one service sets every price',
      'invariants "one service"',
    ]) {
      const reply = DEVIATION.replace('reference: invariant 2', `reference: ${reference}`)
      expect([reference, parseCheckReply(reply)]).toEqual([reference, undefined])
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
        '"I will add a fallback price table in the client." ' +
        "The person's answer: false alarm (the person says this is no deviation, or wanted it).\n",
    )
  })

  test('the alert list and the note close a quote with a period only when it has no end mark', () => {
    const ended = alertOf({ note: 'Keep the price in one service.' })
    const open = alertOf({ evidence: 'a fallback price table', answer: 'told the agent' })

    expect(formatAlerts({ ...emptyRecord(), alerts: [ended, open] })).toBe(
      '1. invariant 2: The session adds a second pricing path. Evidence: ' +
        '"I will add a fallback price table in the client." ' +
        "The person's answer: none yet.\n" +
        '2. invariant 2: The session adds a second pricing path. Evidence: ' +
        '"a fallback price table". The person\'s answer: told the agent.',
    )
    expect(noteText(ended)).toBe(
      'Course Keeper alert on invariant 2. Evidence: ' +
        '"I will add a fallback price table in the client." Note: Keep the price in one service.',
    )
    expect(noteText(open)).toBe(
      'Course Keeper alert on invariant 2. Evidence: "a fallback price table". ' +
        'Note: Keep the price in one service.',
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

  test('invariant words quoted again with or without their end period are the same reference', () => {
    const reference = 'invariant "One service sets every price"'
    const record = { ...emptyRecord(), alerts: [alertOf({ reference, answer: 'dismissed' })] }
    const reply = parseCheckReply(
      DEVIATION.replace('reference: invariant 2', 'reference: invariant "One service sets every price."'),
    )

    expect(applyReply(record, reply, 2000).outcome).toBe(`verdict: deviation (${reference}), already shown`)
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

  test('a new alert keeps the title it is given', () => {
    const reply = parseCheckReply(DEVIATION)
    expect(applyReply(emptyRecord(), reply, 2000, 'One service sets every price').shown?.title).toBe(
      'One service sets every price',
    )
    expect(applyReply(emptyRecord(), reply, 2000).shown).not.toHaveProperty('title')
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

describe('the headline', () => {
  const VISION = [
    '# Vision',
    '',
    'A command-line tool that turns timesheets into invoices.',
    '',
    '1. One module computes every amount. No other code does arithmetic on money.',
    '2. **The tool never sends an invoice.** It writes files; the person sends them.',
    `3. Every change keeps the test suite green on the three supported platforms${' and more'.repeat(5)}`,
    '',
  ].join('\n')

  test("an invariant's title is its bold lead, else its first sentence, without the period", () => {
    expect(invariantTitle(VISION, 'invariant 1')).toBe('One module computes every amount')
    expect(invariantTitle(VISION, 'invariant 2')).toBe('The tool never sends an invoice')
  })

  test('a long title is cut to 60 characters with an ellipsis', () => {
    const title = invariantTitle(VISION, 'invariant 3')
    expect(title).toHaveLength(60)
    expect(title?.endsWith('…')).toBe(true)
  })

  test('no title for a missing item, an instruction, or a title that is empty', () => {
    expect(invariantTitle(VISION, 'invariant 9')).toBeUndefined()
    // A lead that wraps is read to its end; a numbered step inside an invariant is not one.
    const wrapped = '1. **One module\n   computes every amount.** No other code.\n   1. First step.\n   2. Second step.\n2. The tool sends\n   nothing. It writes files.\n'
    expect(invariantTitle(wrapped, 'invariant 1')).toBe('One module computes every amount')
    expect(invariantTitle(wrapped, 'invariant 2')).toBe('The tool sends nothing')
    expect(invariantTitle(VISION, 'instruction "1. never"')).toBeUndefined()
    expect(invariantTitle('1. **  **', 'invariant 1')).toBeUndefined()
  })

  test('an invariant reference names the invariant and its title when the alert has one', () => {
    expect(alertHeadline(alertOf({ title: 'One service sets every price' }))).toBe(
      'Course Keeper: this session breaks invariant 2 (One service sets every price)',
    )
    expect(alertHeadline(alertOf())).toBe('Course Keeper: this session breaks invariant 2')
  })

  test('an instruction reference quotes the words, cut to 60 characters', () => {
    expect(alertSubject(alertOf({ reference: 'instruction "never post without my yes"' }))).toBe(
      'this session breaks your instruction "never post without my yes"',
    )
    const long = `never ${'post '.repeat(20)}`.trim()
    expect(alertSubject(alertOf({ reference: `instruction "${long}"` }))).toBe(
      `this session breaks your instruction "${clean(long, 60)}"`,
    )
  })

  test('a vision with bullet rules gets a headline that quotes the rule', () => {
    const bullets = [
      '# Vision',
      '',
      '- One module computes every amount. No other code does arithmetic on money.',
      '- **The tool never sends an invoice.** It writes files; the person sends them.',
      '',
    ].join('\n')
    const reply = parseCheckReply(
      DEVIATION.replace('reference: invariant 2', 'reference: invariant "The tool never sends an invoice."'),
    )
    if (reply?.verdict !== 'deviation') throw new Error('expected a deviation')
    // The words stand in the reference; the vision gives no title for it.
    expect(invariantTitle(bullets, reply.reference)).toBeUndefined()
    const alert = alertOf({ reference: reply.reference })

    expect(alertHeadline(alert)).toBe(
      'Course Keeper: this session breaks your rule "The tool never sends an invoice"',
    )
    expect(alertBanner(alert)).toBe('Session breaks your rule')
    expect(alertRule(alert)).toEqual({ label: 'Your rule', words: 'The tool never sends an invoice' })
  })

  test('long invariant words are cut to 60 characters, also when the stored reference lost its closing mark', () => {
    const long = `Every change keeps the test suite green${' and more'.repeat(5)}`
    expect(alertSubject(alertOf({ reference: `invariant "${long}"` }))).toBe(
      `this session breaks your rule "${clean(long, 60)}"`,
    )
    expect(alertSubject(alertOf({ reference: `invariant "${long}` }))).toBe(
      `this session breaks your rule "${clean(long, 60)}"`,
    )
  })

  test('a numbered vision keeps the number and its title in the headline', () => {
    const reply = parseCheckReply(DEVIATION)
    if (reply?.verdict !== 'deviation') throw new Error('expected a deviation')
    const title = invariantTitle(VISION, reply.reference)
    const alert = alertOf({ reference: reply.reference, ...(title === undefined ? {} : { title }) })

    expect(alertHeadline(alert)).toBe(
      'Course Keeper: this session breaks invariant 2 (The tool never sends an invoice)',
    )
    expect(alertBanner(alert)).toBe('Session breaks invariant 2')
    expect(alertRule(alert)).toEqual({ label: 'Your rule', words: 'The tool never sends an invoice' })
  })

  test('another reference is named as it stands', () => {
    expect(alertSubject(alertOf({ reference: 'rule x', title: 'ignored' }))).toBe(
      'this session breaks rule x',
    )
  })
})

describe('the quote', () => {
  test('drops Markdown inline marks and keeps their text', () => {
    expect(plainQuote('2. **Refuse transfers** until `fee` data is _complete_.')).toBe(
      '2. Refuse transfers until fee data is complete.',
    )
    expect(plainQuote('use __this__ and *that*')).toBe('use this and that')
  })

  test('keeps underscores and stars that are not emphasis', () => {
    expect(plainQuote('set max_fee_bps to 2 * 3')).toBe('set max_fee_bps to 2 * 3')
  })

  test('keeps the text of a code span exactly', () => {
    expect(plainQuote('read `obj.__dict__` and `**kwargs` **now**')).toBe(
      'read obj.__dict__ and **kwargs now',
    )
  })
})

describe('a refused call tried again', () => {
  test('stops at the first attempt that goes through', async () => {
    let calls = 0
    let waits = 0
    const ok = await retried(
      async () => (++calls < 3 ? { deny: 'not drawn yet' } : {}),
      async () => {
        waits += 1
      },
      10,
    )
    expect(ok).toBe(true)
    expect(calls).toBe(3)
    expect(waits).toBe(2)
  })

  test('stops at once on a refusal named final', async () => {
    let calls = 0
    const ok = await retried(
      async () => {
        calls += 1

        return { deny: 'the window moved meanwhile' }
      },
      async () => undefined,
      10,
      deny => /moved meanwhile/.test(deny),
    )
    expect(ok).toBe(false)
    expect(calls).toBe(1)
  })

  test('gives up after the last try without a final wait', async () => {
    let waits = 0
    const ok = await retried(
      async () => ({ deny: 'never' }),
      async () => {
        waits += 1
      },
      3,
    )
    expect(ok).toBe(false)
    expect(waits).toBe(2)
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

  test('leading system-reminder blocks are taken off the prompt, later ones stay', () => {
    const block = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`
    expect(withoutLeadingReminders(`${block('Always answer in French.')}\n\nnever post without my yes`)).toBe(
      'never post without my yes',
    )
    expect(
      withoutLeadingReminders(`\n ${block('one')}\n${block('two')}\n\n  never post without my yes `),
    ).toBe('never post without my yes ')
    expect(withoutLeadingReminders(`${block('one')}\n\n${block('two')}\n`)).toBe('')
    expect(shouldExtract(withoutLeadingReminders(`${block('never post without my yes')}`), false, false)).toBe(
      false,
    )
    const mid = `never post without my yes\n\n${block('Always answer in French.')}`
    expect(withoutLeadingReminders(mid)).toBe(mid)
    expect(withoutLeadingReminders('  never post without my yes\n')).toBe('  never post without my yes\n')
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

  test("an alert's instead is read cleaned; an old, bad or empty one is dropped", () => {
    const read = normalizeRecord({
      v: 1,
      current: { ...alertOf(), instead: 'Keep the price \x1b[31min one service.' },
      alerts: [alertOf(), { ...alertOf(), instead: 7 }, { ...alertOf(), instead: ' ' }],
    })

    expect(read.current?.instead).toBe('Keep the price in one service.')
    for (const alert of read.alerts) expect(alert).not.toHaveProperty('instead')
  })

  test('a new alert keeps the instead of the reply, and the status lists it', () => {
    const reply = parseCheckReply(DEVIATION.replace('evidence:', 'instead: Keep the price in one service.\nevidence:'))
    const done = applyReply(emptyRecord(), reply, 2000)

    expect(done.shown?.instead).toBe('Keep the price in one service.')
    expect(statusText(done.record, undefined)).toContain(
      '  1. invariant 2: The session adds a second pricing path, which contradicts invariant 2. ' +
        'Instead: Keep the price in one service. Answer: none yet.',
    )
    expect(statusText({ ...emptyRecord(), current: alertOf() }, undefined)).toContain(
      '  1. invariant 2: The session adds a second pricing path. Answer: none yet.',
    )
  })

  test("an alert's title is read cleaned and cut; a bad or empty one is dropped", () => {
    const read = normalizeRecord({
      v: 1,
      current: { ...alertOf(), title: `\x1b[31mOne${' word'.repeat(20)}` },
      alerts: [{ ...alertOf(), title: 7 }, { ...alertOf(), title: ' ' }, alertOf()],
    })

    expect(read.current?.title).toBe(clean(`One${' word'.repeat(20)}`, 60))
    expect(read.current?.title?.endsWith('…')).toBe(true)
    for (const alert of read.alerts) expect(alert).not.toHaveProperty('title')
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
  test('an escaped quote in the quote still finds the reply that holds it', () => {
    const reply = DRAFT_REPLY.replace(
      /^quote: .*$/m,
      String.raw`quote: "I will call Decimal(\"0.19\") in the exporter."`,
    )
    const parsed = parseLearnReply(reply) as { quote: string }
    const rows = [
      row('user', 'Add VAT.'),
      row('assistant', 'I will call Decimal("0.19") in the exporter.'),
      row('user', 'No, keep money in the money module.'),
    ]

    expect(quotedRow(rows, parsed.quote)).toEqual({
      quote: 'I will call Decimal("0.19") in the exporter.',
      at: 1,
    })
  })

  test("a backslash before a quote in the agent's own words still matches", () => {
    const words = String.raw`I will run echo \"hi\" in the exporter.`
    const rows = [
      row('user', 'Add VAT.'),
      row('assistant', words),
      row('user', 'No.'),
    ]

    expect(quotedRow(rows, words)).toEqual({ quote: words, at: 1 })
    expect(quotedRow(rows, 'words nobody wrote')).toBeUndefined()
  })

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
      row('user', '<local-command-stdout>Course Keeper read this as the act you corrected</local-command-stdout>'),
    ]
    const turn = turnOf(command, 1)
    expect(turn).toEqual({ start: 0, end: 1 })
    const text = sessionExcerpt(command, turn)
    expect(text).not.toContain('command-name')
    expect(text).not.toContain('local-command-stdout')
    expect(text).toContain("## The agent's latest turn\n\nINPUT: Add the checkout.\n\nAGENT: I will add a price table in the client.")
  })

  test('a person message after leading system-reminder blocks counts, without the blocks', () => {
    const reminder = '<system-reminder>\nThe app moved this session to another folder.\n</system-reminder>\n\n'
    const reminded: SessionMessage[] = [
      row('user', 'Name the invoice files.'),
      row('assistant', 'Each file now carries its number.'),
      row('user', '<command-name>/course-keeper</command-name><command-args>check</command-args>'),
      row('user', `${reminder}Show the totals per client.`),
      row('assistant', 'The exporter now shows the totals per client.'),
      row('user', `${reminder}${reminder}`),
      row('user', `${reminder}<task-notification>done</task-notification>`),
    ]
    expect(reminded.map((r, k) => isPersonMessage(r, reminded[k - 1]))).toEqual([
      true, false, false, true, false, false, false,
    ])
    expect(turnsOf(reminded)).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ])
    expect(personCountAt(reminded, 3)).toBe(2)
    const text = sessionExcerpt(reminded, { start: 3, end: 4 })
    expect(text).toContain(
      '## Messages the person sent, oldest first\n\nName the invoice files.\n\nShow the totals per client.\n\n##',
    )
    const person = text.slice(0, text.indexOf("## The agent's latest turn"))
    expect(person).not.toContain('system-reminder')
    expect(person).not.toContain('moved this session')
    // The turn's rows stay as the agent saw them.
    expect(text).toContain(`## The agent's latest turn\n\nINPUT: ${reminder}Show the totals per client.`)
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

describe('the anti-patterns file', () => {
  const VISION = '# Vision\n\nA tool.\n\n1. One module computes every amount.\n2. The tool never sends an invoice.\n'
  const ANTI_PATTERNS = [
    '# Anti-patterns for the vision',
    '',
    '## 1. One module computes every amount',
    '',
    '- Never round money in other code.',
    '',
    '## 2) The tool never sends an invoice',
    '',
    '- Never call the mail client from the tool.',
    '',
  ].join('\n')

  test('the vision field is the vision alone without an anti-patterns file or with an empty one', () => {
    expect(visionField(VISION, undefined)).toBe(VISION)
    expect(visionField(VISION, ' \n\n')).toBe(VISION)
  })

  test('the vision field holds the anti-patterns text under its own heading', () => {
    expect(visionField(VISION, ANTI_PATTERNS)).toBe(
      `${VISION.trimEnd()}\n\n${ANTI_PATTERNS_HEADING}\n${ANTI_PATTERNS_NOTE}\n\n${ANTI_PATTERNS}`,
    )
    expect(ANTI_PATTERNS_HEADING).toBe('# Anti-patterns: acts that break the invariants above')
  })

  test('an anti-pattern goes at the end of its section, before the blank lines', () => {
    expect(addAntiPattern(ANTI_PATTERNS, 1, 'Never convert money in the client.')).toBe(
      ANTI_PATTERNS.replace(
        'other code.\n',
        'other code.\n- Never convert money in the client.\n',
      ),
    )
    expect(addAntiPattern(ANTI_PATTERNS, 2, 'Never queue a mail.')).toBe(
      ANTI_PATTERNS.replace('from the tool.\n', 'from the tool.\n- Never queue a mail.\n'),
    )
    // A section that holds only its heading gets a blank line first.
    expect(addAntiPattern('### 3. Tests\n\n## 4. Other\n', 3, 'Never skip.')).toBe(
      '### 3. Tests\n\n- Never skip.\n\n## 4. Other\n',
    )
  })

  test('an anti-pattern for an invariant without a section starts a new section at the end', () => {
    expect(addAntiPattern(ANTI_PATTERNS, 3, 'Never skip a test.')).toBe(
      `${ANTI_PATTERNS.trimEnd()}\n\n## 3.\n\n- Never skip a test.\n`,
    )
    expect(addAntiPattern('', 1, 'Never round.')).toBe('## 1.\n\n- Never round.\n')
    // Section 13 is not section 1, and the new bare heading is found again.
    const once = addAntiPattern('## 13. Other\n', 1, 'Never round.')
    expect(once).toBe('## 13. Other\n\n## 1.\n\n- Never round.\n')
    expect(addAntiPattern(once, 1, 'Never add.')).toBe(
      '## 13. Other\n\n## 1.\n\n- Never round.\n- Never add.\n',
    )
  })

  test('a heading inside a fenced code block is not a section', () => {
    // A fenced "## 1." before the real section does not take the sentence.
    const fencedFirst = '# Anti\n\n```markdown\n## 1. Example\n```\n\n## 1. Real\n\n- Never A.\n'
    expect(addAntiPattern(fencedFirst, 1, 'Never B.')).toBe(`${fencedFirst}- Never B.\n`)
    // A fenced heading does not end the section: the bullet goes after the block.
    const fencedInside = '## 1. Real\n\n- Never A.\n\n~~~\n## 2. Example\n~~~\n\n## 2. Next\n'
    expect(addAntiPattern(fencedInside, 1, 'Never B.')).toBe(
      '## 1. Real\n\n- Never A.\n\n~~~\n## 2. Example\n~~~\n- Never B.\n\n## 2. Next\n',
    )
    // Only a fenced section: a new section is added.
    expect(addAntiPattern('````\n## 1. Example\n```\n````\n', 1, 'Never B.')).toBe(
      '````\n## 1. Example\n```\n````\n\n## 1.\n\n- Never B.\n',
    )
  })

  test('fenced lines: both fence kinds, a longer close, an indented fence, an unclosed block', () => {
    expect(fencedLines(['a', '```js', '# x', '```', 'b'])).toEqual([false, true, true, true, false])
    expect(fencedLines(['~~~', '```', '~~~~', 'b'])).toEqual([true, true, true, false])
    expect(fencedLines(['   ```', '# x', '``` js', '```', 'b'])).toEqual([true, true, true, true, false])
    expect(fencedLines(['    ```', '# x'])).toEqual([false, false])
    expect(fencedLines(['```', '# x'])).toEqual([true, true])
  })

  test('with an anti-patterns file, a sentence for an invariant goes into the anti-patterns text', () => {
    expect(addDraftSentence(VISION, ANTI_PATTERNS, 'invariant 2', 'Never queue a mail.')).toEqual({
      text: visionField(VISION, addAntiPattern(ANTI_PATTERNS, 2, 'Never queue a mail.')),
      target: 2,
      isNew: false,
      inAntiPatterns: true,
    })
    // The vision has no invariant 9: the sentence is a new invariant of the vision.
    expect(addDraftSentence(VISION, ANTI_PATTERNS, 'invariant 9', 'Never guess.')).toMatchObject({
      isNew: true,
      inAntiPatterns: false,
    })
    // A heading with the number and no mark after it is the invariant's section.
    expect(addAntiPattern('## 1 Pricing\n\n- Never C.\n\n## 10 Other\n', 1, 'Never B.')).toBe(
      '## 1 Pricing\n\n- Never C.\n- Never B.\n\n## 10 Other\n',
    )
  })

  test('a new invariant, or no anti-patterns file, goes into the vision', () => {
    expect(addDraftSentence(VISION, ANTI_PATTERNS, 'new', 'Never guess.')).toEqual({
      text: visionField(`${VISION}\n3. Never guess.\n`, ANTI_PATTERNS),
      target: 3,
      isNew: true,
      inAntiPatterns: false,
    })
    expect(addDraftSentence(VISION, undefined, 'invariant 1', 'Never round.')).toEqual({
      ...addSentence(VISION, 'invariant 1', 'Never round.'),
      inAntiPatterns: false,
    })
  })

  test('the status shows the anti-patterns file under VISION.md', () => {
    expect(statusText(emptyRecord(), '/r/VISION.md', '/r/ANTI-PATTERNS.md')).toMatch(
      /^VISION\.md: \/r\/VISION\.md\nANTI-PATTERNS\.md: \/r\/ANTI-PATTERNS\.md\nChecks: on/,
    )
    expect(statusText(emptyRecord(), '/r/VISION.md')).not.toContain('ANTI-PATTERNS.md')
  })

  test('the status says that the anti-patterns file needs a numbered vision', () => {
    const bullets = '# Vision\n\n- **One module computes every amount.**\n- The tool sends nothing.\n'
    const note =
      '  VISION.md has no numbered list. The sections of ANTI-PATTERNS.md ' +
      'and the learn step find an invariant only by its number.'
    const status = (anti: string | undefined, vision: string) =>
      statusText(emptyRecord(), '/r/VISION.md', anti, DEFAULT_FILE_NAMES, undefined, vision)
    expect(status('/r/ANTI-PATTERNS.md', bullets)).toMatch(
      /^VISION\.md: \/r\/VISION\.md\nANTI-PATTERNS\.md: \/r\/ANTI-PATTERNS\.md\n {2}VISION\.md has no numbered list\. .*\nChecks: on/,
    )
    expect(status('/r/ANTI-PATTERNS.md', bullets)).toContain(note)
    // Without an anti-patterns file a bullet vision needs no note.
    expect(status(undefined, bullets)).not.toContain('numbered')
    // A numbered vision gets no note, with either item mark.
    expect(status('/r/ANTI-PATTERNS.md', VISION)).not.toContain('numbered')
    expect(status('/r/ANTI-PATTERNS.md', VISION.replace(/^(\d+)\./gm, '$1)'))).not.toContain('numbered')
    expect(hasNumberedItems(bullets)).toBe(false)
    expect(hasNumberedItems(VISION)).toBe(true)
  })

  test('the status names the configured files', () => {
    const names = { vision: 'docs/course.md', antiPatterns: 'docs/avoid.md' }
    expect(statusText(emptyRecord(), '/r/docs/course.md', '/r/docs/avoid.md', names)).toMatch(
      /^docs\/course\.md: \/r\/docs\/course\.md\ndocs\/avoid\.md: \/r\/docs\/avoid\.md\nChecks: on/,
    )
    expect(statusText(emptyRecord(), undefined, undefined, names)).toMatch(
      /^docs\/course\.md: not found\. No checks run without it\.\n/,
    )
  })

  test('the status says when the vision names the anti-patterns file', () => {
    const names = { vision: 'VISION.md', antiPatterns: 'docs/avoid.md' }
    expect(statusText(emptyRecord(), '/r/VISION.md', '/r/docs/avoid.md', names, 'read')).toMatch(
      /^VISION\.md: \/r\/VISION\.md\ndocs\/avoid\.md: \/r\/docs\/avoid\.md \(named in VISION\.md\)\nChecks: on/,
    )
    expect(statusText(emptyRecord(), '/r/VISION.md', undefined, names, 'missing')).toMatch(
      /^VISION\.md: \/r\/VISION\.md\ndocs\/avoid\.md: not found or not readable \(named in VISION\.md\)\. The vision alone is used\.\nChecks: on/,
    )
    expect(statusText(emptyRecord(), '/r/VISION.md', undefined, names, 'vision')).toMatch(
      /^VISION\.md: \/r\/VISION\.md\ndocs\/avoid\.md: the vision itself \(named in VISION\.md\)\. No separate file is used\.\nChecks: on/,
    )
    // A refused directive: one line says so, and the configured file stays in force.
    expect(statusText(emptyRecord(), '/r/VISION.md', '/r/ANTI-PATTERNS.md', DEFAULT_FILE_NAMES, 'refused')).toMatch(
      /^VISION\.md: \/r\/VISION\.md\n<!-- course-keeper: anti-patterns --> in VISION\.md is not used: it must name a Markdown file in the project, outside hidden folders\.\nANTI-PATTERNS\.md: \/r\/ANTI-PATTERNS\.md\nChecks: on/,
    )
  })
})

describe('the anti-patterns file named in the vision', () => {
  const named = (name: string) => ({ kind: 'named', name })
  const REFUSED = { kind: 'refused' }

  test('the comment on the first line that is not empty names the file, with any spaces and any case', () => {
    expect(antiPatternsDirective('<!-- course-keeper: anti-patterns = docs/vision/anti-patterns.md -->\n# V\n')).toEqual(
      named('docs/vision/anti-patterns.md'),
    )
    expect(antiPatternsDirective('<!--Course-Keeper:Anti-Patterns=AVOID.MD-->')).toEqual(named('AVOID.MD'))
    expect(
      antiPatternsDirective('\n \t\n\r\n \t<!--  course-keeper:\tanti-patterns =\t./docs//avoid.markdown  -->\t \r\n# V\r\n'),
    ).toEqual(named('docs/avoid.markdown'))
    expect(antiPatternsDirective('﻿<!-- course-keeper: anti-patterns = avoid.md -->\n# V\n')).toEqual(
      named('avoid.md'),
    )
    expect(antiPatternsDirective('﻿\n\n<!-- course-keeper: anti-patterns = avoid.md -->\n')).toEqual(
      named('avoid.md'),
    )
  })

  test('the comment counts on no other line', () => {
    const real = '<!-- course-keeper: anti-patterns = docs/avoid.md -->'
    const example = '<!-- course-keeper: anti-patterns = example.md -->'
    expect(antiPatternsDirective(`# V\n${real}\n`)).toBe(undefined)
    expect(antiPatternsDirective(`\n# V\n\n${real}\n`)).toBe(undefined)
    for (const later of [
      `\`\`\`markdown\n${example}\n\`\`\``,
      `~~~\n${example}\n~~~`,
      `Write \`${example}\` in the vision.`,
      `Write \`\`${example}\`\` in the vision.`,
      `Write \`\`\n${example}\n\`\` in the vision.`,
      `Then ${example}`,
      example,
    ]) {
      expect(antiPatternsDirective(`# V\n\n${later}\n`)).toBe(undefined)
      expect(antiPatternsDirective(`${real}\n# V\n\n${later}\n`)).toEqual(named('docs/avoid.md'))
    }
    // A refused first line stays refused; a later line does not replace it.
    expect(antiPatternsDirective(`<!-- course-keeper: anti-patterns = ../a.md -->\n${real}\n`)).toEqual(REFUSED)
  })

  test('no directive, another key or a split line is no directive', () => {
    for (const vision of [
      '',
      ' \n\t\r\n',
      '# Vision\n\n1. One service sets every price.\n',
      'course-keeper: anti-patterns = avoid.md',
      '<!-- course-keeper: vision = avoid.md -->',
      '<!-- anti-patterns = avoid.md -->',
      '<!-- course-keeper : anti-patterns = avoid.md -->',
      '<!-- course-keeper: anti-patterns =\navoid.md -->',
      '`<!-- course-keeper: anti-patterns = avoid.md -->`',
      'See <!-- course-keeper: anti-patterns = avoid.md -->',
      '<!-- course-keeper: anti-patterns = avoid.md --> # V',
    ]) {
      expect(antiPatternsDirective(vision)).toBe(undefined)
    }
  })

  test('an unsafe path, a file that is not Markdown or a hidden folder is refused', () => {
    for (const value of [
      '',
      '../avoid.md',
      '/etc/passwd.md',
      '~/avoid.md',
      'docs\\avoid.md',
      'avoid\u0000.md',
      `${'a'.repeat(198)}.md`,
      '.env',
      'config/secrets.json',
      'avoid.md.txt',
      '.github/x.md',
      'docs/.hidden/x.md',
      '.avoid.md',
    ]) {
      expect(antiPatternsDirective(`<!-- course-keeper: anti-patterns = ${value} -->`)).toEqual(REFUSED)
    }
  })
})

describe('a file that a project may name', () => {
  test('a Markdown file outside hidden folders may be read', () => {
    for (const good of ['docs/vision/anti-patterns.md', 'AVOID.MD', 'docs/avoid.markdown']) {
      expect(isMarkdownOutsideHidden(good)).toBe(true)
    }
    for (const bad of ['.env', 'config/secrets.json', '.github/x.md', 'docs/.hidden/x.md', '.avoid.md', 'avoid.md.txt']) {
      expect(isMarkdownOutsideHidden(bad)).toBe(false)
    }
  })

  test('the rule applies to the real path below the real root', () => {
    expect(isMarkdownOutsideHiddenUnder('/r/docs/avoid.md', '/r')).toBe(true)
    expect(isMarkdownOutsideHiddenUnder('/r/docs/avoid.md', '/r/')).toBe(true)
    expect(isMarkdownOutsideHiddenUnder('/.r/docs/avoid.md', '/.r')).toBe(true)
    expect(isMarkdownOutsideHiddenUnder('C:\\r\\docs\\avoid.md', 'C:\\r')).toBe(true)
    expect(isMarkdownOutsideHiddenUnder('/r/.env', '/r')).toBe(false)
    expect(isMarkdownOutsideHiddenUnder('/r/.private/secrets.md', '/r')).toBe(false)
    expect(isMarkdownOutsideHiddenUnder('C:\\r\\.private\\secrets.md', 'C:\\r')).toBe(false)
    expect(isMarkdownOutsideHiddenUnder('/elsewhere/avoid.md', '/r')).toBe(false)
  })
})

describe('the configured file names', () => {
  test('a relative path is kept, trimmed, without empty or "." segments', () => {
    expect(fileName('VISION.md', 'x')).toBe('VISION.md')
    expect(fileName('  docs/course.md \n', 'x')).toBe('docs/course.md')
    expect(fileName('./docs//course.md', 'x')).toBe('docs/course.md')
    expect(fileName('a'.repeat(200), 'x')).toBe('a'.repeat(200))
  })

  test('a value that is not a safe relative path falls back', () => {
    for (const bad of [
      undefined,
      7,
      true,
      ['VISION.md'],
      '',
      '   ',
      '.',
      './',
      '/etc/passwd',
      '~/VISION.md',
      'C:/VISION.md',
      'c:VISION.md',
      'docs\\VISION.md',
      '../VISION.md',
      'docs/../../VISION.md',
      'docs/..',
      'VISION\u0000.md',
      'docs/\tVISION.md',
      'VISION\u007f.md',
      'a'.repeat(201),
    ]) {
      expect(fileName(bad, 'fallback.md')).toBe('fallback.md')
    }
  })

  test('the options give the names, with defaults for missing or invalid values', () => {
    expect(fileNames({})).toEqual({
      vision: DEFAULT_VISION_FILE,
      antiPatterns: DEFAULT_ANTI_PATTERNS_FILE,
    })
    expect(fileNames({ visionFile: 'course.md', antiPatternsFile: '../avoid.md' })).toEqual({
      vision: 'course.md',
      antiPatterns: 'ANTI-PATTERNS.md',
    })
    expect(fileNames({ antiPatternsFile: 'vision.md' })).toEqual({
      vision: 'VISION.md',
      antiPatterns: 'vision.md',
    })
  })
})

describe('a real path under the project root', () => {
  test('a path under the root is under it, also with a trailing separator on the root', () => {
    expect(isUnderRoot('/r/app/VISION.md', '/r/app')).toBe(true)
    expect(isUnderRoot('/r/app/docs/VISION.md', '/r/app/')).toBe(true)
    expect(isUnderRoot('/r/app/VISION.md', '/r/app//')).toBe(true)
    expect(isUnderRoot('C:\\r\\app\\VISION.md', 'C:\\r\\app\\')).toBe(true)
    expect(isUnderRoot('/VISION.md', '/')).toBe(true)
  })

  test('the root itself, a sibling with the same prefix, and a path outside are not', () => {
    expect(isUnderRoot('/r/app', '/r/app')).toBe(false)
    expect(isUnderRoot('/r/app/', '/r/app')).toBe(false)
    expect(isUnderRoot('/r/app', '/r/app/')).toBe(false)
    expect(isUnderRoot('/r/app2/VISION.md', '/r/app')).toBe(false)
    // On POSIX, `app\\outside` is a sibling directory, not a path under `app`.
    expect(isUnderRoot('/r/app\\outside/VISION.md', '/r/app')).toBe(false)
    expect(isUnderRoot('/r/VISION.md', '/r/app')).toBe(false)
    expect(isUnderRoot('/elsewhere/VISION.md', '/r/app')).toBe(false)
  })
})

describe('the learn answers', () => {
  test('the draft shows the act and the quote, not the sentence', () => {
    const text = draftText(draftOf())
    expect(text).toBe(
      [
        'Course Keeper read this as the act you corrected:',
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
        'Where it comes from: the agent\'s words "I will round the total in the exporter before it writes the file."; drafted 2026-11-23 UTC by example-model; Course Keeper 0.1.0.',
        '',
        'This is a draft for the owners of VISION.md. Course Keeper does not change the file.',
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

  test('a quote that ends a sentence gets a period only when it has no end mark', () => {
    expect(quotedSentence('The exporter rounds totals.')).toBe('"The exporter rounds totals."')
    expect(quotedSentence('Is this a fork?')).toBe('"Is this a fork?"')
    expect(quotedSentence('Stop!')).toBe('"Stop!"')
    expect(quotedSentence('no new files')).toBe('"no new files".')
    expect(quotedSentence('He said "stop."')).toBe('"He said "stop.""')
    expect(quotedSentence('It rounds (twice!)')).toBe('"It rounds (twice!)"')
    expect(quotedSentence('the "exporter"')).toBe('"the "exporter"".')
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
        'Where it comes from: the agent\'s words "I will round the total in the exporter before it writes the file."; drafted 2026-11-23 UTC by example-model; Course Keeper 0.1.0.',
        '',
        'This is a draft for the owners of VISION.md. Course Keeper does not change the file.',
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

  test('a sentence for the anti-patterns file names both files', () => {
    const owners =
      'This is a draft for the owners of ANTI-PATTERNS.md and VISION.md. Course Keeper does not change the files.'
    const report = learnReport({
      draft: draftOf(),
      target: 1,
      isNew: false,
      inAntiPatterns: true,
      control: silent,
      verify: alert('invariant 1'),
      earlier: { tested: 0, newAlerts: [], noResults: [] },
    })
    expect(report).toMatch(/^Draft sentence for ANTI-PATTERNS\.md, under invariant 1:\n {2}Never round/)
    expect(report).toContain(owners)
    expect(report).not.toContain('owners of VISION.md.')
    const untested = untestedReport({ draft: draftOf(), target: 1, isNew: false, inAntiPatterns: true })
    expect(untested).toContain(
      'Draft sentence for ANTI-PATTERNS.md, under invariant 1 (not tested):\n  Never round',
    )
    expect(untested).toContain(owners)
  })

  test('the reports name the configured files', () => {
    const names = { vision: 'docs/course.md', antiPatterns: 'docs/avoid.md' }
    const report = learnReport({
      draft: draftOf(),
      target: 1,
      isNew: false,
      inAntiPatterns: true,
      control: silent,
      verify: alert('invariant 1'),
      earlier: { tested: 0, newAlerts: [], noResults: [] },
      names,
    })
    expect(report).toMatch(/^Draft sentence for docs\/avoid\.md, under invariant 1:\n/)
    expect(report).toContain(
      'This is a draft for the owners of docs/avoid.md and docs/course.md. Course Keeper does not change the files.',
    )
    const untested = untestedReport({ draft: draftOf(), target: 4, isNew: true, names })
    expect(untested).toContain('Draft sentence for docs/course.md, as a new invariant (not tested):')
    expect(untested).toContain(
      'This is a draft for the owners of docs/course.md. Course Keeper does not change the file.',
    )
    expect(untested).not.toContain('VISION.md')
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
