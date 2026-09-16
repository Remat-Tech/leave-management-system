/** Database access for the Chief Executive's reversals. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestReversalTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import {
  AlreadyReversed,
  type NewReversal,
  type Reversal,
  type ReversalAction,
  ReversalNeedsAReason,
} from './reversal.js';
import { recording } from '../../db/recording.js';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

type ReversalRow = Selectable<LeaveRequestReversalTable>;

export class ReversalRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async record(by: Attribution, reversal: NewReversal): Promise<Reversal> {
    try {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_request_reversal')
          .values(rowFor(reversal))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toReversal(row);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };

      if (
        failure.code === UNIQUE_VIOLATION &&
        failure.constraint === 'leave_request_reversed_once'
      ) {
        throw new AlreadyReversed(reversal.leaveRequestId);
      }

      if (
        failure.code === CHECK_VIOLATION &&
        failure.constraint === 'leave_request_reversal_says_why'
      ) {
        throw new ReversalNeedsAReason();
      }

      throw error;
    }
  }

  async forRequest(leaveRequestId: string): Promise<Reversal | undefined> {
    const row = await this.db
      .selectFrom('leave_request_reversal')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .executeTakeFirst();

    return row === undefined ? undefined : toReversal(row);
  }

  async forRequests(leaveRequestIds: readonly string[]): Promise<Reversal[]> {
    if (leaveRequestIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request_reversal')
      .selectAll()
      .where('leave_request_id', 'in', [...leaveRequestIds])
      .orderBy('id')
      .execute();

    return rows.map(toReversal);
  }
}

function rowFor(reversal: NewReversal): Insertable<LeaveRequestReversalTable> {
  return {
    leave_request_id: reversal.leaveRequestId,
    action: reversal.action,
    reason: reversal.reason,
  };
}

function toReversal(row: ReversalRow): Reversal {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    action: row.action as ReversalAction,
    reason: row.reason,
    recordedBy: row.recorded_by,
    recordedByEmployeeId: row.recorded_by_employee_id,
    recordedAt: row.recorded_at,
  };
}
