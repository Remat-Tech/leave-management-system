/** Retrying a notification whose email did not send. FR 59, §7.1., LMS 331. */

import type { Notice } from './notification.js';

/** How long after the first failed send the second is due. */
export const FIRST_RETRY_AFTER_SECONDS = 60;

/** What each wait is multiplied by for the one after it. */
export const BACKOFF_FACTOR = 5;

/**
 * How many sends one notice gets, the first included.
 *
 * Six, which is 1m + 5m + 25m + 2h05 + 10h25 — a little over thirteen hours, so a mail
 * server that goes down in the evening still delivers before the next working morning.
 */
export const ATTEMPTS_ALLOWED = 6;

/** How long to wait after the nth failed attempt, in seconds. */
export function backoffAfter(attempt: number): number {
  return FIRST_RETRY_AFTER_SECONDS * BACKOFF_FACTOR ** (attempt - 1);
}

/**
 * When the send after this one is due, or null where there is not one. LMS 331.
 *
 * No jitter. Everything due is drained by one job through one mailer, one message at a
 * time, so notices that failed together cannot stampede a mail server on the way back.
 */
export function nextAttemptAfter(attempt: number, at: Date): Date | null {
  if (attempt >= ATTEMPTS_ALLOWED) {
    return null;
  }

  return new Date(at.getTime() + backoffAfter(attempt) * 1000);
}

/** Whether an attempt that fails now is the last one. */
export function wouldGiveUpAfter(attempt: number): boolean {
  return attempt >= ATTEMPTS_ALLOWED;
}

/** One notice whose email is due another try, and where it is to go. */
export interface Undelivered {
  notice: Notice;
  /**
   * The recipient's work address, read now rather than when the notice was composed.
   *
   * A person whose address was wrong when the send failed has a right one by the time it is
   * retried, and the message is the same message either way.
   */
  to: string;
}

/** What became of one drained notice. LMS 331. */
export interface Redelivered {
  noticeId: string;
  employeeId: string;
  attempt: number;
  emailed: boolean;
  /** When the next send is due, null where the retrying is over. */
  tryingAgainAt: Date | null;
  /** True where this was the last attempt and it failed. */
  gaveUp: boolean;
}

/** What one drain did. */
export interface DeliveryRun {
  ranAt: Date;
  /** Everything that was due when the run started. */
  due: number;
  /** Those it got to, claimed and attempted. A run drains at most {@link DRAIN_LIMIT}. */
  attempted: readonly Redelivered[];
  /** Those another run had already claimed. */
  claimedElsewhere: number;
}

/** How many notices one run drains, so a backlog cannot hold the mailer all morning. */
export const DRAIN_LIMIT = 200;

/** What one run did, in a sentence, for the log. NFR USA 03. */
export function summaryOf(run: DeliveryRun): string {
  const sent = run.attempted.filter((one) => one.emailed).length;
  const abandoned = run.attempted.filter((one) => one.gaveUp).length;

  const said =
    `${String(run.due)} undelivered ${run.due === 1 ? 'notice' : 'notices'} due, ` +
    `${String(run.attempted.length)} tried, ${String(sent)} delivered.`;

  return abandoned === 0
    ? said
    : `${said} ${String(abandoned)} gave up after ${String(ATTEMPTS_ALLOWED)} attempts. FR 59.`;
}
