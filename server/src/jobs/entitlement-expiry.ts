/**
 * Lapsing event grants that were not used in time. FR 32e. LMS 218.
 *
 * The fourth thing in `/jobs`, and the story's third criterion. Paternity leave is
 * "fourteen days per birth, usable within six months", and until this runs the second
 * half of that sentence is a note in a column that nothing reads.
 *
 * ## What it does, and the one thing it refuses to
 *
 *   **Finds every grant past its deadline.** `leave_entitlement_event.expires_on`,
 *   written when the event was recorded and never moved since — see
 *   ../domain/leave-event.ts for why the deadline is stored rather than recomputed.
 *
 *   **Lapses whatever is left of the balance**, as a `LAPSE` entry taking days back
 *   out of `entitled` where the grant put them. Not an `EXPIRY`: that is FR 36a's
 *   clock and moves `carriedOver`, and an event grant was never carried.
 *
 *   **Says what it did not lapse, and why.** Four reasons, and two of them are things
 *   somebody may need to look at.
 *
 *   **It never lapses days another grant still has a claim on.** Two births in one
 *   leave year, the first six months up and the second not: the balance cannot say
 *   which days belong to which, so nothing is taken and the run says so. The second
 *   deadline catches whatever is left. That is the conservative direction on purpose —
 *   a lapse takes days off somebody who was going to use them, and they find out when
 *   they try to book.
 *
 * ## Running it nightly is running it again
 *
 * Idempotence is not a nice property here, it is the operating mode: every night after
 * the first is a second run over rows the first already saw. So nothing is remembered.
 * The event row carries `lapsed_entry_id`, {@link LeaveEventRepository.expiredBy} does
 * not return rows that have it, and `BalanceService.lapse` closes the row off in the
 * same transaction as the entry — so a run that dies between the two leaves neither.
 *
 * A second run therefore finds nothing and reports nothing, which is the correct
 * account of a night on which nothing ran out.
 *
 * **An event that had nothing left is not closed off**, and that is deliberate twice
 * over. Nothing ended it — there was nothing to take — so marking it done would mean
 * recording a lapse that never happened. And a balance is not finished moving when a
 * deadline passes: HR may post an `ADJUSTMENT` next week correcting a figure, and
 * those days are days past their deadline. Because the event is still open, the next
 * run finds them and takes them; had it been closed, they would sit there with a
 * deadline nothing enforces. The cost is one indexed read a night per such event,
 * which is what a partial index is for.
 *
 * ## It is a class, not a schedule
 *
 * As with ./balance-reconciliation.ts, ./annual-grant.ts and ./year-rollover.ts.
 * "Nightly" is a cron line and this build has no process to hang one on; what ships is
 * the run, and the README says which line calls it.
 */

import type { Actor } from '../auth/actor.js';
import {
  AlreadyLapsed,
  decideTheLapse,
  hasExpired,
  type LeaveEvent,
  type NotLapsedBecause,
  reasonForLapse,
  wasLapsed,
} from '../domain/leave-event.js';
import { type CalendarDate, calendarDateIn } from '../domain/time.js';
import type { LeaveEventRepository } from '../repositories/leave-event-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type { BalanceService } from '../services/balance-service.js';

/** One grant that was lapsed. */
export interface Lapsed {
  leaveEventId: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  occurredOn: CalendarDate;
  expiresOn: CalendarDate;
  /** Positive. How many days went unused. */
  days: number;
  /** The ledger entry, so a report can be traced to the movement it caused. */
  entryId: string;
}

/** One that was not, and why. */
export interface NotLapsed {
  leaveEventId: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  occurredOn: CalendarDate;
  expiresOn: CalendarDate;
  because: NotLapsedBecause;
}

/** What one run of the expiry job did. */
export interface EntitlementExpiryRun {
  /** The day the deadlines were judged against. */
  asAt: CalendarDate;
  ranAt: Date;
  lapsed: readonly Lapsed[];
  notLapsed: readonly NotLapsed[];
}

