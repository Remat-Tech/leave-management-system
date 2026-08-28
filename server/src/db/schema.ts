/**
 * The tables, as TypeScript sees them.
 *
 * Written by hand and kept in step with the migrations by reading them. That is
 * the direction the README insists on: the SQL is the source of truth and no
 * library generates or owns the schema. Kysely reads these types; it does not
 * produce them, and nothing here may be treated as a description of what the
 * database ought to be.
 *
 * Only the tables the application actually queries appear. The rest join as the
 * stories that need them arrive, rather than a wall of types for tables nothing
 * reads yet.
 *
 * Two conventions that are easy to get wrong and expensive to notice late:
 *
 * `bigint` columns are typed `string`. That is what the pg driver returns, and
 * changing it would silently lose precision above 2^53 rather than fail. Ids are
 * handles, not arithmetic.
 *
 * `date` columns are typed `string` too, holding `YYYY-MM-DD`. The driver is
 * configured in ./index.ts to hand them back untouched instead of building a
 * `Date` at UTC midnight, which is the off by one day bug the README warns
 * about. `timestamptz` columns are instants and stay `Date`.
 */

import type { ColumnType, Generated } from 'kysely';

/** Written by the database, never by the application. */
type Timestamp = ColumnType<Date, never, never>;

export interface EmployeeTable {
  id: Generated<string>;
  employee_number: string;
  first_name: string;
  last_name: string;
  work_email: string;
  job_title: string | null;
  /* NOT NULL since the department-rules migration: leave is reported and planned
     by team, and somebody in no team appears in no team's figures. */
  department_id: string;
  /* FR 02. Nullable because exactly one employee — the head of the organisation
     — has nobody to report to. The employee_one_root index is what makes that
     "exactly one" rather than "as many as anybody types". FR 04. */
  manager_id: string | null;
  /* FR 23. NOT NULL: everybody works some week, and a day count needs to know
     which. A caller who names none gets the default pattern, resolved by
     EmployeeService rather than defaulted in the column, because which pattern is
     the default is a row in another table and not something a DDL default can
     read. */
  work_pattern_id: string;
  start_date: string;
  exit_date: string | null;
  employment_type: Generated<string>;
  employment_status: Generated<string>;
  gender: string | null;
  created_at: Timestamp;
  /* Maintained by the employee_set_updated_at trigger, so it is never supplied
     on an insert or an update. */
  updated_at: Timestamp;
}

export interface DepartmentTable {
  id: Generated<string>;
  name: string;
  /* Present because the column is. Nothing writes it, so a department hierarchy
     does not exist rather than half existing; see the department-rules
     migration for what a story that wants one has to bring. */
  parent_id: string | null;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  /* Maintained by the department_set_updated_at trigger, which attaches to the
     same set_updated_at() the employee table uses. Never supplied by a writer. */
  updated_at: Timestamp;
}

export interface WorkPatternTable {
  id: Generated<string>;
  name: string;
  /* Exactly one row in this table holds true. The work_pattern_one_default index
     makes that "no more than one" and the work_pattern_always_has_a_default
     trigger makes it "no fewer"; see the working-pattern-rules migration. */
  is_default: Generated<boolean>;
  created_at: Timestamp;
  /* Maintained by the work_pattern_set_updated_at trigger, which attaches to the
     same set_updated_at() the employee and department tables use. Never supplied
     by a writer. */
  updated_at: Timestamp;
}

/**
 * Which days of the week a pattern works. FR 23.
 *
 * Seven rows per pattern, always: `day_of_week` is ISO, 1 for Monday to 7 for
 * Sunday, and a day that is not worked is a row with `is_working_day` false
 * rather than a missing row. The work_pattern_week_complete trigger is what makes
 * that true, and the reason is that a missing row leaves the answer to "does a
 * Saturday inside this request cost a day" to whichever join the counting query
 * happened to use.
 */
export interface WorkPatternDayTable {
  work_pattern_id: string;
  day_of_week: number;
  is_working_day: Generated<boolean>;
}

/**
 * The sign in account. NFR SEC 01, LMS 109.
 *
 * One row per employee who may sign in, and the address on it is that employee's
 * work_email — not a copy that was right when it was written, but a value the
 * sign-in-account-rules migration keeps in step and refuses to let drift. Nothing
 * above the repository chooses it.
 */
