/**
 * Creating, maintaining and deactivating employee records, recording who each of
 * them reports to, which team they are in and which week they work. FR 01 to
 * FR 06 and FR 23. LMS 101 to LMS 106.
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
 *   No departments. Creating, renaming and closing them is
 *   {@link DepartmentService}. What is here is the employee's end of it: which
 *   team they are in, and the two checks that keep an employed person out of a
 *   closed one. Moving somebody between teams is an ordinary {@link update}.
 *
 *   No working patterns. Creating and editing them is
 *   {@link WorkPatternService}. What is here is the employee's end of it again:
 *   which week this person works, the default that stands in when nobody says,
 *   and the check that the pattern named is a pattern. Moving somebody onto a
 *   different week is an ordinary {@link update} too.
 *
 *   No re-parenting when a manager leaves. {@link terminate} does not move the
 *   leaver's reports onto somebody else, because who they should go to is a
 *   decision rather than a rule, and guessing it in the termination path is how
 *   an entire team silently ends up reporting to the CEO. The condition is
 *   reported by {@link reportingLineWarnings} instead, for HR to answer. It
 *   needs doing, and it is not done.
 *
 *   No authorisation rules. Since LMS 112 every method takes an {@link Actor} and
 *   asks ../auth/employee-policy.ts what they may do — but the rules themselves
 *   are there and not here, and nothing in this file may grow an `if` about a
 *   role. What is here is *when* to ask, which is the same division of labour
 *   /domain and this file already have: the domain says what a rule is, the
 *   service says when it applies.
 *
 *   The one thing worth reading closely is {@link findOrRefuse}. "There is no
 *   such employee" is itself a disclosure, and it is answered there rather than
 *   at four call sites.
 *
 *   No sign in. Terminating still does not touch the leaver's app_user row, and
 *   since LMS 109 that is the decision rather than the gap it used to be.
 *   {@link SignInService.signIn} reads the employee record at the moment somebody
 *   knocks, so a TERMINATED status closes the door by itself. Writing a copy of
 *   it onto the account would be a second source of truth that is wrong in the
 *   worst direction: the termination recorded by some path that forgot to revoke
 *   the login leaves the leaver's access open, and nobody finds out until it is
 *   used. What changing a work address here *does* do is move the login with it,
 *   carried by a trigger rather than by this service — see the
 *   sign-in-account-rules migration.
 */

