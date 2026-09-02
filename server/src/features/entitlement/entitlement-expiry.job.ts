/** Lapsing event grants that were not used in time. FR 32e, LMS 218, FR 36a. */

import type { Actor } from '../../auth/actor.js';
import {
  AlreadyLapsed,
  decideTheLapse,
  hasExpired,
  type LeaveEvent,
  type NotLapsedBecause,
  reasonForLapse,
  wasLapsed,
} from '../leave-event/leave-event.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import type { LeaveEventRepository } from '../leave-event/leave-event.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import type { BalanceService } from '../balance/balance.service.js';

/** One grant that was lapsed. */
export interface Lapsed {
  leaveEventId: string;
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  occurredOn: CalendarDate;
  expiresOn: CalendarDate;
  /** Positive. */
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
    /** The one door that writes a movement. LMS 212. */
    private readonly balances: BalanceService,
    /** The events, and their deadlines. */
    private readonly events: LeaveEventRepository,
    /** For the name that goes in the reason a person reads. */
    private readonly types: LeaveTypeRepository,
    /** Whether the leave year the grant landed in has since been settled. §8.9. */
    private readonly years: LeaveYearRepository,
  ) {}

  /** Lapses every grant whose time is up. */
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

  /** One expired grant. */
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
      if (error instanceof AlreadyLapsed) {
        return { ...named, because: 'ALREADY_LAPSED' };
      }

      throw error;
    }
  }

  /** Whether another grant in the same balance is still within its own deadline. §8.6. */
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

  /** Today, in UTC. NFR DAT 03. */
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

/** The run, as a few lines somebody can read. */
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

/** Two decimal places, which is what the ledger's column holds. See ../features/balance/balance.ts. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
