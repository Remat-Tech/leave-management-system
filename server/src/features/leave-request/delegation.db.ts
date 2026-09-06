/** Database access for delegated approvals. FR 49, §8.6a, LMS 327. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { ApprovalDelegationTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import type { Database } from '../../db/index.js';
import {
  AlreadyDelegated,
  type ApprovalDelegation,
  type ValidatedDelegation,
} from './delegation.js';
import type { CalendarDate } from '../../shared/time.js';
import { recording } from '../../db/recording.js';

/** Postgres `exclusion_violation`. */
const EXCLUSION_VIOLATION = '23P01';

/** The constraint that holds one delegate to an approver at a time. FR 49. */
const ONE_AT_A_TIME = 'approval_delegation_one_delegate_at_a_time';

type DelegationRow = Selectable<ApprovalDelegationTable>;

export class ApprovalDelegationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes a nomination. FR 49. */
  async nominate(by: Attribution, delegation: ValidatedDelegation): Promise<ApprovalDelegation> {
    try {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('approval_delegation')
          .values(rowFor(delegation))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toDelegation(row);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };

      if (failure.code === EXCLUSION_VIOLATION && failure.constraint === ONE_AT_A_TIME) {
        throw new AlreadyDelegated(delegation);
      }

      throw error;
    }
  }

  /** Ends one. The only update the row takes; the trigger stamps who and when. FR 49. */
  async revoke(by: Attribution, id: string): Promise<ApprovalDelegation | undefined> {
    const row = await recording(this.db, by, (on) =>
      on
        .updateTable('approval_delegation')
        .set({ revoked_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : toDelegation(row);
  }

  async findById(id: string): Promise<ApprovalDelegation | undefined> {
    const row = await this.db
      .selectFrom('approval_delegation')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toDelegation(row);
  }

  /** Everything one person has handed over, soonest first. FR 49. */
  async byApprover(approverId: string): Promise<ApprovalDelegation[]> {
    return this.listWhere('approver_employee_id', [approverId]);
  }

  /** Everything one person has been handed, soonest first. FR 49. */
  async toDelegate(delegateId: string): Promise<ApprovalDelegation[]> {
    return this.listWhere('delegate_employee_id', [delegateId]);
  }

  /**
   * The ones standing on that day, whoever handed them over. FR 49, FR 40.
   *
   * `on` rather than today, so the queue and the decide door read the same clock the rest of
   * this feature does. Revoked rows are out.
   */
  async inForceFor(delegateId: string, on: CalendarDate): Promise<ApprovalDelegation[]> {
    return this.listWhere('delegate_employee_id', [delegateId], on);
  }

  /** The same asked the other way round: who is standing in for these approvers. FR 49. */
  async inForceBy(approverIds: readonly string[], on: CalendarDate): Promise<ApprovalDelegation[]> {
    return approverIds.length === 0 ? [] : this.listWhere('approver_employee_id', approverIds, on);
  }

  private async listWhere(
    column: 'approver_employee_id' | 'delegate_employee_id',
    ids: readonly string[],
    on?: CalendarDate,
  ): Promise<ApprovalDelegation[]> {
    let query = this.db
      .selectFrom('approval_delegation')
      .selectAll()
      .where(column, 'in', [...ids]);

    if (on !== undefined) {
      query = query
        .where('revoked_at', 'is', null)
        .where('starts_on', '<=', on)
        .where('ends_on', '>=', on);
    }

    return (await query.orderBy('starts_on').orderBy('id').execute()).map(toDelegation);
  }
}

function rowFor(delegation: ValidatedDelegation): Insertable<ApprovalDelegationTable> {
  return {
    approver_employee_id: delegation.approverId,
    delegate_employee_id: delegation.delegateId,
    starts_on: delegation.from,
    ends_on: delegation.to,
    because: delegation.because,
  };
}

function toDelegation(row: DelegationRow): ApprovalDelegation {
  return {
    id: row.id,
    approverId: row.approver_employee_id,
    delegateId: row.delegate_employee_id,
    from: row.starts_on,
    to: row.ends_on,
    because: row.because,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    nominatedBy: row.nominated_by,
    nominatedAt: row.nominated_at,
  };
}
