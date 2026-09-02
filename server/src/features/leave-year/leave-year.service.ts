/**
 * Defining leave years and closing them. §5.4., LMS 205, LMS 203, LMS 210, LMS 211, FR 36, LMS 217.
 */

import type { Actor } from '../../auth/actor.js';
import { leaveYearPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import type { EarliestOpenDay } from '../entitlement/entitlement-rule.js';
import {
  assertFitsAmong,
  assertMayBeChanged,
  assertMayBeClosed,
  earliestOpenDayOf,
  type LeaveYear,
  type LeaveYearChanges,
  LeaveYearNotFound,
  type NewLeaveYear,
  validateLeaveYearChanges,
  validateNewLeaveYear,
} from './leave-year.js';
import type { LeaveYearListOptions, LeaveYearRepository } from './leave-year.db.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';

export class LeaveYearService {
  constructor(
    private readonly years: LeaveYearRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** Defines a year. */
  async create(actor: Actor, input: NewLeaveYear): Promise<LeaveYear> {
    this.guard.enforce(leaveYearPolicy.create(actor));

    const validated = validateNewLeaveYear(input);

    assertFitsAmong(validated, await this.years.list());

    return this.years.create(actor, validated);
  }

  /** Corrects a year. */
  async update(actor: Actor, id: string, changes: LeaveYearChanges): Promise<LeaveYear> {
    this.guard.enforce(leaveYearPolicy.update(actor, id));

    const current = await this.require(id);

    assertMayBeChanged(current, changes);

    const validated = validateLeaveYearChanges(changes, current);

    if (validated.startDate !== undefined || validated.endDate !== undefined) {
      assertFitsAmong(
        { ...current, ...validated },
        (await this.years.list()).filter((year) => year.id !== id),
      );
    }

    const updated = await this.years.update(actor, id, validated);
    if (updated === undefined) {
      throw new LeaveYearNotFound(id);
    }

    return updated;
  }

  /** Closes a year for good. */
  async close(actor: Actor, id: string): Promise<LeaveYear> {
    this.guard.enforce(leaveYearPolicy.close(actor, id));

    const current = await this.require(id);

    assertMayBeClosed(current, this.today());

    const closed = await this.years.close(actor, id);
    if (closed === undefined) {
      throw new LeaveYearNotFound(id);
    }

    return closed;
  }

  async byId(actor: Actor, id: string): Promise<LeaveYear> {
    this.guard.enforce(leaveYearPolicy.read(actor, id));

    return this.require(id);
  }

  /** By label. */
  async byLabel(actor: Actor, label: string): Promise<LeaveYear | undefined> {
    this.guard.enforce(leaveYearPolicy.read(actor));

    return this.years.findByLabel(label);
  }

  /** The year a day falls in, or undefined where none does. */
  async covering(actor: Actor, day: CalendarDate): Promise<LeaveYear | undefined> {
    this.guard.enforce(leaveYearPolicy.read(actor));

    return this.years.findCovering(day);
  }

  /** The year today falls in, which is the one every screen opens on. */
  async current(actor: Actor): Promise<LeaveYear | undefined> {
    return this.covering(actor, this.today());
  }

  /** Every year, in the order they run. */
  async list(actor: Actor, options: LeaveYearListOptions = {}): Promise<LeaveYear[]> {
    this.guard.enforce(leaveYearPolicy.list(actor));

    return this.years.list(options);
  }

  private async require(id: string): Promise<LeaveYear> {
    const year = await this.years.findById(id);
    if (year === undefined) {
      throw new LeaveYearNotFound(id);
    }
    return year;
  }

  /** Today, in UTC, which is the day the database's `current_date` is having. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/** The boundary a closed year sets, as the function LMS 203 was written against. */
export function earliestOpenDayFrom(years: LeaveYearRepository): EarliestOpenDay {
  return async () => earliestOpenDayOf(await years.list());
}
