/** Turning what the server sent into what a person reads. LMS 401, LMS 402. */

/** A number of days, as it is written down. §8.6. */
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
 * Where a request stands, as the one word that goes in a pill. LMS 409.
 *
 * **Not the server's `statusInWords`**, which is a sentence — "waiting to be decided" — written
 * to be read mid-paragraph. It still says what it says wherever there is room for a sentence;
 * this is the label on a pill, where a sentence wraps to three lines and stops being scannable.
 *
 * Presentation of an enum the wire already carries, not a rule: nothing is decided from it, and
 * a status this does not know falls back to the server's own words rather than to a guess.
 */
export function statusLabel(status: string, inWords: string): string {
  switch (status) {
    case 'SUBMITTED':
      return 'Submitted';
    case 'APPROVED':
      return 'Approved';
    case 'REFUSED':
      return 'Refused';
    case 'WITHDRAWN':
      return 'Withdrawn';
    case 'CANCELLED':
      return 'Cancelled';
    /** FR 48b. Nobody could be found to decide it, which is not a word anybody would guess. */
    case 'UNROUTABLE':
      return 'Nobody to approve';
    default:
      return sentenceCase(inWords);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A calendar date, as a person writes one. LMS 409.
 *
 * **Read off the ten characters, never parsed.** `2026-05-12` becomes `12 May 2026` by slicing
 * and a lookup — `new Date()` is not called here and must not be, for the reason {@link moment}
 * sets out: a calendar date carries no zone, and converting one is how the last day of a leave
 * year becomes the second to last west of Greenwich. NFR DAT 03.
 *
 * Anything that is not ten characters of the expected shape comes back as itself.
 */
export function day(iso: string): string {
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  const dayOfMonth = Number(iso.slice(8, 10));

  return month === undefined || Number.isNaN(dayOfMonth) || dayOfMonth === 0
    ? iso
    : `${String(dayOfMonth)} ${month} ${iso.slice(0, 4)}`;
}

/**
 * Two of them as one period, with whatever they share said once.
 *
 * "12–16 May 2026" rather than "12 May 2026 to 16 May 2026". The month and the year are the
 * same fact twice, and a column of these is read by its numbers.
 */
export function period(from: string, to: string): string {
  const first = day(from);
  const last = day(to);

  if (from === to) {
    return first;
  }

  /* Fell back to the raw ten characters, so neither may be taken apart. */
  if (first === from || last === to) {
    return `${from} to ${to}`;
  }

  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const sameMonth = sameYear && from.slice(5, 7) === to.slice(5, 7);

  if (sameMonth) {
    return `${String(Number(from.slice(8, 10)))}–${last}`;
  }

  return sameYear ? `${first.slice(0, first.lastIndexOf(' '))} – ${last}` : `${first} – ${last}`;
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
