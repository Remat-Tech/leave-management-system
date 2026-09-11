/** The leaver figure, assembled. FR 37a, §8.6d, §8.7, LMS 509. */

import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import { type BalanceOwner, ledgerPolicy } from './policy.js';
import { employeePolicy } from '../employee/policy.js';
import { leaveTypePolicy } from '../leave-type/policy.js';
import { leaveYearPolicy } from '../leave-year/policy.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import { hasRunningBalance } from '../leave-type/leave-type.js';
import { yearFor } from '../leave-year/leave-year.js';
import {
  exitDateOf,
  type LeaverSettlement,
  NoLeaveYearCoversTheExitDate,
  settlementFor,
  type TypeAndRule,
} from './leaver-statement.js';
import type { BalanceRepository } from './balance.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import type { EntitlementRuleService } from '../entitlement/entitlement-rule.service.js';

/** Somebody who has left, as the picker lists them. FR 06. */
export interface Leaver {
  id: string;
  name: string;
  employeeNumber: string;
  jobTitle: string | null;
  exitDate: string | null;
}

export class LeaverStatementService {
  constructor(
    /** The cached balance the figure is settled against. */
    private readonly balances: BalanceRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** The two dates the accrual is clipped to, and whose manager the policy asks about. */
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    private readonly years: LeaveYearRepository,
    /** What each type is worth to this person on the day they left. FR 32h. */
    private readonly entitlements: EntitlementRuleService,
  ) {}

  /** Everybody who has left. FR 06. */
  async whoHasLeft(actor: Actor): Promise<Leaver[]> {
    this.guard.enforce(employeePolicy.list(actor));

    return (await this.employees.list())
      .filter((employee) => employee.employmentStatus === 'TERMINATED')
      .map(asLeaver)
      .sort(byExitDate);
  }

  /**
   * One leaver's final figure, with its working. FR 37a.
   *
   * The read rule is the balance's, because this is that balance settled rather than a new
   * kind of record: theirs, their manager's, or a role that reads everybody.
   */
  async forEmployee(actor: Actor, employeeId: string): Promise<LeaverSettlement> {
    const employee = await this.require(employeeId);

    this.guard.enforce(ledgerPolicy.read(actor, ownerOf(employee)));
    this.guard.enforce(leaveTypePolicy.list(actor));
    this.guard.enforce(leaveYearPolicy.list(actor));

    const exitDate = exitDateOf(employee);

    const year = yearFor(await this.years.list(), exitDate);

    if (year === undefined) {
      throw new NoLeaveYearCoversTheExitDate(employee, exitDate);
    }

    return settlementFor({
      employee,
      exitDate,
      year,
      entitlements: await this.entitlementsOn(actor, employee, exitDate),
      balances: await this.balances.forEmployee(employeeId, year.id),
    });
  }

  /**
   * Each type with the rule reaching this person on their last day. FR 32h.
   *
   * One query per type with a running balance, which is three of them. An event type has no
   * yearly figure to pro rate, so it is not asked about at all.
   */
  private async entitlementsOn(
    actor: Actor,
    employee: Employee,
    exitDate: string,
  ): Promise<TypeAndRule[]> {
    const types = (await this.types.list()).filter(hasRunningBalance);

    return Promise.all(
      types.map(async (type) => ({
        type,
        rule: await this.entitlements.entitlementOn(actor, employee, type.id, exitDate),
      })),
    );
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

function asLeaver(employee: Employee): Leaver {
  return {
    id: employee.id,
    name: `${employee.firstName} ${employee.lastName}`,
    employeeNumber: employee.employeeNumber,
    jobTitle: employee.jobTitle,
    exitDate: employee.exitDate,
  };
}

/** Most recently gone first, which is the order HR works through them in. */
function byExitDate(one: Leaver, other: Leaver): number {
  return (
    (other.exitDate ?? '').localeCompare(one.exitDate ?? '') || one.name.localeCompare(other.name)
  );
}

function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
