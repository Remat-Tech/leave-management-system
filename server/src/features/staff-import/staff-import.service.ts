/** Loading staff from a spreadsheet, with a dry run first. FR 08, LMS 107, LMS 112. */

import type { Actor } from '../../auth/actor.js';
import { allowedDomains, NotACompanyEmail } from '../sign-in/company-email.js';
import { employeePolicy } from '../employee/policy.js';
import type { Guard } from '../../auth/policy.js';
import {
  assertCanTakeEmployees,
  type Department,
  DepartmentDeactivated,
} from '../department/department.js';
import {
  DuplicateEmployeeNumber,
  DuplicateWorkEmail,
  type Employee,
  type EmployeeChanges,
  InvalidEmployee,
  ManagerHasLeft,
  ManagerNotFound,
  type NewEmployee,
  validateEmployeeChanges,
  validateNewEmployee,
} from '../employee/employee.js';
import { cellOf, readSheet } from './spreadsheet.js';
import {
  type ColumnMapping,
  compare,
  type CurrentRow,
  type DraftRow,
  fingerprintOf,
  findManagerCycles,
  type ImportField,
  type ImportPlan,
  ImportChangedSinceDryRun,
  ImportWouldRejectRows,
  InvalidImportRow,
  key,
  orderForWriting,
  type PlannedChange,
  type PlannedCreate,
  readDraft,
  type RejectedRow,
  resolveColumnMapping,
  type UnchangedRow,
} from './staff-import.js';
import type { WorkPattern } from '../work-pattern/work-pattern.js';
import type { Repositories, Transactions } from '../../db/transaction.js';
import { EmployeeService, type EmployeeServiceOptions } from '../employee/employee.service.js';

export interface ImportOptions {
  /** Which heading holds which field. FR 08. */
  mapping?: ColumnMapping;
  /** What separates the cells. */
  delimiter?: string;
}

export interface ConfirmOptions extends ImportOptions {
  /** Import the readable rows even though some rows were rejected. */
  withoutTheRejectedRows?: boolean;
}

/** What a confirmed import actually did. */
export interface ImportOutcome {
  created: Employee[];
  changed: Employee[];
  /** Rows that named somebody whose record already said what the file said. */
  unchanged: number;
  /** Rows that were rejected and deliberately left out. */
  skipped: RejectedRow[];
}

/**
 * The organisation as it stands, in the shapes the planner needs to ask about it a few hundred times.
 */
interface Organisation {
  employeeByNumber: Map<string, Employee>;
  employeeByEmail: Map<string, Employee>;
  numberById: Map<string, string>;
  departmentByName: Map<string, Department>;
  departmentById: Map<string, Department>;
  patternByName: Map<string, WorkPattern>;
  patternById: Map<string, WorkPattern>;
  /** The employee number of the one employee with no line manager. FR 04. */
  headNumber: string | null;
}

/** What InvalidEmployee calls a field, in the words the file uses for it. */
const IMPORT_FIELD_OF: Record<string, ImportField> = {
  employeeNumber: 'employeeNumber',
  firstName: 'firstName',
  lastName: 'lastName',
  workEmail: 'workEmail',
  jobTitle: 'jobTitle',
  departmentId: 'department',
  managerId: 'manager',
  workPatternId: 'workPattern',
  startDate: 'startDate',
  exitDate: 'exitDate',
  employmentType: 'employmentType',
  employmentStatus: 'employmentStatus',
  gender: 'gender',
};

export class StaffImportService {
  private readonly domains: string[];

  constructor(
    private readonly transactions: Transactions,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    options: EmployeeServiceOptions = {},
  ) {
    // Resolved once, at construction, exactly as EmployeeService does it, so a
    // misconfigured environment stops the application starting rather than
    // failing at whichever import first happens to need it.
    this.domains = options.domains ?? allowedDomains();
  }

  /** Reads the file and says what would happen. FR 08. */
  async dryRun(actor: Actor, source: string, options: ImportOptions = {}): Promise<ImportPlan> {
    this.guard.enforce(employeePolicy.importStaff(actor));

    return this.transactions.allOrNothing(
      async (repositories) => (await this.plan(repositories, source, options)).plan,
    );
  }

