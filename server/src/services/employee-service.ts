/**
 * Creating, maintaining and deactivating employee records, and recording who
 * each of them reports to. FR 01 to FR 06. LMS 101 to LMS 104.
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
 *   No re-parenting when a manager leaves. {@link terminate} does not move the
 *   leaver's reports onto somebody else, because who they should go to is a
 *   decision rather than a rule, and guessing it in the termination path is how
 *   an entire team silently ends up reporting to the CEO. The condition is
 *   reported by {@link reportingLineWarnings} instead, for HR to answer. It
 *   needs doing, and it is not done.
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
   *
   * A line manager is required, and required explicitly: `managerId: null` says
   * "this is the head of the organisation" and is refused if somebody already
   * is. FR 02 and FR 04. See {@link checkManager}.
   */
  async create(input: NewEmployee): Promise<Employee> {
    const record = validateNewEmployee(input, this.domains);

    // No record of its own yet, and both of the rules that compare one against
    // the rest of the tree fall away with it: a row that does not exist cannot
    // be the root that already exists, and is above nobody, so no walk upward
    // can reach it.
    await this.checkManager(record.managerId, null);

    return this.employees.create(record);
  }

  /**
   * Changes a record. Only the fields present in `changes` are touched; see
   * {@link change} for why that distinction is kept all the way to the UPDATE.
   *
   * This is also the way a termination is corrected, and the way somebody
   * marked as having left is brought back — the record was never deleted, so
   * putting the status back to ACTIVE and clearing the exit date is an ordinary
   * edit rather than a re-creation with a new id and no history.
   *
   * Moving a reporting line is an ordinary edit too, and goes through the same
   * checks a new record's does. See {@link checkManager}.
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

    const changes = decide(current);

    /* The reporting line is the one field whose rules cannot be settled from
       this record alone: whether a manager exists, whether they are still here,
       and whether anybody else already has none are all questions about other
       rows. It sits here rather than in each caller so that every path that can
       move a line goes through it — today update(), tomorrow whatever LMS 104
       adds. planTermination() never produces one, so terminating skips it. */
    if ('managerId' in changes) {
      await this.checkManager(changes.managerId ?? null, current);
    }

    const updated = await this.employees.update(id, changes);
    if (updated === undefined) {
      // Gone between the read and the write. Not possible — nothing may delete
      // an employee, and the database now refuses the statement outright — but
      // reporting it is cheaper than returning undefined and making every caller
      // wonder.
      throw new EmployeeNotFound(id);
    }

    return updated;
  }

  /**
   * The rules about a reporting line that need other records to answer. FR 02,
   * FR 03 and FR 04.
   *
   * The domain has already decided that a line was named at all and that it is
   * not the employee's own id. What is left needs the table:
   *
   *   A manager who is somebody. A `managerId` the caller invented is a request
   *   that routes into nothing, and the foreign key would refuse it with a
   *   message about `employee_manager_id_fkey`.
   *
   *   A manager who is still here. Somebody who left in July is the same black
   *   hole as no manager at all. This is refused when the line is drawn; a
   *   manager who leaves afterwards cannot be caught here, because nobody
   *   touches the reports' records when it happens. That is
   *   {@link reportingLineWarnings}.
   *
   *   A line that does not loop. FR 03. Walking up from the proposed manager, if
   *   the employee turns up above them, then the proposed manager already reports
   *   to the employee and making them their manager joins the two ends.
   *
   *   At most one employee with none. FR 04. `employee` is what makes editing the
   *   existing head of the organisation work: they are already the root, and
   *   leaving them as it is not making a second one.
   *
   * `employee` is null when a record is being created, and both of the last two
   * fall away with it. A record that does not exist yet is above nobody, so no
   * walk can find it, and it cannot be the root that already exists.
   *
   * One read answers three of the four questions, because the walk starts at the
   * proposed manager: its first element is that manager, so whether they are
   * anybody and whether they have left come out of the same statement as the
   * loop.
   *
   * The check is not the enforcement. Between this and the write, another
   * transaction can commit a root, or the other half of a loop; the
   * employee_one_root index and the employee_no_manager_cycle trigger are what
   * actually decide, and the repository turns their refusals back into
   * {@link SecondRootEmployee} and `ManagerCycle`. Asking first is for the
   * message, not for the guarantee.
   */
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

  /**
   * What is wrong with the reporting lines as they stand. FR 02 and FR 04.
   *
   * The warning HR is shown for a condition that is already true, as against the
   * refusal they get for one they are in the middle of causing. Both exist
   * because they catch different things, and the difference is not tidiness:
   *
   *   {@link SecondRootEmployee} and {@link ManagerHasLeft} fire when somebody
   *   draws a bad line, in front of the person drawing it, while there is still
   *   something to refuse.
   *
   *   This fires for a line that was fine when it was drawn and is not any more.
   *   The manager left in March; nobody edited their reports' records, so no
   *   write-time check ever ran on them. Nothing but a standing question finds
   *   that, which is why the line-manager-rules migration leaves it to be asked
   *   rather than pretending a constraint could hold it.
   *
   * An empty list means every employee has somewhere for their requests to go.
   * It is a read, and safe to call from a dashboard, a nightly job or a support
   * request.
   */
  async reportingLineWarnings(): Promise<ReportingLineWarning[]> {
    return warnAboutReportingLines(await this.employees.reportingLines());
  }

  /** The employee with no line manager. FR 04 permits exactly one, so this is it. */
  async head(): Promise<Employee | undefined> {
    return this.employees.findRoot();
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
