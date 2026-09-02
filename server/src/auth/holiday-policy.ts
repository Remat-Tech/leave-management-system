/**
 * Who may see and keep the public holiday calendar. FR 22, NFR SEC 02, §10., LMS 112, LMS 206, §5.5.
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

  /** One day, by id or by the date. */
  read(actor: Actor, holidayId: string | null = null): Decision {
    return about.allow(actor, 'read', holidayId);
  },

  /** The calendar, or a stretch of it. */
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

  /** Taking a day off the calendar. */
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
