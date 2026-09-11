/** The one place this application talks to the server. LMS 401. */

/** A leave year, as the picker and the heading show it. */
export interface Year {
  id: string;
  label: string;
  /** Ten characters. */
  startDate: string;
  endDate: string;
  isClosed: boolean;
}

/** One leave type's figures, with everything needed to render them beside them. */
export interface BalanceLine {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  /** FR 22. */
  countingBasisLabel: string;
  entitlementBasis: 'QUOTA' | 'EVENT';
  /** What the figures on this line are, so a nought says which kind of nought. */
  allowanceInWords: string;
  unit: 'DAYS' | 'WEEKS' | 'MONTHS';
  isPaid: boolean;
  stillOffered: boolean;

  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  /** `entitled + carriedOver + adjustment`, computed on the server. */
  owed: number;
  /** May be negative. §8.6. */
  available: number;

  hasMoved: boolean;
  /** An instant, ISO 8601, or null where nothing has ever moved this balance. */
  updatedAt: string | null;
}

export interface Statement {
  employeeId: string;
  year: Year;
  years: Year[];
  lines: BalanceLine[];
}

/** ------------------------------------------------ my request history. FR 54, LMS 402. */

/** A desk in an approval chain — not a role somebody holds. */
export type Desk = 'MANAGER' | 'HR' | 'CEO';

/** Where a request has got to. §6., FR 48b. */
export type RequestStatus =
  | 'SUBMITTED'
  | 'APPROVED'
  /** Nobody could be found to decide it. FR 48b, LMS 320. */
  | 'UNROUTABLE'
  | 'WITHDRAWN'
  | 'CANCELLED'
  | 'REFUSED';

/** What kind of thing one step of a trail is. */
export type TrailStepKind =
  | 'ASKED'
  | 'DECIDED'
  /** A decision that reversed the manager's. FR 44, LMS 318. */
  | 'OVERTURNED'
  | 'ENDED'
  /** An ask for agreed leave to come off the books, or HR's answer. FR 47, LMS 324. */
  | 'WITHDRAWAL'
  | 'STILL_TO_ASK';

/** One thing that happened to a request, or one thing that has not happened yet. */
export interface TrailStep {
  kind: TrailStepKind;
  /** The desk this step belongs to, where it belongs to one. */
  desk: Desk | null;
  /** Whether the step said yes. Null on every step that is not a decision. LMS 409. */
  agreed: boolean | null;
  /** FR 39. */
  comment: string | null;
  /** Who, in words, where a record names somebody. */
  by: string | null;
  /** An instant, ISO 8601 — or null for a step that has not happened. */
  at: string | null;
  /** The step in one sentence, written by the server. */
  inWords: string;
}

/** One past request, with what became of it. */
export interface RequestEntry {
  requestId: string;
  leaveTypeId: string;
  typeName: string;
  leaveYearId: string;
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 10. Null where the type asks for none. */
  reason: string | null;
  /** FR 18. Why HR put it on the record past the backdating window. Null on everything else. */
  lateEntryReason: string | null;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  /** FR 11, FR 24. */
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** The story's first criterion, in a word a person says. */
  statusInWords: string;
  submittedAt: string;

  /** FR 41. */
  agreed: boolean;
  /** The desk it is sitting on, or null once it is sitting nowhere. */
  awaiting: Desk | null;
  chain: Desk[];
  approvedBy: Desk[];
  stillToApprove: Desk[];
  /** Stages of today's chain with no approval on this request. */
  stagesMissing: Desk[];
  /** FR 41. */
  progressInWords: string;

  /** The story's second criterion. */
  trail: TrailStep[];
}

export interface History {
  employeeId: string;
  /** The year being shown, or null for every request there is. */
  year: Year | null;
  /** The years this person has asked for leave in. */
  years: Year[];
  entries: RequestEntry[];
}

/** ---------------------------------------------------- the request form. LMS 403. */

/**
 * What kind of thing one rule is.
 *
 * A token rather than a sentence, so the screen can group and order them without reading
 * the words. What each one *says* is composed on the server — see
 * `server/src/features/leave-request/request-form.ts`, which argues why the wording of a
 * leave rule is not a browser's to invent.
 */
export type FormRuleKind =
  | 'DESCRIPTION'
  | 'DOCUMENTATION'
  | 'EVIDENCE_IF_EXCEEDED'
  | 'NOTICE'
  | 'BACKDATING'
  | 'REASON'
  | 'ENTITLEMENT'
  | 'COUNTING'
  | 'APPROVAL';

/** One thing a kind of leave says about itself. */
export interface FormRule {
  kind: FormRuleKind;
  inWords: string;
  /** Whether it asks something of the person, rather than only explaining how the leave works. */
  asks: boolean;
}

/** A kind of leave this person may ask for, with what it asks of them. FR 05, FR 13, FR 17. */
export interface RequestableLeaveType {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  isPaid: boolean;
  /** FR 17, FR 18. Numbers, because a date input needs a number and not a sentence. */
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  /** FR 13, FR 32a. */
  documentation: 'NOT_REQUIRED' | 'ALWAYS' | 'AFTER_DAYS';
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  /** FR 10. Whether the reason box is required for this kind of leave. */
  reasonRequired: boolean;
  /** FR 38a. "your manager, then HR". */
  approvedBy: string;
  rules: FormRule[];
}

export interface RequestForm {
  employeeId: string;
  /** In the order §7.4 puts them, which is the order the balance screen uses too. */
  types: RequestableLeaveType[];
}

/** Why a day inside a period cost nothing. */
export type FreeReason = 'NOT_A_WORKING_DAY' | 'PUBLIC_HOLIDAY';

/** One day inside the period that cost nothing. */
export interface FreeDay {
  /** Ten characters. */
  date: string;
  because: FreeReason;
  /** The holiday's name, where that is the reason. */
  name: string | null;
  /** The whole thing in a sentence, written by the server. */
  inWords: string;
}

/** FR 13, FR 17, FR 14. Worth saying before somebody submits, and not a refusal. */
export type QuoteWarningCode = 'SHORT_NOTICE' | 'DOCUMENTATION_REQUIRED' | 'NOT_ENOUGH_DAYS';

export interface QuoteWarning {
  code: QuoteWarningCode;
  message: string;
}

/** What a period would cost, before anything is written. FR 10, FR 11. */
export interface Quote {
  leaveTypeId: string;
  leaveTypeName: string;
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 11. The basis this was counted under, and what submitting would copy onto it. */
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisInWords: string;
  /** FR 24. The story's first criterion. */
  days: number;
  calendarDays: number;
  /** What turns the number into an explanation. */
  free: FreeDay[];
  availableNow: number;
  /** May be negative, legitimately. §8.6b. */
  availableAfter: number;
  /** FR 38a. */
  approvedBy: string;
  warnings: QuoteWarning[];
}

