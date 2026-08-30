/**
 * Who may see and keep the public holiday calendar. FR 22, NFR SEC 02. §10.
 * LMS 112, LMS 206.
 *
 * The sixth policy about the shape of the working year rather than about a
 * person, and the first one whose writes are not an HR Administrator's. That is
 * the whole of what is interesting here, so it is worth being explicit about why
 * rather than letting it look like an inconsistency.
 *
 * ## Reading is open, and this one barely needs arguing
 *
 * A public holiday is published in the national gazette and is on the front page
 * of every newspaper in Accra. There is nothing to protect, and there is a great
 * deal to lose by hiding it: somebody planning a fortnight off in December wants to
 * know that two of those days are free, and a system that would not say so is a
 * system they plan around by asking a colleague.
 *
 * ## Writing is an HR Officer's, unlike every other table in §5.5
 *
 * ./leave-type-policy.ts, ./entitlement-rule-policy.ts and ./leave-year-policy.ts
 * all reserve their writes to {@link SETS_UP_THE_ORGANISATION}, and the reason
 * given each time is that those tables hold decisions about what leave costs
 * everybody. This one does not hold a decision at all. It holds a transcription of
 * the Public Holidays Act and of whatever the Minister for the Interior gazetted
 * this week, and there is no policy judgement in typing it in — which is why it is
 * {@link MAINTAINS_THE_CALENDAR}, the desk people actually walk up to.
 *
 * The failure the wider rule prevents is worth stating too, because it is the one
 * that would actually happen. A holiday declared on the Tuesday for the Friday is
 * a two minute job. Make an HR Officer raise a ticket for it and the calendar runs
 * a week behind the country by March — and a calendar behind the country charges
 * somebody a day of annual leave for an afternoon nobody worked, which is exactly
 * what the story exists to prevent.
 *
 * ## Removing is named apart from editing
 *
 * The same reason retiring a leave type and closing a leave year are. "The officer
 * moved Eid al-Fitr to the twenty first" and "the officer took Eid al-Fitr off the
 * calendar" are not the same sentence, and only the second one puts a working day
 * back into somebody's leave. A shared `update` decision would have written the
 * first for both, and the denial log would be thinnest exactly where somebody
 * needs it to be specific.
 *
 * What stops a removal reaching a year that is settled is not here. It is
 * `assertNotInASettledYear` in ../domain/holiday.ts and a trigger beside it, which
 * is the right place for it: this file answers who, and that one answers when.
 */

import { type Actor, holdsAny } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { MAINTAINS_THE_CALENDAR } from './roles.js';

const about = policyFor('holiday');

/** Said openly in every case, because anybody who reaches it can already read the calendar. */
const WRITES_ARE_HR =
  'The public holiday calendar is kept by HR, because a day everybody had off has ' +
  'to be a day nobody is charged for. Ask an HR Officer.';

export const holidayPolicy = {
  resource: about.resource,

  /** One day, by id or by the date. Anybody signed in; it is in the gazette. */
  read(actor: Actor, holidayId: string | null = null): Decision {
    return about.allow(actor, 'read', holidayId);
  },

  /** The calendar, or a stretch of it. What every screen showing a month reads. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },

  create(actor: Actor): Decision {
    return holdsAny(actor, ...MAINTAINS_THE_CALENDAR)
      ? about.allow(actor, 'create')
      : about.refuseOpenly(
          actor,
          'create',
          null,
          'holds no role that keeps the holiday calendar',
          WRITES_ARE_HR,
        );
  },

  update(actor: Actor, holidayId: string): Decision {
    return holdsAny(actor, ...MAINTAINS_THE_CALENDAR)
      ? about.allow(actor, 'update', holidayId)
      : about.refuseOpenly(
          actor,
          'update',
          holidayId,
          'holds no role that keeps the holiday calendar',
          WRITES_ARE_HR,
        );
  },

  /**
   * Taking a day off the calendar. Named apart, so the log is.
   *
   * The one write here that puts a working day back into everybody's leave, so
   * "who removed the twenty eighth of December" has to be findable as its own
   * sentence rather than as another "changed a holiday".
   */
  remove(actor: Actor, holidayId: string): Decision {
    return holdsAny(actor, ...MAINTAINS_THE_CALENDAR)
      ? about.allow(actor, 'remove', holidayId)
      : about.refuseOpenly(
          actor,
          'remove',
          holidayId,
          'holds no role that keeps the holiday calendar',
          'Taking a day off the holiday calendar makes it a working day again for ' +
            'everybody, so it is for HR to do. Ask an HR Officer.',
        );
  },
};
