/**
 * The one place a balance changes. FR 26, FR 37, §5.7, §8.2. LMS 211 and LMS 212.
 *
 * LMS 211 built the cache and this class read it. LMS 212 is the story that gives it
 * the other half, and the story's own sentence is the design: "one place responsible
 * for changing balances, so that my days cannot be deducted twice or lost between
 * two screens".
 *
 * Both halves of that sentence are load bearing, and they are different problems.
 *
 * ## One place. Every movement is posted from this file
 *
 * There is no other writer. `LedgerService` reads the account and posts nothing;
 * every other service that will one day move days — the rollover, the request state
 * machine, the expiry job — will call one of the five methods here rather than
 * reaching for `LedgerRepository`. ../../tests/unit/one-writer.test.ts is what keeps
 * that true, by reading the source and failing on a second caller.
 *
 * That is worth a rule rather than a habit because of what the second writer looks
 * like when it arrives. It is not a rogue `UPDATE leave_balance` — the database has
 * refused those since LMS 211 — it is an honest service posting an honest
 * `DEDUCTION` and skipping the one check that made it safe. Days deducted twice, by
 * two files that each looked correct.
 *
 * ## Not deducted twice. Held days can only be spent once
 *
 * The three request movements are a lifecycle rather than three writes.
 * {@link BalanceService.reserve} holds days, {@link BalanceService.commit} turns held
 * days into taken ones, {@link BalanceService.release} gives them back — and both of
 * the last two can only draw down what {@link BalanceService.reserve} put there.
 * `daysToCommit` in ../domain/balance.ts refuses the second approval of the same five
 * days because the first emptied the hold it would have to come out of.
 *
 * That is the property that makes approval idempotent-ish in the only way that
 * matters: not that a second commit is silently ignored, which would hide a bug, but
 * that it is refused with a sentence naming how many days are actually held.
 *
 * ## Not lost between two screens. The row is held while it is checked
 *
 * §8.2, and the criterion is exact: the balance is locked *for the duration of
 * reserve and validate*, not for the read that precedes it. Two requests for five
 * days against a balance of five: without the lock both read five, both check five,
 * both write, and ten days are held. With it, the second waits at
 * `holdStill()` and re-reads a balance the first has already spent.
 *
 * The transaction is `Transactions.allOrNothing`, because a lock lasts exactly as
 * long as the transaction that took it. That is also what makes the movement and the
 * cache one act: the trigger of LMS 211 recomputes the balance inside the same
 * transaction, so the figure this returns is the figure the movement produced.
 *
 * ## What decides *whether* an operation should happen is not here
 *
 * This class asks two questions of every movement: has the actor any standing on
 * this balance — ../auth/ledger-policy.ts — and are the days there. It does not ask
 * whether the request giving rise to the movement is a valid request: the notice
 * period of FR 17, the documentation of FR 13, whether this approver is the one FR
 * 38a's chain is waiting on. Those belong to the request and approval stories, are
 * asked before these are called, and putting them here would make this the service
 * that knows everything.
 */

import type { Actor } from '../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import {
  available,
  type BalanceKey,
  daysToCommit,
  daysToRelease,
  daysToReserve,
  type LeaveBalance,
} from '../domain/balance.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import { LeaveTypeNotFound } from '../domain/leave-type.js';
import {
  correctionFor,
  type LedgerEntry,
  LedgerEntryNotFound,
  validateNewLedgerEntry,
} from '../domain/ledger.js';
import type { BalanceRepository } from '../repositories/balance-repository.js';
import { EmployeeRepository } from '../repositories/employee-repository.js';
import type { Repositories, Transactions } from '../repositories/transaction.js';

/**
 * A balance with the figure the story is about beside it.
 *
 * The same shape `LedgerService.history` returns — the stored row, plus the one
 * derived number a screen would otherwise compute for itself. `available` is
 * `entitled + carriedOver + adjustment − taken − pending`, is not a column, and may
 * be negative: §8.6b, sick leave.
 */
export type BalanceWithAvailable = LeaveBalance & { available: number };

