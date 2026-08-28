/**
 * Who may see and change a working pattern. NFR SEC 02. §10. LMS 112. FR 23,
 * LMS 106.
 *
 * The second policy about the shape of the organisation rather than about a
 * person, and it runs the same way as ./department-policy.ts: reading is open to
 * anybody signed in, writing is an HR Administrator's.
 *
 * ## Reading is open
 *
 * A pattern is a week — which days are worked — and every employee has a right
 * to know which week they are counted against, because it is the difference
 * between a week off costing four days and costing five. A pattern is not a
 * record about anybody: it holds a name, a flag and seven weekdays, and which
 * pattern a *person* is on is a field of the employee record, which
 * ./employee-policy.ts guards.
 *
 * So the open read here is narrower than it looks. Anybody may see that a
 * pattern called "Four days, Wednesdays off" exists. Finding out that it is
 * Abena's means reading Abena's record, and that is refused.
 *
 * ## The headcount is not open
 *
 * How many people are on a pattern is a fact about people, exactly as a
 * department's headcount is, and a small number on an unusual pattern is close
 * to naming somebody. It goes to {@link READS_EVERY_RECORD}.
 *
 * ## Writing is an HR Administrator's
 *
 * Editing a pattern changes what a day off costs for everybody on it, without
 * touching a single employee record — which is precisely the sort of change that
 * ought to need the rank that {@link SETS_UP_THE_ORGANISATION} names. Making one
 * the default changes which week every future joiner is given.
 */

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

  /** One pattern, by id or by name. Anybody signed in. */
  read(actor: Actor, workPatternId: string | null = null): Decision {
    return about.allow(actor, 'read', workPatternId);
  },

  /** Every pattern, and the default among them. What a form offers as choices. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },

  /** How many employee records are on one, leavers included. A fact about people. */
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

  /**
   * Deleting one. The ending a pattern has, unlike a department, and refused by
   * the service for the default and for one anybody is on — so what this decides
   * is who may remove the pattern created by a typo on a Tuesday afternoon.
   */
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
