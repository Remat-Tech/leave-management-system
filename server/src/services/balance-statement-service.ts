/**
 * The balance screen, assembled. FR 53, §7.4. LMS 401.
 *
 * One method, four reads and no writes. What a statement *is* lives in
 * ../domain/balance-statement.ts; who may read one is ../auth/ledger-policy.ts; this
 * gathers the rows those two need and picks the year.
 *
 * ## Why it is not a method on `BalanceService`
 *
 * That class already has `forEmployee`, its documentation already says FR 53, and the
 * shortest version of this story is four more lines inside it. The reason it is here
 * instead is the sentence that class ends its own module note with: the request rules are
 * not in it because "putting them here would make this the service that knows
 * everything."
 *
 * A statement needs the leave types, the leave years and the employee's gender and
 * employment dates. Adding three repositories to the one class in the system that holds
 * a row lock open while it decides whether days are there is a real cost, and it is paid
 * by every future reader of the file that must have exactly one door. So the door stays
 * narrow and the screen is assembled beside it.
 *
 * Nothing here posts a movement, holds a `LedgerRepository`, or opens a transaction.
 * ../../tests/unit/one-writer.test.ts is what keeps that true rather than the intention.
 *
 * ## Four reads, one of them wider than it looks
 *
 * The employee, every leave type, every leave year, and **this person's balances across
 * all years** rather than the one being shown. The last is deliberate and it is what
 * makes the year picker and the figures agree: which years are on the picker depends on
 * which years hold a balance, so asking for one year's rows would mean either a second
 * query or a picker that could offer a year the statement then had nothing for.
 *
 * It is a small read. One person's balances are at most one row per leave type per leave
 * year, which for a decade of service and seven types is seventy rows — and it is the
 * cached table rather than the ledger, which is the whole of what LMS 211 built.
 *
 * ## No lock, and nothing to lock
 *
 * `BalanceService.forOne` says it and it is truer here: "a lock taken for a figure nobody
 * is about to act on is a lock somebody else waits behind for nothing." A statement is
 * read and looked at. The figure it shows may be a moment old by the time it is on a
 * screen, and that is the honest behaviour rather than a race — the check that matters is
 * made inside the lock at the moment somebody submits, which is §8.2 and is somewhere
 * else entirely.
 *
 * ## Three policies asked, and one of them can refuse
 *
 * The layering rule says a service asks the policy for its resource, and a statement
 * touches three tables, so all three are asked rather than only the interesting one.
 * `leaveTypePolicy.list` and `leaveYearPolicy.list` allow anybody signed in — those
 * tables are the rules themselves, and ../auth/leave-type-policy.ts argues at length why
 * they have to be readable — so the question that decides is `ledgerPolicy.read`: your
 * own balances, your direct reports', or a role that reads everybody. FR 53, FR 55, FR 56.
 *
 * **Whose statement it is comes from the caller's id, never from the wire.** This method
 * takes an employee id because FR 55 and FR 56 exist, and the route that serves FR 53
 * passes the actor's own id rather than anything a client sent. Either way
 * `ledgerPolicy.read` is asked against the record read here, so a supplied id can only
 * ever get somebody what they were already entitled to.
 */

import type { Actor } from '../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from '../auth/ledger-policy.js';
import { leaveTypePolicy } from '../auth/leave-type-policy.js';
import { leaveYearPolicy } from '../auth/leave-year-policy.js';
import type { Guard } from '../auth/policy.js';
import {
  type BalanceStatement,
  NoLeaveYearToShow,
  NotOneOfTheirLeaveYears,
  statementFor,
  theYearToOpenOn,
  yearsToChooseFrom,
} from '../domain/balance-statement.js';
import { type Employee, EmployeeNotFound } from '../domain/employee.js';
import { type LeaveYear, LeaveYearNotFound } from '../domain/leave-year.js';
import { type CalendarDate, calendarDateIn } from '../domain/time.js';
import type { BalanceRepository } from '../repositories/balance-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';

/** Which slice of somebody's balances to show. Both are optional; see the method. */
export interface StatementOptions {
  /**
   * The year to show, or nothing for the one {@link theYearToOpenOn} picks.
   *
   * Refused with {@link LeaveYearNotFound} for an id that is nobody's and with
   * {@link NotOneOfTheirLeaveYears} for a real year that is nobody's *here*. Two errors
   * because they are two mistakes: a broken link, and a picker offering too much.
   */
  leaveYearId?: string;
}

