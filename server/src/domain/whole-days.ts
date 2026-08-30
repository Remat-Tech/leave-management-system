/**
 * A count of days is a whole number. FR 24, §7.3. LMS 209.
 *
 * "Leave shall be recorded in whole days only. Half days are handled informally
 * between the employee and their manager, do not reduce any leave balance, and are
 * out of scope for this system." That is the whole policy, and this file is the one
 * place the system knows it.
 *
 * ## Why a file, for four lines
 *
 * Because the rule was already written four times. `entitlement-rule.ts` refused a
 * fraction of an allowance, `leave-type.ts` refused a fraction of a notice window
 * and a fraction of a backdating one, and each did it with its own copy of
 * `Number.isInteger` — which is the arrangement §8.6d warns about in the only other
 * place a figure is computed twice: "there must be exactly one implementation of it.
 * Two will drift, and the one that drifts is always the one used less often."
 *
 * A drifting copy of this rule is not a crash. It is a screen that accepts 0.5 for
 * one figure and refuses it for another, and nobody finds out which until a balance
 * reads 19.5 days and no ledger entry explains the half.
 *
 * ## Refused, never rounded
 *
 * This is a predicate rather than a `roundToWholeDays()`, and the absence of the
 * second function is the decision. A half day rounded up is a day the person did not
 * take and is charged for. Rounded down it is a day the company gives away. Rounded
 * to even it is both, alternately, and no one of the three announces itself — the
 * number simply comes out slightly wrong, in a system whose entire claim is that the
 * number can be explained.
 *
 * So the fraction is refused where it arrives, at the boundary, while somebody still
 * has the form open and can say what they meant. That is also why the callers keep
 * their own error types: {@link InvalidLeaveType} and {@link InvalidEntitlementRule}
 * each carry the field the message has to appear beside, and a shared thrower would
 * have to invent a third that reaches no form at all.
 *
 * ## A whole number, and one that can be counted
 *
 * {@link isWholeDays} asks {@link Number.isSafeInteger} rather than
 * {@link Number.isInteger}, and the difference matters once rather than never:
 * `Number.isInteger(2 ** 53 + 1)` is true, and `2 ** 53 + 1 === 2 ** 53` is also
 * true, so a figure past that point is a whole number that no longer adds up. Every
 * caller bounds its own range far below this — twenty days, fourteen days of notice
 * — and none of them should have to think about it. The floor of "arithmetic on this
 * value still works" belongs here.
 *
 * It also refuses a number written as text. `'20'` is not twenty days; it is a
 * caller that has not parsed its input, and coercing it here would mean the day a
 * `NUMERIC` column arrives from the driver as `'20.00'` the system reads twenty and
 * says nothing. Nothing in this schema is `NUMERIC` — the migrations are held to
 * that, see unit/migrations.test.ts — and this is the second lock on the same door.
 *
 * ## What is deliberately not here
 *
 * **The schema half.** "No half day flags in the schema or the API" is enforced
 * against the SQL and the source rather than at runtime, because a column is not a
 * value that can be validated: by the time one exists it is already the second place
 * this rule lives. unit/migrations.test.ts asserts that no migration declares a
 * fractional column type and that nothing anywhere is named for a half day.
 *
 * **A count of anything else.** ./leave-type.ts validates its documentation
 * threshold, in days, beside its entitlement expiry window, in months, and the two
 * share a function. A count of months is not FR 24's subject, but it is the same
 * arithmetic and refusing it a near-copy of this predicate a few lines away is how
 * the four copies happened in the first place. It asks this one.
 *
 * An *ordinal* is a different thing and keeps its own check: a day of the week and a
 * month of the year are positions rather than quantities, and 1.5 there is not half
 * of anything — it is neither Monday nor Tuesday.
 */

/**
 * Whether this is a number of days this system can record. FR 24.
 *
 * True for a whole number, including zero and including a negative one: whether a
 * figure may be zero, or below it, is each caller's rule and each of them states it
 * separately. This answers only whether the value is a count of days at all.
 */
export function isWholeDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Why half a day is not a number this system takes, for the messages that say so.
 *
 * One sentence rather than each refusal wording it again, because a person who meets
 * it twice in one form should meet the same explanation — and because the reason is
 * the useful part. "0.5 is not a whole number" tells somebody what they already
 * know; this tells them where the morning off actually goes.
 */
export const WHOLE_DAYS_ONLY =
  'Leave is recorded in whole days. Half days are settled between an employee and ' +
  'their manager, do not come off any balance, and are deliberately not in this ' +
  'system. FR 24.';
