/**
 * Assigning roles. Technical Design Document §5.3. LMS 111.
 *
 * The story's "so that" is the design brief: HR and administrative powers are
 * held deliberately rather than by whoever happened to set the system up. That
 * means three things have to be true, and each of them is a rule here rather
 * than a habit:
 *
 *   Every power is a named role somebody granted. Four of them, closed set,
 *   ../auth/roles.ts.
 *
 *   Every grant can be listed and taken back. {@link forEmployee} and
 *   {@link revoke}, and a date on each so that "since when" has an answer.
 *
 *   Nothing is a power by accident. Being a manager is the obvious candidate and
 *   is deliberately not a role at all — see {@link authorityFor}.
 *
 * Keyed on the employee throughout, because that is who HR is looking at. Roles
 * hang off the *login*, which is a distinction worth keeping visible rather than
 * papering over: somebody with no login holds no roles, and giving them one is
 * {@link SignInService.provision} rather than anything here.
 *
 * What this service does not do:
 *
 *   No authorisation rules. It still says what somebody holds rather than what
 *   holding it permits — that is ../auth/, and the four policy objects there are
 *   what read this. What LMS 112 added is the other half of the sentence this
 *   note used to end with: every method now takes an {@link Actor} and asks
 *   ../auth/role-policy.ts whether the *caller* may assign roles. "As an HR
 *   Administrator" is enforced, and three rules there are worth reading before
 *   changing anything here — administrators only, the master key handed on by
 *   somebody holding it, and nobody changing their own roles.
 *
 *   No audit trail. Who granted what, and when, is still half answered: the date
 *   is on the row, and there is now an actor to name — but naming them means a
 *   granted_by column or an audit row, and that is LMS 113's table rather than a
 *   column added here on the way past. What LMS 112 does write down is the
 *   refusals, which is a different and smaller thing. It needs doing, and it is
 *   not done.
 */

import type { Actor } from '../auth/actor.js';
import type { Guard } from '../auth/policy.js';
import { rolePolicy } from '../auth/role-policy.js';
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
} from '../auth/roles.js';
import { SignInAccountNotFound } from '../auth/sign-in.js';
import { type Employee, EmployeeNotFound } from '../domain/employee.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import {
  BASELINE_TRIGGER,
  LAST_ADMIN_TRIGGER,
  type Role,
  type RoleGrant,
  RoleRefusedByDatabase,
  type RoleRepository,
} from '../repositories/role-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';

export class RoleService {
  constructor(
    private readonly roles: RoleRepository,
    /* Roles hang off the login, and callers speak in employees. This is the
       translation, and it is one read. */
    private readonly accounts: SignInAccountRepository,
    /* For the one fact that is not a role: whether anybody reports to them. */
    private readonly employees: EmployeeRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
  ) {}

  /**
   * Gives somebody a role.
   *
   * Returns everything they hold afterwards rather than a bare acknowledgement,
   * because the question a screen asks next is "what do they have now" and the
   * answer is one round trip away either way.
   *
   * Granting a role somebody already holds is not an error. It is two HR officers
   * doing the same sensible thing, or one of them clicking twice, and the state
   * afterwards is the state that was wanted. `EMPLOYEE` is refused, not because
   * granting it would be wrong but because it is already true of everybody with a
   * login and offering it as a choice would suggest otherwise.
   */
  async grant(actor: Actor, employeeId: string, code: string): Promise<RoleCode[]> {
    /* The code is read first, because the policy's answer depends on which role
       it is — SYS_ADMIN is handed on only by somebody holding it — and because a
       caller who typed a role that does not exist should hear that rather than
       being refused a grant nobody could have made. Neither statement has
       touched the database yet. */
    const role = readAssignableRoleCode(code);

    this.guard.enforce(rolePolicy.grant(actor, employeeId, role));

    const accountId = await this.accountFor(employeeId);

    await this.roles.grant(accountId, role);

    return this.roles.codesFor(accountId);
  }

  /**
   * Takes a role away.
   *
   * Throws {@link RoleNotHeld} rather than quietly succeeding, which is the
   * opposite of what {@link grant} does with a role somebody already has, and the
   * asymmetry is deliberate. Granting twice and granting once leave the same
   * person with the same power. Revoking something they never had means the
   * person doing it has somebody else in mind, or the wrong role in mind, and
   * either way they should find out now rather than believe they have removed
   * access that is still there.
   *
   * {@link LastSystemAdministrator} is checked here for the message and held by
   * the database for the guarantee. Between the count and the delete another
   * transaction can remove the other administrator, which is exactly the race the
   * user_role_keeps_a_system_administrator trigger settles; the check is so that
   * the answer that is right almost every time is also a sentence somebody can
   * act on.
   */
  async revoke(actor: Actor, employeeId: string, code: string): Promise<RoleCode[]> {
    const role = readAssignableRoleCode(code);

    this.guard.enforce(rolePolicy.revoke(actor, employeeId, role));

    const accountId = await this.accountFor(employeeId);

    if (role === 'SYS_ADMIN' && (await this.roles.countHolding(role)) <= 1) {
      /* Only meaningful if this is the person who holds it. Removing a role from
         somebody who does not have it is RoleNotHeld below, and saying "you are
         the last administrator" to somebody who is not one would be nonsense. */
      if ((await this.roles.codesFor(accountId)).includes(role)) {
        throw new LastSystemAdministrator();
      }
    }

    const removed = await this.translateRefusals(() => this.roles.revoke(accountId, role));

    if (!removed) {
      throw new RoleNotHeld(role);
    }

    return this.roles.codesFor(accountId);
  }

