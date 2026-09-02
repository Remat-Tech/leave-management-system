/**
 * Creating, maintaining and deactivating employee records, recording who each of them reports to, which team they are in and which week they work. FR 01, FR 06, FR 23, LMS 101, LMS 106, LMS 112, LMS 109.
 */

import type { Actor } from '../../auth/actor.js';
import { allowedDomains } from '../sign-in/company-email.js';
import { employeePolicy } from './policy.js';
import type { Decision, Guard } from '../../auth/policy.js';
import { assertCanTakeEmployees, DepartmentNotFound } from '../department/department.js';
import {
  assertNoManagerCycle,
  EmployeeNotFound,
  ManagerHasLeft,
  ManagerNotFound,
  planTermination,
  type Employee,
  type EmployeeChanges,
  type NewEmployee,
  type ReportingLineWarning,
  SecondRootEmployee,
  type Termination,
  type ValidatedEmployee,
  validateEmployeeChanges,
  validateNewEmployee,
  warnAboutReportingLines,
} from './employee.js';
import { buildOrgChart, type OrgChart } from './org-chart.js';
import { DefaultWorkPatternRequired, WorkPatternNotFound } from '../work-pattern/work-pattern.js';
import type { DepartmentRepository } from '../department/department.db.js';
import type { EmployeeRepository } from './employee.db.js';
import type { WorkPatternRepository } from '../work-pattern/work-pattern.db.js';

export interface EmployeeServiceOptions {
  /** The company domains a work address may belong to. */
  domains?: string[];
}

export class EmployeeService {
  private readonly domains: string[];

  constructor(
    private readonly employees: EmployeeRepository,
    private readonly departments: DepartmentRepository,
    private readonly patterns: WorkPatternRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    options: EmployeeServiceOptions = {},
  ) {
    // Resolved once, at construction. allowedDomains() throws on an empty list,
    // so a misconfigured environment stops the application starting rather than
    // failing at whichever request first happens to need it.
    this.domains = options.domains ?? allowedDomains();
  }

  /** Creates a record. NFR SEC 01, FR 02, FR 04, FR 23. */
  async create(actor: Actor, input: NewEmployee): Promise<Employee> {
    this.guard.enforce(employeePolicy.create(actor));

    const record = validateNewEmployee(input, this.domains);

    await this.checkDepartment(record.departmentId, record.employmentStatus !== 'TERMINATED');

    // No record of its own yet, and both of the rules that compare one against
    // the rest of the tree fall away with it: a row that does not exist cannot
    // be the root that already exists, and is above nobody, so no walk upward
    // can reach it.
    await this.checkManager(record.managerId, null);

    return this.employees.create(actor, {
      ...record,
      workPatternId: await this.resolveWorkPattern(record.workPatternId),
    });
  }

  /** Changes a record. */
  async update(actor: Actor, id: string, changes: EmployeeChanges): Promise<Employee> {
    return this.change(actor, id, employeePolicy.update, (current) =>
      validateEmployeeChanges(changes, current, this.domains),
    );
  }

  /** Records that somebody has left. FR 06. */
  async terminate(actor: Actor, id: string, termination: Termination): Promise<Employee> {
    return this.change(actor, id, employeePolicy.terminate, (current) =>
      planTermination(current, termination),
    );
  }

  /** Read, decide, write. */
  private async change(
    actor: Actor,
    id: string,
    permit: (actor: Actor, employee: Employee) => Decision,
    decide: (current: Employee) => Partial<ValidatedEmployee>,
  ): Promise<Employee> {
    const current = await this.findOrRefuse(actor, id);

    this.guard.enforce(permit(actor, current));

    const changes = decide(current);

    const employed = (changes.employmentStatus ?? current.employmentStatus) !== 'TERMINATED';

    if ('departmentId' in changes) {
      await this.checkDepartment(changes.departmentId!, employed);
    } else if (employed && current.employmentStatus === 'TERMINATED') {
      await this.checkDepartment(current.departmentId, true);
    }

    /**
     * The reporting line is the one field whose rules cannot be settled from this record alone: whether a manager exists, whether they are still here, an… LMS 104.
     */
    if ('managerId' in changes) {
      await this.checkManager(changes.managerId ?? null, current);
    }

    if ('workPatternId' in changes) {
      await this.checkWorkPattern(changes.workPatternId!);
    }

    const updated = await this.employees.update(actor, id, changes);
    if (updated === undefined) {
      // Gone between the read and the write. Not possible — nothing may delete
      // an employee, and the database now refuses the statement outright — but
      // reporting it is cheaper than returning undefined and making every caller
      // wonder.
      throw new EmployeeNotFound(id);
    }

    return updated;
  }

