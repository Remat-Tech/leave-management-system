/** The department record. */

/** What the caller supplies to create one. */
export interface NewDepartment {
  name: string;
}

/** The fields of an existing one that may change. */
export type DepartmentChanges = Partial<NewDepartment>;

/** A record as it comes back out. */
export interface Department {
  id: string;
  name: string;
  /** Present because the column is. */
  parentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedDepartment {
  name: string;
}

/** A record that was refused, and the field that caused it. */
export class InvalidDepartment extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidDepartment';
    this.field = field;
  }
}

export class DuplicateDepartmentName extends Error {
  constructor(name: string) {
    super(`There is already a department called ${name}.`);
    this.name = 'DuplicateDepartmentName';
  }
}

export class DepartmentNotFound extends Error {
  constructor(id: string) {
    super(`No department with id ${id}.`);
    this.name = 'DepartmentNotFound';
  }
}

/**
 * A department that still has people in it.
 *
 * Closing a team under the people standing in it is how an employee ends up in
 * no usable team at all: `employee.department_id` is NOT NULL, so they cannot be
 * moved out by the act of closing it, and they would go on being counted in a
 * department that no report offers as a choice.
 *
 * The count is carried because "move them first" is only actionable if HR knows
 * how many there are and can go and find them.
 */
export class DepartmentStillStaffed extends Error {
  readonly headcount: number;

  constructor(department: Department, headcount: number) {
    super(
      `${department.name} still has ${headcount} ` +
        `${headcount === 1 ? 'person' : 'people'} in it. Move ` +
        `${headcount === 1 ? 'them' : 'them all'} to another department before ` +
        `closing this one.`,
    );
    this.name = 'DepartmentStillStaffed';
    this.headcount = headcount;
  }
}

/**
 * An employee being put into a department that has been closed.
 *
 * The counterpart of {@link DepartmentStillStaffed}, and the two together are
 * what keep the invariant: nobody can be moved into a closed department, and no
 * department can be closed with somebody in it.
 */
export class DepartmentDeactivated extends Error {
  readonly departmentId: string;

  constructor(department: Department) {
    super(
      `${department.name} has been closed and nobody can be assigned to it. ` +
        `Choose a department that is still open, or reopen this one.`,
    );
    this.name = 'DepartmentDeactivated';
    this.departmentId = department.id;
  }
}

/** Checks and tidies a new record. */
export function validateNewDepartment(input: NewDepartment): ValidatedDepartment {
  return { name: requireName(input.name) };
}

/**
 * Checks and tidies a change to an existing one.
 *
 * Only the fields actually supplied are returned, so that a change mentioning
 * nothing leaves the record exactly as it was rather than rewriting it with
 * whatever the caller happened to have loaded.
 *
 * Takes no `current`, unlike the employee equivalent, because a department has
 * one editable field and so no rule that spans two. When a second one arrives
 * and they have to agree, this grows the parameter that employee.ts already has
 * and for the same reason.
 */
export function validateDepartmentChanges(
  changes: DepartmentChanges,
): Partial<ValidatedDepartment> {
  const validated: Partial<ValidatedDepartment> = {};

  if ('name' in changes) {
    validated.name = requireName(changes.name);
  }

  return validated;
}

/**
 * Whether a department may be closed, given how many people are still in it.
 *
 * The count is passed in rather than read here, so the rule needs no database
 * and there is one description of it however the counting is done.
 *
 * "Still in it" means still employed. A leaver stays in the department they left
 * from — their record keeps every other field it had, FR 06, and this is no
 * different — and they are no bar to closing it, because they are not going to
 * raise a request that has to be reported under a team heading.
 *
 * Closing one that is already closed is allowed and does nothing. That is a
 * deliberate difference from terminating an employee twice, which
 * {@link AlreadyTerminated} refuses: there, the second attempt silently writes a
 * new exit date over the one a final figure was settled from. Here the second
 * attempt writes the same boolean it already holds, and there is nothing to
 * lose by letting it.
 */
export function assertCanDeactivate(department: Department, activeHeadcount: number): void {
  if (activeHeadcount > 0) {
    throw new DepartmentStillStaffed(department, activeHeadcount);
  }
}

/** Whether an employee may be put into this department. */
export function assertCanTakeEmployees(department: Department): void {
  if (!department.isActive) {
    throw new DepartmentDeactivated(department);
  }
}

/**
 * The one field a department has.
 *
 * Trimmed rather than refused when it arrives padded, because a name is copied
 * and pasted off a spreadsheet more often than it is typed, and a leading space
 * is not something to make an HR officer hunt for. Blank is refused rather than
 * trimmed to nothing: a caller sending one has a bug, and a department with no
 * name is a heading that shows nothing wherever it appears.
 */
function requireName(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidDepartment('name', 'A department needs a name.');
  }

  const name = value.trim();
  if (name.length > 120) {
    throw new InvalidDepartment(
      'name',
      'A department name is longer than the 120 characters the record holds.',
    );
  }

  return name;
}
