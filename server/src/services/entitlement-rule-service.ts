/**
 * Setting what a leave type is worth, and asking what it was worth on a day.
 * FR 31, §5.5. LMS 203.
 *
 * The story's "so that" is the specification of this file: changing a figure this
 * year never silently rewrites what people were owed last year. Everything below
 * is one of the three things that makes that true.
 *
 *   **A figure is added, never edited.** {@link EntitlementRuleService.create} is
 *   how HR raises annual leave to twenty two days: a new rule, effective from a
 *   date. The twenty day rule stays exactly where it is and goes on answering
 *   every question about the days it covered.
 *
 *   **A rule that has applied to somebody cannot be touched.**
 *   {@link EntitlementRuleService.correct} and
 *   {@link EntitlementRuleService.withdraw} work on drafts — rules dated to start
 *   after today — and refuse everything else. The refusal is not this service's
 *   alone: the entitlement-rule-effective-dates migration holds the same rule as a
 *   trigger, so a correction typed at a psql prompt is refused too.
 *
 *   **Nothing may reach back into a closed leave year.** The boundary comes from
 *   {@link EarliestOpenDay}, which since LMS 205 is {@link earliestOpenDayFrom}
 *   reading `leave_year`. Passed in rather than read here, so that this service
 *   does not become a second place that decides what a closed year is — and so
 *   that it is asked again on every write, because the rollover of LMS 217 closes
 *   a year while this process is running.
 *
 * ## What it does not do
 *
 * **No resolving of its own.** Which of several rules applies is
 * {@link resolve} in ../domain/entitlement-rule.ts, and this file calls it. The
 * repository hands back candidates and orders nothing; there is no view. One
 * implementation, unit tested without a database — which is the criterion the
 * story states.
 *
 * **No granting.** A resolved rule is a figure, not days in somebody's balance.
 * Writing the grant is the ledger, LMS 210 and LMS 211, and it is the other half
 * of why last year cannot move: a grant is an entry recording what the figure was
 * on the day it was written.
 *
 * **No pro rating.** {@link EntitlementRule.prorateOnJoin} says whether a joiner's
 * first year is a proportion. What the proportion is, is LMS 013's formula,
 * applied by LMS 215.
 *
 * **No authorisation rules.** Every method takes an {@link Actor} and asks
 * ../auth/entitlement-rule-policy.ts. The one worth knowing without reading it:
 * a company-wide figure is policy and is open, a figure naming a person is that
 * person's and is not.
 */

import type { Actor } from '../auth/actor.js';
import { entitlementRulePolicy } from '../auth/entitlement-rule-policy.js';
import type { Guard } from '../auth/policy.js';
import type { Employee } from '../domain/employee.js';
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
} from '../domain/entitlement-rule.js';
import type {
  EntitlementRuleListOptions,
  EntitlementRuleRepository,
} from '../repositories/entitlement-rule-repository.js';
import { type CalendarDate, calendarDateIn } from '../domain/time.js';

export class EntitlementRuleService {
  constructor(
    private readonly rules: EntitlementRuleRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * Where a closed leave year ends. {@link earliestOpenDayFrom} since LMS 205;
     * {@link NOTHING_IS_CLOSED_YET} for a caller with no leave years to read.
     */
    private readonly earliestOpenDay: EarliestOpenDay,
  ) {}

  /**
   * Adds a rule. This is how every figure in the system changes.
   *
   * Refuses a rule dated into a closed year — {@link ReachesIntoAClosedYear} —
   * and a second rule for the same scope starting on the same day, which has no
   * order between it and the first: {@link DuplicateEntitlementRule}.
   *
   * It does *not* refuse a rule that overlaps one already there, and that is the
   * design rather than a gap. Overlapping is what changing a figure looks like:
   * "twenty days from 2026" and "twenty two days from 2027" are both open ended
   * and both apply to 2027, and the later start is the one that wins. Making HR
   * close the old rule first would be two operations where the second can be
   * forgotten, and a forgotten one leaves a year with no figure at all.
   */
  async create(actor: Actor, input: NewEntitlementRule): Promise<EntitlementRule> {
    this.guard.enforce(entitlementRulePolicy.create(actor));

    const validated = validateNewEntitlementRule(input);

    assertDoesNotReachIntoAClosedYear(validated.effectiveFrom, await this.earliestOpenDay());

    return this.rules.create(actor, validated);
  }

