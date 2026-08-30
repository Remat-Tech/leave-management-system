/**
 * What a leave type is worth, and from when. FR 31, §5.5. LMS 203.
 *
 * The leave type says what kind of arithmetic applies; this says what numbers go
 * into it. The whole of the difference between the two is the pair of dates every
 * rule carries, and FR 31 is why they are there: a change to an entitlement
 * "shall not retroactively alter closed leave years". Raise annual leave from
 * twenty days to twenty two next January and last year's balances have to stay
 * what they were — not because anybody remembers to leave them alone, but because
 * there is no arrangement of rows that could move them.
 *
 * ## The rule this file exists to implement once
 *
 * Every figure is asked for as of a day, and the answer is the rule that is
 * **most specific, then latest**:
 *
 *   A rule naming this employee beats one naming their department, which beats
 *   one naming nobody. Three rungs, because nothing narrower than a person exists
 *   and nothing sits between a department and everybody.
 *
 *   Within a rung, the latest `effectiveFrom` that has already arrived wins. That
 *   is what makes changing a figure an *insert*: HR adds "twenty two from 1
 *   January 2027" and the twenty day rule keeps answering every question about
 *   2026 for as long as anybody asks one.
 *
 * {@link resolve} is the only implementation of that. The repository fetches
 * candidate rows and does not order them, the migration creates no view, and
 * there is no second copy in SQL — which is the criterion the story states and
 * the one that is easiest to lose, because an `ORDER BY ... LIMIT 1` in a query
 * looks like an optimisation rather than like a duplicate rule.
 *
 * ## Why a closed year cannot move
 *
 * Three properties, and it takes all three:
 *
 *   **There is no undated question.** {@link resolve} takes a day and there is no
 *   overload that does not. A caller cannot ask what annual leave is worth; only
 *   what it was worth on a date, and a date in a closed year selects the rules
 *   that covered it.
 *
 *   **A rule that has taken effect is never rewritten.** Not by this service, and
 *   not by anybody: the entitlement-rule-effective-dates migration holds it as a
 *   trigger, so a correction typed at a psql prompt is refused the same way.
 *   {@link assertMayBeCorrected} is the message; the trigger is the guarantee.
 *
 *   **A new rule may not reach back into a closed year.** This is the one no
 *   constraint on this table can decide, because a closed leave year is a row in
 *   another one. It is held here as {@link assertDoesNotReachIntoAClosedYear},
 *   which takes the boundary as an argument the way {@link worksOn} takes a
 *   weekday — the domain knows the rule, the caller brings the fact. Since
 *   LMS 205 the fact comes from `leave_year`: {@link earliestOpenDayFrom} reads
 *   the day after the last closed year ends. On go live the whole of 2026 is
 *   open, nothing is closed, and entering the current policy from 1 January is
 *   exactly what HR has to be able to do.
 *
 * ## What is deliberately not here
 *
 * **No pro rating.** {@link EntitlementRule.prorateOnJoin} says whether a joiner's
 * first year is a proportion; what the proportion is, is LMS 013's formula and
 * LMS 215 applies it. One calculation for the whole company is not a figure per
 * rule.
 *
 * **No granting.** A resolved rule is a figure, not days somebody has. Turning it
 * into a balance is a ledger entry — LMS 210 and LMS 214 — and that is the other
 * half of why a closed year is safe: a grant is written once, with the amount it
 * was worth on the day it was written.
 *
 * **No leave year.** A rule covers days, and it goes on covering them whatever
 * anybody draws around them. Which days make a year, and whether that year is
 * closed, is ./leave-year.ts — read through {@link EarliestOpenDay} and nowhere
 * else, so that this file still needs nothing but the rules in hand.
 */

import { type CalendarDate, isCalendarDate } from './time.js';
import { isWholeDays, WHOLE_DAYS_ONLY } from './whole-days.js';

