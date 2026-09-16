/** Expiring carried days nobody used by the deadline. FR 36a. */

import type { Actor } from '../../auth/actor.js';
import type { LeaveBalance } from '../balance/balance.js';
import type { LeaveYear } from './leave-year.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import {
  type CarryoverExpiryRun,
  decideTheExpiry,
  type Expired,
  type NotExpired,
  reasonForExpiry,
  wasExpired,
} from './carryover-expiry.js';
import type { BalanceRepository } from '../balance/balance.db.js';
import type { BalanceService } from '../balance/balance.service.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { EntitlementRuleService } from '../entitlement/entitlement-rule.service.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from './leave-year.db.js';

export class CarryoverExpiry {
  constructor(
    /** The one door that writes a movement. LMS 212. */
    private readonly balances: BalanceService,
    /** Every balance in a year, to find the ones with carried days. */
    private readonly balanceRows: BalanceRepository,
    /** Which month carried days expire in. */
    private readonly entitlements: EntitlementRuleService,
    private readonly years: LeaveYearRepository,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
  ) {}

  /** Expires unused carried days in every open year whose deadline has passed. Safe to re-run. */
  async run(actor: Actor, asAt: CalendarDate = this.today()): Promise<CarryoverExpiryRun> {
    const ranAt = new Date();
    const expired: Expired[] = [];
    const notExpired: NotExpired[] = [];

    const years = (await this.years.list({ openOnly: true })).filter(
      (year) => year.startDate <= asAt,
    );

    for (const year of years) {
      for (const balance of await this.balanceRows.forYear(year.id)) {
        if (balance.carriedOver <= 0) {
          continue;
        }

        const outcome = await this.expireOne(actor, year, balance, asAt);

        if ('entryId' in outcome) {
          expired.push(outcome);
        } else {
          notExpired.push(outcome);
        }
      }
    }

    return { asAt, ranAt, expired, notExpired };
  }

  private async expireOne(
    actor: Actor,
    year: LeaveYear,
    balance: LeaveBalance,
    asAt: CalendarDate,
  ): Promise<Expired | NotExpired> {
    const type = await this.types.findById(balance.leaveTypeId);
    const employee = await this.employees.findById(balance.employeeId);

    const named = {
      employeeId: balance.employeeId,
      leaveTypeId: balance.leaveTypeId,
      leaveTypeName: type?.name ?? 'leave',
      leaveYearLabel: year.label,
    };

    /* The rule in force when the year began, so a mid-year rule cannot move this year's deadline. */
    const rule =
      employee === undefined
        ? undefined
        : await this.entitlements.entitlementOn(
            actor,
            employee,
            balance.leaveTypeId,
            year.startDate,
          );

    const decision = decideTheExpiry({
      yearStartDate: year.startDate,
      carryoverExpiryMonth: rule?.carriesOver ? rule.carryoverExpiryMonth : null,
      asAt,
      balance,
    });

    if (!wasExpired(decision)) {
      return { ...named, because: decision.because };
    }

    const { entry } = await this.balances.expireCarriedOver(actor, {
      employeeId: balance.employeeId,
      leaveTypeId: balance.leaveTypeId,
      leaveYearId: balance.leaveYearId,
      days: decision.days,
      reason: reasonForExpiry(named.leaveTypeName, year.label, decision.deadline),
    });

    return { ...named, deadline: decision.deadline, days: -entry.days, entryId: entry.id };
  }

  /** Today, in UTC. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}
