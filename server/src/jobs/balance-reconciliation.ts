/**
 * The nightly balance reconciliation. §7.4. LMS 213.
 *
 * The first thing in `/jobs`, and the project structure has been holding a place for
 * it since the beginning: "scheduled work: reminders, rollover, reconciliation".
 *
 * The story is a sentence about who finds out first. Every balance in this system is a
 * cache of the ledger, kept in step by a trigger, and since LMS 211 there is no way for
 * an application to move one any other way. That is a strong guarantee and it is not
 * the same thing as a promise. A trigger disabled during a maintenance window, a
 * restore from a backup taken between two statements, a future migration moving rows
 * with `session_replication_role` set — every one of those leaves a balance quietly
 * wrong and a ledger quietly right, and nothing in the system notices.
 *
 * What notices today is an employee, looking at a figure they know is wrong. This job
 * is the alternative.
 *
 * ## Three things it does, and one it refuses to
 *
 *   **Recompute every balance from the ledger.** `what_the_ledger_says` is §5.7's
 *   projection — the same one `rebuild_one_balance_from_the_ledger()` writes from, so
 *   there is one definition rather than a checker that can only agree with itself.
 *
 *   **Report what disagrees.** Not that something disagrees: which balance, which of
 *   the five columns, what each side says, and how many days the person is out by.
 *
 *   **Alert somebody.** The people holding an HR role, found from the roles table
 *   rather than from a configured address, so the list stays right when somebody joins
 *   or leaves HR.
 *
 *   **It does not correct anything.** The third acceptance criterion, and the design
 *   is arranged so that it could not: {@link ReconciliationRepository} has two reads
 *   and no writer, and the views behind it cannot be written to. The temptation is
 *   real — the rebuild function is one call away and would empty the report — and
 *   giving in to it would destroy the evidence. A discrepancy is the only sign that
 *   something here does not work; a job that erases that sign at two every morning is
 *   one that guarantees nobody ever finds the cause.
 *
 * ## It is a class, not a schedule
 *
 * "Nightly" is a cron line, and this build has no process to hang one on: no server
 * entry point, no route layer, no scheduler. Inventing one to hold a single job would
 * be more infrastructure than the job. {@link BalanceReconciliation.run} is written to
 * be called by the first thing that runs on a timer, and the README says which line.
 */

