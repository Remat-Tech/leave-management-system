/** Database access for what people have been told. FR 59, §7.1., LMS 329. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { NotificationTable } from '../../db/schema.js';
import type { NewNotice, Notice, NoticeEvent } from './notification.js';

type NoticeRow = Selectable<NotificationTable>;

/** What a caller narrows a list of notices by. */
export interface NoticeListOptions {
  /** FR 59's bell. */
  unreadOnly?: boolean;
  /** How many, newest first. */
  limit?: number;
}

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

  /** Stamps what became of the email. FR 59. */
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
    createdAt: row.created_at,
  };
}
