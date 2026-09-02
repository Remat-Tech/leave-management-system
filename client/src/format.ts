/**
 * Turning what the server sent into what a person reads. LMS 401, LMS 402.
 *
 * Four functions, and the line they all sit on the safe side of is the one `./api.ts` draws:
 * **nothing in the browser computes a leave figure.** These decide how many decimal places to
 * print, whether to keep a sign, and which capital letter a sentence starts with. None of them
 * takes two numbers.
 *
 * They live here rather than in a page because there are two pages now and there were about to
 * be two copies. A second `toFixed(2)` written for the history screen is the kind of duplicate
 * that stays correct for a year and then quietly rounds one screen differently from the other.
 */

/**
 * A number of days, as it is written down.
 *
 * **Not rounding, and not arithmetic.** The server sends figures already at the precision its
 * columns hold — two decimal places, because §8.6d pro rates a mid year joiner to 10.08 days —
 * and this only decides whether to print the decimals. A whole number shows as `20`, because
 * "20.00 days" reads like a bank statement; anything else shows both places, because 10.08 and
 * 10.8 are different figures and dropping a zero makes them look alike.
 *
 * `toFixed(2)` on a value the server has already rounded cannot change it. If it ever appears
 * to, the bug is upstream and hiding it here would be the worst possible response.
 */
export function days(figure: number): string {
  return Number.isInteger(figure) ? String(figure) : figure.toFixed(2);
}

/** Days with their unit, where the unit has to agree with the number. */
export function inDays(figure: number): string {
  return `${days(figure)} ${figure === 1 ? 'day' : 'days'}`;
}

/** An adjustment, with its sign kept. "+3" and "−2" are different news. */
export function signed(figure: number): string {
  if (figure === 0) {
    return '0';
  }

  return figure > 0 ? `+${days(figure)}` : `−${days(Math.abs(figure))}`;
}

/** The server writes its sentences to sit mid-line; a heading starts one. */
export function sentenceCase(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * An instant, in the reader's own time zone.
 *
 * **The one place this client converts anything, and the only kind of value it may be done
 * to.** `./api.ts` is emphatic that a calendar date — `2026-12-31`, the day a leave year ends
 * or a holiday starts — is never handed to `new Date()`, because it carries no zone and
 * converting one is how the last day of the year becomes the second to last west of Greenwich.
 *
 * A decision's `decidedAt` is not that. It is a moment in time, sent as ISO 8601 in UTC, and
 * the honest rendering of a moment is the reader's own clock: "approved at 09:14" should mean
 * the time on the wall of the person reading it.
 *
 * The locale is deliberately not named. `undefined` is the browser's own setting, which is the
 * reader's, rather than a guess made here about where they are.
 */
export function moment(iso: string): string {
  const at = new Date(iso);

  /* A malformed instant renders as itself rather than as "Invalid Date". Nothing in this
     application should send one, and a screen that printed those two words beside somebody's
     refused leave would be a worse answer than the raw value. */
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
