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

/**
 * The leave year, and what closing one means. §5.4. LMS 205.
 *
 * Every balance is per person, per leave type, per leave year, and this is the
 * third of those. The rules that make "which year is this day in" have exactly one
 * answer are `leave_year_never_overlaps`, an exclusion constraint over the days
 * each year covers, and `leave_year_leaves_no_gap`, a deferred trigger — see the
 * leave-year-rules migration. What a year means is ../domain/leave-year.ts.
 *
 * A closed year is history: the flag never goes back, the dates never move, and
 * the row is never deleted, on any connection. `keep_a_closed_leave_year_closed()`
 * holds all three and stamps `closed_at` on the way past.
 */
export interface LeaveYearTable {
  id: Generated<string>;
  /* What HR calls it. '2026', or '2026/27' for a year running April to March —
     which is why it is a column rather than derived from start_date. */
  label: string;
  /* The first and last day the year covers, inclusive both ends. `YYYY-MM-DD`,
     never an instant: a year begins on a day. NFR DAT 03. */
  start_date: string;
  end_date: string;
  /* Settled. The one column this story is about, and the one that never goes
     back. There is no reopen anywhere in the tree. */
  is_closed: Generated<boolean>;
  /* Stamped by the trigger when the flag is set, so a year closed from a psql
     prompt carries it too. Never supplied by a writer; who closed it is the audit
     log rather than a column. */
  closed_at: ColumnType<Date | null, never, never>;
  created_at: Timestamp;
  /* Maintained by the leave_year_set_updated_at trigger, which attaches to the
     same set_updated_at() every other table uses. */
  updated_at: Timestamp;
}

/**
 * The gazetted public holiday calendar. FR 22, §5.4. LMS 206.
 *
 * One row per day the office was closed, and `holiday_one_per_day` makes that
 * literal: the question is "was the office closed on this day", which has one
 * answer, and a day carrying two rows would be subtracted twice by whatever
 * counts it. What a holiday is and how a stretch of days is read against them is
 * ../domain/holiday.ts.
 *
 * There is no `leave_year_id`. Which year a holiday falls in is the containment
 * search `leave_year` already answers for every other day, and a column holding
 * the answer would go wrong the morning somebody moves the company to an April
 * start — the holiday does not move, the year around it does.
 *
 * It is the second table in the configuration half of the schema `lms_app` may
 * delete from. Nothing is filed under a holiday: a request stores the days it
 * cost, worked out against the calendar of the day it was counted. What a settled
 * leave year keeps is held by `refuse_a_holiday_in_a_settled_year()` instead —
 * see the public-holiday-calendar migration.
 */
export interface HolidayTable {
  id: Generated<string>;
  /* What the gazette calls it. Not a code, and deliberately not one: nothing
     refers to a holiday, so a code would be a handle with no holder and the first
     thing somebody would branch on. */
  name: string;
  /* The day the office was closed. `YYYY-MM-DD`, never an instant: a holiday is a
     day, and a moment would carry a zone that moves it across midnight.
     NFR DAT 03. */
  holiday_date: string;
  created_at: Timestamp;
  /* Maintained by the holiday_set_updated_at trigger, which attaches to the same
     set_updated_at() every other table uses. */
  updated_at: Timestamp;
}

/**
 * The balance ledger. FR 27, §5.7, design principle 1. LMS 210.
 *
 * One row per movement in one balance, and the only way days may move at all. The
 * cached total of §5.7 is LMS 211 and is rebuilt from these rows; if the two ever
 * disagree, this wins. What an entry means is ../domain/ledger.ts.
 *
 * Append only, on every connection. `lms_app` holds SELECT and INSERT and nothing
 * else, and `refuse_update()` and `refuse_delete()` — the audit log's, reused — say
 * so to the owner too. A mistake is put right by a compensating ADJUSTMENT carrying
 * `corrects_id`, never by an edit.
 *
 * `created_by`, `created_by_employee_id` and `created_at` are stamped by
 * `stamp_the_writer_on_a_ledger_entry()` from the settings ../repositories/recording.ts
 * sets, and are *overwritten* rather than defaulted: no writer may post an entry
 * under another name or date one into a settled year.
 */
