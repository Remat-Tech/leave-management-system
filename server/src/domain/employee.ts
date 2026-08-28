/**
 * The employee record. FR 01 and FR 05.
 *
 * This is the system's answer to "who works here". Almost everything else hangs
 * off it: a request needs a requester, a balance needs somebody to belong to,
 * and an approval chain needs a person to walk up from.
 *
 * The rules live here as pure functions rather than in the service, so they can
 * be tested without a database and so there is one description of a valid record
 * rather than one per caller. The database holds the same rules as CHECK
 * constraints and unique indexes; see the employee-record-rules migration. That
 * duplication is deliberate. The constraints are what make a bad record
 * impossible, including when something other than this code is writing; the
 * functions here are what make the refusal say which field was wrong and why.
 *
 * Deactivation, FR 06, is {@link planTermination}, added by LMS 102. The line
 * manager, FR 02 and FR 04, arrived with LMS 103, and the rule against a line
 * that loops, FR 03, with LMS 104: the halves of both that need no database are
 * here, and the halves that have to look another record up are in the service.
 * {@link assertNoManagerCycle} is the shape of that split at its clearest — the
 * walk belongs to the service, the judgement and the message belong here.
 *
 * The department, LMS 105, and the working pattern, FR 23 and LMS 106, are both
 * references to another table and are treated alike: this file decides whether
 * one was named at all, and the service decides whether the thing named exists
 * and may be used. What each record *is* lives in ./department.ts and
 * ./work-pattern.ts.
 *
 * What is still absent is who may end an employment or move a reporting line,
 * which is authorisation and belongs to LMS 112.
 */

import { assertCompanyEmail } from '../auth/company-email.js';
import { type CalendarDate, isCalendarDate } from './time.js';

/* Each list is the same set as the matching CHECK constraint on the employee
   table. The integration tests assert that, so adding a value to one and
   forgetting the other fails the suite rather than production. */

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;
export const EMPLOYMENT_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;

/**
 * FR 05. Optional, and read by one thing only: eligibility for the leave types
 * whose entitlement differs by it, which today means maternity and paternity.
 *
 * Not recorded is the resting state and is spelled `null`. Nobody has to declare
 * one to be employed, to book annual leave or to be paid, and no screen, report
 * or filter outside that eligibility check may read the column.
 */
export const GENDERS = ['MALE', 'FEMALE'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];
export type Gender = (typeof GENDERS)[number];

/**
 * A calendar date, `YYYY-MM-DD`, with no time and no timezone.
 *
 * A hire date is the day somebody started, everywhere in the world, and turning
 * it into an instant to store it is how a leaver acquires an exit date one day
 * either side of the one on their letter. The README says it plainly: leave
 * dates are dates, everything else is UTC.
 *
 * Defined in ./time.ts since LMS 114 and re-exported here, because it belongs to
 * no one record: a start date, an exit date and every day of a leave request are
 * the same kind of thing, and by Phase 3 most of them will not be in this file.
 * NFR DAT 03.
 */
export type { CalendarDate } from './time.js';

/** What the caller supplies to create a record. */
export interface NewEmployee {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle?: string | null;
  /**
   * Which team they are in. LMS 105.
   *
   * Required, and required in the type, for the reason the column is NOT NULL:
   * leave is reported and planned by team, and somebody in no team appears in no
   * team's figures. There is no `null` here and no exception for anybody — unlike
   * {@link NewEmployee.managerId}, where the head of the organisation genuinely
   * has nobody above them, everybody is in some team including them.
   */
  departmentId: string;
  /**
   * Which week they work. FR 23, LMS 106.
   *
   * Optional here and NOT NULL in the column, which is not a contradiction: it
   * says that everybody works some week and that most people work the ordinary
   * one. Omitting it is "the usual week", and the service resolves that to
   * whichever pattern is the default rather than the caller having to look it up.
   * A part timer's record names one.
   *
   * `null` means the same as omitting it, because a form that submitted its empty
   * select box is saying "no preference" and not "no week"; there is no such
   * thing as no week. Clearing one on an existing record is refused, which is a
   * deliberate difference — see {@link validateEmployeeChanges}.
   */
  workPatternId?: string | null;
  /**
   * Who this person reports to. FR 02.
   *
   * Required, and required in the type rather than only at runtime, which is the
   * point of the story: a record created without one is a record whose leave
   * requests have nowhere to go, and nobody should be able to make one by
   * forgetting a field.
   *
   * `null` is the head of the organisation and is a deliberate thing to say, not
   * an omission. FR 04 permits exactly one, and the service refuses a second.
   */
  managerId: string | null;
  startDate: CalendarDate;
  exitDate?: CalendarDate | null;
  employmentType?: EmploymentType;
  employmentStatus?: EmploymentStatus;
  gender?: Gender | null;
}