  /** Applies the plan the HR officer confirmed. */
  async confirm(
    actor: Actor,
    source: string,
    fingerprint: string,
    options: ConfirmOptions = {},
  ): Promise<ImportOutcome> {
    this.guard.enforce(employeePolicy.importStaff(actor));

    return this.transactions.allOrNothing(async (repositories) => {
      const { plan, organisation } = await this.plan(repositories, source, options);

      if (plan.fingerprint !== fingerprint) {
        throw new ImportChangedSinceDryRun();
      }

      if (plan.rejected.length > 0 && options.withoutTheRejectedRows !== true) {
        throw new ImportWouldRejectRows(plan.rejected);
      }

      return this.write(actor, repositories, plan, organisation);
    });
  }

  /** The dry run itself: file to plan, with nothing written. */
  private async plan(
    repositories: Repositories,
    source: string,
    options: ImportOptions,
  ): Promise<{ plan: ImportPlan; organisation: Organisation }> {
    const sheet = readSheet(source, { delimiter: options.delimiter });
    const mapping = resolveColumnMapping(sheet.headings, options.mapping);
    const organisation = await readOrganisation(repositories);

    const rejected = new Map<number, RejectedRow>();
    const drafts: DraftRow[] = [];

    for (const row of sheet.rows) {
      try {
        drafts.push(readDraft(row, mapping));
      } catch (error) {
        if (!(error instanceof InvalidImportRow)) {
          throw error;
        }
        rejected.set(row.line, {
          line: row.line,
          employeeNumber: cellOf(row, mapping.employeeNumber) || null,
          field: error.field,
          reason: error.message,
        });
      }
    }

    const rejectLine = (
      line: number,
      employeeNumber: string | null,
      field: ImportField | null,
      reason: string,
    ) => {
      if (!rejected.has(line)) {
        rejected.set(line, { line, employeeNumber, field, reason });
      }
    };

    const reject: Reject = (draft, field, reason) =>
      rejectLine(draft.line, draft.employeeNumber, field, reason);

    const surviving = () => drafts.filter((draft) => !rejected.has(draft.line));

    rejectDuplicatesWithinFile(surviving(), reject);
    rejectReportingLineLoops(surviving(), organisation, reject);
    rejectChangesToTheHeadOfOrganisation(surviving(), organisation, reject);

    const creates: PlannedCreate[] = [];
    const changes: PlannedChange[] = [];
    const unchanged: UnchangedRow[] = [];

    const byNumber = new Map(surviving().map((draft) => [key(draft.employeeNumber), draft]));

    for (const draft of surviving()) {
      try {
        this.classify(draft, { organisation, byNumber, creates, changes, unchanged });
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === undefined) {
          throw error;
        }
        reject(draft, refusal.field, refusal.reason);
      }
    }

    rejectRowsLeftWithoutAManager(creates, changes, organisation, rejectLine);

    const plan = {
      mapping,
      creates,
      changes,
      unchanged,
      rejected: [...rejected.values()].sort((a, b) => a.line - b.line),
    };