export interface LeaveLedgerEntryTable {
  id: Generated<string>;
  /* The three columns a balance is keyed by, and real foreign keys — unlike
     `audit_log.actor_employee_id`. There an id is a handle for a join somebody may
     choose to make; here it is the filing, and days that moved in nobody's balance
     are days no balance can be rebuilt from. */
  employee_id: string;
  leave_type_id: string;
  leave_year_id: string;
  /* One of the eight of §5.7, held closed by leave_ledger_entry_type_known. The
     domain's LEDGER_ENTRY_TYPES is the same list; the integration suite asserts the
     two agree. */
  entry_type: string;
  /**
   * How many days, signed. Positive adds to what somebody is owed, negative
   * consumes it, and which way each type goes is a CHECK rather than a convention.
   *
   * Typed `string`, because that is what the driver returns for `numeric` and
   * changing it globally would turn every future decimal into a double silently.
   * `Number(row.days)` happens once, in ../repositories/ledger-repository.ts, where
   * it is visible. Adding two of these as strings concatenates them, which is
   * exactly the bug this type makes impossible to write by accident.
   *
   * It is the one fractional column in this schema. §8.6d pro rates a mid year
   * joiner to 10.08 days, and "FR 24 governs how leave is requested, not how
   * entitlement is held" — so the four request-shaped entry types are held to whole
   * days by `leave_ledger_entry_requests_move_whole_days` and the four entitlement
   * ones are not. See unit/migrations.test.ts, which permits this column by name.
   *
   * **Summing these in JavaScript is not how a balance is computed.** Postgres adds
   * `numeric` exactly and doubles do not, and a RESERVATION and the DEDUCTION that
   * follows it are not two consumptions of the same days. LMS 211.
   */
  days: string;
  /* FR 27. Mandatory, not blank, no default anywhere: a reason that can be omitted
     is omitted by the writer with the most to explain. */
  reason: string;
  /* The entry this one puts right. Only an ADJUSTMENT may carry one, and it must be
     in the same balance — `refuse_a_correction_across_balances()`. */
  corrects_id: string | null;
  /* The request that caused this movement. LMS 301, and the column the
     immutable-leave-ledger migration refused to add until there was a table to put
     behind it.

     Null for everything that moves what somebody is *owed* — a grant, a carry
     forward, an adjustment, an expiry, a lapse — and required of the four that move
     what they have *asked for*. That is an equivalence rather than a requirement:
     `leave_ledger_entry_request_movements_name_a_request` refuses a reservation
     without one and a grant with one, and the second half is the one that catches a
     method copied from `reserve`. */
  leave_request_id: string | null;
  /* Who, in the two forms audit_log keeps them: the id to join on, the description
     to read when the id belongs to nobody. A year rollover has no person behind it.
     Both stamped by the trigger, never by the writer. */
  created_by: ColumnType<string, never, never>;
  created_by_employee_id: ColumnType<string | null, never, never>;
  /* When, stamped by the same trigger rather than defaulted — a default applies
     only when a writer says nothing, and a balance rebuilt in date order can be
     rewritten by an entry dated backwards without any existing row changing. */
  created_at: Timestamp;
}

/**
 * The cached balance. §5.7, design principle 1. LMS 211.
 *
 * One row per employee, leave type and leave year — `leave_balance_one_per_year`
 * makes that literal — holding the five figures of §5.7 so that "what have I got
 * left" is a single-row read rather than a walk of somebody's whole history.
 *
 * **Every column is `never` for insert and update, and that is the table's whole
 * shape said in the type system.** Nothing above the database writes here. The
 * figures are recomputed from `leave_ledger_entry` by
 * `rebuild_one_balance_from_the_ledger()`, in the transaction of the entry that
 * caused them, and `refuse_a_balance_written_by_hand()` says the same thing to
 * every other connection. `lms_app` holds SELECT and had its INSERT revoked — the
 * one table in this schema to give the default privileges back.
 *
 * So `db.insertInto('leave_balance')` does not compile, and would not be permitted
 * if it did. Moving a balance is posting a ledger entry; there is no second way.
 *
 * Available is `entitled + carried_over + adjustment − taken − pending` and is
 * deliberately not a column. It is a subtraction rather than a sixth fact, it lives
 * in ../domain/balance.ts, and §8.6b lets it go negative for sick leave on purpose.
 */