import type { Actor } from '../auth/actor.js';
import { ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import type { RoleCode } from '../auth/roles.js';
import { isClean, type Reconciliation, reportOf } from '../domain/reconciliation.js';
import type { Mail } from '../mail/transport.js';
import type { Mailer } from '../mail/mailer.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { ReconciliationRepository } from '../repositories/reconciliation-repository.js';
import type { RoleRepository } from '../repositories/role-repository.js';

/**
 * Who hears about a discrepancy.
 *
 * HR, both desks, and the reason both are here where §10 usually distinguishes them:
 * this is not a power, it is being told. An HR Officer is who somebody walks up to
 * about a wrong figure, so they should not hear about it from that person first.
 *
 * `SYS_ADMIN` is deliberately not on the list. A wrong balance is an HR problem that
 * happens to have a technical cause, and the person who has to answer for the number
 * is in HR. Where the cause turns out to be technical, HR forwards it — which is one
 * more email and a great deal clearer than a system that tells administrators about
 * somebody's leave as a matter of routine.
 */
const TOLD_ABOUT_A_DISCREPANCY: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

export class BalanceReconciliation {
  constructor(
    /**
     * Two reads and no writer, which is the third acceptance criterion in the
     * constructor. See ../repositories/reconciliation-repository.ts.
     */
    private readonly checks: ReconciliationRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /** Who holds an HR role, so that the list of who to tell is never a copy. */
    private readonly roles: RoleRepository,
    /** Their work addresses, which are the employee record's rather than a setting's. */
    private readonly employees: EmployeeRepository,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Compares every balance with the ledger, and tells HR about anything that
   * disagrees.
   *
   * Returns what it found either way, including on a clean run — the caller is a
   * scheduler, and "checked 412 balances, all agree" is the line that makes a silent
   * night mean something.
   *
   * A clean run sends nothing. That is deliberate rather than a saving: a nightly
   * email saying nothing is wrong is a nightly email nobody reads by March, and the
   * one that matters arrives looking exactly like it.
   */
  async run(actor: Actor): Promise<Reconciliation> {
    this.guard.enforce(ledgerPolicy.reconcile(actor));

    const checkedAt = new Date();
    const [balancesChecked, disagreements] = await Promise.all([
      this.checks.balancesChecked(),
      this.checks.disagreements(),
    ]);

    const found: Reconciliation = {
      checkedAt,
      balancesChecked,
      disagreements,
      told: [],
      couldNotTell: [],
    };

    return isClean(found) ? found : this.alert(found);
  }

  /**
   * Sends the report to everybody in HR, and records who it reached.
   *
   * Every failure is caught and carried rather than thrown, and both halves of that
   * are deliberate. **Caught**, because one address that bounces must not stop the
   * other three people being told. **Carried rather than swallowed**, because a
   * discrepancy nobody was told about is the exact situation this job exists to
   * prevent, and it has to be visible to whatever ran the job.
   *
   * A run that found something and told nobody is the loudest thing in the returned
   * report: `told` is empty and `couldNotTell` says why — or, where nobody holds an HR
   * role at all, both are empty, and that is a company with a discrepancy and no HR,
   * which the report says plainly.
   */
  private async alert(found: Reconciliation): Promise<Reconciliation> {
    const told: string[] = [];
    const couldNotTell: { to: string; because: string }[] = [];
    const report = reportOf(found);

    for (const address of await this.addressesInHr()) {
      try {
        await this.mailer.send(discrepancyEmail(address, found, report));
        told.push(address);
      } catch (error) {
        couldNotTell.push({
          to: address,
          because: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { ...found, told, couldNotTell };
  }

  /**
   * The work addresses of everybody holding an HR role.
   *
   * Read through the roles rather than from a setting, so that somebody joining HR
   * starts being told and somebody leaving stops, without anybody remembering to edit
   * an environment variable. The addresses are the employee records' — the same ones
   * `app_user.company_email` is kept in step with, which is why there is no second
   * source to drift.
   *
   * Deduplicated, because holding both HR roles is ordinary and two copies of the same
   * email is how somebody learns to filter them.
   */
  private async addressesInHr(): Promise<string[]> {
    const ids = new Set<string>();

    for (const code of TOLD_ABOUT_A_DISCREPANCY) {
      for (const id of await this.roles.employeeIdsHolding(code)) {
        ids.add(id);
      }
    }

    const addresses = new Set<string>();

    for (const id of ids) {
      const employee = await this.employees.findById(id);

      /* A role held by somebody whose record has gone is not reachable, and is not an
         error either: `employeeIdsHolding` reads a join that a terminated employee
         still appears in. Nothing to tell, nothing to report — the address simply is
         not there. */
      if (employee !== undefined) {
        addresses.add(employee.workEmail);
      }
    }

    return [...addresses].sort();
  }
}

/**
 * The alert, as an envelope round the report.
 *
 * A pure function, beside the job that sends it, exactly as `codeEmail` sits beside
 * the code rules in ../auth/mfa.ts. Exported so the suite can read what it said rather
 * than only that something was sent — which is where every interesting failure in an
 * email lives.
 *
 * **The subject carries the count.** Somebody scanning a mailbox has to be able to
 * tell "one balance is out by half a day" from "four hundred are" without opening
 * anything, because those are a Monday morning job and a Sunday night phone call.
 */
export function discrepancyEmail(to: string, found: Reconciliation, report: string): Mail {
  const howMany = found.disagreements.length;

  return {
    to,
    subject:
      howMany === 1
        ? 'A leave balance disagrees with the ledger'
        : `${howMany} leave balances disagree with the ledger`,
    text: report,
  };
}