    return { plan: { ...plan, fingerprint: fingerprintOf(plan) }, organisation };
  }

  /** One row, against the organisation: what would this do? */
  private classify(
    draft: DraftRow,
    context: {
      organisation: Organisation;
      byNumber: Map<string, DraftRow>;
      creates: PlannedCreate[];
      changes: PlannedChange[];
      unchanged: UnchangedRow[];
    },
  ): void {
    const { organisation, byNumber } = context;

    const department = organisation.departmentByName.get(draft.department.trim().toLowerCase());
    if (department === undefined) {
      throw new InvalidImportRow(
        'department',
        `There is no department called "${draft.department}". Departments are not ` +
          'created by an import — the usual cause of a name nothing matches is a typo, ' +
          'and guessing produces two teams with almost the same name and a headcount ' +
          'report that splits in half. Create the department first, or correct the ' +
          `spelling. The departments that exist are ${namesOf(organisation.departmentById)}.`,
      );
    }

    let workPatternId: string | undefined;
    if (draft.workPattern !== undefined) {
      const pattern = organisation.patternByName.get(draft.workPattern.trim().toLowerCase());
      if (pattern === undefined) {
        throw new InvalidImportRow(
          'workPattern',
          `There is no working pattern called "${draft.workPattern}". Leave the cell ` +
            'empty for the standard week, or create the pattern first. The patterns ' +
            `that exist are ${namesOf(organisation.patternById)}.`,
        );
      }
      workPatternId = pattern.id;
    }

    this.checkManagerReference(draft, organisation, byNumber);

    const existing = organisation.employeeByNumber.get(key(draft.employeeNumber));

    if (existing === undefined) {
      context.creates.push(this.planCreate(draft, department, workPatternId, organisation));
      return;
    }

    const planned = this.planChange(draft, existing, department, workPatternId, organisation);

    if (planned === undefined) {
      context.unchanged.push({
        line: draft.line,
        employeeNumber: existing.employeeNumber,
        fullName: `${existing.firstName} ${existing.lastName}`,
      });
      return;
    }

    context.changes.push(planned);
  }

  /**
   * That the line manager the row names is somebody, and somebody still here.
   * FR 02.
   *
   * "Somebody" includes a person the same file creates four lines further down,
   * which is the ordinary case at go live: the whole organisation arrives in one
   * spreadsheet and almost every manager in it is a row of the same file.
   * {@link orderForWriting} is what makes that true by the time anything is
   * written.
   *
   * Whether the line *loops* is not asked here. That is a question about the
   * whole graph rather than about this row, and it has already been answered by
   * {@link findManagerCycles} before classification starts.
   */
  private checkManagerReference(
    draft: DraftRow,
    organisation: Organisation,
    byNumber: Map<string, DraftRow>,
  ): void {
    if (draft.manager === null) {
      return;
    }

    const manager = organisation.employeeByNumber.get(key(draft.manager));
    const inFile = byNumber.get(key(draft.manager));

    if (manager === undefined && inFile === undefined) {
      throw new InvalidImportRow(
        'manager',
        `No employee has the number "${draft.manager}", and no row of this file ` +
          'creates one. A record whose line manager is nobody is a record whose leave ' +
          'requests have nowhere to go. Correct the number, add the manager to the ' +
          'file, or leave the cell empty if this really is the head of the ' +
          'organisation.',
      );
    }

    /* What the manager's status will be once this import lands: what the file
       says about them if it says anything, otherwise what their record says,
       otherwise the default a new record gets. Reading only the record would let
       a file that reinstates a manager on line 4 be refused on line 5. */
    const status = inFile?.employmentStatus ?? manager?.employmentStatus ?? 'ACTIVE';

    if (status !== 'TERMINATED') {
      return;
    }

    if (manager !== undefined && inFile === undefined) {
      // A leaver already on the books, so their record can say when they went.
      throw new ManagerHasLeft(manager);
    }

    throw new InvalidImportRow(
      'manager',
      `This file records ${draft.manager} as having left, so they cannot be anybody's ` +
        'line manager. A request routed to them would have nowhere to go.',
    );
  }

  /** A row naming somebody who is not here yet. */
  private planCreate(
    draft: DraftRow,
    department: Department,
    workPatternId: string | undefined,
    organisation: Organisation,
  ): PlannedCreate {
    const clash = organisation.employeeByEmail.get(draft.workEmail);
    if (clash !== undefined) {
      throw new DuplicateWorkEmail(draft.workEmail);
    }

    const record: Omit<NewEmployee, 'managerId'> = {
      employeeNumber: draft.employeeNumber,
      firstName: draft.firstName,
      lastName: draft.lastName,
      workEmail: draft.workEmail,
      departmentId: department.id,
      startDate: draft.startDate,
      ...(draft.jobTitle !== undefined && { jobTitle: draft.jobTitle }),
      ...(workPatternId !== undefined && { workPatternId }),
      ...(draft.exitDate !== undefined && { exitDate: draft.exitDate }),
      ...(draft.employmentType !== undefined && { employmentType: draft.employmentType }),
      ...(draft.employmentStatus !== undefined && { employmentStatus: draft.employmentStatus }),
      ...(draft.gender !== undefined && { gender: draft.gender }),
    };

    validateNewEmployee({ ...record, managerId: draft.manager }, this.domains);

    if ((draft.employmentStatus ?? 'ACTIVE') !== 'TERMINATED') {
      assertCanTakeEmployees(department);
    }

    return {
      line: draft.line,
      employeeNumber: draft.employeeNumber,
      fullName: `${draft.firstName} ${draft.lastName}`,
      draft,
      record,
      managerNumber: draft.manager,
    };
  }

  /**
   * A row naming somebody who is already here, or nothing at all when their
   * record already says what the file says.
   *
   * Undefined is the answer worth having. On the second run of a file — and
   * there is always a second run, because the first one found eleven bad rows —
   * almost every row is this, and reporting them as changes to nothing would
   * bury the four rows that matter.
   */
  private planChange(
    draft: DraftRow,
    existing: Employee,
    department: Department,
    workPatternId: string | undefined,
    organisation: Organisation,
  ): PlannedChange | undefined {
    const current: CurrentRow = {
      employee: existing,
      departmentName: organisation.departmentById.get(existing.departmentId)?.name ?? '',
      managerNumber:
        existing.managerId === null
          ? null
          : (organisation.numberById.get(existing.managerId) ?? null),
      workPatternName: organisation.patternById.get(existing.workPatternId)?.name ?? '',
    };

    const comparison = compare(current, draft);

    if (comparison.differences.length === 0) {
      return undefined;
    }

    const changes: Omit<EmployeeChanges, 'managerId'> = { ...comparison.changes };

    if (comparison.movesDepartment) {
      changes.departmentId = department.id;
    }
    if (comparison.movesWorkPattern) {
      // Only ever true when the file named a pattern, which is the only way
      // workPatternId is resolved above.
      changes.workPatternId = workPatternId!;
    }

    if (comparison.changes.workEmail !== undefined) {
      const clash = organisation.employeeByEmail.get(draft.workEmail);
      if (clash !== undefined && clash.id !== existing.id) {
        throw new DuplicateWorkEmail(draft.workEmail);
      }
    }

    /* The record rules again, and the manager reference stood in the same way
       planCreate() stands it in. One check inside validateEmployeeChanges() does
       not fire as a result — "an employee cannot be their own line manager",
       which compares against the record's id — and it does not need to: a row
       naming itself is a loop of length one, and findManagerCycles() has already
       rejected it by the time anything gets here. */
    validateEmployeeChanges(
      {
        ...changes,
        ...(comparison.movesManager && { managerId: draft.manager }),
      },
      existing,
      this.domains,
    );

    const employed =
      (comparison.changes.employmentStatus ?? existing.employmentStatus) !== 'TERMINATED';

    if (comparison.movesDepartment) {
      if (employed) {
        assertCanTakeEmployees(department);
      }
    } else if (employed && existing.employmentStatus === 'TERMINATED') {
      /* Bringing a leaver back, which is how a mistaken termination is corrected
         and a perfectly ordinary thing for a file to do. Nobody edited their
         department while they were gone, so nothing checked it, and it may have
         closed in the meantime. EmployeeService.change() closes the same gap the
         same way; this is here so the refusal appears in the dry run rather than
         only at the write. */
      const own = organisation.departmentById.get(existing.departmentId);
      if (own !== undefined) {
        assertCanTakeEmployees(own);
      }
    }

    return {
      line: draft.line,
      employeeId: existing.id,
      employeeNumber: existing.employeeNumber,
      fullName: `${existing.firstName} ${existing.lastName}`,
      changes,
      ...(comparison.movesManager && { managerNumber: draft.manager }),
      differences: comparison.differences,
    };
  }

  /**
   * Writes the confirmed plan, through the ordinary employee rules, in one
   * transaction.
   *
   * The ids are carried in a map that starts as the organisation and grows as
   * each row is created, which is what lets a joiner on line 40 report to a
   * joiner on line 12 who did not exist when the file was written either.
   * {@link orderForWriting} guarantees the manager comes first; the map is how
   * the id gets from there to here.
   *
   * Row at a time rather than one multi-row insert, deliberately. What is bought
   * is that every row goes through {@link EmployeeService} — the department
   * checks, the reporting line walk, the one root rule — so the import cannot
   * write a record the form would have refused. What it costs is a round trip
   * per row, which for a few hundred rows once at go live is the right side of
   * that trade by a very long way.
   */
  private async write(
    actor: Actor,
    repositories: Repositories,
    plan: ImportPlan,
    organisation: Organisation,
  ): Promise<ImportOutcome> {
    /* The same guard this service was built with, so that a row refused four
       hundred deep is written to the same log as anything else. The actor is the
       HR officer who confirmed the import, carried down rather than replaced by
       a system actor — a bulk write is still something a person did, and the
       trail should say who. */
    const employees = new EmployeeService(
      repositories.employees,
      repositories.departments,
      repositories.patterns,
      this.guard,
      { domains: this.domains },
    );

    const idOf = new Map<string, string>();
    for (const [number, employee] of organisation.employeeByNumber) {
      idOf.set(number, employee.id);
    }

    const managerId = (number: string | null): string | null => {
      if (number === null) {
        return null;
      }

      const id = idOf.get(key(number));
      if (id === undefined) {
        // Unreachable: the plan established that this manager is either already
        // here or created by an earlier operation. Reported rather than left as
        // an undefined flowing into an insert, which would surface as a foreign
        // key violation naming a constraint instead of a person.
        throw new ManagerNotFound(number);
      }

      return id;
    };

    const created: Employee[] = [];
    const changed: Employee[] = [];

    for (const operation of orderForWriting(plan, reportingLinesAfter(plan, organisation))) {
      if (operation.kind === 'create') {
        const employee = await employees.create(actor, {
          ...operation.create.record,
          managerId: managerId(operation.create.managerNumber),
        });

        idOf.set(key(employee.employeeNumber), employee.id);
        created.push(employee);
        continue;
      }

      const { change } = operation;
      const changes: EmployeeChanges = { ...change.changes };

      if ('managerNumber' in change) {
        changes.managerId = managerId(change.managerNumber ?? null);
      }

      changed.push(await employees.update(actor, change.employeeId, changes));
    }

    return {
      created,
      changed,
      unchanged: plan.unchanged.length,
      skipped: plan.rejected,
    };
  }
}

