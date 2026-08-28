/**
 * Roles, and what may be done with them. Technical Design Document §5.3.
 * LMS 111.
 *
 * A role is a power somebody has been given on purpose. The story's "rather than
 * by whoever happened to set the system up" is the whole of the point: HR and
 * administrative powers are not a property of having been here longest or of
 * having created the database, they are four named things that somebody granted
 * to somebody else and that can be listed and taken away.
 *
 * Four of them, and the set is closed. {@link ROLE_CODES} is the same list the
 * organisation migration seeds and the role-assignment-rules migration holds as
 * a CHECK, and the integration tests assert that the three agree. Adding a fifth
 * is a migration rather than a row, which is right: a role nothing in the
 * authorisation layer has heard of is a role that grants nothing, and a row that
 * silently grants nothing is worse than a compile error.
 *
 * MANAGER is not one of them and cannot become one. See {@link Authority}.
 *
 * The rules live here as pure functions. Which roles somebody actually holds is
 * a table, and that is ../repositories/role-repository.ts; deciding when to
 * grant one is ../services/role-service.ts; deciding what a role *permits* is
 * LMS 112, and none of it is here.
 */

/**
 * Every role there is.
 *
 * Ordered from least to most power, which is the order they are shown in and the
 * order that makes a list of somebody's roles read sensibly.
 */
export const ROLE_CODES = ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

/**
 * The role everybody with a login has, and the only one nobody grants.
 *
 * It is what "can see their own leave and ask for more of it" is called. Every
 * login gets it at provisioning and none may have it taken away: an account
 * without it is a person who can sign in and then do nothing, which is not a
 * state anybody wants and not what anybody means when they take a role off
 * somebody. Closing the account is what they mean, and that is
 * {@link SignInService.close}.
 */
export const BASELINE_ROLE: RoleCode = 'EMPLOYEE';

/**
 * The roles somebody can be given and can lose. Everything except the baseline.
 *
 * This is the list a screen offers as tick boxes, which is why it exists
 * separately rather than being filtered at each call site.
 */
export const ASSIGNABLE_ROLES: readonly RoleCode[] = ROLE_CODES.filter(
  (code) => code !== BASELINE_ROLE,
);

/**
 * What somebody is, for the purposes of deciding what they may do.
 *
 * Two fields, and they are two different kinds of fact, which is the reason they
 * are not one list:
 *
 *   `roles` is what was granted. Rows in user_role, put there deliberately by
 *   somebody, removable by somebody.
 *
 *   `isManager` is what is true. You are a manager if some employee has your id
 *   as their manager_id, and that is the end of it. Nobody grants it, nobody
 *   revokes it, and it changes the moment a reporting line moves.
 *
 * The story's third criterion is that the second never becomes the first, and
 * the organisation migration has said so since the table was created: "Being a
 * manager is a relationship: you are one if some employee has your id as their
 * manager_id. Holding it as a role too would create two sources of truth that
 * drift the moment somebody changes team."
 *
 * Keeping them apart in the type is how that stays true in the code as well as
 * in the schema. A single `roles: string[]` containing 'MANAGER' would be the
 * drift, one layer up: something would grant it, something else would forget to,
 * and an approver queue would quietly be wrong. Authorisation asks "is this
 * person one of my reports?", never "do they have the manager role?".
 */
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
