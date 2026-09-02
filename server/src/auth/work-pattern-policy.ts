/** Who may see and change a working pattern. NFR SEC 02, §10., LMS 112, FR 23, LMS 106. */

import { type Actor, holdsAny } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { READS_EVERY_RECORD, SETS_UP_THE_ORGANISATION } from './roles.js';

const about = policyFor('work pattern');

/** Said openly in every case, because anybody who reaches it can already read patterns. */
const WRITES_ARE_ADMINISTRATIVE =
  'Working patterns are set up by an HR Administrator, because changing one ' +
  'changes what a day off costs for everybody on it. Ask one.';

export const workPatternPolicy = {
  resource: about.resource,

  /** One pattern, by id or by name. */
  read(actor: Actor, workPatternId: string | null = null): Decision {
    return about.allow(actor, 'read', workPatternId);
  },

  /** Every pattern, and the default among them. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },

  /** How many employee records are on one, leavers included. */
  headcount(actor: Actor, workPatternId: string): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'headcount', workPatternId)
      : about.refuseOpenly(
          actor,
          'headcount',
          workPatternId,
          'holds no role that reads everybody',
          'How many people work a pattern is something HR can tell you.',
        );
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

  update(actor: Actor, workPatternId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'update', workPatternId)
      : about.refuseOpenly(
          actor,
          'update',
          workPatternId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** Choosing the week a joiner gets when nobody says otherwise. */
  makeDefault(actor: Actor, workPatternId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'makeDefault', workPatternId)
      : about.refuseOpenly(
          actor,
          'makeDefault',
          workPatternId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** Deleting one. */
  remove(actor: Actor, workPatternId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'remove', workPatternId)
      : about.refuseOpenly(
          actor,
          'remove',
          workPatternId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },
};
