/**
 * Setting what a leave type is worth, and asking what it was worth on a day. FR 31, §5.5., LMS 203, LMS 205, LMS 217, LMS 210, LMS 211, LMS 013, LMS 215.
 */

import type { Actor } from '../../auth/actor.js';
import { entitlementRulePolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import type { Employee } from '../employee/employee.js';
import {
  assertDoesNotReachIntoAClosedYear,
  assertMayBeCorrected,
  type EarliestOpenDay,
  type EntitlementRule,
  type EntitlementRuleChanges,
  EntitlementRuleNotFound,
  type NewEntitlementRule,
  resolve,
  rulesInForce,
  validateEntitlementRuleChanges,
  validateNewEntitlementRule,
} from './entitlement-rule.js';
import type {
  EntitlementRuleListOptions,
  EntitlementRuleRepository,
} from './entitlement-rule.db.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';

export class EntitlementRuleService {
  constructor(
    private readonly rules: EntitlementRuleRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** Where a closed leave year ends. LMS 205. */
    private readonly earliestOpenDay: EarliestOpenDay,
  ) {}

  /** Adds a rule. */
  async create(actor: Actor, input: NewEntitlementRule): Promise<EntitlementRule> {
    this.guard.enforce(entitlementRulePolicy.create(actor));

    const validated = validateNewEntitlementRule(input);

    assertDoesNotReachIntoAClosedYear(validated.effectiveFrom, await this.earliestOpenDay());

    return this.rules.create(actor, validated);
  }

  /** Corrects a rule that has not started yet. FR 31. */
  async correct(
    actor: Actor,
    id: string,
    changes: EntitlementRuleChanges,
  ): Promise<EntitlementRule> {
    this.guard.enforce(entitlementRulePolicy.correct(actor, id));

    const current = await this.require(id);

    assertMayBeCorrected(current, this.today(), 'changed');

    const validated = validateEntitlementRuleChanges(changes, current);

    if (validated.effectiveFrom !== undefined) {
      assertDoesNotReachIntoAClosedYear(validated.effectiveFrom, await this.earliestOpenDay());
    }

    const updated = await this.rules.update(actor, current, validated);
    if (updated === undefined) {
      // Withdrawn between the read and the write, which is possible: another
      // administrator may remove a draft while this one has the form open.
      throw new EntitlementRuleNotFound(id);
    }

    return updated;
  }

  /** Removes a rule that never applied to anybody. */
  async withdraw(actor: Actor, id: string): Promise<void> {
    this.guard.enforce(entitlementRulePolicy.withdraw(actor, id));

    const current = await this.require(id);

    assertMayBeCorrected(current, this.today(), 'withdrawn');

    const removed = await this.rules.remove(actor, current);
    if (!removed) {
      throw new EntitlementRuleNotFound(id);
    }
  }

  /** One rule, if this actor may see it. */
  async byId(actor: Actor, id: string): Promise<EntitlementRule> {
    const rule = await this.rules.findById(id);

    if (rule === undefined) {
      this.guard.enforce(entitlementRulePolicy.list(actor));
      throw new EntitlementRuleNotFound(id);
    }

    this.guard.enforce(entitlementRulePolicy.read(actor, rule));

    return rule;
  }

  /** Rules, newest starting date first. */
  async list(actor: Actor, options: EntitlementRuleListOptions = {}): Promise<EntitlementRule[]> {
    this.guard.enforce(entitlementRulePolicy.list(actor));

    return this.rules.list(options, this.today());
  }

  /** What one person is entitled to for one type, on one day. FR 32h. */
  async entitlementOn(
    actor: Actor,
    employee: Employee,
    leaveTypeId: string,
    on: CalendarDate,
  ): Promise<EntitlementRule | undefined> {
    return resolve(await this.candidatesFor(actor, employee, leaveTypeId), {
      employeeId: employee.id,
      departmentId: employee.departmentId,
      on,
    });
  }

  /** Every rule that applied to somebody on a day, best first. */
  async rulesInForceOn(
    actor: Actor,
    employee: Employee,
    leaveTypeId: string,
    on: CalendarDate,
  ): Promise<readonly EntitlementRule[]> {
    return rulesInForce(await this.candidatesFor(actor, employee, leaveTypeId), {
      employeeId: employee.id,
      departmentId: employee.departmentId,
      on,
    });
  }

  /** The rules that could answer for this person, once the policy has allowed the question. */
  private async candidatesFor(
    actor: Actor,
    employee: Employee,
    leaveTypeId: string,
  ): Promise<EntitlementRule[]> {
    this.guard.enforce(entitlementRulePolicy.entitlementOf(actor, employee));

    return this.rules.candidatesFor({
      leaveTypeId,
      employeeId: employee.id,
      departmentId: employee.departmentId,
    });
  }

  private async require(id: string): Promise<EntitlementRule> {
    const rule = await this.rules.findById(id);
    if (rule === undefined) {
      throw new EntitlementRuleNotFound(id);
    }
    return rule;
  }

  /** Today, in UTC, which is the day the database's `current_date` is having. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}