/** What came back from asking. LMS 301. */
export interface Submitted {
  requestId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: string;
  to: string;
  /** FR 10. Null where the type asks for none. */
  reason: string | null;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** FR 13, FR 32a. Whether documentation was asked of it, and so is on it. LMS 311. */
  evidenceRequired: boolean;
  /** FR 32a, §8.6b. How many of its days went past the allowance on that certificate. LMS 312. */
  certifiedDays: number;
  /** FR 38a. The desk it is now sitting on. */
  awaitingApprovalFrom: Desk | null;
  submittedAt: string;
  /** What the reservation left. */
  availableAfter: number;
}

/** ------------------------------------------- everything waiting on me. FR 20, LMS 404. */

/** FR 17, FR 18. Worth pointing out before deciding, and not a refusal. */
export type QueueFlag = 'SHORT_NOTICE' | 'BACKDATED';

export interface QueueWarning {
  code: QueueFlag;
  inWords: string;
}

/** Who asked. FR 52. */
export interface Asker {
  employeeId: string;
  name: string;
  jobTitle: string | null;
}

/** What this request would spend, against what they have. §8.6. */
export interface AskerBalance {
  leaveTypeId: string;
  leaveYearId: string;
  owed: number;
  taken: number;
  /** Days held by requests still being decided — this one among them. */
  pending: number;
  /** What is left, this request's days already out of it. May be negative. §8.6b. */
  available: number;
  inWords: string;
}

/** One other person on the team who is away over the same days. */
export interface TeamAway {
  employeeId: string;
  /** Null where this approver has no standing to be told it. */
  name: string | null;
  /** Ten characters. */
  from: string;
  to: string;
  days: number;
  status: RequestStatus;
  typeName: string;
}

export interface TeamContext {
  /** How many report to the asker's manager, the asker included. */
  size: number;
  away: TeamAway[];
  inWords: string;
}

/** One request waiting on me, with what the decision needs beside it. */
export interface QueueItem {
  requestId: string;
  /**
   * NFR DAT 02, §8.1. What this row was drawn from, sent back with the decision. LMS 326.
   *
   * A screen that hands it back is told its decision lost a race — 409, and the server's own
   * sentence — rather than answering a request somebody else has.
   */
  version: string;
  asker: Asker;
  leaveTypeId: string;
  typeName: string;
  leaveYearId: string;
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 10. Null where the type asks for none. */
  reason: string | null;
  /** FR 18. Why HR put it on the record past the backdating window. Null on everything else. */
  lateEntryReason: string | null;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  /** FR 24. */
  days: number;
  calendarDays: number;
  submittedAt: string;

  /** FR 38a. The desk it is sitting on, which is one of mine. */
  desk: Desk;
  chain: Desk[];
  approvedBy: Desk[];
  stillToApprove: Desk[];
  /** FR 41, written by the server in the approver's voice rather than the requester's. */
  stageInWords: string;

  /** FR 17, FR 18. Numbers as well as sentences, because a screen sorts and colours on them. */
  noticeGivenDays: number;
  shortNoticeBy: number;
  backdatedBy: number;
  /** Calendar days from today to the first day off. Negative once it has started. */
  startsInDays: number;
  warnings: QueueWarning[];

  balance: AskerBalance;
  team: TeamContext;

  /** FR 48, §8.6a. False for my own request, whatever desk it is sitting at. */
  actionable: boolean;
  notActionableBecause: string | null;
}

export interface ApproverQueue {
  approverId: string;
  /** FR 38a. Which desks these came from. */
  desks: Desk[];
  inWords: string;
  /** Soonest to start first. */
  items: QueueItem[];
}

/** ------------------------------------------------- my direct reports. FR 55, FR 56, LMS 405. */

/** FR 06. A leaver still reports to somebody until HR moves the line. */
export type EmploymentStatus = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';

/** One piece of live leave a report holds. FR 56. */
export interface TeamBooking {
  requestId: string;
  leaveTypeId: string;
  typeName: string;
  /** Ten characters. */
  from: string;
  to: string;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  /** FR 11, FR 24. */
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** FR 41. */
  agreed: boolean;
  /** FR 38a. The desk it is sitting on, null once it is sitting nowhere. */
  awaiting: Desk | null;
  inWords: string;
}

/** One direct report. FR 55, FR 56. */
export interface TeamMember {
  employeeId: string;
  name: string;
  jobTitle: string | null;
  employmentStatus: EmploymentStatus;
  /** Days of live leave in the year shown, across every type. */
  daysBooked: number;
  awayToday: boolean;
  inWords: string;
  /** FR 55. The same lines their own balance screen shows. */
  balances: BalanceLine[];
  /** FR 56. Soonest first. */
  booked: TeamBooking[];
}

/** One report away on one day. */
export interface TeamAwayOn {
  employeeId: string;
  name: string;
  requestId: string;
  status: RequestStatus;
  typeName: string;
}

/** One day somebody is away. Days nobody is away are not sent. */
export interface TeamDay {
  /** Ten characters. */
  date: string;
  /** More than one report away — the day a manager is looking for. */
  isClash: boolean;
  isEverybody: boolean;
  away: TeamAwayOn[];
}

export interface TeamCalendar {
  from: string;
  to: string;
  /** The most reports away on any one day. */
  busiest: number;
  clashes: number;
  inWords: string;
  /** Soonest first. */
  days: TeamDay[];
}

export interface Team {
  managerId: string;
  year: Year;
  years: Year[];
  size: number;
  inWords: string;
  /** Surname first. */
  members: TeamMember[];
  calendar: TeamCalendar;
}

/** ------------------------------------------ the team I am on. FR 57, LMS 406. */

/**
 * One absence on the team calendar. FR 57.
 *
 * Dates and how long, and that is the whole of it. There is no leave type here and no reason,
 * because the server sends neither — see `myCalendar`.
 */
export interface Absence {
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 24. Days off the calendar, not days charged. */
  calendarDays: number;
  /** FR 41. */
  agreed: boolean;
  inWords: string;
}

/** A department, as the calendar names one. LMS 409. */
export interface DepartmentOnTheCalendar {
  id: string;
  name: string;
}

/** Somebody on the team calendar. FR 57. */
export interface Colleague {
  employeeId: string;
  name: string;
  jobTitle: string | null;
  /** LMS 409. The heading they sit under where the calendar spans more than one. */
  department: DepartmentOnTheCalendar | null;
  /** FR 06. */
  employmentStatus: EmploymentStatus;
  isMe: boolean;
  /** The reader's own manager, where they are in this department too. */
  isTheManager: boolean;
  awayToday: boolean;
  inWords: string;
  /** Soonest first. */
  absences: Absence[];
}

/** One person away on one day. */
export interface AwayOn {
  employeeId: string;
  name: string;
  agreed: boolean;
  isMe: boolean;
}