/**
 * How narrowly a rule is aimed, and therefore which one wins.
 *
 * Ordered from widest to narrowest, which is the order {@link specificityOf}
 * scores them in and the order they read in a sentence: everybody, then a
 * department, then a person.
 *
 * A rung is not a column of its own. It follows from which of the two scope
 * fields is set, so a rule cannot claim to be more specific than it is — the two
 * could disagree and the row would be sound and wrong.
 */
export const RULE_SCOPES = ['EVERYBODY', 'DEPARTMENT', 'EMPLOYEE'] as const;

export type RuleScope = (typeof RULE_SCOPES)[number];

/** What the caller supplies to create one. Everything with a sensible default has one. */
export interface NewEntitlementRule {
  leaveTypeId: string;
  /** The person this is for, or nothing. Never set beside a department. */
  employeeId?: string | null;
  /** The team this is for, or nothing. Never set beside an employee. */
  departmentId?: string | null;
  /** Whole days. FR 24. Per leave year, or per occurrence for an event type. */
  entitlementDays: number;
  prorateOnJoin?: boolean;
  carriesOver?: boolean;
  carryoverMaxDays?: number | null;
  carryoverExpiryMonth?: number | null;
  /** The first day this figure applies to. Inclusive. */
  effectiveFrom: CalendarDate;
  /** The last day, or nothing for a standing rule. Inclusive. */
  effectiveTo?: CalendarDate | null;
  note?: string | null;
}

/**
 * A change to one.
 *
 * Only ever applied to a rule that has not yet taken effect; see
 * {@link assertMayBeCorrected}. Everything else is a new rule.
 */
export type EntitlementRuleChanges = Partial<NewEntitlementRule>;

/** A record as it comes back out. */
export interface EntitlementRule {
  id: string;
  leaveTypeId: string;
  employeeId: string | null;
  departmentId: string | null;
  entitlementDays: number;
  prorateOnJoin: boolean;
  carriesOver: boolean;
  carryoverMaxDays: number | null;
  carryoverExpiryMonth: number | null;
  effectiveFrom: CalendarDate;
  effectiveTo: CalendarDate | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedEntitlementRule {
  leaveTypeId: string;
  employeeId: string | null;
  departmentId: string | null;
  entitlementDays: number;
  prorateOnJoin: boolean;
  carriesOver: boolean;
  carryoverMaxDays: number | null;
  carryoverExpiryMonth: number | null;
  effectiveFrom: CalendarDate;
  effectiveTo: CalendarDate | null;
  note: string | null;
}

/**
 * Who is asking, and about which day.
 *
 * Both scope fields are required rather than optional, because every employee is
 * in exactly one department and a caller who does not know which is a caller
 * asking about nobody in particular. The day is required for the reason the whole
 * file exists: there is no undated form of this question.
 */
export interface AsAt {
  employeeId: string;
  departmentId: string;
  on: CalendarDate;
}

/**
 * The first day still open to change, or null where nothing has been closed.
 *
 * Supplied by the caller rather than read here, and it is a function rather than
 * a date because the answer moves: the year rollover of LMS 217 closes a year,
 * and a service holding a date read at start up would go on accepting rules into
 * it.
 *
 * LMS 205 brought `leave_year` and with it the real implementation:
 * {@link earliestOpenDayFrom} in ../services/leave-year-service.ts, which is the
 * day after the last closed year ends. That is what the composition root passes,
 * and swapping it in was the whole of what this seam was left for.
 */
export type EarliestOpenDay = () => Promise<CalendarDate | null>;

/**
 * No year has been closed.
 *
 * Still true of a fresh database, and still the answer
 * {@link earliestOpenDayOf} gives one — which is why this stayed after LMS 205
 * rather than being deleted with the seam it filled. It is what a caller that has
 * no leave years to read passes, and in this system that is a test asking what a
 * rule does when nothing is settled.
 */
export const NOTHING_IS_CLOSED_YET: EarliestOpenDay = async () => null;

/**
 * A rule that was refused, and the field that caused it.
 *
 * The same shape as {@link InvalidLeaveType} and for the same reason, NFR USA 03:
 * an error has to say what is wrong next to the input it is about, and this form
 * has two pairs of fields that can only be judged together.
 */
export class InvalidEntitlementRule extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidEntitlementRule';
    this.field = field;
  }
}