/** The whole organisation, in one read, in the shapes the planner asks for. */
async function readOrganisation(repositories: Repositories): Promise<Organisation> {
  const [employees, departments, patterns] = await Promise.all([
    repositories.employees.list(),
    repositories.departments.list(),
    repositories.patterns.list(),
  ]);

  return {
    employeeByNumber: new Map(employees.map((one) => [key(one.employeeNumber), one])),
    employeeByEmail: new Map(employees.map((one) => [one.workEmail.toLowerCase(), one])),
    numberById: new Map(employees.map((one) => [one.id, one.employeeNumber])),
    departmentByName: new Map(departments.map((one) => [one.name.trim().toLowerCase(), one])),
    departmentById: new Map(departments.map((one) => [one.id, one])),
    patternByName: new Map(patterns.map((one) => [one.name.trim().toLowerCase(), one])),
    patternById: new Map(patterns.map((one) => [one.id, one])),
    headNumber: employees.find((one) => one.managerId === null)?.employeeNumber ?? null,
  };
}

type Reject = (draft: DraftRow, field: ImportField | null, reason: string) => void;

/** The same, for a row that has already been read past its draft. */
type RejectLine = (
  line: number,
  employeeNumber: string | null,
  field: ImportField | null,
  reason: string,
) => void;

