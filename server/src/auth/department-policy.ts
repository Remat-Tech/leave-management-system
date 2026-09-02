/** Who may see and change a department. NFR SEC 02, §10., LMS 112, LMS 105. */

import { type Actor, holdsAny } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { READS_EVERY_RECORD, SETS_UP_THE_ORGANISATION } from './roles.js';

const about = policyFor('department');

/** The sentence a refused write gives. */
const WRITES_ARE_ADMINISTRATIVE =
  'Teams are set up and closed by an HR Administrator, because doing it changes ' +
  'how leave is reported for everybody in them. Ask one.';

export const departmentPolicy = {
  resource: about.resource,

  /** One team, by id or by name. */
  read(actor: Actor, departmentId: string | null = null): Decision {
    return about.allow(actor, 'read', departmentId);
  },

  /** The list of teams. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },

  /** How many people are still employed in one. */
  headcount(actor: Actor, departmentId: string): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'headcount', departmentId)
      : about.refuseOpenly(
          actor,
          'headcount',
          departmentId,
          'holds no role that reads everybody',
          'How many people are in a team is something HR can tell you.',
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

  update(actor: Actor, departmentId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'update', departmentId)
      : about.refuseOpenly(
          actor,
          'update',
          departmentId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** Closing one. */
  close(actor: Actor, departmentId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'close', departmentId)
      : about.refuseOpenly(
          actor,
          'close',
          departmentId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** And undoing that. */
  reopen(actor: Actor, departmentId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'reopen', departmentId)
      : about.refuseOpenly(
          actor,
          'reopen',
          departmentId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },
};
