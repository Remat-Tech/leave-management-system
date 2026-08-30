/**
 * Defining leave years and closing them. §5.4. LMS 205.
 *
 * The story's "so that" is the whole specification of this file: a completed year
 * can be locked so its balances cannot drift afterwards. Everything below is one
 * of the three things that makes that true.
 *
 *   **A year is closed once, deliberately.** {@link LeaveYearService.close} is its
 *   own operation with its own policy decision, so the audit log says "closed
 *   2026" rather than "changed 2026", and it refuses a year that has not ended —
 *   the mistake that actually happens, on the third of January.
 *
 *   **Nothing reopens one.** There is no method here, no privilege that reaches
 *   it, and `keep_a_closed_leave_year_closed()` refuses it for every writer
 *   including a psql prompt. A lock the person holding it can undo is not a lock;
 *   the way back is a migration with a reason attached.
 *
 *   **The boundary is read from these rows.** {@link earliestOpenDayFrom} is the
 *   adapter LMS 203 was written against, and it is the whole of what that story
 *   left for this one: `EarliestOpenDay` stops being a truthful
 *   `NOTHING_IS_CLOSED_YET` and becomes a read of the table.
 *
 * ## What it does not do
 *
 * **No balances.** `leave_balance` and `leave_ledger_entry` arrive with LMS 210
 * and LMS 211, each carrying a `leave_year_id` and each refusing a write against a
 * closed year. That is where "its balances cannot drift" stops being about one row
 * and becomes a rule about a year of them. Nothing here pretends to do it, because
 * a check that counts nothing reads as a rule and is not one.
 *
 * **No rollover.** Carrying unused annual leave into the next year is FR 36 and
 * LMS 217. Closing a year does not perform it and must not: they are two decisions
 * — "this year is settled" and "these days move" — and a close that silently did
 * both would be a close nobody could audit.
 *
 * **No moving the boundary between two years.** Changing from a January start to
 * an April one moves the end of one year and the start of the next, in one
 * transaction; both database rules are deferred so that a later story can, and it
 * is not this one, because it also has to say what happens to the balances in the
 * months that changed hands.
 *
 * **No authorisation rules.** Every method takes an {@link Actor} and asks
 * ../auth/leave-year-policy.ts. Reading is open to anybody signed in — when the
 * year ends is the most planned-around date in the system — and writing is an HR
 * Administrator's.
 */

import type { Actor } from '../auth/actor.js';
import { leaveYearPolicy } from '../auth/leave-year-policy.js';
import type { Guard } from '../auth/policy.js';
import type { EarliestOpenDay } from '../domain/entitlement-rule.js';
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
} from '../domain/leave-year.js';
import type {
  LeaveYearListOptions,
  LeaveYearRepository,
} from '../repositories/leave-year-repository.js';
import { type CalendarDate, calendarDateIn } from '../domain/time.js';

export class LeaveYearService {
  constructor(
    private readonly years: LeaveYearRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
  ) {}

  /**
   * Defines a year.
   *
   * Throws {@link InvalidLeaveYear} for a date that is not one or a year that
   * ends before it starts, {@link DuplicateLeaveYearLabel} for a name already in
   * use, {@link OverlappingLeaveYears} for one that shares a day with a year
   * already there, and {@link LeaveYearLeavesAGap} for one that would leave days
   * in no year at all.
   *
   * The last two are checked here against the years as they stand *and* by the
   * database as the write lands. Neither copy is redundant: this one names the
   * year that was collided with and the days that would have been orphaned, which
   * is what somebody at a form needs, and the constraint is what holds when two
   * administrators define 2028 in the same second.
   */
  async create(actor: Actor, input: NewLeaveYear): Promise<LeaveYear> {
    this.guard.enforce(leaveYearPolicy.create(actor));

    const validated = validateNewLeaveYear(input);

    assertFitsAmong(validated, await this.years.list());

    return this.years.create(actor, validated);
  }