  /**
   * Corrects a rule that has not started yet.
   *
   * The narrow operation, and it is narrow on purpose. A figure HR set for next
   * January and then thought better of is a draft: nothing has been calculated
   * from it and nobody has planned against it, so fixing the row is honest and
   * leaves the table saying what the policy is rather than what two versions of it
   * were.
   *
   * The moment the rule starts applying, this refuses —
   * {@link EntitlementRuleAlreadyApplies} — and says the same thing FR 31 says:
   * add a rule from a later date. That is not a way around the refusal, it is
   * what changing an entitlement is.
   */
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

  /**
   * Removes a rule that never applied to anybody.
   *
   * The one delete in the configuration half of this system, and the reason it is
   * allowed here and refused for a leave type is what the row is. A leave type is
   * the heading last year's report is filed under whatever its age. A rule dated
   * to start next January has produced nothing and heads nothing, and leaving a
   * mistake in the table to fire on the first of the month is worse than removing
   * it.
   */
  async withdraw(actor: Actor, id: string): Promise<void> {
    this.guard.enforce(entitlementRulePolicy.withdraw(actor, id));

    const current = await this.require(id);

    assertMayBeCorrected(current, this.today(), 'withdrawn');

    const removed = await this.rules.remove(actor, current);
    if (!removed) {
      throw new EntitlementRuleNotFound(id);
    }
  }

  /**
   * One rule, if this actor may see it.
   *
   * A rule naming nobody is policy and is open; one naming a person is theirs and
   * HR's. A rule that is not there refuses whoever could not have gone looking for
   * it in the first place, so that an id which exists and an id which does not
   * give the same answer — the same arrangement {@link EmployeeService.byId} makes.
   */
  async byId(actor: Actor, id: string): Promise<EntitlementRule> {
    const rule = await this.rules.findById(id);

    if (rule === undefined) {
      this.guard.enforce(entitlementRulePolicy.list(actor));
      throw new EntitlementRuleNotFound(id);
    }

    this.guard.enforce(entitlementRulePolicy.read(actor, rule));

    return rule;
  }

  /**
   * Rules, newest starting date first. HR's, because the list of personal
   * arrangements is a list of who has one.
   */
  async list(actor: Actor, options: EntitlementRuleListOptions = {}): Promise<EntitlementRule[]> {
    this.guard.enforce(entitlementRulePolicy.list(actor));

    return this.rules.list(options, this.today());
  }

  /**
   * What one person is entitled to for one type, on one day. The headline read.
   *
   * Undefined where no rule applies, which is an answer and not a failure: unpaid
   * leave has no figure at all, because FR 32h is agreed occasion by occasion. A
   * caller has to decide what that means for them, and throwing here would make
   * every one of them catch it.
   *
   * The day is required. There is no undated form of this question anywhere in the
   * system, and that is most of what makes a closed year safe — a balance
   * recalculated for last March asks about last March, and gets the rule that
   * covered it however many times the figure has changed since.
   */
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

  /**
   * Every rule that applied to somebody on a day, best first.
   *
   * What a screen shows when somebody asks why they get twenty five days: the
   * personal rule that won and the company rule it beat, in the order the
   * precedence rule put them. Built here rather than in the interface, so that
   * "which one wins" is never worked out twice.
   */
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

  /**
   * The rules that could answer for this person, once the policy has allowed the
   * question.
   *
   * The employee record is passed in by the caller rather than read here, the same
   * way {@link LeaveTypeService.offeredTo} takes one: this service must never
   * become a second place that decides who may read an employee record.
   */
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

  /**
   * Today, in UTC, which is the day the database's `current_date` is having.
   *
   * The same clock as the trigger that refuses to rewrite a rule in effect, so the
   * service and the database can never disagree about whether a rule has started —
   * and a disagreement there would be a form that accepts a change the write then
   * refuses. Accra is UTC+0 all year, so it is also the day the person at the
   * screen is having; NFR DAT 03 and ../domain/time.ts.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}
