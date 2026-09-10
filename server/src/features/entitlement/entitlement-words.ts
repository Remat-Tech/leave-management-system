/** What an entitlement rule says, in words. FR 31, LMS 502. */

import { type CalendarDate, formatDay } from '../../shared/time.js';
import {
  type EntitlementRule,
  isStillADraft,
  type RuleScope,
  scopeOf,
} from './entitlement-rule.js';

/** The names a rule's ids stand for, looked up by whoever has the tables. */
export interface RuleNames {
  leaveTypeName: string;
  employeeName: string | null;
  departmentName: string | null;
}

const SCOPE_LABELS: Record<RuleScope, string> = {
  EVERYBODY: 'Everybody',
  DEPARTMENT: 'One department',
  EMPLOYEE: 'One person',
};

/** How narrowly a rule is aimed, as a label on a control. */
export function scopeLabel(scope: RuleScope): string {
  return SCOPE_LABELS[scope];
}

/** Who the rule is for, named where it names somebody. */
export function whoInWords(rule: EntitlementRule, names: RuleNames): string {
  switch (scopeOf(rule)) {
    case 'EMPLOYEE':
      return names.employeeName ?? 'One person';
    case 'DEPARTMENT':
      return names.departmentName ?? 'One department';
    default:
      return 'Everybody';
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * FR 31. What unused days do at the year end.
 *
 * Written short because of where it is read: a footnote on a card three to a row, where
 * "Unused days carry over, uncapped, and do not expire" wrapped to three lines. The subject
 * is the card it sits on, so it does not need naming again.
 */
export function carryoverInWords(rule: EntitlementRule): string {
  if (!rule.carriesOver) {
    return 'No carry over.';
  }

  const cap =
    rule.carryoverMaxDays === null
      ? 'Carries over, uncapped'
      : `Carries over, up to ${inDays(rule.carryoverMaxDays)}`;

  const month = rule.carryoverExpiryMonth;

  return month === null ? `${cap}, never expires.` : `${cap}, expires end of ${MONTHS[month - 1]}.`;
}

/** The days a rule is in force for. */
export function periodInWords(rule: EntitlementRule): string {
  return rule.effectiveTo === null
    ? `From ${formatDay(rule.effectiveFrom)}, until a later rule replaces it`
    : `${formatDay(rule.effectiveFrom)} to ${formatDay(rule.effectiveTo)}`;
}

/** The whole rule in one sentence. */
export function ruleInWords(rule: EntitlementRule, names: RuleNames): string {
  const prorata = rule.prorateOnJoin ? ', pro rata in the year somebody joins' : '';

  return (
    `${whoInWords(rule, names)}: ${inDays(rule.entitlementDays)} of ${names.leaveTypeName}` +
    `${prorata}. ${periodInWords(rule)}.`
  );
}

/**
 * What fixes this rule, or null while it can still be edited. FR 31.
 *
 * The screen greys a button on it, so the sentence is the server's rather than the
 * browser's — the same rule `assertMayBeCorrected` throws.
 */
export function fixedReason(rule: EntitlementRule, today: CalendarDate): string | null {
  return isStillADraft(rule, today)
    ? null
    : `This rule started on ${formatDay(rule.effectiveFrom)}, so it can no longer be ` +
        'changed. To use a different figure, add a new rule that starts on a later date.';
}

/** The boundary a closed year sets, said where a date picker can act on it. FR 31. */
export function closedYearsInWords(earliestOpenDay: CalendarDate | null): string {
  return earliestOpenDay === null
    ? 'No leave year has been closed, so a rule may start on any day.'
    : `Leave years are closed up to ${formatDay(earliestOpenDay)}. A rule cannot start ` +
        'before then; a closed year is never recalculated.';
}

function inDays(count: number): string {
  return `${String(count)} ${count === 1 ? 'day' : 'days'}`;
}