  /** The rules about a department that need the department itself to answer. LMS 105. */
  private async checkDepartment(departmentId: string, employed: boolean): Promise<void> {
    const department = await this.departments.findById(departmentId);

    if (department === undefined) {
      throw new DepartmentNotFound(departmentId);
    }
    if (employed) {
      assertCanTakeEmployees(department);
    }
  }

  /** The week a new record works, resolved to an id. FR 23, LMS 106. */
  private async resolveWorkPattern(workPatternId: string | null): Promise<string> {
    if (workPatternId !== null) {
      await this.checkWorkPattern(workPatternId);
      return workPatternId;
    }

    const standard = await this.patterns.findDefault();
    if (standard === undefined) {
      throw new DefaultWorkPatternRequired();
    }

    return standard.id;
  }

  /** That a working pattern named on a record is a working pattern. */
  private async checkWorkPattern(workPatternId: string): Promise<void> {
    if ((await this.patterns.findById(workPatternId)) === undefined) {
      throw new WorkPatternNotFound(workPatternId);
    }
  }

  /** The rules about a reporting line that need other records to answer. FR 02, FR 03, FR 04. */
  private async checkManager(managerId: string | null, employee: Employee | null): Promise<void> {
    if (managerId === null) {
      const root = await this.employees.findRoot();

      if (root !== undefined && root.id !== employee?.id) {
        throw new SecondRootEmployee(root);
      }
      return;
    }

    const chain = await this.employees.chainFrom(managerId);
    const manager = chain[0];

    if (manager === undefined) {
      throw new ManagerNotFound(managerId);
    }
    if (manager.employmentStatus === 'TERMINATED') {
      throw new ManagerHasLeft(manager);
    }

    if (employee !== null) {
      assertNoManagerCycle(employee, chain);
    }
  }

  /** What is wrong with the reporting lines as they stand. FR 02, FR 04. */
  async reportingLineWarnings(actor: Actor): Promise<ReportingLineWarning[]> {
    this.guard.enforce(employeePolicy.warnings(actor));

    return warnAboutReportingLines(await this.employees.reportingLines());
  }

  /** The employee with no line manager. FR 04. */
  async head(actor: Actor): Promise<Employee | undefined> {
    this.guard.enforce(employeePolicy.search(actor));

    return this.employees.findRoot();
  }

  async byId(actor: Actor, id: string): Promise<Employee> {
    const employee = await this.findOrRefuse(actor, id);

    this.guard.enforce(employeePolicy.read(actor, employee));

    return employee;
  }

  /** By employee number. LMS 112. */
  async byNumber(actor: Actor, employeeNumber: string): Promise<Employee | undefined> {
    this.guard.enforce(employeePolicy.search(actor));

    return this.employees.findByNumber(employeeNumber);
  }

  async byWorkEmail(actor: Actor, workEmail: string): Promise<Employee | undefined> {
    this.guard.enforce(employeePolicy.search(actor));

    return this.employees.findByWorkEmail(workEmail);
  }

  /** Everybody, leavers included, unless asked otherwise. */
  async list(actor: Actor, options: { activeOnly?: boolean } = {}): Promise<Employee[]> {
    this.guard.enforce(employeePolicy.list(actor));

    return this.employees.list(options);
  }

  /** The reporting structure, as a chart. FR 09, LMS 107. */
  async orgChart(actor: Actor): Promise<OrgChart> {
    this.guard.enforce(employeePolicy.chart(actor));

    return buildOrgChart(await this.employees.list());
  }

  /** The record, or the right refusal for an id that is nobody. NFR SEC 02. */
  private async findOrRefuse(actor: Actor, id: string): Promise<Employee> {
    const employee = await this.employees.findById(id);

    if (employee === undefined) {
      this.guard.enforce(employeePolicy.search(actor));
      throw new EmployeeNotFound(id);
    }

    return employee;
  }
}
