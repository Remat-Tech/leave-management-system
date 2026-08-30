/**
 * Who may see and close a leave year. NFR SEC 02. §10. LMS 112, LMS 205.
 *
 * The fifth policy about the shape of the organisation rather than about a
 * person, and it runs like the first three: reading is open to anybody signed in,
 * writing is an HR Administrator's. ./entitlement-rule-policy.ts is the one that
 * departs from that, and only because its table has a person-shaped field on it.
 * This one has nothing but dates.
 *
 * ## Reading is open, and has to be
 *
 * When the leave year ends is the single most planned-around date in the system.
 * It is when unused annual leave carries over or is lost — FR 36 — and it is why
 * December is the month everybody books. An employee who cannot find out when
 * their year ends is an employee who finds out by losing days.
 *
 * Whether a year is *closed* is equally open, and that is worth being deliberate
 * about rather than letting it follow. "Last year is settled" is the answer to
 * "why can nobody change my 2026 figure now", and a system that would not say so
 * turns a clear answer into an argument.
 *
 * ## Closing is named apart from editing
 *
 * The same reason retiring a leave type is. "The administrator changed the dates
 * of 2026" and "the administrator closed 2026" are not the same sentence, and the
 * second is irreversible — there is no reopen in this system, by design. A shared
 * `update` decision would have written the first for both, and the denial log
 * would have been thinnest exactly where somebody most needs it to be specific.
 *
 * It is the same role as every other write here. A fifth role between officer and
 * administrator would be a change to ./roles.ts with an argument of its own, not
 * something to invent for one operation — but it is worth recording that closing
 * a leave year is the largest single act an HR Administrator can perform in this
 * system, and that it is the audit log rather than the policy that makes it
 * answerable afterwards.
 */

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

  /** One year, by id, label, or the day it covers. Anybody signed in. */
  read(actor: Actor, leaveYearId: string | null = null): Decision {
    return about.allow(actor, 'read', leaveYearId);
  },

  /** Every year. What a screen showing the years and their state reads. */
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

  /**
   * Settling a year for good. Named apart, so the log is.
   *
   * There is no `reopen` beside it, and the omission is the story: a decision
   * that can be undone by the person who made it is not a lock.
   */
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
