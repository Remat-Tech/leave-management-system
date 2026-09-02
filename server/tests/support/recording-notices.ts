/**
 * A notice log that keeps what it is given, for a test to read back. FR 59. LMS 329.
 *
 * The counterpart of ./recording-denials.ts and ./recording-mailer.ts, and here for the
 * same reason both of those exist: `NotificationService.tell` cannot throw — by the time it
 * runs the leave has already been approved — so the *only* record of a notice that never
 * reached anybody is this log. "It is recorded" is only an assertion if something can be
 * asked what it was told, and asserting on stderr would mean intercepting `console.error`,
 * which is a global other tests share.
 *
 * Deliberately not a mock. `record` is the whole of the {@link NoticeLog} interface and
 * nothing here pretends.
 */

import type { NoticeLog, UndeliveredNotice } from '../../src/services/notification-service.js';

export interface RecordingNoticeLog extends NoticeLog {
  /** Everything that failed to reach somebody, in the order it happened. */
  readonly failures: UndeliveredNotice[];
  last(): UndeliveredNotice | undefined;
  clear(): void;
}

export function recordingNotices(): RecordingNoticeLog {
  const failures: UndeliveredNotice[] = [];

  return {
    failures,
    record(failure) {
      failures.push(failure);
    },
    last() {
      return failures.at(-1);
    },
    clear() {
      failures.length = 0;
    },
  };
}
