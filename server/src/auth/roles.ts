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
 * grant one is ../services/role-service.ts.
 *
 * Deciding what a role *permits* is LMS 112 and is ./policy.ts and the policy
 * objects beside it. What this file gained from that story is the four standing
 * groups the policies are written in terms of — {@link READS_EVERY_RECORD} and
 * the three below it. They are here rather than there because a group of roles
 * is a fact about roles, and because five policies each spelling out its own
 * copy of the same three codes is five places for them to drift apart. No rule
 * about any particular record is here, and none should arrive.
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
 * The roles that may read anybody's record. LMS 112.
 *
 * The same three as {@link MANDATORY_ROLES} in ./mfa.ts, and that is not a
 * coincidence to be tidied away into a shared constant — it is two files stating
 * the same fact for different reasons, and the unit suite asserts they agree.
 * mfa.ts says these three must answer a one time code *because* they can read
 * everybody's records; this is the file that makes that true. If the two ever
 * disagree, one of them is wrong and the suite says so rather than a code
 * quietly becoming optional for somebody who can read the company's leave.
 */
export const READS_EVERY_RECORD: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'];

/**
 * The roles that create, change and terminate employee records. LMS 112.
 *
 * The day to day of HR. SYS_ADMIN is deliberately not among them: a system
 * administrator keeps the system running and is not the person who decides that
 * somebody has left the company. They can read the record — a support request
 * about a wrong balance is unanswerable otherwise — and they cannot write it.
 */
export const MAINTAINS_EMPLOYEE_RECORDS: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

/**
 * The role that changes what the system does to everybody. LMS 112.
 *
 * Departments and working patterns are not records about a person, they are the
 * shape leave is counted and reported in: closing a team moves a heading off
 * every report, and editing a week changes what a day off costs for everybody on
 * it. That is an HR Administrator's decision rather than an HR Officer's, and it
 * is the whole of what distinguishes the two.
 *
 * One role rather than a list, which reads oddly and is meant to. It is here as
 * a name so that the reason lives in one place and so that widening it later is
 * a deliberate edit to this line with this comment above it.
 */
export const SETS_UP_THE_ORGANISATION: readonly RoleCode[] = ['HR_ADMIN'];

/**
 * The roles that keep the public holiday calendar. FR 22. LMS 206.
 *
 * The one configuration table that is not Remat's decision at all. What annual
 * leave is worth, who approves unpaid leave and when the leave year ends are all
 * things this company chose, and {@link SETS_UP_THE_ORGANISATION} is who chooses
 * them. The gazetted holidays are the Republic's, published by the Ministry for
 * the Interior, and HR is transcribing rather than deciding — so the desk that
 * does it is the one people actually walk up to.
 *
 * The practical argument is the one {@link PROVIDES_LOGINS} makes. A holiday
 * gazetted on a Tuesday for the Friday of the same week is a two minute job; make
 * an HR Officer raise a ticket for it and the calendar is a week behind the
 * country by March, which costs somebody a day of leave for an afternoon nobody
 * worked.
 *
 * The same two codes as {@link MAINTAINS_EMPLOYEE_RECORDS}, and deliberately a
 * separate constant rather than a reuse of it, exactly as
 * {@link PROVIDES_LOGINS} is separate from {@link READS_EVERY_RECORD}. They agree
 * today for unrelated reasons — one is about the records of the people here, this
 * is about a calendar somebody else publishes — and the day one of them changes is
 * the day a shared constant would have moved the other silently.
 */
export const MAINTAINS_THE_CALENDAR: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

/**
 * The roles that staff the HR desk in a leave type's approval chain. FR 38a. LMS 314.
 *
 * FR 38a gives each leave type an ordered chain of *desks* — MANAGER, HR, CEO — and two of
 * the three are not roles at all: a manager is somebody a person reports to, and the Chief
 * Executive is the one employee FR 04 leaves without a line manager. HR is the one that is
 * a grant, and it is two of them, because "unpaid leave is approved by HR" is what the
 * policy says and which of the two codes the person on duty holds is not something an HR
 * Administrator should have to encode to configure a leave type.
 *
 * The same two codes as {@link MAINTAINS_EMPLOYEE_RECORDS}, and deliberately a separate
 * constant rather than a reuse of it, exactly as {@link MAINTAINS_THE_CALENDAR} is. They
 * agree today for unrelated reasons — that one is about creating and terminating the
 * records of the people here, this is about who may sign off somebody's leave — and the day
 * one of them changes is the day a shared constant would have moved the other silently. A
 * story widening who maintains records to include a System Administrator would otherwise
 * have quietly made them an approver of every unpaid leave request in the company.
 *
 * SYS_ADMIN is not on it for that reason and not by omission. Keeping the system running is
 * not deciding whether somebody may be away for a fortnight.
 */
export const APPROVES_AS_HR: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN'];

/**
 * The roles that set a joiner up with a login and reset a forgotten password.
 * LMS 112.
 *
 * HR, and the reason is that this is the desk people actually walk up to. An HR
 * Officer is who creates the employee record on somebody's first morning, and
 * making them stop there and wait for an administrator to add the login turns a
 * two minute job into a ticket — which is how a company ends up with a shared
 * administrator password that four people in HR know, and that is a worse
 * outcome than anything this rule was protecting.
 *
 * SYS_ADMIN is included because somebody has to be able to do it when HR cannot
 * sign in, which is the failure this system has to survive.
 *
 * The same three codes as {@link READS_EVERY_RECORD}, and deliberately a
 * separate constant rather than a reuse of it. They agree today for unrelated
 * reasons — one is about seeing the company's records, this is about who runs
 * the joining process — and the day one of them changes is the day sharing a
 * constant would have moved the other silently.
 *
 * What is **not** here is closing an account, which is {@link ADMINISTERS_ACCESS}
 * below. Giving somebody access as they join and taking it away in the middle of
 * an investigation are not the same act, and the second is the one that wants a
 * second pair of eyes.
 */
export const PROVIDES_LOGINS: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'];

/**
 * The roles that decide who may get in and what they may do. LMS 112.
 *
 * Role grants, and closing or reopening an account. Two roles rather than one
 * because they come at it from different ends and both are legitimate: HR knows
 * who has joined and who has left, and the system administrator is who is left
 * when HR cannot sign in.
 *
 * Giving somebody a login in the first place is not here — see
 * {@link PROVIDES_LOGINS}. The line between the two is that this is where a
 * decision about somebody is being made rather than a joining process being
 * followed: granting HR powers, and shutting an account because of a lost laptop
 * or an investigation.
 *
 * It is worth being plain that this is the escalation path in this system. A
 * SYS_ADMIN who wants to close a department cannot, but can grant themselves
 * HR_ADMIN and then do it — which is true of every system administrator
 * everywhere, is not a hole to be plugged with a rule they could also change,
 * and is precisely why every grant is a dated row and every refusal is logged.
 */
export const ADMINISTERS_ACCESS: readonly RoleCode[] = ['HR_ADMIN', 'SYS_ADMIN'];

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
