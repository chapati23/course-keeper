// Course Keeper: checks the main agent's work against the project's vision
// and the person's standing instructions at the end of each turn, and
// alerts the person when the session deviates from them.
//
// Every hook passes its event on and catches its own errors. Course Keeper
// never denies or rewrites a tool call and never rewrites the person's
// prompt. The only event it changes is `session.compact`, where it adds to
// the summarizer's instructions.

import type { EngineInterface, Register, SessionRepo } from 'claude-code'

import type { CourseKeeperAlert, CourseKeeperSession } from '../types'
import {
  GIVE_WORDS,
  addDraftSentence,
  addInstructions,
  addWithdrawn,
  addedNotice,
  alertHeadline,
  alertBanner,
  alertRule,
  alertsOn,
  answerCurrent,
  antiPatternsDirective,
  applyReply,
  catchText,
  clean,
  compactInstructions,
  coveredText,
  draftOf,
  draftText,
  earlierTurns,
  excerptCheckPrompt,
  excerptKeepsQuote,
  failingRow,
  failingTurnAt,
  fileNames,
  fillCheckPrompt,
  fillExtractPrompt,
  fillLearnPrompt,
  forgetInstruction,
  formatAlerts,
  formatInstructions,
  invariantTitle,
  isCheckRunning,
  isMarkdownOutsideHiddenUnder,
  isUnderRoot,
  isPersonOrigin,
  learnReport,
  noteText,
  normalizeRecord,
  oldestKeys,
  parseCheckReply,
  parseExtractReply,
  parseLearnReply,
  personCountAt,
  removeWithdrawn,
  restoreUnsent,
  ruleLine,
  sessionExcerpt,
  shouldExtract,
  statusText,
  stripLeadingComments,
  turnOf,
  untestedReport,
  visionField,
  withFinalAnswer,
  withOutcome,
  withoutDraft,
} from './logic'
import type { EarlierTest, ExcerptResult, FileNames, NamedInVision, Turn } from './logic'

type $ = EngineInterface

const SESSION = { plugin: 'course-keeper', key: 'session' } as const
const STORE_PREFIX = 'session:'
const MAX_STORED_SESSIONS = 20
const USAGE =
  'Usage: /course-keeper, /course-keeper check, /course-keeper forget <n>, ' +
  '/course-keeper off, /course-keeper on, ' +
  '/course-keeper learn [yes | cancel | <what the agent did wrong>]'

// The main loop's latest turns as the hooks heard them. Module variables: a
// hot reload clears them, and a check then runs without the final answer and
// without the next-turn test below. A check reads them before its first wait.
let startedTurn: string | undefined
let endedTurn: { turnId: string; answer: string } | undefined

// The configured file names (VISION.md and ANTI-PATTERNS.md by default).
// `register` sets them; a change to the options reloads the module.
let files = fileNames({})

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

  // A check or a learn step that was in flight before the restart is not
  // running now.
  const { learningSince: _, ...rest } = normalizeRecord(record)

  return { record: { ...rest, checkingSince: null }, version: 0 }
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
 * is dropped and the write is tried again. This repeats until the store
 * takes the record or no other session is left; then the save is given up.
 * Never rejects.
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
    // Each refusal drops one other session, so this ends when none is left.
    while (true) {
      try {
        await $.store.set(own, value)

        return
      } catch {
        const [oldest] = oldestKeys(await savedTimes($, others), others.length - 1)
        if (oldest === undefined) return
        await $.store.delete(oldest)
        others = others.filter(key => key !== oldest)
      }
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
  throw new Error('Course Keeper: the session record kept changing')
}

async function readPrompt(
  $: $,
  name: 'check' | 'extract' | 'learn' | 'excerpt-head',
): Promise<string> {
  return stripLeadingComments(await $.fs.read(`${$.plugin.root}/prompts/${name}.md`))
}

type Vision = {
  path: string
  text: string
  /** ANTI-PATTERNS.md beside VISION.md, when it exists and can be read. */
  antiPatterns?: { path: string; text: string }
  /** The names in force for this project: the texts shown to the person use them. */
  names: FileNames
  /** Set when the vision names the anti-patterns file itself. */
  namedInVision?: NamedInVision
}