export interface LeaveBalanceTable {
  id: ColumnType<string, never, never>;
  employee_id: ColumnType<string, never, never>;
  leave_type_id: ColumnType<string, never, never>;
  leave_year_id: ColumnType<string, never, never>;
  /**
   * What the year granted, what survived last year end less what has lapsed, and
   * what HR moved by hand. `numeric`, and typed `string` for the reason
   * `leave_ledger_entry.days` is: that is what the driver returns, and `'20.00' +
   * '5.00'` is `'20.005.00'`. ../repositories/balance-repository.ts is the one
   * place they become numbers.
   *
   * Fractional because §8.6d pro rates a mid year joiner to 10.08 days. What
   * somebody is owed may carry a fraction; what they have taken may not.
   */
  entitled: ColumnType<string, never, never>;
  carried_over: ColumnType<string, never, never>;
  adjustment: ColumnType<string, never, never>;
  /**
   * Days consumed by approved leave, and days held for leave not yet decided.
   * Positive counts of movements the ledger records as negative.
   *
   * `integer` rather than `numeric`, and the difference from the three above is FR
   * 24: these are sums of the four request-shaped entry types, which
   * `leave_ledger_entry_requests_move_whole_days` holds to whole days. LMS 209's
   * rule, drawn between two columns where it can be read.
   */
  taken: ColumnType<number, never, never>;
  pending: ColumnType<number, never, never>;
  created_at: Timestamp;
  /* Maintained by the leave_balance_set_updated_at trigger. "When did this figure
     last move" is the first question asked of a balance somebody disputes. */
  updated_at: Timestamp;
}

/**
 * Every balance where the cache and the ledger do not say the same thing. §7.4.
 * LMS 213.
 *
 * A view, not a table, and that is the third acceptance criterion in the type system:
 * a reconciliation that reports rather than silently corrects has nothing to write to.
 * Every column is `never` for insert and update because there is no row here to write
 * — each one is a comparison, computed when it is asked for.
 *
 * The comparison itself is `what_the_ledger_says`, which is §5.7's projection lifted
 * out of `rebuild_one_balance_from_the_ledger()` so that the writer and the checker
 * read one definition. See the nightly-balance-reconciliation migration.
 *
 * **The two sides are not the same type, and the view does not pretend otherwise.**
 * `cached_taken` is the `integer` column `leave_balance` declares; `ledger_taken` is a
 * `numeric` sum. ../repositories/reconciliation-repository.ts turns both into numbers
 * in one place, which is where every other `numeric` in this schema becomes one.
 */
export interface BalanceDisagreementView {
  employee_id: ColumnType<string, never, never>;
  /* The handle a person acts on. FR 08's imports and FR 63's reports use it, and an
     alert naming three bigints is one somebody has to go and look up first. The
     employee's *name* is deliberately absent: an alert may sit in a mailbox or be
     forwarded, and it needs no staff details it does not use. */
  employee_number: ColumnType<string, never, never>;
  leave_type_id: ColumnType<string, never, never>;
  leave_type_name: ColumnType<string, never, never>;
  leave_year_id: ColumnType<string, never, never>;
  leave_year_label: ColumnType<string, never, never>;
  /* False where the ledger has movements and no balance row exists at all — the fault
     a join from `leave_balance` could never find, and the one that shows every screen
     nought days. Told apart from a genuine row of noughts, which reads the same. */
  has_cached_row: ColumnType<boolean, never, never>;
  cached_entitled: ColumnType<string, never, never>;
  ledger_entitled: ColumnType<string, never, never>;
  cached_carried_over: ColumnType<string, never, never>;
  ledger_carried_over: ColumnType<string, never, never>;
  cached_adjustment: ColumnType<string, never, never>;
  ledger_adjustment: ColumnType<string, never, never>;
  cached_taken: ColumnType<number, never, never>;
  ledger_taken: ColumnType<string, never, never>;
  cached_pending: ColumnType<number, never, never>;
  ledger_pending: ColumnType<string, never, never>;
}

