/** HR's reports, assembled. FR 63, LMS 510, FR 58, LMS 511. */

import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import { reportPolicy } from './policy.js';
import {
  type BalanceFacts,
  type CarriedOverReport,
  carriedOverBalances,
  type LeaveTakenReport,
  leaveTakenByTypeAndPeriod,
  type LeaveUsageReport,
  leaveUsage,
  type LiabilityReport,
  liabilityByDepartment,
  NoLeaveYearForTheReport,
  type OverdueRequestsReport,
  type ReportChoices,
  reportChoicesOf,
  readOpenEndedPeriod,
  readReportFilter,
  readReportPeriod,
  readTurnaroundDays,
  type ReportYear,
  reportYearOf,
  requestsPastTurnaround,
} from './report.js';
import { theYearToOpenOn } from '../balance/balance-statement.js';
import { byStartDate, type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import type { BalanceRepository } from '../balance/balance.db.js';
import type { DepartmentRepository } from '../department/department.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveRequestRepository } from '../leave-request/leave-request.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';

/** What a report may be asked, as it arrived. */
export interface ReportQuery {
  leaveYearId?: string;
  from?: string;
  to?: string;
  turnaroundDays?: string;
  departmentId?: string;
  leaveTypeId?: string;
}

/** A report with what its filters offer. */
export type WithChoices<T> = T & { choices: ReportChoices };

/** A report over one leave year, with the years it could have been. */
export type WithYears<T> = WithChoices<T> & { years: ReportYear[] };

export class ReportService {
  constructor(
    /** NFR SEC 02. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    private readonly departments: DepartmentRepository,
    private readonly types: LeaveTypeRepository,
    private readonly years: LeaveYearRepository,
    private readonly balances: BalanceRepository,
    private readonly requests: LeaveRequestRepository,
  ) {}

  /** Leave liability by department. */
  async liability(actor: Actor, asked: ReportQuery = {}): Promise<WithYears<LiabilityReport>> {
    this.guard.enforce(reportPolicy.read(actor));

    return this.overYear(asked, liabilityByDepartment);
  }

  /** Leave taken by type and period, the current leave year where no period is given. */
  async leaveTaken(actor: Actor, asked: ReportQuery = {}): Promise<WithChoices<LeaveTakenReport>> {
    this.guard.enforce(reportPolicy.read(actor));

    const year = this.yearToShow(await this.sortedYears(), undefined);
    const { from, to } = readReportPeriod(asked.from, asked.to, {
      from: year.startDate,
      to: year.endDate,
    });
    const departments = await this.departments.list();
    const types = await this.types.list();

    return {
      ...leaveTakenByTypeAndPeriod({
        from,
        to,
        employees: await this.employees.list(),
        types,
        approved: await this.requests.approvedStartingBetween({ from, to }),
        filter: readReportFilter(asked, departments, types),
      }),
      choices: reportChoicesOf(departments, types),
    };
  }

  /** Requests pending beyond the agreed turnaround, narrowed by when they were submitted. */
  async overdueRequests(
    actor: Actor,
    asked: ReportQuery = {},
  ): Promise<WithChoices<OverdueRequestsReport>> {
    this.guard.enforce(reportPolicy.read(actor));

    const departments = await this.departments.list();
    const types = await this.types.list();

    return {
      ...requestsPastTurnaround({
        asAt: this.today(),
        turnaroundDays: readTurnaroundDays(asked.turnaroundDays),
        undecided: await this.requests.undecided(),
        employees: await this.employees.list(),
        departments,
        types,
        filter: readReportFilter(asked, departments, types),
        submitted: readOpenEndedPeriod(asked.from, asked.to),
      }),
      choices: reportChoicesOf(departments, types),
    };
  }

  /** Employees with zero or excessive leave taken. */
  async usage(actor: Actor, asked: ReportQuery = {}): Promise<WithYears<LeaveUsageReport>> {
    this.guard.enforce(reportPolicy.read(actor));

    return this.overYear(asked, leaveUsage);
  }

  /** Carried over balances. */
  async carriedOver(actor: Actor, asked: ReportQuery = {}): Promise<WithYears<CarriedOverReport>> {
    this.guard.enforce(reportPolicy.read(actor));

    return this.overYear(asked, carriedOverBalances);
  }

  /** Gathers one year's balances and hands them to a report. */
  private async overYear<T>(
    asked: ReportQuery,
    report: (facts: BalanceFacts) => T,
  ): Promise<WithYears<T>> {
    const years = await this.sortedYears();
    const year = this.yearToShow(years, asked.leaveYearId);
    const departments = await this.departments.list();
    const types = await this.types.list();

    return {
      ...report({
        year,
        employees: await this.employees.list(),
        departments,
        types,
        balances: await this.balances.forYear(year.id),
        filter: readReportFilter(asked, departments, types),
      }),
      years: years.map(reportYearOf),
      choices: reportChoicesOf(departments, types),
    };
  }

  private async sortedYears(): Promise<LeaveYear[]> {
    return [...(await this.years.list())].sort(byStartDate);
  }

  /** The year asked for, or the one covering today. */
  private yearToShow(years: readonly LeaveYear[], leaveYearId: string | undefined): LeaveYear {
    if (leaveYearId !== undefined) {
      const chosen = years.find((year) => year.id === leaveYearId);

      if (chosen === undefined) {
        throw new LeaveYearNotFound(leaveYearId);
      }

      return chosen;
    }

    const opening = theYearToOpenOn(years, this.today());

    if (opening === undefined) {
      throw new NoLeaveYearForTheReport();
    }

    return opening;
  }

  /** Today, in UTC. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}
