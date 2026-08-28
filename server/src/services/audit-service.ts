/**
 * Reading the account of what happened. NFR AUD 01 and NFR AUD 02. LMS 113.
 *
 * The story is a dispute: a balance is wrong, or is said to be, and the question
 * is how it got that way. This is the half of the story somebody actually uses.
 * The other half — writing the entries — is not here and is not anywhere in the
 * application: every row is written by a trigger on the table that changed, in
 * the same transaction as the change, and the audit-log migration argues that
 * out at length.
 *
 * So there is no `record()` method, no `write()`, and nothing that composes an
 * entry. If one ever appears here it is a bug, and a serious one: an entry the
 * application writes is an entry the application can be made to write.
 *
 * What this service does is turn a question a person asks into the handle the
 * table is filed under. "Show me Abena's history" is three entities — her
 * employee record, her login, and her roles — and it is two different
 * authorisation questions, because who may see a record and who may see when
 * somebody's password was reset are not the same people. See
 * ../auth/audit-policy.ts.
 *
 * What it does not do:
 *
 *   No interpretation. It hands back entries; turning "these two snapshots
 *   differ in `work_pattern_id`" into "her working week changed" is
 *   {@link changedFields} in ../domain/audit.ts, which is a pure function and
 *   tested as one.
 *
 *   No correction. There is no method to fix an entry, because there is no way
 *   to fix an entry: the table refuses UPDATE and DELETE on every connection,
 *   and a mistake in the record of what happened is corrected by doing something
 *   and having that recorded too.
 */

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
    /* To read the record the standing is judged against — a line manager's
       claim on it is a field of the record, exactly as it is everywhere else. */
    private readonly employees: EmployeeRepository,
    /* Roles and logins are filed under the login, so a person's access history
       needs the same translation RoleService makes. */
    private readonly accounts: SignInAccountRepository,
    private readonly guard: Guard,
  ) {}

  /**
   * How this person's record came to say what it says. The story's own question.
   *
   * Oldest first, because that is the direction it reads: a record is created,
   * then things happen to it, and the answer to "how did we get here" runs
   * forwards.
   *
   * Their own history is theirs. That is the point of the story rather than a
   * concession — an account of a disputed balance that the person disputing it
   * cannot see is not an account, it is a reassurance.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    const employee = await this.findOrRefuse(actor, employeeId);

    this.guard.enforce(auditPolicy.forEmployee(actor, employee));

    return this.entries.forSubjects([{ entity: 'employee', entityId: employee.id }], options);
  }

  /**
   * When their login and their roles changed, and who changed them.
   *
   * A narrower audience than the record's history — yours or an
   * administrator's — because this is the material of an investigation rather
   * than of a leave query. See ../auth/audit-policy.ts.
   *
   * An employee with no login has no access history, which is an empty list and
   * not an error: they have never had access, so nothing has ever happened to
   * it. That differs from {@link RoleService}, which refuses, and the difference
   * is what the caller is asking for — a role cannot be granted to somebody with
   * no login, but "what has happened to their access" has a true answer and it
   * is "nothing".
   */
  async forAccess(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    /* The record is read first for the same reason it is everywhere else: being
       told that an employee id is nobody is itself a permission. */
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

  /**
   * How a working week came to be what it is. FR 23.
   *
   * Both entities, because a pattern and its seven days are one thing to
   * everybody who is not the schema: changing a week is seven deletes and seven
   * inserts, and the audit-log migration files all fourteen under the pattern so
   * that they can be read together here.
   *
   * This is the history that settles a disputed day count. "A week off cost her
   * four days" is answered by which days the pattern worked at the time, and
   * that is one of these entries.
   */
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

  /**
   * What has been happening, newest first.
   *
   * Every record at once, so it goes to the people who may read every record.
   * `actorEmployeeId` narrows it to one person's doing, which is the question
   * asked after ../auth/denials.ts has shown somebody probing: the denial log
   * says what they were refused, and this says what they were not.
   */
  async recent(
    actor: Actor,
    options: HistoryOptions & { actorEmployeeId?: string } = {},
  ): Promise<AuditEntry[]> {
    this.guard.enforce(auditPolicy.browse(actor));

    return this.entries.recent(options);
  }

  /** How many times this record has changed. For a screen offering to show them. */
  async countForEmployee(actor: Actor, employeeId: string): Promise<number> {
    const employee = await this.findOrRefuse(actor, employeeId);

    this.guard.enforce(auditPolicy.forEmployee(actor, employee));

    return this.entries.countFor({ entity: 'employee', entityId: employee.id });
  }

  /**
   * The record, or the right refusal for an id that is nobody.
   *
   * The same shape as {@link EmployeeService.findOrRefuse} and for the same
   * reason, which is worth restating because this is the surface where forgetting
   * it would be easiest to miss: an audit log that answers "no such employee" to
   * somebody it would refuse a real id is an existence oracle wearing a different
   * hat. Anybody who may browse the log is told plainly; everybody else gets the
   * one sentence that covers both cases.
   */
  private async findOrRefuse(actor: Actor, employeeId: string) {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      this.guard.enforce(auditPolicy.browse(actor));
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }
}
