/**
 * Reading the cached balance. FR 53, FR 55, FR 56, §5.7. LMS 211.
 *
 * The story's "so that" is "checking what I have left is a glance rather than a
 * wait", and this is the glance. Two reads, no writers, and the absence of the
 * writers is the design rather than an omission from it.
 *
 * ## There is nothing here that changes a figure
 *
 * A balance moves because a ledger entry was posted — `LedgerService.adjust` today,
 * the rollover and the request state machine when they arrive — and the cache
 * follows in that entry's transaction, by a trigger. So there is no `set`, no
 * `recalculate` and no `refresh` on this class.
 *
 * A `refresh` in particular would be the tempting one, and it is worth saying why
 * it is not here. `rebuild_one_balance_from_the_ledger()` exists and is callable,
 * and offering it through a service would make "the balance looks wrong, refresh
 * it" a supported operation — which would quietly turn a cache that cannot drift
 * into one that is expected to, and would put a button in front of the reconciling
 * that §7.4 wants to do on a schedule and report on.
 *
 * ## Who may read one is the ledger's rule, and deliberately not a second copy of it
 *
 * `ledgerPolicy.read` decides both. A balance is the ledger added up, so "may this
 * person see it" is not a second question: the same three standings answer it — it
 * is your own, FR 53; you are their line manager, FR 55; you hold a role that reads
 * everybody, FR 56.
 *
 * A `balancePolicy.read` beside it would be those three cases written twice, and
 * the day FR 55 changes one of the two files would be edited. The denial log says
 * `ledger` for a refused balance read, which is right rather than merely tolerable:
 * what was refused was a look at somebody's leave account, and the account is the
 * ledger.
 *
 * ## What is not here
 *
 * **The list of leave types a screen should show.** This returns the balances that
 * exist, which is the balances something has moved. A joiner on their first morning
 * has none, and a screen that wants a row per type has to decide which types apply
 * to this person — `entitlement_basis` for the ones that arrive with an event, FR
 * 05's `gender_restriction` — which is a decision with policy in it and belongs to
 * the story that builds the screen. {@link BalanceService.forOne} answers for any
 * single type, including one with no row.
 *
 * **The reconciliation.** §7.4 recomputes every balance and reports the drift. The
 * recompute is the migration's; what is missing is a schedule and somebody to tell.
 */

import type { Actor } from '../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import { available, type BalanceKey, type LeaveBalance } from '../domain/balance.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import type { BalanceRepository } from '../repositories/balance-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';

/**
 * A balance with the figure the story is about beside it.
 *
 * The same shape `LedgerService.history` returns — the stored row, plus the one
 * derived number a screen would otherwise compute for itself. `available` is
 * `entitled + carriedOver + adjustment − taken − pending`, is not a column, and may
 * be negative: §8.6b, sick leave.
 */
export type BalanceWithAvailable = LeaveBalance & { available: number };

export class BalanceService {
  constructor(
    private readonly balances: BalanceRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * The employee records, for one question only: who is this person's line
     * manager. The same reason ../services/ledger-service.ts holds one, and the
     * same repository rather than the service, so that no part of the system has to
     * mint an actor to ask another part what it holds.
     */
    private readonly employees: EmployeeRepository,
  ) {}

  /**
   * Every balance this person has, oldest leave year first and in the order leave
   * types are shown in. FR 53 for themselves, FR 55 for their manager, FR 56 for
   * HR.
   *
   * One row read per balance and no arithmetic over a history, which is the whole
   * of the story: a person opening the system sees what they have left in the time
   * it takes to draw the screen, and the account behind any figure is still one
   * call away at `LedgerService.history`.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    leaveYearId?: string,
  ): Promise<BalanceWithAvailable[]> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(employeeId)));

    return (await this.balances.forEmployee(employeeId, leaveYearId)).map(withAvailable);
  }

  /**
   * One balance: this person, this leave type, this leave year.
   *
   * A balance nothing has moved yet comes back as nought rather than as an absence,
   * so a screen asking about a type this person has never used gets a figure to
   * show. `updatedAt` is null in that case, which is how a caller tells "nothing has
   * happened" from "it has been moved back to nought".
   */
  async forOne(actor: Actor, key: BalanceKey): Promise<BalanceWithAvailable> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(key.employeeId)));

    return withAvailable(await this.balances.forOne(key));
  }

  /**
   * Whose balance this is, and who their line manager is.
   *
   * {@link EmployeeNotFound} for an id that is nobody, raised before any policy
   * decision because there is no balance to have standing towards. The same method
   * as ../services/ledger-service.ts's, and deliberately a second copy of eight
   * lines rather than a shared helper: it is the seam between this service and the
   * employee records, and a shared one would be the first thing to grow a parameter
   * saying which of its callers was asking.
   */
  private async ownerOf(employeeId: string): Promise<BalanceOwner> {
    const employee: Employee | undefined = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return { employeeId: employee.id, managerId: employee.managerId };
  }
}

function withAvailable(balance: LeaveBalance): BalanceWithAvailable {
  return { ...balance, available: available(balance) };
}
