/**
 * A leave type and the rules it carries. FR 21, FR 31, FR 32, §5.5. LMS 201.
 *
 * The story is an HR Administrator adding or changing a leave type without
 * waiting on a developer, and FR 31 puts it in the strongest terms the SRS uses:
 * "No leave rule shall require a code change or a deployment." The test of
 * whether that has been achieved is not whether there is a form. It is whether
 * the rules that differ between annual leave and maternity leave are *data*.
 * They are: every one of them is a field of {@link LeaveType}, and this file is
 * what a field means and what makes one nonsense.
 *
 * Design principle 5 of the Technical Design Document is what this serves. "Two
 * things vary by leave type, and both used to be global... If either is written
 * as an `if` on a type code, every future leave type becomes a code change."
 * Nothing here reads {@link LeaveType.code} to decide anything, and nothing above
 * here may either. The code is a stable handle for reports and imports; the
 * rules are the columns.
 *
 * ## The same split as everywhere else
 *
 * The rules that need nothing but the record in hand are here as pure functions.
 * The ones that have to look another row up are in the service. The database
 * holds the same rules again as constraints; see the leave-type-rules migration.
 * That duplication is deliberate: the constraints make a bad row impossible for
 * every writer, and the functions here make the refusal say which field was
 * wrong and why.
 *
 * ## What the readings take, and what they deliberately do not
 *
 * Each takes the type plus at most one fact the caller already has: a number of
 * days, a gender, a count of parts. None takes a leave request, a date, or a
 * working pattern.
 *
 * That is the discipline {@link worksOn} keeps in ./work-pattern.ts, and for the
 * same reason. `worksOn` takes an ISO weekday rather than a date, so it needs no
 * timezone and cannot acquire one; {@link noticeShortfall} takes a number of
 * calendar days of notice rather than two dates, so the one subtraction that
 * could go wrong across a timezone happens once, in the caller. Turning a request
 * into those numbers is the LeaveCalculator of §7.3 and the request workflow of
 * Phase 3. This file is the configuration they read.
 *
 * ## Two rules that look alike and are not
 *
 * **Notice warns; backdating refuses.** FR 17 is explicit that a short notice
 * annual leave request is warned about, acknowledged, and then allowed through,
 * "since whether short notice is workable is a judgement for the approvers".
 * FR 18 is equally explicit that beyond the backdating window the employee may
 * not enter the record at all and only HR may, with a reason. So
 * {@link noticeShortfall} returns a number and {@link assertWithinBackdatingWindow}
 * throws. Making them symmetrical would break one of the two requirements, and
 * the one it would break is the one people meet every December.
 *
 * **A documentation threshold is not a balance threshold.** {@link DocumentationRule}
 * `AFTER_DAYS` asks for a document when *this request* is longer than n days.
 * {@link LeaveType.exceedableWithDocument} asks for one when the request would
 * take the *yearly balance* past its allowance. Sick leave is the second, not the
 * first — FR 32a calls its three days "a documentation threshold, not a hard
 * cap" — and reading it as the first would demand a certificate for a four day
 * absence from somebody who had taken none all year.
 *
 * ## What is not here
 *
 * **No figures.** Twenty days of annual leave, a hundred and twenty of maternity.
 * FR 31 requires them versioned with an effective date and forbids them altering
 * closed leave years, and a column has no date on it. They are
 * `leave_entitlement_rule`.
 *
 * ## What arrived with LMS 204
 *
 * **The approval chain.** FR 38a, and it is the second of the two things design
 * principle 5 says vary by leave type. It is a field of {@link LeaveType} like
 * every other rule — {@link LeaveType.approvalChain}, an ordered list of desks —
 * but it is stored as its own rows and it is changed by its own operation rather
 * than as part of an ordinary edit, so what a chain *is* lives next door in
 * ./approval-chain.ts and only what it means for a leave type is here.
 */

import {
  type ApproverRole,
  chainInWords,
  DEFAULT_APPROVAL_CHAIN,
  isApprovable,
  validateApprovalChain,
} from './approval-chain.js';
import type { Gender } from './employee.js';
import { isWholeDays, WHOLE_DAYS_ONLY } from './whole-days.js';

/**
 * FR 21. Whether a day inside the request that the person does not work still
 * costs them one.
 *
 * The most consequential thing a type says about itself. FR 22: annual, sick and
 * compassionate count working days; maternity and paternity count calendar days,
 * "since they are expressed as a continuous period of absence rather than an
 * allowance of workdays".
 *
 * Read together with the working pattern, never instead of it: this says whether
 * the pattern is consulted at all.
 */
export const COUNTING_BASES = ['WORKING_DAYS', 'CALENDAR_DAYS'] as const;

export type CountingBasis = (typeof COUNTING_BASES)[number];

