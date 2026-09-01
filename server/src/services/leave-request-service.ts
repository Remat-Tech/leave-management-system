/**
 * Asking for leave, and being told what it costs first. FR 10, FR 11, §8. LMS 301.
 *
 * The first service of Phase 3, and the story is one sentence: no surprises when the
 * days come off the balance. Two methods follow from it and they are deliberately the
 * same arithmetic twice.
 *
 * ## `quote` and `submit` count the same way, on purpose
 *
 * {@link LeaveRequestService.quote} answers "what would this cost" and writes nothing.
 * {@link LeaveRequestService.submit} answers it again, inside the transaction that
 * holds the days, and stores what it counted.
 *
 * Counting twice looks like waste and is the point. The alternative is a quote handed
 * back to the caller and passed in again at submission — at which point the figure a
 * person is charged is a figure the caller supplied, and a caller that can supply a
 * figure can supply a smaller one. So the number is never an input: both methods take
 * the same four fields somebody typed and both ask {@link LeaveCalculatorService}, and
 * the calculator is pure, so the same period, pattern, calendar and basis give the same
 * answer. What is between the two calls is a person reading a screen, which is exactly
 * the window a holiday could be gazetted in — and if one is, the second count is the
 * right one and the person is charged what the system knew at the moment they
 * committed.
 *
 * ## The basis is copied, and this is where the copy is taken
 *
 * The story's third criterion. `type.countingBasis` is read once, at submission, and
 * written onto the row; every later reading of that request uses the column. See
 * ../domain/leave-request.ts for the argument, and
 * `refuse_rewriting_what_a_request_cost()` for the half that holds even when this
 * service is not the writer.
 *
 * ## What it asks, and in what order
 *
 * The order is the order the answers become possible in, and it is also the order the
 * refusals get cheaper to produce in — which is FR 16's "at once" in the form that
 * matters, because a person waiting on four queries to be told their dates are backwards
 * has been made to wait:
 *
 *   **Are these two dates a period at all?** {@link validateLeavePeriod}, before a
 *   single row is read. An end before a start, a date written `31/07/2026`, a period
 *   two years long. It is first because it needs nothing, and because the queries
 *   underneath it are bounded by these two dates.
 *
 *   **Is this type still offered, and open to them?** FR 05 and a retired type. Asked
 *   before anything is counted, because counting a fortnight of a type nobody may
 *   request is work done to produce a refusal.
 *
 *   **Which leave year does the period fall in?** The year covering the *start*, and
 *   then the whole period is checked against it. A request straddling a year end is
 *   refused with both years named rather than split — see {@link LeaveCrossesAYearEnd},
 *   which is the one refusal here carrying an error code.
 *
 *   **Do they already have leave on those days?** FR 15, and the only question here
 *   about another row. Asked last of the four above because it is the only one that
 *   costs a query the happy path would not otherwise run — and answered with
 *   {@link LeaveOverlapsAnother} naming the leave in the way, which needs one more
 *   query and gets it only on the way to a refusal.
 *
 *   **What does it cost?** {@link LeaveCalculatorService}, which reads the working
 *   pattern and the holidays for the period and applies the type's basis. A period
 *   nothing in which is charged is refused on that answer — {@link countFor} — rather
 *   than by the calculator, which since LMS 303 reports rather than judges.
 *
 *   **Are the days there?** Not asked here at all. It is asked inside
 *   `BalanceService.reserveForRequest`'s lock, because a service that checked
 *   affordability and then wrote would be checking it a moment before it mattered —
 *   §8.2. The quote reports what the balance holds so that a person is not surprised;
 *   the refusal comes from the door.
 *
 * **Every one of those is asked by `quote` as well as by `submit`**, because they share
 * {@link LeaveRequestService.resolve} and {@link LeaveRequestService.countFor}. A quote
 * that accepted what a submission would refuse is the surprise this whole story exists
 * to prevent, arriving two days later in an approver's queue.
 *
 * ## What it does not do
 *
 * **No approving, refusing, withdrawing or cancelling.** Those move `status`, and the
 * README's rule is that only the state machine does — one service method, one
 * authorisation check, one audit write. That is the next story's, and this one leaves
 * `REQUEST_STATUSES` holding a single value so nothing can pretend otherwise.
 *
 * **No notice or documentation enforcement.** FR 17 is a warning by design — leave is
 * sometimes needed at short notice — and the quote carries it so the person sees it
 * before they commit and the approver sees it afterwards. FR 13's documentation is an
 * attachment, and there is nowhere to attach one until Phase 4.
 */

