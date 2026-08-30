/**
 * Who may read and post to the balance ledger. FR 27, FR 37, NFR SEC 02. §10.
 * LMS 210.
 *
 * The first policy about a *record of what happened* rather than about a record of
 * how things are, and the two are not protected the same way. A leave type can be
 * read by anybody because knowing what annual leave is worth harms nobody. A ledger
 * is somebody's history, and reading it says how much leave they took, when, and —
 * once the request types start writing to it — often why.
 *
 * ## Reading is the employee record's rule, not the calendar's
 *
 * Three kinds of standing, exactly as ./employee-policy.ts has them, and for the
 * same reasons:
 *
 *   **It is your own balance.** FR 53. The point of the system. An employee sees
 *   every movement in their own figures, which is the whole of the story's "any
 *   figure can be explained rather than taken on trust" — explained to *them*.
 *
 *   **You are their line manager.** FR 55, direct reports only, never the subtree.
 *   A manager deciding a request needs the balance behind it; the argument for
 *   stopping at one level is ./employee-policy.ts's and is not repeated here.
 *
 *   **You hold a role that reads everybody.** FR 56.
 *
 * The standing is taken as a fact the caller has established rather than read here,
 * which is the same shape `employeePolicy.read` uses: this file is a pure function
 * of what it is handed, and working out whose balance an entry belongs to is a
 * database read.
 *
 * ## Posting is an HR Administrator's, and only ever an adjustment
 *
 * §10's authorisation matrix has one row for this table — "Manual balance
 * adjustment: HR Admin" — with an ✗ against every other column including HR
 * Officer. That is narrower than every other write in this system and it is right:
 * an adjustment moves days by fiat, with no request and no rule behind it, and it
 * cannot be undone. It can only be compensated, permanently and visibly.
 *
 * There is no `post` decision for the other seven entry types, and its absence is
 * deliberate rather than pending. Nobody posts a `GRANT` — the year rollover does,
 * as part of closing a year. Nobody posts a `RESERVATION` — submitting a request
 * does. Those are decisions about the operations that cause them, and each belongs
 * to the policy for that operation: a `create` on this file would be a way to reach
 * every one of them without passing any of those checks.
 *
 * ## Nobody may change or remove an entry, and there is no decision for it
 *
 * The absence is the rule. A `ledgerPolicy.update` returning a refusal for everybody
 * would suggest that some actor, somewhere, might be allowed one — and the first
 * person to need it badly enough would add a role to the list. The table has no
 * UPDATE and no DELETE granted to the application at all, and a compensating entry
 * is not an exception to that: it is an ordinary {@link ledgerPolicy.adjust},
 * decided by exactly the same rule as any other adjustment.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { READS_EVERY_RECORD, SETS_UP_THE_ORGANISATION } from './roles.js';

const about = policyFor('ledger');

/**
 * Whose balance this is, as the caller has established it.
 *
 * Two ids rather than an `Employee`, because this file is reached from a history
 * screen holding a balance's key rather than a person's record, and asking a policy
 * to take a whole record it does not read would be asking every caller to fetch
 * one.
 */
export interface BalanceOwner {
  employeeId: string;
  /** Their line manager, or null. Read from the employee record by the service. */
  managerId: string | null;
}

/**
 * Said openly, because anybody who reaches it can already read the balance they are
 * trying to adjust.
 */
const ADJUSTMENTS_ARE_ADMINISTRATORS =
  'A balance adjustment moves days with no request behind it and can never be ' +
  'removed afterwards, only compensated. It is an HR Administrator’s to post. ' +
  'FR 37.';

export const ledgerPolicy = {
  resource: about.resource,

  /**
   * Every movement in one balance. FR 53, FR 55, FR 56.
   *
   * The order of the three cases is the order they are most often true in and has
   * no other significance: they are alternatives, and any one is enough.
   *
   * Refused silently rather than openly, the default of ./policy.ts, because
   * somebody asking after a balance that is not theirs and not their report's has
   * not been shown that the person exists — and "you may not read employee 4471's
   * leave" would tell them that 4471 is somebody.
   */
  read(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId)) {
      return about.allow(actor, 'read', owner.employeeId);
    }
    if (isSelf(actor, owner.managerId)) {
      return about.allow(actor, 'read', owner.employeeId);
    }
    if (holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'read', owner.employeeId);
    }

    return about.refuse(
      actor,
      'read',
      owner.employeeId,
      'not their balance, not their line manager, and holds no role that reads everybody',
    );
  },

  /**
   * Posting a manual adjustment, and therefore also a correction of an earlier
   * entry. FR 37, §10.
   *
   * One decision for both, deliberately, where ./holiday-policy.ts splits `update`
   * from `remove`. The argument that splits those is that they are different
   * sentences in the log with different consequences; here they are the same
   * sentence — days moved by fiat, with a reason — and a correction is only
   * distinguished by the row it names. Splitting would suggest that somebody might
   * hold one and not the other, which is not a distinction anybody should be able
   * to make: whoever can post an adjustment can already post its opposite.
   *
   * Refused openly, because anybody reaching this has already been allowed to read
   * the balance and telling them which desk posts adjustments discloses nothing.
   */
  adjust(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'adjust', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'adjust',
          owner.employeeId,
          'holds no role that adjusts balances',
          ADJUSTMENTS_ARE_ADMINISTRATORS,
        );
  },
};