/**
 * Whether there is a running balance at all. The TDD's `is_quota_based`, as a
 * named pair rather than a boolean.
 *
 * FR 32g settles which is which. `QUOTA` is an annual allowance that resets each
 * leave year — annual and sick. `EVENT` is granted per qualifying occurrence,
 * does not reset on 1 January and does not accumulate: maternity, paternity,
 * compassionate, unpaid, and the unpaid maternity extension.
 */
export const ENTITLEMENT_BASES = ['QUOTA', 'EVENT'] as const;

export type EntitlementBasis = (typeof ENTITLEMENT_BASES)[number];

/**
 * How the allowance is expressed to a person, never how it is counted.
 *
 * Maternity is "4 months, 120 days" and paternity is "2 weeks, 14 days". Both
 * are stored and counted in days — FR 24, whole days only — and this is what
 * lets a screen say "4 months" without any part of the system doing arithmetic
 * in months.
 */
export const ALLOWANCE_UNITS = ['DAYS', 'WEEKS', 'MONTHS'] as const;

export type AllowanceUnit = (typeof ALLOWANCE_UNITS)[number];

/**
 * FR 13. Whether the request needs something attached to it, judged on the
 * length of the request.
 *
 * Three states rather than the TDD's boolean-plus-threshold, because the pair
 * could disagree and neither half could stop it.
 *
 * Not to be confused with {@link LeaveType.exceedableWithDocument}, which is
 * about the balance rather than the request. See the module note.
 */
export const DOCUMENTATION_RULES = ['NOT_REQUIRED', 'ALWAYS', 'AFTER_DAYS'] as const;

export type DocumentationRule = (typeof DOCUMENTATION_RULES)[number];

/** What the caller supplies to create one. Everything with a sensible default has one. */
export interface NewLeaveType {
  /** The stable handle. Uppercased and trimmed here. */
  code: string;
  name: string;
  /** What staff read on the request form beside the name. HR's wording. */
  description?: string | null;
  countingBasis: CountingBasis;
  entitlementBasis: EntitlementBasis;
  isPaid?: boolean;
  unit?: AllowanceUnit;
  documentation?: DocumentationRule;
  /** Required exactly when the rule is `AFTER_DAYS`, and refused otherwise. */
  documentationAfterDays?: number | null;
  /** FR 32a. Whether exceeding the balance asks for evidence rather than refusing. */
  exceedableWithDocument?: boolean;
  /** FR 32e. Months after the event an unused grant lapses. Not carry over. */
  entitlementExpiryMonths?: number | null;
  mayBeSplit?: boolean;
  /** FR 17. Calendar days. A threshold for a warning, not a refusal. */
  minNoticeCalendarDays?: number;
  /** FR 18. Calendar days after the fact it may still be entered. This one refuses. */
  maxBackdateCalendarDays?: number;
  /** FR 05. Null for a type open to everybody, which is most of them. */
  genderRestriction?: Gender | null;
  displayOrder?: number;
  /**
   * FR 38a. The desks a request goes to, in order. Manager then HR when nobody
   * says otherwise — {@link DEFAULT_APPROVAL_CHAIN}.
   *
   * Supplied here, on the one operation where the type and its chain are written
   * together, and nowhere else. Changing it afterwards is
   * {@link LeaveTypeService.setApprovalChain}; see {@link LeaveTypeChanges}.
   */
  approvalChain?: readonly string[];
}

/**
 * The fields of an existing one that may change.
 *
 * `isActive` is not among them, deliberately, and for the same reason it is not
 * an ordinary department edit: retiring a type is a decision about every request
 * that will ever be raised against it, and putting the flag in an ordinary edit
 * would give that decision a second door nobody would remember to guard. It is
 * {@link LeaveTypeService.retire} and {@link LeaveTypeService.reinstate}.
 *
 * `deductsFromAnnual` is not among them either, and never will be. FR 33 says
 * sick leave, maternity leave and public holidays shall never reduce annual leave
 * entitlement; the column exists so that the requirement is a CHECK rather than a
 * comment, and there is nothing for a configuration screen to offer.
 *
 * `code` is among them, and only just. It is the handle a report from last year
 * joined on, so changing it is a rename of history rather than a correction — but
 * a typo made on the afternoon a type was created has to be fixable by somebody
 * other than a developer, which is the whole story. The audit log is what makes
 * the difference between the two visible afterwards.
 *
 * `approvalChain` is not among them either, and it is the same argument `isActive`
 * makes rather than a new one. Who signs a request off is a decision about every
 * request that will ever be raised against the type, not a correction to what the
 * type is, and leaving it in an ordinary edit would give that decision a second
 * door — one that the denial log and the audit log would both record as "changed
 * the leave type". It is {@link LeaveTypeService.setApprovalChain}, so that
 * "the administrator took the Chief Executive out of the unpaid leave chain" is a
 * sentence somebody can find afterwards.
 */
export type LeaveTypeChanges = Partial<Omit<NewLeaveType, 'approvalChain'>>;