/** The same fields, any subset of them, for maintaining an existing record. */
export type EmployeeChanges = Partial<Omit<NewEmployee, 'workPatternId'>> & {
  workPatternId?: string | null;
};

/**
 * What ending an employment needs to know. FR 06.
 *
 * One field, and it is still an object rather than a bare string, because the
 * reason for terminating and who authorised it are both coming — the first with
 * the audit trail, the second with LMS 112 — and adding them to an object is a
 * change nobody has to visit every caller for.
 */
export interface Termination {
  exitDate: CalendarDate;
}

/** A record as it comes back out. */
export interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle: string | null;
  departmentId: string;
  managerId: string | null;
  workPatternId: string;
  startDate: CalendarDate;
  exitDate: CalendarDate | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  gender: Gender | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A record that was refused, and the field that caused it.
 *
 * The field is carried separately rather than only mentioned in the message,
 * because the form that will sit in front of this in Phase 5 needs to put the
 * message next to the input rather than at the top of the page.
 */
export class InvalidEmployee extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidEmployee';
    this.field = field;
  }
}

export class DuplicateEmployeeNumber extends Error {
  constructor(employeeNumber: string) {
    super(`Employee number ${employeeNumber} already belongs to somebody else.`);
    this.name = 'DuplicateEmployeeNumber';
  }
}

export class DuplicateWorkEmail extends Error {
  constructor(workEmail: string) {
    super(`${workEmail} is already the work address of another employee.`);
    this.name = 'DuplicateWorkEmail';
  }
}

export class EmployeeNotFound extends Error {
  constructor(id: string) {
    super(`No employee with id ${id}.`);
    this.name = 'EmployeeNotFound';
  }
}

/**
 * A line manager who is nobody.
 *
 * Separate from {@link EmployeeNotFound} because the two are different problems
 * wearing the same words: there, the record being edited does not exist; here it
 * does, and it is the person it was pointed at who does not. An HR officer needs
 * to be told which of the two they are looking at.
 */
export class ManagerNotFound extends Error {
  readonly managerId: string;

  constructor(managerId: string) {
    super(`No employee with id ${managerId}, so there is nobody for this person to report to.`);
    this.name = 'ManagerNotFound';
    this.managerId = managerId;
  }
}

/**
 * A line manager who has left.
 *
 * Routing a request to somebody who left in July is the same black hole as
 * routing it nowhere, which is what FR 02 exists to close. This is refused when
 * the line is drawn; a manager who leaves afterwards is drift, and is reported
 * by {@link warnAboutReportingLines} instead. See the line-manager-rules
 * migration for why neither can be a database constraint.
 */
export class ManagerHasLeft extends Error {
  readonly managerId: string;

  constructor(manager: Employee) {
    super(
      `${manager.firstName} ${manager.lastName} left on ` +
        `${manager.exitDate ?? 'a date that was not recorded'} and cannot be anybody's ` +
        `line manager. A request routed to them would have nowhere to go.`,
    );
    this.name = 'ManagerHasLeft';
    this.managerId = manager.id;
  }
}

