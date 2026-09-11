/** Database access for the days of agreed leave that became sick leave. FR 32c, LMS 507. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestReclassificationTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import {
  DaysAlreadyMoved,
  type Reclassification,
  type ValidatedReclassification,
} from './reclassification.js';
import { InvalidLeaveRequest } from './leave-request.js';
import { recording } from '../../db/recording.js';

/** Postgres `restrict_violation`, which this table's triggers raise with, and `exclusion_violation`. */
const RESTRICT_VIOLATION = '23001';
const EXCLUSION_VIOLATION = '23P01';

const EACH_DAY_ONCE = 'leave_request_reclassification_covers_each_day_once';

/** Which field a refused row is reported against. */
const REFUSED_FIELDS: Record<string, string> = {
  leave_request_reclassification_stays_inside_the_leave: 'from',
  leave_request_reclassification_moves_between_two_types: 'toLeaveTypeId',
  leave_request_reclassification_moves_into_an_exceedable_type: 'toLeaveTypeId',
  leave_request_reclassification_stands_on_their_certificate: 'certificateId',
  leave_request_reclassification_stands_on_a_clean_certificate: 'certificateId',
  leave_request_reclassification_moves_its_days: 'days',
};

type ReclassificationRow = Selectable<LeaveRequestReclassificationTable>;

export class ReclassificationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes one. */
  async record(
    by: Attribution,
    reclassification: ValidatedReclassification,
  ): Promise<Reclassification> {
    return this.catchRefusals(reclassification, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_request_reclassification')
          .values(rowFor(reclassification))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toReclassification(row);
    });
  }

  /** Everything one request has collected, oldest first. */
  async forRequest(leaveRequestId: string): Promise<Reclassification[]> {
    const rows = await this.db
      .selectFrom('leave_request_reclassification')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toReclassification);
  }

  /** The same for a whole page of requests. FR 54, LMS 402. */
  async forRequests(leaveRequestIds: readonly string[]): Promise<Reclassification[]> {
    if (leaveRequestIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request_reclassification')
      .selectAll()
      .where('leave_request_id', 'in', [...leaveRequestIds])
      .orderBy('id')
      .execute();

    return rows.map(toReclassification);
  }

  /**
   * Turns what the database refused into something a caller can act on.
   *
   * The overlap is the one worth catching: the service reads the earlier moves and refuses
   * the same days a moment earlier, and two tabs pressing together both read a request with
   * nothing over those dates. This is where that race actually ends.
   */
  private async catchRefusals<T>(
    reclassification: ValidatedReclassification,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const said = error instanceof Error ? error.message : '';

      if (failure.code === EXCLUSION_VIOLATION && failure.constraint === EACH_DAY_ONCE) {
        throw new DaysAlreadyMoved(reclassification.leaveRequestId, null);
      }

      if (failure.code === RESTRICT_VIOLATION && failure.constraint !== undefined) {
        const field = REFUSED_FIELDS[failure.constraint];

        if (field !== undefined) {
          throw new InvalidLeaveRequest(field, said);
        }
      }

      throw error;
    }
  }
}

function rowFor(
  reclassification: ValidatedReclassification,
): Insertable<LeaveRequestReclassificationTable> {
  return {
    leave_request_id: reclassification.leaveRequestId,
    to_leave_type_id: reclassification.toLeaveTypeId,
    start_date: reclassification.from,
    end_date: reclassification.to,
    days: reclassification.days,
    reason: reclassification.reason,
    correlation_id: reclassification.correlationId,
    certificate_id: reclassification.certificateId,
  };
}

function toReclassification(row: ReclassificationRow): Reclassification {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    toLeaveTypeId: row.to_leave_type_id,
    from: row.start_date,
    to: row.end_date,
    days: Number(row.days),
    reason: row.reason,
    correlationId: row.correlation_id,
    certificateId: row.certificate_id,
    recordedBy: row.recorded_by,
    recordedByEmployeeId: row.recorded_by_employee_id,
    recordedAt: row.recorded_at,
  };
}