/** One day somebody is away. Days nobody is away are not sent. */
export interface AwayDay {
  /** Ten characters. */
  date: string;
  isEverybody: boolean;
  away: AwayOn[];
}

/** Who is away and when, in the department I am in. FR 57, LMS 409. */
export interface TeamAwayCalendar {
  employeeId: string;
  year: Year;
  years: Year[];
  /** LMS 409. The department being shown, or null where every one of them is, at once. */
  department: DepartmentOnTheCalendar | null;
  /** LMS 409. What may be asked for. Only my own, unless I am HR. */
  departments: DepartmentOnTheCalendar[];
  /** LMS 409. Whether the picker is a choice or a label. */
  canChooseDepartment: boolean;
  from: string;
  to: string;
  /** How many the calendar covers, me included. */
  size: number;
  /** The most away on any one day. */
  busiest: number;
  inWords: string;
  awayToday: AwayOn[];
  /** The manager first, then surname. */
  colleagues: Colleague[];
  /** Soonest first. */
  days: AwayDay[];
}

/** ---------------------------------------- requests I have not finished. FR 19, LMS 302. */

/** A field a draft may still be missing, in the order the form asks for them. */
export type DraftField = 'leaveTypeId' | 'from' | 'to' | 'reason';

/** What a draft still needs before it can be asked for. */
export interface DraftProgress {
  finished: boolean;
  missing: DraftField[];
  /** What is left, and that nothing is held yet, in one sentence. */
  inWords: string;
}

/**
 * A leave request started and not finished. FR 19.
 *
 * Every field is nullable, which is the story: somebody plans before the dates are settled.
 * Nothing is held and nobody has been asked until it is submitted.
 */
export interface Draft {
  draftId: string;
  leaveTypeId: string | null;
  /** Ten characters, or null. */
  from: string | null;
  to: string | null;
  reason: string | null;
  progress: DraftProgress;
  createdAt: string;
  /** What the list is ordered by. */
  updatedAt: string;
}

/** What a draft form sends. Any of them may be left out or cleared. */
export interface DraftFields {
  leaveTypeId?: string | null;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
}

/** ------------------------------------ leave types, as HR sets them up. FR 31, FR 32, LMS 501 */

export type CountingBasis = 'WORKING_DAYS' | 'CALENDAR_DAYS';
export type EntitlementBasis = 'QUOTA' | 'EVENT';
export type AllowanceUnit = 'DAYS' | 'WEEKS' | 'MONTHS';
export type DocumentationRule = 'NOT_REQUIRED' | 'ALWAYS' | 'AFTER_DAYS';
/** FR 05. Null is no restriction, which is most types. */
export type GenderRestriction = 'MALE' | 'FEMALE' | null;

/**
 * One value of a closed set, with the words that go beside it.
 *
 * The labels come down the wire rather than being written here, for the reason the server's
 * `countingBasisLabel` gives about itself: the file that defines a basis is the file that
 * decides what it is called, and a second copy in a browser is one that eventually disagrees.
 */
export interface Choice<T> {
  value: T;
  label: string;
  /** FR 22. What the basis costs, in full. Only the counting bases carry one. */
  inWords?: string;
}

/** Every control on the form, and what may go in it. */
export interface LeaveTypeChoices {
  countingBases: Choice<CountingBasis>[];
  entitlementBases: Choice<EntitlementBasis>[];
  units: Choice<AllowanceUnit>[];
  documentationRules: Choice<DocumentationRule>[];
  genderRestrictions: Choice<GenderRestriction>[];
  /** FR 38a. */
  approvers: Choice<Desk>[];
}

/** A leave type as the screen that edits it sees one. FR 31, FR 32. */
export interface ConfiguredLeaveType {
  id: string;
  /** The handle reports and imports join on. Never branched on. */
  code: string;
  name: string;
  description: string | null;

  /** FR 21. */
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  countingBasisInWords: string;

  /** FR 32g. */
  entitlementBasis: EntitlementBasis;
  entitlementBasisLabel: string;

  isPaid: boolean;
  /** FR 24. How the allowance is said, never how it is counted. */
  unit: AllowanceUnit;
  unitLabel: string;

  /** FR 13. */
  documentation: DocumentationRule;
  documentationLabel: string;
  documentationAfterDays: number | null;
  /** FR 32a. Whether going past the allowance asks for evidence rather than refusing. */
  exceedableWithDocument: boolean;
  /** FR 32e. How long an unused grant lasts. Not carry over. */
  entitlementExpiryMonths: number | null;

  mayBeSplit: boolean;
  /** FR 17, FR 18. Calendar days; zero means no window. */
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;

  genderRestriction: GenderRestriction;
  genderRestrictionLabel: string;
  /** FR 10. */
  reasonRequired: boolean;
  /** FR 33. Shown, never set: it is false forever. */
  deductsFromAnnual: boolean;

  /** FR 38a. */
  approvalChain: Desk[];
  /** In the requester's voice: "your manager then HR". What the request form says. */
  approvedBy: string;
  /** The same chain as a configuration screen names it: "Manager then HR". LMS 503. */
  approvedByLabel: string;

