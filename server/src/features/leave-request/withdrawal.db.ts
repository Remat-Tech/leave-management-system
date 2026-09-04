/** Database access for the asks to withdraw approved leave, and HR's answers. FR 47, LMS 324. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestWithdrawalTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import {
  AlreadyAskedToWithdraw,
  type ValidatedWithdrawal,
  type Withdrawal,
  type WithdrawalAction,
  WithdrawalNeedsAReason,
} from './withdrawal.js';
import { recording } from '../../db/recording.js';

/** Postgres `check_violation`, and the class `RAISE … USING ERRCODE` uses for a rule. */
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '2F004';

/** The CHECK that carries FR 47's reasons into the schema. */
const WITHDRAWAL_SAYS_WHY = 'leave_request_withdrawal_says_why';

/** The trigger that refuses a second ask while the first is unanswered. */
const ASKED_ONCE_AT_A_TIME = 'leave_request_is_asked_to_withdraw_once_at_a_time';

type WithdrawalRow = Selectable<LeaveRequestWithdrawalTable>;

export class WithdrawalRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes one ask, or one answer to one. */
  async record(by: Attribution, withdrawal: ValidatedWithdrawal): Promise<Withdrawal> {
    return this.catchRefusals(withdrawal, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_request_withdrawal')
          .values(rowFor(withdrawal))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toWithdrawal(row);
    });
  }

  /** Everything one request has collected, oldest first. */
  async forRequest(leaveRequestId: string): Promise<Withdrawal[]> {
    const rows = await this.db
      .selectFrom('leave_request_withdrawal')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id')
      .execute();

    return rows.map(toWithdrawal);
  }

  /** The same for a whole page of requests, oldest first within each. FR 54, LMS 402. */
  async forRequests(leaveRequestIds: readonly string[]): Promise<Withdrawal[]> {
    if (leaveRequestIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request_withdrawal')
      .selectAll()
      .where('leave_request_id', 'in', [...leaveRequestIds])
      .orderBy('id')
      .execute();

    return rows.map(toWithdrawal);
  }

  /**
   * Turns what the database refused into something a caller can act on.
   *
   * The second ask is the one worth catching. `LeaveRequestService` reads the rows and
   * refuses it with the same sentence a moment earlier, and two tabs pressing the button
   * together both read no open ask and both pass — so this is where the race actually ends,
   * and it ends in the message the person was going to get anyway rather than in a
   * `restrict_violation`.
   */
  private async catchRefusals<T>(
    withdrawal: ValidatedWithdrawal,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };

      if (failure.code === CHECK_VIOLATION && failure.constraint === WITHDRAWAL_SAYS_WHY) {
        throw new WithdrawalNeedsAReason(withdrawal.action);
      }

      if (failure.code === RESTRICT_VIOLATION && failure.constraint === ASKED_ONCE_AT_A_TIME) {
        throw new AlreadyAskedToWithdraw(withdrawal.leaveRequestId, null);
      }

      throw error;
    }
  }
}

function rowFor(withdrawal: ValidatedWithdrawal): Insertable<LeaveRequestWithdrawalTable> {
  return {
    leave_request_id: withdrawal.leaveRequestId,
    action: withdrawal.action,
    reason: withdrawal.reason,
    answers_id: withdrawal.answersId,
  };
}

function toWithdrawal(row: WithdrawalRow): Withdrawal {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    action: row.action as WithdrawalAction,
    reason: row.reason,
    answersId: row.answers_id,
    recordedBy: row.recorded_by,
    recordedByEmployeeId: row.recorded_by_employee_id,
    recordedAt: row.recorded_at,
  };
}
