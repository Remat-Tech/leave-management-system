/**
 * A denial log that keeps what it is given, for a test to read back. LMS 112.
 *
 * The counterpart of ./recording-mailer.ts, and here for the same reason: the
 * story's third criterion is that refused attempts are logged, and "logged" is
 * only testable if something can be asked what it was told. Asserting on stderr
 * would mean intercepting `console.error`, which is a global that other tests
 * share.
 *
 * It is deliberately not a mock. Every method is real, `record` is the whole of
 * the {@link DenialLog} interface, and nothing about it pretends: it is the
 * driver a test wants, exactly as the local filesystem driver is the one
 * development wants.
 */

import type { DeniedAttempt, DenialLog } from '../../src/auth/denials.js';

export interface RecordingDenialLog extends DenialLog {
  /** Every refusal, in the order it happened. */
  readonly entries: DeniedAttempt[];
  /** The most recent one, or undefined if nothing has been refused. */
  last(): DeniedAttempt | undefined;
  /** Forget everything. For a `beforeEach`. */
  clear(): void;
}

export function recordingDenials(): RecordingDenialLog {
  const entries: DeniedAttempt[] = [];

  return {
    entries,
    record(attempt) {
      entries.push(attempt);
    },
    last() {
      return entries.at(-1);
    },
    clear() {
      entries.length = 0;
    },
  };
}