export class EntitlementRuleNotFound extends Error {
  readonly entitlementRuleId: string;

  constructor(id: string) {
    super(`No entitlement rule with id ${id}.`);
    this.name = 'EntitlementRuleNotFound';
    this.entitlementRuleId = id;
  }
}

/**
 * A rule that has already applied to somebody, being changed or removed.
 *
 * The refusal FR 31 is actually made of. It says what to do instead in the same
 * breath, because "you cannot change this" with no second sentence is how a rule
 * gets worked around: the answer is always another rule, from a later date, and
 * that is not a workaround — it is what changing an entitlement is.
 */
export class EntitlementRuleAlreadyApplies extends Error {
  readonly entitlementRuleId: string;
  readonly effectiveFrom: CalendarDate;

  constructor(id: string, effectiveFrom: CalendarDate, attempted: string) {
    super(
      `Entitlement rule ${id} has applied since ${effectiveFrom} and cannot be ${attempted}. ` +
        `Add a rule effective from a later date instead; the figure people were owed ` +
        `for days that have already passed does not change. FR 31.`,
    );
    this.name = 'EntitlementRuleAlreadyApplies';
    this.entitlementRuleId = id;
    this.effectiveFrom = effectiveFrom;
  }
}

/** A rule dated into a leave year that has already been closed off. FR 31. */
export class ReachesIntoAClosedYear extends Error {
  readonly effectiveFrom: CalendarDate;
  readonly earliestOpenDay: CalendarDate;

  constructor(effectiveFrom: CalendarDate, earliestOpenDay: CalendarDate) {
    super(
      `A rule cannot take effect from ${effectiveFrom}: leave years are closed up to ` +
        `${earliestOpenDay}, and a closed year is never recalculated. The earliest ` +
        `date this rule can start from is ${earliestOpenDay}. FR 31.`,
    );
    this.name = 'ReachesIntoAClosedYear';
    this.effectiveFrom = effectiveFrom;
    this.earliestOpenDay = earliestOpenDay;
  }
}

/** Two rules for the same thing on the same day, which has no answer. */
export class DuplicateEntitlementRule extends Error {
  constructor(effectiveFrom: CalendarDate) {
    super(
      `There is already a rule for that leave type and that scope effective from ` +
        `${effectiveFrom}. Two figures for one day have no order between them; ` +
        `change the one that is there, or start the new one on a different day.`,
    );
    this.name = 'DuplicateEntitlementRule';
  }
}

/**
 * Which rung a rule is on.
 *
 * Read off the scope fields rather than stored, so it cannot disagree with them.
 */
export function scopeOf(rule: Pick<EntitlementRule, 'employeeId' | 'departmentId'>): RuleScope {
  if (rule.employeeId !== null) {
    return 'EMPLOYEE';
  }

  return rule.departmentId !== null ? 'DEPARTMENT' : 'EVERYBODY';
}

/**
 * How specific a rule is, as a number, so that precedence is a comparison.
 *
 * The index into {@link RULE_SCOPES} rather than a hand written switch, so that a
 * fourth rung added to that list is a fourth rung here without anybody
 * remembering to come back — and so the two cannot get into different orders.
 */
export function specificityOf(rule: Pick<EntitlementRule, 'employeeId' | 'departmentId'>): number {
  return RULE_SCOPES.indexOf(scopeOf(rule));
}

/**
 * Whether the rule was in force on that day. Inclusive both ends.
 *
 * A string comparison, which is the whole reason a {@link CalendarDate} is ten
 * characters: `'2026-07-31' < '2026-08-01'` is true for every pair of dates in
 * this form, so there is no parsing, no zone and no library between the question
 * and the answer.
 */
export function coversDay(rule: EntitlementRule, day: CalendarDate): boolean {
  return rule.effectiveFrom <= day && (rule.effectiveTo === null || day <= rule.effectiveTo);
}