/**
 * VISION.md at the repository's main working tree; at the project root only
 * when the session is in no repository. When `repo()` fails, whether there
 * is a repository is unknown, and there is no vision. ANTI-PATTERNS.md in the
 * same directory is read too; without VISION.md it is not used. The vision's
 * name is the configured one. The anti-patterns name is the one the vision
 * names in its directive, else the configured one; it is resolved at each
 * read, so it never carries over to another project. A file whose real path
 * (every link followed) is not under the root's real path counts as not
 * found, so its text never goes to a model. When both names lead to the same
 * file, it is the vision.
 */
async function readVision($: $): Promise<Vision | undefined> {
  let repo: SessionRepo | null
  try {
    repo = await $.session.repo()
  } catch {
    return undefined
  }
  const dir = (repo === null ? await $.session.root() : repo.root).replace(/\/+$/, '')
  const root = await realPath($, dir === '' ? '/' : dir)
  if (root === undefined) return undefined
  const path = `${dir}/${files.vision}`
  const real = await realFileUnder($, path, root)
  if (real === undefined) return undefined
  let text: string
  try {
    text = await $.fs.read(real)
  } catch {
    // Missing or unreadable.
    return undefined
  }
  // A refused directive names no file: the configured name stays in force.
  const directive = antiPatternsDirective(text)
  const named = directive?.kind === 'named' ? directive.name : undefined
  const names = named === undefined ? files : { ...files, antiPatterns: named }
  const from = (namedInVision: NamedInVision): Partial<Vision> =>
    directive === undefined ? {} : { namedInVision: directive.kind === 'refused' ? 'refused' : namedInVision }
  const alone: Vision = { path, text, names, ...from('missing') }
  const antiPatternsPath = `${dir}/${names.antiPatterns}`
  const antiPatternsReal = await realFileUnder($, antiPatternsPath, root)
  if (antiPatternsReal === real) return { path, text, names, ...from('vision') }
  if (antiPatternsReal === undefined) return alone
  // The project chose this name: the file it leads to must pass the same rule.
  if (named !== undefined && !isMarkdownOutsideHiddenUnder(antiPatternsReal, root)) return alone
  try {
    return {
      path,
      text,
      names,
      antiPatterns: { path: antiPatternsPath, text: await $.fs.read(antiPatternsReal) },
      ...from('read'),
    }
  } catch {
    // No anti-patterns file, or an unreadable one: the vision alone.
    return alone
  }
}

