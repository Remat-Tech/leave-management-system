/** Database access for what people have been told. FR 59, §7.1., LMS 329. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { NotificationTable } from '../../db/schema.js';
import type { Undelivered } from './delivery.js';
import type { NewNotice, Notice, NoticeEvent } from './notification.js';
import { REMINDER_EVENT, type ReminderSent } from './reminder.js';

type NoticeRow = Selectable<NotificationTable>;

/** What a caller narrows a list of notices by. */
export interface NoticeListOptions {
  /** FR 59's bell. */
  unreadOnly?: boolean;
  /** How many, newest first. */
  limit?: number;
}

/** What became of one attempt to send a notice. LMS 331. */
export type EmailOutcome =
  | { attempt: number; sentAt: Date }
  | {
      attempt: number;
      failedBecause: string;
      /** When to try again, null where that was the last attempt. */
      tryAgainAt: Date | null;
      /** The moment the attempt failed, stamped as the giving up where there is no next. */
      at: Date;
    };

export class NotificationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes one notice. */
  async write(notice: NewNotice): Promise<Notice> {
    const row = await this.db
      .insertInto('notification')
      .values(rowFor(notice))
      .returningAll()
      .executeTakeFirstOrThrow();

    return toNotice(row);
  }

  /** Stamps what became of one attempt at the email. FR 59, LMS 331. */
  async recordTheEmail(id: string, outcome: EmailOutcome): Promise<Notice | undefined> {
    const row = await this.db
      .updateTable('notification')
      .set(
        'sentAt' in outcome
          ? {
              emailed_at: outcome.sentAt,
              email_attempts: outcome.attempt,
              email_next_attempt_at: null,
            }
          : {
              email_failure: outcome.failedBecause,
              email_attempts: outcome.attempt,
              email_next_attempt_at: outcome.tryAgainAt,
              email_gave_up_at: outcome.tryAgainAt === null ? outcome.at : null,
            },
      )
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toNotice(row);
  }

  /**
   * Notices whose email is due another try, oldest due first. FR 59, LMS 331.
   *
   * The address is joined rather than stored on the notice, so a corrected work address is
   * the one a retry goes to. Read only — {@link claimForAnotherTry} is what takes one.
   */
  async dueForAnotherTry(asAt: Date, limit: number): Promise<Undelivered[]> {
    const rows = await this.db
      .selectFrom('notification')
      .innerJoin('employee', 'employee.id', 'notification.employee_id')
      .selectAll('notification')
      .select('employee.work_email as to')
      .where('email_next_attempt_at', 'is not', null)
      .where('email_next_attempt_at', '<=', asAt)
      .orderBy('email_next_attempt_at')
      .limit(limit)
      .execute();

    return rows.map(({ to, ...row }) => ({ notice: toNotice(row), to }));
  }

  /**
   * Takes one due notice, counting the attempt and scheduling the one after it. LMS 331.
   *
   * Claimed before the send rather than after, so a process that dies mid-send leaves a
   * notice that comes due again rather than one nobody will ever look at. `seenAttempts` is
   * what makes two runs safe: the second finds the count already moved and gets nothing.
   */
  async claimForAnotherTry(
    id: string,
    seenAttempts: number,
    tryAgainAt: Date | null,
  ): Promise<Notice | undefined> {
    const row = await this.db
      .updateTable('notification')
      .set({ email_attempts: seenAttempts + 1, email_next_attempt_at: tryAgainAt })
      .where('id', '=', id)
      .where('email_attempts', '=', seenAttempts)
      .where('email_next_attempt_at', 'is not', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toNotice(row);
  }

  /** How many notices are waiting on another try. LMS 331. */
  async howManyAreDue(asAt: Date): Promise<number> {
    const row = await this.db
      .selectFrom('notification')
      .select(({ fn }) => fn.countAll<string>().as('due'))
      .where('email_next_attempt_at', 'is not', null)
      .where('email_next_attempt_at', '<=', asAt)
      .executeTakeFirstOrThrow();

    return Number(row.due);
  }

  /** Marks a notice read, or puts it back to unread. FR 59. */
  async markRead(id: string, at: Date | null): Promise<Notice | undefined> {
    const row = await this.db
      .updateTable('notification')
      .set({ read_at: at })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toNotice(row);
  }

  async findById(id: string): Promise<Notice | undefined> {
    const row = await this.db
      .selectFrom('notification')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toNotice(row);
  }

  /** What one person has been told, newest first. */
  async forEmployee(employeeId: string, options: NoticeListOptions = {}): Promise<Notice[]> {
    let query = this.db
      .selectFrom('notification')
      .selectAll()
      .where('employee_id', '=', employeeId);

    if (options.unreadOnly === true) {
      query = query.where('read_at', 'is', null);
    }

    query = query.orderBy('id', 'desc');

    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }

    return (await query.execute()).map(toNotice);
  }

  /** How many this person has not seen. FR 59. */
  async unreadCountFor(employeeId: string): Promise<number> {
    const row = await this.db
      .selectFrom('notification')
      .select(({ fn }) => fn.countAll<string>().as('unread'))
      .where('employee_id', '=', employeeId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();

    return Number(row.unread);
  }

  /**
   * Who has already been reminded about which request since then. FR 50, LMS 330.
   *
   * What stops a second run in one day chasing everybody twice. Read across everybody
   * rather than per request, because the job asks it once a morning.
   */
  async remindersSince(since: Date): Promise<ReminderSent[]> {
    const rows = await this.db
      .selectFrom('notification')
      .select(['employee_id', 'leave_request_id'])
      .where('event', '=', REMINDER_EVENT)
      .where('created_at', '>=', since)
      .execute();

    return rows.map((row) => ({
      employeeId: row.employee_id,
      leaveRequestId: row.leave_request_id,
    }));
  }

  /** Everything one request has been told about, oldest first. */
  async forRequest(leaveRequestId: string): Promise<Notice[]> {
    const rows = await this.db
      .selectFrom('notification')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toNotice);
  }
}

/** The row to write. */
function rowFor(notice: NewNotice): Insertable<NotificationTable> {
  return {
    employee_id: notice.employeeId,
    leave_request_id: notice.leaveRequestId,
    event: notice.event,
    subject: notice.subject,
    body: notice.body,
  };
}

function toNotice(row: NoticeRow): Notice {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveRequestId: row.leave_request_id,
    event: row.event as NoticeEvent,
    subject: row.subject,
    body: row.body,
    readAt: row.read_at,
    emailedAt: row.emailed_at,
    emailFailure: row.email_failure,
    emailAttempts: row.email_attempts,
    emailNextAttemptAt: row.email_next_attempt_at,
    emailGaveUpAt: row.email_gave_up_at,
    createdAt: row.created_at,
  };
}
