/** Loading staff from a spreadsheet, with a dry run first. FR 08. */

import {
  type CalendarDate,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  type Employee,
  type EmployeeChanges,
  type EmploymentStatus,
  type EmploymentType,
  GENDERS,
  type Gender,
  type NewEmployee,
} from '../employee/employee.js';
import { cellOf, normaliseHeading, type SheetRow } from './spreadsheet.js';
import { withoutMidnight } from '../../shared/time.js';

/**
 * The fields a spreadsheet can carry, which is every field of an employee record that a person could reasonably type.
 */
export const IMPORT_FIELDS = [
  'employeeNumber',
  'firstName',
  'lastName',
  'workEmail',
  'jobTitle',
  'department',
  'manager',
  'workPattern',
  'startDate',
  'exitDate',
  'employmentType',
  'employmentStatus',
  'gender',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** The columns a file has to have before it can be imported at all. FR 02, FR 23. */
export const REQUIRED_IMPORT_FIELDS: readonly ImportField[] = [
  'employeeNumber',
  'firstName',
  'lastName',
  'workEmail',
  'department',
  'manager',
  'startDate',
];

/** Which heading in the file holds each field. FR 08. */
export type ColumnMapping = Partial<Record<ImportField, string>>;

/**
 * The headings each field answers to, normalised by normaliseHeading — so case, spaces, underscores and punctuation are already gone and `Employee Nu…
 */
const HEADING_SYNONYMS: Record<ImportField, readonly string[]> = {
  employeeNumber: [
    'employeenumber',
    'employeeno',
    'employeeid',
    'staffnumber',
    'staffno',
    'staffid',
    'payrollnumber',
    'empno',
  ],
  firstName: ['firstname', 'forename', 'givenname'],
  lastName: ['lastname', 'surname', 'familyname'],
  workEmail: ['workemail', 'email', 'emailaddress', 'companyemail', 'workemailaddress'],
  jobTitle: ['jobtitle', 'jobrole', 'position'],
  department: ['department', 'dept', 'team', 'departmentname'],
  manager: [
    'manager',
    'linemanager',
    'reportsto',
    'supervisor',
    'managernumber',
    'linemanagernumber',
    'managerempno',
    'linemanageremployeenumber',
  ],
  workPattern: ['workpattern', 'workingpattern', 'pattern', 'workingweek'],
  startDate: ['startdate', 'start', 'hiredate', 'datejoined', 'joindate', 'commencementdate'],
  exitDate: ['exitdate', 'enddate', 'leavingdate', 'dateleft', 'terminationdate', 'lastday'],
  employmentType: ['employmenttype', 'contracttype'],
  employmentStatus: ['employmentstatus', 'status'],
  gender: ['gender', 'sex'],
};

/** A file whose columns cannot be mapped to the fields of a record. */
export class InvalidColumnMapping extends Error {
  /** The fields that could not be mapped, or that were mapped to nothing. */
  readonly fields: ImportField[];
  /** The headings the file has, for a message that can suggest an answer. */
  readonly headings: string[];

  constructor(message: string, fields: ImportField[], headings: string[]) {
    super(message);
    this.name = 'InvalidColumnMapping';
    this.fields = fields;
    this.headings = headings;
  }
}

/** A row that cannot be read as a record at all, and the field that caused it. */
export class InvalidImportRow extends Error {
  readonly field: ImportField | null;

  constructor(field: ImportField | null, message: string) {
    super(message);
    this.name = 'InvalidImportRow';
    this.field = field;
  }
}

/** A confirmation of a dry run that is no longer the dry run it confirms. */
export class ImportChangedSinceDryRun extends Error {
  constructor() {
    super(
      'The staff records changed between the dry run and this confirmation, so ' +
        'importing now would not do what the dry run said it would. Nothing has ' +
        'been written. Run the dry run again and check the new report.',
    );
    this.name = 'ImportChangedSinceDryRun';
  }
}

/** A confirmation of a plan that still has rejected rows in it. */
export class ImportWouldRejectRows extends Error {
  readonly rejected: RejectedRow[];

  constructor(rejected: RejectedRow[]) {
    super(
      `${rejected.length} ${rejected.length === 1 ? 'row' : 'rows'} in this file ` +
        `${rejected.length === 1 ? 'cannot' : 'cannot'} be imported, so nothing has been ` +
        'written. Correct the file and run the dry run again, or confirm again asking ' +
        'for the rest to be imported without them.',
    );
    this.name = 'ImportWouldRejectRows';
    this.rejected = rejected;
  }
}

/**
 * One row of the file, read into the fields of a record.
 *
 * References are still the file's words for them. Optional fields are *absent*
 * rather than null when the file said nothing, which is what carries the "a
 * blank cell says nothing" rule of the module note all the way through: absent
 * means the field never reaches an update, and never overrides a default on a
 * create.
 */
export interface DraftRow {
  /** The line of the file this came from, as the HR officer's editor numbers it. */
  line: number;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle?: string;
  /** The department's name, as the file spells it. */
  department: string;
  /**
   * The line manager's employee number, or `null` for the head of the
   * organisation. FR 02 and FR 04.
   *
   * `null` here is a blank cell in a column that exists, which is the one place
   * this system reads a blank as a deliberate `null` rather than refusing it.
   * ./employee.ts says why that decision belongs at this layer: the domain
   * refuses `''` precisely so that whoever maps blanks to null does it knowingly,
   * and this is that layer doing it knowingly. The dry run then names every row
   * it happened to, so a human confirms it rather than a parser inferring it.
   */
  manager: string | null;
  /** The working pattern's name. Absent means the standard week. FR 23. */
  workPattern?: string;
  startDate: CalendarDate;
  exitDate?: CalendarDate;
  employmentType?: EmploymentType;
  employmentStatus?: EmploymentStatus;
  gender?: Gender;
}

/** An existing record, with its references put back into the words the file uses. */
export interface CurrentRow {
  employee: Employee;
  departmentName: string;
  /** The line manager's employee number, or null for the head of the organisation. */
  managerNumber: string | null;
  workPatternName: string;
}

/** One field that the file would change, in the terms the file used. */
export interface FieldChange {
  field: ImportField;
  from: string | null;
  to: string | null;
}

/** A row that would create somebody who is not here yet. */
export interface PlannedCreate {
  line: number;
  employeeNumber: string;
  fullName: string;
  /** As the file read, for a report that talks about departments rather than ids. */
  draft: DraftRow;
  /**
   * Everything but the reporting line, with the references resolved to ids.
   *
   * The line manager is missing on purpose and is {@link managerNumber} instead.
   * A manager who is themselves a row in the same file has no id yet — they do
   * not exist — so the id cannot be settled until the write, when the rows are
   * done in an order that puts a manager before their reports.
   */
  record: Omit<NewEmployee, 'managerId'>;
  /** The manager's employee number, or null for the head of the organisation. */
  managerNumber: string | null;
}

/** A row that would change somebody who is already here. */
export interface PlannedChange {
  line: number;
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  /** Everything but the reporting line, for the reason {@link PlannedCreate.record} says. */
  changes: Omit<EmployeeChanges, 'managerId'>;
  /**
   * The new manager's employee number, or null for the head of the organisation.
   *
   * Present only when the reporting line actually moves. Absent and `null` are
   * different instructions and stay different: absent leaves the line alone,
   * `null` makes this person the head.
   */
  managerNumber?: string | null;
  /** What would change, in the file's own words, for the HR officer to read. */
  differences: FieldChange[];
}

/** A row naming somebody whose record already says exactly what the file says. */
export interface UnchangedRow {
  line: number;
  employeeNumber: string;
  fullName: string;
}

/** A row that would not be imported, and why. */
export interface RejectedRow {
  line: number;
  /** As far as it could be read. Null when even the employee number was unusable. */
  employeeNumber: string | null;
  field: ImportField | null;
  reason: string;
}

/**
 * The answer to "what would happen", with nothing written.
 *
 * Four buckets rather than three, because "left exactly as it is" is the biggest
 * one on the second and every subsequent run of a file and an HR officer needs
 * to see that number to believe the other three.
 */
export interface ImportPlan {
  /** Which heading fed which field, so the report can show its working. */
  mapping: ColumnMapping;
  creates: PlannedCreate[];
  changes: PlannedChange[];
  unchanged: UnchangedRow[];
  rejected: RejectedRow[];
  /**
   * The plan as it stood, for a confirmation to be checked against.
   *
   * Opaque and only ever compared. It is what makes "nothing is written until
   * the dry run is confirmed" mean something stronger than "the caller made two
   * calls": what is confirmed is *this* plan, and if the world moved underneath
   * it the confirmation is refused rather than silently applied to a different
   * one. See {@link ImportChangedSinceDryRun}.
   */
  fingerprint: string;
}

export interface ImportSummary {
  toCreate: number;
  toChange: number;
  unchanged: number;
  rejected: number;
  /** Every row of the file that was not blank. */
  rows: number;
}

/** One thing the confirmed plan does, in the order it has to be done. */
export type PlannedOperation =
  { kind: 'create'; create: PlannedCreate } | { kind: 'change'; change: PlannedChange };

/**
 * Works out which heading holds which field.
 *
 * The caller's mapping wins wherever it says anything; the rest is guessed from
 * {@link HEADING_SYNONYMS}. That order matters — an HR officer who has told the
 * system that `Ref` is the employee number should not be second guessed because
 * the file also has a column called `Staff No` — and it is what makes the
 * mapping of FR 08 a mapping rather than a fixed format.
 *
 * Throws {@link InvalidColumnMapping} when a required field has no column, when
 * a mapping names a heading the file does not have, or when two headings answer
 * to the same field. That last one is refused rather than resolved by picking
 * the first: a file with both `Email` and `Work Email` in it has two candidate
 * addresses per person, and choosing one silently is how half the company ends
 * up unable to sign in.
 */
export function resolveColumnMapping(headings: string[], given: ColumnMapping = {}): ColumnMapping {
  const byNormalised = new Map(headings.map((heading) => [normaliseHeading(heading), heading]));

  const named: ImportField[] = [];
  const mapping: ColumnMapping = {};

  for (const field of IMPORT_FIELDS) {
    const heading = given[field];
    if (heading === undefined) {
      continue;
    }

    const actual = byNormalised.get(normaliseHeading(heading));
    if (actual === undefined) {
      named.push(field);
      continue;
    }

    mapping[field] = actual;
  }

  if (named.length > 0) {
    throw new InvalidColumnMapping(
      `The mapping names ${named.length === 1 ? 'a column' : 'columns'} the file does ` +
        `not have: ${named.map((field) => `${field} -> "${given[field]}"`).join(', ')}. ` +
        `The file has ${listHeadings(headings)}.`,
      named,
      headings,
    );
  }

  const taken = new Set(Object.values(mapping));
  const ambiguous: ImportField[] = [];

  for (const field of IMPORT_FIELDS) {
    if (mapping[field] !== undefined) {
      continue;
    }

    const matches = headings.filter(
      (heading) =>
        !taken.has(heading) && HEADING_SYNONYMS[field].includes(normaliseHeading(heading)),
    );

    if (matches.length > 1) {
      ambiguous.push(field);
      continue;
    }
    if (matches.length === 1) {
      mapping[field] = matches[0];
      taken.add(matches[0]!);
    }
  }

  if (ambiguous.length > 0) {
    throw new InvalidColumnMapping(
      `More than one column could be the ${ambiguous.join(', ')} and there is no way ` +
        'to tell which. Say which in the column mapping, or remove the column that ' +
        `is not wanted. The file has ${listHeadings(headings)}.`,
      ambiguous,
      headings,
    );
  }

  const missing = REQUIRED_IMPORT_FIELDS.filter((field) => mapping[field] === undefined);

  if (missing.length > 0) {
    throw new InvalidColumnMapping(
      `The file has no column for ${missing.join(', ')}, and a staff import cannot ` +
        `proceed without ${missing.length === 1 ? 'it' : 'them'}. Add the column, or ` +
        `map an existing one. The file has ${listHeadings(headings)}.`,
      missing,
      headings,
    );
  }

  return mapping;
}

function listHeadings(headings: string[]): string {
  return headings.map((heading) => `"${heading}"`).join(', ');
}

/**
 * Reads one row into the fields of a record.
 *
 * What is checked here is what the *file* can get wrong: a required cell nobody
 * filled in, a date in a format that cannot be read, a word that is not one of
 * the values the column permits. What a *record* can get wrong — an address
 * outside the company domains, a name longer than the column, an exit date
 * before a start date — is left to the validators in ./employee.ts, which the
 * planner runs on the result. Both become rejections in the same report, and
 * neither rule is written twice.
 *
 * Throws {@link InvalidImportRow}, naming the field, which is what puts the
 * column name in the report next to the line number.
 */
export function readDraft(row: SheetRow, mapping: ColumnMapping): DraftRow {
  if (row.problem !== null) {
    throw new InvalidImportRow(null, row.problem);
  }

  const read = (field: ImportField) => cellOf(row, mapping[field]);

  const draft: DraftRow = {
    line: row.line,
    employeeNumber: required('employeeNumber', read('employeeNumber'), mapping),
    firstName: required('firstName', read('firstName'), mapping),
    lastName: required('lastName', read('lastName'), mapping),
    workEmail: required('workEmail', read('workEmail'), mapping).toLowerCase(),
    department: required('department', read('department'), mapping),
    /* The one blank that means something. A column that exists with nothing in
       it is HR saying "this person reports to nobody", which FR 04 permits for
       exactly one person and which the plan then names out loud. */
    manager: read('manager') === '' ? null : read('manager'),
    startDate: date('startDate', required('startDate', read('startDate'), mapping)),
  };

  /* Everything below is optional, and absent when the cell is blank rather than
     null. See the module note: absent never reaches an update and never
     overrides a default, which is what stops a partial spreadsheet clearing
     fields it says nothing about. */

  const jobTitle = read('jobTitle');
  if (jobTitle !== '') {
    draft.jobTitle = jobTitle;
  }

  const workPattern = read('workPattern');
  if (workPattern !== '') {
    draft.workPattern = workPattern;
  }

  const exitDate = read('exitDate');
  if (exitDate !== '') {
    draft.exitDate = date('exitDate', exitDate);
  }

  const employmentType = read('employmentType');
  if (employmentType !== '') {
    draft.employmentType = oneOf('employmentType', employmentType, EMPLOYMENT_TYPES);
  }

  const employmentStatus = read('employmentStatus');
  if (employmentStatus !== '') {
    draft.employmentStatus = oneOf('employmentStatus', employmentStatus, EMPLOYMENT_STATUSES);
  }

  const gender = read('gender');
  if (gender !== '') {
    draft.gender = oneOf('gender', gender, GENDERS);
  }

  return draft;
}

/**
 * What the file would change about somebody who is already here.
 *
 * Compared in the file's own terms rather than in ids, so the report reads
 * "department: Operations -> Finance" instead of two numbers. Only fields the
 * draft actually carries are looked at, which is the "a blank cell says nothing"
 * rule doing its work: an unmapped column and an empty cell both leave the field
 * out of the draft, and a field that is not in the draft cannot appear here.
 *
 * The three references are reported separately from the change they imply,
 * because turning a name into an id needs the database and this does not.
 */
export function compare(current: CurrentRow, draft: DraftRow): RowComparison {
  const differences: FieldChange[] = [];
  const changes: PlainChanges = {};

  const record = current.employee;

  const differs = (field: ImportField, from: string | null, to: string | null) => {
    /* Compared without regard to case, and not only for the identifiers the
       database folds. A file that writes OPERATIONS where the record says
       Operations is naming the same team, and reporting that as a change would
       fill the report with rows nobody meant to touch — which is how a genuine
       change three pages down goes unread. */
    if ((from ?? '').toLowerCase() === (to ?? '').toLowerCase()) {
      return false;
    }

    differences.push({ field, from, to });
    return true;
  };

  if (differs('firstName', record.firstName, draft.firstName)) {
    changes.firstName = draft.firstName;
  }
  if (differs('lastName', record.lastName, draft.lastName)) {
    changes.lastName = draft.lastName;
  }
  if (differs('workEmail', record.workEmail, draft.workEmail)) {
    changes.workEmail = draft.workEmail;
  }
  if (draft.jobTitle !== undefined && differs('jobTitle', record.jobTitle, draft.jobTitle)) {
    changes.jobTitle = draft.jobTitle;
  }
  if (differs('startDate', record.startDate, draft.startDate)) {
    changes.startDate = draft.startDate;
  }
  if (draft.exitDate !== undefined && differs('exitDate', record.exitDate, draft.exitDate)) {
    changes.exitDate = draft.exitDate;
  }
  if (
    draft.employmentType !== undefined &&
    differs('employmentType', record.employmentType, draft.employmentType)
  ) {
    changes.employmentType = draft.employmentType;
  }
  if (
    draft.employmentStatus !== undefined &&
    differs('employmentStatus', record.employmentStatus, draft.employmentStatus)
  ) {
    changes.employmentStatus = draft.employmentStatus;
  }
  if (draft.gender !== undefined && differs('gender', record.gender, draft.gender)) {
    changes.gender = draft.gender;
  }

  return {
    differences,
    changes,
    movesDepartment: differs('department', current.departmentName, draft.department),
    movesManager: differs('manager', current.managerNumber, draft.manager),
    movesWorkPattern:
      draft.workPattern !== undefined &&
      differs('workPattern', current.workPatternName, draft.workPattern),
  };
}

/** The fields of a change that need nothing but the row itself. */
type PlainChanges = Omit<EmployeeChanges, 'departmentId' | 'managerId' | 'workPatternId'>;

export interface RowComparison {
  /** Every field that differs, references included, in the file's words. */
  differences: FieldChange[];
  /** The changes that need no lookup. The service adds the three that do. */
  changes: PlainChanges;
  movesDepartment: boolean;
  movesManager: boolean;
  movesWorkPattern: boolean;
}

/**
 * Every loop in a set of reporting lines. FR 03, and the cycle detection FR 08
 * asks for.
 *
 * `managerOf` is the whole organisation as it *would be* — everybody already in
 * the database, with the file's changes applied over them — keyed however the
 * caller likes, so long as it is consistent. The service keys it by employee
 * number folded to lower case, because that is what a spreadsheet has to point
 * at somebody with.
 *
 * This is the same rule as {@link assertNoManagerCycle}, asked the other way
 * round, and the difference is the reason both exist. That one answers "would
 * *this* edit close a loop" by walking up from one proposed manager, which is
 * the right question when a person is editing one record. A file changes
 * hundreds of lines at once, and the loop it closes may not touch any row the
 * walk from any single one of them would reach; so the whole graph is swept, and
 * every loop in it is found rather than the first.
 *
 * Doing it here rather than leaving it to the `employee_no_manager_cycle`
 * trigger is the point the README makes about that trigger: being deferred, it
 * fires at COMMIT with the transaction already rolled back, so it can say that
 * the file contains a loop but not which lines hold it. The backstop stays where
 * it is and covers everything that never comes through this code; what this adds
 * is the three names and the line numbers.
 *
 * Each loop comes back in reporting order — each element reports to the next,
 * and the last reports to the first. A manager who is nobody is not a loop and
 * is not reported here; it is an unresolved reference and is refused separately.
 */
export function findManagerCycles(managerOf: ReadonlyMap<string, string | null>): string[][] {
  const cycles: string[][] = [];
  const settled = new Set<string>();

  for (const start of managerOf.keys()) {
    if (settled.has(start)) {
      continue;
    }

    /* One walk up from this person, remembering where on the path each name was
       seen. Walking upward rather than downward is what bounds this by the depth
       of the organisation rather than by its size, which is the same reason
       checkManager() walks that way. */
    const path: string[] = [];
    const positionOf = new Map<string, number>();

    let current: string | null = start;

    while (current !== null && managerOf.has(current)) {
      const seenAt = positionOf.get(current);
      if (seenAt !== undefined) {
        // The path has met itself. Everything from there on is the loop.
        cycles.push(path.slice(seenAt));
        break;
      }

      // Somebody an earlier walk already followed to its end. Whatever is above
      // them has been judged, and judging it again would report the same loop
      // once per person hanging off it.
      if (settled.has(current)) {
        break;
      }

      positionOf.set(current, path.length);
      path.push(current);
      current = managerOf.get(current) ?? null;
    }

    for (const walked of path) {
      settled.add(walked);
    }
  }

  return cycles;
}

/**
 * The order the confirmed plan has to be written in: nearest the top of the
 * organisation first.
 *
 * `managerOf` is the reporting lines **as they will be** once the whole plan has
 * landed — everybody already in the database, with the file written over the top
 * — keyed the way {@link findManagerCycles} keys them. Each row is placed by how
 * far below the head of the organisation it ends up, and the file's own order
 * breaks ties so that a report reads in the order it was written.
 *
 * One rule, and it is worth seeing why it is the right one, because two
 * different constraints are being satisfied at once and each of them refuses the
 * obvious answer to the other.
 *
 * **A manager has to exist before the row that names them.** `manager_id` is an
 * ordinary foreign key, checked at the end of the statement that writes the row,
 * so a joiner on line 2 cannot report to a joiner on line 40. Sorting the file by
 * hand is not something to ask of an HR officer.
 *
 * **No intermediate state may contain a loop**, because
 * {@link EmployeeService.checkManager} walks up from the proposed manager and
 * refuses one — and it is right to, for the single edit it was written for. A
 * manager and their report swapping over is a legitimate restructure whose final
 * state is a good tree, but done in the wrong order the first of the two writes
 * leaves a loop standing that the walk refuses. The database would permit it, the
 * cycle trigger being deferred; the service will not, and the service is what
 * every row goes through.
 *
 * Writing in order of final depth satisfies both. When a row is written, every
 * ancestor it will end up under has already been written, so the manager it names
 * exists; and the line above it is already its *final* line, which is part of a
 * tree the plan has proved acyclic, so no walk up from it can come back round to
 * the row being written.
 *
 * What this order cannot do is succeed the head of the organisation, and nothing
 * else can either. Promoting the incoming head first leaves two employees with no
 * line manager, which `employee_one_root` refuses immediately, being an index
 * rather than a deferred trigger; demoting the outgoing one first points them at
 * somebody who is still below them, which is the loop the walk refuses. The
 * README says the same thing about `EmployeeService`, which is why a
 * `succeedHead()` is wanted there and not written. The dry run therefore refuses
 * that one shape of file outright rather than discovering it here.
 */
export function orderForWriting(
  plan: ImportPlan,
  managerOf: ReadonlyMap<string, string | null>,
): PlannedOperation[] {
  const depthOf = depthsBelowTheHead(managerOf);

  const operations: PlannedOperation[] = [
    ...plan.creates.map((create) => ({ kind: 'create' as const, create })),
    ...plan.changes.map((change) => ({ kind: 'change' as const, change })),
  ];

  return operations.sort((a, b) => {
    const first = a.kind === 'create' ? a.create : a.change;
    const second = b.kind === 'create' ? b.create : b.change;

    const byDepth = depthOf(first.employeeNumber) - depthOf(second.employeeNumber);

    // The file's own order breaks the tie, so the same plan is always written
    // the same way and a report of it reads down the page.
    return byDepth !== 0 ? byDepth : first.line - second.line;
  });
}

/**
 * How far below the head of the organisation somebody ends up, measured once per
 * person and remembered.
 *
 * The walk goes up rather than down, which bounds it by the depth of the
 * organisation rather than its size, and it stops at the first person already
 * measured, so the whole table costs one pass rather than one walk per row.
 *
 * A loop cannot reach here — every row in one was rejected before the plan was
 * offered for confirmation — but the walk refuses to follow one anyway, because
 * an ordering pass that hangs is a far worse failure than one that writes in an
 * order the database then refuses.
 */
function depthsBelowTheHead(
  managerOf: ReadonlyMap<string, string | null>,
): (employeeNumber: string) => number {
  const known = new Map<string, number>();

  return (employeeNumber: string): number => {
    const walked: string[] = [];
    const onPath = new Set<string>();

    let current: string | null = key(employeeNumber);

    while (current !== null && !known.has(current) && !onPath.has(current)) {
      walked.push(current);
      onPath.add(current);
      current = managerOf.get(current) ?? null;
    }

    // The head of the organisation is 0, and so is a walk that ran out of
    // reporting line without finding one.
    let depth = current === null ? -1 : (known.get(current) ?? -1);

    for (let index = walked.length - 1; index >= 0; index--) {
      depth += 1;
      known.set(walked[index], depth);
    }

    return known.get(key(employeeNumber)) ?? 0;
  };
}

/**
 * The plan reduced to a string, so that a confirmation can be checked against
 * the plan it confirms.
 *
 * Every decision the plan made is in it — what would be created and with what,
 * what would change and to what, what was left alone, what was refused and why,
 * and which column fed which field. A joiner somebody else created in the
 * meantime turns a create into a change; a department closed in the meantime
 * turns a row into a rejection; either moves this string, and the confirmation
 * is refused.
 *
 * Deliberately not a hash. There is nothing to hide, the plan is the HR
 * officer's own file, and a hash would buy a shorter string at the cost of a
 * dependency and of being unable to see what differed while debugging. It is
 * only ever compared for equality.
 */
export function fingerprintOf(plan: Omit<ImportPlan, 'fingerprint'>): string {
  const lines: string[] = [];

  for (const field of IMPORT_FIELDS) {
    const heading = plan.mapping[field];
    if (heading !== undefined) {
      lines.push(`column\t${field}\t${heading}`);
    }
  }

  for (const create of plan.creates) {
    lines.push(
      `create\t${create.line}\t${key(create.employeeNumber)}\t${canonical(create.record)}\t` +
        `${create.managerNumber ?? ''}`,
    );
  }

  for (const change of plan.changes) {
    lines.push(
      `change\t${change.line}\t${change.employeeId}\t${canonical(change.changes)}\t` +
        `${'managerNumber' in change ? (change.managerNumber ?? 'null') : '-'}`,
    );
  }

  for (const row of plan.unchanged) {
    lines.push(`same\t${row.line}\t${key(row.employeeNumber)}`);
  }

  for (const row of plan.rejected) {
    lines.push(`reject\t${row.line}\t${row.field ?? ''}\t${row.reason}`);
  }

  return lines.join('\n');
}

export function summarise(plan: ImportPlan): ImportSummary {
  return {
    toCreate: plan.creates.length,
    toChange: plan.changes.length,
    unchanged: plan.unchanged.length,
    rejected: plan.rejected.length,
    rows: plan.creates.length + plan.changes.length + plan.unchanged.length + plan.rejected.length,
  };
}

/**
 * The dry run report, as something a person reads. FR 08.
 *
 * A screen will render the plan itself when Phase 5 arrives; this is what makes
 * the story usable before then, and it is what the integration tests read to
 * check that the report says what happened rather than only that the numbers add
 * up. Every line carries the file's line number first, because the only thing an
 * HR officer can do with a rejection is go and look at that row.
 */
export function describePlan(plan: ImportPlan): string {
  const counts = summarise(plan);
  const out: string[] = [];

  out.push('Staff import dry run. Nothing has been written.');
  out.push(
    `${counts.rows} ${counts.rows === 1 ? 'row' : 'rows'} read: ${counts.toCreate} to create, ` +
      `${counts.toChange} to change, ${counts.unchanged} already correct, ` +
      `${counts.rejected} rejected.`,
  );

  out.push('', 'Columns read');
  for (const field of IMPORT_FIELDS) {
    const heading = plan.mapping[field];
    out.push(heading === undefined ? `  ${field}: not in the file` : `  ${field}: "${heading}"`);
  }

  if (plan.creates.length > 0) {
    out.push('', `To create (${plan.creates.length})`);
    for (const create of plan.creates) {
      out.push(`  line ${create.line}  ${create.employeeNumber}  ${create.fullName}`);
      out.push(
        `      ${create.draft.department}, ` +
          (create.managerNumber === null
            ? 'reporting to nobody — the head of the organisation'
            : `reporting to ${create.managerNumber}`) +
          `, ${create.draft.workPattern ?? 'the standard week'}`,
      );
    }
  }

  if (plan.changes.length > 0) {
    out.push('', `To change (${plan.changes.length})`);
    for (const change of plan.changes) {
      out.push(`  line ${change.line}  ${change.employeeNumber}  ${change.fullName}`);
      for (const difference of change.differences) {
        out.push(`      ${difference.field}: ${show(difference.from)} -> ${show(difference.to)}`);
      }
    }
  }

  if (plan.unchanged.length > 0) {
    out.push('', `Already correct (${plan.unchanged.length})`);
    for (const row of plan.unchanged) {
      out.push(`  line ${row.line}  ${row.employeeNumber}  ${row.fullName}`);
    }
  }

  if (plan.rejected.length > 0) {
    out.push('', `Rejected (${plan.rejected.length})`);
    for (const row of plan.rejected) {
      out.push(
        `  line ${row.line}  ${row.employeeNumber ?? '(no employee number)'}  ` +
          `${row.field === null ? '' : `${row.field}: `}${row.reason}`,
      );
    }
  }

  return out.join('\n');
}

/** How an employee number is compared: it is an identifier, and case is not part of it. */
export function key(employeeNumber: string): string {
  return employeeNumber.trim().toLowerCase();
}

function show(value: string | null): string {
  return value === null || value === '' ? '(nothing)' : value;
}

function required(field: ImportField, value: string, mapping: ColumnMapping): string {
  if (value !== '') {
    return value;
  }

  const heading = mapping[field];

  throw new InvalidImportRow(
    field,
    heading === undefined
      ? `${field} is required and the file has no column for it.`
      : `${field} is required and the "${heading}" cell on this row is empty.`,
  );
}

/**
 * A date, and only in the one form there is no argument about.
 *
 * `31/07/2026` and `07/31/2026` are the same eleven characters meaning two
 * different days, and no amount of looking at one row tells you which convention
 * the file uses — a file full of dates before the thirteenth of the month is
 * genuinely ambiguous from top to bottom. Guessing is not an option worth having
 * here: `start_date` is what a joiner's first entitlement is calculated from and
 * `exit_date` is what FR 37a settles a leaver's final figure from, so a
 * convention read the wrong way round is a wrong number in somebody's pay.
 *
 * So the column is required to be `YYYY-MM-DD`, the refusal says so, and
 * formatting one column is a minute of an HR officer's time before the import
 * rather than a fortnight of unpicking afterwards. It is also what the rest of
 * the system uses, for the reason the README gives about dates.
 *
 * The one concession is a time on the end, because a spreadsheet that has
 * decided a column is a datetime writes `2026-09-01 00:00:00` and means the
 * first of September. Dropping midnight is unambiguous; nothing else is, and
 * {@link withoutMidnight} in ./time.ts is where that concession is defined —
 * this is a fact about the form rather than about importing, and the next file
 * somebody uploads will not be a staff list.
 *
 * Shape only. Whether the ten characters are a day anybody could have started on
 * is {@link isCalendarDate}, applied by {@link validateNewEmployee} when the row
 * goes through {@link EmployeeService} like every other record. There is no
 * second opinion about that here and there should not be one.
 */
function date(field: ImportField, value: string): CalendarDate {
  const withoutTime = withoutMidnight(value);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(withoutTime)) {
    throw new InvalidImportRow(
      field,
      `"${value}" is not a date this import can read. Dates have to be written ` +
        'YYYY-MM-DD, as 2026-09-01, because 01/09/2026 and 09/01/2026 are the same ' +
        'characters meaning different days and nothing in the file says which is ' +
        'meant. Format the column as YYYY-MM-DD and run the dry run again.',
    );
  }

  return withoutTime;
}

/**
 * One of a fixed set of words, read the way somebody types it.
 *
 * `Part time`, `part-time` and `PART_TIME` are the same answer, and refusing the
 * first two would mean an HR officer retyping a column the system could perfectly
 * well have understood. Anything genuinely outside the set is refused and the
 * refusal lists what the column accepts, because that list is nowhere in the
 * spreadsheet.
 */
function oneOf<T extends string>(field: ImportField, value: string, permitted: readonly T[]): T {
  const normalised = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (!permitted.includes(normalised as T)) {
    throw new InvalidImportRow(
      field,
      `"${value}" is not a ${field} this system knows. It has to be one of ` +
        `${permitted.join(', ')}.`,
    );
  }

  return normalised as T;
}

/**
 * An object as a string that does not depend on the order its keys were built
 * in, so that the fingerprint compares what a plan says rather than how it was
 * assembled.
 */
function canonical(value: Record<string, unknown>): string {
  return Object.keys(value)
    .sort()
    .map((name) => `${name}=${String(value[name])}`)
    .join(';');
}
