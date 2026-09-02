/** The year rollover. FR 36, FR 36a, §11., LMS 217, LMS 205, FR 30, §11. */

import type { Actor } from '../../auth/actor.js';
import { AlreadyCarried } from '../balance/balance.js';
import type { Employee } from '../employee/employee.js';
import { hasRunningBalance, type LeaveType } from '../leave-type/leave-type.js';
import { type LeaveYear, LeaveYearAlreadyClosed } from './leave-year.js';
import { dayAfter } from '../../shared/time.js';
import {
  type Carried,
  type CarryDecision,
  decideTheCarry,
  type HowItClosed,
  type NotCarried,
  reasonForCarry,
  type Unsettled,
  wasCarried,
  type YearRolloverRun,
} from './year-rollover.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { BalanceService } from '../balance/balance.service.js';
import type { EntitlementRuleService } from '../entitlement/entitlement-rule.service.js';
import type { LeaveYearService } from './leave-year.service.js';
import type { AnnualGrant } from '../entitlement/annual-grant.job.js';

/** A year being rolled over with nothing on the other side of it. */
export class NoLeaveYearAhead extends Error {
  readonly leaveYearId: string;

  constructor(closing: LeaveYear) {
    super(
      `${closing.label} ends on ${closing.endDate} and there is no leave year after it. ` +
        `Unused days have to be carried into a year that exists, so define the next one ` +
        `before rolling this one over. FR 36.`,
    );
    this.name = 'NoLeaveYearAhead';
    this.leaveYearId = closing.id;
  }
}

/**
 * The year ahead already closed, which nothing can be written into.
 *
 * Unreachable by any ordinary sequence — years are closed in the order they run — and
 * refused up front anyway, because the alternative is a run that closes the old year and
 * then fails on every single carry with a settled-year refusal from the ledger. Answering
 * it here costs one comparison and turns four hundred confusing failures into one
 * sentence.
 */
export class LeaveYearAheadIsClosed extends Error {
  readonly leaveYearId: string;

  constructor(opening: LeaveYear) {
    super(
      `${opening.label} is already closed, so nothing can be carried into it. A settled ` +
        `year takes no new figures — the only entry it accepts is a manual adjustment ` +
        `with a reason. §8.9.`,
    );
    this.name = 'LeaveYearAheadIsClosed';
    this.leaveYearId = opening.id;
  }
}

export class YearRollover {
  constructor(
    /**
     * The one door that writes a movement. LMS 212.
     *
     * A service rather than a repository, for the reason ./annual-grant.ts gives: the
     * check that a balance is carried into once lives inside the lock there, so a job
     * writing its own entries would be posting carries without it.
     */
    private readonly balances: BalanceService,
    /** Which year is ending, which one follows it, and the close itself. */
    private readonly years: LeaveYearService,
    /** Whether each type carries at all, and FR 36a's cap. */
    private readonly entitlements: EntitlementRuleService,
    /**
     * The third act, delegated whole. FR 30 and LMS 214.
     *
     * The job rather than the pieces of it, deliberately. A rollover that resolved
     * entitlement rules and posted its own grants would be a second implementation of
     * FR 30 that agreed with the first until the day one of them was edited.
     */
    private readonly grant: AnnualGrant,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
  ) {}

  /**
   * Rolls one leave year into the next. §11.
   *
   * Returns what it did, act by act, because the caller is a scheduler and because the
   * two things worth a person's attention — a balance in arrears and a request left
   * pending in a year that has closed — are only visible from here.
   *
   * The actor is carried all the way through rather than swapped for a system actor
   * partway, exactly as the annual grant carries it: the close is audited with it, every
   * carry entry is attributed to it, and the grant inherits it. A run on the first of
   * January says "the system (the year rollover)" against every row it wrote, and an HR
   * Administrator running it by hand says who they are.
   *
   * Throws {@link NoLeaveYearAhead} and {@link LeaveYearAheadIsClosed} before anything is
   * written, and {@link LeaveYearNotFinished} from the close where the year is still
   * running — which is the mistake that actually happens, on the third of January, with
   * the year that started two days ago.
   */
  async run(actor: Actor, closingLeaveYearId: string): Promise<YearRolloverRun> {
    const closing = await this.years.byId(actor, closingLeaveYearId);
    const opening = await this.years.covering(actor, dayAfter(closing.endDate));

    if (opening === undefined) {
      throw new NoLeaveYearAhead(closing);
    }
    if (opening.isClosed) {
      throw new LeaveYearAheadIsClosed(opening);
    }

    const ranAt = new Date();

    /* First, and before a single figure is read out of the closing year. See
       ../features/leave-year/year-rollover.ts: closing is what makes those figures final. */
    const closed = await this.closeIt(actor, closing);

    const carried: Carried[] = [];
    const notCarried: NotCarried[] = [];
    const unsettled: Unsettled[] = [];

    const everybody = await this.employees.list({ activeOnly: true });
    /* FR 32g and the story's fourth criterion, held by a filter rather than by a rule
       further down: an event type's entitlement arrives with the event, so it has no
       year end to survive. Nothing below this line has ever seen a maternity type. */
    const yearly = (await this.types.list({ offeredOnly: true })).filter(hasRunningBalance);

    for (const employee of everybody) {
      for (const type of yearly) {
        const outcome = await this.carryOne(actor, closing, opening, employee, type, unsettled);

        if ('entryId' in outcome) {
          carried.push(outcome);
        } else {
          notCarried.push(outcome);
        }
      }
    }

    return {
      fromLeaveYearId: closing.id,
      fromLeaveYearLabel: closing.label,
      intoLeaveYearId: opening.id,
      intoLeaveYearLabel: opening.label,
      ranAt,
      closed,
      carried,
      notCarried,
      unsettled,
      /* Last, so that a balance screen never shows a new year with its entitlement in it
         and last year's days still missing. */
      grant: await this.grant.run(actor, opening.id),
    };
  }