  /** §7.4. The order the balance screen and the request form list them in. */
  displayOrder: number;
  /** A retired type is still readable and still heads every report it ever did. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a new type is unless the person says otherwise. FR 32.
 *
 * On the wire rather than written here, because these are the values the server would apply
 * anyway: a create form drawing its controls at its own guesses would show one thing and save
 * another. `countingBasis` and `entitlementBasis` are deliberately absent — they have no
 * default and are refused when missing, so the form makes somebody choose.
 */
export interface LeaveTypeDefaults {
  isPaid: boolean;
  unit: AllowanceUnit;
  documentation: DocumentationRule;
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  entitlementExpiryMonths: number | null;
  mayBeSplit: boolean;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  genderRestriction: GenderRestriction;
  reasonRequired: boolean;
  displayOrder: number;
  approvalChain: Desk[];
}

export interface LeaveTypeSettings {
  types: ConfiguredLeaveType[];
  choices: LeaveTypeChoices;
  defaults: LeaveTypeDefaults;
}

/**
 * What the form sends. FR 31, FR 32.
 *
 * Every field optional, and that is the PATCH: a field left out is unchanged, where a field
 * sent as null is cleared. The two are different instructions all the way down to the UPDATE.
 */
export interface LeaveTypeFields {
  code?: string;
  name?: string;
  description?: string | null;
  countingBasis?: CountingBasis;
  entitlementBasis?: EntitlementBasis;
  isPaid?: boolean;
  unit?: AllowanceUnit;
  documentation?: DocumentationRule;
  documentationAfterDays?: number | null;
  exceedableWithDocument?: boolean;
  entitlementExpiryMonths?: number | null;
  mayBeSplit?: boolean;
  minNoticeCalendarDays?: number;
  maxBackdateCalendarDays?: number;
  genderRestriction?: GenderRestriction;
  reasonRequired?: boolean;
  displayOrder?: number;
  /** FR 38a. Only on a create; changing it afterwards is {@link setApprovalChain}. */
  approvalChain?: Desk[];
}

/**
 * Every type there is, retired ones included, with the vocabulary the form needs.
 *
 * Reading is open to anybody signed in — the person who most needs to know a notice window is
 * the one about to miss it — so this route answers for everybody. Every write below is refused
 * for anybody but an HR Administrator, with the server's own sentence.
 */
export async function leaveTypes(): Promise<LeaveTypeSettings> {
  return request<LeaveTypeSettings>('GET', '/api/leave-types');
}

export async function createLeaveType(fields: LeaveTypeFields): Promise<ConfiguredLeaveType> {
  return request<ConfiguredLeaveType>('POST', '/api/leave-types', fields);
}

/** Changes one. Only what is sent changes. FR 32, FR 33. */
export async function editLeaveType(
  id: string,
  fields: LeaveTypeFields,
): Promise<ConfiguredLeaveType> {
  return request<ConfiguredLeaveType>(
    'PATCH',
    `/api/leave-types/${encodeURIComponent(id)}`,
    fields,
  );
}

/**
 * Says who approves leave of this kind, in order. FR 38a.
 *
 * Its own call rather than a field on the edit, because it is its own table and its own
 * refusals — a chain naming the same desk twice is refused with a sentence about the chain.
 */
export async function setApprovalChain(id: string, chain: Desk[]): Promise<ConfiguredLeaveType> {
  return request<ConfiguredLeaveType>(
    'PUT',
    `/api/leave-types/${encodeURIComponent(id)}/approval-chain`,
    { approvalChain: chain },
  );
}

/** Takes it out of use. There is no delete: the type heads every report it ever headed. */
export async function retireLeaveType(id: string): Promise<ConfiguredLeaveType> {
  return request<ConfiguredLeaveType>('POST', `/api/leave-types/${encodeURIComponent(id)}/retire`);
}

export async function reinstateLeaveType(id: string): Promise<ConfiguredLeaveType> {
  return request<ConfiguredLeaveType>(
    'POST',
    `/api/leave-types/${encodeURIComponent(id)}/reinstate`,
  );
}

/** ------------------------- what a leave type is worth, and from when. FR 31, LMS 502 */

/** How narrowly a rule is aimed, and therefore which one wins. */
export type RuleScope = 'EVERYBODY' | 'DEPARTMENT' | 'EMPLOYEE';

/** One effective dated figure, as the screen that edits it sees one. FR 31. */
export interface EntitlementRule {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;

  scope: RuleScope;
  scopeLabel: string;
  /** Null on anything but a rule aimed at that rung. */
  employeeId: string | null;
  departmentId: string | null;
  /** Who it is for, named, in the server's words. */
  who: string;

  /** FR 24. Whole days. */
  entitlementDays: number;
  prorateOnJoin: boolean;

  carriesOver: boolean;
  carryoverMaxDays: number | null;
  /** 1 to 12, or null where carried days never expire. */
  carryoverExpiryMonth: number | null;
  carryoverInWords: string;

  /** Ten characters. */
  effectiveFrom: string;
  effectiveTo: string | null;
  periodInWords: string;
  note: string | null;

  /**
   * FR 31. Whether it is still a draft, and the sentence saying why not.
   *
   * The whole of the story's second criterion: a rule that has taken effect is history and
   * the next figure is another rule, from a later date. The refusal is the server's — this
   * only decides which button is greyed.
   */
  mayBeChanged: boolean;
  fixedReason: string | null;
  inForce: boolean;
  inWords: string;

  createdAt: string;
  updatedAt: string;
}

export interface RuleLeaveType {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface RuleDepartment {
  id: string;
  name: string;
}

export interface RulePerson {
  id: string;
  name: string;
  departmentId: string;
}

/** What a new rule is unless the person says otherwise. On the wire, as LMS 501's are. */
export interface EntitlementRuleDefaults {
  entitlementDays: number;
  prorateOnJoin: boolean;
  carriesOver: boolean;
  carryoverMaxDays: number | null;
  carryoverExpiryMonth: number | null;
  effectiveTo: string | null;
  note: string | null;
}

export interface EntitlementRuleSettings {
  /** Latest starting date first. */
  rules: EntitlementRule[];
  leaveTypes: RuleLeaveType[];
  departments: RuleDepartment[];
  employees: RulePerson[];
  scopes: Choice<RuleScope>[];
  defaults: EntitlementRuleDefaults;
  /** The server's day, in UTC, which is what "already in force" is judged against. */
  today: string;
  /** FR 31. The earliest day a rule may start from, or null where nothing is closed. */
  earliestOpenDay: string | null;
  closedYearsInWords: string;
}

/** What the form sends. A field left out is unchanged; a field sent as null is cleared. */
export interface EntitlementRuleFields {
  leaveTypeId?: string;
  employeeId?: string | null;
  departmentId?: string | null;
  entitlementDays?: number;
  prorateOnJoin?: boolean;
  carriesOver?: boolean;
  carryoverMaxDays?: number | null;
  carryoverExpiryMonth?: number | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  note?: string | null;
}

/**
 * Every rule there is, with the vocabulary the form needs. FR 31.
 *
 * Refused with a 403 for anybody who does not read every record — the rules include personal
 * arrangements — and the screen shows the server's own sentence.
 */
export async function entitlementRules(leaveTypeId?: string): Promise<EntitlementRuleSettings> {
  const query = leaveTypeId === undefined ? '' : `?leaveTypeId=${encodeURIComponent(leaveTypeId)}`;

  return request<EntitlementRuleSettings>('GET', `/api/entitlement-rules${query}`);
}

/**
 * Adds a rule. FR 31.
 *
 * The only way a figure ever changes: a new rule from a later date, never an edit to one
 * that has already applied. Refused where the date reaches into a closed leave year.
 */
export async function addEntitlementRule(fields: EntitlementRuleFields): Promise<EntitlementRule> {
  return request<EntitlementRule>('POST', '/api/entitlement-rules', fields);
}

/** Corrects a rule that has not started yet. Only what is sent changes. */
export async function editEntitlementRule(
  id: string,
  fields: EntitlementRuleFields,
): Promise<EntitlementRule> {
  return request<EntitlementRule>(
    'PATCH',
    `/api/entitlement-rules/${encodeURIComponent(id)}`,
    fields,
  );
}

/** Removes a rule that never applied to anybody. */
export async function withdrawEntitlementRule(id: string): Promise<void> {
  await request<void>('DELETE', `/api/entitlement-rules/${encodeURIComponent(id)}`);
}

/** ------------------------------- the days the office is closed. FR 22, LMS 504 */

/** One gazetted day, as the screen that keeps it sees one. FR 22. */
export interface Holiday {
  id: string;
  /** What the gazette calls it. */
  name: string;
  /** Ten characters. */
  date: string;
  /** The same day as a person writes one, in the server's words. */
  inWords: string;
  weekday: string;