import type { Actor } from '../auth/actor.js';
import { leaveRequestPolicy } from '../auth/leave-request-policy.js';
import type { BalanceOwner } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import type { DayCount, LeavePeriod } from '../domain/leave-calculator.js';
import { validateLeavePeriod } from '../domain/leave-calculator.js';
import {
  assertItCostsSomething,
  InvalidLeaveRequest,
  LeaveCrossesAYearEnd,
  type LeaveRequest,
  type LeaveRequestQuote,
  LeaveRequestNotFound,
  LeaveOverlapsAnother,
  type NewLeaveRequest,
  noticeGiven,
  quoteFor,
  reachesPastTheEndOf,
  reasonForReservation,
  validateLeaveRequestChanges,
  validateNewLeaveRequest,
} from '../domain/leave-request.js';
import {
  assertEligible,
  assertSomebodyApprovesIt,
  assertStillOffered,
  type LeaveType,
  LeaveTypeNotFound,
} from '../domain/leave-type.js';
import { type LeaveYear, LeaveYearNotFound } from '../domain/leave-year.js';
import { type CalendarDate, calendarDateIn, dayAfter } from '../domain/time.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type {
  LeaveRequestListOptions,
  LeaveRequestRepository,
} from '../repositories/leave-request-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type { BalanceService, LeaveRequested } from './balance-service.js';
import type { LeaveCalculatorService } from './leave-calculator-service.js';

/**
 * Leave asked for in a year that has been settled. §8.9.
 *
 * The ledger refuses everything but an `ADJUSTMENT` into a closed year, so the
 * RESERVATION would be refused anyway — by a trigger, with a message about entries.
 * This is the same refusal said in front of the form, about leave.
 */
export class LeaveYearIsClosed extends Error {
  readonly leaveYearId: string;

  constructor(year: LeaveYear) {
    super(
      `Leave year ${year.label} has been settled, so its balances are final and no ` +
        `further leave can be booked against it. Leave taken in a closed year is put on ` +
        `the record by HR as an adjustment with a reason. §8.9.`,
    );
    this.name = 'LeaveYearIsClosed';
    this.leaveYearId = year.id;
  }
}

export class LeaveRequestService {
  constructor(
    /**
     * The one door that writes a movement. LMS 212.
     *
     * A service rather than a repository, for the reason `LeaveEventService` gives: the
     * request row and its RESERVATION are written in one transaction, and the seam that
     * owns transactions is reachable from there and not from here.
     */
    private readonly balances: BalanceService,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    /** Which year the period falls in, and whether it has been settled. */
    private readonly years: LeaveYearRepository,
    /** For the reads; the writes go through {@link BalanceService}. */
    private readonly requests: LeaveRequestRepository,
    /**
     * What the period costs. The one place this question is asked.
     *
     * A service rather than the domain function, because counting needs the working
     * pattern and the holiday calendar and those are reads with policies in front of
     * them — see ../services/leave-calculator-service.ts, which is where the two are
     * fetched for the period rather than for whatever somebody had in hand.
     */
    private readonly calculator: LeaveCalculatorService,
  ) {}

