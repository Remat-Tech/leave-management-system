/**
 * Posting to and reading the balance ledger. FR 27, FR 37, §5.7. LMS 210.
 *
 * The story's "so that" is one sentence and this file is where it becomes usable:
 * any figure can be explained rather than taken on trust. Two verbs and two reads,
 * and each of the four is one part of that.
 *
 *   **{@link LedgerService.history}.** Every movement in one balance, oldest first,
 *   with the figure each one left behind it. The explanation itself.
 *
 *   **{@link LedgerService.adjust}.** FR 37: HR posts a movement by hand, with a
 *   mandatory reason. The one writer this story ships, because it is the only one
 *   that needs nothing that does not exist yet.
 *
 *   **{@link LedgerService.correct}.** The fourth acceptance criterion. A mistake
 *   is put right by an exact compensating entry naming the one it reverses, never
 *   by an edit — and there is no method here that edits, because the table would
 *   refuse it and a method that always throws is a worse way of saying so.
 *
 *   **{@link LedgerService.explain}.** One entry with whatever put it right, both
 *   directions, because "is this the figure that counts" is unanswerable from
 *   either end alone.
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
 * **No other writers.** Six of the eight entry types have no caller here — the
 * rollover posts GRANT and CARRY_FORWARD, the request state machine posts
 * RESERVATION, DEDUCTION and RELEASE, the expiry job posts EXPIRY, FR 25's
 * recalculation posts RECALCULATION. Each is a decision about the operation that
 * causes it, so each belongs to that operation's service and its own policy. A
 * general `post(anything)` here would be a way to reach all six without passing any
 * of those checks, which is the hole ../auth/ledger-policy.ts declines to open.
 */

import type { Actor } from '../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import {
  correctionFor,
  type LedgerEntry,
  LedgerEntryNotFound,
  type LedgerEntryType,
  runningTotal,
  validateNewLedgerEntry,
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

/** What HR supplies to move a balance by hand. FR 37. */
export interface Adjustment {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  /** Signed. Positive gives days, negative takes them away. Never zero. */
  days: number;
  /** Mandatory, and the whole point. FR 27. */
  reason: string;
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

  /**
   * Moves a balance by hand. FR 37.
   *
   * An HR Administrator's, and nobody else's — see ../auth/ledger-policy.ts. The
   * reason is mandatory and there is no default for it anywhere in the tree,
   * because a reason that can be omitted is omitted by the writer with the most to
   * explain.
   *
   * Throws {@link InvalidLedgerEntry} for a figure that is not a movement, a reason
   * that is blank, or a leave year that has been closed — with the exception §8.9
   * names: an adjustment *may* be posted into a settled year, and is the only kind
   * of entry that may. What a closed year refuses is being recalculated quietly by
   * a rule or a job; a deliberate, attributed, permanent correction is not that,
   * and taking it away would leave HR with a psql prompt as the only way to fix a
   * settled figure.
   */
  async adjust(actor: Actor, adjustment: Adjustment): Promise<LedgerEntry> {
    const owner = await this.ownerOf(adjustment.employeeId);

    this.guard.enforce(ledgerPolicy.adjust(actor, owner));

    return this.entries.post(
      actor,
      validateNewLedgerEntry({
        employeeId: adjustment.employeeId,
        leaveTypeId: adjustment.leaveTypeId,
        leaveYearId: adjustment.leaveYearId,
        entryType: 'ADJUSTMENT',
        days: adjustment.days,
        reason: adjustment.reason,
      }),
    );
  }

  /**
   * Puts an earlier entry right, by posting its exact opposite. The story's fourth
   * criterion.
   *
   * The amount is the negation of what was posted and is not the caller's to
   * choose. A correction somebody could size is a correction that can be the wrong
   * size, and "an adjustment of −18 correcting a grant of 20" is a row that looks
   * reconciled and leaves two days behind. Anybody who wants a different figure
   * wants an ordinary {@link LedgerService.adjust}, which is a different thing and
   * reads as one in the history.
   *
   * Decided by the same rule as any other adjustment, because that is what it is.
   * The one thing the caller must supply is what went wrong.
   */
  async correct(actor: Actor, entryId: string, reason: string): Promise<LedgerEntry> {
    const wrong = await this.entries.findById(entryId);

    if (wrong === undefined) {
      throw new LedgerEntryNotFound(entryId);
    }

    const owner = await this.ownerOf(wrong.employeeId);

    this.guard.enforce(ledgerPolicy.adjust(actor, owner));

    return this.entries.post(actor, validateNewLedgerEntry(correctionFor(wrong, reason)));
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