  /** Null where the day falls outside every leave year HR has defined. */
  leaveYearId: string | null;
  leaveYearLabel: string | null;

  /**
   * FR 22. Whether the calendar is still open for this day, and the sentence saying it is not.
   *
   * A closed leave year is never recalculated, so a day inside one is fixed: every request
   * over it was already counted against the calendar as it stood. The refusal is the
   * server's — this only decides which buttons are greyed.
   */
  mayBeChanged: boolean;
  fixedReason: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface HolidayCalendar {
  /** In the order the days fall. */
  holidays: Holiday[];
  years: Year[];
  /**
   * FR 22. The years nobody has transcribed the gazette for yet.
   *
   * A leave year with no holidays in it is not a year with no holidays, and everybody in it
   * is charged a day for Christmas until somebody enters one.
   */
  yearsAwaitingACalendar: Year[];
  /** The server's day, in UTC, so the screen never asks a browser's clock. */
  today: string;
  /** FR 22. The earliest day the calendar may still be changed for, or null where none is. */
  earliestOpenDay: string | null;
  closedYearsInWords: string;
}

/** What the form sends. A field left out is unchanged. */
export interface HolidayFields {
  name?: string;
  date?: string;
}

/**
 * The whole calendar, with the vocabulary the form needs. FR 22.
 *
 * Reading it is open to anybody signed in — it is what a leave quote is priced against — and
 * every write below is refused for anybody but HR, with the server's own sentence.
 */
export async function holidayCalendar(): Promise<HolidayCalendar> {
  return request<HolidayCalendar>('GET', '/api/holidays');
}

/** Adds a day. Refused where the day is taken, or inside a closed leave year. */
export async function addHoliday(fields: HolidayFields): Promise<Holiday> {
  return request<Holiday>('POST', '/api/holidays', fields);
}

/** Renames a day or moves it. Only what is sent changes. */
export async function editHoliday(id: string, fields: HolidayFields): Promise<Holiday> {
  return request<Holiday>('PATCH', `/api/holidays/${encodeURIComponent(id)}`, fields);
}

/** Takes a day off the calendar, making it a working day again for everybody. */
export async function removeHoliday(id: string): Promise<void> {
  await request<void>('DELETE', `/api/holidays/${encodeURIComponent(id)}`);
}

/** --------------- the settings that are about the company. FR 44, FR 48c, NFR SEC 06, LMS 505 */

/** Every org-wide setting, with the sentence each one adds up to. */
export interface PolicySettings {
  /** FR 48c. Null until somebody names one, which is what go live waits on. */
  chiefExecutiveId: string | null;
  chiefExecutiveName: string | null;
  chiefExecutiveJobTitle: string | null;
  isReadyForGoLive: boolean;

  /** FR 44. False makes a line manager's decision final. */
  overridesAreAllowed: boolean;
  overrideRuleInWords: string;

  /** NFR SEC 06. Whole months, or null for kept indefinitely. */
  attachmentRetentionMonths: number | null;
  retentionInWords: string;

  updatedAt: string;
}

/** FR 17, FR 18. One type's two windows, as this screen shows them side by side. */
export interface LeaveWindow {
  id: string;
  code: string;
  name: string;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  displayOrder: number;
}

/** Somebody who could be named Chief Executive. */
export interface Nameable {
  id: string;
  name: string;
  jobTitle: string | null;
  /** FR 06. In the list and marked, so the picker says why it refuses them. */
  hasLeft: boolean;
}

export interface PolicySettingsPage {
  settings: PolicySettings;
  windows: LeaveWindow[];
  employees: Nameable[];
  longestRetentionMonths: number;
}

/** What the form sends. A field left out is unchanged; null clears the window. */
export interface PolicyFields {
  overridesAreAllowed?: boolean;
  attachmentRetentionMonths?: number | null;
}

/**
 * Every policy setting on one answer. FR 44, FR 48c, NFR SEC 06.
 *
 * Reading is open to anybody signed in, because the request form already says unpaid leave
 * goes to the Chief Executive. Every write below is refused for anybody but an HR
 * Administrator, with the server's own sentence.
 */
export async function policySettings(): Promise<PolicySettingsPage> {
  return request<PolicySettingsPage>('GET', '/api/policy-settings');
}

/** Changes the override rule, the retention window, or both. */
export async function changePolicySettings(fields: PolicyFields): Promise<PolicySettings> {
  return request<PolicySettings>('PATCH', '/api/policy-settings', fields);
}

/**
 * Names the Chief Executive. FR 48c.
 *
 * Its own call rather than a field on the change above, because it is its own refusals: an
 * id that is nobody's, somebody who has left, and an empty box.
 */
export async function nameChiefExecutive(employeeId: string): Promise<PolicySettings> {
  return request<PolicySettings>('PUT', '/api/policy-settings/chief-executive', { employeeId });
}

/** ------------------------------ putting a balance right by hand. FR 37, FR 27, LMS 506 */

/** Every kind of movement a balance is made of. §5.7. */
export type MovementType =
  | 'GRANT'
  | 'CARRY_FORWARD'
  | 'ADJUSTMENT'
  | 'EXPIRY'
  | 'LAPSE'
  | 'RESERVATION'
  | 'DEDUCTION'
  | 'RELEASE'
  | 'RECALCULATION';

/** Somebody whose balance can be corrected. */
export interface Adjustable {
  id: string;
  name: string;
  employeeNumber: string;
  jobTitle: string | null;
  /** FR 06. In the list and marked: a leaver's final figure is still HR's to put right. */
  hasLeft: boolean;
}

/** One movement in a balance, on its own. FR 27. */
export interface Entry {
  id: string;
  leaveTypeId: string;
  entryType: MovementType;
  /** The server's wording for the kind of movement. Never translated here. */
  inWords: string;
  /** Signed. An adjustment is the only kind that may go either way. FR 37. */
  days: number;
  /** FR 27. What somebody reads when they ask why the figure is what it is. */
  reason: string;
  correctsId: string | null;
  leaveRequestId: string | null;
  /** Who wrote it. An employee id where a person did, and `createdBy` for a job. */
  createdBy: string;
  createdByEmployeeId: string | null;
  createdAt: string;
}

/** The same, read as one of a run: named, with the figure it left behind it. LMS 211. */
export interface Movement extends Entry {
  typeName: string;
  after: number;
}

/** One person's figures for one leave year, and every movement behind them. */
export interface AdjustmentView {
  employee: Adjustable;
  year: Year;
  years: Year[];
  lines: BalanceLine[];
  ledger: Movement[];
}

/** What the form sends. `days` is signed, and the reason is mandatory. FR 37. */
export interface AdjustmentFields {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  days: number;
  reason: string;
}

/** The movement that was written, and what the balance became. */
export interface Adjusted {
  /** No running total and no type name: neither is true of one movement on its own. */
  entry: Entry;
  balance: {
    leaveTypeId: string;
    leaveYearId: string;
    entitled: number;
    carriedOver: number;
    adjustment: number;
    taken: number;
    pending: number;
    available: number;
  };
}

/** Whose balance could be corrected. Refused for anybody who does not read every record. */
export async function whoCanBeAdjusted(): Promise<{ employees: Adjustable[] }> {
  return request<{ employees: Adjustable[] }>('GET', '/api/balance-adjustments');
}

/** One person's figures and movements, for one leave year or the one the server picks. */
export async function balanceToAdjust(
  employeeId: string,
  leaveYearId?: string,
): Promise<AdjustmentView> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<AdjustmentView>('GET', `/api/balance-adjustments/${employeeId}${query}`);
}

/**
 * Moves a balance by hand. FR 37.
 *
 * An HR Administrator's, and an HR Officer who reaches it meets the server's own sentence
 * naming the desk that can. The answer carries what the balance became, so nothing here has
 * to add the movement to the figure it moved.
 */
export async function adjustBalance(fields: AdjustmentFields): Promise<Adjusted> {
  return request<Adjusted>('POST', '/api/balance-adjustments', fields);
}

/** Who the session belongs to. */
export interface Me {
  employeeId: string;
  firstName: string;
  lastName: string;
}

export interface SignedIn {
  employeeId: string;
  firstName: string;
  lastName: string;
}

/** The second factor was sent instead of a session being opened. LMS 110. */
export interface CodeSent {
  status: 'CODE_SENT';
  companyEmail: string;
  expiresAt: string;
}

/** A refusal the server wrote, carried rather than replaced. NFR USA 03. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Which input, where the server said. */
  readonly field?: string;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Whether a failure is "you are not signed in", which is a screen rather than an error. */
export function isNotSignedIn(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** The status a request that never got an answer carries. Nought: there was no response. */
export const UNREACHABLE = 0;

/**
 * Every call this file makes, with a dropped connection given a sentence. LMS 410.
 *
 * `fetch` rejects with a `TypeError` reading "Failed to fetch", which is what the screens used
 * to show — the one failure here with no sentence behind it. It does not claim the request was
 * not received: a connection can drop after the server has read it.
 */
async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(
      UNREACHABLE,
      'Unreachable',
      'Could not reach the server. Check your connection, then try again.',
    );
  }
}

/** Who the session belongs to, or a 401 where there is no usable one. */
export async function currentSession(): Promise<Me> {
  return request<Me>('GET', '/api/me');
}

export async function signIn(email: string, password: string): Promise<SignedIn | CodeSent> {
  return request<SignedIn | CodeSent>('POST', '/api/session', { email, password });
}

export async function submitCode(email: string, code: string): Promise<SignedIn> {
  return request<SignedIn>('POST', '/api/session/code', { email, code });
}

export async function signOut(): Promise<void> {
  await request<void>('DELETE', '/api/session');
}

/** My balances, for one leave year or for the one the server picks. */
export async function myBalances(leaveYearId?: string): Promise<Statement> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<Statement>('GET', `/api/me/balances${query}`);
}

