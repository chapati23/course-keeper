// The parts of Course Keeper that need no engine: origin decision, text
// cleaning, prompt filling, reply parsing and the list rules. The hooks
// module calls these; the tests call them directly.

import type { SessionMessage } from 'claude-code'

import type {
  CourseKeeperAlert,
  CourseKeeperAnswer,
  CourseKeeperDraft,
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
  instead: 160,
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

/**
 * Removes every HTML comment at the start of a prompt file. The learn prompt
 * holds two: the plugin's own, and the one of the measured prompt below it.
 */
export function stripLeadingComments(text: string): string {
  let out = text
  for (;;) {
    const next = stripLeadingComment(out)
    if (next === out) return out
    out = next
  }
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
            `${i + 1}. ${a.reference}: ${a.alert} Evidence: ${quotedSentence(a.evidence)} ` +
            `The person's answer: ${describeAnswer(a.answer)}.`,
        )
        .join('\n')
}

function describeAnswer(answer: CourseKeeperAnswer | null): string {
  switch (answer) {
    case null:
      return 'none yet'
    case 'intended':
      return 'false alarm (the person says this is no deviation, or wanted it)'
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
      /** What to do instead; absent when the reply has no such field or it is empty. */
      instead?: string
      evidence: string
      note: string
    }

const FIELD = /^(verdict|reference|alert|instead|evidence|note)\s*:\s*(.*)$/i
/** The marks that close each opening mark: straight, curly, German, French or single quotes. */
const CLOSING: Record<string, string> = { '"': '"', '“': '”', '„': '“”', '«': '»', "'": "'", '‘': '’' }
/**
 * The start of a reference field, after any run of backticks, asterisks or
 * underscores: `invariant <number>`, or `invariant "<text>"` (the
 * invariant's own words) or `instruction "<text>"` with an optional colon
 * and the text in quotes (see CLOSING and quotedText). What comes after the
 * number or the closing mark is not read.
 */
const REFERENCE = {
  invariant: /^[`*_]*invariant\s+(\d+)\b/i,
  words: /^[`*_]*invariant\s*:?\s*(["“„«'‘])/i,
  instruction: /^[`*_]*instruction\s*:?\s*(["“„«'‘])/i,
}

/** What may follow a closing mark: the end of the field, a space or a mark that ends a phrase. */
const AFTER_CLOSE = /(?:$|[\s.,;:!?)\]}*_`])/y
/**
 * What may follow a closing single quote, which can also be an apostrophe
 * (`don't`, `users' data`): the end of the field, or a mark that is no
 * letter or digit, after any spaces.
 */
const AFTER_SINGLE_CLOSE = /\s*(?:$|[^\p{L}\p{N}\s])/uy

/** True when the mark at `index` has an odd run of backslashes before it. */
function escaped(field: string, index: number): boolean {
  let count = 0
  while (field.charAt(index - 1 - count) === '\\') count++

  return count % 2 === 1
}

/**
 * The quoted text after the start that `start` matches, trimmed. The text
 * ends at the first mark that closes the opening mark, is not escaped with
 * a backslash, and is followed by what AFTER_CLOSE (for single quotes,
 * AFTER_SINGLE_CLOSE) allows. So an apostrophe in a word does not end it,
 * and a quotation in a remark after it does not join it. A quotation inside
 * the text stays whole: in straight double quotes the text holds an even
 * number of unescaped quote marks, and in curly or French quotes as many
 * inner opening marks as closing ones. Without such a mark the text runs to
 * the last closing mark; without any, there is no text.
 */
function quotedText(field: string, start: RegExp): string | undefined {
  const match = start.exec(field)
  if (!match) return undefined
  const open = match[1] ?? ''
  const closers = CLOSING[open] ?? ''
  const nests = open === '“' || open === '«'
  const after = open === "'" || open === '‘' ? AFTER_SINGLE_CLOSE : AFTER_CLOSE
  const from = match[0].length
  let last: number | undefined
  let depth = 0
  let nonSpace = false

  for (let i = from; i < field.length; i++) {
    const mark = field.charAt(i)
    if (nests && mark === open) depth++
    if (!closers.includes(mark) || escaped(field, i)) {
      nonSpace ||= /\S/.test(mark)
      continue
    }
    if (nonSpace) {
      last = i
      const inside = open === '"' ? depth % 2 === 1 : depth > 0
      after.lastIndex = i + 1
      if (!inside && after.test(field)) return field.slice(from, i).trim()
    }
    if (open === '"') depth++
    else if (nests && depth > 0) depth--
    nonSpace ||= /\S/.test(mark)
  }

  return last === undefined ? undefined : field.slice(from, last).trim()
}

/** The canonical form of a reference field, or undefined when it has none. */
function canonicalReference(field: string): string | undefined {
  const invariant = REFERENCE.invariant.exec(field)
  if (invariant) return `invariant ${invariant[1] ?? ''}`
  // An invariant's words are a title: the model's `\"` turns back into `"`,
  // and a matched pair of bold marks around them and the period that ends
  // the sentence go, whether the period stands inside or after the marks.
  // An ellipsis keeps its dots, and a lone `*` (a wildcard) stays.
  const quoted = quotedText(field, REFERENCE.words)
  const words = (quoted === undefined ? undefined : unescapeQuotes(quoted))
    ?.replace(/(?<!\.)\.$/, '')
    .replace(/^([*_]+)(.*)\1$/, '$2')
    .trim()
    .replace(/(?<!\.)\.$/, '')
    .trim()
  if (words !== undefined && words !== '') return `invariant "${words}"`
  const instruction = quotedText(field, REFERENCE.instruction)
  if (instruction !== undefined) return `instruction "${instruction}"`

  return undefined
}

/**
 * Reads a check reply. Returns undefined for a malformed reply: a field
 * given twice, an unknown verdict, a deviation with a field missing, or a
 * reference that does not start with `invariant <number>`,
 * `invariant "<text>"` or `instruction "<text>"`. The reference comes back
 * in its canonical form, `invariant <number>`, `invariant "<text>"` or `instruction "<text>"` in
 * straight quotes, with anything after the number or the closing mark
 * dropped, and for an invariant's words the period at their end.
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
  // Optional: a reply to an older prompt has no `instead`, and the model
  // can leave it out.
  const instead = clean(fields.get('instead') ?? '', LIMITS.instead)

  if (canonical === undefined) return undefined
  if (alert === '' || evidence === '' || note === '') return undefined
  const reference = clean(canonical, LIMITS.reference)

  return {
    verdict: 'deviation',
    reference,
    alert,
    ...(instead === '' ? {} : { instead }),
    evidence,
    note,
  }
}

/**
 * A field value with the `\"` that a model writes for a double quote inside a
 * quote turned back into `"`. Every other backslash stays, so a quoted path
 * such as `\\server\share` keeps its own text.
 */
export function unescapeQuotes(text: string): string {
  return text.replace(/\\"/g, '"')
}

/** The text of a field value, without its outer quote marks. */
function stripQuotes(text: string): string {
  const trimmed = text.trim()
  const match = /^["“'](.*)["”']$/s.exec(trimmed)

  return match ? (match[1] ?? '') : trimmed
}

function unquote(text: string): string {
  return unescapeQuotes(stripQuotes(text))
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

  // A record from before 0.6.1 can hold evidence with the model's `\"`.
  return all.some(
    a =>
      same(a.reference, reference) &&
      same(unescapeQuotes(a.evidence), unescapeQuotes(evidence)),
  )
}

/** Moves the current alert into the list of shown alerts, with an answer. */
export function answerCurrent(
  record: CourseKeeperSession,
  answer: CourseKeeperAnswer,
): CourseKeeperSession {
  if (record.current === null) return record
  const { confirmFalseAlarm: _, ...rest } = record

  return {
    ...rest,
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
 * show in `/course-keeper`, and the new alert when there is one. A new
 * alert keeps `title`, the cited invariant's title, when one is given.
 */
export function applyReply(
  record: CourseKeeperSession,
  reply: CheckReply | undefined,
  now: number,
  title?: string,
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
    ...(title === undefined ? {} : { title }),
    alert: reply.alert,
    ...(reply.instead === undefined ? {} : { instead: reply.instead }),
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
    `Course Keeper alert on ${alert.reference}. ` +
    `Evidence: ${quotedSentence(alert.evidence)} Note: ${alert.note}`
  )
}

/** The most characters kept of an invariant's title or an instruction in a headline. */
export const MAX_HEADLINE_PART = 60

/**
 * The title of the invariant that `reference` cites, from the vision text:
 * on the first outer item numbered n (its lines joined), the bold lead `**…**` when the item
 * starts with one, else the first sentence, without a trailing period,
 * cleaned and cut to MAX_HEADLINE_PART characters. Undefined for a
 * reference that is not `invariant <n>`, or when the vision has no such item.
 * An `invariant "<text>"` reference carries its title in itself (see quotedWords).
 */
export function invariantTitle(vision: string, reference: string): string | undefined {
  const wanted = /^invariant (\d+)$/.exec(reference)
  if (!wanted) return undefined
  const n = Number(wanted[1])
  const lines = vision.split('\n')
  // The invariants are the items at the outer level: a numbered step inside
  // an invariant is indented further and is not one.
  const indent = (l: string): number => /^\s*/.exec(l)?.[0].length ?? 0
  const items = lines.filter(l => ITEM.test(l))
  const outer = Math.min(...items.map(indent))
  const at = lines.findIndex(
    l => indent(l) === outer && Number(ITEM.exec(l)?.[1]) === n,
  )
  if (at < 0) return undefined
  // A lead can wrap: the item runs to the next blank line or the next item.
  let end = at + 1
  while (end < lines.length && (lines[end] ?? '').trim() !== '' && !ITEM.test(lines[end] ?? '')) end += 1
  const rest = lines
    .slice(at, end)
    .map((l, i) => (i === 0 ? l.replace(ITEM, '') : l.trim()))
    .join(' ')
  const bold = /^\s*\*\*(.+?)\*\*/.exec(rest)
  const lead = bold ? (bold[1] ?? '') : (/^.*?\.(?=\s|$)/.exec(rest.trim())?.[0] ?? rest)
  const title = clean(clean(lead, Infinity).replace(/\.$/, ''), MAX_HEADLINE_PART)

  return title === '' ? undefined : title
}

/**
 * The quoted words of an `invariant "<text>"` or `instruction "<text>"` reference,
 * cut to MAX_HEADLINE_PART characters, or undefined for another reference.
 * A stored reference that was cut has no closing mark.
 */
function quotedWords(reference: string, kind: 'invariant' | 'instruction'): string | undefined {
  const match = new RegExp(`^${kind} "(.*)$`).exec(reference)

  return match ? clean((match[1] ?? '').replace(/"$/, ''), MAX_HEADLINE_PART) : undefined
}

/**
 * What the alert's headline says after "Course Keeper: ", from its
 * reference and the title stored with it.
 */
export function alertSubject(alert: CourseKeeperAlert): string {
  const instruction = quotedWords(alert.reference, 'instruction')
  if (instruction !== undefined) return `this session breaks your instruction "${instruction}"`
  const words = quotedWords(alert.reference, 'invariant')
  if (words !== undefined) return `this session breaks your rule "${words}"`
  if (/^invariant \d+$/.test(alert.reference) && alert.title !== undefined) {
    return `this session breaks ${alert.reference} (${alert.title})`
  }

  return `this session breaks ${alert.reference}`
}

/** The alert's headline, as the row and the desktop notification show it. */
export function alertHeadline(alert: CourseKeeperAlert): string {
  return `Course Keeper: ${alertSubject(alert)}`
}

/**
 * The words in the row's top rule: what the session breaks, without the
 * invariant's title or words or the instruction's words (the next line
 * holds those).
 */
export function alertBanner(alert: CourseKeeperAlert): string {
  if (/^instruction "/.test(alert.reference)) return 'Session breaks your instruction'
  if (/^invariant "/.test(alert.reference)) return 'Session breaks your rule'

  return `Session breaks ${alert.reference}`
}

/**
 * The line under the top rule: the invariant's title or quoted words, or
 * the instruction's words, quoted. Undefined for an invariant whose title is
 * not stored.
 */
export function alertRule(
  alert: CourseKeeperAlert,
): { label: string; words: string } | undefined {
  const instruction = quotedWords(alert.reference, 'instruction')
  if (instruction !== undefined) return { label: 'Your instruction', words: instruction }
  const words = quotedWords(alert.reference, 'invariant')
  if (words !== undefined) return { label: 'Your rule', words }
  if (/^invariant \d+$/.test(alert.reference) && alert.title !== undefined) {
    return { label: 'Your rule', words: alert.title }
  }

  return undefined
}

/**
 * The agent's words without Markdown's inline marks, as the person read them
 * in the transcript: `**bold**`, `__bold__`, `*em*`, `_em_` and `` `code` ``
 * keep their text. A code span keeps its text exactly (`obj.__dict__`), and
 * an underscore inside a word (`snake_case`) stays.
 */
export function plainQuote(text: string): string {
  const prose = (part: string) =>
    part
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[\s(["'])([*_])(?=\S)([^*_]+?)(?<=\S)\2(?=[\s.,;:!?)"']|$)/g, '$1$3')

  // Odd pieces are code spans: their backticks go, their text stays as is.
  return text
    .split(/`([^`]+)`/)
    .map((part, i) => (i % 2 === 1 ? part : prose(part)))
    .join('')
}

/**
 * Calls `attempt` until it is not refused, waiting between tries, at most
 * `tries` times. True when an attempt went through. For a call whose target
 * may not exist yet, such as a scroll to a part drawn after a state write.
 * A refusal that `isFinal` names (the person moved the window meanwhile)
 * stops it at once, so a retry never works against the person.
 */
export async function retried(
  attempt: () => Promise<{ deny?: string }>,
  wait: () => Promise<void>,
  tries: number,
  isFinal: (deny: string) => boolean = () => false,
): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    const { deny } = await attempt()
    if (deny === undefined) return true
    if (isFinal(deny)) return false
    if (i < tries - 1) await wait()
  }

  return false
}

/** A horizontal rule `width` cells wide, at least two cells. */
export function ruleLine(width: number): string {
  return '─'.repeat(Math.max(width, 2))
}

/** The notice shown when standing instructions are added. */
export function addedNotice(added: readonly string[]): string {
  const quoted = added.map(text => `"${clean(text, 80)}"`).join('; ')

  return added.length === 1
    ? `Course Keeper noted a standing instruction: ${quoted}`
    : `Course Keeper noted ${added.length} standing instructions: ${quoted}`
}

function time(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/**
 * Quoted text that ends a sentence: the text in quotation marks, then a
 * period, unless the text already ends with a period, a question mark or an
 * exclamation mark. Closing quotation marks and brackets after that mark do
 * not count: `He said "stop."` already ends its sentence.
 */
export function quotedSentence(text: string): string {
  return /[.?!]["'\u201d\u2019)\]]*$/.test(text) ? `"${text}"` : `"${text}".`
}

/** The default name of the vision file. */
export const DEFAULT_VISION_FILE = 'VISION.md'
/** The default name of the anti-patterns file. */
export const DEFAULT_ANTI_PATTERNS_FILE = 'ANTI-PATTERNS.md'
const MAX_FILE_NAME = 200

/**
 * The names of the two files, as configured: paths relative to the directory
 * where the vision is looked for. The texts shown to the person use them.
 */
export type FileNames = { vision: string; antiPatterns: string }

export const DEFAULT_FILE_NAMES: FileNames = {
  vision: DEFAULT_VISION_FILE,
  antiPatterns: DEFAULT_ANTI_PATTERNS_FILE,
}

/**
 * A configured file name, or `fallback` when the value is not a safe relative
 * path: not a string, empty, absolute (`/`, `~`, a drive letter), with a
 * backslash, a `..` segment or a control character, or over 200 characters.
 * Empty and `.` segments are dropped, so `./docs//VISION.md` is `docs/VISION.md`.
 */
export function fileName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const name = value.trim()
  if (name === '' || name.length > MAX_FILE_NAME) return fallback
  if (/^[/~]/.test(name) || /^[A-Za-z]:/.test(name) || name.includes('\\')) return fallback
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return fallback
  const segments = name.split('/')
  if (segments.includes('..')) return fallback
  const kept = segments.filter(segment => segment !== '' && segment !== '.')

  return kept.length === 0 ? fallback : kept.join('/')
}

/** The file names from the plugin's options, each one checked by `fileName`. */
export function fileNames(options: { visionFile?: unknown; antiPatternsFile?: unknown }): FileNames {
  return {
    vision: fileName(options.visionFile, DEFAULT_VISION_FILE),
    antiPatterns: fileName(options.antiPatternsFile, DEFAULT_ANTI_PATTERNS_FILE),
  }
}

const DIRECTIVE =
  /^[ \t]*<!--[ \t]*course-keeper:[ \t]*anti-patterns[ \t]*=[ \t]*(.*?)[ \t]*-->[ \t]*\r?$/i

/**
 * True when a relative path that a project chooses may be read for it: it
 * ends in `.md` or `.markdown` and no segment starts with a dot. The project's
 * author chooses such a path, not the person, so no other kind of file goes
 * to the model.
 */
export function isMarkdownOutsideHidden(relative: string): boolean {
  return (
    /\.(md|markdown)$/i.test(relative) &&
    !relative.split(/[\\/]/).some(segment => segment.startsWith('.'))
  )
}

/**
 * True when the real path `real` lies under the real root `root` and its
 * part below the root passes `isMarkdownOutsideHidden`. A link can lead a
 * safe name to an unsafe file; this checks the file itself.
 */
export function isMarkdownOutsideHiddenUnder(real: string, root: string): boolean {
  if (!isUnderRoot(real, root)) return false
  const base = root.replace(root.startsWith('/') ? /\/+$/ : /[\\/]+$/, '')

  return isMarkdownOutsideHidden(real.slice(base.length + 1))
}

/**
 * The anti-patterns file that the vision names for its own project, in one
 * HTML comment on the first line of the vision that is not empty, such as
 * `<!-- course-keeper: anti-patterns = docs/vision/anti-patterns.md -->`.
 * That line must be the comment alone. The comment counts nowhere else, so
 * an example further down never counts. The name must pass `fileName` and
 * `isMarkdownOutsideHidden`; otherwise the directive is `refused` and names
 * no file. Undefined: no directive.
 */
export function antiPatternsDirective(
  vision: string,
): { kind: 'named'; name: string } | { kind: 'refused' } | undefined {
  const first = vision
    .replace(/^\uFEFF/, '')
    .split('\n')
    .find(line => !/^[ \t]*\r?$/.test(line))
  const value = first === undefined ? undefined : DIRECTIVE.exec(first)?.[1]
  if (value === undefined) return undefined
  const name = fileName(value, '')

  return name !== '' && isMarkdownOutsideHidden(name) ? { kind: 'named', name } : { kind: 'refused' }
}

/**
 * Where the anti-patterns file of a project comes from, when the vision has
 * a directive: `read` when the named file was read, `missing` when it was
 * not found, could not be read, or leads through a link to a file that
 * `isMarkdownOutsideHidden` refuses, `vision` when it is the vision itself,
 * `refused` when the directive names no file that may be read.
 */
export type NamedInVision = 'read' | 'missing' | 'vision' | 'refused'

/** The text `/course-keeper` prints. */
export function statusText(
  record: CourseKeeperSession,
  visionPath: string | undefined,
  antiPatternsPath?: string,
  names: FileNames = DEFAULT_FILE_NAMES,
  namedInVision?: NamedInVision,
): string {
  const named = ` (named in ${names.vision})`
  const antiPatternsLines =
    namedInVision === 'missing'
      ? [`${names.antiPatterns}: not found or not readable${named}. The vision alone is used.`]
      : namedInVision === 'vision'
        ? [`${names.antiPatterns}: the vision itself${named}. No separate file is used.`]
        : [
            ...(namedInVision === 'refused'
              ? [
                  `<!-- course-keeper: anti-patterns --> in ${names.vision} is not used: ` +
                    'it must name a Markdown file in the project, outside hidden folders.',
                ]
              : []),
            ...(antiPatternsPath === undefined
              ? []
              : [`${names.antiPatterns}: ${antiPatternsPath}${namedInVision === 'read' ? named : ''}`]),
          ]
  const lines = [
    visionPath === undefined
      ? `${names.vision}: not found. No checks run without it.`
      : `${names.vision}: ${visionPath}`,
    ...antiPatternsLines,
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
            `  ${i + 1}. ${a.reference}: ${a.alert}` +
            (a.instead === undefined ? '' : ` Instead: ${a.instead.replace(/\.$/, '')}.`) +
            ` Answer: ${describeAnswer(a.answer)}.`,
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
  const { reference, title, alert, instead, evidence, note, shownAt, answer } = value
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

  // Absent in a record written before alerts kept a title or an instead.
  const kept = typeof title === 'string' ? clean(title, MAX_HEADLINE_PART) : ''
  const keptInstead = typeof instead === 'string' ? clean(instead, LIMITS.instead) : ''

  return {
    reference: clean(reference, LIMITS.reference),
    ...(kept === '' ? {} : { title: kept }),
    alert: clean(alert, LIMITS.alert),
    ...(keptInstead === '' ? {} : { instead: keptInstead }),
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
  // Both absent in a record written before the learn step existed.
  const learn = readDraft(value.learn)
  const learningSince =
    typeof value.learningSince === 'number' && Number.isFinite(value.learningSince)
      ? value.learningSince
      : undefined
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
    ...(value.confirmFalseAlarm === true && current !== null
      ? { confirmFalseAlarm: true }
      : {}),
    lastCheck,
    checkingSince:
      typeof value.checkingSince === 'number' && Number.isFinite(value.checkingSince)
        ? value.checkingSince
        : null,
    ...(learningSince === undefined ? {} : { learningSince }),
    ...(learn === undefined ? {} : { learn }),
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

// The learn step: `/course-keeper learn` drafts one "Never" sentence for
// VISION.md from the agent's failing reply and tests it on excerpts of the
// session. It shows the draft to the person and changes nothing else.

/** The most characters kept of each field of a learn reply. */
export const LEARN_LIMITS = {
  quote: 600,
  act: 300,
  forms: 300,
  variant: 300,
  place: 40,
  sentence: 700,
  allowed: 300,
  reason: 300,
} as const
export const MAX_CATCH_LENGTH = 600
export const NO_CATCH =
  "The person gave no words with the request. Take the person's most recent correction of the agent as the catch."
/** How a compaction summary starts, as the engine writes it. */
export const COMPACTION_START =
  'This session is being continued from a previous conversation'
/** How many earlier turns the learn step tests the sentence on. */
export const MAX_EARLIER_TURNS = 3

/** The catch field of the learn prompt. */
export function catchText(words: string): string {
  const text = clean(words, MAX_CATCH_LENGTH)

  return text === ''
    ? NO_CATCH
    : `The person described the act in these words: "${text}"`
}

/** Fills the two fields of the learn prompt in one pass. */
export function fillLearnPrompt(
  template: string,
  fields: { vision: string; catch: string },
): string {
  const values: Record<string, string> = fields

  return template.replace(
    /\{\{(vision|catch)\}\}/g,
    (_, name: string) => values[name] ?? '',
  )
}

export type LearnReply =
  | { result: 'none'; reason: string }
  | {
      result: 'draft'
      quote: string
      act: string
      forms: string
      variant: string
      place: string
      sentence: string
      allowed: string
    }

const LEARN_FIELD =
  /^(result|quote|act|forms|variant|place|sentence|allowed|reason)\s*:\s*(.*)$/i
const PLACE = {
  invariant: /^[`*_]*invariant\s+(\d+)\b/i,
  new: /^[`*_]*new\b/i,
}

/** `invariant <number>` or `new`, or undefined when the field is neither. */
function canonicalPlace(field: string): string | undefined {
  const invariant = PLACE.invariant.exec(field)
  if (invariant) return `invariant ${Number(invariant[1])}`

  return PLACE.new.test(field) ? 'new' : undefined
}

/**
 * Reads a learn reply. The first occurrence of a field wins; a repeat and
 * the lines that continue it are dropped. Returns undefined for a malformed
 * reply: an unknown result, or a draft without a quote, an act, a place of
 * the form `invariant <number>` or `new`, or a sentence that starts with
 * "Never".
 */
export function parseLearnReply(reply: string): LearnReply | undefined {
  const fields = new Map<string, string>()
  let last: string | undefined

  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.trim()

    if (line.startsWith('```')) {
      last = undefined
      continue
    }
    if (line === '') continue

    const match = LEARN_FIELD.exec(line)
    if (match) {
      const name = (match[1] ?? '').toLowerCase()
      if (fields.has(name)) {
        last = undefined
        continue
      }
      fields.set(name, match[2] ?? '')
      last = name
    } else if (last !== undefined) {
      fields.set(last, `${fields.get(last) ?? ''} ${line}`)
    }
  }

  const field = (name: keyof typeof LEARN_LIMITS) =>
    clean(fields.get(name) ?? '', LEARN_LIMITS[name])
  const result = clean(fields.get('result') ?? '', 20)
    .toLowerCase()
    .replace(/[^a-z]/g, '')

  if (result === 'none') return { result: 'none', reason: field('reason') }
  if (result !== 'draft') return undefined

  // Kept as the model wrote it: `quotedRow` decides whether its `\"` is an
  // escape or the agent's own text.
  const quote = clean(stripQuotes(fields.get('quote') ?? ''), LEARN_LIMITS.quote)
  const act = field('act')
  const sentence = field('sentence')
  const place = canonicalPlace(clean(fields.get('place') ?? '', Infinity))

  if (quote === '' || act === '' || sentence === '' || place === undefined) {
    return undefined
  }
  if (!/^never\b/i.test(sentence)) return undefined

  return {
    result: 'draft',
    quote,
    act,
    forms: field('forms'),
    variant: field('variant'),
    place,
    sentence,
    allowed: field('allowed'),
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * True when the text holds the quote word for word, with runs of whitespace
 * counted as one space. An empty quote is in no text.
 */
export function holdsQuote(text: string, quote: string): boolean {
  const wanted = collapse(quote)

  return wanted !== '' && collapse(text).includes(wanted)
}

/**
 * The index of the last assistant row whose text holds the quote word for
 * word, with runs of whitespace counted as one space; -1 when none does.
 */
export function findQuote(rows: readonly SessionMessage[], quote: string): number {
  return rows.findLastIndex(row => row.role === 'assistant' && holdsQuote(row.text, quote))
}

/**
 * The failing reply of a draft: the last assistant row that holds the quote
 * (as `findQuote` reads it) and that comes before the last person message.
 * The agent's answer to the correction can repeat the words it is corrected
 * for, so a row in the newest turn counts only when no earlier row holds the
 * quote. -1 when no row holds it.
 */
export function failingRow(rows: readonly SessionMessage[], quote: string): number {
  const wanted = collapse(quote)
  if (wanted === '') return -1
  const newest = rows.findLastIndex((_, k) => isPersonMessage(rows[k], rows[k - 1]))
  const before = rows.findLastIndex(
    (row, k) => k < newest && row.role === 'assistant' && collapse(row.text).includes(wanted),
  )

  return before >= 0 ? before : findQuote(rows, quote)
}

/**
 * The form of a learn quote that stands in the agent's replies, with the row
 * that `failingRow` finds for it: the quote as the model wrote it, else with
 * each `\"` turned into `"`. A model escapes a double quote inside the quote,
 * but the agent's own words can hold a backslash before a quote too.
 * Undefined when neither form is in a reply.
 */
export function quotedRow(
  rows: readonly SessionMessage[],
  quote: string,
): { quote: string; at: number } | undefined {
  for (const form of new Set([quote, unescapeQuotes(quote)])) {
    const at = failingRow(rows, form)
    if (at >= 0) return { quote: form, at }
  }

  return undefined
}

function isCompactionSummary(row: SessionMessage): boolean {
  return row.role === 'user' && row.text.trimStart().startsWith(COMPACTION_START)
}

/**
 * True for a message the person sent: a user row with text and no tool
 * results that is neither an engine notice (it starts with `<`) nor a
 * compaction summary. A user row right after a row of tool results is not
 * one either: the engine put it there inside the agent's turn (a skill's
 * text after the skill's tool call, say).
 */
export function isPersonMessage(
  row: SessionMessage | undefined,
  previous?: SessionMessage,
): boolean {
  if (row === undefined || row.role !== 'user') return false
  if ((row.toolResults?.length ?? 0) > 0) return false
  if (previous?.role === 'user' && (previous.toolResults?.length ?? 0) > 0) return false
  const text = row.text.trimStart()

  return text !== '' && !text.startsWith('<') && !text.startsWith(COMPACTION_START)
}

/** The first and the last row of a turn, both included. */
export type Turn = { start: number; end: number }

/**
 * The turns of a transcript, oldest first. Each person message starts a
 * turn; the rows before the first one form a turn of their own. A turn
 * ends at its last assistant row: the rows after it (engine notices, the
 * rows of a command) are not part of the agent's turn. A turn without an
 * assistant row runs to the row before the next person message.
 */
export function turnsOf(rows: readonly SessionMessage[]): Turn[] {
  const turns: Turn[] = []
  let start = 0
  for (let k = 1; k <= rows.length; k += 1) {
    if (k === rows.length || isPersonMessage(rows[k], rows[k - 1])) {
      let end = k - 1
      while (end > start && rows[end]?.role !== 'assistant') end -= 1
      turns.push({ start, end: rows[end]?.role === 'assistant' ? end : k - 1 })
      start = k
    }
  }

  return turns
}

/** The turn that holds row `i`. */
export function turnOf(rows: readonly SessionMessage[], i: number): Turn {
  return (
    turnsOf(rows).find(turn => turn.start <= i && i <= turn.end) ?? { start: i, end: i }
  )
}

/** How many person messages the rows hold up to and including row `start`. */
export function personCountAt(rows: readonly SessionMessage[], start: number): number {
  let count = 0
  for (let k = 0; k <= start && k < rows.length; k += 1) {
    if (isPersonMessage(rows[k], rows[k - 1])) count += 1
  }

  return count
}

/**
 * The turn that starts at person message number `personCount` (0: the rows
 * before the first person message), when one of its assistant rows holds the
 * quote; undefined otherwise. A draft stores the number, so a later reply
 * that repeats the quote does not move the failing turn.
 */
export function failingTurnAt(
  rows: readonly SessionMessage[],
  personCount: number,
  quote: string,
): Turn | undefined {
  const turn = turnsOf(rows).find(t => personCountAt(rows, t.start) === personCount)
  if (turn === undefined) return undefined
  const holds = rows
    .slice(turn.start, turn.end + 1)
    .some(row => row.role === 'assistant' && holdsQuote(row.text, quote))

  return holds ? turn : undefined
}

/**
 * Up to `max` turns that ended before `turn` started and hold an assistant
 * row, newest first.
 */
export function earlierTurns(
  rows: readonly SessionMessage[],
  turn: Turn,
  max = MAX_EARLIER_TURNS,
): Turn[] {
  return turnsOf(rows)
    .filter(
      t =>
        t.end < turn.start &&
        rows.slice(t.start, t.end + 1).some(row => row.role === 'assistant'),
    )
    .reverse()
    .slice(0, max)
}

function head(text: string, max: number): string {
  const chars = Array.from(text)

  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** The text whole, or its first `first` and last `rest` characters around `mark`. */
function cutMiddle(text: string, max: number, first: number, rest: number, mark: string) {
  const chars = Array.from(text)

  return chars.length <= max
    ? text
    : `${chars.slice(0, first).join('')}${mark}${chars.slice(-rest).join('')}`
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** One row of a turn as the excerpt shows it; '' for a row with nothing in it. */
function rowText(row: SessionMessage): string {
  const parts = row.text.trim() === '' ? [] : [row.text]
  if (row.role === 'assistant') {
    for (const use of row.toolUses) {
      parts.push(`[tool call ${use.tool}: ${head(json(use.input), 1500)}]`)
    }
  } else {
    for (const result of row.toolResults ?? []) {
      parts.push(`[tool result: ${head(result.text, 1500)}]`)
    }
  }
  const text = parts.join('\n')
  if (text.trim() === '') return ''

  return `${row.role === 'assistant' ? 'AGENT' : 'INPUT'}: ${text}`
}

// The excerpt keeps at most LATEST_MAX characters of a turn: the first
// LATEST_FIRST and the last LATEST_LAST, around LATEST_CUT.
const LATEST_MAX = 60000
const LATEST_FIRST = 20000
const LATEST_LAST = 40000
const LATEST_CUT = '\n\n[... middle of the turn left out ...]\n\n'
const PART_SEPARATOR = '\n\n'

/** The rows of a turn as the excerpt shows them, with the role of each. */
function latestParts(
  rows: readonly SessionMessage[],
  turn: Turn,
): { role: SessionMessage['role']; text: string }[] {
  return rows
    .slice(turn.start, turn.end + 1)
    .filter(row => !isCompactionSummary(row))
    .map(row => ({ role: row.role, text: rowText(row) }))
    .filter(part => part.text !== '')
}

/**
 * The excerpt of the session that an excerpt check reads for one turn: the
 * newest compaction summary before the turn's end, every person message up
 * to the turn's first row in order, and the rows of the turn.
 */
export function sessionExcerpt(rows: readonly SessionMessage[], turn: Turn): string {
  let summary: string | undefined
  const person: string[] = []
  for (let k = 0; k <= turn.end && k < rows.length; k += 1) {
    const row = rows[k]
    if (row === undefined) continue
    if (isCompactionSummary(row)) summary = row.text.trim()
    // A message the person repeats stays: it can restate an instruction.
    if (k <= turn.start && isPersonMessage(row, rows[k - 1])) person.push(row.text.trim())
  }

  const latest = latestParts(rows, turn)
    .map(part => part.text)
    .join(PART_SEPARATOR)

  const sections: string[] = []
  if (summary !== undefined) {
    sections.push(
      '## Summary that replaced the earlier conversation\n\n' +
        cutMiddle(summary, 40000, 28000, 12000, '\n[... cut ...]\n'),
    )
  }
  sections.push(
    '## Messages the person sent, oldest first\n\n' +
      (person.length === 0
        ? '(none in this part of the session)'
        : person.map(text => head(text, 3000)).join('\n\n')),
  )
  sections.push(
    "## The agent's latest turn\n\n" +
      cutMiddle(latest, LATEST_MAX, LATEST_FIRST, LATEST_LAST, LATEST_CUT),
  )

  return sections.join('\n\n')
}

/**
 * True when an agent row of the turn holds the quote in the part that the
 * excerpt keeps of the turn. Person messages and input rows do not count. A
 * quote that the cut splits does not count either.
 */
export function excerptKeepsQuote(
  rows: readonly SessionMessage[],
  turn: Turn,
  quote: string,
): boolean {
  const parts = latestParts(rows, turn).map(part => ({
    role: part.role,
    chars: Array.from(part.text),
  }))
  const separator = Array.from(PART_SEPARATOR).length
  const total = parts.reduce(
    (sum, part, k) => sum + part.chars.length + (k > 0 ? separator : 0),
    0,
  )
  const isCut = total > LATEST_MAX
  let start = 0
  for (const part of parts) {
    const at = start
    start += part.chars.length + separator
    if (part.role !== 'assistant') continue
    // The characters of this row before the cut and after it.
    const kept = isCut
      ? [
          part.chars.slice(0, Math.max(0, LATEST_FIRST - at)),
          part.chars.slice(Math.max(0, total - LATEST_LAST - at)),
        ]
      : [part.chars]
    if (kept.some(chars => holdsQuote(chars.join(''), quote))) return true
  }

  return false
}

const LEADING_REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>/

/**
 * A prompt without the system-reminder blocks at its start, and without the
 * whitespace around them. The desktop app can put such blocks before the
 * words a person types; they are not the person's words. A block later in
 * the text stays, and a prompt without a leading block comes back unchanged.
 */
export function withoutLeadingReminders(text: string): string {
  let rest = text
  while (LEADING_REMINDER.test(rest)) rest = rest.replace(LEADING_REMINDER, '')

  return rest === text ? text : rest.trimStart()
}

/**
 * The prompt of an excerpt check: the check prompt with its leading
 * system-reminder block replaced by `head`, the fields filled, and the
 * excerpt after it. Both templates come without their leading comments.
 */
export function excerptCheckPrompt(
  template: string,
  head: string,
  fields: { vision: string; instructions: string },
  excerpt: string,
): string {
  const top = head.trim()
  const body = LEADING_REMINDER.test(template)
    ? template.replace(LEADING_REMINDER, () => top)
    : `${top}\n\n${template}`
  const filled = fillCheckPrompt(body, {
    vision: fields.vision,
    instructions: fields.instructions,
    alerts: NO_ALERTS,
  })

  return `${filled}\n\n# The session excerpts\n\n${excerpt}`
}

const ITEM = /^\s*(\d+)[.)]\s/

/**
 * The vision with the sentence added. For `invariant <n>` the sentence goes
 * on its own line, indented three spaces, at the end of item n: before the
 * next blank line or the next numbered item. For `new`, or when the vision
 * has no item n, it goes at the end as item m+1, where m is the highest item
 * number. `target` is the number of the item that holds the sentence.
 */
export function addSentence(
  vision: string,
  place: string,
  sentence: string,
): { text: string; target: number; isNew: boolean } {
  const lines = vision.split('\n')
  const wanted = /^invariant (\d+)$/.exec(place)
  if (wanted) {
    const n = Number(wanted[1])
    const at = lines.findIndex(line => Number(ITEM.exec(line)?.[1]) === n)
    if (at >= 0) {
      let end = at
      for (;;) {
        const next = lines[end + 1]
        if (next === undefined || next.trim() === '' || ITEM.test(next)) break
        end += 1
      }

      return {
        text: [...lines.slice(0, end + 1), `   ${sentence}`, ...lines.slice(end + 1)].join(
          '\n',
        ),
        target: n,
        isNew: false,
      }
    }
  }
  const highest = lines.reduce((m, line) => {
    const item = ITEM.exec(line)

    return item ? Math.max(m, Number(item[1])) : m
  }, 0)
  const target = highest + 1

  return {
    text: `${vision.replace(/\s+$/, '')}\n\n${target}. ${sentence}\n`,
    target,
    isNew: true,
  }
}

export const ANTI_PATTERNS_HEADING = '# Anti-patterns: acts that break the invariants above'
export const ANTI_PATTERNS_NOTE =
  'The number of each section below is the number of the invariant it belongs to, ' +
  'and an act named in a section is a deviation from that invariant.'

/**
 * The text that fills the `{{vision}}` field of every prompt: the vision,
 * then the anti-patterns file under its own heading. Without an anti-patterns file, or with an
 * empty one, it is the vision unchanged.
 */
export function visionField(vision: string, antiPatterns: string | undefined): string {
  if (antiPatterns === undefined || antiPatterns.trim() === '') return vision

  return `${vision.replace(/\s+$/, '')}\n\n${ANTI_PATTERNS_HEADING}\n${ANTI_PATTERNS_NOTE}\n\n${antiPatterns}`
}

const ANY_HEADING = /^#{1,6}(\s|$)/

/**
 * The anti-patterns text with the sentence added as a bullet at the end of the
 * section of invariant n: from its heading to the line before the next
 * heading, or to the end. Trailing blank lines stay after the bullet. When
 * the anti-patterns text has no such section, a new section `## n.` is appended.
 */
export function addAntiPattern(antiPatterns: string, n: number, sentence: string): string {
  const bullet = `- ${sentence}`
  const lines = antiPatterns.split('\n')
  const own = new RegExp(`^#{1,6}\\s*${n}(?:[.)]|\\s|$)`)
  // A heading inside a fenced code block is text, not a section.
  const fenced = fencedLines(lines)
  const at = lines.findIndex((line, i) => !fenced[i] && own.test(line))
  if (at < 0) {
    const kept = antiPatterns.replace(/\s+$/, '')

    return `${kept === '' ? '' : `${kept}\n\n`}## ${n}.\n\n${bullet}\n`
  }
  const next = lines.findIndex((line, i) => i > at && !fenced[i] && ANY_HEADING.test(line))
  let last = (next < 0 ? lines.length : next) - 1
  while (last > at && (lines[last] ?? '').trim() === '') last -= 1
  const added = last === at ? ['', bullet] : [bullet]

  return [...lines.slice(0, last + 1), ...added, ...lines.slice(last + 1)].join('\n')
}

/**
 * For each line, true when it lies in a fenced code block (``` or ~~~, up to
 * three spaces in), the fence lines included. A block closes at a line of
 * the same fence character, at least as long, and nothing else; one that
 * never closes runs to the end.
 */
export function fencedLines(lines: readonly string[]): boolean[] {
  let fence: string | undefined

  return lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === undefined) {
      if (marker === undefined) return false
      fence = marker

      return true
    }
    if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      fence = undefined
    }

    return true
  })
}

/**
 * True when `path` lies strictly under the directory `root`: both are real
 * paths (every link followed). A trailing separator on the root does not
 * count, the root itself is not under it, and `/r/app2` is not under `/r/app`.
 */
export function isUnderRoot(path: string, root: string): boolean {
  // On a POSIX root a backslash is a character of a name, not a separator.
  const posix = root.startsWith('/')
  const base = root.replace(posix ? /\/+$/ : /[\\/]+$/, '')
  if (!path.startsWith(base) || path.length <= base.length + 1) return false
  const sep = path[base.length]

  return sep === '/' || (!posix && sep === '\\')
}

/**
 * The `{{vision}}` field with the draft's sentence added. With an anti-patterns file
 * and the place `invariant <n>`, the sentence goes into the anti-patterns text under
 * invariant n (`inAntiPatterns`). Otherwise it goes into the vision as
 * `addSentence` places it.
 */
export function addDraftSentence(
  vision: string,
  antiPatterns: string | undefined,
  place: string,
  sentence: string,
): { text: string; target: number; isNew: boolean; inAntiPatterns: boolean } {
  const wanted = /^invariant (\d+)$/.exec(place)
  const target = wanted ? Number(wanted[1]) : 0
  // A number that the vision does not hold names no invariant: the sentence
  // then goes the way of `addSentence`, as a new invariant.
  const held = vision.split('\n').some(line => Number(ITEM.exec(line)?.[1]) === target)
  if (antiPatterns !== undefined && wanted && held) {

    return {
      text: visionField(vision, addAntiPattern(antiPatterns, target, sentence)),
      target,
      isNew: false,
      inAntiPatterns: true,
    }
  }
  const added = addSentence(vision, place, sentence)

  return { ...added, text: visionField(added.text, antiPatterns), inAntiPatterns: false }
}

/** What one excerpt check gave: a reply, or why there is none. */
export type ExcerptResult =
  | { kind: 'reply'; reply: CheckReply }
  | { kind: 'no result'; reason: string }

/** True when the result is an alert on `invariant <target>`. */
export function alertsOn(result: ExcerptResult, target: number): boolean {
  return (
    result.kind === 'reply' &&
    result.reply.verdict === 'deviation' &&
    result.reply.reference === `invariant ${target}`
  )
}

/** The pending draft made from a learn reply. */
export function draftOf(
  reply: Extract<LearnReply, { result: 'draft' }>,
  draftedAt: number,
  model: string,
  personCount: number,
): CourseKeeperDraft {
  const { result: _, ...fields } = reply

  return { ...fields, draftedAt, model: clean(model, 100), personCount }
}

function readDraft(value: unknown): CourseKeeperDraft | undefined {
  if (!isObject(value)) return undefined
  const {
    quote,
    act,
    forms,
    variant,
    place,
    sentence,
    allowed,
    draftedAt,
    model,
    personCount,
  } = value
  const texts = [quote, act, forms, variant, place, sentence, allowed, model]
  if (
    !texts.every(text => typeof text === 'string') ||
    typeof draftedAt !== 'number' ||
    !Number.isFinite(draftedAt) ||
    typeof personCount !== 'number' ||
    !Number.isInteger(personCount) ||
    personCount < 0
  ) {
    return undefined
  }
  const read = {
    quote: clean(quote as string, LEARN_LIMITS.quote),
    act: clean(act as string, LEARN_LIMITS.act),
    forms: clean(forms as string, LEARN_LIMITS.forms),
    variant: clean(variant as string, LEARN_LIMITS.variant),
    place: canonicalPlace(clean(place as string, LEARN_LIMITS.place)),
    sentence: clean(sentence as string, LEARN_LIMITS.sentence),
    allowed: clean(allowed as string, LEARN_LIMITS.allowed),
    draftedAt,
    model: clean(model as string, 100),
    personCount,
  }
  const { place: placed } = read
  if (
    placed === undefined ||
    read.quote === '' ||
    read.act === '' ||
    !/^never\b/i.test(read.sentence)
  ) {
    return undefined
  }

  return { ...read, place: placed }
}

/** The record without its pending draft. */
export function withoutDraft(record: CourseKeeperSession): CourseKeeperSession {
  if (record.learn === undefined) return record
  const { learn: _, ...rest } = record

  return rest
}

export const GIVE_WORDS =
  'To give the act in your words: /course-keeper learn <what the agent did wrong>'

/** The answer to `/course-keeper learn` when the draft's quote was found. */
export function draftText(draft: CourseKeeperDraft): string {
  return [
    'Course Keeper read this as the act you corrected:',
    `  ${draft.act}`,
    `The agent's words: "${draft.quote}"`,
    '',
    'If this is the act: /course-keeper learn yes',
    'If it is not: /course-keeper learn <what the agent did wrong, in your words>',
    'To drop it: /course-keeper learn cancel',
  ].join('\n')
}

/**
 * The answer when the control check already alerts on the corrected turn, on
 * the invariant that the draft's sentence would join. The alert can be about
 * another matter of the same turn, so the person decides.
 */
export function coveredText(reply: Extract<CheckReply, { verdict: 'deviation' }>): string {
  return (
    'The check already alerts on the turn you corrected with today\'s vision ' +
    `(${reply.reference}): ${reply.alert} Evidence: ${quotedSentence(reply.evidence)} ` +
    'If this alert is about the act you corrected, the vision already covers the act, ' +
    'so no sentence is offered. If the alert is about another matter, run ' +
    '/course-keeper learn <the act in words> again. The draft is dropped.'
  )
}

/** What the tests on earlier turns found. */
export type EarlierTest = {
  /** How many earlier turns were tested. */
  tested: number
  /** The evidence of each new alert, newest turn first. */
  newAlerts: string[]
  /** Why each turn without a result has none. */
  noResults: string[]
}

function verifyLine(verify: ExcerptResult, target: number): string {
  if (verify.kind === 'no result') return `no result (${verify.reason}).`
  if (alertsOn(verify, target)) return 'the check alerts with this sentence added.'
  if (verify.reply.verdict === 'deviation') {
    return (
      `the check alerts on ${verify.reply.reference}, not on invariant ${target}, ` +
      'with this sentence added. The sentence is not verified.'
    )
  }

  return 'the check stays silent with this sentence added. The sentence is not verified.'
}

function earlierLine(earlier: EarlierTest): string {
  const { tested, newAlerts, noResults } = earlier
  if (tested === 0) {
    return 'Test on earlier turns of this session: no earlier turn to test.'
  }
  const start = `Test on ${tested} earlier turn${tested === 1 ? '' : 's'} of this session: `
  const missing =
    noResults.length === 0
      ? ''
      : ` No result on ${noResults.length} of them (${noResults[0]}).`
  if (newAlerts.length > 0) {
    const count = newAlerts.length
    const quoted = newAlerts
      .map((text, i) => (i === count - 1 ? quotedSentence(text) : `"${text}"`))
      .join('; ')

    return (
      `${start}${count} new alert${count === 1 ? '' : 's'}: ${quoted} ` +
      `Read ${count === 1 ? 'it' : 'them'}: such an alert can be sound.${missing}`
    )
  }
  if (noResults.length === tested) return `${start}no result (${noResults[0]}).`

  return `${start}no new alert.${missing}`
}

function placeText(target: number, isNew: boolean): string {
  return isNew ? 'as a new invariant' : `invariant ${target}`
}

/** Where the draft's sentence goes, as a report names it. */
function draftHeading(
  target: number,
  isNew: boolean,
  inAntiPatterns: boolean,
  names: FileNames,
): string {
  return inAntiPatterns
    ? `Draft sentence for ${names.antiPatterns}, under invariant ${target}`
    : `Draft sentence for ${names.vision}, ${placeText(target, isNew)}`
}

/** The lines that close a report: what the draft allows, its source, the notes. */
function closingLines(
  draft: CourseKeeperDraft,
  version: string | undefined,
  inAntiPatterns: boolean,
  names: FileNames,
): string[] {
  const lines = draft.allowed === '' ? [] : [`Must stay allowed: ${draft.allowed}`]
  const date = new Date(draft.draftedAt).toISOString().slice(0, 10)
  lines.push(
    '',
    `Where it comes from: the agent's words "${draft.quote}"; drafted ${date} UTC by ` +
      `${draft.model || "the session's model"}` +
      `${version === undefined ? '' : `; Course Keeper ${version}`}.`,
    '',
    inAntiPatterns
      ? `This is a draft for the owners of ${names.antiPatterns} and ${names.vision}. Course Keeper does not change the files.`
      : `This is a draft for the owners of ${names.vision}. Course Keeper does not change the file.`,
    '- An alert in the test does not prove that the sentence names the right act. Compare it with what you corrected.',
    '- Widen or narrow it before you add it. In a measurement on 8 recorded catches, 4 of 16 drafts were',
    '  too broad and 4 too narrow.',
    '- Whether an agent that reads the sentence avoids the act is not measured.',
  )

  return lines
}

/** The answer to `/course-keeper learn yes` once the tests ran. */
export function learnReport(input: {
  draft: CourseKeeperDraft
  target: number
  isNew: boolean
  control: ExcerptResult
  verify: ExcerptResult
  earlier: EarlierTest
  version?: string
  /** True when the sentence goes into ANTI-PATTERNS.md. */
  inAntiPatterns?: boolean
  /** The configured file names; the defaults when not given. */
  names?: FileNames
}): string {
  const { draft, target, isNew, control, verify, earlier, version } = input
  const inAntiPatterns = input.inAntiPatterns === true
  const names = input.names ?? DEFAULT_FILE_NAMES
  const lines = [
    `${draftHeading(target, isNew, inAntiPatterns, names)}:`,
    `  ${draft.sentence}`,
    '',
  ]
  if (control.kind === 'no result') {
    lines.push(
      `Check with today's vision on the turn you corrected: no result (${control.reason}).`,
    )
  } else if (control.reply.verdict === 'deviation') {
    // The control alerts, but not where the sentence goes: another matter.
    lines.push(
      `With today's vision the check alerts on this turn on ${control.reply.reference}, ` +
        `another matter: ${quotedSentence(control.reply.alert)}`,
    )
  }
  lines.push(
    `Test on the turn you corrected: ${verifyLine(verify, target)}`,
    earlierLine(earlier),
    ...closingLines(draft, version, inAntiPatterns, names),
  )

  return lines.join('\n')
}

/**
 * The answer when the corrected turn is too long for the test: the excerpt
 * leaves out the middle of the turn, and the agent's words fall there.
 */
export function untestedReport(input: {
  draft: CourseKeeperDraft
  target: number
  isNew: boolean
  version?: string
  /** True when the sentence goes into ANTI-PATTERNS.md. */
  inAntiPatterns?: boolean
  /** The configured file names; the defaults when not given. */
  names?: FileNames
}): string {
  const { draft, target, isNew, version } = input
  const inAntiPatterns = input.inAntiPatterns === true
  const names = input.names ?? DEFAULT_FILE_NAMES

  return [
    'The turn you corrected is too long for the test. The agent\'s words fall in the part ' +
      'that the excerpt leaves out, so the sentence could not be tested. The draft is dropped.',
    '',
    `${draftHeading(target, isNew, inAntiPatterns, names)} (not tested):`,
    `  ${draft.sentence}`,
    ...closingLines(draft, version, inAntiPatterns, names),
  ].join('\n')
}
