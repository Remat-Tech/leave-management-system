/**
 * Recording something that happened, and granting what it brings. FR 32g, FR 32e,
 * §8.6aa. LMS 218.
 *
 * The story is an employee expecting a child, and the sentence that matters is "when I
 * need it rather than tied to the leave year". Everything this service does is in
 * service of that: one call, from the desk somebody actually walks up to, and the days
 * are in the balance.
 *
 * ## Six questions, and then one write
 *
 * This class asks; `BalanceService.grantForAnEvent` writes. The order below is the
 * order the answers become possible in, and two of them are load bearing:
 *
 *   **Is this a type whose entitlement arrives with an event at all?** FR 32g.
 *   `hasRunningBalance` is false for exactly these types, and the check is the same
 *   column the annual grant and the rollover read to *skip* them. A quota type reaching
 *   here would be somebody granting themselves a second year of annual leave through a
 *   door built for births.
 *
 *   **Is the type open to them?** FR 05, the gender restriction, and the one refusal
 *   here that is about the person rather than the paperwork.
 *
 *   **Which leave year does the event fall in?** Not today's year: the balance the
 *   grant lands in is the one for the day the thing happened, because a birth in
 *   December told to HR in January belongs to December. The database holds the same
 *   rule — `refuse_an_event_outside_its_leave_year()` — so the two cannot drift.
 *
 *   **What is it worth?** The entitlement rule resolved **as at the day it happened**,
 *   which is FR 31's argument again: a figure changed in January must not restate what
 *   a birth in December was worth.
 *
 *   **When does it run out?** `expiryFor`, from `leave_type.entitlement_expiry_months`.
 *   Paternity's six months, and null everywhere else.
 *
 * ## What it does not do
 *
 * **No pro rating.** FR 29 proportions a *year* to the part of it somebody worked; an
 * event grant is not a year and has no part to take. Somebody who joined in November
 * and has a child in December is owed the whole fourteen days, which is what makes an
 * event grant an event grant.
 *
 * **No lapsing.** That is ../jobs/entitlement-expiry.ts, on a schedule, and it is a
 * different act by a different desk — see ../auth/ledger-policy.ts.
 *
 * **No correcting.** A birth recorded against the wrong person is put right the way
 * every other mistake in a balance is: an `ADJUSTMENT` on each side with a reason. The
 * table refuses to be rewritten and says so, which is FR 27 applied to the record
 * rather than to the movement.
 */

import type { Actor } from '../auth/actor.js';
import { ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import {
  assertHasHappened,
  expiryFor,
  InvalidLeaveEvent,
  type LeaveEvent,
  type NewLeaveEvent,
  reasonForGrant,
} from '../domain/leave-event.js';
import { hasRunningBalance, isEligible, LeaveTypeNotFound } from '../domain/leave-type.js';
import { LeaveYearNotFound } from '../domain/leave-year.js';
import { type CalendarDate, calendarDateIn } from '../domain/time.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type {
  LeaveEventListOptions,
  LeaveEventRepository,
} from '../repositories/leave-event-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type { BalanceService, EventGranted } from './balance-service.js';

/**
 * A quota type being granted through the event door.
 *
 * Refused by name rather than by a generic invalid-input message, because the two
 * mistakes behind it are both worth naming: somebody has picked the wrong type in a
 * form, or somebody has found a way to grant a second year of annual leave that does
 * not go past `grantTheYear`'s once-a-year refusal.
 */
export class NotAnEventBasedType extends Error {
  readonly leaveTypeId: string;

  constructor(id: string, name: string) {
    super(
      `${name} is a yearly allowance rather than something granted per occurrence, so ` +
        `there is no event to record it against. Its entitlement arrives with the leave ` +
        `year — the annual grant posts it — and a second grant of it is refused. FR 32g.`,
    );
    this.name = 'NotAnEventBasedType';
    this.leaveTypeId = id;
  }
}

/** A type the person is not eligible for. FR 05. */
export class NotEligibleForTheType extends Error {
  readonly leaveTypeId: string;

  constructor(id: string, name: string) {
    super(
      `${name} is not open to this employee, so recording an event against it would ` +
        `grant an entitlement they cannot take. FR 05.`,
    );
    this.name = 'NotEligibleForTheType';
    this.leaveTypeId = id;
  }
}

/** A type with no entitlement rule reaching this person. */
export class NoEntitlementForTheEvent extends Error {
  readonly leaveTypeId: string;

  constructor(id: string, name: string, on: CalendarDate) {
    super(
      `Nobody has said what ${name} is worth to this employee as at ${on}, so there is ` +
        `nothing to grant. Unpaid leave is agreed occasion by occasion and has no ` +
        `standing figure at all; for anything else, HR writes an entitlement rule ` +
        `first. FR 31.`,
    );
    this.name = 'NoEntitlementForTheEvent';
    this.leaveTypeId = id;
  }
}