/**
 * What the ledger says every balance is. §5.7's projection, as a view. LMS 213.
 *
 * Read here only to count how many balances a reconciliation compared. The figures
 * themselves are read through {@link BalanceDisagreementView}, which is this beside
 * the cache with the rows that agree left out.
 */
export interface WhatTheLedgerSaysView {
  employee_id: ColumnType<string, never, never>;
  leave_type_id: ColumnType<string, never, never>;
  leave_year_id: ColumnType<string, never, never>;
  entitled: ColumnType<string, never, never>;
  carried_over: ColumnType<string, never, never>;
  adjustment: ColumnType<string, never, never>;
  taken: ColumnType<string, never, never>;
  pending: ColumnType<string, never, never>;
}

/**
 * Something that happened, and the entitlement it brought with it. FR 32g, FR 32e.
 * LMS 218.
 *
 * The record a grant is made *against*, and the reason it is a table rather than two
 * columns on `leave_ledger_entry`: when a birth happened is not a fact about a
 * movement in a balance, and `created_at` on the grant is the day somebody typed it
 * rather than the day the child was born.
 *
 * **Only `note` and `lapsed_entry_id` may be updated.** The three facts the grant was
 * calculated from — who, what kind, when — and the deadline it was made under are held
 * by `refuse_rewriting_an_entitlement_event()`, for the owner connection as well. A
 * birth recorded against the wrong person is put right by a compensating ADJUSTMENT on
 * each balance, never by an edit. Nothing is deleted at all.
 */
export interface LeaveEntitlementEventTable {
  id: Generated<string>;
  /* The same three a balance is keyed by, so an event and the movement it caused are
     filed identically. `leave_year_id` is held to the year covering `occurred_on` by
     `refuse_an_event_outside_its_leave_year()`. */
  employee_id: ColumnType<string, string, never>;
  leave_type_id: ColumnType<string, string, never>;
  leave_year_id: ColumnType<string, string, never>;
  /* The day it happened, which is not the day it was recorded: FR 18 lets an absence
     be entered a week late and a birth reaches HR later than that, so six months from
     `created_at` would be six months from the wrong day. */
  occurred_on: ColumnType<string, string, never>;
  /* FR 32e. Null where this type's grant never runs out, which is every event type but
     paternity today. Stored rather than derived, so that changing
     `leave_type.entitlement_expiry_months` cannot move a deadline already given. */
  expires_on: ColumnType<string | null, string | null, never>;
  note: string | null;
  /* §8.6aa and the story's first criterion, as a foreign key. Unique: one grant, one
     event. Written in the same transaction as the entry it names. */
  granted_entry_id: ColumnType<string, string, never>;
  /* The LAPSE that closed it off, and the whole of the expiry job's idempotency: a row
     with this set is done. The one column above that an UPDATE may touch. */
  lapsed_entry_id: string | null;
  created_at: Timestamp;
  /* Maintained by the leave_entitlement_event_set_updated_at trigger. */
  updated_at: ColumnType<Date, never, never>;
}

/**
 * A period of leave somebody has asked for. FR 10, FR 11, §8. LMS 301.
 *
 * The first table whose rows are written by the subject of the record rather than
 * about them, and the first that both points at the ledger and is pointed at by it —
 * `leave_ledger_entry.leave_request_id` is the filing, and there is deliberately no
 * column here pointing back. Two NOT NULL keys between two tables is a pair neither
 * row can be written first.
 *
 * **`counting_basis`, `days` and `calendar_days` are a copy, and the copy is the
 * point.** FR 11: an HR Administrator may change a leave type's counting basis, and a
 * request that read it fresh would restate what it cost every time somebody looked at
 * it. `refuse_rewriting_what_a_request_cost()` holds all three, and the two dates, and
 * who and what kind, on every connection — so the only editable columns are `reason`,
 * which explains rather than decides, and `status`, which the approval story moves.
 *
 * `submitted_at` is stamped by a trigger rather than defaulted, for the reason the
 * ledger stamps its writer: FR 17 counts notice from it and FR 18 judges backdating
 * against it, so it is not a figure the writer supplies.
 */