/**
 * Every request I have made, or only those in one leave year. FR 54. LMS 402.
 *
 * `leaveYearId` is left off by default and that means **everything**, which is the opposite
 * of what leaving it off means for {@link myBalances}. A balance is per leave year and cannot
 * be shown without one, so the server picks; a history is a list of things that happened, and
 * the story asks for all of them.
 *
 * So there is no year for a browser to work out here either, and nothing to hide behind a
 * filter the person did not set.
 */
export async function myRequests(leaveYearId?: string): Promise<History> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<History>('GET', `/api/me/requests${query}`);
}

/**
 * The kinds of leave I may ask for, and what each of them asks of me. LMS 403.
 *
 * Asked once, when the form opens. Nothing in it depends on what somebody types, which is
 * the whole point: the rule that maternity leave needs a certificate is true before a date
 * has been chosen, and a screen that waited for the dates would tell people too late.
 */
export async function requestForm(): Promise<RequestForm> {
  return request<RequestForm>('GET', '/api/me/request-form');
}

/**
 * What this period would cost, before anything is written. LMS 403's first criterion.
 *
 * A GET, because it is one: it writes nothing and reserves nothing, and is meant to be
 * called again every time a date changes.
 *
 * **The reason is not sent.** It is not an input to what a period costs — the server's
 * signature says so — and a form that put a half-written sentence in a query string on
 * every keystroke would be writing somebody's private explanation into an access log.
 */
export async function quoteLeave(input: {
  leaveTypeId: string;
  from: string;
  to: string;
}): Promise<Quote> {
  const query = new URLSearchParams({
    leaveTypeId: input.leaveTypeId,
    from: input.from,
    to: input.to,
  });

  return request<Quote>('GET', `/api/me/requests/quote?${query.toString()}`);
}

/**
 * Everything waiting on me. FR 20, FR 40. LMS 404.
 *
 * No parameters, and there is nothing to pass: the desks are established from the session, so
 * there is no id a browser could name and nothing to narrow by.
 *
 * Refused with a 403 and the server's own sentence for somebody who staffs no desk, and the
 * screen shows that sentence. There is deliberately no flag on `/api/me` to hide the tab in
 * advance: `integration/balances-api.test.ts` pins that route's fields precisely so nothing
 * like `canApprove` appears there, and the reason holds here — a client that decided what to
 * draw from its own standing would be a second answer to a question the server owns.
 */
export async function myApprovals(): Promise<ApproverQueue> {
  return request<ApproverQueue>('GET', '/api/me/approvals');
}

/**
 * The people who report to me, for one leave year. FR 55, FR 56. LMS 405.
 *
 * `/me` names the *manager* here, and there is no id to pass: the team is whoever reports to
 * the session. Direct reports only — a manager two levels up sees their own reports and
 * nobody below them, which is the server's query rather than a filter here.
 *
 * Refused with a 403 and the server's own sentence for somebody who manages nobody, and the
 * screen shows that sentence. As with `/api/me/approvals`, there is deliberately no flag on
 * `/api/me` to hide the tab in advance.
 */
export async function myTeam(leaveYearId?: string): Promise<Team> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<Team>('GET', `/api/me/team${query}`);
}

/**
 * Who is away in a department, for one leave year. FR 57, LMS 406, LMS 409.
 *
 * `/me` names the *reader*, and there is no employee id to pass: the calendar is the
 * department they are in.
 *
 * **`departmentId` is three values rather than two.** Left out, it is the reader's own;
 * an id asks for that department, which is HR's to ask; and the empty string asks for every
 * department at once, which is also HR's. `EVERY_DEPARTMENT` is that empty string, named,
 * because `myCalendar(year, '')` reads like a bug at every call site.
 *
 * **Leave type and reason are not missing from these types — they are not on the wire.** The
 * service behind this route is handed no leave type repository at all, so a type name is not
 * something the screen declines to draw; it is something the server cannot say.
 */
