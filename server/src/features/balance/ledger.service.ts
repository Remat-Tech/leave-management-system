/**
 * Reading the balance ledger. FR 27, §5.7., LMS 210, LMS 212, FR 37, FR 55, §5.7, §7.4, LMS 211, FR 25.
 */

import type { Actor } from '../../auth/actor.js';
import { type BalanceOwner, ledgerPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import type { Employee } from '../employee/employee.js';
import { EmployeeNotFound } from '../employee/employee.js';
import {
  type LedgerEntry,
  LedgerEntryNotFound,
  type LedgerEntryType,
  runningTotal,
} from './ledger.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LedgerRepository } from './ledger.db.js';

/** Which slice of a balance's history to read. */
export interface HistoryOptions {
  /** One leave type, or every one. */
  leaveTypeId?: string;
  /** One leave year, or every one. */
  leaveYearId?: string;
  /** Only these kinds of movement. FR 32b. */
  entryTypes?: readonly LedgerEntryType[];
}

export class LedgerService {
  constructor(
    private readonly entries: LedgerRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** The employee records, for one question only: who is this person's line manager. FR 55. */
    private readonly employees: EmployeeRepository,
  ) {}

  /**
   * Every movement in one balance, oldest first, with the figure each left behind. FR 53, FR 55, FR 56, LMS 211.
   */
  async history(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<(LedgerEntry & { after: number })[]> {
    await this.mayRead(actor, employeeId);

    return runningTotal(await this.entries.entriesFor({ employeeId, ...options }));
  }

  /** One entry, with everything that puts it right and everything it puts right. */
  async explain(actor: Actor, entryId: string): Promise<LedgerEntry[]> {
    const entry = await this.entries.findById(entryId);

    if (entry === undefined) {
      throw new LedgerEntryNotFound(entryId);
    }

    await this.mayRead(actor, entry.employeeId);

    return this.entries.correctionsAround(entryId);
  }

  /** Enforces the read rule, having found out whose balance this is. */
  private async mayRead(actor: Actor, employeeId: string): Promise<void> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(employeeId)));
  }

  /** Whose balance this is, and who their line manager is. */
  private async ownerOf(employeeId: string): Promise<BalanceOwner> {
    const employee: Employee | undefined = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return { employeeId: employee.id, managerId: employee.managerId };
  }
}