export interface LeaveRequestTable {
  id: Generated<string>;
  /* The same three a balance is keyed by, so a request and the movements it causes are
     filed identically. `leave_year_id` is held to a year covering the whole period by
     `refuse_a_request_outside_its_leave_year()`, which is what refuses leave running
     over a year end rather than splitting it. */
  employee_id: ColumnType<string, string, never>;
  leave_type_id: ColumnType<string, string, never>;
  leave_year_id: ColumnType<string, string, never>;
  /* Inclusive at both ends: away from the twenty first to the thirty first means both
     of those days. `date`, so no zone can move one across midnight. NFR DAT 03. */
  start_date: ColumnType<string, string, never>;
  end_date: ColumnType<string, string, never>;
  /* FR 10. Mandatory, unlike an entitlement event's note — a manager is being asked to
     agree to something. The one field of substance that may be edited afterwards. */
  reason: string;
  /* FR 11, the story's third criterion. WORKING_DAYS | CALENDAR_DAYS, held closed by
     leave_request_counting_basis_known; the domain's COUNTING_BASES is the same list
     and the integration suite asserts the two agree.

     Read this rather than the leave type's when rendering a request. They agree today
     and the whole reason the column exists is the day they do not. */
  counting_basis: ColumnType<string, string, never>;
  /* What it cost, and what the RESERVATION took. `integer` rather than the ledger's
     `numeric`, which is FR 24 in the type system: leave is requested in whole days,
     and the ledger's fractions are entitlement rather than requests. */
  days: ColumnType<number, number, never>;
  /* The span, counted or not, held equal to the two dates by
     leave_request_spans_its_own_dates. Stored rather than derived because it is the
     other half of the sentence a person reads. */
  calendar_days: ColumnType<number, number, never>;
  /* SUBMITTED, APPROVED, WITHDRAWN, CANCELLED or REFUSED, held closed by
     leave_request_status_known; the domain's REQUEST_STATUSES is the same list and the
     integration suite asserts the two agree. Moved only by
     LeaveRequestRepository.moveTo(), and only where TRANSITIONS holds the move. */
  status: string;
  /* FR 38a, FR 40. The desk in the type's approval chain this request is waiting on —
     MANAGER, HR or CEO — or null once it is waiting on nobody. LMS 314.

     Where a request has got to is two facts and this is the second: the status says
     whether it is still being decided, this says who is deciding it. Not null exactly
     while the status is SUBMITTED, which leave_request_waits_at_a_desk holds as an
     equivalence, so a request that has been approved or has ended sits in nobody's
     queue. */
  awaiting_approval_from: string | null;
  /* Stamped by leave_request_says_when_it_was_submitted, never supplied. */
  submitted_at: Timestamp;
  created_at: Timestamp;
  /* Maintained by the leave_request_set_updated_at trigger. */
  updated_at: Timestamp;
}

export interface Database {
  app_user: AppUserTable;
  audit_log: AuditLogTable;
  balances_that_disagree_with_the_ledger: BalanceDisagreementView;
  department: DepartmentTable;
  employee: EmployeeTable;
  holiday: HolidayTable;
  leave_balance: LeaveBalanceTable;
  leave_entitlement_event: LeaveEntitlementEventTable;
  leave_entitlement_rule: LeaveEntitlementRuleTable;
  leave_ledger_entry: LeaveLedgerEntryTable;
  leave_request: LeaveRequestTable;
  leave_type: LeaveTypeTable;
  leave_type_approval_step: LeaveTypeApprovalStepTable;
  leave_year: LeaveYearTable;
  role: RoleTable;
  user_role: UserRoleTable;
  what_the_ledger_says: WhatTheLedgerSaysView;
  work_pattern: WorkPatternTable;
  work_pattern_day: WorkPatternDayTable;
}