/**
 * A second employee with no line manager. FR 04, and the warning HR is shown.
 *
 * It names the person who already holds that position, because "somebody else
 * has no manager" is not something an HR officer can act on and "Kwame Asante
 * (RH-0001) does" is. The database refuses this as well, through the
 * employee_one_root index; this is the half that can say who.
 */
export class SecondRootEmployee extends Error {
  /** The employee already recorded without a manager, where one could be identified. */
  readonly existingRootId: string | null;

  constructor(existing?: Employee) {
    super(
      existing
        ? `${existing.firstName} ${existing.lastName} (${existing.employeeNumber}) is ` +
            `already the one employee recorded without a line manager. Give this ` +
            `record a manager, or move ${existing.firstName}'s reporting line first.`
        : 'Somebody is already recorded without a line manager, and exactly one may ' +
            'be. Give this record a manager.',
    );
    this.name = 'SecondRootEmployee';
    this.existingRootId = existing?.id ?? null;
  }
}

/**
 * A manager change that would close a loop. FR 03.
 *
 * A loop is the one bad state in this table that nothing downstream survives.
 * FR 04 gives the tree a single root so that a walk upward terminates; a loop
 * makes it not terminate, and a request going round one is never approved, never
 * rejected and never seen again.
 *
 * The loop is carried rather than only described, because "that would create a
 * cycle" is not something an HR officer can act on. Which three people, and in
 * what order, is.
 */
export class ManagerCycle extends Error {
  /**
   * The loop that would have been closed: the proposed manager first, then each
   * person above them, ending with the employee whose manager was being set.
   *
   * Empty when the loop was caught by the database rather than by the walk — see
   * the repository — in which case there was a refusal but nobody to name.
   */
  readonly loop: readonly Employee[];

  constructor(loop: readonly Employee[] = []) {
    super(describeCycle(loop));
    this.name = 'ManagerCycle';
    this.loop = loop;
  }
}

function describeCycle(loop: readonly Employee[]): string {
  const manager = loop[0];
  const employee = loop[loop.length - 1];

  if (manager === undefined || employee === undefined) {
    return (
      'That line manager would close a loop in the reporting lines. A request ' +
      'walking up it would go round for ever and reach nobody.'
    );
  }

  /* Everybody strictly between the two, which is what turns "these two cannot
     both be right" into a route somebody can follow and correct. */
  const between = loop.slice(1, -1);
  const through = between.length === 0 ? '' : `, through ${between.map(fullName).join(', then ')}`;

  return (
    `${fullName(manager)} already reports to ${fullName(employee)}${through}. ` +
    `Making them ${employee.firstName}'s line manager would close the loop, and a ` +
    `request walking up it would reach nobody.`
  );
}

/**
 * The rule, given a walk somebody else did. FR 03 and Technical Design Document
 * section 5.2.
 *
 * `chain` is the reporting line above the *proposed manager*, nearest first,
 * beginning with the proposed manager themselves. If the employee whose manager
 * is being set appears anywhere in it, that employee is already above the
 * proposed manager, and making the proposed manager theirs joins the two ends.
 *
 * Walking up from the proposed manager rather than down from the employee finds
 * the same loop either way, and is bounded by the depth of the organisation
 * instead of by the number of people in it.
 *
 * The walk is not here, because it needs the table. This is only the judgement,
 * kept in the domain so that the rule and its message can be read and tested
 * without a database. The same rule is held again as a deferred constraint
 * trigger, which is what covers a bulk import that never passes through any of
 * this; see the reject-circular-reporting-lines migration.
 */
export function assertNoManagerCycle(employee: Employee, chain: readonly Employee[]): void {
  const closesAt = chain.findIndex((above) => above.id === employee.id);

  if (closesAt !== -1) {
    throw new ManagerCycle(chain.slice(0, closesAt + 1));
  }
}