  /**
   * What somebody holds, with the date each was granted.
   *
   * The answer to "who has HR powers and since when", which is the review this
   * story exists to make possible.
   */
  async forEmployee(actor: Actor, employeeId: string): Promise<RoleGrant[]> {
    this.guard.enforce(rolePolicy.read(actor, employeeId));

    return this.roles.grantsFor(await this.accountFor(employeeId));
  }

  /**
   * Everything that decides what somebody may do, in one read.
   *
   * Two fields, kept apart on purpose: `roles` is what was granted, `isManager`
   * is what is true. See {@link Authority} for why collapsing them into one list
   * would be the drift the schema has refused since the table was created.
   *
   * This is the shape LMS 112 authorises from, and it turned out to be the right
   * one: ../auth/actor.ts is this interface with a name attached rather than a
   * second shape beside it. It is here rather than there because both halves are
   * reads this service already owns, and because writing it then is what stopped
   * the authorisation layer inventing a `roles` array with 'MANAGER' in it.
   *
   * Note what does *not* call this. The sign in path builds its own actor from
   * the two reads it is already making, because there is nobody to authorise this
   * read for somebody who has not finished signing in. See
   * {@link SignInService.open}.
   */
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

  /**
   * Whether anybody reports to them. FR 02, and the story's third criterion.
   *
   * Derived, every time it is asked, from the reporting lines. Nobody grants it
   * and nobody can: there is no MANAGER row to insert, role_code_known refuses
   * the code outright, and this is the only thing in the system that answers the
   * question.
   *
   * A leaver's reports still count. Somebody who has left is not going to approve
   * anything — {@link SignInService.signIn} closes that door — but if requests are
   * still routed to them, that is a fact worth being able to see rather than one
   * to hide by filtering here. Which reports are still live is the caller's
   * question, and {@link EmployeeService.reportingLineWarnings} is what asks it.
   */
  async isManager(actor: Actor, employeeId: string): Promise<boolean> {
    /* The same standing as reading their roles. Whether anybody reports to
       somebody is not a role, but it is the other half of what decides what they
       may do, and answering it for anybody who asks would let the reporting
       lines be mapped one employee at a time. */
    this.guard.enforce(rolePolicy.read(actor, employeeId));

    return this.isManagerUnchecked(employeeId);
  }

  /**
   * The same, for callers inside this service that have already been judged.
   *
   * Split out rather than left as a second policy check inside
   * {@link authorityFor}, because asking twice is not a safety net — it is a
   * second line in the denial log for one refused request, and a reader of that
   * log counting attempts would be counting wrongly.
   */
  private async isManagerUnchecked(employeeId: string): Promise<boolean> {
    if ((await this.employees.findById(employeeId)) === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return (await this.employees.countReports(employeeId)) > 0;
  }

  /**
   * Everybody holding a role, as employee records.
   *
   * "Who are the System Administrators" is the other half of the review, and the
   * one somebody asks before taking a role away from anybody.
   */
  async holdersOf(actor: Actor, code: string): Promise<Employee[]> {
    const role = readRoleCode(code);

    this.guard.enforce(rolePolicy.holders(actor, role));

    return this.employees.findAllById(await this.roles.employeeIdsHolding(role));
  }

  /** The four roles, for a screen that offers them. Reference data. */
  async list(actor: Actor): Promise<Role[]> {
    this.guard.enforce(rolePolicy.list(actor));

    return this.roles.list();
  }

  /**
   * The three a screen may offer as tick boxes.
   *
   * EMPLOYEE is not among them, because it is not a choice: everybody with a
   * login has it and nobody can lose it. Offering it as an unticked box would be
   * a lie about what the system does.
   *
   * The one method here that takes no actor and asks no policy. It returns a
   * constant from ../auth/roles.ts, reads nothing, and is the same three codes
   * whoever is asking — there is no record behind it to protect and no fact about
   * anybody to disclose. Guarding it would be a check that can only ever pass,
   * which is worse than no check: it teaches whoever reads this file next that
   * the checks are decoration.
   */
  assignable(): readonly RoleCode[] {
    return ASSIGNABLE_ROLES;
  }

  /**
   * The login a person's roles hang off.
   *
   * {@link SignInAccountNotFound} rather than a silent empty list, because
   * "she has no roles" and "she has no login" are different answers to different
   * problems: one needs a role granting, the other needs
   * {@link SignInService.provision} first. Telling an HR officer the first when
   * the second is true is half an hour of clicking a button that does nothing.
   */
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