  /**
   * Closes the year, or reports that it was closed already.
   *
   * The refusal is caught here and turned into an outcome for the reason the annual
   * grant catches {@link AlreadyGranted}: on a re-run it is the expected answer rather
   * than a failure. {@link LeaveYearNotFinished} is deliberately *not* caught — a year
   * that has not ended is somebody rolling over the wrong year, and carrying on would
   * carry figures people are still adding to.
   */
  private async closeIt(actor: Actor, closing: LeaveYear): Promise<HowItClosed> {
    if (closing.isClosed) {
      return 'ALREADY_CLOSED';
    }

    try {
      await this.years.close(actor, closing.id);

      return 'CLOSED_BY_THIS_RUN';
    } catch (error) {
      /* Two runs at once, or a year closed by hand between the read above and this write.
         Both mean the same thing and neither is a failure of the rollover. */
      if (error instanceof LeaveYearAlreadyClosed) {
        return 'ALREADY_CLOSED';
      }

      throw error;
    }
  }

  /**
   * One person, one leave type.
   *
   * The decision is ../features/leave-year/year-rollover.ts's and the write is
   * `BalanceService.carryForward`'s; what is left here is fetching the two facts the
   * decision needs and turning the refusal into a line of the report.
   *
   * Days still held for an undecided request are noted on the way past. They are not an
   * outcome of the carry — `available` has already left them out, because days spoken for
   * are not unused — but a request left pending when its year closed can never be
   * approved, and this run is the only thing that will ever notice.
   */
  private async carryOne(
    actor: Actor,
    closing: LeaveYear,
    opening: LeaveYear,
    employee: Employee,
    type: LeaveType,
    unsettled: Unsettled[],
  ): Promise<Carried | NotCarried> {
    const named = {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      leaveTypeId: type.id,
      leaveTypeName: type.name,
    };

    const was = await this.balances.forOne(actor, {
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: closing.id,
    });

    if (was.pending > 0) {
      unsettled.push({ ...named, pending: was.pending });
    }

    /**
     * The rule as at the **last day of the year being closed**, which is FR 31 rather
     * than an arbitrary choice of date. The days being carried were earned under the
     * policy that covered them; a rule taking effect in January must not reach back and
     * strip days somebody accrued in a year it says nothing about.
     */
    const rule = await this.entitlements.entitlementOn(actor, employee, type.id, closing.endDate);

    const decision: CarryDecision = decideTheCarry({
      /* `available` rather than a subtraction written here. `BalanceService` hands the
         figure back already computed by ../features/balance/balance.ts, and a second copy of
         `entitled + carriedOver + adjustment − taken − pending` in a job is how the day
         one of those signs changes only one of them gets edited. */
      available: was.available,
      carriesOver: rule?.carriesOver,
      carryoverMaxDays: rule?.carryoverMaxDays ?? null,
    });

    if (!wasCarried(decision)) {
      return { ...named, because: decision.because };
    }

    try {
      const { entry } = await this.balances.carryForward(actor, {
        employeeId: employee.id,
        leaveTypeId: type.id,
        leaveYearId: opening.id,
        days: decision.days,
        reason: reasonForCarry(type.name, closing.label, opening.label, decision),
      });

      return { ...named, days: decision.days, cappedFrom: decision.cappedFrom, entryId: entry.id };
    } catch (error) {
      /* The expected outcome of a re-run, for everybody the first run reached. Caught
         rather than prevented, because the thing that knows a balance has been carried
         into is the ledger, read inside the lock that makes the answer still true when
         the entry is written. */
      if (error instanceof AlreadyCarried) {
        return { ...named, because: 'ALREADY_CARRIED' };
      }

      throw error;
    }
  }
}
