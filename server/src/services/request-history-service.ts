/** The request history screen, assembled. FR 54, §7.4., LMS 402, FR 55, FR 56. */

import type { Actor } from '../auth/actor.js';
import { leaveRequestPolicy } from '../auth/leave-request-policy.js';
import { leaveTypePolicy } from '../auth/leave-type-policy.js';
import { leaveYearPolicy } from '../auth/leave-year-policy.js';
import type { BalanceOwner } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import { type Employee, EmployeeNotFound } from '../domain/employee.js';
import type { LeaveDecision } from '../domain/leave-decision.js';
import { type LeaveYear, LeaveYearNotFound } from '../domain/leave-year.js';
import { historyFor, type RequestHistory, yearsWithRequests } from '../domain/request-history.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveDecisionRepository } from '../repositories/leave-decision-repository.js';
import type { LeaveRequestRepository } from '../repositories/leave-request-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';

/** Which slice of somebody's history to show. */
export interface HistoryOptions {
  /** The year to narrow to, or nothing for every request there is. */
  leaveYearId?: string;
}

export class RequestHistoryService {
  constructor(
    private readonly requests: LeaveRequestRepository,
    /** FR 39, FR 52. */
    private readonly decisions: LeaveDecisionRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /**
     * The employee record, for two facts and no more: who their line manager is, which the policy decides on, and that the person exists at all.
     */
    private readonly employees: EmployeeRepository,
    /** For each request's type name and its approval chain as it stands. */
    private readonly types: LeaveTypeRepository,
    /** For the picker, and to tell a year that is nobody's from one that is empty. */
    private readonly years: LeaveYearRepository,
  ) {}

  /** One person's requests, newest first, each with the account of how it was decided. LMS 402. */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<RequestHistory> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));
    this.guard.enforce(leaveTypePolicy.list(actor));
    this.guard.enforce(leaveYearPolicy.list(actor));

    const asked = await this.requests.list({ employeeId: employee.id });

    const year = await this.yearToShow(options.leaveYearId);

    const shown =
      year === null ? asked : asked.filter((request) => request.leaveYearId === year.id);

    const decisions = await this.decisions.forRequests(shown.map((request) => request.id));

    return historyFor({
      employeeId: employee.id,
      year,
      years: yearsWithRequests(await this.years.list(), asked),
      requests: shown,
      types: await this.types.list(),
      decisions,
      deciders: await this.employees.findAllById(whoDecidedThem(decisions)),
    });
  }

  /** Which year this history is narrowed to, or null for all of them. */
  private async yearToShow(leaveYearId: string | undefined): Promise<LeaveYear | null> {
    if (leaveYearId === undefined) {
      return null;
    }

    const year = await this.years.findById(leaveYearId);

    if (year === undefined) {
      throw new LeaveYearNotFound(leaveYearId);
    }

    return year;
  }

  /** The record, or EmployeeNotFound. */
  private async require(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }
}

/** Whose requests these are, and who their line manager is. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}

/** The people to look up so a trail can name them. FR 52. */
function whoDecidedThem(decisions: readonly LeaveDecision[]): string[] {
  return [
    ...new Set(
      decisions
        .map((decision) => decision.decidedByEmployeeId)
        .filter((id): id is string => id !== null),
    ),
  ];
}
