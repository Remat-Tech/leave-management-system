/** Database access for the stages a request's routing had to skip. FR 48b, §8.6a, LMS 320. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestRoutingTable } from '../../db/schema.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { Attribution } from '../audit/audit.js';
import type { SkippedStage } from './routing.js';
import { recording } from '../../db/recording.js';

type RoutingRow = Selectable<LeaveRequestRoutingTable>;

/** A skip as it comes back out, with who recorded it and when. */
export interface RecordedSkip extends SkippedStage {
  id: string;
  leaveRequestId: string;
  /** Who, in words. */
  recordedBy: string;
  recordedAt: Date;
}

export class LeaveRoutingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes the stages this move had to skip. FR 48b.
   *
   * `ON CONFLICT DO NOTHING` on the stage, because a skip is recorded once per request: two
   * writers reaching the same conclusion is the same fact twice, not two facts.
   */
  async record(
    by: Attribution,
    leaveRequestId: string,
    skips: readonly SkippedStage[],
  ): Promise<RecordedSkip[]> {
    if (skips.length === 0) {
      return [];
    }

    const rows = await recording(this.db, by, (on) =>
      on
        .insertInto('leave_request_routing')
        .values(skips.map((skip) => rowFor(leaveRequestId, skip)))
        .onConflict((conflict) => conflict.columns(['leave_request_id', 'stage']).doNothing())
        .returningAll()
        .execute(),
    );

    return rows.map(toSkip);
  }

  /** Every stage one request skipped, oldest first. */
  async forRequest(leaveRequestId: string): Promise<RecordedSkip[]> {
    const rows = await this.db
      .selectFrom('leave_request_routing')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toSkip);
  }

  /** The skips on a whole page of requests, oldest first within each. FR 40, FR 54. */
  async forRequests(leaveRequestIds: readonly string[]): Promise<RecordedSkip[]> {
    if (leaveRequestIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request_routing')
      .selectAll()
      .where('leave_request_id', 'in', [...leaveRequestIds])
      .orderBy('id')
      .execute();

    return rows.map(toSkip);
  }
}

function rowFor(leaveRequestId: string, skip: SkippedStage): Insertable<LeaveRequestRoutingTable> {
  return {
    leave_request_id: leaveRequestId,
    stage: skip.stage,
    routed_to: skip.routedTo,
    because: skip.because,
  };
}

function toSkip(row: RoutingRow): RecordedSkip {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    stage: row.stage as ApproverRole,
    routedTo: row.routed_to as ApproverRole,
    because: row.because,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}
