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
  department_id: string | null;
  /* FR 02. Nullable because exactly one employee — the head of the organisation
     — has nobody to report to. The employee_one_root index is what makes that
     "exactly one" rather than "as many as anybody types". FR 04. */
  manager_id: string | null;
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

export interface WorkPatternTable {
  id: Generated<string>;
  name: string;
  is_default: Generated<boolean>;
}

export interface Database {
  employee: EmployeeTable;
  work_pattern: WorkPatternTable;
}