/** A record as it comes back out. */
export interface LeaveType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  countingBasis: CountingBasis;
  entitlementBasis: EntitlementBasis;
  isPaid: boolean;
  unit: AllowanceUnit;
  documentation: DocumentationRule;
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  entitlementExpiryMonths: number | null;
  mayBeSplit: boolean;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  genderRestriction: Gender | null;
  /** FR 33. Always false, held as a column so the requirement is a constraint. */
  deductsFromAnnual: boolean;
  /**
   * FR 38a. The desks a request goes to, in order.
   *
   * Empty only for a type somebody left half configured — the database allows it
   * and the leave-type-approval-chain migration says why — and
   * {@link assertSomebodyApprovesIt} is where that is refused.
   */
  approvalChain: ApproverRole[];
  displayOrder: number;
  /** Retired types are still readable and still head every report they ever did. */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedLeaveType {
  code: string;
  name: string;
  description: string | null;
  countingBasis: CountingBasis;
  entitlementBasis: EntitlementBasis;
  isPaid: boolean;
  unit: AllowanceUnit;
  documentation: DocumentationRule;
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  entitlementExpiryMonths: number | null;
  mayBeSplit: boolean;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  genderRestriction: Gender | null;
  displayOrder: number;
  /**
   * FR 38a. Not a column of `leave_type` at all — the repository writes it as
   * rows in the same transaction, the way a working pattern's week is written.
   */
  approvalChain: ApproverRole[];
}

/**
 * A record that was refused, and the field that caused it.
 *
 * The field is carried separately rather than only mentioned in the message, for
 * the reason {@link InvalidEmployee} carries one, and NFR USA 03 is the
 * requirement behind it: an error must say what is wrong *and what to do about
 * it*, next to the input it is about. It matters more here than anywhere else in
 * the system, because this form has fifteen inputs and two of the rules span two
 * of them.
 */
export class InvalidLeaveType extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeaveType';
    this.field = field;
  }
}

export class DuplicateLeaveTypeCode extends Error {
  constructor(code: string) {
    super(
      `There is already a leave type with the code ${code}. A code is the handle ` +
        `reports and imports join on, so two types cannot share one.`,
    );
    this.name = 'DuplicateLeaveTypeCode';
  }
}

export class DuplicateLeaveTypeName extends Error {
  constructor(name: string) {
    super(`There is already a leave type called ${name}.`);
    this.name = 'DuplicateLeaveTypeName';
  }
}

export class LeaveTypeNotFound extends Error {
  readonly leaveTypeId: string;

  constructor(id: string) {
    super(`No leave type with id ${id}.`);
    this.name = 'LeaveTypeNotFound';
    this.leaveTypeId = id;
  }
}

/**
 * A retired type being chosen for something new.
 *
 * The counterpart of retiring one, and the two together are what let a type stop
 * being offered without anything already filed under it becoming unreadable —
 * the same arrangement {@link DepartmentDeactivated} makes for a closed team.
 */
export class LeaveTypeRetired extends Error {
  readonly leaveTypeId: string;

  constructor(type: LeaveType) {
    super(
      `${type.name} has been retired and no new leave can be requested against ` +
        `it. Choose a type that is still offered, or reinstate this one.`,
    );
    this.name = 'LeaveTypeRetired';
    this.leaveTypeId = type.id;
  }
}

/**
 * FR 05. Somebody asking for a type that is not open to them.
 *
 * Two cases, told apart because they need different answers. A man asking for
 * maternity leave has made a mistake and should be told so plainly. An employee
 * whose record has no gender on it has hit a *gap*, and telling them they are
 * ineligible would be a lie — nobody has established that they are. That one is
 * HR's to fix on the record, and NFR USA 03 says the message must say so.
 *
 * FR 05 makes the column optional on purpose and limits its use "to eligibility
 * checks only". Refusing silently in the second case would quietly make it
 * mandatory after all.
 */
export class NotEligibleForLeaveType extends Error {
  readonly leaveTypeId: string;
  /** Whether the record simply says nothing, as against saying the wrong thing. */
  readonly genderNotRecorded: boolean;

  constructor(type: LeaveType, gender: Gender | null) {
    super(
      gender === null
        ? `${type.name} is only available to ${lower(type.genderRestriction)} employees, ` +
            `and this record does not say. Ask HR to complete the record rather than ` +
            `guessing — nothing here will assume it.`
        : `${type.name} is only available to ${lower(type.genderRestriction)} employees.`,
    );
    this.name = 'NotEligibleForLeaveType';
    this.leaveTypeId = type.id;
    this.genderNotRecorded = gender === null;
  }
}

/**
 * FR 38a. A type nobody is set up to approve, being requested.
 *
 * The counterpart of {@link LeaveTypeRetired}: that one is a type deliberately
 * taken out of use, this one is a type nobody finished configuring. Telling the
 * two apart matters to the person reading the message, because only one of them
 * is somebody's mistake and only one of them has a fix.
 *
 * The state is reachable, which is why this exists. A type restored by
 * `ensure_statutory_leave_types()` comes back without a chain — that function
 * predates the table — and the repair is the call beside it. Refusing here rather
 * than in the database is the decision the leave-type-approval-chain migration
 * argues: a constraint would fire on the operator putting the type back, and this
 * fires on the person the gap actually affects, with the answer in the message.
 */
