// The parts of course keeper that need no engine: origin decision, text
// cleaning, prompt filling, reply parsing and the list rules. The hooks
// module calls these; the tests call them directly.

import type {
  CourseKeeperAlert,
  CourseKeeperAnswer,
  CourseKeeperSession,
} from '../types'

export const MAX_INSTRUCTIONS = 30
export const MAX_INSTRUCTION_LENGTH = 300
export const MAX_ALERTS = 50
export const MIN_PROMPT_LENGTH = 12
export const MAX_OUTCOME_LENGTH = 200
/**
 * After this long, a check's in-flight mark counts as lost (a hot reload
 * or a restart cut the check) and no longer blocks a new check.
 */
export const CHECK_STALE_MS = 5 * 60 * 1000

/** The most characters kept of each field of a check reply. */
export const LIMITS = {
  reference: 200,
  alert: 300,
  evidence: 400,
  note: 1200,
} as const

export const NO_INSTRUCTIONS =
  'None listed. Use what the person said in this session.'
export const NO_ALERTS = 'None.'

// Which prompt origins count as a person typing.
//
// The declaration of `PromptOrigin` in claude-code.d.ts (2.1.328), the
// union of `kind` values documented as "Where a `prompt.submit` submission
// came from", names three kinds for a person's own input:
// - `composer`: "The user's own gesture at the terminal ... Enter at the
//   prompt, typed or queued, or a click on a transcript link".
// - `bridge`: "The user's message through the Remote Control bridge (a phone
//   or web client)".
// - `slack-ping`: "The session's owner pinging it from Slack".
// Every other kind there is a program, another session, a schedule, a
// channel or a plugin: sdk, task-notification, scheduled-trigger, peer,
// peer-send-message, projects-relay, channel, coordinator, observer,
// observer-activity, auto-continuation, unclassified, plugin. A kind not
// listed here, such as one a later release adds, does not count either.
// Whether a surface can show an alert is a separate test at check time.
const PERSON_ORIGINS: ReadonlySet<string> = new Set([
  'composer',
  'bridge',
  'slack-ping',
])

/** True when a prompt of this origin kind was typed by a person. */
export function isPersonOrigin(kind: string): boolean {
  return PERSON_ORIGINS.has(kind)
}

