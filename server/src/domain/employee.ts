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
 * Two things about the record belong to other stories and are deliberately
 * absent. The line manager is FR 02 and LMS 103, and deactivation is FR 06 and
 * LMS 102: this module will record a status of TERMINATED with an exit date, but
 * the rules about who may end an employment and what else happens when they do
 * are not here.
 */

import { assertCompanyEmail } from '../auth/company-email.js';

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
 */
export type CalendarDate = string;

/** What the caller supplies to create a record. */
export interface NewEmployee {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle?: string | null;
  departmentId?: string | null;
  workPatternId?: string | null;
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

/** A record as it comes back out. */
export interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle: string | null;
  departmentId: string | null;
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

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedEmployee {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  jobTitle: string | null;
  departmentId: string | null;
  workPatternId: string | null;
  startDate: CalendarDate;
  exitDate: CalendarDate | null;
  employmentType: EmploymentType;
  employmentStatus: EmploymentStatus;
  gender: Gender | null;
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
    departmentId: input.departmentId ?? null,
    workPatternId: input.workPatternId ?? null,
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
    validated.departmentId = changes.departmentId ?? null;
  }
  if ('workPatternId' in changes) {
    /* Nullable on the way in so the field can be omitted, but the column is NOT
       NULL: an employee always works some pattern. Clearing it is a caller
       error, not an instruction. */
    if (changes.workPatternId == null) {
      throw new InvalidEmployee(
        'workPatternId',
        'An employee always has a working pattern. Assign a different one rather than removing it.',
      );
    }
    validated.workPatternId = changes.workPatternId;
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
     serving notice. */
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

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(field: string, value: CalendarDate | undefined): CalendarDate {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEmployee(field, `${field} is required.`);
  }

  const date = value.trim();
  if (!CALENDAR_DATE.test(date)) {
    throw new InvalidEmployee(field, `${field} must be a calendar date, as YYYY-MM-DD.`);
  }

  /* The shape being right does not make the date real: 2026-02-31 and 2026-13-01
     both match. Round tripping through UTC and comparing catches those without
     bringing a timezone anywhere near the value, because a date built at UTC
     midnight and formatted back at UTC is the same day it went in. */
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
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