/**
 * What a caller supplies to move a balance.
 *
 * **`days` is positive, always, in all five operations.** A reserve of five days is
 * `5`, and so is the release that gives them back — which way the balance moves is
 * decided by which method was called, not by the sign of the figure. The ledger's
 * signs are ../domain/ledger.ts's business, and a caller that had to remember that a
 * reservation is −5 and a release is +5 would eventually get one backwards and post a
 * perfectly valid entry that meant the opposite of what happened.
 *
 * The exception is {@link Adjustment}, which is signed because FR 37 says so.
 */
export interface BalanceMovement extends BalanceKey {
  /** Positive and whole. FR 24. */
  days: number;
  /** FR 27. Why the days moved, in words somebody reading a balance can use. */
  reason: string;
}

/** What HR supplies to move a balance by hand. FR 37. */
export interface Adjustment extends BalanceKey {
  /** Signed, and the only movement that is. Positive gives days, negative takes. */
  days: number;
  /** Mandatory, and the whole point. FR 27. */
  reason: string;
}

/**
 * A movement, and what the balance became.
 *
 * Both, from every one of the five, because a caller needs both and reading the
 * balance again afterwards would read it outside the transaction that moved it — one
 * more window for somebody else's movement to arrive in, in a class whose whole
 * subject is windows.
 */
export interface BalanceMoved {
  entry: LedgerEntry;
  balance: BalanceWithAvailable;
}

export class BalanceService {
  constructor(
    /**
     * For reads, which take no lock and need no transaction.
     *
     * The same repository the transactional half uses, bound to the pool rather than
     * to one connection. A read of somebody's balance for a screen is one statement
     * and wants nothing more.
     */
    private readonly balances: BalanceRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * The employee records, for one question only: who is this person's line
     * manager. Every decision in ../auth/ledger-policy.ts is a function of that and
     * of who is asking, and it is a fact on the row rather than something an id can
     * answer.
     *
     * The repository rather than the service, for the reason
     * ../services/holiday-service.ts gives about the leave years it holds: this is
     * one part of the system asking another what it holds, and giving it a second
     * actor would mean minting one.
     */
    private readonly employees: EmployeeRepository,
    /**
     * Where a movement is written. LMS 212.
     *
     * Not a `LedgerRepository`, which is what a service that only wrote would take.
     * A movement is hold, read, decide and write with nobody in between, and a lock
     * lasts exactly as long as the transaction that took it — so what this class
     * needs is not a repository but the seam that owns transactions.
     */
    private readonly transactions: Transactions,
  ) {}

