// The values course keeper keeps in `$.state`, one record per session id.
// Old records can hold other shapes: the module validates every read
// (normalizeRecord in hooks/logic.ts).

/** The person's answer to an alert. */
export type CourseKeeperAnswer =
  | 'intended'
  | 'told the agent'
  | 'dismissed'
  | 'replaced by a newer alert'

/** One alert shown to the person, with the person's answer once given. */
export type CourseKeeperAlert = {
  /** `invariant <number>` or `instruction "<the person's words>"`. */
  reference: string
  /** One sentence: what the session does, and what that contradicts. */
  alert: string
  /** A short quote from the agent's text or action. */
  evidence: string
  /** The text for the agent, sent only when the person asks. */
  note: string
  /** When the alert was shown, in milliseconds since the epoch. */
  shownAt: number
  /** The person's answer; null while the alert is still shown. */
  answer: CourseKeeperAnswer | null
}

/** The result of the last check, or why it did not run. */
export type CourseKeeperCheck = {
  at: number
  outcome: string
}

/**
 * A draft sentence for VISION.md that `/course-keeper learn` made and that
 * waits for the person's `/course-keeper learn yes`.
 */
export type CourseKeeperDraft = {
  /** The agent's words that show the act; found in the agent's replies. */
  quote: string
  /** One plain sentence: what the agent did. */
  act: string
  /** The forms the act can take, as the draft listed them. */
  forms: string
  /** The draft's variant of the act. */
  variant: string
  /** `invariant <number>` or `new`. */
  place: string
  /** The sentence; it starts with "Never". */
  sentence: string
  /** One sound act close to the forbidden one that the sentence allows. */
  allowed: string
  /** When the draft was made, in milliseconds since the epoch. */
  draftedAt: number
  /** The session's model when the draft was made, as `/model` shows it. */
  model: string
  /**
   * The number of person messages up to and including the first row of the
   * failing turn; 0 for the rows before the first person message.
   * `/course-keeper learn yes` tests the turn that starts at this person
   * message, so a later reply that repeats the quote does not move the turn.
   * A stored draft without a whole number here of 0 or more is dropped.
   */
  personCount: number
}

/** Everything course keeper keeps for one session. */
export type CourseKeeperSession = {
  /** The record's shape version. */
  v: 1
  /** True once a person has typed a prompt in the session. */
  hasPerson: boolean
  /** True after `/course-keeper off`. */
  isOff: boolean
  /** The session's standing instructions, oldest first. */
  instructions: string[]
  /**
   * Standing instructions the person removed with `/course-keeper forget`,
   * oldest first; the check is told not to enforce them. Absent in a record
   * written before this field existed.
   */
  withdrawn?: string[]
  /** Alerts shown earlier in the session, with the person's answers. */
  alerts: CourseKeeperAlert[]
  /** The alert shown now, if any. */
  current: CourseKeeperAlert | null
  /** True while the person has opened the evidence and the note. */
  showDetails: boolean
  lastCheck: CourseKeeperCheck | null
  /**
   * When the check in flight started, in milliseconds since the epoch; null
   * when none runs. Kept here, not in a module variable, so that a hot
   * reload does not let a second check start beside the first.
   */
  checkingSince: number | null
  /**
   * When the learn step in flight started, in milliseconds since the epoch.
   * Absent or null when none runs, and in a record written before it existed.
   */
  learningSince?: number | null
  /**
   * The draft that waits for `/course-keeper learn yes`. Absent when there is
   * none, and in a record written before it existed.
   */
  learn?: CourseKeeperDraft
}

declare module 'claude-code' {
  interface PluginState {
    'course-keeper': { session: StateFamily<CourseKeeperSession> }
  }
}
