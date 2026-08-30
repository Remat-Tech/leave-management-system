/**
 * The annual grant of entitlement. FR 30. LMS 214.
 *
 * The second thing in `/jobs`, and the one an employee actually feels. Everything
 * before it could record days moving and add them up; nothing had put any there. This
 * is where a balance stops being nought and somebody can plan a year.
 *
 * ## What it does, once per leave year
 *
 * Every active employee, every leave type with a yearly balance, one decision each —
 * {@link decideTheGrant} — and a `GRANT` posted through the one door that writes
 * movements. The figure is the entitlement rule in force **on the first day of the
 * year**, resolved by `EntitlementRuleService`: asking on any other day would grant a
 * figure that was not in force when the year began, which is the whole reason that
 * question takes a date.
 *
 * ## Running it twice is safe, and that is the design rather than a caution
 *
 * The realistic failure of an annual job is not that it runs twice by accident. It is
 * that it fails at employee three hundred on a January morning and somebody has to run
 * it again. So each grant is its own transaction — the first two hundred and
 * ninety-nine keep theirs — and a second grant against a balance that already has one
 * is refused inside the lock by `BalanceService.grantTheYear`, not by this job
 * remembering. A job that remembers is a job that forgets.
 *
 * The refusal is caught here and reported as an outcome rather than an error, because
 * on a re-run it is the *expected* outcome for almost every employee.
 *
 * ## What it passes over, and says it has
 *
 * Four reasons, and each is reported rather than skipped quietly. That matters more
 * than it looks: "the grant ran and Ama has nothing" is a support call, and the
 * difference between it being a two minute answer and an afternoon is whether the run
 * said why.
 *
 * The one worth naming here is the joiner. Somebody who started in July is owed a
 * proportion rather than the whole figure — FR 29, §8.6d — and that is a story with a
 * formula in it. Granting them the year and correcting it afterwards would mean
 * somebody planning a year around days they were never owed, which is the failure this
 * story exists to prevent rather than an approximation of success.
 *
 * ## It is a class, not a schedule
 *
 * As with ./balance-reconciliation.ts: "at the start of each leave year" is a line in
 * something that runs on a timer, and this build has no process to hang one on. What
 * this ships is the run.
 */

import type { Actor } from '../auth/actor.js';
import {
  type AnnualGrantRun,
  decideTheGrant,
  type Granted,
  type NotGranted,
  wasGranted,
} from '../domain/annual-grant.js';
import { AlreadyGranted } from '../domain/balance.js';
import type { Employee } from '../domain/employee.js';
import { hasRunningBalance, isEligible, type LeaveType } from '../domain/leave-type.js';
import type { LeaveYear } from '../domain/leave-year.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { BalanceService } from '../services/balance-service.js';
import type { EntitlementRuleService } from '../services/entitlement-rule-service.js';
import type { LeaveYearService } from '../services/leave-year-service.js';

export class AnnualGrant {
  constructor(
    /**
     * The one door that writes a movement. LMS 212.
     *
     * A service rather than a repository, and it is the whole reason this job holds no
     * `LedgerRepository`: the check that a year is granted once lives inside the lock
     * there, so a job that wrote its own entries would be posting grants without it.
     */
    private readonly balances: BalanceService,
    /** Which year is being granted, and when it began. */
    private readonly years: LeaveYearService,
    /** What each type is worth to each person, as at the first day of that year. */
    private readonly entitlements: EntitlementRuleService,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
  ) {}

  /**
   * Grants a leave year to everybody it is owed to.
   *
   * Returns what it did either way, granted and not granted, because the caller is a
   * scheduler and a run that silently did nothing is indistinguishable from one that
   * did not happen.
   *
   * The actor is carried all the way through rather than swapped for a system actor
   * partway: the policy is asked with it, the entitlement rules are read with it, and
   * every ledger entry carries its name. An annual run's entries say "the system (the
   * annual grant of entitlement)" and an HR Administrator's say who they are, which is
   * the difference somebody reading a balance in March needs.
   */
  async run(actor: Actor, leaveYearId: string): Promise<AnnualGrantRun> {
    const year = await this.years.byId(actor, leaveYearId);
    const grantedAt = new Date();

    const granted: Granted[] = [];
    const notGranted: NotGranted[] = [];

    const everybody = await this.employees.list({ activeOnly: true });
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

  /**
   * One person, one leave type.
   *
   * The decision is ../domain/annual-grant.ts's and the write is
   * `BalanceService.grantTheYear`'s; what is left here is fetching the one figure the
   * decision needs and turning the refusal into a line of the report.
   */
  private async grantOne(
    actor: Actor,
    year: LeaveYear,
    employee: Employee,
    type: LeaveType,
  ): Promise<Granted | NotGranted> {
    const named = {
      employeeId: employee.id,
      employeeNumber: employee.employeeNumber,
      leaveTypeId: type.id,
      leaveTypeName: type.name,
    };

    /* Only asked for somebody who could be granted. A joiner is passed over whatever
       the rule says, and reading a rule to answer a question already settled would be a
       query per employee for nothing. */
    const rule =
      employee.startDate > year.startDate || !isEligible(type, employee.gender)
        ? undefined
        : await this.entitlements.entitlementOn(actor, employee, type.id, year.startDate);

    const decision = decideTheGrant({
      startedOn: employee.startDate,
      yearBeganOn: year.startDate,
      entitlementDays: rule?.entitlementDays,
      eligible: isEligible(type, employee.gender),
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
        reason: `${type.name} entitlement for ${year.label}`,
      });

      return { ...named, days: decision.days, entryId: entry.id };
    } catch (error) {
      /* The expected outcome of a re-run, for almost everybody. Caught rather than
         prevented, because the thing that knows a year has been granted is the ledger,
         read inside the lock that makes the answer still true when the entry is
         written. Anything else — a closed year, a rule that has since gone — is a
         genuine failure of this run and is not this job's to swallow. */
      if (error instanceof AlreadyGranted) {
        return { ...named, because: 'ALREADY_GRANTED' };
      }

      throw error;
    }
  }
}