export class LeaveEventService {
  constructor(
    /**
     * The one door that writes a movement. LMS 212.
     *
     * A service rather than a repository, and the reason is sharper here than it is for
     * the two jobs that say the same thing: the grant and the event row are written in
     * one transaction, and the seam that owns transactions is reachable from there and
     * not from here.
     */
    private readonly balances: BalanceService,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    /** Which year the day it happened falls in. The balance the grant lands in. */
    private readonly years: LeaveYearRepository,
    /** For the reads; the writes go through {@link BalanceService}. */
    private readonly events: LeaveEventRepository,
    /**
     * What the type is worth to this person on that day.
     *
     * A function rather than the `EntitlementRuleService`, for the reason
     * ../services/ledger-service.ts gives about the employee repository it holds: this
     * is one part of the system asking another what it holds, on a path where the
     * caller has already been through a policy, and handing it a whole service would
     * mean minting a second actor to ask with.
     */
    private readonly entitlementOn: (
      employee: Employee,
      leaveTypeId: string,
      on: CalendarDate,
    ) => Promise<number | undefined>,
  ) {}

  /**
   * Records an event and grants what it brings. The story.
   *
   * Returns the grant, the event and the balance it produced — all three, because the
   * caller is a screen that has just been told about a birth and has to say what
   * happened: how many days, until when, and what the person now has.
   *
   * Throws {@link NotAnEventBasedType}, {@link NotEligibleForTheType},
   * {@link NoEntitlementForTheEvent}, {@link LeaveYearNotFound} for a day in no year
   * this company has defined, {@link InvalidLeaveEvent} for a date in the future, and
   * {@link EventAlreadyRecorded} where the same event is already on the record.
   */
  async record(actor: Actor, input: NewLeaveEvent): Promise<EventGranted> {
    const occurredOn = requireDay(input.occurredOn);

    assertHasHappened(occurredOn, this.today());

    const employee = await this.employeeFor(input.employeeId);
    const type = await this.typeFor(input.leaveTypeId);

    /* FR 32g. The same column the annual grant and the rollover read to skip these
       types, read here to require one. */
    if (hasRunningBalance(type)) {
      throw new NotAnEventBasedType(type.id, type.name);
    }

    if (!isEligible(type, employee.gender)) {
      throw new NotEligibleForTheType(type.id, type.name);
    }

    /* The year the event fell in, never today's. A birth in December told to HR in
       January belongs to December's balance, and the trigger on the table holds the
       same rule for every other writer. */
    const year = await this.years.findCovering(occurredOn);

    if (year === undefined) {
      throw new LeaveYearNotFound(
        `covering ${occurredOn}. Define the leave year that day falls in first`,
      );
    }

    /* FR 31, as at the day it happened rather than as at today: a figure changed in
       January must not restate what a birth in December was worth. */
    const days = await this.entitlementOn(employee, type.id, occurredOn);

    if (days === undefined || days <= 0) {
      throw new NoEntitlementForTheEvent(type.id, type.name, occurredOn);
    }

    /* FR 32e, computed once and written to the row, so that changing the column later
       cannot move a deadline already given. */
    const expiresOn = expiryFor(occurredOn, type.entitlementExpiryMonths);

    return this.balances.grantForAnEvent(actor, {
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: year.id,
      days,
      reason: reasonForGrant(type.name, occurredOn, expiresOn),
      occurredOn,
      expiresOn,
      note: input.note,
    });
  }

  /**
   * The events on somebody's record, oldest first.
   *
   * The read a balance screen makes to put "for the birth on 4 March" beside a figure,
   * and the read a dispute makes. Decided by exactly the rule that decides who may read
   * the balance — `ledgerPolicy.read`, which is yours, your line manager's, or a role
   * that reads everybody — because an event is the reason a figure is what it is, and
   * standing to see one without the other would be standing to see half an explanation.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: Omit<LeaveEventListOptions, 'employeeId'> = {},
  ): Promise<LeaveEvent[]> {
    const employee = await this.employeeFor(employeeId);

    this.guard.enforce(
      ledgerPolicy.read(actor, { employeeId: employee.id, managerId: employee.managerId }),
    );

    return this.events.list({ ...options, employeeId });
  }

  private async employeeFor(employeeId: unknown): Promise<Employee> {
    if (typeof employeeId !== 'string' || employeeId.trim() === '') {
      throw new InvalidLeaveEvent(
        'employeeId',
        'An entitlement event has to name the employee it happened to.',
      );
    }

    const employee = await this.employees.findById(employeeId.trim());

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId.trim());
    }

    return employee;
  }

  private async typeFor(leaveTypeId: unknown) {
    if (typeof leaveTypeId !== 'string' || leaveTypeId.trim() === '') {
      throw new InvalidLeaveEvent(
        'leaveTypeId',
        'An entitlement event has to name the kind of leave it entitles them to.',
      );
    }

    const type = await this.types.findById(leaveTypeId.trim());

    if (type === undefined) {
      throw new LeaveTypeNotFound(leaveTypeId.trim());
    }

    return type;
  }

  /**
   * Today, in UTC, which is the day the database's `current_date` is having.
   *
   * The same clock `LeaveYearService` and `EntitlementRuleService` read, so that "has
   * this happened yet" is answered against the same day everywhere. Accra is UTC+0 all
   * year, so it is also the day the person at the screen is having. NFR DAT 03.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

function requireDay(value: unknown): CalendarDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidLeaveEvent(
      'occurredOn',
      'The day it happened is a date in the form YYYY-MM-DD. 03/04/2026 and 04/03/2026 ' +
        'are the same ten characters meaning two different days.',
    );
  }

  return value as CalendarDate;
}
