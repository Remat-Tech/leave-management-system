/**
 * Who may see and change a leave type. NFR SEC 02. §10. LMS 112. FR 21, LMS 201.
 *
 * The third policy about the shape of the organisation rather than about a
 * person, and it runs the same way as ./department-policy.ts and
 * ./work-pattern-policy.ts: reading is open to anybody signed in, writing is an
 * HR Administrator's.
 *
 * ## Reading is open, and has to be
 *
 * A leave type is the rules themselves — how many days' notice, whether a
 * certificate is wanted after two days, whether a weekend inside the request
 * costs anything. Every one of those is something an employee has to know
 * *before* they raise a request, and a system that refuses to say is a system
 * where the rule is discovered by being refused by it.
 *
 * It is also not a record about anybody. The whole table is a dozen rows of
 * policy, and the only one with a person-shaped field on it is the gender
 * restriction — which names a category, not a colleague. Which types a
 * *particular* employee is eligible for is a question about their record, and
 * ./employee-policy.ts guards that.
 *
 * The story is an HR Administrator's, so it would have been easy to make the
 * whole resource theirs. That would have been wrong in the direction that
 * matters: the person who most needs to read a notice window is the one about to
 * miss it.
 *
 * ## Writing is an HR Administrator's
 *
 * The story says so in its first four words, and {@link SETS_UP_THE_ORGANISATION}
 * is already the name for exactly this: a change that alters what the system does
 * to everybody without touching a single employee record. Moving annual leave
 * from working days to calendar days changes what every future request costs, and
 * shortening an expiry can take days off people who had banked them.
 *
 * That is a wider blast radius than closing a department, and it is the same
 * role, which is worth being deliberate about rather than letting it happen by
 * pattern matching. The answer is that HR_ADMIN is the rank this system has for
 * "decides policy"; a fifth role between officer and administrator would be a
 * change to ./roles.ts with an argument of its own, not something to invent here.
 *
 * ## Retiring is not an ordinary edit, and neither is the approval chain
 *
 * Each gets its own decision so that the log says which happened. "The
 * administrator changed the maternity type", "the administrator stopped anybody
 * requesting maternity leave" and "the administrator changed who approves
 * maternity leave" are three different sentences, and a shared `update` would
 * have written the first for all three.
 *
 * The chain is the one where that matters most, because it is the change whose
 * effect nobody sees directly: a request that goes to the wrong desk does not
 * fail, it waits. FR 38a, LMS 204. It is the same role as every other write here
 * — an HR Administrator's — and it is named apart rather than guarded apart.
 */

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

  /** One type, by id, code or name. Anybody signed in. */
  read(actor: Actor, leaveTypeId: string | null = null): Decision {
    return about.allow(actor, 'read', leaveTypeId);
  },

  /** Every type, or the ones still offered. What a request form offers as choices. */
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

  /** FR 38a. Saying who approves this kind of leave. Named apart, so the log is. */
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

  /** Taking a type out of use, and putting it back. Named apart, so the log is. */
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
