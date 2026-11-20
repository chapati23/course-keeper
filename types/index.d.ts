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
}

declare module 'claude-code' {
  interface PluginState {
    'course-keeper': { session: StateFamily<CourseKeeperSession> }
  }
}
