/** Creating, editing and deactivating departments. LMS 105, LMS 112, FR 03, FR 04. */

import type { Actor } from '../../auth/actor.js';
import { departmentPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import {
  assertCanDeactivate,
  type Department,
  type DepartmentChanges,
  DepartmentNotFound,
  type NewDepartment,
  type ValidatedDepartment,
  validateDepartmentChanges,
  validateNewDepartment,
} from './department.js';
import type { DepartmentRepository } from './department.db.js';

export class DepartmentService {
  constructor(
    private readonly departments: DepartmentRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** Creates one. */
  async create(actor: Actor, input: NewDepartment): Promise<Department> {
    this.guard.enforce(departmentPolicy.create(actor));

    return this.departments.create(actor, validateNewDepartment(input));
  }

  /** Renames one. */
  async update(actor: Actor, id: string, changes: DepartmentChanges): Promise<Department> {
    this.guard.enforce(departmentPolicy.update(actor, id));

    return this.change(actor, id, () => validateDepartmentChanges(changes));
  }

  /** Closes a department. */
  async deactivate(actor: Actor, id: string): Promise<Department> {
    this.guard.enforce(departmentPolicy.close(actor, id));

    const department = await this.require(id);

    assertCanDeactivate(department, await this.departments.activeHeadcount(id));

    return this.setActive(actor, id, false);
  }

  /** Reopens one. */
  async reactivate(actor: Actor, id: string): Promise<Department> {
    this.guard.enforce(departmentPolicy.reopen(actor, id));

    await this.require(id);
    return this.setActive(actor, id, true);
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

  /** How many people are still employed in one. */
  async headcount(actor: Actor, id: string): Promise<number> {
    this.guard.enforce(departmentPolicy.headcount(actor, id));

    await this.require(id);
    return this.departments.activeHeadcount(id);
  }

  /** The record, or DepartmentNotFound. */
  private async require(id: string): Promise<Department> {
    const department = await this.departments.findById(id);
    if (department === undefined) {
      throw new DepartmentNotFound(id);
    }
    return department;
  }

  /** Read, decide, write. */
  private async change(
    actor: Actor,
    id: string,
    decide: (current: Department) => Partial<ValidatedDepartment>,
  ): Promise<Department> {
    const current = await this.require(id);

    const updated = await this.departments.update(actor, id, decide(current));
    if (updated === undefined) {
      throw new DepartmentNotFound(id);
    }

    return updated;
  }

  private async setActive(actor: Actor, id: string, isActive: boolean): Promise<Department> {
    const updated = await this.departments.setActive(actor, id, isActive);
    if (updated === undefined) {
      throw new DepartmentNotFound(id);
    }
    return updated;
  }
}