export async function myCalendar(
  leaveYearId?: string,
  departmentId?: string,
): Promise<TeamAwayCalendar> {
  const query = new URLSearchParams();

  if (leaveYearId !== undefined) {
    query.set('leaveYearId', leaveYearId);
  }

  /* Set even when empty, because the empty string is what asks for every department and
     leaving the parameter out asks for the reader's own. */
  if (departmentId !== undefined) {
    query.set('departmentId', departmentId);
  }

  const asked = query.toString();

  return request<TeamAwayCalendar>('GET', `/api/me/calendar${asked === '' ? '' : `?${asked}`}`);
}

/** What `departmentId` is when the calendar is being asked for every department. LMS 409. */
export const EVERY_DEPARTMENT = '';

/* ------------------------------------------ several at once. FR 51, LMS 328 */

/** One request a batch decided, as the single door answers it too. FR 38a, FR 39. */
export interface Decided {
  requestId: string;
  /** NFR DAT 02. Where the row now stands, for whatever decides on it next. LMS 326. */
  version: string;
  status: RequestStatus;
  /** FR 38a. Null once there is nobody left to ask. */
  awaitingApprovalFrom: Desk | null;
  decision: {
    action: 'APPROVE' | 'REFUSE';
    /** FR 52. */
    onBehalfOf: Desk;
    comment: string | null;
    overridesDecisionId: string | null;
    decidedBy: string;
    /** FR 49. The approver whose absence this covered. LMS 327. */
    delegatedFor: string | null;
    decidedAt: string;
  };
  /** Null where this decision was not the last word and no days moved. */
  entryId: string | null;
  availableAfter: number;
}

/** One a batch left where it was, carrying the server's own refusal. FR 51, LMS 328. */
export interface Undecided {
  requestId: string;
  /** The refusal's name, to branch on — `NotAuthorised` for my own request, FR 48. */
  error: string;
  /** NFR USA 03. The sentence, shown beside the row. */
  message: string;
  field?: string;
}

/** What one press did. FR 51, LMS 328. */
export interface BulkDecided {
  action: 'APPROVE' | 'REFUSE';
  inWords: string;
  decided: Decided[];
  undecided: Undecided[];
}

/**
 * Answers several requests at once. FR 51, LMS 328.
 *
 * Never a refusal of the whole selection: each row is decided at its own desk and the ones
 * that could not be are in `undecided` with the sentence saying why. The versions are the
 * ones the queue rows carried — a row somebody else has since answered is refused on its own
 * rather than taking the batch down with it. NFR DAT 02, LMS 326.
 *
 * `comment` is required of a refusal and goes on every one in the batch. FR 39.
 */
export async function decideMany(input: {
  action: 'APPROVE' | 'REFUSE';
  requests: { requestId: string; version: string }[];
  comment?: string;
}): Promise<BulkDecided> {
  return request<BulkDecided>('POST', '/api/me/approvals/decisions', input);
}

/**
 * Asks for the leave. FR 10.
 *
 * The day count is deliberately not among the arguments. The server counts the period
 * again inside the transaction that holds the days, and what it counts is what is charged
 * — a quote is not a promise, and a caller that could hand over a figure could hand over a
 * smaller one.
 *
 * `acknowledgesShortNotice` answers the quote's `SHORT_NOTICE` warning. FR 17, LMS 307. Sent
 * either way; whether one was owed is the server's to decide.
 *
 * `evidence` answers its `DOCUMENTATION_REQUIRED` one. FR 13, FR 32a, LMS 311. Ids from
 * {@link holdEvidence}, uploaded before this call, because a type that asks for documentation
 * refuses a request that arrives without it.
 */
export async function askForLeave(input: {
  leaveTypeId: string;
  from: string;
  to: string;
  /** FR 10. Sent as typed; whether nothing is allowed is the leave type's rule. */
  reason: string;
  acknowledgesShortNotice?: boolean;
  /** FR 13, FR 32a. Attachment ids, never files. LMS 311. */
  evidence?: string[];
}): Promise<Submitted> {
  return request<Submitted>('POST', '/api/me/requests', input);
}

/* ------------------------------------------------------- drafts. FR 19, LMS 302 */

/** Everything I have started and not finished, the one I last worked on first. */
export async function myDrafts(): Promise<{ drafts: Draft[] }> {
  return request<{ drafts: Draft[] }>('GET', '/api/me/request-drafts');
}

/**
 * Saves what I have filled in so far. FR 19.
 *
 * Every field is optional and nothing is held, so this is safe to call with a form that is
 * barely started. What comes back says what is still to fill in rather than refusing it.
 */
export async function saveDraft(fields: DraftFields): Promise<Draft> {
  return request<Draft>('POST', '/api/me/request-drafts', fields);
}

/**
 * Replaces what a draft holds. FR 19.
 *
 * A PUT, and the whole form is sent: a field somebody cleared has to arrive as cleared, and
 * leaving it out would mean "unchanged".
 */
export async function editDraft(draftId: string, fields: DraftFields): Promise<Draft> {
  return request<Draft>('PUT', `/api/me/request-drafts/${encodeURIComponent(draftId)}`, fields);
}

export async function discardDraft(draftId: string): Promise<void> {
  await request<void>('DELETE', `/api/me/request-drafts/${encodeURIComponent(draftId)}`);
}

/**
 * Finishes it: asks for the leave, and the draft goes away. FR 19, FR 10.
 *
 * The same answer {@link askForLeave} gives, and every refusal it can meet. A refused
 * submission leaves the draft exactly where it was.
 *
 * The acknowledgement is given here rather than saved on the draft: how short the notice is
 * depends on the day it is finished. FR 17, LMS 307.
 */
export async function submitDraft(
  draftId: string,
  acknowledgesShortNotice = false,
  /** FR 13, FR 32a, LMS 311. Given here for the same reason: a draft holds no files. */
  evidence: string[] = [],
): Promise<Submitted> {
  return request<Submitted>(
    'POST',
    `/api/me/request-drafts/${encodeURIComponent(draftId)}/submit`,
    { acknowledgesShortNotice, evidence },
  );
}

/* ---------------------------------------------- attachments. FR 12, LMS 310 */

/** NFR SEC 07. `PENDING` is a file nothing has checked; it counts as no evidence. */
export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED';

