/** The nightly balance reconciliation. §7.4., LMS 213, LMS 211, §5.7. */

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

/** Who hears about a discrepancy. §10. */
const TOLD_ABOUT_A_DISCREPANCY: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

export class BalanceReconciliation {
  constructor(
    /** Two reads and no writer, which is the third acceptance criterion in the constructor. */
    private readonly checks: ReconciliationRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** Who holds an HR role, so that the list of who to tell is never a copy. */
    private readonly roles: RoleRepository,
    /** Their work addresses, which are the employee record's rather than a setting's. */
    private readonly employees: EmployeeRepository,
    private readonly mailer: Mailer,
  ) {}

  /** Compares every balance with the ledger, and tells HR about anything that disagrees. */
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

  /** Sends the report to everybody in HR, and records who it reached. */
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

  /** The work addresses of everybody holding an HR role. */
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

      if (employee !== undefined) {
        addresses.add(employee.workEmail);
      }
    }

    return [...addresses].sort();
  }
}

/** The alert, as an envelope round the report. */
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
