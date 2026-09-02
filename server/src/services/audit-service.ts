/** Reading the account of what happened. NFR AUD 01, NFR AUD 02, LMS 113. */

import { auditPolicy } from '../auth/audit-policy.js';
import type { Actor } from '../auth/actor.js';
import type { Guard } from '../auth/policy.js';
import type { AuditEntry } from '../domain/audit.js';
import { EmployeeNotFound } from '../domain/employee.js';
import type { AuditRepository, HistoryOptions } from '../repositories/audit-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';

export class AuditService {
  constructor(
    private readonly entries: AuditRepository,
    private readonly employees: EmployeeRepository,
    private readonly accounts: SignInAccountRepository,
    private readonly guard: Guard,
  ) {}

  /** How this person's record came to say what it says. */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    const employee = await this.findOrRefuse(actor, employeeId);

    this.guard.enforce(auditPolicy.forEmployee(actor, employee));

    return this.entries.forSubjects([{ entity: 'employee', entityId: employee.id }], options);
  }

  /** When their login and their roles changed, and who changed them. */
  async forAccess(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    await this.findOrRefuse(actor, employeeId);

    this.guard.enforce(auditPolicy.forAccess(actor, employeeId));

    const account = await this.accounts.findByEmployeeId(employeeId);
    if (account === undefined) {
      return [];
    }

    return this.entries.forSubjects(
      [
        { entity: 'app_user', entityId: account.id },
        { entity: 'user_role', entityId: account.id },
      ],
      options,
    );
  }

  /** Who renamed a team, closed it, and when. */
  async forDepartment(
    actor: Actor,
    departmentId: string,
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    this.guard.enforce(auditPolicy.forOrganisation(actor, 'department', departmentId));

    return this.entries.forSubjects([{ entity: 'department', entityId: departmentId }], options);
  }

  /** How a working week came to be what it is. FR 23. */
  async forWorkPattern(
    actor: Actor,
    workPatternId: string,
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    this.guard.enforce(auditPolicy.forOrganisation(actor, 'work pattern', workPatternId));

    return this.entries.forSubjects(
      [
        { entity: 'work_pattern', entityId: workPatternId },
        { entity: 'work_pattern_day', entityId: workPatternId },
      ],
      options,
    );
  }

  /** What has been happening, newest first. */
  async recent(
    actor: Actor,
    options: HistoryOptions & { actorEmployeeId?: string } = {},
  ): Promise<AuditEntry[]> {
    this.guard.enforce(auditPolicy.browse(actor));

    return this.entries.recent(options);
  }

  /** How many times this record has changed. */
  async countForEmployee(actor: Actor, employeeId: string): Promise<number> {
    const employee = await this.findOrRefuse(actor, employeeId);

    this.guard.enforce(auditPolicy.forEmployee(actor, employee));

    return this.entries.countFor({ entity: 'employee', entityId: employee.id });
  }

  /** The record, or the right refusal for an id that is nobody. */
  private async findOrRefuse(actor: Actor, employeeId: string) {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      this.guard.enforce(auditPolicy.browse(actor));
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }
}
