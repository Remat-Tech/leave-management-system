/** The tables, as TypeScript sees them. NFR DAT 03. */

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
  department_id: string;
  /** FR 02. */
  manager_id: string | null;
  /** FR 23. */
  work_pattern_id: string;
  start_date: string;
  exit_date: string | null;
  employment_type: Generated<string>;
  employment_status: Generated<string>;
  gender: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DepartmentTable {
  id: Generated<string>;
  name: string;
  parent_id: string | null;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WorkPatternTable {
  id: Generated<string>;
  name: string;
  is_default: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Which days of the week a pattern works. FR 23. */
export interface WorkPatternDayTable {
  work_pattern_id: string;
  day_of_week: number;
  is_working_day: Generated<boolean>;
}

/** A leave type and the rules it carries. FR 21, FR 31, FR 32, §5.5., LMS 201, FR 38a. */
export interface LeaveTypeTable {
  id: Generated<string>;
  code: string;
  name: string;
  description: string | null;
  /** FR 21 and FR 22. */
  counting_basis: string;
  /** FR 32g. */
  entitlement_basis: string;
  /** FALSE for unpaid leave and the unpaid maternity extension. FR 63. */
  is_paid: Generated<boolean>;
  /** DAYS | WEEKS | MONTHS. FR 24. */
  unit: Generated<string>;
  /** FR 13. */
  documentation: Generated<string>;
  documentation_after_days: number | null;
  /** FR 32a. */
  exceedable_with_document: Generated<boolean>;
  /** FR 32e. */
  entitlement_expiry_months: number | null;
  /** §8.6aa. */
  may_be_split: Generated<boolean>;
  /** FR 17. */
  min_notice_calendar_days: Generated<number>;
  /** FR 18. */
  max_backdate_calendar_days: Generated<number>;
  /** FR 05. */
  gender_restriction: string | null;
  /** FR 33. */
  deducts_from_annual: ColumnType<boolean, never, never>;
  /**
   * §7.4 orders the balance read by it, so the order a form lists types in is a decision rather than an alphabetical accident.
   */
  display_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Who approves a kind of leave, and in what order. FR 38a, §5.5., LMS 204. */
export interface LeaveTypeApprovalStepTable {
  leave_type_id: string;
  step_order: number;
  approver_role: string;
}

/** The sign in account. NFR SEC 01, LMS 109. */
export interface AppUserTable {
  id: Generated<string>;
  employee_id: string;
  company_email: string;
  password_hash: string | null;
  /** LMS 110. */
  mfa_enabled: Generated<boolean>;
  mfa_code_hash: string | null;
  mfa_code_expires_at: Date | null;
  mfa_code_attempts: Generated<number>;
  is_active: Generated<boolean>;
  last_login_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The roles somebody can hold. */
export interface RoleTable {
  id: Generated<string>;
  code: string;
  name: string;
}

/** Who holds which. LMS 110, LMS 111. */
export interface UserRoleTable {
  user_id: string;
  role_id: string;
  /** When it was granted. LMS 111, LMS 112, LMS 113. */
  granted_at: Generated<Date>;
}

/** The audit log. NFR AUD 01, NFR AUD 02, LMS 113. */
export interface AuditLogTable {
  id: Generated<string>;
  occurred_at: Timestamp;
  action: ColumnType<string, never, never>;
  entity: ColumnType<string, never, never>;
  entity_id: ColumnType<string, never, never>;
  before: ColumnType<Record<string, unknown> | null, never, never>;
  after: ColumnType<Record<string, unknown> | null, never, never>;
  actor: ColumnType<string, never, never>;
  actor_employee_id: ColumnType<string | null, never, never>;
}

/** What a leave type is worth, and from when. FR 31, §5.5., LMS 203. */
export interface LeaveEntitlementRuleTable {
  id: Generated<string>;
  leave_type_id: string;
  employee_id: string | null;
  department_id: string | null;
  /** Whole days, FR 24. */
  entitlement_days: number;
  /** FR 29. */
  prorate_on_join: Generated<boolean>;
  /** FR 36. */
  carries_over: Generated<boolean>;
  /** FR 36a. */
  carryover_max_days: number | null;
  carryover_expiry_month: number | null;
  /** Inclusive both ends. NFR DAT 03. */
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The leave year, and what closing one means. §5.4., LMS 205. */
export interface LeaveYearTable {
  id: Generated<string>;
  label: string;
  /** The first and last day the year covers, inclusive both ends. NFR DAT 03. */
  start_date: string;
  end_date: string;
  is_closed: Generated<boolean>;
  closed_at: ColumnType<Date | null, never, never>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The gazetted public holiday calendar. FR 22, §5.4., LMS 206. */
export interface HolidayTable {
  id: Generated<string>;
  name: string;
  /** The day the office was closed. NFR DAT 03. */
  holiday_date: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** The balance ledger. FR 27, §5.7, LMS 210, LMS 211. */
export interface LeaveLedgerEntryTable {
  id: Generated<string>;
  employee_id: string;
  leave_type_id: string;
  leave_year_id: string;
  /** One of the eight of §5.7, held closed by leave_ledger_entry_type_known. */
  entry_type: string;
  /** How many days, signed. §8.6, FR 24, LMS 211. */
  days: string;
  /** FR 27. */
  reason: string;
  corrects_id: string | null;
  /** The request that caused this movement. LMS 301. */
  leave_request_id: string | null;
  created_by: ColumnType<string, never, never>;
  created_by_employee_id: ColumnType<string | null, never, never>;
  created_at: Timestamp;
}

/** The cached balance. §5.7, LMS 211, §8.6. */
export interface LeaveBalanceTable {
  id: ColumnType<string, never, never>;
  employee_id: ColumnType<string, never, never>;
  leave_type_id: ColumnType<string, never, never>;
  leave_year_id: ColumnType<string, never, never>;
  /**
   * What the year granted, what survived last year end less what has lapsed, and what HR moved by hand. §8.6.
   */
  entitled: ColumnType<string, never, never>;
  carried_over: ColumnType<string, never, never>;
  adjustment: ColumnType<string, never, never>;
  /** Days consumed by approved leave, and days held for leave not yet decided. FR 24, LMS 209. */
  taken: ColumnType<number, never, never>;
  pending: ColumnType<number, never, never>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Every balance where the cache and the ledger do not say the same thing. §7.4., LMS 213, §5.7. */
export interface BalanceDisagreementView {
  employee_id: ColumnType<string, never, never>;
  /** The handle a person acts on. FR 08, FR 63. */
  employee_number: ColumnType<string, never, never>;
  leave_type_id: ColumnType<string, never, never>;
  leave_type_name: ColumnType<string, never, never>;
  leave_year_id: ColumnType<string, never, never>;
  leave_year_label: ColumnType<string, never, never>;
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

/** What the ledger says every balance is. §5.7, LMS 213. */
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

/** Something that happened, and the entitlement it brought with it. FR 32g, FR 32e, LMS 218. */
export interface LeaveEntitlementEventTable {
  id: Generated<string>;
  employee_id: ColumnType<string, string, never>;
  leave_type_id: ColumnType<string, string, never>;
  leave_year_id: ColumnType<string, string, never>;
  /**
   * The day it happened, which is not the day it was recorded: FR 18 lets an absence be entered a week late and a birth reaches HR later than that, so…
   */
  occurred_on: ColumnType<string, string, never>;
  /** FR 32e. */
  expires_on: ColumnType<string | null, string | null, never>;
  note: string | null;
  /** §8.6aa and the story's first criterion, as a foreign key. */
  granted_entry_id: ColumnType<string, string, never>;
  lapsed_entry_id: string | null;
  created_at: Timestamp;
  updated_at: ColumnType<Date, never, never>;
}

/** A period of leave somebody has asked for. FR 10, FR 11, §8., LMS 301, FR 17, FR 18. */
export interface LeaveRequestTable {
  id: Generated<string>;
  employee_id: ColumnType<string, string, never>;
  leave_type_id: ColumnType<string, string, never>;
  leave_year_id: ColumnType<string, string, never>;
  /**
   * Inclusive at both ends: away from the twenty first to the thirty first means both of those days. NFR DAT 03.
   */
  start_date: ColumnType<string, string, never>;
  end_date: ColumnType<string, string, never>;
  /** FR 10. */
  reason: string;
  /** FR 11, the story's third criterion. */
  counting_basis: ColumnType<string, string, never>;
  /** What it cost, and what the RESERVATION took. FR 24. */
  days: ColumnType<number, number, never>;
  calendar_days: ColumnType<number, number, never>;
  status: string;
  /** FR 38a, FR 40. */
  awaiting_approval_from: string | null;
  submitted_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** What one approver said at one stage, and when. FR 39, FR 52, LMS 315, LMS 314. */
export interface LeaveRequestDecisionTable {
  id: Generated<string>;
  leave_request_id: ColumnType<string, string, never>;
  action: ColumnType<string, string, never>;
  /** FR 52. */
  on_behalf_of: ColumnType<string, string, never>;
  /** FR 39. */
  comment: ColumnType<string | null, string | null, never>;
  /** The decision this one reverses. FR 44, §7.2, LMS 318. */
  overrides_decision_id: ColumnType<string | null, string | null, never>;
  decided_by: ColumnType<string, never, never>;
  decided_by_employee_id: ColumnType<string | null, never, never>;
  decided_at: Timestamp;
}

/** One stage of a request's chain that another desk answered. FR 48b, §8.6a, LMS 320. */
export interface LeaveRequestRoutingTable {
  id: Generated<string>;
  leave_request_id: ColumnType<string, string, never>;
  /** The desk the type's chain names at this stage. */
  stage: ColumnType<string, string, never>;
  /** The desk that answered it instead. */
  routed_to: ColumnType<string, string, never>;
  /** NFR USA 03. */
  because: ColumnType<string, string, never>;
  recorded_by: ColumnType<string, never, never>;
  recorded_by_employee_id: ColumnType<string | null, never, never>;
  recorded_at: Timestamp;
}

/** One thing somebody was told about their leave. FR 59, §7.1., LMS 329. */
export interface NotificationTable {
  id: Generated<string>;
  /** Who was told. FR 59, FR 60. */
  employee_id: ColumnType<string, string, never>;
  /** What it is about. FR 59. */
  leave_request_id: ColumnType<string, string, never>;
  event: ColumnType<string, string, never>;
  subject: ColumnType<string, string, never>;
  body: ColumnType<string, string, never>;
  read_at: ColumnType<Date | null, never, Date | null>;
  emailed_at: ColumnType<Date | null, never, Date | null>;
  email_failure: ColumnType<string | null, never, string | null>;
  created_at: Generated<Date>;
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
  leave_request_decision: LeaveRequestDecisionTable;
  leave_request_routing: LeaveRequestRoutingTable;
  leave_type: LeaveTypeTable;
  leave_type_approval_step: LeaveTypeApprovalStepTable;
  leave_year: LeaveYearTable;
  notification: NotificationTable;
  role: RoleTable;
  user_role: UserRoleTable;
  what_the_ledger_says: WhatTheLedgerSaysView;
  work_pattern: WorkPatternTable;
  work_pattern_day: WorkPatternDayTable;
}