/**
 * Rows whose line manager was on a row that got rejected.
 *
 * The last pass, and the only one that has to run after classification, because
 * until then it is not known which rows survive. A joiner reporting to a joiner
 * three lines up is the ordinary case at go live; if those three lines were
 * refused for a work address that is not a company one, the manager the first row
 * names is never going to exist.
 *
 * It matters only on the path that imports the readable rows anyway — with every
 * rejection honoured, the confirmation is refused before any of this could bite.
 * On that path it is the difference between a report that says two rows were
 * skipped and a write that gets halfway and rolls back with a foreign key
 * violation naming a constraint.
 *
 * Repeated until nothing more falls out, because the row that has just been
 * rejected may itself have been somebody's line manager. Each pass removes at
 * least one row, so it ends.
 */
function rejectRowsLeftWithoutAManager(
  creates: PlannedCreate[],
  changes: PlannedChange[],
  organisation: Organisation,
  rejectLine: RejectLine,
): void {
  for (;;) {
    const present = new Set([
      ...organisation.employeeByNumber.keys(),
      ...creates.map((create) => key(create.employeeNumber)),
    ]);

    const orphaned = (managerNumber: string | null | undefined) =>
      managerNumber != null && !present.has(key(managerNumber));

    const because = (managerNumber: string) =>
      `${managerNumber} is the line manager on this row, and the row that would have ` +
      'created them was itself rejected, so there would be nobody for this person to ' +
      'report to. Correct that row, or give this one a different line manager.';

    const create = creates.findIndex((one) => orphaned(one.managerNumber));
    if (create !== -1) {
      const [removed] = creates.splice(create, 1);
      rejectLine(
        removed!.line,
        removed!.employeeNumber,
        'manager',
        because(removed!.managerNumber!),
      );
      continue;
    }

    const change = changes.findIndex(
      (one) => 'managerNumber' in one && orphaned(one.managerNumber),
    );
    if (change !== -1) {
      const [removed] = changes.splice(change, 1);
      rejectLine(
        removed!.line,
        removed!.employeeNumber,
        'manager',
        because(removed!.managerNumber!),
      );
      continue;
    }

    return;
  }
}