/** Where `path` lands, every link followed; undefined when it cannot be told. */
async function realPath($: $, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

/** The real path of the file at `path` when it is a file under `root`. */
async function realFileUnder($: $, path: string, root: string): Promise<string | undefined> {
  let stat
  try {
    stat = await $.fs.stat(path, { resolve: true })
  } catch {
    return undefined
  }
  const real = stat.realPath

  return stat.kind === 'file' && real !== undefined && isUnderRoot(real, root) ? real : undefined
}

/** The text that fills the `{{vision}}` field of a prompt. */
function fieldOf(vision: Vision): string {
  return visionField(vision.text, vision.antiPatterns?.text)
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
    return record($, id, 'did not run: Course Keeper failed (a prompt file or a call)')
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
  if (vision === undefined) return record($, id, `did not run: no ${files.vision} found`)

  const template = await readPrompt($, 'check')
  const { record: held } = await load($, id)
  const prompt = fillCheckPrompt(template, {
    vision: fieldOf(vision),
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
  // the one the ended turn answered. A check that a turn started skips, and
  // the next turn's end checks it. One the person asked for runs without
  // the ended turn's answer. Nothing waits between these tests and the fork.
  const isOvertaken =
    turn !== undefined && startedTurn !== undefined && startedTurn !== turn.turnId
  if (trigger === 'turn' && isOvertaken) {
    return record($, id, 'did not run: the next turn started first')
  }
  const reply = await $.model.fork({
    prompt: withFinalAnswer(prompt, isOvertaken ? '' : turn?.answer ?? ''),
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
  // The title comes from the vision as this check read it, so drawing the
  // row reads no file.
  const title =
    parsed?.verdict === 'deviation' ? invariantTitle(vision.text, parsed.reference) : undefined
  const now = await $.clock.now()
  let outcome = ''
  let shown: CourseKeeperAlert | undefined
  await change($, id, r => {
    // A check that took longer than CHECK_STALE_MS lost its in-flight mark,
    // and a newer check may have started and shown its own alert since.
    // The status keeps the newer check's outcome.
    if (r.checkingSince !== started) {
      outcome = 'did not run: a newer check replaced this one'
      shown = undefined

      return r
    }
    // `/course-keeper off` may have come during the fork. A check that a
    // turn started shows nothing; one the person asked for applies its reply.
    if (trigger === 'turn' && r.isOff) {
      const done = withOutcome(r, 'did not run: checks are off', now)
      outcome = done.outcome
      shown = undefined

      return done.record
    }
    const done = applyReply(r, parsed, now, title)
    outcome = done.outcome
    shown = done.shown

    return done.record
  })
  if (shown !== undefined) {
    try {
      await $.ui.notify(shown.alert, { title: alertHeadline(shown) })
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
  // in such a project Course Keeper sends nothing to any model.
  if ((await readVision($)) === undefined) return

  const template = await readPrompt($, 'extract')
  const { record: beforeCall } = await load($, id)
  const reply = await $.model.complete({
    model: 'haiku',
    prompt: fillExtractPrompt(template, text),
  })
  if (!reply.isAnswered) return
  const candidates = parseExtractReply(reply.text)
  if (candidates.length === 0) return

  let added: string[] = []
  await change($, id, r => {
    // `/course-keeper forget` during the call wins: an instruction withdrawn
    // since then is neither added again nor taken off the withdrawn list.
    // `removeWithdrawn(a, b)` is list a without the entries equal to one in b.
    const since = removeWithdrawn(r.withdrawn ?? [], beforeCall.withdrawn ?? [])
    const stated = removeWithdrawn(candidates, since)
    const done = addInstructions(r.instructions, stated)
    added = done.added
    // An instruction the person states again is no longer withdrawn, also
    // when the list is full and it was not added.
    const before = r.withdrawn ?? []
    const withdrawn = removeWithdrawn(before, stated)

    return added.length === 0 && withdrawn.length === before.length
      ? r
      : { ...r, instructions: done.list, withdrawn }
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

      return statusText(
        held,
        vision?.path,
        vision?.antiPatterns?.path,
        vision?.names ?? files,
        vision?.namedInVision,
      )
    }
    case 'check':
      return `Check finished: ${await check($, 'command')}.`
    case 'off':
      await change($, id, r => (r.isOff ? r : { ...r, isOff: true }))
      // The answer waits for the store, so a quit right after keeps the change.
      await saving

      return 'Course Keeper checks are off for this session.'
    case 'on':
      await change($, id, r => (r.isOff ? { ...r, isOff: false } : r))
      await saving

      return 'Course Keeper checks are on for this session.'
    case 'learn':
      return learn($, args.trim().slice(verb.length).trim()).catch(
        () => 'Course Keeper could not finish the learn step.',
      )
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
      await saving

      return removed === undefined
        ? `No standing instruction ${rest[0] ?? ''}. ${USAGE}`
        : `Standing instruction ${rest[0]} removed: "${removed}"`
    }
    default:
      return USAGE
  }
}

const NO_DRAFT =
  'No draft sentence waits for an answer. Run /course-keeper learn first.'
const REPLACED = 'A newer learn request replaced this one.'

/**
 * `/course-keeper learn`: drafts one sentence for VISION.md from the agent's
 * failing reply (`<words>` or none), tests a draft (`yes`) or drops it
 * (`cancel`). It never writes VISION.md and sends nothing to the agent. It
 * does not touch the check's in-flight mark, alerts or outcome.
 */
async function learn($: $, words: string): Promise<string> {
  // Read before the first wait, as a check reads it.
  const turn = endedTurn
  const id = await $.session.id()
  const verb = words.toLowerCase()

  if (verb === 'cancel') {
    // Cancel also clears the in-flight mark. A learn step in flight then
    // keeps nothing and makes no further calls.
    const now = await $.clock.now()
    let had = false
    let wasRunning = false
    await change($, id, r => {
      had = r.learn !== undefined
      wasRunning = isCheckRunning(r.learningSince ?? null, now)
      const rest = withoutDraft(r)

      return (r.learningSince ?? null) === null ? rest : { ...rest, learningSince: null }
    })
    await saving

    if (had) return 'The draft sentence is dropped.'

    return wasRunning ? 'The learn step in flight is cancelled.' : NO_DRAFT
  }
  if (verb === 'yes' && (await load($, id)).record.learn === undefined) return NO_DRAFT

  const vision = await readVision($)
  if (vision === undefined) {
    return `No ${files.vision} found. /course-keeper learn does not run without it.`
  }

  // At most one learn step in flight per session, as for the check, with its
  // own mark; a mark older than CHECK_STALE_MS counts as lost.
  const started = await $.clock.now()
  let isBusy = false
  await change($, id, r => {
    isBusy = isCheckRunning(r.learningSince ?? null, started)

    return isBusy ? r : { ...r, learningSince: started }
  })
  if (isBusy) return 'A learn step is already running in this session. Wait for its answer.'

  try {
    return verb === 'yes'
      ? await testDraft($, id, vision, started)
      : await makeDraft($, id, fieldOf(vision), words, turn, started)
  } catch {
    return 'Course Keeper could not finish the learn step: a prompt file or a call failed.'
  } finally {
    await change($, id, r =>
      r.learningSince === started ? { ...r, learningSince: null } : r,
    ).catch(() => undefined)
  }
}

/**
 * True while the learn step that started at `started` holds the in-flight
 * mark. A plain read can show the record as this dispatch last saw it, so
 * the record is written back when it looks owned: a write that another
 * write beat reads the record again.
 */
async function ownsMark($: $, id: string, started: number): Promise<boolean> {
  let isOwn = false
  await change($, id, r => {
    isOwn = r.learningSince === started

    return isOwn ? { ...r } : r
  })

  return isOwn
}

/** Step one: a fork drafts the sentence; its quote must be the agent's. */
async function makeDraft(
  $: $,
  id: string,
  vision: string,
  words: string,
  turn: { turnId: string; answer: string } | undefined,
  started: number,
): Promise<string> {
  // A new request replaces a draft the person did not accept.
  await change($, id, withoutDraft)
  const template = await readPrompt($, 'learn')
  // As for a check: the fork's last request does not hold the agent's final
  // answer to it, so the answer goes before the prompt. When the next turn
  // started since, the fork's last request is that turn's, and no answer is
  // added. Nothing waits between this test and the fork.
  const isOvertaken =
    turn !== undefined && startedTurn !== undefined && startedTurn !== turn.turnId
  const reply = await $.model.fork({
    prompt: withFinalAnswer(
      fillLearnPrompt(template, { vision, catch: catchText(words) }),
      isOvertaken ? '' : turn?.answer ?? '',
    ),
  })
  if (!reply.isAnswered) {
    return reply.reason === 'nothing-to-fork'
      ? 'No sentence drafted: there is nothing in the session to fork yet.'
      : `No sentence drafted: the fork ended with ${reply.reason}.`
  }

  const parsed = parseLearnReply(reply.text)
  if (parsed === undefined) {
    return `No sentence drafted: the draft reply was malformed.\n${GIVE_WORDS}`
  }
  if (parsed.result === 'none') {
    return `No sentence drafted: ${parsed.reason || 'the draft gave no reason.'}\n${GIVE_WORDS}`
  }
  // The quote must stand word for word in one of the agent's replies, or
  // nothing of the draft is shown.
  const rows = await $.session.messages()
  const at = failingRow(rows, parsed.quote)
  if (at < 0) {
    return (
      "The draft quoted words that are not in the agent's replies, so it is not shown. " +
      `Run /course-keeper learn again, or give the act in words.\n${GIVE_WORDS}`
    )
  }
  // The draft keeps the failing turn by its person message, so a later
  // reply that repeats the quote does not move it.
  const personCount = personCountAt(rows, turnOf(rows, at).start)

  let model = ''
  try {
    model = await $.session.model()
  } catch {
    // The report then names the session's model without its name.
  }
  const draft = draftOf(parsed, await $.clock.now(), model, personCount)
  // A request that took longer than CHECK_STALE_MS lost its in-flight mark,
  // and a newer request may have saved its own draft since.
  let isOwn = false
  await change($, id, r => {
    isOwn = r.learningSince === started

    return isOwn ? { ...r, learn: draft } : r
  })
  await saving

  return isOwn ? draftText(draft) : REPLACED
}

/**
 * Step two: excerpt checks of the corrected turn and of earlier turns, with
 * today's vision and with the sentence added. Each one is a separate call
 * on the session's model.
 */
async function testDraft(
  $: $,
  id: string,
  read: Vision,
  started: number,
): Promise<string> {
  // Today's vision as the prompts get it, with the anti-patterns file when there is one.
  const vision = fieldOf(read)
  const { record: held } = await load($, id)
  const draft = held.learn
  if (draft === undefined) return NO_DRAFT
  // Drops the draft and answers `text`. A request that took longer than
  // CHECK_STALE_MS lost its in-flight mark: a newer request owns the draft
  // now, so this one changes nothing and says so.
  const drop = async (text: string): Promise<string> => {
    let isOwn = false
    await change($, id, r => {
      isOwn = r.learningSince === started

      return isOwn && r.learn?.draftedAt === draft.draftedAt ? withoutDraft(r) : r
    })
    await saving

    return isOwn ? text : REPLACED
  }

  // The turn that starts at the draft's person message, as the draft found it.
  const rows = await $.session.messages()
  const failing = failingTurnAt(rows, draft.personCount, draft.quote)
  if (failing === undefined) {
    return drop(
      'The turn you corrected is no longer in the session (a compaction can remove it). ' +
        'The draft is dropped; nothing is kept.',
    )
  }
  const added = addDraftSentence(read.text, read.antiPatterns?.text, draft.place, draft.sentence)
  // The excerpt leaves out the middle of a long turn. When the agent's words
  // fall there, no check can see them, and no model is called. Only the
  // agent's rows count: the person can repeat the words in a message.
  if (!excerptKeepsQuote(rows, failing, draft.quote)) {
    const version = await pluginVersion($)

    return drop(
      untestedReport({
        draft,
        target: added.target,
        isNew: added.isNew,
        inAntiPatterns: added.inAntiPatterns,
        names: read.names,
        version,
      }),
    )
  }

  let model: string
  try {
    model = await $.session.model()
  } catch {
    return (
      "The test could not run: Course Keeper could not read the session's model. " +
      'The draft still waits; run /course-keeper learn yes again.'
    )
  }
  const [template, head] = await Promise.all([
    readPrompt($, 'check'),
    readPrompt($, 'excerpt-head'),
  ])
  // No standing instructions: the list held now can hold one that the
  // person's correction created. The person's messages in each excerpt
  // show what was in force at that turn. The withdrawn instructions go in,
  // so the check does not enforce them from those messages again.
  const instructions = formatInstructions([], held.withdrawn)
  const ask = async (turn: Turn, text: string): Promise<ExcerptResult> => {
    const prompt = excerptCheckPrompt(
      template,
      head,
      { vision: text, instructions },
      sessionExcerpt(rows, turn),
    )
    try {
      const reply = await $.model.complete({ model, prompt, maxTokens: 2000 })
      if (!reply.isAnswered) {
        return { kind: 'no result', reason: `the call ended with ${reply.reason}` }
      }
      const parsed = parseCheckReply(reply.text)

      return parsed === undefined
        ? { kind: 'no result', reason: 'the reply was malformed' }
        : { kind: 'reply', reply: parsed }
    } catch {
      return { kind: 'no result', reason: 'the call failed' }
    }
  }

  // The vision covers the act only when today's check alerts on the
  // invariant that the sentence would join. An alert on another invariant
  // or an instruction is another matter of the same turn: the test goes on.
  const control = await ask(failing, vision)
  // A cancel or a newer request since the start: no more calls.
  if (!(await ownsMark($, id, started))) return REPLACED
  if (
    control.kind === 'reply' &&
    control.reply.verdict === 'deviation' &&
    !added.isNew &&
    alertsOn(control, added.target)
  ) {
    return drop(coveredText(control.reply))
  }

  const earlier = earlierTurns(rows, failing)
  const [verify, ...withSentence] = await Promise.all([
    ask(failing, added.text),
    ...earlier.map(turn => ask(turn, added.text)),
  ])
  // An earlier turn's alert counts as new only when today's vision is silent there.
  const found = await Promise.all(
    withSentence.map(async (result, k): Promise<{ alert?: string; missing?: string }> => {
      const turn = earlier[k]
      if (result.kind === 'no result') return { missing: result.reason }
      if (turn === undefined || !alertsOn(result, added.target)) return {}
      const today = await ask(turn, vision)
      if (today.kind === 'no result') return { missing: today.reason }
      if (today.reply.verdict !== 'none' || result.reply.verdict !== 'deviation') return {}

      return { alert: result.reply.evidence }
    }),
  )
  const tested: EarlierTest = {
    tested: earlier.length,
    newAlerts: found.flatMap(f => (f.alert === undefined ? [] : [f.alert])),
    noResults: found.flatMap(f => (f.missing === undefined ? [] : [f.missing])),
  }

  const version = await pluginVersion($)

  return drop(
    learnReport({
      draft,
      target: added.target,
      isNew: added.isNew,
      control,
      verify: verify ?? { kind: 'no result', reason: 'the call failed' },
      earlier: tested,
      version,
      inAntiPatterns: added.inAntiPatterns,
      names: read.names,
    }),
  )
}

/** The plugin's version from its manifest, or undefined when it cannot be read. */
async function pluginVersion($: $): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(
      await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`),
    )
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest
        ? manifest.version
        : undefined

    return typeof version === 'string' && clean(version, 40) !== ''
      ? clean(version, 40)
      : undefined
  } catch {
    return undefined
  }
}

/** The widest the alert's frame is drawn, in cells. */
const MAX_ROW_WIDTH = 100

/**
 * About how many rows the alert's frame takes with its empty lines, at
 * `width` cells: an empty line above and below, the two rules, the rule line, each part's empty line
 * (`space` rows) and its heading and text wrapped together, and the actions.
 */
function frameRows(
  width: number,
  top: string,
  ruleText: string | undefined,
  parts: readonly string[],
  space: number,
): number {
  const text = Math.max(width - 4, 10)
  // The top rule's words and the rule line wrap in a narrow band too.
  const topRows = Math.ceil(top.length / width)
  const ruleRows = ruleText === undefined ? 0 : Math.ceil(ruleText.length / text)
  // An empty line, then the heading (at most 27 cells) and the text.
  const body = parts.reduce(
    (rows, part) => rows + space + Math.ceil((part.length + 27) / text),
    0,
  )
  const actions = space + Math.ceil(75 / width)

  // The empty lines above and below the frame, the rules and the rule line.
  return 2 * space + topRows + 1 + ruleRows + body + actions
}

/**
 * "False alarm": the first press asks for a second one, the second records
 * the answer. A false alarm tells later checks to skip the deviation, so one
 * stray key does not record it.
 */
async function falseAlarm($: $, id: string, shownAt: number) {
  return change($, id, r => {
    if (r.current?.shownAt !== shownAt) return r

    return r.confirmFalseAlarm === true
      ? answerCurrent(r, 'intended')
      : { ...r, confirmFalseAlarm: true }
  })
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
  $.ui.toast('Course Keeper could not send the note to the agent. The alert is shown again.')
}

export const register: Register = (on, options) => {
  files = fileNames(options)
  on('session.start', async ($, e, next) => {
    try {
      // A literal name, so that validate reads the command.run hook below as
      // answering its own command.
      await $.command.register({
        name: 'course-keeper',
        description:
          'Course Keeper: show the vision, standing instructions and alerts',
        argumentHint:
          '[check | forget <n> | off | on | learn [yes | cancel | <what went wrong>]]',
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
        // Not awaited: the prompt does not wait for Course Keeper.
        void notePrompt(
          $,
          entered.text,
          e.command !== undefined,
          e.isMeta === true,
        ).catch(() => undefined)
      }
    } catch {
      // Ignore: Course Keeper never holds up a prompt.
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
      // Ignore: Course Keeper never holds up a turn.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    let passed = e
    try {
      if (e.agentId === undefined) {
        const { record: held } = await load($, await $.session.id())
        const instructions = compactInstructions(e.instructions, held.instructions)
        // Without a vision Course Keeper does nothing in the project.
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
    text: 'Course Keeper could not run that command.',
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
          // The frame is at most MAX_ROW_WIDTH cells wide, so that long
          // sentences wrap at a reading width.
          const width = Math.max(Math.min(e.props.bodyColumns, MAX_ROW_WIDTH), 20)
          const banner = alertBanner(shown)
          const rule = alertRule(shown)
          const confirming = held.confirmFalseAlarm === true
          // `── ▲ <banner> · Course Keeper ───…`, as one line of Texts.
          const titled = `▲ ${banner} · Course Keeper`
          const fill = ' ' + ruleLine(width - `── ${titled} `.length)
          // Text between the plain Buttons only separates them: it takes no
          // focus, and each Button keeps its hotkey.
          const dot = <Text dimColor> · </Text>
          const parts = [
            shown.alert,
            shown.instead ?? '',
            shown.evidence,
            held.showDetails ? shown.note : '',
          ].filter(text => text !== '')
          // A Button scrolled out of view does not answer its hotkey. When the
          // frame would not fit the band it drops its empty lines; when it
          // still would not fit, the buttons move into its first line.
          const rows = (space: number) =>
            frameRows(
              width,
              `── ▲ ${banner} · Course Keeper ──`,
              rule === undefined ? undefined : `${rule.label}: "${rule.words}"`,
              parts,
              space,
            )
          const space = rows(1) > e.props.maxRows ? 0 : 1
          const actionsFirst = rows(0) > e.props.maxRows
          // A heading in bold and its text on the same line, wrapped at the
          // frame's width.
          const part = (key: string, heading: string, body: string, dim?: true) => (
            <Box key={key} marginTop={space}>
              <Text>
                <Text bold>{heading}:</Text>{' '}
                <Text dimColor={dim}>{body}</Text>
              </Text>
            </Box>
          )
          // In the tightest band the first line holds the buttons, after a
          // short name of what the session breaks, so their keys answer.
          const short = /^instruction "/.test(shown.reference)
            ? 'Your instruction'
            : shown.reference.replace(/^invariant/, 'Invariant')
          const actions = (
            <Box flexDirection="row" flexWrap="wrap" marginTop={actionsFirst ? 0 : space}>
              {actionsFirst && <Text color="warning">▲ </Text>}
              {actionsFirst && <Text bold>{short}</Text>}
              {actionsFirst && <Text dimColor> · </Text>}
              <Button
                key="tell"
                plain
                hotkey="1"
                label="Tell the agent"
                autoFocus
                onPress={() => tell($, id, at).catch(() => undefined)}
              />
              {dot}
              <Button
                key="details"
                plain
                hotkey="2"
                label="Details"
                onPress={() =>
                  change($, id, r =>
                    r.current?.shownAt === at
                      ? { ...r, showDetails: !r.showDetails }
                      : r,
                  ).catch(() => undefined)
                }
              />
              {dot}
              <Button
                key="false-alarm"
                plain
                hotkey="3"
                label={confirming ? 'Confirm false alarm' : 'False alarm'}
                onPress={() =>
                  falseAlarm($, id, at).catch(() => undefined)
                }
              />
              {dot}
              <Button
                key="dismiss"
                plain
                hotkey="4"
                label="Dismiss"
                role="dismiss"
                onPress={() =>
                  answer($, id, at, 'dismissed').catch(() => undefined)
                }
              />
              <Text dimColor> · ctrl+x tab</Text>
            </Box>
          )
          tree = (
            <Box flexDirection="column" width={width} marginTop={space} marginBottom={space}>
              {actionsFirst ? (
                actions
              ) : (
                <Box flexDirection="row">
                  <Text dimColor>── </Text>
                  <Text color="warning">▲ </Text>
                  <Text bold>{banner}</Text>
                  <Text dimColor> · Course Keeper{fill}</Text>
                </Box>
              )}
              <Box flexDirection="column" paddingLeft={2}>
                {rule !== undefined && (
                  <Box flexDirection="row">
                    <Text>{rule.label}: </Text>
                    <Text bold>"{rule.words}"</Text>
                  </Box>
                )}
                {part('doing', 'What your agent is doing', shown.alert)}
                {shown.instead !== undefined &&
                  shown.instead !== '' &&
                  part('instead', 'What it should do instead', shown.instead)}
                {shown.evidence !== '' &&
                  part('quote', 'Quote', `"${shown.evidence}"`, true)}
                {held.showDetails &&
                  part('note', 'For the agent', shown.note, true)}
                {!actionsFirst && actions}
              </Box>
              <Text dimColor>{ruleLine(width)}</Text>
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