export class NobodyApprovesLeaveType extends Error {
  readonly leaveTypeId: string;

  constructor(type: LeaveType) {
    super(
      `Nobody is set up to approve ${type.name}, so a request for it would sit in ` +
        `no queue at all. Ask an HR Administrator to say who approves it — most ` +
        `types go to ${chainInWords(DEFAULT_APPROVAL_CHAIN)}.`,
    );
    this.name = 'NobodyApprovesLeaveType';
    this.leaveTypeId = type.id;
  }
}

/**
 * FR 18. Dated further into the past than the type's backdating window allows.
 *
 * The one window that refuses. Its message names the escape hatch, because there
 * is one and the person hitting this cannot use it themselves: "Beyond 7 days
 * only HR may enter the record, with a reason."
 */
export class TooLateToRecord extends Error {
  readonly permitted: number;
  readonly daysAgo: number;

  constructor(type: LeaveType, daysAgo: number) {
    super(
      `${type.name} can be recorded up to ${days(type.maxBackdateCalendarDays)} after ` +
        `the fact, and this one starts ${days(daysAgo)} ago. Ask HR to enter it; ` +
        `they can record leave from further back, with a reason.`,
    );
    this.name = 'TooLateToRecord';
    this.permitted = type.maxBackdateCalendarDays;
    this.daysAgo = daysAgo;
  }
}

/** A type that has to be taken in one continuous period, being broken up. */
export class LeaveTypeMayNotBeSplit extends Error {
  readonly leaveTypeId: string;

  constructor(type: LeaveType) {
    super(
      `${type.name} is taken as one continuous period rather than in separate ` +
        `spells, so it cannot be split.`,
    );
    this.name = 'LeaveTypeMayNotBeSplit';
    this.leaveTypeId = type.id;
  }
}

/* ------------------------------------------------------------- what is valid */

/**
 * Checks and tidies a new record.
 *
 * Defaults are applied here rather than left to the column defaults, so that the
 * record the caller gets back is the record that was written. A type created
 * through a form that omitted `mayBeSplit` and a type created with it set to true
 * are the same type, and both should read as the same type immediately rather
 * than after a round trip.
 */
export function validateNewLeaveType(input: NewLeaveType): ValidatedLeaveType {
  const validated: ValidatedLeaveType = {
    code: requireCode(input.code),
    name: requireName(input.name),
    description: optionalText('description', input.description),
    countingBasis: requireOneOf('countingBasis', input.countingBasis, COUNTING_BASES),
    entitlementBasis: requireOneOf('entitlementBasis', input.entitlementBasis, ENTITLEMENT_BASES),
    isPaid: input.isPaid ?? true,
    unit: requireOneOf('unit', input.unit ?? 'DAYS', ALLOWANCE_UNITS),
    documentation: requireOneOf(
      'documentation',
      input.documentation ?? 'NOT_REQUIRED',
      DOCUMENTATION_RULES,
    ),
    documentationAfterDays: optionalCount('documentationAfterDays', input.documentationAfterDays),
    exceedableWithDocument: input.exceedableWithDocument ?? false,
    entitlementExpiryMonths: optionalCount(
      'entitlementExpiryMonths',
      input.entitlementExpiryMonths,
    ),
    mayBeSplit: input.mayBeSplit ?? true,
    minNoticeCalendarDays: requireWindow('minNoticeCalendarDays', input.minNoticeCalendarDays ?? 0),
    maxBackdateCalendarDays: requireWindow(
      'maxBackdateCalendarDays',
      input.maxBackdateCalendarDays ?? DEFAULT_BACKDATE_DAYS,
    ),
    genderRestriction:
      input.genderRestriction == null
        ? null
        : requireOneOf('genderRestriction', input.genderRestriction, GENDERS),
    displayOrder: requireOrder(input.displayOrder ?? 0),
    /* FR 38a. Manager then HR unless the caller said otherwise, applied here
       rather than left to the writer for the reason every other default is: the
       record the caller gets back is the record that was written, and a type
       created through a form that did not mention approvals reads as the type it
       is immediately rather than after a round trip. */
    approvalChain: validateApprovalChain(input.approvalChain ?? DEFAULT_APPROVAL_CHAIN),
  };

  assertRulesAgree(validated);

  return validated;
}

/**
 * Checks and tidies a change to an existing one.
 *
 * Takes the current record, like the employee equivalent and unlike the
 * department and working pattern ones, because the documentation rule spans two
 * fields and a change usually mentions only one of them. Setting the rule to
 * `AFTER_DAYS` is valid or not depending on a threshold that may already be
 * there, and that has to be judged against the record *as it will be*.
 *
 * Only the fields actually supplied come back, so a change mentioning nothing
 * leaves the record exactly as it stands rather than rewriting it with whatever
 * the caller happened to have loaded.
 */
