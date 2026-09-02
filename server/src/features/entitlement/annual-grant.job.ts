/** The annual grant of entitlement. FR 30, LMS 214, LMS 215, FR 29, §8.6. */

import type { Actor } from '../../auth/actor.js';
import {
  type AnnualGrantRun,
  decideTheGrant,
  type Granted,
  type NotGranted,
  reasonFor,
  wasGranted,
} from './annual-grant.js';
import { AlreadyGranted } from '../balance/balance.js';
import type { Employee } from '../employee/employee.js';
import { hasRunningBalance, isEligible, type LeaveType } from '../leave-type/leave-type.js';
import { employedPortionOf } from './pro-rata.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { BalanceService } from '../balance/balance.service.js';
import type { EntitlementRuleService } from './entitlement-rule.service.js';
import type { LeaveYearService } from '../leave-year/leave-year.service.js';

export class AnnualGrant {
  constructor(
    /** The one door that writes a movement. LMS 212. */
    private readonly balances: BalanceService,
    /** Which year is being granted, and when it began. */
    private readonly years: LeaveYearService,
    /** What each type is worth to each person, as at the first day of that year. */
    private readonly entitlements: EntitlementRuleService,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
  ) {}

  /** Grants a leave year to everybody it is owed to. */
  async run(
    actor: Actor,
    leaveYearId: string,
    /** One employee, for the joiner who should not wait until next January. */
    only: { employeeId?: string } = {},
  ): Promise<AnnualGrantRun> {
    const year = await this.years.byId(actor, leaveYearId);
    const grantedAt = new Date();

    const granted: Granted[] = [];
    const notGranted: NotGranted[] = [];

    const everybody = (await this.employees.list({ activeOnly: true })).filter(
      (employee) => only.employeeId === undefined || employee.id === only.employeeId,
    );
    const yearly = (await this.types.list({ offeredOnly: true })).filter(hasRunningBalance);

    for (const employee of everybody) {
      for (const type of yearly) {
        const outcome = await this.grantOne(actor, year, employee, type);

        if ('entryId' in outcome) {
          granted.push(outcome);
        } else {
          notGranted.push(outcome);
        }
      }
    }

    return {
      leaveYearId: year.id,
      leaveYearLabel: year.label,
      grantedAt,
      granted,
      notGranted,
    };
  }

  /** One person, one leave type. */
  private async grantOne(
    actor: Actor,
    year: LeaveYear,
    employee: Employee,
    type: LeaveType,
  ): Promise<Granted | NotGranted> {
    const yearDates = { startsOn: year.startDate, endsOn: year.endDate };

    const named = {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      leaveTypeId: type.id,
      leaveTypeName: type.name,
    };

    const eligible = isEligible(type, employee.gender);
    const employment = { startedOn: employee.startDate, leftOn: employee.exitDate };

    const rule =
      eligible && employedPortionOf(yearDates, employment) !== undefined
        ? await this.entitlements.entitlementOn(actor, employee, type.id, year.startDate)
        : undefined;

    const decision = decideTheGrant({
      year: yearDates,
      employment,
      entitlementDays: rule?.entitlementDays,
      /** FR 29, and the column HR sets per figure. */
      proRateAPartYear: rule?.prorateOnJoin ?? false,
      eligible,
    });

    if (!wasGranted(decision)) {
      return { ...named, because: decision.because };
    }

    try {
      const { entry } = await this.balances.grantTheYear(actor, {
        employeeId: employee.id,
        leaveTypeId: type.id,
        leaveYearId: year.id,
        days: decision.days,
        reason: reasonFor(type.name, year.label, decision),
      });

      return { ...named, days: decision.days, entryId: entry.id };
    } catch (error) {
      if (error instanceof AlreadyGranted) {
        return { ...named, because: 'ALREADY_GRANTED' };
      }

      throw error;
    }
  }
}
