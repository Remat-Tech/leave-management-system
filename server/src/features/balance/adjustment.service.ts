/** The balance adjustment screen, assembled. FR 37, FR 27, LMS 506. */

import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import { employeePolicy } from '../employee/policy.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { BalanceStatement } from './balance-statement.js';
import type { BalanceStatementService } from './balance-statement.service.js';
import { type LedgerEntry, movementInWords } from './ledger.js';
import type { LedgerService } from './ledger.service.js';

/** One movement, with what a reader needs beside it. FR 27, LMS 211. */
export interface Movement extends LedgerEntry {
  /** The figure the balance stood at after it. */
  after: number;
  /** The leave type's name, so a row reads on its own. */
  typeName: string;
  /** Which kind of movement, in words. */
  inWords: string;
}

/** Somebody whose balance can be put right. */
export interface AdjustableEmployee {
  id: string;
  name: string;
  employeeNumber: string;
  jobTitle: string | null;
  /** FR 06. In the list and marked: a leaver's figures are still corrected. */
  hasLeft: boolean;
}

/** One person's balances for one year, and every movement behind them. */
export interface AdjustmentView {
  employee: AdjustableEmployee;
  statement: BalanceStatement;
  ledger: Movement[];
}

export class BalanceAdjustmentService {
  constructor(
    /** The figures as they stand, and the years to choose between. LMS 401. */
    private readonly statements: BalanceStatementService,
    /** FR 27. The movements those figures are made of. */
    private readonly ledger: LedgerService,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** The directory behind the picker, and the one name on the heading. */
    private readonly employees: EmployeeRepository,
    /** The names on the ledger rows. */
    private readonly types: LeaveTypeRepository,
  ) {}

  /**
   * Everybody whose balance could be adjusted. FR 06.
   *
   * A refusal rather than an empty list, unlike `OrganisationService.whoCouldBeNamed`: the
   * picker is the whole screen, so somebody who cannot use it has nothing to be shown.
   */
  async whoCanBeAdjusted(actor: Actor): Promise<AdjustableEmployee[]> {
    this.guard.enforce(employeePolicy.list(actor));

    return (await this.employees.list()).map(adjustable);
  }

  /**
   * One person's balances for one year, with the movements behind them. FR 27, FR 37.
   *
   * The statement is read first, so the read rule decides before anything about the record
   * is in hand. The year it settles on is the year the movements are read for, so the two
   * halves of the screen are never about different years.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    leaveYearId?: string,
  ): Promise<AdjustmentView> {
    const statement = await this.statements.forEmployee(actor, employeeId, { leaveYearId });

    const entries = await this.ledger.history(actor, employeeId, {
      leaveYearId: statement.year.id,
    });

    const names = new Map((await this.types.list()).map((type) => [type.id, type.name]));

    return {
      employee: adjustable(await this.require(employeeId)),
      statement,
      /* A type retired since the movement was written still has a name, so the id is a
         fallback nothing should reach rather than a label. */
      ledger: entries.map((entry) => ({
        ...entry,
        typeName: names.get(entry.leaveTypeId) ?? entry.leaveTypeId,
        inWords: movementInWords(entry.entryType),
      })),
    };
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

function adjustable(employee: Employee): AdjustableEmployee {
  return {
    id: employee.id,
    name: `${employee.firstName} ${employee.lastName}`,
    employeeNumber: employee.employeeNumber,
    jobTitle: employee.jobTitle,
    hasLeft: employee.employmentStatus === 'TERMINATED',
  };
}
