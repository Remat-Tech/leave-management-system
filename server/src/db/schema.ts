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
 * about, and the session is pinned to `ISO, YMD` so that the characters it hands
 * back are that form on every host. `timestamptz` columns are instants, are
 * stored as UTC, and stay `Date`. NFR DAT 03; the rule is
 * ../domain/time.ts.
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
 * A leave type and the rules it carries. FR 21, FR 31, FR 32, §5.5. LMS 201.
 *
 * Every column but the first three is a rule that differs between annual leave
 * and maternity leave, held as data so that adding or changing a type is a row
 * rather than a release. What each one means is ../domain/leave-type.ts; the
 * constraints that make a nonsense row impossible are the leave-type-rules
 * migration.
 *
 * `code` is a stable handle for reports and imports and is **not** a branch
 * point. Nothing above the database may read it and decide anything: the rules
 * are the columns, and a `WHEN code = 'MATERNITY'` anywhere is the bug the table
 * exists to prevent.
 *
 * One rule of a type is not a column of it. The approval chain of FR 38a is an
 * ordered list, so it is {@link LeaveTypeApprovalStepTable} below — read and
 * written with the type, the way a working pattern's week is.
 */
export interface LeaveTypeTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: string | null;
  /* FR 21 and FR 22. WORKING_DAYS | CALENDAR_DAYS. Whether the working pattern is
     consulted when counting a request at all. */
  counting_basis: string;
  /* FR 32g. QUOTA | EVENT — the TDD's is_quota_based as a named pair. Whether the
     year rollover opens a leave_balance row, or the grant arrives with the event.
     The figure either way is leave_entitlement_rule, which carries the effective
     dates FR 31 requires. */
  entitlement_basis: string;
  /* FALSE for unpaid leave and the unpaid maternity extension. Nothing in the
     ledger turns on it yet; the report of FR 63 groups by it. */
  is_paid: Generated<boolean>;
  /* DAYS | WEEKS | MONTHS. How the allowance is expressed — "4 months, 120 days"
     — never how it is counted. Everything is counted in whole days, FR 24. */
  unit: Generated<string>;
  /* FR 13. NOT_REQUIRED | ALWAYS | AFTER_DAYS, judged on the length of the
     request. Not the sick leave rule; see exceedable_with_document. */
  documentation: Generated<string>;
  /* NOT NULL exactly when the rule is AFTER_DAYS, which
     leave_type_documentation_agrees holds from both sides. Unset on every type
     the migration ships. */
  documentation_after_days: number | null;
  /* FR 32a. TRUE for sick leave alone: exceeding the balance asks for a medical
     certificate rather than refusing, so the allowance is a documentation
     threshold and not a cap. §8.6b — sick balances go negative, and that is
     correct. */
  exceedable_with_document: Generated<boolean>;
  /* FR 32e. Months after the qualifying event an unused grant lapses. Paternity's
     six, and nothing else today. **Not carry over**: unused annual days rolling
     forward is FR 36 and lives on leave_entitlement_rule. */
  entitlement_expiry_months: number | null;
  /* §8.6aa. Whether one grant may be drawn down by several requests. TRUE
     everywhere today, maternity included — the column exists so a future type
     that must be continuous can say so. */
  may_be_split: Generated<boolean>;
  /* FR 17. Calendar days, 14 for annual leave and 0 for everything else. A
     threshold for a warning: short notice is acknowledged and allowed through. */
  min_notice_calendar_days: Generated<number>;
  /* FR 18. Calendar days after the fact, 7 everywhere. This one refuses; beyond
     it only HR may enter the record, with a reason. */
  max_backdate_calendar_days: Generated<number>;
  /* FR 05. MALE | FEMALE, or null for a type open to everybody. The one place in
     the schema that reads employee.gender, and the reason that column is
     nullable rather than required. */
  gender_restriction: string | null;
  /* FR 33. Always false, and leave_type_never_deducts_from_annual makes that a
     constraint rather than the TDD's comment. Nothing writes it. */
  deducts_from_annual: ColumnType<boolean, never, never>;
  /* §7.4 orders the balance read by it, so the order a form lists types in is a
     decision rather than an alphabetical accident. */
  display_order: Generated<number>;
  /* Retired, never deleted: a type is the heading every request and ledger entry
     is filed under. lms_app holds no DELETE on this table, which is what makes
     that true for every writer rather than only for the service. */
  is_active: Generated<boolean>;
  created_at: Timestamp;
  /* Maintained by the leave_type_set_updated_at trigger, which attaches to the
     same set_updated_at() every other table uses. Never supplied by a writer. */
  updated_at: Timestamp;
}