/**
 * Somebody already recorded as having left.
 *
 * Separate from {@link InvalidEmployee} because it is not a bad field, it is a
 * request that has already happened, and the two want different answers in front
 * of an HR officer: one is "fix this box", the other is "this is already done,
 * and here is the date it was done with".
 */
export class AlreadyTerminated extends Error {
  readonly exitDate: CalendarDate;

  constructor(exitDate: CalendarDate) {
    super(`This employee is already recorded as having left on ${exitDate}.`);
    this.name = 'AlreadyTerminated';
    this.exitDate = exitDate;
  }
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedEmployee {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle: string | null;
  departmentId: string;
  managerId: string | null;
  workPatternId: string | null;
  startDate: CalendarDate;
  exitDate: CalendarDate | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  gender: Gender | null;
}

/**
 * A validated record with its working pattern resolved, which is what the
 * repository will actually write. FR 23.
 *
 * The difference is one field and it is the whole of the distinction between
 * "the caller did not name a pattern" and "this record has no pattern". The
 * column is NOT NULL, so the second cannot be stored; something has to turn the
 * first into the id of the default pattern, and that something is
 * {@link EmployeeService.create}, because which pattern is the default is a row
 * in another table and not a fact the domain can read.
 *
 * Saying it in the type rather than defaulting again inside the repository is
 * what stops the resolution happening twice, or in the layer that cannot say
 * what a good answer would be.
 */
export interface StorableEmployee extends ValidatedEmployee {
  workPatternId: string;
}

/**
 * Checks and tidies a new record.
 *
 * Returns the record as it should be stored rather than mutating what it was
 * given, so a caller cannot half apply the normalisation and store the rest as
 * it arrived.
 *
 * `domains` is passed in rather than read from the environment here, so the unit
 * tests need no environment and the service decides once where configuration
 * comes from.
 */
export function validateNewEmployee(input: NewEmployee, domains: string[]): ValidatedEmployee {
  const employmentType = input.employmentType ?? 'FULL_TIME';
  const employmentStatus = input.employmentStatus ?? 'ACTIVE';

  const record: ValidatedEmployee = {
    employeeNumber: requireText('employeeNumber', input.employeeNumber, 40),
    firstName: requireText('firstName', input.firstName, 80),
    lastName: requireText('lastName', input.lastName, 80),
    workEmail: normaliseWorkEmail(input.workEmail, domains),
    jobTitle: optionalText('jobTitle', input.jobTitle, 120),
    departmentId: requireDepartmentReference(input.departmentId),
    managerId: requireManagerReference(input.managerId),
    workPatternId: optionalWorkPatternReference(input.workPatternId),
    startDate: requireDate('startDate', input.startDate),
    exitDate: optionalDate('exitDate', input.exitDate),
    employmentType: requireOneOf('employmentType', employmentType, EMPLOYMENT_TYPES),
    employmentStatus: requireOneOf('employmentStatus', employmentStatus, EMPLOYMENT_STATUSES),
    gender: input.gender == null ? null : requireOneOf('gender', input.gender, GENDERS),
  };

  checkDatesAgree(record.startDate, record.exitDate, record.employmentStatus);

  return record;
}

/**
 * Checks and tidies a change to an existing record.
 *
 * Only the fields actually supplied are returned, so that "leave the job title
 * alone" and "clear the job title" stay different instructions. `undefined`
 * means the first and `null` the second.
 *
 * The cross field rules cannot be checked from the changes alone — clearing an
 * exit date is only wrong if the status is, or is becoming, TERMINATED — so the
 * record as it stands is passed in and the two are checked merged.
 */
export function validateEmployeeChanges(
  changes: EmployeeChanges,
  current: Employee,
  domains: string[],
): Partial<ValidatedEmployee> {
  const validated: Partial<ValidatedEmployee> = {};

  if ('employeeNumber' in changes) {
    validated.employeeNumber = requireText('employeeNumber', changes.employeeNumber, 40);
  }
  if ('firstName' in changes) {
    validated.firstName = requireText('firstName', changes.firstName, 80);
  }
  if ('lastName' in changes) {
    validated.lastName = requireText('lastName', changes.lastName, 80);
  }
  if ('workEmail' in changes) {
    validated.workEmail = normaliseWorkEmail(changes.workEmail, domains);
  }
  if ('jobTitle' in changes) {
    validated.jobTitle = optionalText('jobTitle', changes.jobTitle, 120);
  }
  if ('departmentId' in changes) {
    /* Moving somebody between teams, which is an ordinary edit. There is no
       clearing it: the column is NOT NULL and everybody is in some team, so a
       null here is a caller error rather than an instruction. */
    validated.departmentId = requireDepartmentReference(changes.departmentId);
  }
  if ('managerId' in changes) {
    const managerId = requireManagerReference(changes.managerId);

    /* The database says the same thing, in employee_not_own_manager. It is said
       here as well so the refusal names the box rather than the constraint, and
       because this is the one cycle short enough to see without a walk. The
       longer ones — A -> B -> A — are FR 03 and LMS 104, and are not checked
       anywhere yet. */
    if (managerId !== null && managerId === current.id) {
      throw new InvalidEmployee(
        'managerId',
        'An employee cannot be their own line manager. Their requests would be ' +
          'theirs to approve.',
      );
    }

    validated.managerId = managerId;
  }
  if ('workPatternId' in changes) {
    /* Moving somebody onto a different week, which is an ordinary edit and the
       assignable half of FR 23. Nullable on the way in so the field can be
       omitted, but the column is NOT NULL: an employee always works some week.
       Clearing it is a caller error, not an instruction. */
    validated.workPatternId = requireWorkPatternReference(changes.workPatternId);
  }
  if ('startDate' in changes) {
    validated.startDate = requireDate('startDate', changes.startDate);
  }
  if ('exitDate' in changes) {
    validated.exitDate = optionalDate('exitDate', changes.exitDate);
  }
  if ('employmentType' in changes) {
    validated.employmentType = requireOneOf(
      'employmentType',
      changes.employmentType,
      EMPLOYMENT_TYPES,
    );
  }
  if ('employmentStatus' in changes) {
    validated.employmentStatus = requireOneOf(
      'employmentStatus',
      changes.employmentStatus,
      EMPLOYMENT_STATUSES,
    );
  }
  if ('gender' in changes) {
    validated.gender =
      changes.gender == null ? null : requireOneOf('gender', changes.gender, GENDERS);
  }

  checkDatesAgree(
    validated.startDate ?? current.startDate,
    'exitDate' in validated ? (validated.exitDate ?? null) : current.exitDate,
    validated.employmentStatus ?? current.employmentStatus,
  );

  return validated;
}

/**
 * Ending an employment. FR 06, and the whole of what "deactivated" means.
 *
 * Returns the change to apply, which is a status and a date and nothing else.
 * Everything that made the record what it is — the number, the work address, the
 * start date, the department, the working pattern, the id every leave row points
 * at — is untouched, because keeping all of it is the point. A leaver is a record
 * with an ending, not a record with holes in it.
 *
 * This exists as its own operation rather than as a `update({ employmentStatus,
 * exitDate })` for three reasons:
 *
 *   The two fields cannot come apart. Passing them separately is an invitation to
 *   pass one, and a status of TERMINATED with no date is a record FR 37a cannot
 *   settle a final figure from. Here there is no way to say the first without the
 *   second.
 *
 *   Terminating twice is a mistake worth naming. Through the general update it is
 *   a silent overwrite of the first exit date, which is how a leaver's final
 *   figure quietly changes months after it was agreed.
 *
 *   It is the thing a route, a screen and an audit entry all want to name. "HR
 *   terminated this employee" is the event; "HR changed two fields" is not.
 *
 * Correcting a termination is deliberately not this function. A wrong exit date,
 * or somebody marked as leaving who did not, is
 * {@link validateEmployeeChanges} — an ordinary edit to a record that still
 * exists, which is exactly the point of never having deleted it.
 */
export function planTermination(
  current: Employee,
  termination: Termination,
): Partial<ValidatedEmployee> {
  if (current.employmentStatus === 'TERMINATED') {
    /* The exit date is non null on a terminated record: the domain refuses one
       without it and employee_terminated_has_exit_date refuses it at the
       database. The fallback is for the type, not for a case that occurs. */
    throw new AlreadyTerminated(current.exitDate ?? 'a date that was not recorded');
  }

  const exitDate = requireDate('exitDate', termination.exitDate);

  const changes: Partial<ValidatedEmployee> = { employmentStatus: 'TERMINATED', exitDate };

  /* The same cross field check the create and update paths run, called rather
     than restated, so there is one description of when a pair of dates is
     nonsense and terminating cannot drift away from it. */
  checkDatesAgree(current.startDate, exitDate, 'TERMINATED');

  return changes;
}

/**
 * What is wrong with the recorded reporting lines, as facts about the table.
 *
 * Gathered by the repository, judged here, so the judging needs no database and
 * the same three questions are asked the same way wherever they are asked from.
 */
export interface ReportingLines {
  /** How many employee records there are at all, leavers included. */
  total: number;
  /** Everybody recorded with no line manager. FR 04 permits exactly one. */
  rootless: Employee[];
  /** Everybody still here whose recorded manager has left. */
  reportingToLeavers: { employee: Employee; manager: Employee }[];
}

export interface ReportingLineWarning {
  code: 'NO_ROOT' | 'SECOND_ROOT' | 'MANAGER_HAS_LEFT';
  message: string;
  /** Who the warning is about, so a screen can link to them rather than describe them. */
  employeeIds: string[];
}

/**
 * The standing check on the reporting lines. FR 02 and FR 04.
 *
 * This is the other half of the warning HR gets, and it exists because the two
 * halves catch different things. {@link SecondRootEmployee} and
 * {@link ManagerHasLeft} catch a bad line being *drawn*, in front of the person
 * drawing it. This catches a line that was fine when it was drawn and is not any
 * more, which is the case nothing at write time can see: nobody edited the
 * record whose manager left.
 *
 * It reports rather than refuses, because every condition here is already true
 * by the time it is asked about. There is nothing left to refuse, only somebody
 * to tell.
 */
export function warnAboutReportingLines(lines: ReportingLines): ReportingLineWarning[] {
  const warnings: ReportingLineWarning[] = [];

  if (lines.total > 0 && lines.rootless.length === 0) {
    /* Not an omission. With manager_id a foreign key to this same table and no
       NULL anywhere in it, every upward walk is infinite over a finite set, so
       it must revisit somebody: no root means a cycle. Naming that here saves
       the next person the twenty minutes of looking for the missing chief
       executive. FR 03 and LMS 104 are what fix it. */
    warnings.push({
      code: 'NO_ROOT',
      message:
        'Every employee has a line manager and none is the head of the organisation, ' +
        'so somewhere a reporting line loops back on itself. No upward walk can ' +
        'terminate, which means no request can be routed.',
      employeeIds: [],
    });
  }

  if (lines.rootless.length > 1) {
    /* The employee_one_root index makes this unreachable through any write. It
       is still asked, because the check should report what is in the table
       rather than what ought to be possible: a database restored from a dump
       taken before that index, or one the down migration has been run against,
       can hold it, and this is the only thing that would say so. */
    warnings.push({
      code: 'SECOND_ROOT',
      message:
        `${lines.rootless.length} employees are recorded with no line manager, and ` +
        `exactly one may be: ${lines.rootless.map(fullName).join(', ')}. All but the ` +
        `head of the organisation need one, or their requests have nowhere to go.`,
      employeeIds: lines.rootless.map((employee) => employee.id),
    });
  }

  for (const { employee, manager } of lines.reportingToLeavers) {
    warnings.push({
      code: 'MANAGER_HAS_LEFT',
      message:
        `${fullName(employee)} reports to ${fullName(manager)}, who left on ` +
        `${manager.exitDate ?? 'a date that was not recorded'}. Their requests have ` +
        `nowhere to go until somebody else is recorded as their manager.`,
      employeeIds: [employee.id, manager.id],
    });
  }

  return warnings;
}

function fullName(employee: Employee): string {
  return `${employee.firstName} ${employee.lastName} (${employee.employeeNumber})`;
}

/**
 * The rules that involve more than one field, checked in one place so that
 * creating a record and changing one cannot drift apart.
 */
function checkDatesAgree(
  startDate: CalendarDate,
  exitDate: CalendarDate | null,
  employmentStatus: EmploymentStatus,
): void {
  // String comparison is date comparison for YYYY-MM-DD, which is most of why
  // dates are carried in that form.
  if (exitDate !== null && exitDate < startDate) {
    throw new InvalidEmployee(
      'exitDate',
      `An exit date of ${exitDate} is before the start date of ${startDate}.`,
    );
  }

  /* FR 06 keeps a leaver's record and FR 37a settles their final figure from the
     exit date, so a record marked TERMINATED without one cannot be finished. An
     exit date on an ACTIVE record is allowed and ordinary: it is somebody
     serving notice.

     An exit date in the future on a TERMINATED record is allowed too, and that
     is a decision rather than an omission. It is HR doing a leaver's paperwork
     on the Friday for a Sunday exit, which is how the work actually happens.
     Refusing it would push them to either wait or lie about the date, and a
     wrong exit date is far more expensive here than an early one — it is the
     date the final figure is calculated from. */
  if (employmentStatus === 'TERMINATED' && exitDate === null) {
    throw new InvalidEmployee(
      'exitDate',
      'An employee recorded as terminated needs the date they left.',
    );
  }
}

/**
 * Work addresses are company addresses, checked here as well as at sign in.
 *
 * This is the provisioning door of NFR SEC 01, and it is the one that matters
 * more of the two: refusing a personal address at login stops that person
 * signing in, whereas refusing it here stops the record ever existing.
 *
 * Stored folded to lower case. The database compares the two identifiers without
 * regard to case in any event, but an address is a machine identifier rather
 * than a name, and there is nothing to preserve the capitals of.
 */
function normaliseWorkEmail(value: string | undefined, domains: string[]): string {
  const email = requireText('workEmail', value, 160).toLowerCase();
  assertCompanyEmail(email, domains);
  return email;
}

/**
 * The team they are in. LMS 105.
 *
 * Simpler than the line manager reference below, because there is no exception
 * to make room for. Nobody is outside the organisation chart the way the head of
 * it is outside the reporting lines, so there is no meaning to give `null` and it
 * is refused along with everything else that is not an id.
 *
 * Whether that id is a department, and whether it is one still open, are
 * questions about another table and belong to the service.
 */
function requireDepartmentReference(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmployee(
      'departmentId',
      'Every employee belongs to a department, so that their leave can be reported ' +
        'and planned by team. Choose the team they are in.',
    );
  }

