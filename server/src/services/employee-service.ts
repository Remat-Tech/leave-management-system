/**
 * Creating, maintaining and deactivating employee records. FR 01, FR 05 and
 * FR 06. LMS 101 and LMS 102.
 *
 * The business rules for an employee record, in the layer that owns them. A
 * route will sit in front of this when Phase 1 has an authorisation layer to put
 * behind it (LMS 112); until then this is the whole of the story's surface, and
 * it is deliberately the same surface a route would call rather than a smaller
 * one that would have to be widened later.
 *
 * What this service does not do is as much the point as what it does:
 *
 *   No delete. There is no method for it, there is no route that could reach
 *   one, the application role holds no DELETE privilege on the table, and a
 *   trigger refuses the statement even on the owner connection. An employee who
 *   leaves is {@link terminate}: a status of TERMINATED and an exit date, so
 *   that their leave history survives them. FR 06.
 *
 *   No manager. The line manager is FR 02 and belongs to LMS 103, along with the
 *   rules about exactly one root and about cycles that LMS 104 adds. Recording
 *   it here would mean writing half of those rules in the wrong place.
 *
 *   No authorisation. "As an HR Officer" is enforced by the policy layer of
 *   LMS 112, from this layer, when it exists. Nothing here decides who may call
 *   it, and nothing here should start to.
 *
 *   No sign in. Terminating does not touch the leaver's app_user row, because
 *   nothing reads app_user.is_active yet — there is no login, no session and no
 *   auth middleware in the tree. Revoking a leaver's access is the login story's
 *   to write, next to the code that would honour it; doing it here would be half
 *   a rule with no reader. It needs doing, and it is not done.
 */

import { allowedDomains } from '../auth/company-email.js';
import {
  EmployeeNotFound,
  planTermination,
  type Employee,
  type EmployeeChanges,
  type NewEmployee,
  type Termination,
  type ValidatedEmployee,
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
   * Changes a record. Only the fields present in `changes` are touched; see
   * {@link change} for why that distinction is kept all the way to the UPDATE.
   *
   * This is also the way a termination is corrected, and the way somebody
   * marked as having left is brought back — the record was never deleted, so
   * putting the status back to ACTIVE and clearing the exit date is an ordinary
   * edit rather than a re-creation with a new id and no history.
   */
  async update(id: string, changes: EmployeeChanges): Promise<Employee> {
    return this.change(id, (current) => validateEmployeeChanges(changes, current, this.domains));
  }

  /**
   * Records that somebody has left. FR 06.
   *
   * This is what deactivation is, and it is the only ending an employee record
   * has. The row stays, keeping the id that every leave request, ledger entry
   * and approval of theirs points at, so their history is still there to settle
   * a dispute with. Nothing here removes anything.
   *
   * Throws {@link AlreadyTerminated} rather than quietly writing a second exit
   * date over the first, {@link InvalidEmployee} for a date that is not a date
   * or that falls before the person started, and {@link EmployeeNotFound} for an
   * id that is nobody.
   *
   * Correcting a termination — the wrong date, or somebody marked as leaving who
   * then stayed — is {@link update}, an ordinary edit to a record that still
   * exists. That is the dividend of never having deleted it.
   */
  async terminate(id: string, termination: Termination): Promise<Employee> {
    return this.change(id, (current) => planTermination(current, termination));
  }

  /**
   * Read, decide, write.
   *
   * Every change to an existing record goes through here, because several of the
   * rules span fields — whether clearing an exit date is allowed depends on the
   * status, which may or may not be changing in the same call — and those have
   * to be checked against the record as it will be, not as it arrived. The
   * decision is the caller's; what is shared is that there is a record to decide
   * against and that it is still there afterwards.
   *
   * Only the fields the decision produced are touched. Omitting a field leaves it
   * alone and passing null clears it, which are different instructions and stay
   * different all the way down to the UPDATE statement: the alternative, taking a
   * whole record and writing all of it, silently reverts anything a colleague
   * changed while this caller had the form open.
   */
  private async change(
    id: string,
    decide: (current: Employee) => Partial<ValidatedEmployee>,
  ): Promise<Employee> {
    const current = await this.employees.findById(id);
    if (current === undefined) {
      throw new EmployeeNotFound(id);
    }

    const updated = await this.employees.update(id, decide(current));
    if (updated === undefined) {
      // Gone between the read and the write. Not possible — nothing may delete
      // an employee, and the database now refuses the statement outright — but
      // reporting it is cheaper than returning undefined and making every caller
      // wonder.
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
