/** The team calendar, assembled. FR 57, §7.4., LMS 406, LMS 409. */

import { type Actor, holdsAny } from '../../auth/actor.js';
import { leaveYearPolicy } from '../leave-year/policy.js';
import { teamPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import {
  NoLeaveYearForTheCalendar,
  type TeamCalendarView,
  teamCalendarFor,
} from './team-calendar.js';
import { theYearToOpenOn } from '../balance/balance-statement.js';
import { type Department, DepartmentNotFound } from '../department/department.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import { byStartDate, type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import { READS_EVERY_RECORD } from '../role/roles.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import type { DepartmentRepository } from '../department/department.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveRequestRepository } from '../leave-request/leave-request.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';

/** Which slice of the calendar to show. */
export interface TeamCalendarOptions {
  /** The year to show, or nothing for the one theYearToOpenOn picks. */
  leaveYearId?: string;
  /** LMS 409. Nothing is the reader's own; the empty string is every department, for HR. */
  departmentId?: string;
}

/** LMS 409. What `departmentId: ''` asks for, and only HR may ask. */
const EVERY_DEPARTMENT = '';

export class TeamCalendarService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** FR 57. Who the reader shares a department with. */
    private readonly employees: EmployeeRepository,
    /** FR 57. The department's live leave. */
    private readonly requests: LeaveRequestRepository,
    private readonly years: LeaveYearRepository,
    /** LMS 409. The headings, and what HR may filter by. */
    private readonly departments: DepartmentRepository,
  ) {}

  /**
   * Who is away and when, for one employee, for one leave year. FR 57, LMS 406, LMS 409.
   *
   * **No leave type repository here, and that is the privacy rule.** A type name cannot be
   * sent by a service that never reads the table — enforced by what is not wired up rather
   * than by a filter somebody could forget.
   *
   * **The department is the scope.** LMS 409 replaced the line manager with it: cover is
   * arranged inside a department. HR reads every record, so HR may pick any of them.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: TeamCalendarOptions = {},
  ): Promise<TeamCalendarView> {
    const reader = await this.require(employeeId);

    const acrossAll = holdsAny(actor, ...READS_EVERY_RECORD);
    const showing = await this.departmentToShow(actor, reader, options.departmentId);

    const team =
      showing === null
        ? await this.employees.list()
        : await this.employees.findInDepartment(showing.id);

    this.guard.enforce(teamPolicy.calendar(actor, team.length));
    this.guard.enforce(leaveYearPolicy.list(actor));

    /* Every year the company has defined, as `/api/me/team` offers: a department is several
       people, and a picker whose contents changed as they joined and left would describe
       the roster rather than the calendar. */
    const years = [...(await this.years.list())].sort(byStartDate);

    const year = this.yearToShow(reader.id, years, options.leaveYearId);

    return teamCalendarFor({
      reader,
      team,
      year,
      years,
      showing,
      /* Every department for HR, so the picker is a picker; the reader's own for everybody
         else, so the screen can still say which department it is naming. */
      departments: acrossAll ? await this.departments.list() : await this.readersOwn(reader),
      canChooseDepartment: acrossAll,
      /** FR 57. Live leave only — a refused request is not an absence. */
      leave: await this.requests.liveOverlapping(
        team.map((person) => person.id),
        { from: year.startDate, to: year.endDate },
      ),
      today: this.today(),
    });
  }

  /**
   * Which department the calendar is for. LMS 409.
   *
   * The reader's own unless they asked for another, which is HR's. The empty string is every
   * department at once, and the one case that comes back null.
   */
  private async departmentToShow(
    actor: Actor,
    reader: Employee,
    asked: string | undefined,
  ): Promise<Department | null> {
    if (asked === undefined || asked === reader.departmentId) {
      return this.requireDepartment(reader.departmentId);
    }

    /* Refused rather than silently narrowed to their own: a filter that quietly answered a
       different question is how somebody comes to trust a figure that is not the one they
       asked for. */
    this.guard.enforce(teamPolicy.everyDepartment(actor));

    return asked === EVERY_DEPARTMENT ? null : this.requireDepartment(asked);
  }

  /** The one department a reader who is not HR may name: the one they are in. */
  private async readersOwn(reader: Employee): Promise<Department[]> {
    const own = await this.departments.findById(reader.departmentId);

    return own === undefined ? [] : [own];
  }

  /** The record, or DepartmentNotFound — a department id nobody has is a 404, not an empty page. */
  private async requireDepartment(departmentId: string): Promise<Department> {
    const department = await this.departments.findById(departmentId);

    if (department === undefined) {
      throw new DepartmentNotFound(departmentId);
    }

    return department;
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