export function validateLeaveTypeChanges(
  changes: LeaveTypeChanges,
  current: LeaveType,
): Partial<ValidatedLeaveType> {
  const validated: Partial<ValidatedLeaveType> = {};

  if ('code' in changes) {
    validated.code = requireCode(changes.code);
  }
  if ('name' in changes) {
    validated.name = requireName(changes.name);
  }
  if ('description' in changes) {
    validated.description = optionalText('description', changes.description);
  }
  if ('countingBasis' in changes) {
    validated.countingBasis = requireOneOf('countingBasis', changes.countingBasis, COUNTING_BASES);
  }
  if ('entitlementBasis' in changes) {
    validated.entitlementBasis = requireOneOf(
      'entitlementBasis',
      changes.entitlementBasis,
      ENTITLEMENT_BASES,
    );
  }
  if ('isPaid' in changes) {
    validated.isPaid = requireBoolean('isPaid', changes.isPaid);
  }
  if ('unit' in changes) {
    validated.unit = requireOneOf('unit', changes.unit, ALLOWANCE_UNITS);
  }
  if ('documentation' in changes) {
    validated.documentation = requireOneOf(
      'documentation',
      changes.documentation,
      DOCUMENTATION_RULES,
    );
  }
  if ('documentationAfterDays' in changes) {
    validated.documentationAfterDays = optionalCount(
      'documentationAfterDays',
      changes.documentationAfterDays,
    );
  }
  if ('exceedableWithDocument' in changes) {
    validated.exceedableWithDocument = requireBoolean(
      'exceedableWithDocument',
      changes.exceedableWithDocument,
    );
  }
  if ('entitlementExpiryMonths' in changes) {
    validated.entitlementExpiryMonths = optionalCount(
      'entitlementExpiryMonths',
      changes.entitlementExpiryMonths,
    );
  }
  if ('mayBeSplit' in changes) {
    validated.mayBeSplit = requireBoolean('mayBeSplit', changes.mayBeSplit);
  }
  if ('minNoticeCalendarDays' in changes) {
    validated.minNoticeCalendarDays = requireWindow(
      'minNoticeCalendarDays',
      changes.minNoticeCalendarDays,
    );
  }
  if ('maxBackdateCalendarDays' in changes) {
    validated.maxBackdateCalendarDays = requireWindow(
      'maxBackdateCalendarDays',
      changes.maxBackdateCalendarDays,
    );
  }
  if ('genderRestriction' in changes) {
    validated.genderRestriction =
      changes.genderRestriction == null
        ? null
        : requireOneOf('genderRestriction', changes.genderRestriction, GENDERS);
  }
  if ('displayOrder' in changes) {
    validated.displayOrder = requireOrder(changes.displayOrder);
  }

  assertRulesAgree({ ...asValidated(current), ...validated });

  return validated;
}

/**
 * The rule that is about two fields at once, judged against the whole record.
 *
 * One of them, where an earlier draft of this file had four. Three of those were
 * invented — a notice window and a backdating window were held to be mutually
 * exclusive, which FR 17 and FR 18 flatly contradict, since annual leave carries
 * both — and inventing rules is the failure mode this table exists to prevent.
 * What is left is the pair the SRS and the TDD both leave unguarded, and it is a
 * real one: `requires_attachment` and `attachment_required_after_days` are two
 * columns describing one rule, and either can be set without the other.
 */
function assertRulesAgree(type: ValidatedLeaveType): void {
  if (type.documentation === 'AFTER_DAYS' && type.documentationAfterDays === null) {
    throw new InvalidLeaveType(
      'documentationAfterDays',
      'A type that asks for documentation after a number of days has to say how ' +
        'many. Set the number, or choose whether documentation is always or never ' +
        'required instead.',
    );
  }
  if (type.documentation !== 'AFTER_DAYS' && type.documentationAfterDays !== null) {
    throw new InvalidLeaveType(
      'documentationAfterDays',
      `Documentation is ${type.documentation === 'ALWAYS' ? 'always' : 'never'} ` +
        'required for this type, so a number of days would never be read. Clear it, ' +
        'or change the rule to require documentation after a number of days.',
    );
  }
}

/* --------------------------------------------------------------- the readings */

/**
 * FR 21. Whether the working pattern is consulted when counting this type.
 *
 * The primitive the LeaveCalculator of §7.3 branches on — "one function with one
 * branch, not two functions" — and the reason it is a function rather than a
 * comparison written at each call site: there are two bases today, and the day a
 * third arrives every caller that wrote `=== 'WORKING_DAYS'` is silently wrong
 * while every caller that asked this is merely out of date, which the compiler
 * can say.
 */
export function countsWorkingDays(type: LeaveType): boolean {
  return type.countingBasis === 'WORKING_DAYS';
}