// Escape sequences: CSI, OSC, DCS/SOS/PM/APC strings, then any other ESC
// sequence. Control characters (Cc): C0, DEL and C1. Format characters
// (Cf): the bidirectional marks and overrides, which can reorder what a
// terminal shows, and the invisible ones (zero-width characters, the soft
// hyphen, Unicode tag characters), which a terminal does not draw but a
// model reads. Control characters become spaces; format characters are
// removed. Line and paragraph separators count as spaces (`\s`).
const ESCAPES =
  /\x1b\[[0-?]*[ -/]*[@-~]?|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?/g
const CONTROLS = /\p{Cc}/gu
const FORMATS = /\p{Cf}/gu

/**
 * Removes escape sequences and control characters, joins the text into one
 * line, and cuts it to `max` characters.
 */
export function clean(text: string, max: number): string {
  const flat = text
    .replace(ESCAPES, '')
    .replace(CONTROLS, ' ')
    .replace(FORMATS, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(flat)

  return chars.length <= max
    ? flat
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

/** Removes one HTML comment at the start of a prompt file. */
export function stripLeadingComment(text: string): string {
  return text.replace(/^\s*<!--[\s\S]*?-->[ \t]*\r?\n?/, '').replace(/^\s+/, '')
}

/** Fills the three fields of the check prompt in one pass. */
export function fillCheckPrompt(
  template: string,
  fields: { vision: string; instructions: string; alerts: string },
): string {
  const values: Record<string, string> = {
    vision: fields.vision,
    standing_instructions: fields.instructions,
    previous_alerts: fields.alerts,
  }

  return template.replace(
    /\{\{(vision|standing_instructions|previous_alerts)\}\}/g,
    (_, name: string) => values[name] ?? '',
  )
}

/**
 * Puts the agent's final answer of the turn before the check prompt. A fork
 * sends the main thread's last request again, and that request does not
 * hold the answer the model gave to it.
 */
export function withFinalAnswer(prompt: string, answer: string): string {
  const text = answer.trim()
  if (text === '') return prompt

  return (
    'The agent ended its latest turn with the answer below. The conversation ' +
    'above does not show this answer yet. It is part of the material to examine.\n\n' +
    `<final_answer>\n${text}\n</final_answer>\n\n${prompt}`
  )
}

/** Fills the one field of the extract prompt. */
export function fillExtractPrompt(template: string, message: string): string {
  return template.replace(/\{\{message\}\}/g, () => message)
}

export const WITHDRAWN_HEADING = 'Withdrawn by the person; do not enforce these:'

/**
 * The standing instructions as a numbered list, or the "none" sentence;
 * then, when there are any, the withdrawn instructions under their heading.
 */
export function formatInstructions(
  list: readonly string[],
  withdrawn: readonly string[] = [],
): string {
  const listed =
    list.length === 0
      ? NO_INSTRUCTIONS
      : list.map((text, i) => `${i + 1}. ${text}`).join('\n')

  return withdrawn.length === 0
    ? listed
    : `${listed}\n\n${WITHDRAWN_HEADING}\n${withdrawn.map(text => `- ${text}`).join('\n')}`
}

/** The alerts shown in the session with the person's answers, or "None.". */
export function formatAlerts(record: CourseKeeperSession): string {
  const all = record.current ? [...record.alerts, record.current] : record.alerts

  return all.length === 0
    ? NO_ALERTS
    : all
        .map(
          (a, i) =>
            `${i + 1}. ${a.reference}: ${a.alert} Evidence: "${a.evidence}". ` +
            `The person's answer: ${describeAnswer(a.answer)}.`,
        )
        .join('\n')
}

function describeAnswer(answer: CourseKeeperAnswer | null): string {
  switch (answer) {
    case null:
      return 'none yet'
    case 'intended':
      return 'intended (the person wanted this)'
    default:
      return answer
  }
}

export type CheckReply =
  | { verdict: 'none' }
  | {
      verdict: 'deviation'
      reference: string
      alert: string
      evidence: string
      note: string
    }

const FIELD = /^(verdict|reference|alert|evidence|note)\s*:\s*(.*)$/i
/**
 * The start of a reference field, after any run of backticks, asterisks or
 * underscores: `invariant <number>`, or `instruction "<text>"` with an
 * optional colon and the text in straight, curly, German, French or single
 * quotes. The instruction runs to the last mark in the field that closes
 * its opening mark, so an apostrophe after a double-quoted text does not
 * end it. What comes after the number or the closing mark is not read.
 */
const REFERENCE = {
  invariant: /^[`*_]*invariant\s+(\d+)\b/i,
  instruction:
    /^[`*_]*instruction\s*:?\s*(?:"(.*\S.*)"|“(.*\S.*)”|„(.*\S.*)[“”]|«(.*\S.*)»|'(.*\S.*)'|‘(.*\S.*)’)/i,
}

/** The canonical form of a reference field, or undefined when it has none. */
function canonicalReference(field: string): string | undefined {
  const invariant = REFERENCE.invariant.exec(field)
  if (invariant) return `invariant ${invariant[1] ?? ''}`
  const instruction = REFERENCE.instruction.exec(field)
  const text = instruction?.slice(1).find(group => group !== undefined)
  if (text !== undefined) return `instruction "${text.trim()}"`

  return undefined
}

/**
 * Reads a check reply. Returns undefined for a malformed reply: a field
 * given twice, an unknown verdict, a deviation with a field missing, or a
 * reference that does not start with `invariant <number>` or
 * `instruction "<text>"`. The reference comes back in its canonical form,
 * `invariant <number>` or `instruction "<text>"` in straight quotes, with
 * anything after the number or the closing mark dropped.
 */
export function parseCheckReply(reply: string): CheckReply | undefined {
  const fields = new Map<string, string>()
  let last: string | undefined

  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.trim()

    if (line.startsWith('```')) {
      last = undefined
      continue
    }
    if (line === '') continue

    const match = FIELD.exec(line)
    if (match) {
      const name = (match[1] ?? '').toLowerCase()
      if (fields.has(name)) return undefined
      fields.set(name, match[2] ?? '')
      last = name
    } else if (last !== undefined) {
      fields.set(last, `${fields.get(last) ?? ''} ${line}`)
    }
  }

  const verdict = clean(fields.get('verdict') ?? '', 20)
    .toLowerCase()
    .replace(/[^a-z]/g, '')

  if (verdict === 'none') return { verdict: 'none' }
  if (verdict !== 'deviation') return undefined

  // The reference is read whole, before it is cut: a long quote keeps
  // its closing mark only before the cut.
  const canonical = canonicalReference(clean(fields.get('reference') ?? '', Infinity))
  const alert = clean(fields.get('alert') ?? '', LIMITS.alert)
  const evidence = clean(
    unquote(fields.get('evidence') ?? ''),
    LIMITS.evidence,
  )
  const note = clean(fields.get('note') ?? '', LIMITS.note)

  if (canonical === undefined) return undefined
  if (alert === '' || evidence === '' || note === '') return undefined
  const reference = clean(canonical, LIMITS.reference)

  return { verdict: 'deviation', reference, alert, evidence, note }
}

function unquote(text: string): string {
  const trimmed = text.trim()
  const match = /^["“'](.*)["”']$/s.exec(trimmed)

  return match ? (match[1] ?? '') : trimmed
}

function same(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

  return norm(a) === norm(b)
}

/** True when an alert with this reference and evidence was already shown. */
export function wasShown(
  record: CourseKeeperSession,
  reference: string,
  evidence: string,
): boolean {
  const all = record.current ? [...record.alerts, record.current] : record.alerts

  return all.some(a => same(a.reference, reference) && same(a.evidence, evidence))
}

/** Moves the current alert into the list of shown alerts, with an answer. */
export function answerCurrent(
  record: CourseKeeperSession,
  answer: CourseKeeperAnswer,
): CourseKeeperSession {
  if (record.current === null) return record

  return {
    ...record,
    alerts: [...record.alerts, { ...record.current, answer }].slice(-MAX_ALERTS),
    current: null,
    showDetails: false,
  }
}

/**
 * Takes back the answer "told the agent" for the alert shown at `shownAt`,
 * when its note did not reach the agent. The alert is shown again; if a
 * newer alert is shown now, the older one counts as replaced.
 */
export function restoreUnsent(
  record: CourseKeeperSession,
  shownAt: number,
): CourseKeeperSession {
  const index = record.alerts.findLastIndex(
    a => a.shownAt === shownAt && a.answer === 'told the agent',
  )
  const alert = record.alerts[index]
  if (alert === undefined) return record

  if (record.current !== null) {
    return {
      ...record,
      alerts: record.alerts.map((a, i) =>
        i === index ? { ...a, answer: 'replaced by a newer alert' } : a,
      ),
    }
  }

  return {
    ...record,
    alerts: record.alerts.filter((_, i) => i !== index),
    current: { ...alert, answer: null },
    showDetails: false,
  }
}

/**
 * Applies a check's reply to the record: the new record, the outcome to
 * show in `/course-keeper`, and the new alert when there is one.
 */
export function applyReply(
  record: CourseKeeperSession,
  reply: CheckReply | undefined,
  now: number,
): {
  record: CourseKeeperSession
  outcome: string
  shown?: CourseKeeperAlert
} {
  if (reply === undefined) {
    return withOutcome(record, 'the reply was malformed', now)
  }
  if (reply.verdict === 'none') {
    return withOutcome(record, 'verdict: none', now)
  }
  if (wasShown(record, reply.reference, reply.evidence)) {
    return withOutcome(
      record,
      `verdict: deviation (${reply.reference}), already shown`,
      now,
    )
  }

  const shown: CourseKeeperAlert = {
    reference: reply.reference,
    alert: reply.alert,
    evidence: reply.evidence,
    note: reply.note,
    shownAt: now,
    answer: null,
  }
  const replaced = answerCurrent(record, 'replaced by a newer alert')
  const next = withOutcome(
    { ...replaced, current: shown, showDetails: false },
    `verdict: deviation (${reply.reference})`,
    now,
  )

  return { ...next, shown }
}

/** Records the outcome of the last check. */
export function withOutcome(
  record: CourseKeeperSession,
  outcome: string,
  now: number,
): { record: CourseKeeperSession; outcome: string } {
  const text = clean(outcome, MAX_OUTCOME_LENGTH)

  return { record: { ...record, lastCheck: { at: now, outcome: text } }, outcome: text }
}

/** True when a prompt is sent to the extract model. */
export function shouldExtract(
  text: string,
  isCommand: boolean,
  isMeta: boolean,
): boolean {
  const trimmed = text.trim()

  return (
    !isCommand &&
    !isMeta &&
    !trimmed.startsWith('/') &&
    trimmed.length >= MIN_PROMPT_LENGTH
  )
}

/** Reads the extract reply: "none", or up to three lines that start "- ". */
export function parseExtractReply(reply: string): string[] {
  return reply
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .slice(0, 3)
    .map(line => clean(line.slice(2), MAX_INSTRUCTION_LENGTH))
    .filter(line => line !== '')
}

/**
 * Adds each candidate that no equal instruction already holds, up to
 * MAX_INSTRUCTIONS in all; returns the new list and what was added.
 */
export function addInstructions(
  list: readonly string[],
  candidates: readonly string[],
): { list: string[]; added: string[] } {
  const next = [...list]
  const added: string[] = []

  for (const raw of candidates) {
    const text = clean(raw, MAX_INSTRUCTION_LENGTH)
    if (text === '' || next.length >= MAX_INSTRUCTIONS) continue
    if (next.some(have => same(have, text))) continue
    next.push(text)
    added.push(text)
  }

  return { list: next, added }
}

/**
 * Removes standing instruction `n` (counted from 1). Returns undefined when
 * `n` is not the number of an instruction.
 */
export function forgetInstruction(
  list: readonly string[],
  n: string,
): { list: string[]; removed: string } | undefined {
  if (!/^\d+$/.test(n)) return undefined
  const index = Number(n) - 1
  const removed = list[index]
  if (removed === undefined) return undefined

  return { list: list.filter((_, i) => i !== index), removed }
}

/**
 * Adds a removed instruction to the withdrawn ones, newest last: an equal
 * one moves to the end, and only the newest MAX_INSTRUCTIONS stay.
 */
export function addWithdrawn(
  withdrawn: readonly string[],
  removed: string,
): string[] {
  const text = clean(removed, MAX_INSTRUCTION_LENGTH)
  if (text === '') return [...withdrawn]

  return [...withdrawn.filter(have => !same(have, text)), text].slice(-MAX_INSTRUCTIONS)
}

/** The withdrawn instructions without those the person stated again. */
export function removeWithdrawn(
  withdrawn: readonly string[],
  added: readonly string[],
): string[] {
  return withdrawn.filter(have => !added.some(text => same(have, text)))
}

/** The summarizer's instructions, with the standing instructions added. */
export function compactInstructions(
  existing: string | undefined,
  list: readonly string[],
): string | undefined {
  if (list.length === 0) return undefined
  const request =
    'Keep these standing instructions of the person word for word in the summary:\n' +
    formatInstructions(list)

  return existing && existing.trim() !== '' ? `${existing}\n\n${request}` : request
}

/** The message to the agent that "Tell the agent" sends. */
export function noteText(alert: CourseKeeperAlert): string {
  return (
    `Course keeper alert on ${alert.reference}. ` +
    `Evidence: "${alert.evidence}". Note: ${alert.note}`
  )
}

/** The notice shown when standing instructions are added. */
export function addedNotice(added: readonly string[]): string {
  const quoted = added.map(text => `"${clean(text, 80)}"`).join('; ')

  return added.length === 1
    ? `Course keeper noted a standing instruction: ${quoted}`
    : `Course keeper noted ${added.length} standing instructions: ${quoted}`
}

function time(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/** The text `/course-keeper` prints. */
export function statusText(
  record: CourseKeeperSession,
  visionPath: string | undefined,
): string {
  const lines = [
    visionPath === undefined
      ? 'VISION.md: not found. No checks run without it.'
      : `VISION.md: ${visionPath}`,
    `Checks: ${record.isOff ? 'off' : 'on'} for this session.`,
    '',
    'Standing instructions:',
    ...(record.instructions.length === 0
      ? ['  none']
      : record.instructions.map((text, i) => `  ${i + 1}. ${text}`)),
  ]
  const withdrawn = record.withdrawn ?? []
  if (withdrawn.length > 0) {
    lines.push(
      '',
      'Withdrawn standing instructions:',
      ...withdrawn.map(text => `  - ${text}`),
    )
  }
  lines.push('', 'Alerts in this session:')
  const all = record.current ? [...record.alerts, record.current] : record.alerts

  lines.push(
    ...(all.length === 0
      ? ['  none']
      : all.map(
          (a, i) =>
            `  ${i + 1}. ${a.reference}: ${a.alert} Answer: ${describeAnswer(a.answer)}.`,
        )),
  )
  if (record.current) {
    lines.push(
      '',
      `Current alert: ${record.current.alert}`,
      `  Evidence: "${record.current.evidence}"`,
      `  Note: ${record.current.note}`,
    )
  }
  lines.push(
    '',
    record.lastCheck === null
      ? 'Last check: none yet.'
      : `Last check: ${time(record.lastCheck.at)}, ${record.lastCheck.outcome}.`,
  )

  return lines.join('\n')
}

/** A record with nothing in it. */
export function emptyRecord(): CourseKeeperSession {
  return {
    v: 1,
    hasPerson: false,
    isOff: false,
    instructions: [],
    withdrawn: [],
    alerts: [],
    current: null,
    showDetails: false,
    lastCheck: null,
    checkingSince: null,
  }
}

const ANSWERS: ReadonlySet<string> = new Set([
  'intended',
  'told the agent',
  'dismissed',
  'replaced by a newer alert',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAlert(value: unknown): CourseKeeperAlert | undefined {
  if (!isObject(value)) return undefined
  const { reference, alert, evidence, note, shownAt, answer } = value
  if (
    typeof reference !== 'string' ||
    typeof alert !== 'string' ||
    typeof evidence !== 'string' ||
    typeof note !== 'string' ||
    typeof shownAt !== 'number' ||
    !Number.isFinite(shownAt)
  ) {
    return undefined
  }

  return {
    reference: clean(reference, LIMITS.reference),
    alert: clean(alert, LIMITS.alert),
    evidence: clean(evidence, LIMITS.evidence),
    note: clean(note, LIMITS.note),
    shownAt,
    answer:
      typeof answer === 'string' && ANSWERS.has(answer)
        ? (answer as CourseKeeperAnswer)
        : null,
  }
}

/** The cleaned, non-empty texts of a stored list; none when it is not a list. */
function readTexts(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((x): x is string => typeof x === 'string')
        .map(x => clean(x, MAX_INSTRUCTION_LENGTH))
        .filter(x => x !== '')
    : []
}

/**
 * Reads a stored record, written by this version or an earlier one. Any
 * field that does not hold the expected shape takes its empty value.
 */
export function normalizeRecord(value: unknown): CourseKeeperSession {
  const record = emptyRecord()
  if (!isObject(value) || value.v !== 1) return record

  const instructions = readTexts(value.instructions).slice(0, MAX_INSTRUCTIONS)
  // Absent in a record written before withdrawn instructions were kept.
  const withdrawn = readTexts(value.withdrawn).slice(-MAX_INSTRUCTIONS)
  const alerts = Array.isArray(value.alerts)
    ? value.alerts
        .map(readAlert)
        .filter((x): x is CourseKeeperAlert => x !== undefined)
        .map(a => ({ ...a, answer: a.answer ?? 'dismissed' }))
        .slice(-MAX_ALERTS)
    : []
  const current = readAlert(value.current) ?? null
  const last = value.lastCheck
  const lastCheck =
    isObject(last) &&
    typeof last.at === 'number' &&
    Number.isFinite(last.at) &&
    typeof last.outcome === 'string'
      ? { at: last.at, outcome: clean(last.outcome, MAX_OUTCOME_LENGTH) }
      : null

  return {
    v: 1,
    hasPerson: value.hasPerson === true,
    isOff: value.isOff === true,
    instructions,
    withdrawn,
    alerts,
    current: current === null ? null : { ...current, answer: null },
    showDetails: value.showDetails === true && current !== null,
    lastCheck,
    checkingSince:
      typeof value.checkingSince === 'number' && Number.isFinite(value.checkingSince)
        ? value.checkingSince
        : null,
  }
}

/** True when a check started at `since` may still run at `now`. */
export function isCheckRunning(since: number | null, now: number): boolean {
  return since !== null && now - since < CHECK_STALE_MS
}

/** The store keys to delete so that at most `keep` sessions stay. */
export function oldestKeys(
  entries: readonly { key: string; savedAt: number }[],
  keep: number,
): string[] {
  return [...entries]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(keep)
    .map(entry => entry.key)
}