export class BalanceStatementService {
  constructor(
    /** The cached balance. Read without a lock; see the module note. */
    private readonly balances: BalanceRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * The employee record, for three facts and no more: who their line manager is,
     * which the policy decides on, and the two dates that say which leave years were
     * theirs. FR 05's gender is the third, and it decides which types are on the list.
     *
     * The repository rather than the service, for the reason `BalanceService` gives
     * about the same dependency: this is one part of the system asking another what it
     * holds, and giving it a second actor would mean minting one.
     */
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * One person's balances for one leave year, with the years they may switch to.
   *
   * The whole of LMS 401 as one call, because the three criteria are one screen: a
   * statement that came back without its year list would leave the picker to be built
   * from a second read that could disagree with it.
   *
   * The year is the caller's if they named one and {@link theYearToOpenOn}'s if they did
   * not. Nothing about which year to open on is decided in a browser — the clock is here,
   * in UTC, which is the day `current_date` is having and the day somebody in Accra is
   * having. NFR DAT 03.
   *
   * Refused with {@link EmployeeNotFound} for an id that is nobody, raised before the
   * policy because there is no balance to have standing towards, and with the policy's
   * silent refusal for somebody else's. Those are deliberately different in kind and the
   * second discloses nothing; see the note at the top of ../auth/policy.ts.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: StatementOptions = {},
  ): Promise<BalanceStatement> {
    const employee = await this.require(employeeId);

    this.guard.enforce(ledgerPolicy.read(actor, ownerOf(employee)));
    this.guard.enforce(leaveTypePolicy.list(actor));
    this.guard.enforce(leaveYearPolicy.list(actor));

    /* All of them, across every year, because the picker is a function of which years
       hold one. See the module note on why that is the cheaper of the two arrangements
       as well as the consistent one. */
    const held = await this.balances.forEmployee(employeeId);

    const choices = yearsToChooseFrom(
      await this.years.list(),
      { startedOn: employee.startDate, leftOn: employee.exitDate },
      held.map((balance) => balance.leaveYearId),
    );

    const year = await this.yearToShow(employee, choices, options.leaveYearId);

    return statementFor({
      employeeId: employee.id,
      gender: employee.gender,
      year,
      years: choices,
      /* Every type, retired ones included. Which of them belong on this person's
         statement is `linesFor`, which has the two rules and the argument for them. */
      types: await this.types.list(),
      balances: held,
    });
  }

  /**
   * Which year this statement is for.
   *
   * A named year is checked twice and the two refusals are different mistakes. That it
   * exists at all is {@link LeaveYearNotFound} and is a broken link or a stale bookmark.
   * That it is one of *theirs* is {@link NotOneOfTheirLeaveYears} and is a picker
   * somewhere offering more than it should — and it matters because the alternative is a
   * screen of noughts for a year somebody was not employed for, which reads as "you have
   * no leave" rather than as "you were not here".
   *
   * The lookup goes through `choices` rather than the repository, because the list has
   * already been read: a second query to establish that a year exists would be a round
   * trip to learn something in hand.
   */
  private async yearToShow(
    employee: Employee,
    choices: readonly LeaveYear[],
    leaveYearId: string | undefined,
  ): Promise<LeaveYear> {
    if (leaveYearId === undefined) {
      const opening = theYearToOpenOn(choices, this.today());

      if (opening === undefined) {
        throw new NoLeaveYearToShow(employee.id);
      }

      return opening;
    }

    const chosen = choices.find((year) => year.id === leaveYearId);

    if (chosen !== undefined) {
      return chosen;
    }

    const real = await this.years.findById(leaveYearId);

    if (real === undefined) {
      throw new LeaveYearNotFound(leaveYearId);
    }

    throw new NotOneOfTheirLeaveYears(employee.id, real, choices);
  }

  /** The record, or {@link EmployeeNotFound}. Read before any policy is asked. */
  private async require(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }

  /**
   * Today, in UTC, which is the day the database's `current_date` is having.
   *
   * The same clock `LeaveYearService` and `LeaveRequestService` read, so that no two
   * parts of this system disagree about which leave year it is. Accra is UTC+0 all year,
   * so it is also the day the person at the screen is having. NFR DAT 03.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/** Whose balances these are, and who their line manager is. ../auth/ledger-policy.ts. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
