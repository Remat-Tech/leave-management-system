/**
 * Creating, editing and deactivating departments. LMS 105.
 *
 * A department is a team, and this exists so that leave can be reported and
 * planned by team rather than one person at a time. Everything here serves that:
 * a department is only useful if there is one row per team, if its name means
 * something, and if the teams on a report are the teams that currently exist.
 *
 * A route will sit in front of this when Phase 1 has an authorisation layer to
 * put behind it (LMS 112); until then this is the whole of the story's surface,
 * and it is deliberately the same surface a route would call.
 *
 * What this service does not do:
 *
 *   No delete. A department is {@link deactivate}d, which is the ending it has.
 *   The application role no longer holds DELETE on the table — the
 *   department-rules migration took it back — so there is no path to one even if
 *   a method were added. This is deliberately a shade weaker than the employee
 *   table, which refuses the owner connection too: a department nobody has ever
 *   been in is a typo worth being able to remove, and the foreign key already
 *   protects every department anybody is in.
 *
 *   No hierarchy. `parent_id` exists on the table and nothing writes it. See the
 *   department-rules migration for what a story that exposes sub-departments has
 *   to bring with it, which is the same pair of rules FR 03 and FR 04 gave
 *   reporting lines.
 *
 *   No moving people. Reassigning somebody is a change to their record, so it is
 *   {@link EmployeeService.update} with a departmentId. This service knows how
 *   many people are in a department, because closing one turns on it, and moves
 *   none of them itself.
 *
 *   No authorisation rules. Since LMS 112 every method takes an {@link Actor}
 *   and asks ../auth/department-policy.ts what they may do, but the rules
 *   themselves are there. Reading a team is open to anybody signed in and
 *   writing one is an HR Administrator's; the reasoning for both, including why
 *   the headcount is not open, is in that file.
 */

import type { Actor } from '../auth/actor.js';
import { departmentPolicy } from '../auth/department-policy.js';
import type { Guard } from '../auth/policy.js';
import {
  assertCanDeactivate,
  type Department,
  type DepartmentChanges,
  DepartmentNotFound,
  type NewDepartment,
  type ValidatedDepartment,
  validateDepartmentChanges,
  validateNewDepartment,
} from '../domain/department.js';
import type { DepartmentRepository } from '../repositories/department-repository.js';

export class DepartmentService {
  constructor(
    private readonly departments: DepartmentRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
  ) {}

  /**
   * Creates one.
   *
   * Throws {@link InvalidDepartment} for a name that is wrong and
   * {@link DuplicateDepartmentName} when the name already belongs to a
   * department — including one that has been closed, whose name stays reserved
   * so that reopening it is what happens rather than a second row of the same
   * team appearing beside it.
   */
  async create(actor: Actor, input: NewDepartment): Promise<Department> {
    this.guard.enforce(departmentPolicy.create(actor));

    return this.departments.create(validateNewDepartment(input));
  }

  /** Renames one. The id every employee record points at does not move. */
  async update(actor: Actor, id: string, changes: DepartmentChanges): Promise<Department> {
    this.guard.enforce(departmentPolicy.update(actor, id));

    return this.change(id, () => validateDepartmentChanges(changes));
  }

  /**
   * Closes a department. The ending a department has.
   *
   * Refused while anybody is still employed in it, with
   * {@link DepartmentStillStaffed} and the number of them. That is not
   * tidiness: `employee.department_id` is NOT NULL, so closing a team does not
   * and cannot move the people out of it, and they would go on being counted
   * under a heading no report offers as a choice. Move them, then close it.
   *
   * Leavers are not counted, because they stay in the department they left from
   * and are not going to raise anything that has to be reported under a team.
   *
   * Closing one that is already closed does nothing and says so by returning the
   * record. See {@link assertCanDeactivate} for why that differs from
   * terminating an employee twice, which is refused.
   */
  async deactivate(actor: Actor, id: string): Promise<Department> {
    this.guard.enforce(departmentPolicy.close(actor, id));

    /* Read through the repository rather than through byId(actor, id), which
       would ask the read policy a second question that this caller has already
       been asked a harder version of. Closing a team is permitted; seeing its
       name obviously follows. */
    const department = await this.require(id);

    assertCanDeactivate(department, await this.departments.activeHeadcount(id));

    return this.setActive(id, false);
  }

  /**
   * Reopens one.
   *
   * Unconditional, because there is nothing to check: an open department with
   * nobody in it is an ordinary state — every department has it for the minute
   * between being created and being staffed.
   *
   * This is also the answer to having closed one by mistake. The row was never
   * deleted, so it comes back with the id every employee record and every past
   * report already points at, rather than as a new department with the same name
   * and none of the history.
   */
  async reactivate(actor: Actor, id: string): Promise<Department> {
    this.guard.enforce(departmentPolicy.reopen(actor, id));

    await this.require(id);
    return this.setActive(id, true);
  }

  async byId(actor: Actor, id: string): Promise<Department> {
    this.guard.enforce(departmentPolicy.read(actor, id));

    return this.require(id);
  }

  /** Undefined rather than a throw: asking whether a name is taken is a fair question. */
  async byName(actor: Actor, name: string): Promise<Department | undefined> {
    this.guard.enforce(departmentPolicy.read(actor));

    return this.departments.findByName(name);
  }

  /** Everything, closed ones included, unless asked otherwise. */
  async list(actor: Actor, options: { openOnly?: boolean } = {}): Promise<Department[]> {
    this.guard.enforce(departmentPolicy.list(actor));

    return this.departments.list(options);
  }

  /**
   * How many people are still employed in one.
   *
   * The one read here that is not open to everybody. A headcount is a fact about
   * people rather than about the team, and a small one is close to naming them —
   * see ../auth/department-policy.ts.
   */
  async headcount(actor: Actor, id: string): Promise<number> {
    this.guard.enforce(departmentPolicy.headcount(actor, id));

    await this.require(id);
    return this.departments.activeHeadcount(id);
  }

  /**
   * The record, or {@link DepartmentNotFound}.
   *
   * No policy question, deliberately, and the difference from
   * {@link EmployeeService.findOrRefuse} is worth knowing rather than looking
   * like an inconsistency. There, being told that an id is nobody is a
   * disclosure, because employee records are what the story is about hiding.
   * Here, every signed in caller may read every department, so there is nothing
   * a missing one could disclose that a present one would not.
   */
  private async require(id: string): Promise<Department> {
    const department = await this.departments.findById(id);
    if (department === undefined) {
      throw new DepartmentNotFound(id);
    }
    return department;
  }

  /**
   * Read, decide, write. The same shape as EmployeeService.change, and here for
   * the same reason: there is one place that establishes the record exists and
   * one place that reports it if it stops existing between the read and the
   * write.
   */
  private async change(
    id: string,
    decide: (current: Department) => Partial<ValidatedDepartment>,
  ): Promise<Department> {
    const current = await this.require(id);

    const updated = await this.departments.update(id, decide(current));
    if (updated === undefined) {
      throw new DepartmentNotFound(id);
    }

    return updated;
  }

  private async setActive(id: string, isActive: boolean): Promise<Department> {
    const updated = await this.departments.setActive(id, isActive);
    if (updated === undefined) {
      throw new DepartmentNotFound(id);
    }
    return updated;
  }
}
