/** The team calendar, assembled. FR 57, §7.4., LMS 406. */

import type { Actor } from '../../auth/actor.js';
import { leaveYearPolicy } from '../leave-year/policy.js';
import { teamPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import {
  NoLeaveYearForTheCalendar,
  type TeamCalendarView,
  teamCalendarFor,
} from './team-calendar.js';
import { theYearToOpenOn } from '../balance/balance-statement.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import { byStartDate, type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveRequestRepository } from '../leave-request/leave-request.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';

/** Which slice of the calendar to show. */
export interface TeamCalendarOptions {
  /** The year to show, or nothing for the one theYearToOpenOn picks. */
  leaveYearId?: string;
}

export class TeamCalendarService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** FR 57. Who the reader shares a line manager with. */
    private readonly employees: EmployeeRepository,
    /** FR 57. The team's live leave. */
    private readonly requests: LeaveRequestRepository,
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * Who is away and when, for one employee, for one leave year. FR 57, LMS 406.
   *
   * **No leave type repository here, and that is the privacy rule.** A type name cannot be
   * put on the wire by a service that never reads the table, and a reason cannot be sent by
   * a projection that has no field for one. The rule is enforced by what is not wired up
   * rather than by a filter somebody could forget.
   *
   * Three reads for the whole screen, whatever the size of the team.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: TeamCalendarOptions = {},
  ): Promise<TeamCalendarView> {
    const reader = await this.require(employeeId);
    const team = await this.teamAround(reader);

    this.guard.enforce(teamPolicy.calendar(actor, team.length));
    this.guard.enforce(leaveYearPolicy.list(actor));

    /* Every year the company has defined, as `/api/me/team` offers: a team is several
       people, and a picker whose contents changed as they joined and left would describe
       the roster rather than the calendar. */
    const years = [...(await this.years.list())].sort(byStartDate);

    const year = this.yearToShow(reader.id, years, options.leaveYearId);

    return teamCalendarFor({
      reader,
      team,
      year,
      years,
      /** FR 57. Live leave only — a refused request is not an absence. */
      leave: await this.requests.liveOverlapping(
        team.map((person) => person.id),
        { from: year.startDate, to: year.endDate },
      ),
      today: this.today(),
    });
  }

  /**
   * The team the reader is on: their line manager, and everybody reporting to them.
   *
   * The reader is among those reports, so they are on their own calendar. The line manager
   * is added because a team whose manager's absences are invisible is not a calendar somebody
   * can plan a week around. Nobody a colleague manages is here — one level, one query.
   *
   * Empty for the one employee with no line manager, FR 04, which is what the guard refuses.
   */
  private async teamAround(reader: Employee): Promise<Employee[]> {
    if (reader.managerId === null) {
      return [];
    }

    const [reports, manager] = await Promise.all([
      this.employees.findReportsOf([reader.managerId]),
      this.employees.findById(reader.managerId),
    ]);

    return manager === undefined ? reports : [...reports, manager];
  }

  /** Which year this screen is for: the one asked for, or the one covering today. */
  private yearToShow(
    employeeId: string,
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
      throw new NoLeaveYearForTheCalendar(employeeId);
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
