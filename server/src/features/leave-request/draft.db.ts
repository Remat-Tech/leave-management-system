/**
 * Database access for a leave request draft. FR 19, LMS 302.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestDraftTable } from '../../db/schema.js';
import { type DraftContents, InvalidLeaveRequestDraft, type LeaveRequestDraft } from './draft.js';

/** Postgres `check_violation` and `foreign_key_violation`. */
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

/** Which field a refused row is reported against. */
const CHECKED_FIELDS: Record<string, string> = {
  leave_request_draft_ends_after_it_starts: 'to',
  leave_request_draft_reason_not_blank: 'reason',
  leave_request_draft_employee_id_fkey: 'employeeId',
  leave_request_draft_leave_type_id_fkey: 'leaveTypeId',
};

/** What each rule means, in words. Unreachable through the service, which asks first. */
function messageFor(constraint: string): string {
  switch (constraint) {
    case 'leave_request_draft_ends_after_it_starts':
      return 'Leave that ends before it starts is two dates entered the wrong way round.';
    case 'leave_request_draft_reason_not_blank':
      return 'A reason on a draft is a sentence, or it is left out.';
    case 'leave_request_draft_leave_type_id_fkey':
      return 'leaveTypeId does not name a kind of leave that exists.';
    default:
      return `${constraint} refused this draft.`;
  }
}

type LeaveRequestDraftRow = Selectable<LeaveRequestDraftTable>;

export class LeaveRequestDraftRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes a new draft.
   *
   * Not `recording`, because this table has no audit trigger — see the migration. Nothing
   * reads `lms.audit.actor` on this path, so naming the writer would name it to nobody.
   */
  async save(employeeId: string, contents: DraftContents): Promise<LeaveRequestDraft> {
    return this.catchRefusals(async () => {
      const row = await this.db
        .insertInto('leave_request_draft')
        .values(rowFor(employeeId, contents))
        .returningAll()
        .executeTakeFirstOrThrow();

      return toDraft(row);
    });
  }

  /**
   * Replaces what a draft holds, all four fields at once.
   *
   * A whole replacement rather than a patch: a field cleared on the form is a field
   * cleared here, and an absent-means-unchanged update could not express that.
   */
  async replace(id: string, contents: DraftContents): Promise<LeaveRequestDraft | undefined> {
    return this.catchRefusals(async () => {
      const row = await this.db
        .updateTable('leave_request_draft')
        .set({
          leave_type_id: contents.leaveTypeId,
          start_date: contents.from,
          end_date: contents.to,
          reason: contents.reason,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      return row === undefined ? undefined : toDraft(row);
    });
  }

  async findById(id: string): Promise<LeaveRequestDraft | undefined> {
    const row = await this.db
      .selectFrom('leave_request_draft')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toDraft(row);
  }

  /** One person's drafts, the one they were last working on first. */
  async forEmployee(employeeId: string): Promise<LeaveRequestDraft[]> {
    const rows = await this.db
      .selectFrom('leave_request_draft')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    return rows.map(toDraft);
  }

  /**
   * Throws a draft away. FR 19.
   *
   * A real DELETE, which the migration grants and argues for: a draft holds nothing, so
   * there is nothing left behind to explain. Answers whether there was one to remove.
   */
  async discard(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('leave_request_draft')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** Runs a write and turns whatever the database refused it for into a domain error. */
  private async catchRefusals<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const constraint = failure.constraint ?? '';

      if (
        (failure.code === CHECK_VIOLATION || failure.code === FOREIGN_KEY_VIOLATION) &&
        constraint in CHECKED_FIELDS
      ) {
        throw new InvalidLeaveRequestDraft(CHECKED_FIELDS[constraint], messageFor(constraint));
      }

      throw error;
    }
  }
}

function rowFor(employeeId: string, contents: DraftContents): Insertable<LeaveRequestDraftTable> {
  return {
    employee_id: employeeId,
    leave_type_id: contents.leaveTypeId,
    start_date: contents.from,
    end_date: contents.to,
    reason: contents.reason,
  };
}

/** A row as the domain sees it. The two dates stay ten characters. NFR DAT 03. */
function toDraft(row: LeaveRequestDraftRow): LeaveRequestDraft {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    from: row.start_date,
    to: row.end_date,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
