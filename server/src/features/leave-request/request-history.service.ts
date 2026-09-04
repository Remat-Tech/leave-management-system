/** The request history screen, assembled. FR 54, §7.4., LMS 402, FR 55, FR 56. */

import type { Actor } from '../../auth/actor.js';
import { leaveRequestPolicy } from './policy.js';
import { leaveTypePolicy } from '../leave-type/policy.js';
import { leaveYearPolicy } from '../leave-year/policy.js';
import type { BalanceOwner } from '../balance/policy.js';
import type { Guard } from '../../auth/policy.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import type { LeaveDecision } from './leave-decision.js';
import { type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import { historyFor, type RequestHistory, yearsWithRequests } from './request-history.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveDecisionRepository } from './leave-decision.db.js';
import type { LeaveRequestRepository } from './leave-request.db.js';
import type { LeaveRoutingRepository } from './routing.db.js';
import type { WithdrawalRepository } from './withdrawal.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';

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
    /** FR 48b. The stages each request's routing skipped. LMS 320. */
    private readonly routing: LeaveRoutingRepository,
    /** FR 47. The asks to take agreed leave off the books, and HR's answers. LMS 324. */
    private readonly withdrawals: WithdrawalRepository,
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
      /** FR 48b. A skipped stage is not still owed an answer. LMS 320. */
      skipped: await this.routing.forRequests(shown.map((request) => request.id)),
      /** FR 47, LMS 324. */
      withdrawals: await this.withdrawals.forRequests(shown.map((request) => request.id)),
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
