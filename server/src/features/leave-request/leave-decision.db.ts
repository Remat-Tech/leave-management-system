/** Database access for the decisions on a leave request. FR 39, FR 52, LMS 315. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestDecisionTable } from '../../db/schema.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { Attribution } from '../audit/audit.js';
import {
  type DecidingAction,
  LeaveAlreadyDecided,
  type LeaveDecision,
  OverrideNeedsAJustification,
  RefusalNeedsAComment,
  type ValidatedDecision,
} from './leave-decision.js';
import { recording } from '../../db/recording.js';

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The index that holds one decision to a desk. NFR DAT 02, §8.1, LMS 326. */
const ONCE_PER_DESK = 'leave_request_decision_once_per_desk';

/** The CHECK that carries LMS 315's first criterion into the schema. */
const REFUSAL_SAYS_WHY = 'leave_request_refusal_says_why';

/** The CHECK that carries FR 44's second criterion into the schema. LMS 318. */
const OVERRIDE_SAYS_WHY = 'leave_request_override_says_why';

type DecisionRow = Selectable<LeaveRequestDecisionTable>;

export class LeaveDecisionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes one decision. */
  async record(by: Attribution, decision: ValidatedDecision): Promise<LeaveDecision> {
    return this.catchRefusals(decision, async () => {
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
  private async catchRefusals<T>(decision: ValidatedDecision, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };

      /* NFR DAT 02, §8.1, LMS 326. The desk answered twice. `BalanceService.decideForRequest`
         reads the decisions inside the lock and refuses this with the winner named, so what
         reaches here is a writer that found another way in — and it is told the same thing
         rather than a message about an index. */
      if (failure.code === UNIQUE_VIOLATION && failure.constraint === ONCE_PER_DESK) {
        throw new LeaveAlreadyDecided(decision.leaveRequestId, decision.onBehalfOf);
      }

      if (failure.code === CHECK_VIOLATION && failure.constraint === REFUSAL_SAYS_WHY) {
        throw new RefusalNeedsAComment();
      }

      /** FR 44. Two constraints rather than one widened, because they say different things. */
      if (failure.code === CHECK_VIOLATION && failure.constraint === OVERRIDE_SAYS_WHY) {
        throw new OverrideNeedsAJustification();
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
    /** FR 44. */
    overrides_decision_id: decision.overridesDecisionId,
  };
}

function toDecision(row: DecisionRow): LeaveDecision {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    action: row.action as DecidingAction,
    onBehalfOf: row.on_behalf_of as ApproverRole,
    comment: row.comment,
    overridesDecisionId: row.overrides_decision_id,
    decidedBy: row.decided_by,
    decidedByEmployeeId: row.decided_by_employee_id,
    decidedAt: row.decided_at,
  };
}
