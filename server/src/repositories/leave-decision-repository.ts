/**
 * Database access for the decisions on a leave request. FR 39, FR 52. LMS 315.
 *
 * Queries and row mapping, nothing else. What a decision is and which of them must carry a
 * comment is ../domain/leave-decision.ts; who may make one is
 * ../auth/leave-request-policy.ts; when one is written is ../services/balance-service.ts,
 * which writes it in the same transaction as the status it explains.
 *
 * ## There is no update and no delete, and that is the file's shape
 *
 * The same shape ./ledger-repository.ts has, for the same reason and with the same
 * consequence: `lms_app` holds SELECT and INSERT on this table and nothing more, and
 * `refuse_update()` and `refuse_delete()` refuse the owner as well. A method here would be a
 * method that always throws, which is a worse way of saying so than not having one.
 *
 * What that buys is the thing the story is about. A refusal whose comment can be edited
 * afterwards says whatever the last person to look at it wanted it to say, and the person it
 * was written for has no way of knowing. An approver who put it badly decides again; the
 * history is the answer.
 *
 * ## The three columns this file does not write
 *
 * `decided_by`, `decided_by_employee_id` and `decided_at` are not sent and could not be
 * honoured if they were — `stamp_the_decider_on_a_decision()` overwrites all three from the
 * settings {@link recording} puts on the transaction. That is the same seam the audit log
 * reads, so a decision written inside an audited move is attributed to whoever was making
 * it, and the two records cannot disagree about who that was.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveRequestDecisionTable } from '../db/schema.js';
import type { ApproverRole } from '../domain/approval-chain.js';
import type { Attribution } from '../domain/audit.js';
import {
  type DecidingAction,
  type LeaveDecision,
  RefusalNeedsAComment,
  type ValidatedDecision,
} from '../domain/leave-decision.js';
import { recording } from './recording.js';

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** The CHECK that carries the story's first criterion into the schema. */
const REFUSAL_SAYS_WHY = 'leave_request_refusal_says_why';

type DecisionRow = Selectable<LeaveRequestDecisionTable>;

export class LeaveDecisionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes one decision. The only writer this table has.
   *
   * Called from inside `BalanceService`'s transactions, which move the status the decision
   * explains. Called anywhere else it would write a decision about a request that did not
   * move, which nothing refuses — the guard in the other direction is
   * `leave_request_records_its_decision`, and it is the one that matters: a request that
   * moved at a desk with nothing to say who moved it is the failure this story is about,
   * and a decision about a request that stayed put is a row nobody reads.
   */
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

  /**
   * Every decision one request has collected, oldest first.
   *
   * In the order they were made, because that is the order they are read in: the manager's
   * yes and then HR's is the account of how a request got where it is, and a list sorted any
   * other way is a chain rendered out of order.
   *
   * By `id` rather than by `decided_at`, and the tie break is not decoration — the ledger
   * makes the same point about a rollover's two entries. `now()` is identical for everything
   * written in one transaction, and while a request cannot collect two decisions in one
   * today, an account that reorders itself between two reads is one nobody can check twice.
   */
  async forRequest(leaveRequestId: string): Promise<LeaveDecision[]> {
    const rows = await this.db
      .selectFrom('leave_request_decision')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toDecision);
  }

  /**
   * The decisions on a whole page of requests, oldest first within each. FR 54. LMS 402.
   *
   * {@link LeaveDecisionRepository.forRequest} asks about one, which is right for a screen
   * showing one request and is a query per row for a history showing forty. This is the same
   * read widened by an `in`, and it is ordered by `id` for the same reason that one is:
   * `now()` is identical for everything written in one transaction, so an account sorted by
   * time could reorder itself between two reads.
   *
   * **An empty list of ids is answered without asking the database.** `WHERE id IN ()` is not
   * valid SQL, and a person with no requests at all is somebody's first week rather than an
   * edge case — it should cost nothing.
   *
   * The grouping is deliberately not done here. Which decisions belong to which request is a
   * fact about the rows, and ../domain/request-history.ts does it while it is already walking
   * them; a repository handing back a `Map` would be a repository that had decided what its
   * caller wanted to iterate.
   */
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

  /**
   * Turns what the database refused into something a caller can act on.
   *
   * One constraint is worth translating and the rest are not. `leave_request_refusal_says_
   * why` is the story's first criterion and is unreachable through
   * {@link LeaveRequestService.refuse}, which asks the same question before it reads a
   * single row — but it is the one a second writer would meet, and the sentence
   * {@link RefusalNeedsAComment} carries is written for a person rather than for a log.
   *
   * Everything else is re-thrown as itself. A decision naming a request that does not exist,
   * or a desk that is not one of the three, is a caller with a bug rather than a person with
   * a form, and inventing a friendly sentence for it would hide which of them it was.
   */
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

/**
 * The row to write.
 *
 * The three stamped columns are absent, and their absence here is what makes that
 * unmistakable at the call site rather than a fact somebody has to go and read a trigger for.
 */
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