/**
 * Who approves a kind of leave, and in what order. FR 38a, §5.5. LMS 204.
 *
 * One row per stage. `step_order` is 1 for the first approver and is contiguous
 * from there, which `leave_type_approval_chain_is_whole` holds: a chain that skips
 * a number stops at the gap, and the request waits in a queue nobody is looking
 * at.
 *
 * Written as a whole rather than edited — deleted and re-inserted inside one
 * transaction, the way a working pattern's week is — which is why `lms_app` holds
 * DELETE here and no UPDATE. There are no timestamps for the same reason
 * `work_pattern_day` has none: a step is part of a chain rather than a record in
 * its own right, and its history is the type's. The audit entries are filed under
 * `leave_type_id`.
 */
export interface LeaveTypeApprovalStepTable {
  leave_type_id: string;
  step_order: number;
  /* MANAGER | HR | CEO, held closed by leave_type_approval_step_role_known.
     **Not** one of the four role codes: the chain names the desk a request goes
     to, and how that desk is found is three different questions — a reporting
     line, a role grant, and the one employee with no manager. See
     ../domain/approval-chain.ts. */
  approver_role: string;
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

/**
 * What a leave type is worth, and from when. FR 31, §5.5. LMS 203.
 *
 * The figures the leave type deliberately does not carry, each with the two dates
 * FR 31 requires. Changing one is a new row with a later `effective_from`, never
 * an edit: the entitlement-rule-effective-dates migration has a trigger that
 * refuses to let a rule which has already applied be rewritten by any writer,
 * which is what makes a closed leave year safe from this morning's decision.
 *
 * Nothing here answers "what is annual leave worth" — only "what is annual leave
 * worth on this day, to this person". The picking between rows is
 * ../domain/entitlement-rule.ts and is written once; there is no view and no
 * `ORDER BY ... LIMIT 1` in the repository doing it a second time.
 */
export interface LeaveEntitlementRuleTable {
  id: Generated<string>;
  leave_type_id: string;
  /* The scope, and at most one of them is set — leave_entitlement_rule_scope_is_
     one_thing refuses both, since an employee is already in one department. Both
     null is the rule for everybody, which is what the statutory figures are. */
  employee_id: string | null;
  department_id: string | null;
  /* Whole days, FR 24. Per leave year where the type is QUOTA and per qualifying
     occurrence where it is EVENT — a hundred and twenty days of maternity is per
     confinement. Zero is a decision that this is worth nothing; no rule at all is
     the absence of one, which is what unpaid leave has. */
  entitlement_days: number;
  /* FR 29. Whether a joiner's first year is a proportion of the figure. Read only
     for QUOTA types; the formula is LMS 013 and is applied by LMS 215. */
  prorate_on_join: Generated<boolean>;
  /* FR 36. Whether unused days survive the year end. Annual leave alone today,
     and the column that keeps the rollover job from branching on a type code. */
  carries_over: Generated<boolean>;
  /* FR 36a. How many carried days survive, null for uncapped; the month whatever
     carried lapses in, null for never. Both meaningless where nothing carries,
     which leave_entitlement_rule_carryover_agrees holds from both sides. */
  carryover_max_days: number | null;
  carryover_expiry_month: number | null;
  /* Inclusive both ends. `YYYY-MM-DD`, never an instant: an entitlement changes
     on a day, and a moment would carry a zone that moves it. NFR DAT 03. */
  effective_from: string;
  /* Null for a standing rule with no end in sight, which is what an ordinary
     policy looks like. */
  effective_to: string | null;
  /* Why the rule exists, in HR's words. The only field of a rule already in
     effect that may still be edited: explaining a figure better does not change
     it. */
  note: string | null;
  created_at: Timestamp;
  /* Maintained by the leave_entitlement_rule_set_updated_at trigger, which
     attaches to the same set_updated_at() every other table uses. */
  updated_at: Timestamp;
}

export interface Database {
  app_user: AppUserTable;
  audit_log: AuditLogTable;
  department: DepartmentTable;
  employee: EmployeeTable;
  leave_entitlement_rule: LeaveEntitlementRuleTable;
  leave_type: LeaveTypeTable;
  leave_type_approval_step: LeaveTypeApprovalStepTable;
  role: RoleTable;
  user_role: UserRoleTable;
  work_pattern: WorkPatternTable;
  work_pattern_day: WorkPatternDayTable;
}
