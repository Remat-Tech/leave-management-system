/** Database access for the decisions on a leave request. FR 39, FR 52, LMS 315. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestDecisionTable } from '../../db/schema.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { Attribution } from '../audit/audit.js';
import {
  type DecidingAction,
  type LeaveDecision,
  RefusalNeedsAComment,
  type ValidatedDecision,
} from './leave-decision.js';
import { recording } from '../../db/recording.js';

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** The CHECK that carries the story's first criterion into the schema. */
const REFUSAL_SAYS_WHY = 'leave_request_refusal_says_why';

type DecisionRow = Selectable<LeaveRequestDecisionTable>;

export class LeaveDecisionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes one decision. */
  async record(by: Attribution, decision: ValidatedDecision): Promise<LeaveDecision> {
    return this.catchRefusals(async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_request_decision')
          .values(rowFor(decision))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toDecision(row);
    });
  }

  /** Every decision one request has collected, oldest first. */
  async forRequest(leaveRequestId: string): Promise<LeaveDecision[]> {
    const rows = await this.db
      .selectFrom('leave_request_decision')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toDecision);
  }

  /** The decisions on a whole page of requests, oldest first within each. FR 54, LMS 402. */
  async forRequests(leaveRequestIds: readonly string[]): Promise<LeaveDecision[]> {
    if (leaveRequestIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request_decision')
      .selectAll()
      .where('leave_request_id', 'in', [...leaveRequestIds])
      .orderBy('id')
      .execute();

    return rows.map(toDecision);
  }

  /** Turns what the database refused into something a caller can act on. */
  private async catchRefusals<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };

      if (failure.code === CHECK_VIOLATION && failure.constraint === REFUSAL_SAYS_WHY) {
        throw new RefusalNeedsAComment();
      }

      throw error;
    }
  }
}

/** The row to write. */
function rowFor(decision: ValidatedDecision): Insertable<LeaveRequestDecisionTable> {
  return {
    leave_request_id: decision.leaveRequestId,
    action: decision.action,
    on_behalf_of: decision.onBehalfOf,
    comment: decision.comment,
  };
}

function toDecision(row: DecisionRow): LeaveDecision {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    action: row.action as DecidingAction,
    onBehalfOf: row.on_behalf_of as ApproverRole,
    comment: row.comment,
    decidedBy: row.decided_by,
    decidedByEmployeeId: row.decided_by_employee_id,
    decidedAt: row.decided_at,
  };
}