  /**
   * Corrects a year.
   *
   * A year that is still open may be corrected freely — it has settled nothing,
   * and the honest fix for one typed wrong in January is to fix it. A closed year
   * may only be relabelled: calling it by a better name does not change which days
   * it covered or what anybody was owed in it, which is the same exemption an
   * entitlement rule in effect makes for its note.
   *
   * Moving a date is judged against every other year, so a correction cannot open
   * a hole in the run of them or reach into the year beside it.
   */
  async update(actor: Actor, id: string, changes: LeaveYearChanges): Promise<LeaveYear> {
    this.guard.enforce(leaveYearPolicy.update(actor, id));

    const current = await this.require(id);

    assertMayBeChanged(current, changes);

    const validated = validateLeaveYearChanges(changes, current);

    if (validated.startDate !== undefined || validated.endDate !== undefined) {
      /* Judged against every year but this one. A year always overlaps itself,
         and comparing it with its own row would refuse every correction. */
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

  /**
   * Closes a year for good. The story.
   *
   * Refuses a year that has not ended — {@link LeaveYearNotFinished} — and one
   * that is already closed, which is a different refusal rather than a silent
   * success: closing twice is somebody expecting something to happen, and the
   * honest answer is that it happened already.
   *
   * There is no `reopen` and there will not be one. That is what makes this worth
   * doing at all, and the database says the same thing to every other writer.
   *
   * **Today comes from the clock the database keeps.** The trigger compares
   * against `current_date` on a connection pinned to UTC, so this asks the same
   * question of the same day — a service that used a different clock would accept
   * a close the write then refused, on one day of the year, in one direction.
   */
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

  /**
   * By label. Undefined rather than a throw, because asking whether a name is
   * taken is a fair question and every signed in caller may ask it.
   */
  async byLabel(actor: Actor, label: string): Promise<LeaveYear | undefined> {
    this.guard.enforce(leaveYearPolicy.read(actor));

    return this.years.findByLabel(label);
  }

  /**
   * The year a day falls in, or undefined where none does. The headline read.
   *
   * Every balance question in the system is really this one — "which year does
   * this request draw from" — and it is undefined rather than an error for the
   * honest reason: this system holds no leave year before 2026 and none past
   * whatever HR has defined, and a day outside that is a question about a year
   * nobody has decided on yet. The caller says what that means for them.
   */
  async covering(actor: Actor, day: CalendarDate): Promise<LeaveYear | undefined> {
    this.guard.enforce(leaveYearPolicy.read(actor));

    return this.years.findCovering(day);
  }

  /** The year today falls in, which is the one every screen opens on. */
  async current(actor: Actor): Promise<LeaveYear | undefined> {
    return this.covering(actor, this.today());
  }

  /** Every year, in the order they run. Pass `openOnly` for the ones still live. */
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

  /**
   * Today, in UTC, which is the day the database's `current_date` is having.
   *
   * The same clock {@link EntitlementRuleService} reads and the same one the
   * closed-year trigger reads, so the service and the database can never disagree
   * about whether a year has ended. Accra is UTC+0 all year, so it is also the day
   * the person at the screen is having. NFR DAT 03 and ../domain/time.ts.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/**
 * The boundary a closed year sets, as the function LMS 203 was written against.
 *
 * This is the seam that story left, described in its own words: "LMS 205 brings
 * `leave_year` and with it the real implementation — the day after the last closed
 * year ends. Until then {@link NOTHING_IS_CLOSED_YET} is the honest answer rather
 * than a placeholder." It is no longer the honest answer, so it is no longer what
 * the composition root passes.
 *
 * A function of the repository rather than a method on the service, and neither
 * half of that is incidental:
 *
 *   **It takes no actor**, because it is not somebody asking a question. It is one
 *   part of the system telling another what a date means, on a path where the
 *   caller has already been through ../auth/entitlement-rule-policy.ts. Giving it
 *   an actor would mean inventing one for a background job, which is how a system
 *   acquires a caller that holds every role.
 *
 *   **It is read fresh every time**, which is the reason the type is a function
 *   rather than a date. The year rollover of LMS 217 closes a year while the
 *   process is running, and a service holding a boundary read at start up would go
 *   on accepting figures into a year that had since been settled.
 */
export function earliestOpenDayFrom(years: LeaveYearRepository): EarliestOpenDay {
  return async () => earliestOpenDayOf(await years.list());
}