/**
 * Whether the rule is aimed at this person at all.
 *
 * A rule naming an employee is for that employee. A rule naming a department is
 * for everybody in it today — not for whoever was in it when the rule was
 * written, which would be a fourth kind of history and is not what a department
 * rule means. A rule naming neither is for everybody.
 */
export function appliesTo(
  rule: EntitlementRule,
  who: Pick<AsAt, 'employeeId' | 'departmentId'>,
): boolean {
  switch (scopeOf(rule)) {
    case 'EMPLOYEE':
      return rule.employeeId === who.employeeId;
    case 'DEPARTMENT':
      return rule.departmentId === who.departmentId;
    default:
      return true;
  }
}

/**
 * The order rules are considered in: most specific first, then latest.
 *
 * The third key is unreachable and is here anyway. Scope and starting day
 * together are unique — leave_entitlement_rule_one_per_scope_and_day — so two
 * candidates cannot tie on both, and once they cannot tie the sort is total. If
 * that index were ever dropped, this would still return the same answer twice
 * running rather than whichever row the planner happened to hand back first,
 * which is the kind of wrong that is invisible until the table grows.
 */
export function byPrecedence(left: EntitlementRule, right: EntitlementRule): number {
  const bySpecificity = specificityOf(right) - specificityOf(left);
  if (bySpecificity !== 0) {
    return bySpecificity;
  }

  if (left.effectiveFrom !== right.effectiveFrom) {
    return left.effectiveFrom < right.effectiveFrom ? 1 : -1;
  }

  /* Ids are bigints held as strings, so they are compared by length and then by
     character rather than as numbers: '9' is not greater than '10'. */
  return right.id.length - left.id.length || right.id.localeCompare(left.id);
}

/**
 * Every rule that could answer for this person on this day, best first.
 *
 * Exported beside {@link resolve} because a screen showing why somebody gets
 * twenty five days wants the whole list — the personal rule that won and the
 * company one it beat — and building that from a resolve call per rung would be a
 * second implementation of precedence in the interface layer.
 */
export function rulesInForce(
  rules: readonly EntitlementRule[],
  asAt: AsAt,
): readonly EntitlementRule[] {
  return rules
    .filter((rule) => appliesTo(rule, asAt) && coversDay(rule, asAt.on))
    .sort(byPrecedence);
}

/**
 * The figure that applies, or undefined where none does.
 *
 * Undefined is an answer rather than a failure, and the seeded data is why:
 * unpaid leave has no rule at all, because FR 32h is an arrangement agreed
 * occasion by occasion rather than an allowance. A caller has to decide what to
 * do about that, and a thrown error here would make every one of them catch it.
 *
 * Nor is it the same as a rule of zero days. Zero is HR saying this is worth
 * nothing to this person; undefined is nobody having said anything.
 */
export function resolve(
  rules: readonly EntitlementRule[],
  asAt: AsAt,
): EntitlementRule | undefined {
  return rulesInForce(rules, asAt)[0];
}

/**
 * Whether the rule is still a draft: dated to start after the day given.
 *
 * "Has not taken effect yet" is the whole of what makes a rule editable. A rule
 * starting today is in effect today — somebody may already have been told what
 * they are owed — so the comparison is strictly greater than.
 */
export function isStillADraft(rule: EntitlementRule, today: CalendarDate): boolean {
  return rule.effectiveFrom > today;
}

/**
 * Refuses a change to a rule that has already applied to somebody. FR 31.
 *
 * `attempted` is the word that goes in the message — "changed", "withdrawn" — so
 * that the refusal names what was actually being done rather than describing both
 * possibilities.
 */
export function assertMayBeCorrected(
  rule: EntitlementRule,
  today: CalendarDate,
  attempted = 'changed',
): void {
  if (!isStillADraft(rule, today)) {
    throw new EntitlementRuleAlreadyApplies(rule.id, rule.effectiveFrom, attempted);
  }
}

/**
 * Refuses a rule dated back into a year that has been closed. FR 31.
 *
 * The boundary is passed in because it belongs to a table this file does not know
 * about; see {@link EarliestOpenDay}. Null means nothing has been closed, which
 * is not the same as "no check": it is the check, answered.
 *
 * Only `effectiveFrom` is judged. A rule that starts inside an open year and ends
 * inside it or later cannot reach backwards at all, and one that starts in an open
 * year is by definition not rewriting a closed one.
 */
