/** Who may see and close a leave year. NFR SEC 02, §10., LMS 112, LMS 205, FR 36. */

import { type Actor, holdsAny } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { SETS_UP_THE_ORGANISATION } from './roles.js';

const about = policyFor('leave year');

/** Said openly in every case, because anybody who reaches it can already read years. */
const WRITES_ARE_ADMINISTRATIVE =
  'Leave years are set up by an HR Administrator, because when the year ends ' +
  'decides when unused leave carries over for everybody. Ask one.';

export const leaveYearPolicy = {
  resource: about.resource,

  /** One year, by id, label, or the day it covers. */
  read(actor: Actor, leaveYearId: string | null = null): Decision {
    return about.allow(actor, 'read', leaveYearId);
  },

  /** Every year. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },

  create(actor: Actor): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'create')
      : about.refuseOpenly(
          actor,
          'create',
          null,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  update(actor: Actor, leaveYearId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'update', leaveYearId)
      : about.refuseOpenly(
          actor,
          'update',
          leaveYearId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** Settling a year for good. */
  close(actor: Actor, leaveYearId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'close', leaveYearId)
      : about.refuseOpenly(
          actor,
          'close',
          leaveYearId,
          'holds no role that sets up the organisation',
          'Closing a leave year settles every balance in it for good, so it is for ' +
            'an HR Administrator to do. Ask one.',
        );
  },
};