/**
 * A manager id that resolves to nobody, in the key space employee numbers are
 * compared in.
 *
 * Deliberately not `null`, which would make that person look like the head of
 * the organisation and quietly miscount the roots, and deliberately not anything
 * an employee number could be, so a walk upward stops there rather than
 * following it. `employee_manager_id_fkey` makes it unreachable; it is carried
 * because a silent miscount is a worse way to find that out than a dead end.
 */
const UNRESOLVED_MANAGER = ' unresolved';

/** The reporting lines as the database holds them, keyed by employee number. */
function currentReportingLines(organisation: Organisation): Map<string, string | null> {
  const managerOf = new Map<string, string | null>();

  for (const employee of organisation.employeeByNumber.values()) {
    managerOf.set(
      key(employee.employeeNumber),
      employee.managerId === null
        ? null
        : (optionalKey(organisation.numberById.get(employee.managerId)) ?? UNRESOLVED_MANAGER),
    );
  }

  return managerOf;
}

/**
 * The reporting lines as they will stand once the plan has landed.
 *
 * What {@link orderForWriting} places each row by. Both halves are needed: a row
 * the file does not touch keeps the line it has, and it is those untouched
 * records that most of the file's rows will end up hanging from.
 */
function reportingLinesAfter(
  plan: ImportPlan,
  organisation: Organisation,
): Map<string, string | null> {
  const managerOf = currentReportingLines(organisation);

  for (const create of plan.creates) {
    managerOf.set(
      key(create.employeeNumber),
      create.managerNumber === null ? null : key(create.managerNumber),
    );
  }

  for (const change of plan.changes) {
    if ('managerNumber' in change) {
      const manager = change.managerNumber ?? null;
      managerOf.set(key(change.employeeNumber), manager === null ? null : key(manager));
    }
  }

  return managerOf;
}

/**
 * Two rows of the file claiming to be the same person. FR 01.
 *
 * Both are rejected, not the second. Which of them is right is not knowable from
 * the file — one is a correction of the other, or a paste that went in twice, or
 * two genuinely different people whose numbers collided — and importing whichever
 * happened to come first is a coin toss with somebody's record. Naming both lines
 * turns it into thirty seconds of looking.
 *
 * The database says the same thing through employee_number_unique and
 * employee_work_email_unique, and would refuse the second row at the write. What
 * this adds is both line numbers, before anything is written.
 */
function rejectDuplicatesWithinFile(drafts: DraftRow[], reject: Reject): void {
  const duplicates = (
    field: ImportField,
    identifierOf: (draft: DraftRow) => string,
    describe: (draft: DraftRow, lines: number[]) => string,
  ) => {
    const groups = new Map<string, DraftRow[]>();

    for (const draft of drafts) {
      const identifier = identifierOf(draft);
      const group = groups.get(identifier);
      if (group === undefined) {
        groups.set(identifier, [draft]);
      } else {
        group.push(draft);
      }
    }

    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }

      const lines = group.map((draft) => draft.line);
      for (const draft of group) {
        reject(
          draft,
          field,
          describe(
            draft,
            lines.filter((line) => line !== draft.line),
          ),
        );
      }
    }
  };

  duplicates(
    'employeeNumber',
    (draft) => key(draft.employeeNumber),
    (draft, others) =>
      `The employee number ${draft.employeeNumber} is on more than one row of this ` +
      `file: ${describeLines(others)}. An employee number belongs to one person, and ` +
      'nothing in the file says which of these rows is the right one, so none of them ' +
      'is imported. Delete or correct the rows that are wrong.',
  );

  duplicates(
    'workEmail',
    (draft) => draft.workEmail,
    (draft, others) =>
      `The work address ${draft.workEmail} is on more than one row of this file: ` +
      `${describeLines(others)}. A work address belongs to one person — it is what ` +
      'they sign in with — so none of these rows is imported. Correct the addresses ' +
      'that are wrong.',
  );
}