export class EntitlementExpiry {
  constructor(
    /**
     * The one door that writes a movement. LMS 212.
     *
     * A service rather than a repository, for the reason the other three jobs give: the
     * check that an event lapses once lives inside `BalanceService.lapse`'s
     * transaction, so a job writing its own entries would be posting lapses without it.
     */
    private readonly balances: BalanceService,
    /** The events, and their deadlines. */
    private readonly events: LeaveEventRepository,
    /** For the name that goes in the reason a person reads. */
    private readonly types: LeaveTypeRepository,
    /**
     * Whether the leave year the grant landed in has since been settled.
     *
     * A paternity grant made in December runs to June, and December's year may well
     * have been closed in February. §8.9 lets nothing but an `ADJUSTMENT` into a closed
     * year, so the lapse is reported rather than posted — and nothing is lost by that,
     * because a closed year's balance cannot be booked against either.
     */
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * Lapses every grant whose time is up.
   *
   * Returns what it did either way, because the caller is a scheduler and because two
   * of the four outcomes are things a person may want to look at: a grant left alone
   * because another is still live, and one left alone because its year has closed.
   *
   * `asAt` is the day the deadlines are judged against, and it is a parameter rather
   * than always the clock so that the rule can be asked about any day — the same shape
   * `assertMayBeClosed` uses, and the only way a test can watch six months pass. It
   * defaults to today in UTC, which is the day the database's `current_date` is having.
   *
   * The actor is carried all the way through: every `LAPSE` says who ran it, and a
   * nightly run says "the system (the entitlement expiry)".
   */
  async run(actor: Actor, asAt: CalendarDate = this.today()): Promise<EntitlementExpiryRun> {
    const ranAt = new Date();
    const lapsed: Lapsed[] = [];
    const notLapsed: NotLapsed[] = [];

    for (const event of await this.events.expiredBy(asAt)) {
      const outcome = await this.lapseOne(actor, event, asAt);

      if ('entryId' in outcome) {
        lapsed.push(outcome);
      } else {
        notLapsed.push(outcome);
      }
    }

    return { asAt, ranAt, lapsed, notLapsed };
  }

  /**
   * One expired grant.
   *
   * The decision is ../domain/leave-event.ts's and the write is
   * `BalanceService.lapse`'s; what is left here is fetching the three facts the
   * decision needs and turning a refusal into a line of the report.
   */
  private async lapseOne(
    actor: Actor,
    event: LeaveEvent,
    asAt: CalendarDate,
  ): Promise<Lapsed | NotLapsed> {
    const type = await this.types.findById(event.leaveTypeId);

    const named = {
      leaveEventId: event.id,
      employeeId: event.employeeId,
      leaveTypeId: event.leaveTypeId,
      leaveTypeName: type?.name ?? 'leave',
      occurredOn: event.occurredOn,
      /* Never null on a row `expiredBy` returned — it selects on the column being set —
         and narrowed here rather than asserted so the report's type stays honest. */
      expiresOn: event.expiresOn ?? asAt,
    };

    const balance = await this.balances.forOne(actor, {
      employeeId: event.employeeId,
      leaveTypeId: event.leaveTypeId,
      leaveYearId: event.leaveYearId,
    });

    const year = await this.years.findById(event.leaveYearId);

    const decision = decideTheLapse({
      available: balance.available,
      anotherGrantIsLive: await this.anotherGrantIsLive(event, asAt),
      theYearIsClosed: year?.isClosed ?? false,
    });

    if (!wasLapsed(decision)) {
      return { ...named, because: decision.because };
    }

    try {
      const { entry } = await this.balances.lapse(actor, {
        employeeId: event.employeeId,
        leaveTypeId: event.leaveTypeId,
        leaveYearId: event.leaveYearId,
        days: decision.days,
        reason: reasonForLapse(named.leaveTypeName, event.occurredOn, named.expiresOn),
        leaveEventId: event.id,
      });

      return { ...named, days: decision.days, entryId: entry.id };
    } catch (error) {
      /* Two runs at once, or the same run started twice. Caught rather than prevented,
         because the thing that knows an event has lapsed is the row, read inside the
         transaction that makes the answer still true when the entry is written. */
      if (error instanceof AlreadyLapsed) {
        return { ...named, because: 'ALREADY_LAPSED' };
      }

      throw error;
    }
  }

  /**
   * Whether another grant in the same balance is still within its own deadline.
   *
   * The rare case that makes "whatever remains" honest. There is no per-grant
   * consumption anywhere in this system — §8.6aa lets one grant be drawn down by
   * several requests and the balance is what tracks it — so with two live grants in one
   * balance the days cannot be attributed to either. Rather than guess, this lapses
   * nothing and the run says why.
   *
   * A grant with no deadline at all counts as live, and always will be: compassionate
   * leave has no `entitlement_expiry_months`, so a bereavement in March never runs out
   * and nothing that shares its balance may be lapsed against it. That is the same
   * conservative direction and it is the right one — those days are still somebody's.
   */
  private async anotherGrantIsLive(event: LeaveEvent, asAt: CalendarDate): Promise<boolean> {
    const others = await this.events.list({
      employeeId: event.employeeId,
      leaveTypeId: event.leaveTypeId,
      leaveYearId: event.leaveYearId,
    });

    return others.some(
      (other) => other.id !== event.id && other.lapsedEntryId === null && !hasExpired(other, asAt),
    );
  }

  /**
   * Today, in UTC. NFR DAT 03.
   *
   * The same clock `LeaveYearService` and `LeaveEventService` read, so that a deadline
   * is judged against the same day the event was refused or allowed against. Accra is
   * UTC+0 all year.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/** How many days the run took back. */
export function daysLapsed(run: EntitlementExpiryRun): number {
  return round(run.lapsed.reduce((total, one) => round(total + one.days), 0));
}

/** How many grants were left alone for each reason. */
export function notLapsedCounts(run: EntitlementExpiryRun): Record<NotLapsedBecause, number> {
  const counts: Record<string, number> = {
    ALREADY_LAPSED: 0,
    NOTHING_LEFT: 0,
    ANOTHER_GRANT_IS_LIVE: 0,
    THE_YEAR_IS_CLOSED: 0,
  };

  for (const one of run.notLapsed) {
    counts[one.because] += 1;
  }

  return counts as Record<NotLapsedBecause, number>;
}

/**
 * The run, as a few lines somebody can read.
 *
 * Not an email, for the reason the annual grant's summary is not one: nothing here is a
 * surprise to the system, and the person it *is* a surprise to is the employee — who
 * finds out from their own balance, where the entry says which deadline was missed and
 * when. Telling HR nightly that six people did not use leave they were entitled to
 * would be a nightly email nobody reads by March.
 *
 * The two lines worth acting on are named rather than counted: a grant a closed year
 * has stranded, and one held back because another is still live.
 */
export function summaryOf(run: EntitlementExpiryRun): string {
  const counts = notLapsedCounts(run);

  return [
    `Entitlement expiry as at ${run.asAt}, run at ${run.ranAt.toISOString()}.`,
    '',
    `${run.lapsed.length} grants lapsed, ${daysLapsed(run)} days in total.`,
    ...(counts.ANOTHER_GRANT_IS_LIVE === 0
      ? []
      : [
          '',
          `${counts.ANOTHER_GRANT_IS_LIVE} were left alone because another grant in the ` +
            `same balance is still within its own deadline. Nothing is lost: the later ` +
            `deadline will take whatever is still there.`,
        ]),
    ...(counts.THE_YEAR_IS_CLOSED === 0
      ? []
      : [
          '',
          `${counts.THE_YEAR_IS_CLOSED} ran out in a leave year that has since been ` +
            `closed, so nothing was posted. A settled year takes no new figures, and its ` +
            `balance cannot be booked against either. §8.9.`,
        ]),
    ...(counts.NOTHING_LEFT === 0 ? [] : ['', `${counts.NOTHING_LEFT} had nothing left to lapse.`]),
  ].join('\n');
}

/** Two decimal places, which is what the ledger's column holds. See ../domain/balance.ts. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