export function assertDoesNotReachIntoAClosedYear(
  effectiveFrom: CalendarDate,
  earliestOpenDay: CalendarDate | null,
): void {
  if (earliestOpenDay !== null && effectiveFrom < earliestOpenDay) {
    throw new ReachesIntoAClosedYear(effectiveFrom, earliestOpenDay);
  }
}

/**
 * Checks and tidies a new rule.
 *
 * Defaults are applied here rather than left to the column defaults, so the
 * record the caller gets back is the record that was written — the same decision
 * {@link validateNewLeaveType} makes and for the same reason.
 */
export function validateNewEntitlementRule(input: NewEntitlementRule): ValidatedEntitlementRule {
  const validated: ValidatedEntitlementRule = {
    leaveTypeId: requireId('leaveTypeId', input.leaveTypeId),
    employeeId: optionalId('employeeId', input.employeeId),
    departmentId: optionalId('departmentId', input.departmentId),
    entitlementDays: requireDays(input.entitlementDays),
    prorateOnJoin: input.prorateOnJoin ?? false,
    carriesOver: input.carriesOver ?? false,
    carryoverMaxDays: optionalPositive('carryoverMaxDays', input.carryoverMaxDays),
    carryoverExpiryMonth: optionalMonth(input.carryoverExpiryMonth),
    effectiveFrom: requireDay('effectiveFrom', input.effectiveFrom),
    effectiveTo: optionalDay('effectiveTo', input.effectiveTo),
    note: optionalText('note', input.note),
  };

  assertRuleHangsTogether(validated);

  return validated;
}

/**
 * Checks and tidies a change to a rule that has not taken effect yet.
 *
 * Takes the current record, like {@link validateLeaveTypeChanges}, because both
 * pairs of fields that have to agree can be half mentioned: setting
 * `carryoverMaxDays` alone has to be judged against the `carriesOver` already on
 * the row, and moving `effectiveFrom` alone against the `effectiveTo` already
 * there.
 */
export function validateEntitlementRuleChanges(
  changes: EntitlementRuleChanges,
  current: EntitlementRule,
): Partial<ValidatedEntitlementRule> {
  const validated: Partial<ValidatedEntitlementRule> = {};

  if ('leaveTypeId' in changes) {
    validated.leaveTypeId = requireId('leaveTypeId', changes.leaveTypeId);
  }
  if ('employeeId' in changes) {
    validated.employeeId = optionalId('employeeId', changes.employeeId);
  }
  if ('departmentId' in changes) {
    validated.departmentId = optionalId('departmentId', changes.departmentId);
  }
  if ('entitlementDays' in changes) {
    validated.entitlementDays = requireDays(changes.entitlementDays);
  }
  if ('prorateOnJoin' in changes) {
    validated.prorateOnJoin = requireBoolean('prorateOnJoin', changes.prorateOnJoin);
  }
  if ('carriesOver' in changes) {
    validated.carriesOver = requireBoolean('carriesOver', changes.carriesOver);
  }
  if ('carryoverMaxDays' in changes) {
    validated.carryoverMaxDays = optionalPositive('carryoverMaxDays', changes.carryoverMaxDays);
  }
  if ('carryoverExpiryMonth' in changes) {
    validated.carryoverExpiryMonth = optionalMonth(changes.carryoverExpiryMonth);
  }
  if ('effectiveFrom' in changes) {
    validated.effectiveFrom = requireDay('effectiveFrom', changes.effectiveFrom);
  }
  if ('effectiveTo' in changes) {
    validated.effectiveTo = optionalDay('effectiveTo', changes.effectiveTo);
  }
  if ('note' in changes) {
    validated.note = optionalText('note', changes.note);
  }

  assertRuleHangsTogether({ ...editableHalfOf(current), ...validated });

  return validated;
}

