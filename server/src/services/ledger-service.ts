/**
 * Reading the balance ledger. FR 27, §5.7. LMS 210, and narrowed by LMS 212.
 *
 * The story's "so that" is one sentence and this file is where it becomes usable:
 * any figure can be explained rather than taken on trust. Two reads, and each is one
 * part of that.
 *
 *   **{@link LedgerService.history}.** Every movement in one balance, oldest first,
 *   with the figure each one left behind it. The explanation itself.
 *
 *   **{@link LedgerService.explain}.** One entry with whatever put it right, both
 *   directions, because "is this the figure that counts" is unanswerable from
 *   either end alone.
 *
 * ## It used to write, and LMS 212 is why it does not
 *
 * `adjust` and `correct` were here, because FR 37's manual movement was the one
 * writer LMS 210 could ship. They are `BalanceService` now, along with the reserve,
 * commit and release that arrived with them, because that story's first acceptance
 * criterion is that there is exactly one writer of balance movements — and two
 * services that can each post an entry is the arrangement in which the second one
 * skips a check the first one makes.
 *
 * The move is not a tidy-up. It is the difference between "the ledger is written
 * carefully in two places" and "the ledger has one door", and only the second of
 * those is a property somebody can check. ../../tests/unit/one-writer.test.ts checks
 * it.
 *
 * What is left here is the account being read, which is what a ledger is for.
 *
 * ## Whose balance it is, and why that costs a read
 *
 * Every method resolves the employee record before it asks the policy. FR 55 gives
 * a manager their direct reports' balances, and whether this actor is that manager
 * is a fact on the employee row rather than something an id can answer. So the
 * record is fetched first and the policy is a pure function of it, which is the
 * same arrangement ../auth/employee-policy.ts is built on.
 *
 * The cost is one read before a refusal. That is the right way round: the
 * alternative is a policy that reads the database, which is how an authorisation
 * layer stops being testable as arithmetic.
 *
 * ## What is not here
 *
 * **No balance.** Nothing sums these into "days available". §5.7's cached total,
 * its five buckets and the reconciliation job of §7.4 are LMS 211, and
 * {@link LedgerEntry} deliberately offers no shortcut to them: see `BUCKETS` in
 * ../domain/ledger.ts for why a run of signed days is not a balance, and
 * `runningTotal` for the figure that is honestly available today.
 *
 * **No writers at all.** Not the six entry types nobody posts yet — the rollover's
 * GRANT and CARRY_FORWARD, the expiry job's EXPIRY, FR 25's RECALCULATION — and not
 * the three a request causes either. All of them are `BalanceService`'s, because
 * moving days and reading the account of days having moved are different jobs, and
 * the first one has to have exactly one door.
 */

import type { Actor } from '../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import {
  type LedgerEntry,
  LedgerEntryNotFound,
  type LedgerEntryType,
  runningTotal,
} from '../domain/ledger.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LedgerRepository } from '../repositories/ledger-repository.js';

/** Which slice of a balance's history to read. */
export interface HistoryOptions {
  /** One leave type, or every one. A balance screen names one; a dispute may not. */
  leaveTypeId?: string;
  /** One leave year, or every one. Carried days mean earlier years still matter. */
  leaveYearId?: string;
  /** Only these kinds of movement. For FR 32b's certified sick days, and reports. */
  entryTypes?: readonly LedgerEntryType[];
}

export class LedgerService {
  constructor(
    private readonly entries: LedgerRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * The employee records, for one question only: who is this person's line
     * manager. FR 55 gives a manager their direct reports' balances, and that is a
     * fact on the row rather than something an id can answer.
     *
     * The repository rather than the service, for the reason
     * ../services/holiday-service.ts gives about the leave years it holds: this is
     * one part of the system asking another what it holds, and giving it a second
     * actor would mean minting one, which is how a system acquires a caller that
     * holds every role.
     */
    private readonly employees: EmployeeRepository,
  ) {}

  /**
   * Every movement in one balance, oldest first, with the figure each left behind.
   *
   * The story, as a screen. FR 53 for the person themselves, FR 55 for their
   * manager, FR 56 for HR.
   *
   * The running figure is `runningTotal`'s and is the sum of the signed movements —
   * **not** the available balance, which is five figures and is LMS 211. The
   * distinction is kept in the name rather than in a comment on the call site,
   * because a field called `after` on a list of movements is what it says and a
   * field called `balance` would not be.
   */
  async history(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<(LedgerEntry & { after: number })[]> {
    await this.mayRead(actor, employeeId);

    return runningTotal(await this.entries.entriesFor({ employeeId, ...options }));
  }

  /**
   * One entry, with everything that puts it right and everything it puts right.
   *
   * What somebody reading a figure they disagree with actually needs: not the row
   * on its own, which may have been reversed an hour later, but the row and its
   * corrections in the order they were written.
   *
   * Refused with {@link LedgerEntryNotFound} for an id that is nobody's, and with
   * the policy's silent refusal for an id that is somebody else's — which are
   * deliberately the same outcome from outside, so that the pair of them is not an
   * existence oracle. See the note at the top of ../auth/policy.ts.
   */
  async explain(actor: Actor, entryId: string): Promise<LedgerEntry[]> {
    const entry = await this.entries.findById(entryId);

    if (entry === undefined) {
      throw new LedgerEntryNotFound(entryId);
    }

    await this.mayRead(actor, entry.employeeId);

    return this.entries.correctionsAround(entryId);
  }

  /** Enforces the read rule, having found out whose balance this is. */
  private async mayRead(actor: Actor, employeeId: string): Promise<void> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(employeeId)));
  }

  /**
   * Whose balance this is, and who their line manager is.
   *
   * {@link EmployeeNotFound} for an id that is nobody, and it is raised *before*
   * any policy decision because there is no balance to have standing towards. That
   * is not the existence oracle the employee policy guards against: this method is
   * only ever reached with an id the caller already supplied, and every read of a
   * real balance they have no standing on refuses silently a line later.
   */
  private async ownerOf(employeeId: string): Promise<BalanceOwner> {
    const employee: Employee | undefined = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return { employeeId: employee.id, managerId: employee.managerId };
  }
}
