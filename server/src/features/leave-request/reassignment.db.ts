/** Database access for the requests a moved reporting line carried. FR 07, §8.4, LMS 325. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestReassignmentTable } from '../../db/schema.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { Attribution } from '../audit/audit.js';
import type { Reassignment } from './reassignment.js';
import { recording } from '../../db/recording.js';

type ReassignmentRow = Selectable<LeaveRequestReassignmentTable>;

/** A reassignment as it comes back out, with who recorded it and when. */
export interface RecordedReassignment extends Reassignment {
  id: string;
  leaveRequestId: string;
  /** Who, in words. */
  recordedBy: string;
  recordedAt: Date;
}

export class LeaveReassignmentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes that a request changed hands. FR 07. */
  async record(
    by: Attribution,
    leaveRequestId: string,
    reassignment: Reassignment,
  ): Promise<RecordedReassignment> {
    const row = await recording(this.db, by, (on) =>
      on
        .insertInto('leave_request_reassignment')
        .values(rowFor(leaveRequestId, reassignment))
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toReassignment(row);
  }

  /** Every time one request changed hands, oldest first. */
  async forRequest(leaveRequestId: string): Promise<RecordedReassignment[]> {
    const rows = await this.db
      .selectFrom('leave_request_reassignment')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toReassignment);
  }

  /** The same over a whole page of requests. FR 54. */
  async forRequests(leaveRequestIds: readonly string[]): Promise<RecordedReassignment[]> {
    if (leaveRequestIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request_reassignment')
      .selectAll()
      .where('leave_request_id', 'in', [...leaveRequestIds])
      .orderBy('id')
      .execute();

    return rows.map(toReassignment);
  }
}

function rowFor(
  leaveRequestId: string,
  reassignment: Reassignment,
): Insertable<LeaveRequestReassignmentTable> {
  return {
    leave_request_id: leaveRequestId,
    from_manager_employee_id: reassignment.from,
    to_manager_employee_id: reassignment.to,
    moved_from: reassignment.movedFrom,
    moved_to: reassignment.movedTo,
    because: reassignment.because,
  };
}

function toReassignment(row: ReassignmentRow): RecordedReassignment {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    from: row.from_manager_employee_id,
    to: row.to_manager_employee_id,
    movedFrom: row.moved_from as ApproverRole | null,
    movedTo: row.moved_to as ApproverRole | null,
    because: row.because,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}