/**
 * The three rules that span more than one field, judged against the record as it
 * will be.
 *
 * Each of them is also a constraint in the entitlement-rule-effective-dates
 * migration, and neither copy is redundant: the constraint makes the row
 * impossible for every writer, and this says which field to look at.
 */
function assertRuleHangsTogether(rule: ValidatedEntitlementRule): void {
  if (rule.employeeId !== null && rule.departmentId !== null) {
    throw new InvalidEntitlementRule(
      'departmentId',
      'A rule names an employee or a department, never both. Somebody is already in ' +
        'exactly one department, so a rule naming both is either saying the same thing ' +
        'twice or contradicting itself.',
    );
  }

  if (rule.effectiveTo !== null && rule.effectiveTo < rule.effectiveFrom) {
    throw new InvalidEntitlementRule(
      'effectiveTo',
      `A rule cannot end on ${rule.effectiveTo}, before it starts on ${rule.effectiveFrom}. ` +
        'Leave the end date empty for a rule with no end in sight.',
    );
  }

  if (!rule.carriesOver && (rule.carryoverMaxDays !== null || rule.carryoverExpiryMonth !== null)) {
    throw new InvalidEntitlementRule(
      'carriesOver',
      'A carry over cap or expiry month means nothing where unused days do not carry ' +
        'over at all. Either turn carrying over on, or clear both.',
    );
  }
}

/** The editable half of a stored record, so a change can be judged against it. */
function editableHalfOf(rule: EntitlementRule): ValidatedEntitlementRule {
  return {
    leaveTypeId: rule.leaveTypeId,
    employeeId: rule.employeeId,
    departmentId: rule.departmentId,
    entitlementDays: rule.entitlementDays,
    prorateOnJoin: rule.prorateOnJoin,
    carriesOver: rule.carriesOver,
    carryoverMaxDays: rule.carryoverMaxDays,
    carryoverExpiryMonth: rule.carryoverExpiryMonth,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    note: rule.note,
  };
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEntitlementRule(field, `A rule has to name a ${labelFor(field)}.`);
  }

  return value.trim();
}

function optionalId(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return requireId(field, value);
}

/**
 * FR 24. Whole days, and never a negative allowance.
 *
 * Zero is allowed on purpose. "This type is worth nothing to this person" is a
 * decision somebody may need to record — a rule that ends an inherited departmental
 * allowance without waiting for the department rule to end — and it reads
 * differently from having no rule at all.
 */
function requireDays(value: unknown): number {
  if (!isWholeDays(value) || value < 0) {
    throw new InvalidEntitlementRule(
      'entitlementDays',
      `An entitlement is a whole number of days and cannot be negative. ${WHOLE_DAYS_ONLY}`,
    );
  }

  return value;
}

function optionalPositive(field: string, value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isWholeDays(value) || value <= 0) {
    throw new InvalidEntitlementRule(
      field,
      `${labelFor(field)} is a whole number of days above zero, or nothing at all. ` +
        'Carrying a maximum of no days is not carrying over; turn carrying over off ' +
        `instead. ${WHOLE_DAYS_ONLY}`,
    );
  }

  return value;
}

function optionalMonth(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 12) {
    throw new InvalidEntitlementRule(
      'carryoverExpiryMonth',
      'The month carried days expire in is 1 to 12, or nothing where they never expire.',
    );
  }

  return value;
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidEntitlementRule(
      field,
      `${labelFor(field)} is a date in the form YYYY-MM-DD. An entitlement changes on a ` +
        'day, so it is written as one — 31/07/2026 and 07/31/2026 are the same eleven ' +
        'characters meaning two different days.',
    );
  }

  return value;
}

function optionalDay(field: string, value: unknown): CalendarDate | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return requireDay(field, value);
}

function requireBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidEntitlementRule(field, `${labelFor(field)} is either true or false.`);
  }

  return value;
}

function optionalText(field: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new InvalidEntitlementRule(field, `${labelFor(field)} is text.`);
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

/** A field name as a person reads it, for the one place a message needs it. */
function labelFor(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').toLowerCase();
}
