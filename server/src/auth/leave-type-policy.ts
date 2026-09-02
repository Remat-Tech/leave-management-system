/** Who may see and change a leave type. NFR SEC 02, §10., LMS 112, FR 21, LMS 201, FR 38a, LMS 204. */

import { type Actor, holdsAny } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { SETS_UP_THE_ORGANISATION } from './roles.js';

const about = policyFor('leave type');

/** Said openly in every case, because anybody who reaches it can already read types. */
const WRITES_ARE_ADMINISTRATIVE =
  'Leave types are set up by an HR Administrator, because changing one changes ' +
  'what leave costs and who may take it for everybody. Ask one.';

export const leaveTypePolicy = {
  resource: about.resource,

  /** One type, by id, code or name. */
  read(actor: Actor, leaveTypeId: string | null = null): Decision {
    return about.allow(actor, 'read', leaveTypeId);
  },

  /** Every type, or the ones still offered. */
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

  update(actor: Actor, leaveTypeId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'update', leaveTypeId)
      : about.refuseOpenly(
          actor,
          'update',
          leaveTypeId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** FR 38a. */
  setApprovalChain(actor: Actor, leaveTypeId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'set approval chain', leaveTypeId)
      : about.refuseOpenly(
          actor,
          'set approval chain',
          leaveTypeId,
          'holds no role that sets up the organisation',
          'Who approves a kind of leave is set by an HR Administrator, because it ' +
            'decides where every future request of that kind goes. Ask one.',
        );
  },

  /** Taking a type out of use, and putting it back. */
  retire(actor: Actor, leaveTypeId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'retire', leaveTypeId)
      : about.refuseOpenly(
          actor,
          'retire',
          leaveTypeId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  reinstate(actor: Actor, leaveTypeId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'reinstate', leaveTypeId)
      : about.refuseOpenly(
          actor,
          'reinstate',
          leaveTypeId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },
};