  return value.trim();
}

/**
 * The week they work, on a record being created. FR 23, LMS 106.
 *
 * Silence is the ordinary case and means "the usual week": most people work the
 * standard one, and making every caller look up the id of a pattern they did not
 * choose would be a lookup with one right answer. `null` and `''` say the same
 * thing as omitting it, because both are a form that submitted its empty select
 * box, and on a record that does not exist yet there is nothing being cleared.
 *
 * Which pattern the usual week is, is a row in another table, so the answer
 * comes from {@link EmployeeService.create} rather than from here.
 */
function optionalWorkPatternReference(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') {
    return null;
  }

  return value.trim();
}

/**
 * The week they work, on a record that already has one.
 *
 * Deliberately stricter than the same field on a new record, and the difference
 * is what the caller is saying rather than what they typed. On a new record an
 * empty box is "no preference", and there is a right answer to that. On an
 * existing one it is an instruction to remove the pattern somebody is on, and
 * there is no such thing as an employee who works no week: the column is NOT
 * NULL, and a leaver keeps their pattern because FR 37a settles their final
 * figure against it. Moving somebody to a different week is what was meant.
 */
function requireWorkPatternReference(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmployee(
      'workPatternId',
      'An employee always works some week, so a working pattern cannot be removed. ' +
        'Assign a different one instead.',
    );
  }

  return value.trim();
}

