/**
 * Who may see and change a department. NFR SEC 02. §10. LMS 112. LMS 105.
 *
 * The first of the two policies about the *shape* of the organisation rather
 * than about a person, and the split runs the same way in both: reading is
 * open, writing is an HR Administrator's.
 *
 * ## Reading is open to everybody signed in
 *
 * A department is a team name. It is on every screen that shows anybody
 * anything: the person raising a request sees which team the approver is in, a
 * joiner picks one from a list, and a leave report is organised by them. There
 * is no version of this system where a signed in employee cannot see the list of
 * teams, and pretending otherwise would mean either a hole in the rule or a
 * screen that shows ids.
 *
 * It is worth being explicit that this is a deliberate opening and not an
 * oversight, because "read is open" is exactly the sentence somebody will later
 * copy into a policy where it is wrong. What makes it safe here is that a
 * department row holds a name, a parent that nothing writes and a flag. Nothing
 * about a person is in it. The moment a story adds a field that is about
 * somebody — a budget, a head of department, a cost centre — this decision has
 * to be made again, and this paragraph is the reason to notice.
 *
 * ## The headcount is not
 *
 * How many people are in a team is a fact about people, and a number small
 * enough to be revealing: "how many are still employed in Legal" answered for
 * everybody is a redundancy watch. So it goes to whoever may read the records it
 * counts, which is {@link READS_EVERY_RECORD}.
 *
 * ## Writing is an HR Administrator's
 *
 * Creating, renaming and closing a team changes what every report is organised
 * by and, in the case of closing one, refuses to happen until somebody has moved
 * the people out. See {@link SETS_UP_THE_ORGANISATION} for why that is a rank
 * above the officer who maintains the records.
 */

import { type Actor, holdsAny } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { READS_EVERY_RECORD, SETS_UP_THE_ORGANISATION } from './roles.js';

const about = policyFor('department');

/**
 * The sentence a refused write gives.
 *
 * Said openly, in every case, because anybody who reaches it can already see the
 * department — reading is open — so naming the rule discloses nothing. There is
 * no second, vaguer form of this refusal for the same reason: there is nobody it
 * would be keeping anything from.
 */
const WRITES_ARE_ADMINISTRATIVE =
  'Teams are set up and closed by an HR Administrator, because doing it changes ' +
  'how leave is reported for everybody in them. Ask one.';

export const departmentPolicy = {
  resource: about.resource,

  /** One team, by id or by name. Anybody signed in. */
  read(actor: Actor, departmentId: string | null = null): Decision {
    return about.allow(actor, 'read', departmentId);
  },

  /** The list of teams. Anybody signed in; it is what a form offers as choices. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },

  /** How many people are still employed in one. A fact about people, not about teams. */
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

  /**
   * Closing one. The ending a department has, and the consequential write here:
   * a closed team is a heading no report offers and a team nobody can be moved
   * into.
   */
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

  /** And undoing that. Same standing: it is the same decision, made the other way. */
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
