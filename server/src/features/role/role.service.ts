/** Assigning roles. §5.3., LMS 111, LMS 112, LMS 113. */

import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import { rolePolicy } from './policy.js';
import {
  ASSIGNABLE_ROLES,
  type Authority,
  BASELINE_ROLE,
  LastSystemAdministrator,
  readAssignableRoleCode,
  readRoleCode,
  RoleCannotBeRevoked,
  type RoleCode,
  RoleNotHeld,
} from './roles.js';
import { SignInAccountNotFound } from '../sign-in/sign-in.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import {
  BASELINE_TRIGGER,
  LAST_ADMIN_TRIGGER,
  type Role,
  type RoleGrant,
  RoleRefusedByDatabase,
  type RoleRepository,
} from './role.db.js';
import type { SignInAccountRepository } from '../sign-in/sign-in-account.db.js';

export class RoleService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly accounts: SignInAccountRepository,
    private readonly employees: EmployeeRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** Gives somebody a role. */
  async grant(actor: Actor, employeeId: string, code: string): Promise<RoleCode[]> {
    const role = readAssignableRoleCode(code);

    this.guard.enforce(rolePolicy.grant(actor, employeeId, role));

    const accountId = await this.accountFor(employeeId);

    await this.roles.grant(actor, accountId, role);

    return this.roles.codesFor(accountId);
  }

  /** Takes a role away. */
  async revoke(actor: Actor, employeeId: string, code: string): Promise<RoleCode[]> {
    const role = readAssignableRoleCode(code);

    this.guard.enforce(rolePolicy.revoke(actor, employeeId, role));

    const accountId = await this.accountFor(employeeId);

    if (role === 'SYS_ADMIN' && (await this.roles.countHolding(role)) <= 1) {
      if ((await this.roles.codesFor(accountId)).includes(role)) {
        throw new LastSystemAdministrator();
      }
    }

    const removed = await this.translateRefusals(() => this.roles.revoke(actor, accountId, role));

    if (!removed) {
      throw new RoleNotHeld(role);
    }

    return this.roles.codesFor(accountId);
  }

  /** What somebody holds, with the date each was granted. */
  async forEmployee(actor: Actor, employeeId: string): Promise<RoleGrant[]> {
    this.guard.enforce(rolePolicy.read(actor, employeeId));

    return this.roles.grantsFor(await this.accountFor(employeeId));
  }

  /** Everything that decides what somebody may do, in one read. LMS 112. */
  async authorityFor(actor: Actor, employeeId: string): Promise<Authority> {
    this.guard.enforce(rolePolicy.read(actor, employeeId));

    const [roles, isManager] = await Promise.all([
      this.roles
        .grantsFor(await this.accountFor(employeeId))
        .then((grants) => grants.map((grant) => grant.code)),
      this.isManagerUnchecked(employeeId),
    ]);

    return { roles, isManager };
  }

  /** Whether anybody reports to them. FR 02. */
  async isManager(actor: Actor, employeeId: string): Promise<boolean> {
    this.guard.enforce(rolePolicy.read(actor, employeeId));

    return this.isManagerUnchecked(employeeId);
  }

  /** The same, for callers inside this service that have already been judged. */
  private async isManagerUnchecked(employeeId: string): Promise<boolean> {
    if ((await this.employees.findById(employeeId)) === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return (await this.employees.countReports(employeeId)) > 0;
  }

  /** Everybody holding a role, as employee records. */
  async holdersOf(actor: Actor, code: string): Promise<Employee[]> {
    const role = readRoleCode(code);

    this.guard.enforce(rolePolicy.holders(actor, role));

    return this.employees.findAllById(await this.roles.employeeIdsHolding(role));
  }

  /** The four roles, for a screen that offers them. */
  async list(actor: Actor): Promise<Role[]> {
    this.guard.enforce(rolePolicy.list(actor));

    return this.roles.list();
  }

  /** The three a screen may offer as tick boxes. */
  assignable(): readonly RoleCode[] {
    return ASSIGNABLE_ROLES;
  }

  /** The login a person's roles hang off. */
  private async accountFor(employeeId: string): Promise<string> {
    const employee = await this.employees.findById(employeeId);
    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    const account = await this.accounts.findByEmployeeId(employeeId);
    if (account === undefined) {
      throw new SignInAccountNotFound(
        `${employee.firstName} ${employee.lastName} (${employee.employeeNumber}), who has ` +
          `no login yet, so there is nothing to give a role to`,
      );
    }

    return account.id;
  }

  /**
   * Turns a trigger's refusal into the domain error for it.
   *
   * Both of these are races the checks above already asked about and lost, which
   * is not wasted work on either side: the check gives the good message for the
   * answer that is right almost every time, and the trigger is what makes the
   * answer right when two people are clicking at once.
   */
  private async translateRefusals<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof RoleRefusedByDatabase) {
        if (error.constraintName === LAST_ADMIN_TRIGGER) {
          throw new LastSystemAdministrator();
        }
        if (error.constraintName === BASELINE_TRIGGER) {
          /* Unreachable through this service: readAssignableRoleCode refuses
             EMPLOYEE before any statement runs. Translated anyway, because a
             repository is callable without a service and the message it would
             otherwise give is a constraint name. */
          throw new RoleCannotBeRevoked(BASELINE_ROLE);
        }
      }

      throw error;
    }
  }
}