import type { Actor } from '../auth/actor.js';
import { allowedDomains } from '../auth/company-email.js';
import { employeePolicy } from '../auth/employee-policy.js';
import type { Decision, Guard } from '../auth/policy.js';
import { assertCanTakeEmployees, DepartmentNotFound } from '../domain/department.js';
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
import { buildOrgChart, type OrgChart } from '../domain/org-chart.js';
import { DefaultWorkPatternRequired, WorkPatternNotFound } from '../domain/work-pattern.js';
import type { DepartmentRepository } from '../repositories/department-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { WorkPatternRepository } from '../repositories/work-pattern-repository.js';

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
    /* A second repository rather than the DepartmentService, because what is
       needed here is one record read, not the department rules. Bringing the
       service would put "may this department be closed" behind the employee
       surface, which is not this layer's question. */
    private readonly departments: DepartmentRepository,
    /* And a third, for the same reason. What is wanted from working patterns
       here is two reads — does this pattern exist, and which one is the default
       — not the rules about what a pattern may contain. */
    private readonly patterns: WorkPatternRepository,
    /* NFR SEC 02. Required rather than defaulted, because a service that can be
       built without one is a service somebody builds without one, and the
       failure is silent: everything works, nothing is refused, and nothing is
       written down. See ../auth/policy.ts. */
    private readonly guard: Guard,
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
   *
   * A working pattern is not required, and that asymmetry is deliberate. There
   * is no right answer to "who does this person report to" but there is one to
   * "which week do they work": the one most people work. Naming a pattern is for
   * the part timer, which is the whole of what FR 23 is about; everybody else
   * gets the default without anybody having to look its id up.
   */
  async create(actor: Actor, input: NewEmployee): Promise<Employee> {
    /* First, before the record is even read. A caller who may not create an
       employee has no business finding out whether their proposed employee
       number is taken, and refusing after the validation would tell them. */
    this.guard.enforce(employeePolicy.create(actor));

    const record = validateNewEmployee(input, this.domains);

    /* A leaver being loaded from an old system may belong to a team that has
       since closed, and refusing that would make the history unimportable. Only
       somebody who is actually going to work here has to go into a team that is
       still open. */
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
  async update(actor: Actor, id: string, changes: EmployeeChanges): Promise<Employee> {
    return this.change(actor, id, employeePolicy.update, (current) =>
      validateEmployeeChanges(changes, current, this.domains),
    );
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
  async terminate(actor: Actor, id: string, termination: Termination): Promise<Employee> {
    return this.change(actor, id, employeePolicy.terminate, (current) =>
      planTermination(current, termination),
    );
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
    actor: Actor,
    id: string,
    /* The policy that judges this particular change. Passed in rather than
       decided here, because "may they edit this record" and "may they record
       that this person has left" are two questions with two answers and two
       lines in the denial log, and folding them into one would put the wrong
       word in that log. */
    permit: (actor: Actor, employee: Employee) => Decision,
    decide: (current: Employee) => Partial<ValidatedEmployee>,
  ): Promise<Employee> {
    const current = await this.findOrRefuse(actor, id);

    /* After the read and before anything else. The record is needed to decide —
       a line manager's standing towards it is on the record — and nothing has
       happened yet that a refused caller could observe. */
    this.guard.enforce(permit(actor, current));

    const changes = decide(current);

    /* Whether the record will still be somebody who works here once this change
       lands, which is what both department rules turn on. */
    const employed = (changes.employmentStatus ?? current.employmentStatus) !== 'TERMINATED';

    if ('departmentId' in changes) {
      await this.checkDepartment(changes.departmentId!, employed);
    } else if (employed && current.employmentStatus === 'TERMINATED') {
      /* Coming back from terminated, which is how a mistaken termination is
         corrected. Nobody edited their department while they were gone, so
         nothing checked it, and it may have been closed in the meantime — which
         would put an employed person in a team no report offers. This is the one
         path into that state, so it is the one place to close it. */
      await this.checkDepartment(current.departmentId, true);
    }

    /* The reporting line is the one field whose rules cannot be settled from
       this record alone: whether a manager exists, whether they are still here,
       and whether anybody else already has none are all questions about other
       rows. It sits here rather than in each caller so that every path that can
       move a line goes through it — today update(), tomorrow whatever LMS 104
       adds. planTermination() never produces one, so terminating skips it. */
    if ('managerId' in changes) {
      await this.checkManager(changes.managerId ?? null, current);
    }

    /* Moving somebody onto a different week. The domain has established that a
       pattern was named; whether it is one is a question about another table.
       There is no clearing it and so no equivalent of the reinstatement case
       above: a pattern is never closed, so the one somebody is on cannot become
       unusable while nobody is looking. */
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

  /**
   * The rules about a department that need the department itself to answer.
   * LMS 105.
   *
   * The domain has already decided that a team was named at all. What is left
   * needs the other table:
   *
   *   A department that is somebody. An invented id is an employee filed under a
   *   heading that does not exist, and the foreign key would refuse it with a
   *   message about `employee_department_id_fkey`.
   *
   *   One that is still open, but only for somebody who still works here.
   *   `employed` is what carries that distinction: a leaver may sit in a team
   *   that has since closed, which is how history imports and how a leaver's
   *   record stays untouched when their old team is wound up, but nobody who is
   *   going to raise a request may.
   *
   * Together with the headcount rule that {@link DepartmentService.deactivate}
   * applies, these leave no way to reach an employed person in a closed team:
   * one end refuses moving somebody in, the other refuses closing it under them,
   * and the reinstatement path above covers the gap between the two.
   */
  private async checkDepartment(departmentId: string, employed: boolean): Promise<void> {
    const department = await this.departments.findById(departmentId);

    if (department === undefined) {
      throw new DepartmentNotFound(departmentId);
    }
    if (employed) {
      assertCanTakeEmployees(department);
    }
  }

  /**
   * The week a new record works, resolved to an id. FR 23, LMS 106.
   *
   * `null` is the caller not having said, which is the ordinary case and means
   * the standard week. The default is read here rather than defaulted in the
   * column, because which pattern is the default is a row in another table and a
   * DDL default cannot read one — and rather than in the repository, because
   * "what should stand in" is a decision and this is the layer that makes them.
   *
   * {@link DefaultWorkPatternRequired} when there is none. That is not a case
   * that occurs against a migrated database: the working-pattern-rules migration
   * inserts the standard week, a deferred trigger refuses its removal, and a
   * unique index refuses a second. It is reported rather than worked around
   * because the alternatives are worse — picking some other pattern would put a
   * joiner on a week nobody chose, and refusing to say why would leave an HR
   * officer looking at a foreign key violation.
   */
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

  /**
   * That a working pattern named on a record is a working pattern.
   *
   * The one rule here that needs the other table, and the counterpart of
   * {@link checkDepartment}'s first half. An invented id is somebody whose leave
   * is counted against a week that does not exist, and the foreign key would
   * refuse it with a message about `employee_work_pattern_id_fkey`.
   *
   * There is no second half. A department can be closed and so has to be checked
   * for that; a pattern has no closed state, because it is not a heading on a
   * report that outlives the team — it is a week, and a week that nobody works is
   * deleted rather than retired. See {@link WorkPatternService.remove}.
   */
  private async checkWorkPattern(workPatternId: string): Promise<void> {
    if ((await this.patterns.findById(workPatternId)) === undefined) {
      throw new WorkPatternNotFound(workPatternId);
    }
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
  async reportingLineWarnings(actor: Actor): Promise<ReportingLineWarning[]> {
    this.guard.enforce(employeePolicy.warnings(actor));

    return warnAboutReportingLines(await this.employees.reportingLines());
  }

  /** The employee with no line manager. FR 04 permits exactly one, so this is it. */
  async head(actor: Actor): Promise<Employee | undefined> {
    this.guard.enforce(employeePolicy.search(actor));

    return this.employees.findRoot();
  }

  async byId(actor: Actor, id: string): Promise<Employee> {
    const employee = await this.findOrRefuse(actor, id);

    this.guard.enforce(employeePolicy.read(actor, employee));

    return employee;
  }

  /**
   * By employee number. Undefined rather than a throw, because asking whether a
   * number is taken is a fair question — from somebody entitled to ask it.
   *
   * That entitlement is the whole of what changed in LMS 112. A lookup by number
   * or by address is a directory search, so it is HR's; see
   * {@link employeePolicy.search}.
   */
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

  /**
   * The reporting structure, as a chart. FR 09. LMS 107.
   *
   * The story's own method: an HR officer looking at the organisation and seeing
   * that somebody's manager is wrong or missing, before a request is raised and
   * routed at them. {@link reportingLineWarnings} answers the same worry as a
   * list of sentences; this answers it as a shape, and the two catch different
   * mistakes. A warning finds the manager who has left. Only a chart finds the
   * new starter put under the wrong team lead, because nothing is *invalid* about
   * that record — it is simply in the wrong place, and being in the wrong place
   * is a thing you see rather than a thing you check.
   *
   * **Leavers are on it, and that is the decision worth knowing.** A chart of
   * only the currently employed would quietly drop a manager who has left and
   * leave their whole team hanging off nobody, which is the exact condition the
   * story exists to catch and the one it would then hide. Every node carries the
   * record, so a screen greys out anybody TERMINATED and the text rendering marks
   * them; either way they are visible rather than absent.
   *
   * One statement, and the tree is built from it in memory. The organisation is
   * a few hundred rows and this is not the recursive walk
   * {@link EmployeeRepository.chainFrom} does — that one goes up one line and is
   * a query because it must stop early, and this one is every line at once, which
   * is every row either way. Building it here keeps the whole of the shaping in a
   * pure function that can be tested against organisations no database would
   * accept, loops included. See ../domain/org-chart.ts.
   */
  async orgChart(actor: Actor): Promise<OrgChart> {
    this.guard.enforce(employeePolicy.chart(actor));

    return buildOrgChart(await this.employees.list());
  }

  /**
   * The record, or the right refusal for an id that is nobody. NFR SEC 02.
   *
   * This is the method the story turns on, so it is worth the paragraph.
   *
   * "A colleague cannot reach them by guessing a web address" is not satisfied
   * by refusing to show them the record. It is satisfied by refusing to *answer*,
   * and a system that says `EmployeeNotFound` for an id that is nobody and
   * `NotAuthorised` for an id that is somebody has answered: the pair of them is
   * a working existence oracle, and running it over a list of guesses is exactly
   * the attack the story describes.
   *
   * So being told that a record is missing is itself a permission, and it is the
   * one {@link employeePolicy.search} grants — the same permission as looking
   * somebody up by employee number, because it is the same question asked with a
   * different key. Anybody who may search is told plainly that there is no such
   * record, which is what makes a mistyped id a five second problem for HR.
   * Anybody who may not gets the one sentence that covers both cases, and
   * learns nothing by repeating it.
   *
   * Every path that takes an id from a caller goes through here, which is the
   * only way a property like this survives the next method somebody adds.
   */
  private async findOrRefuse(actor: Actor, id: string): Promise<Employee> {
    const employee = await this.employees.findById(id);

    if (employee === undefined) {
      this.guard.enforce(employeePolicy.search(actor));
      throw new EmployeeNotFound(id);
    }

    return employee;
  }
}