/**
 * Reporting lines that would loop once the file lands. FR 03, and the cycle
 * detection FR 08 asks for.
 *
 * The graph swept is the organisation *as it would be*: everybody already in the
 * database, with the file's rows written over the top. Both halves are needed
 * and neither is enough. A file that only moves two existing people can close a
 * loop through six others it never mentions; a file that is the whole company at
 * go live closes its loops entirely among rows that are not in the database yet.
 *
 * Every row in a loop is rejected, and the message names the loop in order, so
 * an HR officer can see which of the three lines is the one that is wrong. That
 * is the whole reason for doing this here rather than leaving it to
 * `employee_no_manager_cycle`: the trigger is deferred, so it fires at COMMIT
 * with the transaction already rolled back and can say only that the file
 * contains a loop. It stays where it is as the backstop for everything that
 * never comes through this code.
 */
function rejectReportingLineLoops(
  drafts: DraftRow[],
  organisation: Organisation,
  reject: Reject,
): void {
  const managerOf = currentReportingLines(organisation);
  const shownAs = new Map<string, string>();

  for (const employee of organisation.employeeByNumber.values()) {
    shownAs.set(key(employee.employeeNumber), employee.employeeNumber);
  }

  const draftsByNumber = new Map<string, DraftRow>();

  for (const draft of drafts) {
    const identifier = key(draft.employeeNumber);
    draftsByNumber.set(identifier, draft);
    shownAs.set(identifier, draft.employeeNumber);
    managerOf.set(identifier, draft.manager === null ? null : key(draft.manager));
  }

  for (const loop of findManagerCycles(managerOf)) {
    const named = loop.map((identifier) => shownAs.get(identifier) ?? identifier);

    const description =
      named.length === 1
        ? `${named[0]} is recorded as their own line manager, so their requests would ` +
          'be theirs to approve and would never leave them.'
        : `${named
            .map((number, index) => `${number} reports to ${named[(index + 1) % named.length]}`)
            .join(', ')}. A request walking up that line would go round for ever and ` +
          'reach nobody.';

    for (const identifier of loop) {
      const draft = draftsByNumber.get(identifier);
      if (draft !== undefined) {
        reject(
          draft,
          'manager',
          `Importing this file would close a loop in the reporting lines: ${description} ` +
            'Correct one of the line managers in the loop.',
        );
      }
    }
  }
}

/**
 * What the file does to the one employee with no line manager. FR 04.
 *
 * Counted over the organisation as it would be, for the same reason the loops
 * are: a file that promotes somebody to the head without demoting the current
 * one is two roots, and neither of those rows looks wrong on its own.
 *
 * Two different refusals come out of that count, and they are different problems
 * with different answers.
 *
 * **Two people with no line manager** is a file that has to be corrected, and
 * the answer is in the file: give one of them a line. The database refuses it
 * too, through employee_one_root; what this adds is both names before anything
 * is written.
 *
 * **One person with no line manager, but a different one from before** is a
 * succession, and it is not something an import can do at all — see below. The
 * answer is not in the file, so the refusal says what to do instead rather than
 * asking HR to find a mistake that is not there.
 *
 * Only the file's rows are rejected. A database that already holds two roots —
 * which employee_one_root makes unreachable through any write, but a restored
 * dump can hold — is not something this file caused or can fix, and rejecting
 * rows over it would make the database unimportable until somebody worked out
 * why.
 */
function rejectChangesToTheHeadOfOrganisation(
  drafts: DraftRow[],
  organisation: Organisation,
  reject: Reject,
): void {
  const headless = new Map<string, DraftRow | Employee>();

  for (const employee of organisation.employeeByNumber.values()) {
    if (employee.managerId === null) {
      headless.set(key(employee.employeeNumber), employee);
    }
  }

  for (const draft of drafts) {
    const identifier = key(draft.employeeNumber);
    if (draft.manager === null) {
      headless.set(identifier, draft);
    } else {
      // Somebody the file gives a line to who had none before: the demotion half
      // of a succession.
      headless.delete(identifier);
    }
  }

  if (headless.size === 1 && organisation.headNumber !== null) {
    rejectSuccession(drafts, organisation, [...headless.values()][0]!, reject);
    return;
  }

  if (headless.size < 2) {
    return;
  }

  const numbers = [...headless.values()].map((one) => one.employeeNumber);

  for (const one of headless.values()) {
    if (!('line' in one)) {
      continue;
    }

    reject(
      one,
      'manager',
      `This row leaves ${one.employeeNumber} with no line manager, and once this file ` +
        `landed ${numbers.length} people would have none: ${numbers.join(', ')}. Exactly ` +
        'one employee may be the head of the organisation, because a request is routed ' +
        'by walking up the reporting lines and that walk has to stop somewhere. Give ' +
        'this row a line manager, or give the others one in the same file.',
    );
  }
}

