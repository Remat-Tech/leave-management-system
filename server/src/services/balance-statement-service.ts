/** The balance screen, assembled. FR 53, §7.4., LMS 401, LMS 211, §8.2, FR 55, FR 56. */

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

/** Which slice of somebody's balances to show. */
export interface StatementOptions {
  /** The year to show, or nothing for the one theYearToOpenOn picks. */
  leaveYearId?: string;
}

export class BalanceStatementService {
  constructor(
    /** The cached balance. */
    private readonly balances: BalanceRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /**
     * The employee record, for three facts and no more: who their line manager is, which the policy decides on, and the two dates that say which leave ye… FR 05.
     */
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * One person's balances for one leave year, with the years they may switch to. LMS 401, NFR DAT 03.
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
      types: await this.types.list(),
      balances: held,
    });
  }

  /** Which year this statement is for. */
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

  /** The record, or EmployeeNotFound. */
  private async require(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }

  /** Today, in UTC, which is the day the database's `current_date` is having. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/** Whose balances these are, and who their line manager is. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