  /**
   * Every balance this person has, oldest leave year first and in the order leave
   * types are shown in. FR 53 for themselves, FR 55 for their manager, FR 56 for
   * HR.
   *
   * One row read per balance and no arithmetic over a history, which is LMS 211's
   * whole point: a person opening the system sees what they have left in the time it
   * takes to draw the screen, and the account behind any figure is still one call
   * away at `LedgerService.history`.
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
   *
   * No lock. This is the read a screen does, and a lock taken for a figure nobody is
   * about to act on is a lock somebody else waits behind for nothing.
   */
  async forOne(actor: Actor, key: BalanceKey): Promise<BalanceWithAvailable> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(key.employeeId)));

    return withAvailable(await this.balances.forOne(key));
  }

  /**
   * Holds days for leave that has been asked for. FR 26, §8.2.
   *
   * The first movement of a request's life and the one the locking is for. The
   * balance is held still, read, checked against what is being asked for, and the
   * `RESERVATION` written — all inside one transaction, so that a second request for
   * the same days waits rather than reading a figure the first is about to spend.
   *
   * Refused with {@link BalanceOverdrawn} where the days are not there, **unless the
   * leave type may be exceeded**. FR 32a makes sick leave a documentation threshold
   * rather than a cap, so going past it asks for a medical certificate instead — a
   * decision about the request, made by the story that owns requests. What this does
   * is decline to stand in its way, by reading `exceedableWithDocument` off the type
   * rather than deciding anything about which type it is.
   *
   * Held days are not taken days. They are subtracted from what may be booked,
   * because days spoken for are not days to spend twice, and they go back if the
   * request is refused — see {@link BalanceService.release}.
   */
  async reserve(actor: Actor, movement: BalanceMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(movement.employeeId);

    this.guard.enforce(ledgerPolicy.reserve(actor, owner));

    return this.moving(actor, movement, async (held, repositories) => {
      const type = await repositories.types.findById(movement.leaveTypeId);

      if (type === undefined) {
        throw new LeaveTypeNotFound(movement.leaveTypeId);
      }

      return {
        entryType: 'RESERVATION' as const,
        days: -daysToReserve(held, movement.days, type.exceedableWithDocument),
      };
    });
  }

  /**
   * Turns held days into taken days, which is what approval does. FR 26.
   *
   * **This does not consume days a second time.** The reservation already did that;
   * a `DEDUCTION` moves the same days from `pending` to `taken` and leaves available
   * exactly where it was. Anything that instead subtracted them again would be the
   * double deduction this story is named after, and it would look right in every test
   * that never reserved first.
   *
   * Refused with {@link NotEnoughHeld} where there are not that many days held. That
   * is what makes approving the same request twice impossible rather than merely
   * unlikely: the second attempt asks to take five days out of a hold the first one
   * emptied.
   */
  async commit(actor: Actor, movement: BalanceMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(movement.employeeId);

    this.guard.enforce(ledgerPolicy.commit(actor, owner));

    return this.moving(actor, movement, async (held) =>
      Promise.resolve({
        entryType: 'DEDUCTION' as const,
        days: -daysToCommit(held, movement.days),
      }),
    );
  }

  /**
   * Gives held days back, when a request is withdrawn, refused or cancelled.
   *
   * The mirror of {@link BalanceService.reserve}, and refused by the same rule as
   * {@link BalanceService.commit}: days can only be given back out of days that are
   * held, so a second release of the same five is refused rather than crediting
   * somebody twice.
   *
   * It gives back what was held, never what was taken. Undoing an *approved* absence
   * is a different act with a different entry behind it — FR 25's `RECALCULATION` for
   * a holiday inside approved leave, or an `ADJUSTMENT` where HR has decided — and
   * neither is a release.
   */
  async release(actor: Actor, movement: BalanceMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(movement.employeeId);

    this.guard.enforce(ledgerPolicy.release(actor, owner));

    return this.moving(actor, movement, async (held) =>
      Promise.resolve({
        entryType: 'RELEASE' as const,
        days: daysToRelease(held, movement.days),
      }),
    );
  }

  /**
   * Moves a balance by hand. FR 37. Moved here from `LedgerService` by LMS 212.
   *
   * An HR Administrator's, and nobody else's — see ../auth/ledger-policy.ts. The
   * reason is mandatory and there is no default for it anywhere in the tree, because
   * a reason that can be omitted is omitted by the writer with the most to explain.
   *
   * **No lock, and no check against what is there.** That is the difference between
   * an adjustment and the three above rather than an omission: an adjustment moves
   * days by fiat, with no request and no rule behind it, so there is no limit to
   * check and nothing for a lock to protect. It may take a balance negative, and
   * where HR means to do that they mean to do it.
   *
   * Throws {@link InvalidLedgerEntry} for a figure that is not a movement, a reason
   * that is blank, or a leave year that has been closed — with the exception §8.9
   * names: an adjustment *may* be posted into a settled year, and is the only kind of
   * entry that may. What a closed year refuses is being recalculated quietly by a
   * rule or a job; a deliberate, attributed, permanent correction is not that.
   */
  async adjust(actor: Actor, adjustment: Adjustment): Promise<BalanceMoved> {
    const owner = await this.ownerOf(adjustment.employeeId);

    this.guard.enforce(ledgerPolicy.adjust(actor, owner));

    const key = keyOf(adjustment);

    return this.transactions.allOrNothing(async (repositories) => ({
      entry: await repositories.entries.post(
        actor,
        validateNewLedgerEntry({
          ...key,
          entryType: 'ADJUSTMENT',
          days: adjustment.days,
          reason: adjustment.reason,
        }),
      ),
      balance: withAvailable(await repositories.balances.forOne(key)),
    }));
  }

  /**
   * Puts an earlier entry right, by posting its exact opposite. Moved here from
   * `LedgerService` by LMS 212, because it is a movement and movements are written
   * here.
   *
   * The amount is the negation of what was posted and is not the caller's to choose.
   * A correction somebody could size is a correction that can be the wrong size, and
   * "an adjustment of −18 correcting a grant of 20" is a row that looks reconciled
   * and leaves two days behind. Anybody who wants a different figure wants an
   * ordinary {@link BalanceService.adjust}, which is a different thing and reads as
   * one in the history.
   *
   * Decided by the same rule as any other adjustment, because that is what it is. The
   * one thing the caller must supply is what went wrong.
   */
  async correct(actor: Actor, entryId: string, reason: string): Promise<BalanceMoved> {
    return this.transactions.allOrNothing(async (repositories) => {
      const wrong = await repositories.entries.findById(entryId);

      /* Refused with {@link LedgerEntryNotFound} for an id that is nobody's, and with
         the policy's silent refusal a line later for an id that is somebody else's —
         deliberately the same outcome from outside, so the pair is not an existence
         oracle. See the note at the top of ../auth/policy.ts. */
      if (wrong === undefined) {
        throw new LedgerEntryNotFound(entryId);
      }

      const owner = await this.ownerOf(wrong.employeeId, repositories.employees);

      this.guard.enforce(ledgerPolicy.adjust(actor, owner));

      return {
        entry: await repositories.entries.post(
          actor,
          validateNewLedgerEntry(correctionFor(wrong, reason)),
        ),
        balance: withAvailable(await repositories.balances.forOne(keyOf(wrong))),
      };
    });
  }

  /**
   * Hold the balance still, decide what the movement is, write it, and read back what
   * it left. The shape all three request movements share. §8.2.
   *
   * The order is the whole of the concurrency argument and none of it is incidental:
   *
   *   **The lock comes first**, before the balance is read, so the figure the rule is
   *   checked against cannot move under it. A read followed by a lock would be a
   *   check on a stale number with a lock protecting nothing.
   *
   *   **The rule is decided inside the window**, by ../domain/balance.ts, which is
   *   handed the held figure rather than fetching one.
   *
   *   **The entry is written in the same transaction**, so the lock is still held
   *   when the movement lands. The trigger of LMS 211 recomputes the cache in that
   *   same transaction, which is why the read at the end is the figure this movement
   *   produced rather than the figure at the time of asking.
   *
   * Whatever the rule throws rolls the transaction back and comes out unchanged, so a
   * caller catches {@link BalanceOverdrawn} exactly as it would outside one — and no
   * lock outlives the refusal.
   */
  private async moving(
    actor: Actor,
    movement: BalanceMovement,
    decide: (
      held: LeaveBalance,
      repositories: Repositories,
    ) => Promise<{ entryType: 'RESERVATION' | 'DEDUCTION' | 'RELEASE'; days: number }>,
  ): Promise<BalanceMoved> {
    const key = keyOf(movement);

    return this.transactions.allOrNothing(async (repositories) => {
      const held = await repositories.balances.holdStill(key);
      const { entryType, days } = await decide(held, repositories);

      const entry = await repositories.entries.post(
        actor,
        validateNewLedgerEntry({ ...key, entryType, days, reason: movement.reason }),
      );

      return { entry, balance: withAvailable(await repositories.balances.forOne(key)) };
    });
  }

  /**
   * Whose balance this is, and who their line manager is.
   *
   * {@link EmployeeNotFound} for an id that is nobody, raised before any policy
   * decision because there is no balance to have standing towards, and — for the four
   * movements that can raise it before opening one — before any transaction, because
   * a refusal should cost no lock.
   *
   * `employees` is the pool's repository except inside a transaction, where it is
   * that transaction's. A correction reads the entry it is putting right and then
   * this, and both reads belong on the connection holding the work: a record read on
   * the pool could be one the same transaction has already changed.
   */
  private async ownerOf(
    employeeId: string,
    employees: EmployeeRepository = this.employees,
  ): Promise<BalanceOwner> {
    const employee: Employee | undefined = await employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return { employeeId: employee.id, managerId: employee.managerId };
  }
}

function withAvailable(balance: LeaveBalance): BalanceWithAvailable {
  return { ...balance, available: available(balance) };
}

/** The three columns a balance is keyed by, taken off whatever was passed in. */
function keyOf(key: BalanceKey): BalanceKey {
  return {
    employeeId: key.employeeId,
    leaveTypeId: key.leaveTypeId,
    leaveYearId: key.leaveYearId,
  };
}