/**
 * Whether this type has an annual balance that resets. FR 32g.
 *
 * What decides that a `leave_balance` row is opened by the year rollover, and
 * therefore whether "you have three days left" is a sentence anybody should be
 * shown about it. An event type's grant arrives when the event is recorded.
 */
export function hasRunningBalance(type: LeaveType): boolean {
  return type.entitlementBasis === 'QUOTA';
}

/**
 * FR 32e. Whether an unused grant of this type lapses, and after how long.
 *
 * Paternity, and today only paternity: 14 days per birth, usable within six
 * months. **Not carry over** — unused annual days rolling into the next year is
 * FR 36 and lives on the entitlement rule with the effective dates. Two clocks
 * with similar names.
 */
export function grantExpires(type: LeaveType): boolean {
  return type.entitlementExpiryMonths !== null;
}

/**
 * FR 13. Whether a request of this many days needs something attached, on the
 * strength of its length alone.
 *
 * Takes the day count rather than the request, so it needs no dates and no
 * working pattern — the count is whatever the calculator produced under this
 * type's own {@link CountingBasis}.
 *
 * The comparison is `>` rather than `>=`: "documentation after two days" means
 * two days is fine and the third is not.
 *
 * This is not the sick leave rule. Sick leave's certificate is demanded by the
 * *balance*, not by the length of the request — see
 * {@link balanceMayBeExceededWithDocument} — so a four day absence by somebody
 * who has taken none all year needs nothing from this function.
 *
 * Half a day is refused rather than compared. FR 24, and it matters here because
 * the comparison would otherwise succeed quietly: 2.5 days is past a two day
 * threshold, so a caller that had miscounted would get a plausible answer and no
 * indication that its number was never a number of days.
 */
export function documentationRequired(type: LeaveType, days: number): boolean {
  requireWholeDays('days', 'The length of a request', days);

  switch (type.documentation) {
    case 'ALWAYS':
      return true;
    case 'AFTER_DAYS':
      return type.documentationAfterDays !== null && days > type.documentationAfterDays;
    default:
      return false;
  }
}

/**
 * FR 32a and FR 14. Whether going past the available balance asks for evidence
 * rather than refusing.
 *
 * True for sick leave and nothing else today. It inverts the balance check: the
 * allowance stops being a cap and becomes the point at which a medical
 * certificate is demanded, and the leave is granted either way. §8.6b spells out
 * the consequence — sick balances will routinely go negative, and that is correct.
 *
 * The check itself belongs to the submission path, which is the only thing that
 * knows what the balance is. This is the flag it reads, and it is a column so
 * that the day compassionate leave works the same way it is a checkbox.
 */
export function balanceMayBeExceededWithDocument(type: LeaveType): boolean {
  return type.exceedableWithDocument;
}

/**
 * FR 05. Whether this type is open to somebody, and why not when it is not.
 *
 * The gender is passed in rather than the employee record, so this rule cannot
 * become a second place that decides who may read one.
 *
 * A type with no restriction is open to everybody including somebody whose record
 * says nothing, which is most types and most people. The gap only matters where a
 * restriction exists, and there it is reported as a gap rather than as a refusal
 * — see {@link NotEligibleForLeaveType}.
 */
export function assertEligible(type: LeaveType, gender: Gender | null): void {
  if (type.genderRestriction === null) {
    return;
  }
  if (gender !== type.genderRestriction) {
    throw new NotEligibleForLeaveType(type, gender);
  }
}

/**
 * FR 17. How many days short of the expected notice this request is, or zero.
 *
 * **This returns a number rather than throwing, and that is the requirement
 * rather than a preference.** FR 17: where an annual leave request is submitted
 * with less notice "the system shall warn and require the employee to
 * acknowledge, then allow it through, since whether short notice is workable is a
 * judgement for the approvers". A rule that refused would be a rule the business
 * did not ask for, applied to the one type most people use.
 *
 * `daysOfNotice` is calendar days between the request being made and the leave
 * starting, which is how a person counts notice off a wall calendar. The caller
 * does that subtraction, once, where it has both dates.
 *
 * Backdating is not this function's business. A negative notice is a request
 * about the past, which {@link assertWithinBackdatingWindow} judges and which
 * *is* refused; zero here means the request was made on the day, which is the
 * ordinary case for sick leave and short of nothing at all.
 */
export function noticeShortfall(type: LeaveType, daysOfNotice: number): number {
  requireWholeDays('daysOfNotice', 'Notice', daysOfNotice);

  if (daysOfNotice < 0) {
    return type.minNoticeCalendarDays;
  }

  return Math.max(0, type.minNoticeCalendarDays - daysOfNotice);
}

/**
 * FR 18. Whether leave that has already begun may still be entered.
 *
 * The window that refuses, and the asymmetry with {@link noticeShortfall} is the
 * SRS's rather than a choice made here: leave may be recorded up to a week after
 * the fact "so that emergency absence can be entered on return", and beyond that
 * "only HR may enter the record, with a reason".
 *
 * That HR exemption is not applied here, deliberately. It is a question about who
 * is asking rather than about the type, so it belongs to the request workflow;
 * this answers only what the type permits. {@link TooLateToRecord} names the
 * exemption in its message, because the person who hits it cannot use it
 * themselves and has to know who can.
 *
 * `daysOfNotice` uses the same sign convention as {@link noticeShortfall}:
 * positive is ahead of the leave, negative is behind it. A request made on the
 * day or ahead of it is not backdated at all.
 */