/** FR 12. What the server accepts, as the bytes say it rather than as the name claims. */
export type AttachmentContentType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface Attachment {
  attachmentId: string;
  /** FR 13. Null while the file is waiting for the request it will evidence. LMS 311. */
  leaveRequestId: string | null;
  /** FR 13. Whose evidence it is. LMS 311. */
  heldForEmployeeId: string;
  slot: number;
  filename: string;
  /** Sniffed server side. What this says may differ from what the file was called. */
  contentType: AttachmentContentType;
  sizeBytes: number;
  checksumSha256: string;
  scanStatus: ScanStatus;
  scanSignature: string | null;
  scannedBy: string | null;
  scannedAt: string | null;
  /** What to grey the download out on. */
  downloadable: boolean;
  uploadedBy: string | null;
  uploadedAt: string;
}

/** FR 13. Whether this leave's documentation rule is met by what is attached. */
export interface Evidence {
  required: boolean;
  satisfied: boolean;
  usable: number;
  attached: number;
  inWords: string;
}

export interface Attachments {
  leaveRequestId: string;
  attachments: Attachment[];
  evidence: Evidence;
}

/** FR 13. What has been uploaded and not yet asked for leave with. LMS 311. */
export interface EvidenceWaiting {
  employeeId: string;
  attachments: Attachment[];
  /** How many of them could stand as documentation. `PENDING` counts for nothing. */
  usable: number;
  inWords: string;
}

/** FR 12. Ten megabytes, five files. Shown on the form, enforced on the server. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;

export async function attachmentsOn(requestId: string): Promise<Attachments> {
  return request<Attachments>('GET', `/api/requests/${encodeURIComponent(requestId)}/attachments`);
}

/**
 * Attaches one file. FR 12.
 *
 * The body is the bytes and the name goes in a header, so a filename never reaches a
 * query string or an access log. The content type is sent for the record and is not what
 * the server decides on — it sniffs the bytes. NFR SEC 07.
 */
export async function attachToRequest(requestId: string, file: File): Promise<Attachment> {
  return upload(`/api/requests/${encodeURIComponent(requestId)}/attachments`, file);
}

/** The one shape both uploads have: bytes as the body, name in a header. FR 12. */
async function upload(path: string, file: File): Promise<Attachment> {
  const response = await send(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': file.type === '' ? 'application/octet-stream' : file.type,
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
  });

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw errorFrom(response.status, payload);
  }

  return payload as Attachment;
}

/**
 * Uploads evidence ahead of the request it will go on. FR 13, FR 32a. LMS 311.
 *
 * The call a form makes *before* it submits, because a type that asks for documentation
 * refuses a request that arrives without it. The id that comes back is what
 * {@link submitRequest} names in `evidence`.
 */
export async function holdEvidence(file: File): Promise<Attachment> {
  return upload('/api/me/evidence', file);
}

/** What is waiting, and how much of it counts. FR 13, LMS 311. */
export async function evidenceWaiting(): Promise<EvidenceWaiting> {
  return request<EvidenceWaiting>('GET', '/api/me/evidence');
}

/** Throws away a waiting file. It is addressed by its own id; there is no request yet. */
export async function discardEvidence(attachmentId: string): Promise<void> {
  await request<void>('DELETE', `/api/evidence/${encodeURIComponent(attachmentId)}`);
}

/** Asks the scanner again about a waiting file it never answered for. NFR SEC 07, LMS 311. */
export async function rescanEvidence(attachmentId: string): Promise<Attachment> {
  return request<Attachment>('POST', `/api/evidence/${encodeURIComponent(attachmentId)}/scan`);
}

/** Where one attachment is addressed for everything that is not its bytes. */
function attachmentPath(requestId: string, attachmentId: string): string {
  return (
    `/api/requests/${encodeURIComponent(requestId)}/attachments/` + encodeURIComponent(attachmentId)
  );
}

export async function removeAttachment(requestId: string, attachmentId: string): Promise<void> {
  await request<void>('DELETE', attachmentPath(requestId, attachmentId));
}

/** Asks the scanner again about a file it never answered for. NFR SEC 07. */
export async function rescanAttachment(
  requestId: string,
  attachmentId: string,
): Promise<Attachment> {
  return request<Attachment>('POST', `${attachmentPath(requestId, attachmentId)}/scan`);
}

/* ------------------------------------ fetching a certificate. NFR SEC 04, LMS 407 */

/** An address the bytes may be fetched from, once, in the next two minutes. */
export interface DownloadLink {
  attachmentId: string;
  filename: string;
  contentType: AttachmentContentType;
  sizeBytes: number;
  /** A path on this origin. Spent by the first fetch. */
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
}

/**
 * Asks for a way in. NFR SEC 04, LMS 407.
 *
 * A POST because it writes: the server records who asked before it answers. Refused unless
 * the scan came back clean, and refused for anybody with no standing over the request.
 */
export async function downloadLinkFor(
  requestId: string,
  attachmentId: string,
): Promise<DownloadLink> {
  return request<DownloadLink>('POST', `${attachmentPath(requestId, attachmentId)}/link`);
}

/**
 * The file, through a link. NFR SEC 04, LMS 407.
 *
 * Two calls, and there is no one-call version: the bytes have no standing address. What
 * comes back is held as a blob rather than navigated to, so that a refusal — a link somebody
 * left open for five minutes, a standing that has since gone — arrives here as the server's
 * own sentence and can be shown, instead of replacing the page with a browser error.
 *
 * The caller is handed the blob and the name, and decides what to do with them. Nothing here
 * touches the document.
 */
export async function fetchAttachment(
  requestId: string,
  attachmentId: string,
): Promise<{ blob: Blob; filename: string }> {
  const link = await downloadLinkFor(requestId, attachmentId);

  const response = await send(link.url, { method: 'GET', credentials: 'same-origin' });

  if (!response.ok) {
    throw errorFrom(response.status, await response.json().catch(() => undefined));
  }

  return { blob: await response.blob(), filename: link.filename };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await send(path, {
    method,
    /* Sends the HttpOnly session cookie. Same-origin rather than include, because the API
       is proxied onto this origin — see client/vite.config.ts — and `include` would be
       asking for a cross-origin credentialed request that the server's SameSite=Strict
       cookie would refuse to be part of anyway. */
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw errorFrom(response.status, payload);
  }

  return payload as T;
}

/**
 * A refusal, from whatever the server sent.
 *
 * Defensive about the shape because a proxy, a load balancer or a crash can produce a
 * non-JSON body with a perfectly good status code, and a client that threw a
 * `TypeError: undefined is not an object` in that case would show a stack trace where a
 * sentence belongs.
 */
function errorFrom(status: number, payload: unknown): ApiError {
  const body =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

  return new ApiError(
    status,
    typeof body.error === 'string' ? body.error : 'Unexpected',
    /* LMS 410. Nothing upstream wrote this one, so it says the act as well as the fault. */
    typeof body.message === 'string'
      ? body.message
      : 'Something went wrong and the server did not say what. Try again in a minute, and ' +
          'tell IT roughly when you tried if it keeps happening.',
    typeof body.field === 'string' ? body.field : undefined,
  );
}