/**
 * The line manager reference, or a deliberate statement that there is none.
 *
 * Three inputs, three different meanings, and keeping them apart is most of the
 * story:
 *
 *   `undefined` is the caller not having said. Refused, because a record with no
 *   manager by accident is exactly the one whose requests go nowhere.
 *
 *   `null` is "this is the head of the organisation". Permitted here and checked
 *   against the rest of the table by the service, because at most one may be it.
 *
 *   A string is an id, which the service then has to find.
 *
 * `''` is refused rather than read as `null`. Unlike a job title, where blank is
 * somebody clearing a field, blank in a reference is a form that submitted its
 * empty select box, and a routing black hole is not something to infer from an
 * empty string. The route layer of Phase 5 maps its own blanks to `null`
 * knowingly, which is where that decision belongs.
 */
function requireManagerReference(value: string | null | undefined): string | null {
  if (value === undefined) {
    throw new InvalidEmployee(
      'managerId',
      'Every employee has a line manager, so that their requests have somewhere to ' +
        'go. If this is the head of the organisation, say so with a managerId of ' +
        'null rather than by leaving it out.',
    );
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmployee(
      'managerId',
      'managerId must be the id of the line manager, or null for the head of the ' +
        'organisation.',
    );
  }

  return value.trim();
}

function requireText(field: string, value: string | undefined, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmployee(field, `${field} is required.`);
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new InvalidEmployee(
      field,
      `${field} is longer than the ${maxLength} characters the record holds.`,
    );
  }

  return trimmed;
}