export function assertWithinBackdatingWindow(type: LeaveType, daysOfNotice: number): void {
  requireWholeDays('daysOfNotice', 'Notice', daysOfNotice);

  if (daysOfNotice < 0 && -daysOfNotice > type.maxBackdateCalendarDays) {
    throw new TooLateToRecord(type, -daysOfNotice);
  }
}

/**
 * §8.6aa. Whether one grant may be drawn down by more than one request.
 *
 * `parts` is how many separate periods the grant is being broken into, so one is
 * always allowed — a type that cannot be split can still be taken.
 */
export function assertMayBeSplit(type: LeaveType, parts: number): void {
  if (parts > 1 && !type.mayBeSplit) {
    throw new LeaveTypeMayNotBeSplit(type);
  }
}

/**
 * Whether new leave may be requested against this type at all.
 *
 * Retiring a type is the ending it has, and this is the other half: a retired
 * type stays readable, keeps heading every report it ever headed, and is offered
 * for nothing new.
 */
export function assertStillOffered(type: LeaveType): void {
  if (!type.isActive) {
    throw new LeaveTypeRetired(type);
  }
}

/**
 * FR 38a. Whether anybody is set up to approve leave of this kind.
 *
 * Asked beside {@link assertStillOffered} and answered separately from it,
 * because they are different facts with different fixes: a retired type was taken
 * out of use on purpose, and a type with no chain is one somebody has not
 * finished configuring. Both stop a request; only one is a mistake.
 *
 * Every type shipped has a chain and every type created through
 * {@link LeaveTypeService.create} gets one, so this fires on the seam the
 * leave-type-approval-chain migration names: a type restored by
 * `ensure_statutory_leave_types()` without the call beside it, or one written
 * from a psql prompt.
 */
export function assertSomebodyApprovesIt(type: LeaveType): void {
  if (!isApprovable(type.approvalChain)) {
    throw new NobodyApprovesLeaveType(type);
  }
}

/**
 * FR 38a. Who a request of this kind goes to, in order, as a person reads it.
 *
 * "your line manager then HR", or "HR then the Chief Executive". What the request
 * form shows beside the type, so that somebody knows before they ask rather than
 * after they have waited — the same argument ../auth/leave-type-policy.ts makes
 * for leaving the whole table readable.
 */
export function approvalChainInWords(type: LeaveType): string {
  return chainInWords(type.approvalChain);
}

/**
 * The order a form and a balance screen list types in. §7.4 orders the balance
 * read by it, so it is a decision rather than an alphabetical accident.
 */
export function byDisplayOrder(left: LeaveType, right: LeaveType): number {
  return left.displayOrder - right.displayOrder || left.name.localeCompare(right.name);
}

/* ---------------------------------------------------------------- the fields */

/** FR 18, and the TDD's column default. One week. */
const DEFAULT_BACKDATE_DAYS = 7;

/* Imported rather than restated, because a restriction naming something no
   employee record can hold is a type nobody is eligible for. */
const GENDERS = ['MALE', 'FEMALE'] as const satisfies readonly Gender[];

/**
 * The handle, uppercased.
 *
 * Folded here rather than only compared folded in the database, because this one
 * is read by people in a report heading and a CSV column: a table holding both
 * `ANNUAL` and `Annual` would be refused by the unique index, but a table holding
 * only `annual` would look like a bug in every export.
 *
 * Spaces and punctuation are refused rather than trimmed out. A code is a token a
 * spreadsheet column and a report join on, and one with a comma in it breaks the
 * import of FR 08 the first time somebody uses it — months after the code was
 * typed, by somebody who did not type it.
 */
function requireCode(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveType(
      'code',
      'A leave type needs a code. It is the short handle reports and imports use, ' +
        'like ANNUAL or MATERNITY.',
    );
  }

  const code = value.trim().toUpperCase();

  if (code.length > 40) {
    throw new InvalidLeaveType(
      'code',
      'A leave type code is longer than the 40 characters the record holds.',
    );
  }
  if (!/^[A-Z0-9][A-Z0-9_]*$/.test(code)) {
    throw new InvalidLeaveType(
      'code',
      `${code} is not a usable code. Use letters, digits and underscores, starting ` +
        'with a letter or a digit — a code is a column heading in an export and a ' +
        'value in an import, and a space or a comma in one breaks both.',
    );
  }

  return code;
}

/**
 * What it is called on the screen somebody chooses it from.
 *
 * Trimmed rather than refused when it arrives padded, for the reason a department
 * name is: it is copied off a handbook more often than it is typed.
 */