/**
 * A file that would move the head of the organisation from one person to
 * another.
 *
 * Refused, and not because it is wrong. It is a perfectly reasonable thing for
 * HR to want, and there is no order of single record writes that achieves it:
 *
 *   Promote the incoming head first and there are momentarily two employees with
 *   no line manager. `employee_one_root` is a unique index rather than a deferred
 *   trigger, so that moment is refused even inside a transaction that would have
 *   ended with one.
 *
 *   Demote the outgoing head first and they are pointed at somebody who is still
 *   below them, which is a loop. The database would tolerate it, its cycle
 *   trigger being deferred, but {@link EmployeeService} walks up from the
 *   proposed manager and refuses it — rightly, for the single edit it was written
 *   for — and every row of an import goes through that service on purpose.
 *
 *   And there is no third move, because any manager the outgoing head could be
 *   given is somebody below them, and below them is where the loop comes from.
 *
 * The README sets out the two statement transaction that does work, and says
 * plainly that `EmployeeService` cannot express it and that a `succeedHead()` is
 * wanted and not written. Until it is, this is refused here — before anything is
 * written, with the reason and the alternative — rather than discovered halfway
 * through the write as a constraint violation naming an index.
 */
function rejectSuccession(
  drafts: DraftRow[],
  organisation: Organisation,
  incoming: DraftRow | Employee,
  reject: Reject,
): void {
  const outgoing = organisation.headNumber;

  if (outgoing === null || key(incoming.employeeNumber) === key(outgoing)) {
    return;
  }

  /* Both rows, where both are in the file. Either on its own is refused by
     something else — the promotion as a second root, the demotion as a loop —
     so what is being named here is the pair, and the HR officer needs to be sent
     to both lines rather than to one of them. */
  const involved = drafts.filter(
    (draft) =>
      key(draft.employeeNumber) === key(outgoing) ||
      key(draft.employeeNumber) === key(incoming.employeeNumber),
  );

  for (const draft of involved) {
    reject(
      draft,
      'manager',
      `This file would move the head of the organisation from ${outgoing} to ` +
        `${incoming.employeeNumber}. An import cannot do that, and neither can any ` +
        'other single record change: promoting the incoming head first leaves two ' +
        'employees with no line manager, which is refused immediately, and demoting ' +
        'the outgoing one first points them at somebody still below them, which is a ' +
        'loop. Succeeding the head of the organisation is one deliberate transaction ' +
        'of its own and is not built yet. Leave both reporting lines as they stand in ' +
        'this file, and import everything else.',
    );
  }
}

/**
 * The domain refusals the planner turns into report lines, and the ones it does
 * not.
 *
 * Every error a rule raises about one record is a rejection of the row that
 * caused it. Anything else — a connection that dropped, a bug — is not, and is
 * re-thrown so it fails the import rather than appearing as a mysterious line in
 * a report an HR officer is expected to act on.
 */
function refusalOf(error: unknown): { field: ImportField | null; reason: string } | undefined {
  if (error instanceof InvalidImportRow) {
    return { field: error.field, reason: error.message };
  }

  if (error instanceof InvalidEmployee) {
    return { field: IMPORT_FIELD_OF[error.field] ?? null, reason: error.message };
  }

  /* Raised from inside validateNewEmployee() rather than alongside it, because a
     work address being a company address is the provisioning door of NFR SEC 01
     and belongs to the auth layer. It is still one bad cell in one row: without
     this, one personal address in a file of four hundred stops the dry run
     rather than appearing as a line of it. */
  if (error instanceof NotACompanyEmail) {
    return { field: 'workEmail', reason: error.message };
  }

  if (error instanceof DuplicateWorkEmail) {
    return { field: 'workEmail', reason: error.message };
  }

  if (error instanceof DuplicateEmployeeNumber) {
    return { field: 'employeeNumber', reason: error.message };
  }

  if (error instanceof DepartmentDeactivated) {
    return { field: 'department', reason: error.message };
  }

  if (error instanceof ManagerHasLeft) {
    return { field: 'manager', reason: error.message };
  }

  return undefined;
}

function optionalKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : key(value);
}

function namesOf(records: Map<string, { name: string }>): string {
  const names = [...records.values()].map((one) => one.name).sort();

  return names.length === 0 ? 'none — there are none yet' : names.join(', ');
}

function describeLines(lines: number[]): string {
  return lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(', ')}`;
}
