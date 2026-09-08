/** The team screen, assembled. FR 55, FR 56, §7.4., LMS 405. */

import type { Actor } from '../../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from '../balance/policy.js';
import { leaveTypePolicy } from '../leave-type/policy.js';
import { leaveYearPolicy } from '../leave-year/policy.js';
import { teamPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import { NoLeaveYearForTheTeam, type TeamView, teamViewFor } from './team.js';
import { theYearToOpenOn } from '../balance/balance-statement.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import { byStartDate, type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import type { BalanceRepository } from '../balance/balance.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveRequestRepository } from '../leave-request/leave-request.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';

/** Which slice of a team to show. */
export interface TeamOptions {
  /** The year to show, or nothing for the one theYearToOpenOn picks. */
  leaveYearId?: string;
}

export class TeamService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** FR 55. Who reports to this person, one level down. */
    private readonly employees: EmployeeRepository,
    /** FR 55. The reports' cached balances. */
    private readonly balances: BalanceRepository,
    /** FR 56. The reports' live leave. */
    private readonly requests: LeaveRequestRepository,
    private readonly types: LeaveTypeRepository,
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * One manager's direct reports, for one leave year. FR 55, FR 56, LMS 405.
   *
   * Two gates. `teamPolicy.read` says whether there is a team at all, and `ledgerPolicy.read`
   * bounds each row — the same rule that lets a manager open one report's balance
   * screen, asked here of every row rather than restated as "direct reports only".
   *
   * Four reads for the whole screen, whatever the size of the team.
   */
  async forManager(actor: Actor, managerId: string, options: TeamOptions = {}): Promise<TeamView> {
    const manager = await this.require(managerId);

    /** FR 55. One level, so a report who manages people brings none of them here. */
    const reports = await this.employees.findReportsOf([manager.id]);

    this.guard.enforce(teamPolicy.read(actor, reports.length));
    this.guard.enforce(leaveTypePolicy.list(actor));
    this.guard.enforce(leaveYearPolicy.list(actor));

    for (const report of reports) {
      this.guard.enforce(ledgerPolicy.read(actor, ownerOf(report)));
    }

    /* Every year the company has defined, rather than the years one employment covers: a team
       is several people, and a picker whose contents changed as they joined and left would be
       showing the reader something about the roster rather than about the calendar. */
    const years = [...(await this.years.list())].sort(byStartDate);

    const year = this.yearToShow(manager.id, years, options.leaveYearId);
    const reportIds = reports.map((report) => report.id);

    return teamViewFor({
      managerId: manager.id,
      reports,
      year,
      years,
      types: await this.types.list(),
      balances: await this.balances.forEmployees(reportIds, year.id),
      /** FR 56. Live leave only — a refused request is not a booking. */
      leave: await this.requests.liveOverlapping(reportIds, {
        from: year.startDate,
        to: year.endDate,
      }),
      today: this.today(),
    });
  }

  /** Which year this screen is for: the one asked for, or the one covering today. */
  private yearToShow(
    managerId: string,
    choices: readonly LeaveYear[],
    leaveYearId: string | undefined,
  ): LeaveYear {
    if (leaveYearId !== undefined) {
      const chosen = choices.find((year) => year.id === leaveYearId);

      if (chosen === undefined) {
        throw new LeaveYearNotFound(leaveYearId);
      }

      return chosen;
    }

    const opening = theYearToOpenOn(choices, this.today());

    if (opening === undefined) {
      throw new NoLeaveYearForTheTeam(managerId);
    }

    return opening;
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

/** Whose balances these are, and who their manager is. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