function requireName(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveType('name', 'A leave type needs a name.');
  }

  const name = value.trim();
  if (name.length > 80) {
    throw new InvalidLeaveType(
      'name',
      'A leave type name is longer than the 80 characters the record holds.',
    );
  }

  return name;
}

/**
 * Free text, or nothing.
 *
 * Blank comes back as null rather than as an empty string, so that "nobody wrote
 * one" has a single representation and a screen has one thing to test.
 */
function optionalText(field: string, value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new InvalidLeaveType(field, `${field} is text, or nothing at all.`);
  }

  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * A count of days or months that is either absent or a positive whole number.
 *
 * Zero is refused rather than treated as absent, and the two are genuinely
 * different instructions: "documentation after zero days" is `ALWAYS` written in
 * a way no screen renders correctly, and "the grant lapses after zero months" is
 * "it lapses immediately". Both are somebody reaching for null and finding the
 * number nearest to it.
 *
 * The whole-number question is {@link isWholeDays}, asked here for a count of
 * months as well as a count of days. One of the two this serves really is days —
 * the documentation threshold of FR 13 — so a second copy of the test sitting a
 * few lines from the first is exactly the drift ./whole-days.ts exists to stop.
 */
function optionalCount(field: string, value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!isWholeDays(value) || value < 1) {
    throw new InvalidLeaveType(
      field,
      `${field} is a whole number of at least 1, or nothing at all. ${String(value)} ` +
        'is neither; leave it empty if the rule does not apply.',
    );
  }

  return value;
}

/**
 * A notice or backdating window, in whole calendar days, where zero means no
 * window.
 *
 * Zero is the ordinary value here rather than a stand in for absent, which is why
 * this is not {@link optionalCount}: "no notice required" is a real rule that
 * sick leave holds on purpose, not an unanswered question.
 */
function requireWindow(field: string, value: number | undefined): number {
  if (!isWholeDays(value) || value < 0) {
    throw new InvalidLeaveType(
      field,
      `${field} is a whole number of calendar days, zero or more. ${String(value)} ` +
        `is not; use 0 for a type with no window. ${WHOLE_DAYS_ONLY}`,
    );
  }

  /* A window measured in years is a figure entered in the wrong unit far more
     often than it is a policy. Refused with the unit named, because the person
     who typed 365 meant days and the person who typed 12 meant months. */
  if (value > 365) {
    throw new InvalidLeaveType(
      field,
      `${field} is measured in calendar days, and ${String(value)} of them is over ` +
        'a year. Check the unit.',
    );
  }

  return value;
}

function requireOrder(value: number | undefined): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new InvalidLeaveType(
      'displayOrder',
      `displayOrder is a whole number, zero or more, and ${String(value)} is not.`,
    );
  }
  return value as number;
}

function requireBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidLeaveType(field, `${field} is true or false, not ${String(value)}.`);
  }
  return value;
}

function requireOneOf<T extends string>(
  field: string,
  value: string | undefined,
  permitted: readonly T[],
): T {
  if (typeof value !== 'string' || !permitted.includes(value as T)) {
    throw new InvalidLeaveType(
      field,
      `${field} must be one of ${permitted.join(', ')}, not ${String(value)}.`,
    );
  }
  return value as T;
}

/**
 * A count of days handed in by a caller, which is whole or is a bug. FR 24.
 *
 * The three functions that take one all get it the same way — a subtraction of two
 * calendar dates, or {@link countLeaveDays} — and each of those produces a whole
 * number by construction. So a fraction arriving here is not a person typing into a
 * form; it is a caller that has computed something wrong, and the refusal names the
 * argument rather than a field, because there is no field for it to appear beside.
 */
function requireWholeDays(field: string, noun: string, days: number): void {
  if (!isWholeDays(days)) {
    throw new InvalidLeaveType(
      field,
      `${noun} is a whole number of days, and ${String(days)} is not one. ${WHOLE_DAYS_ONLY}`,
    );
  }
}

/** The editable half of a stored record, so a change can be judged against it. */
function asValidated(type: LeaveType): ValidatedLeaveType {
  return {
    code: type.code,
    name: type.name,
    description: type.description,
    countingBasis: type.countingBasis,
    entitlementBasis: type.entitlementBasis,
    isPaid: type.isPaid,
    unit: type.unit,
    documentation: type.documentation,
    documentationAfterDays: type.documentationAfterDays,
    exceedableWithDocument: type.exceedableWithDocument,
    entitlementExpiryMonths: type.entitlementExpiryMonths,
    mayBeSplit: type.mayBeSplit,
    minNoticeCalendarDays: type.minNoticeCalendarDays,
    maxBackdateCalendarDays: type.maxBackdateCalendarDays,
    genderRestriction: type.genderRestriction,
    displayOrder: type.displayOrder,
    approvalChain: type.approvalChain,
  };
}

function days(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

function lower(gender: Gender | null): string {
  return gender === null ? 'eligible' : gender.toLowerCase();
}