  /**
   * What this leave would cost, before anything is written. The story's second
   * criterion.
   *
   * Writes nothing, reserves nothing, and is safe to call on every keystroke that
   * changes a date. What it returns is {@link LeaveRequestQuote}: the day count, the
   * basis it was reached by *in words*, the days inside the period that were free and
   * why, what the balance holds now and what it would hold afterwards, who would decide
   * it, and anything worth knowing that is not a refusal.
   *
   * The refusals it can raise are the ones that mean there is nothing to quote — a
   * period that is not a period, a type nobody may request, a year nobody has defined —
   * and they come from the domain unchanged, because a service that reworded them would
   * be a second copy of the message NFR USA 03 asks for.
   *
   * **It is not a promise.** A quote taken on Monday and submitted on Friday is counted
   * again on Friday, and if a public holiday was gazetted inside the period in between,
   * the second answer is the one that is charged. That is the honest behaviour and the
   * reason the count is never passed in.
   */
  async quote(actor: Actor, input: NewLeaveRequest): Promise<LeaveRequestQuote> {
    const { employee, type, year, period } = await this.resolve(actor, input);

    const count = await this.countFor(actor, employee, type, period);
    const balance = await this.balances.forOne(actor, {
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: year.id,
    });

    return quoteFor({
      type,
      period,
      count,
      availableNow: balance.available,
      daysOfNotice: noticeGiven(this.today(), period.from),
    });
  }

  /**
   * Records the request and holds the days. FR 10, FR 26.
   *
   * Everything {@link LeaveRequestService.quote} asked, asked again, and then one write
   * through the one door. The two rows — the request and its RESERVATION — land
   * together or neither does.
   *
   * Returns the request, the movement and the balance it left, because the caller is a
   * screen that has just submitted something and has to say what happened: how many
   * days it cost, and what is left.
   *
   * Throws {@link InvalidLeavePeriod} for two dates that are not a period,
   * {@link LeaveCountsNoDays} where nothing in it counts, {@link LeaveTypeRetired} and
   * {@link NotEligibleForTheType} for a type that may not be asked for,
   * {@link LeaveCrossesAYearEnd} for a period spanning a year end,
   * {@link LeaveOverlapsAnother} for leave over leave already booked,
   * {@link LeaveYearIsClosed} for a settled year, and {@link BalanceOverdrawn} from the
   * door where the days are not there.
   */
  async submit(actor: Actor, input: NewLeaveRequest): Promise<LeaveRequested> {
    const { employee, type, year, period } = await this.resolve(actor, input);

    this.guard.enforce(leaveRequestPolicy.submit(actor, ownerOf(employee)));

    /* FR 38a. A type nobody is configured to approve produces a request that would sit
       in no queue, and the person would find out by waiting. Asked here rather than
       when the type was created because a chain can be emptied afterwards. */
    assertSomebodyApprovesIt(type);

    if (year.isClosed) {
      throw new LeaveYearIsClosed(year);
    }

    /* Counted again, inside no transaction yet but from the same facts, and it is this
       answer that is stored. See the module note for why it is not the caller's. */
    const count = await this.countFor(actor, employee, type, period);

    const request = validateNewLeaveRequest({
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: year.id,
      from: period.from,
      to: period.to,
      reason: input.reason,
      /* The story's third criterion, taken here and never read off the type again. */
      countingBasis: type.countingBasis,
      days: count.days,
      calendarDays: count.calendarDays,
    });

    return this.balances.reserveForRequest(actor, {
      request,
      reason: reasonForReservation(type.name, period, count.days),
    });
  }