/**
 * Trimmed, or null.
 *
 * A string of spaces becomes null rather than being refused. Unlike a required
 * field, where blank means the caller forgot something, blank in an optional one
 * is somebody clearing it, and storing '' would leave a record that has a job
 * title according to every `IS NOT NULL` and shows nothing on every screen.
 */
function optionalText(field: string, value: string | null | undefined, maxLength: number) {
  if (value == null || value.trim() === '') {
    return null;
  }
  return requireText(field, value, maxLength);
}

const CALENDAR_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a date is is ./time.ts's; which field was wrong and how to say so is
 * this file's. The two refusals stay separate because they are the two different
 * mistakes an HR officer makes — a date written the other way round, and a day
 * that is not a day — and one message covering both would help with neither.
 */
function requireDate(field: string, value: CalendarDate | undefined): CalendarDate {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmployee(field, `${field} is required.`);
  }

  const date = value.trim();
  if (!CALENDAR_DATE_SHAPE.test(date)) {
    throw new InvalidEmployee(field, `${field} must be a calendar date, as YYYY-MM-DD.`);
  }

  // The shape being right does not make the date real: 2026-02-31 and 2026-13-01
  // both match ten characters and are not days.
  if (!isCalendarDate(date)) {
    throw new InvalidEmployee(field, `${date} is not a real date.`);
  }

  return date;
}

function optionalDate(field: string, value: CalendarDate | null | undefined): CalendarDate | null {
  if (value == null || value.trim() === '') {
    return null;
  }
  return requireDate(field, value);
}

function requireOneOf<T extends string>(
  field: string,
  value: string | undefined,
  permitted: readonly T[],
): T {
  if (typeof value !== 'string' || !permitted.includes(value as T)) {
    throw new InvalidEmployee(
      field,
      `${field} must be one of ${permitted.join(', ')}, not ${String(value)}.`,
    );
  }
  return value as T;
}
