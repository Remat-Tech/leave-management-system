/** A count of days is a whole number. FR 24, §7.3., LMS 209, §8.6. */

/** Whether this is a number of days this system can record. FR 24. */
export function isWholeDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Why half a day is not a number this system takes, for the messages that say so. */
export const WHOLE_DAYS_ONLY =
  'Leave is recorded in whole days. Half days are settled between an employee and ' +
  'their manager, do not come off any balance, and are deliberately not in this ' +
  'system. FR 24.';
