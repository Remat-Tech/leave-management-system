/**
 * Database access for what people have been told. FR 59, §7.1. LMS 329.
 *
 * Queries and row mapping, nothing else. What a notice says is ../domain/notification.ts;
 * who may read one is ../auth/notification-policy.ts; when one is written is
 * ../services/notification-service.ts, which writes it **after** the transaction that moved
 * the request has committed.
 *
 * ## No `recording()`, and that absence is a decision rather than an omission
 *
 * Every other repository that writes goes through it, because the table it writes to is
 * either audited or has a trigger that stamps the writer from the transaction's settings.
 * `notification` is neither — the migration declines the audit trigger and argues why — so
 * `recording()` here would open a transaction to set a name nothing reads.
 *
 * That is not merely wasteful. The whole point of this table is that its rows are written
 * outside the transaction that caused them, and a repository that opened one per write
 * would be the seam a future change quietly ran the send inside.
 *
 * ## There is no update method, and there are two stamps
 *
 * `lms_app` holds UPDATE on three columns and no others — `read_at`, `emailed_at` and
 * `email_failure` — and `refuse_rewriting_a_notice()` refuses the rest on the owner
 * connection too. So the writes here are exactly those three, each one named for what it
 * is: {@link NotificationRepository.markRead}, and the two halves of
 * {@link NotificationRepository.recordTheEmail}.
 *
 * There is no `reword` and no `delete`. Both would be methods that always throw, which is
 * a worse way of saying so than not having one — the same shape ./leave-decision-repository.ts
 * has for the same reason.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { NotificationTable } from '../db/schema.js';
import type { NewNotice, Notice, NoticeEvent } from '../domain/notification.js';

type NoticeRow = Selectable<NotificationTable>;

/** What a caller narrows a list of notices by. */
export interface NoticeListOptions {
  /** FR 59's bell. Only the ones the person has not seen. */
  unreadOnly?: boolean;
  /** How many, newest first. A screen shows a page and not a year. */
  limit?: number;
}

export class NotificationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes one notice. The only inserter this table has.
   *
   * The row lands before the email is attempted, which is the order the whole feature turns
   * on and is argued in ../services/notification-service.ts: the in-app notice is the
   * record, and the email is a delivery of it. Written the other way round, a mail server
   * that accepted the message and a database that then refused the row would leave somebody
   * holding an email about leave their account cannot show them.
   */
  async write(notice: NewNotice): Promise<Notice> {
    const row = await this.db
      .insertInto('notification')
      .values(rowFor(notice))
      .returningAll()
      .executeTakeFirstOrThrow();

    return toNotice(row);
  }

  /**
   * Stamps what became of the email. FR 59.
   *
   * One method for both outcomes rather than `markSent` and `markFailed`, because they are
   * one fact with two values and the table holds them as a pair —
   * `notification_email_went_or_did_not` refuses a row claiming both. A caller that had to
   * pick a method could call neither, and a notice that never recorded an outcome is
   * indistinguishable from one whose send is still in flight.
   *
   * Stamped once. `refuse_rewriting_a_notice()` refuses a second, so a retry is a new notice
   * rather than an overwritten one — which keeps "what did this person actually receive, and
   * when" answerable.
   */
  async recordTheEmail(
    id: string,
    outcome: { sentAt: Date } | { failedBecause: string },
  ): Promise<Notice | undefined> {
    const row = await this.db
      .updateTable('notification')
      .set(
        'sentAt' in outcome
          ? { emailed_at: outcome.sentAt }
          : { email_failure: outcome.failedBecause },
      )
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toNotice(row);
  }

  /**
   * Marks a notice read, or puts it back to unread. FR 59's in-app half.
   *
   * `at` is the caller's rather than `now()` in the statement, which is the opposite of the
   * discipline `leave_request_decision` keeps about `decided_at` — and the difference is
   * what the column is for. A decider must not be able to date their own decision; a person
   * marking their own post read is not making a record anybody will dispute, and the same
   * value is what the caller returns to a screen.
   *
   * Null puts it back to unread, which is an ordinary thing to want and is why the trigger
   * lets this column move in both directions.
   */
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

  /**
   * What one person has been told, newest first.
   *
   * Newest first, which is the one list in this system ordered that way and is worth the
   * note: a request's decisions are read oldest first because they are the account of how it
   * got where it is, and a person's notices are read newest first because they are post.
   *
   * By `id` rather than by `created_at`, the tie break the decisions and the ledger both
   * make: `now()` is identical across one transaction, and a list that reorders itself
   * between two reads is one nobody can check twice.
   */
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

  /**
   * How many this person has not seen. FR 59's bell.
   *
   * A count rather than the length of a list, because the number is drawn on every page and
   * the list is opened rarely. The partial index `notification_unread_for_employee` is
   * exactly this query.
   */
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
   * Everything one request has been told about, oldest first.
   *
   * Oldest first here and newest first above, and the difference is what each list is: this
   * one sits beside a request's decisions as the account of what its owner was told as it
   * travelled, so it reads in the order those things happened.
   */
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

/**
 * The row to write.
 *
 * The four stamped or defaulted columns are absent — `read_at`, `emailed_at`,
 * `email_failure` and `created_at` — and their absence here is what makes it unmistakable
 * at the call site that a notice is written unread and undelivered, and becomes either
 * afterwards.
 */
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
    createdAt: row.created_at,
  };
}
