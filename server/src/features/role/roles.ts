/** Roles, and what may be done with them. §5.3., LMS 111, LMS 112. */

/** Every role there is. */
export const ROLE_CODES = ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

/** The role everybody with a login has, and the only one nobody grants. */
export const BASELINE_ROLE: RoleCode = 'EMPLOYEE';

/** The roles somebody can be given and can lose. */
export const ASSIGNABLE_ROLES: readonly RoleCode[] = ROLE_CODES.filter(
  (code) => code !== BASELINE_ROLE,
);

/** The roles that may read anybody's record. LMS 112. */
export const READS_EVERY_RECORD: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'];

/** The roles that create, change and terminate employee records. LMS 112. */
export const MAINTAINS_EMPLOYEE_RECORDS: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

/** The role that changes what the system does to everybody. LMS 112. */
export const SETS_UP_THE_ORGANISATION: readonly RoleCode[] = ['HR_ADMIN'];

/** The roles that keep the public holiday calendar. FR 22, LMS 206. */
export const MAINTAINS_THE_CALENDAR: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

/** The roles that staff the HR desk in a leave type's approval chain. FR 38a, LMS 314, FR 04. */
export const APPROVES_AS_HR: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

/** The roles that set a joiner up with a login and reset a forgotten password. LMS 112. */
export const PROVIDES_LOGINS: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'];

/** The roles that decide who may get in and what they may do. LMS 112. */
export const ADMINISTERS_ACCESS: readonly RoleCode[] = ['HR_ADMIN', 'SYS_ADMIN'];

/** What somebody is, for the purposes of deciding what they may do. */
export interface Authority {
  roles: RoleCode[];
  isManager: boolean;
}

/** A role code that is not one of the four. */
export class UnknownRole extends Error {
  readonly code: string;

  constructor(code: string) {
    super(
      code.trim().toUpperCase() === 'MANAGER'
        ? 'MANAGER is not a role. Somebody is a manager because an employee reports ' +
            'to them, which is a fact about the reporting lines rather than something ' +
            'to grant. Change who reports to whom instead.'
        : `${code} is not a role. The roles are ${ROLE_CODES.join(', ')}.`,
    );
    this.name = 'UnknownRole';
    this.code = code;
  }
}

/**
 * An attempt to take away the role that is not a grant.
 *
 * Refused rather than ignored, for the reason every refusal in this layer is
 * refused rather than ignored: a screen that reports a role removed while the
 * person still has it is worse than one that says no.
 */
export class RoleCannotBeRevoked extends Error {
  constructor(code: RoleCode) {
    super(
      `${code} is held by everybody with a login and cannot be taken away. It is ` +
        `what being able to see your own leave is called. To stop somebody signing ` +
        `in at all, close their account instead.`,
    );
    this.name = 'RoleCannotBeRevoked';
  }
}

/**
 * The last System Administrator, being removed.
 *
 * Not asked for by the story, and the reason it is here anyway is the story's
 * own "so that": powers held deliberately. Removing the last SYS_ADMIN is the
 * one role change that cannot be undone by anybody, because the person who would
 * undo it is the person who just stopped existing. It is the same class of rule
 * as FR 04's single root — a shape the organisation has to keep — and it is held
 * in the database as well, by user_role_keeps_a_system_administrator.
 */
export class LastSystemAdministrator extends Error {
  constructor() {
    super(
      'This is the only System Administrator. Removing the role would leave nobody ' +
        'able to grant it back, including the person doing it. Give somebody else ' +
        'the role first.',
    );
    this.name = 'LastSystemAdministrator';
  }
}

/** Somebody who does not hold the role being taken away. */
export class RoleNotHeld extends Error {
  constructor(code: RoleCode) {
    super(`They do not hold ${code}, so there is nothing to take away.`);
    this.name = 'RoleNotHeld';
  }
}

/**
 * Reads a role code, or refuses it.
 *
 * Tolerant about case and spacing, because this arrives from a form and
 * `hr_admin` is not a different role from `HR_ADMIN`. Strict about everything
 * else: an unrecognised code is refused rather than ignored, so that a screen
 * sending the wrong value hears about it instead of silently granting nothing.
 */
export function readRoleCode(value: unknown): RoleCode {
  if (typeof value !== 'string') {
    throw new UnknownRole(String(value));
  }

  const code = value.trim().toUpperCase();

  if (!(ROLE_CODES as readonly string[]).includes(code)) {
    throw new UnknownRole(value.trim());
  }

  return code as RoleCode;
}

/** The same, for a role somebody is allowed to be given or lose. */
export function readAssignableRoleCode(value: unknown): RoleCode {
  const code = readRoleCode(value);

  if (code === BASELINE_ROLE) {
    throw new RoleCannotBeRevoked(code);
  }

  return code;
}

/**
 * Codes as they come back from the database, in the order {@link ROLE_CODES}
 * declares.
 *
 * Sorted by power rather than alphabetically, so that a list of somebody's roles
 * reads as an escalation and the most significant one is last wherever it is
 * shown. Alphabetical would put HR_ADMIN before HR_OFFICER, which is the reverse
 * of what it means.
 *
 * Anything the database holds that is not a known code is dropped rather than
 * carried. It cannot happen — role_code_known refuses it — and if it ever does,
 * the safe reading of a role nothing understands is that it grants nothing.
 */
export function orderRoles(codes: readonly string[]): RoleCode[] {
  return ROLE_CODES.filter((code) => codes.includes(code));
}
