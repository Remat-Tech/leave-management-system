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
  /* LMS 110. Written by nothing yet. */
  mfa_enabled: Generated<boolean>;
  mfa_code_hash: string | null;
  mfa_code_expires_at: Date | null;
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

export interface Database {
  app_user: AppUserTable;
  department: DepartmentTable;
  employee: EmployeeTable;
  work_pattern: WorkPatternTable;
  work_pattern_day: WorkPatternDayTable;
}
