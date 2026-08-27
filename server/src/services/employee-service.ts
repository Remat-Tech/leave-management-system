/**
 * Creating and maintaining employee records. FR 01 and FR 05, LMS 101.
 *
 * The business rules for an employee record, in the layer that owns them. A
 * route will sit in front of this when Phase 1 has an authorisation layer to put
 * behind it (LMS 112); until then this is the whole of the story's surface, and
 * it is deliberately the same surface a route would call rather than a smaller
 * one that would have to be widened later.
 *
 * What this service does not do is as much the point as what it does:
 *
 *   No delete. There is no method for it and the application role holds no
 *   DELETE privilege on the table. An employee who leaves is a status of
 *   TERMINATED and an exit date, so that their leave history survives them.
 *   FR 06, and LMS 102 owns the path proper.
 *
 *   No manager. The line manager is FR 02 and belongs to LMS 103, along with the
 *   rules about exactly one root and about cycles that LMS 104 adds. Recording
 *   it here would mean writing half of those rules in the wrong place.
 *
 *   No authorisation. "As an HR Officer" is enforced by the policy layer of
 *   LMS 112, from this layer, when it exists. Nothing here decides who may call
 *   it, and nothing here should start to.
 */

import { allowedDomains } from '../auth/company-email.js';
import {
  EmployeeNotFound,
  type Employee,
  type EmployeeChanges,
  type NewEmployee,
  validateEmployeeChanges,
  validateNewEmployee,
} from '../domain/employee.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';

export interface EmployeeServiceOptions {
  /**
   * The company domains a work address may belong to. Read from
   * ALLOWED_EMAIL_DOMAINS when not given, which is how the application runs;
   * tests pass their own so they need no environment.
   */
  domains?: string[];
}

export class EmployeeService {
  private readonly domains: string[];

  constructor(
    private readonly employees: EmployeeRepository,
    options: EmployeeServiceOptions = {},
  ) {
    // Resolved once, at construction. allowedDomains() throws on an empty list,
    // so a misconfigured environment stops the application starting rather than
    // failing at whichever request first happens to need it.
    this.domains = options.domains ?? allowedDomains();
  }

  /**
   * Creates a record.
   *
   * Throws InvalidEmployee for a field that is wrong, and
   * DuplicateEmployeeNumber or DuplicateWorkEmail when the identifier already
   * belongs to somebody. A personal address is refused here, which is the
   * provisioning half of NFR SEC 01.
   */
  async create(input: NewEmployee): Promise<Employee> {
    return this.employees.create(validateNewEmployee(input, this.domains));
  }

  /**
   * Changes a record.
   *
   * Only the fields present in `changes` are touched. Omitting a field leaves it
   * alone and passing null clears it, which are different instructions and stay
   * different all the way down to the UPDATE statement: the alternative, taking
   * a whole record and writing all of it, silently reverts anything a colleague
   * changed while this caller had the form open.
   *
   * The record is read first because several of the rules span fields — whether
   * clearing an exit date is allowed depends on the status, which may or may not
   * be changing in the same call — and those have to be checked against the
   * record as it will be, not as it arrived.
   */
  async update(id: string, changes: EmployeeChanges): Promise<Employee> {
    const current = await this.employees.findById(id);
    if (current === undefined) {
      throw new EmployeeNotFound(id);
    }

    const validated = validateEmployeeChanges(changes, current, this.domains);

    const updated = await this.employees.update(id, validated);
    if (updated === undefined) {
      // Deleted between the read and the write. Not possible today, since
      // nothing may delete an employee, but reporting it is cheaper than
      // returning undefined and making every caller wonder.
      throw new EmployeeNotFound(id);
    }

    return updated;
  }

  async byId(id: string): Promise<Employee> {
    const employee = await this.employees.findById(id);
    if (employee === undefined) {
      throw new EmployeeNotFound(id);
    }
    return employee;
  }

  /** Undefined rather than a throw: asking whether a number is taken is a fair question. */
  async byNumber(employeeNumber: string): Promise<Employee | undefined> {
    return this.employees.findByNumber(employeeNumber);
  }

  async byWorkEmail(workEmail: string): Promise<Employee | undefined> {
    return this.employees.findByWorkEmail(workEmail);
  }

  /** Everybody, leavers included, unless asked otherwise. */
  async list(options: { activeOnly?: boolean } = {}): Promise<Employee[]> {
    return this.employees.list(options);
  }
}