  /** One request, if the actor may see whose it is. */
  async byId(actor: Actor, id: string): Promise<LeaveRequest> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    return request;
  }

  /**
   * The leave somebody has asked for, the earliest first.
   *
   * Decided by exactly the rule that decides who may read their balance — yours, your
   * line manager's, or a role that reads everybody — because a request is the reason a
   * figure is what it is, and standing to see one without the other would be standing
   * to see half an explanation.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: Omit<LeaveRequestListOptions, 'employeeId'> = {},
  ): Promise<LeaveRequest[]> {
    const employee = await this.employeeFor(employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    return this.requests.list({ ...options, employeeId: employee.id });
  }

  /**
   * Improves the reason on a request already submitted.
   *
   * The only field of substance that may change, and only by the person who wrote it —
   * see ../auth/leave-request-policy.ts. Everything the days were priced from is
   * refused by the database on every connection, so this method's narrowness is a
   * convenience rather than the protection.
   */
  async reword(actor: Actor, id: string, reason: string): Promise<LeaveRequest> {
    const existing = await this.requests.findById(id);

    if (existing === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(existing.employeeId);

    this.guard.enforce(leaveRequestPolicy.reword(actor, ownerOf(employee)));

    const changes = validateLeaveRequestChanges({ reason });
    const written = await this.requests.reword(actor, id, changes.reason);

    /* Unreachable: the row was read a statement ago and nothing deletes one. Answered
       rather than asserted, because the alternative is returning undefined from a
       method whose type says it does not. */
    if (written === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    return written;
  }

  /**
   * The four facts every method here needs, resolved and checked once.
   *
   * Shared by {@link LeaveRequestService.quote} and {@link LeaveRequestService.submit}
   * so that a quote cannot be produced for something a submission would refuse. A
   * person who is shown "7 days, and you would have 13 left" and is then told the type
   * is retired has been misled by a system that knew.
   *
   * The period is validated before the leave year is looked up, because the lookup is
   * bounded by the two dates: a `from` of `31/07/2026` reaching a `WHERE start_date <=`
   * is a driver error where it should have been a sentence beside the input.
   */
  private async resolve(
    actor: Actor,
    input: NewLeaveRequest,
  ): Promise<{ employee: Employee; type: LeaveType; year: LeaveYear; period: LeavePeriod }> {
    const employee = await this.employeeFor(input.employeeId);
    const type = await this.typeFor(input.leaveTypeId);

    /* Both before anything is counted. A fortnight of a type nobody may ask for is
       work done to produce a refusal, and the refusal is better said first. */
    assertStillOffered(type);
    assertEligible(type, employee.gender);

    const period = validateLeavePeriod({ from: input.from, to: input.to });

    /* Reading the balance and the calendar are both permissions of their own, asked by
       the services that do the reading. What this one asks is the request's own
       question, and only where a request is what is being made — a quote reads nothing
       a balance screen would not already show its owner. */
    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    const year = await this.yearCovering(period);

    await this.assertNothingIsAlreadyBooked(employee, period);

    return { employee, type, year, period };
  }

  /**
   * Refuses leave asked for over leave the person already has. FR 15, §5.6. LMS 304.
   *
   * Last in {@link LeaveRequestService.resolve}, because it is the only check there that
   * costs a query the happy path would not otherwise run, and because everything above
   * it refuses on the dates alone. A period the wrong way round should be told so
   * without a table being consulted about it.
   *
   * **Asked by `quote` as well as by `submit`.** A quote is where somebody finds out,
   * and the story is that the system stops them booking over leave they already have
   * rather than letting them price it first and refusing them afterwards.
   *
   * The conflicting request's leave type is read only to be named, and only on the way
   * to a refusal — a row carries a `leaveTypeId` and nobody has recognised their own
   * leave from one. It is very often a different type from the one being asked for,
   * which is what makes naming it worth a query nobody pays for unless they are being
   * refused.
   *
   * **This is not the guarantee.** Two submissions of the same fortnight racing each
   * other both reach this with a table that has no conflict in it, and both pass; what
   * refuses the second is `leave_request_never_overlaps` as the row is written. The
   * repository turns that into the same refusal. What this method buys is the sentence
   * naming the leave in the way, for everybody who is not in a race — which is
   * everybody.
   */
  private async assertNothingIsAlreadyBooked(
    employee: Employee,
    period: LeavePeriod,
  ): Promise<void> {
    const conflict = await this.requests.findOverlapping(employee.id, period);

    if (conflict === undefined) {
      return;
    }

    const type = await this.types.findById(conflict.leaveTypeId);

    throw new LeaveOverlapsAnother(period, {
      request: conflict,
      /* Unreachable: `leave_request.leave_type_id` is NOT NULL with a foreign key behind
         it, and nothing deletes a leave type — retiring one clears `is_active`. Answered
         rather than asserted, because a refusal that reads "5 days of undefined" is worse
         than one that says less. */
      typeName: type?.name ?? 'leave',
    });
  }

  /**
   * What the period costs, refused where that is nothing. FR 16a.
   *
   * The one place either method counts, so the refusal cannot end up on the submission
   * and not on the quote — which would be the exact failure the story is written
   * against: a person shown a figure, told it is fine, and refused after they commit.
   *
   * The judgement is one line and it is deliberately not inlined at the two call sites.
   * {@link assertItCostsSomething} is the rule and lives in the domain; this is where it
   * meets the answer, and there is one such place.
   */
  private async countFor(
    actor: Actor,
    employee: Employee,
    type: LeaveType,
    period: LeavePeriod,
  ): Promise<DayCount> {
    const count = await this.calculator.count(actor, employee, type, period);

    assertItCostsSomething(type, period, count);

    return count;
  }

  /**
   * The leave year the whole period falls in. FR 16.
   *
   * Found from the first day and then checked at the last, which is the only order that
   * gives a useful refusal: a period straddling a year end has a real year at one end
   * and the message can name it, where "no leave year covers 28 December to 5 January"
   * would be true of nothing and helpful to nobody.
   *
   * The year being crossed *into* is looked up only once the crossing is established,
   * and that is the whole reason {@link reachesPastTheEndOf} is a predicate rather than
   * an assertion taking both years. A quote is safe to call on every keystroke that
   * changes a date, so a second query asked on the way to answering "no" every time
   * would be paid for by every request that is fine.
   *
   * It is looked up rather than derived because a leave year need not be a calendar year
   * — §5.4 — so only the row can say whether the year after 2026 is called '2027' or
   * '2027/28'. Undefined where nobody has defined it yet, which is legitimate: a gap
   * after the last leave year is next year's decision rather than a hole.
   *
   * `refuse_a_request_outside_its_leave_year()` holds the same rule for every other
   * writer, so the two cannot drift.
   */
  private async yearCovering(period: LeavePeriod): Promise<LeaveYear> {
    const year = await this.years.findCovering(period.from);

    if (year === undefined) {
      throw new LeaveYearNotFound(
        `covering ${period.from}. Define the leave year that day falls in first`,
      );
    }

    if (reachesPastTheEndOf(year, period)) {
      throw new LeaveCrossesAYearEnd(
        period,
        year,
        await this.years.findCovering(dayAfter(year.endDate)),
      );
    }

    return year;
  }

  private async employeeFor(employeeId: unknown): Promise<Employee> {
    if (typeof employeeId !== 'string' || employeeId.trim() === '') {
      throw new InvalidLeaveRequest('employeeId', 'A leave request has to name whose leave it is.');
    }

    const employee = await this.employees.findById(employeeId.trim());

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId.trim());
    }

    return employee;
  }

  private async typeFor(leaveTypeId: unknown): Promise<LeaveType> {
    if (typeof leaveTypeId !== 'string' || leaveTypeId.trim() === '') {
      throw new InvalidLeaveRequest(
        'leaveTypeId',
        'A leave request has to name the kind of leave being asked for.',
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
   * The same clock `LeaveYearService`, `LeaveEventService` and the expiry job read, so
   * that notice is measured against the same day everywhere. Accra is UTC+0 all year,
   * so it is also the day the person at the screen is having. NFR DAT 03.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/**
 * Whose leave this is, as the policies want it.
 *
 * The same two ids {@link BalanceOwner} carries, and deliberately that type rather than
 * one of this file's own: a request and the balance it moves are decided by the same
 * standings, and two structurally identical types would be an invitation for them to
 * stop being identical.
 */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