export interface AppUserTable {
  id: Generated<string>;
  /* UNIQUE. One person, one login. */
  employee_id: string;
  company_email: string;
  /* NULL until somebody sets one, which is the state a login is provisioned in
     and the state every seeded login is in. Refused at the door, and told apart
     from a wrong password only in the log. */
  password_hash: string | null;
  /* LMS 110. Whether this person chose a code on top of their password. It is
     not the whole answer to "do they need one": the HR and administrator roles
     need one whatever this says, and that is read from user_role at sign in
     rather than copied here. */
  mfa_enabled: Generated<boolean>;
  /* A challenge in progress. All three move together: issued together, cleared
     together, and meaningless apart — app_user_code_and_expiry_together holds the
     first two to that, and the attempt count is reset by the same write that
     issues a code. NULL in all three is most rows most of the time. */
  mfa_code_hash: string | null;
  mfa_code_expires_at: Date | null;
  mfa_code_attempts: Generated<number>;
  /* An administrative lock, separate from employment. A leaver is refused by
     their employee record's status, which cannot drift; this is for an account
     that has to be closed for a reason of its own. */
  is_active: Generated<boolean>;
  last_login_at: Date | null;
  created_at: Timestamp;
  /* Maintained by the app_user_set_updated_at trigger, which attaches to the same
     set_updated_at() the employee, department and work_pattern tables use. Never
     supplied by a writer. */
  updated_at: Timestamp;
}

/**
 * The roles somebody can hold. Reference data, seeded by the organisation
 * migration and not edited at runtime — lms_app holds no UPDATE or DELETE on it.
 *
 * MANAGER is deliberately not among them. Being a manager is a relationship: you
 * are one if some employee has your id as their manager_id. Holding it as a role
 * as well would be two sources of truth that drift the moment somebody changes
 * team.
 */
export interface RoleTable {
  id: Generated<string>;
  /* EMPLOYEE | HR_OFFICER | HR_ADMIN | SYS_ADMIN. Matched against
     MANDATORY_ROLES in ../auth/mfa.ts, which the integration tests assert. */
  code: string;
  name: string;
}

/**
 * Who holds which. Read at sign in by the rule that makes a one time code
 * mandatory for HR and administrators. LMS 110.
 *
 * Writing to it — assigning and removing roles — is LMS 111, which is why nothing
 * in the tree inserts here yet but the seed.
 */
export interface UserRoleTable {
  user_id: string;
  role_id: string;
  /* When it was granted. LMS 111. "Who has HR powers and since when" is most of
     what somebody reviewing access asks, and two ids answer only the first half.
     Who granted it waits for an authenticated actor — LMS 112 — and belongs in
     the audit log of LMS 113 rather than in a column that would be null on every
     row until then. */
  granted_at: Generated<Date>;
}

/**
 * The audit log. NFR AUD 01 and NFR AUD 02. LMS 113.
 *
 * Read by the application and never written by it — not because it holds no
 * INSERT, which it does, but because every row here is written by a trigger on
 * the table that changed. There is no insert statement anywhere above this file
 * and there should never be one: an entry the application composes is an entry
 * the application can compose wrongly, or forget.
 *
 * `never` on every column for insert and update is that rule said in the type
 * system. lms_app holds no UPDATE or DELETE at all, so the update half is
 * doubly true.
 */
export interface AuditLogTable {
  id: Generated<string>;
  occurred_at: Timestamp;
  /* CREATE | UPDATE | DELETE, held closed by audit_log_action_known. */
  action: ColumnType<string, never, never>;
  /* The table that changed, from TG_TABLE_NAME, so it cannot drift from it. */
  entity: ColumnType<string, never, never>;
  /* The record this is filed under: its own id, or its parent's for a child
     table. Text rather than bigint because work_pattern_day files under a
     pattern and user_role under a login, and one column has to hold both. */
  entity_id: ColumnType<string, never, never>;
  /* The record either side of the change. Null on one side says which kind of
     change it was as reliably as `action` does. Secrets are stored as a marker;
     see the audit-log migration. */
  before: ColumnType<Record<string, unknown> | null, never, never>;
  after: ColumnType<Record<string, unknown> | null, never, never>;
  /* Who, in words, from the setting the repositories put on the transaction. A
     writer that did not say so says so. */
  actor: ColumnType<string, never, never>;
  actor_employee_id: ColumnType<string | null, never, never>;
}

export interface Database {
  app_user: AppUserTable;
  audit_log: AuditLogTable;
  department: DepartmentTable;
  employee: EmployeeTable;
  role: RoleTable;
  user_role: UserRoleTable;
  work_pattern: WorkPatternTable;
  work_pattern_day: WorkPatternDayTable;
}
