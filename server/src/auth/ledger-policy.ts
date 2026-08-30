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
 * ## Three of those operations arrived, and each brought its own decision. LMS 212
 *
 * {@link ledgerPolicy.reserve}, {@link ledgerPolicy.commit} and
 * {@link ledgerPolicy.release} are the movements a leave request causes, and they
 * are three decisions rather than one for exactly the reason there is no `post`:
 * they are different acts by different people. Asking for leave is yours. Approving
 * it is emphatically not. Giving days back is any of the three.
 *
 * What they do **not** decide is whether the operation behind them is legitimate —
 * whether this request may be submitted at all, whether this approver is the one FR
 * 38a's chain is waiting on, whether the notice period was met. Those are the
 * request story's, about a request, and they will be asked before these are. This
 * file answers the narrower question the balance itself has to ask of anybody moving
 * it: have you any standing here at all. Both questions are worth asking, and a
 * service that only asked the first would be one route away from a balance anybody
 * could move.
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
import {
  MAINTAINS_EMPLOYEE_RECORDS,
  READS_EVERY_RECORD,
  SETS_UP_THE_ORGANISATION,
} from './roles.js';

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

/**
 * Said openly to everybody it refuses, including the person whose leave it is.
 *
 * Nothing is disclosed by it — they are looking at their own balance — and the
 * sentence has to be a sentence rather than the generic refusal, because the one
 * person most likely to meet it is somebody who has just been told their leave is
 * approved and is wondering why the system disagrees.
 */
const APPROVAL_IS_SOMEBODY_ELSE =
  'Approving leave turns days that were held into days that were taken, and it is ' +
  'the approver’s to do rather than the person taking the leave. FR 38a.';

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

  /**
   * Holding days for leave that has been asked for. FR 26, LMS 212.
   *
   * Yours, or HR's on your behalf. Asking for leave is the one thing every employee
   * does, and FR 18 gives HR the same act for somebody who was off sick and could
   * not — a request entered more than seven days after the fact is theirs to enter,
   * with a reason.
   *
   * **A line manager is deliberately not here**, and it is the one place in this
   * file where their read standing does not carry. Reading a report's balance is
   * what deciding a request needs; asking for leave on their behalf is not a thing
   * anybody has asked for, and a manager who could reserve somebody else's days
   * could reduce what that person may book without ever approving anything.
   *
   * Refused openly, because anybody who reaches this can already read the balance.
   */
  reserve(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId) || holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'reserve', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'reserve',
      owner.employeeId,
      'not their own balance, and holds no role that enters leave for somebody else',
      'Leave is asked for by the person taking it, or entered by HR on their behalf. ' + 'FR 18.',
    );
  },

  /**
   * Turning held days into taken days, which is what approval does. FR 26.
   *
   * Their line manager, or a role that reads every record. **Never the person
   * themselves**, and that is the only refusal in this file aimed at somebody's own
   * balance: approving your own leave is the failure the seed fixtures are built to
   * expose by name, and a self-approval that reached the ledger would be
   * indistinguishable afterwards from one somebody granted.
   *
   * HR staff hold this for anybody, their own balance included, and that is not a
   * hole this policy can close — an HR Administrator can already post an adjustment
   * for themselves, and §10 puts that beyond argument. What stops it being invisible
   * is that both leave a permanent row with their name on it.
   *
   * **Whether this is the right approver is not asked here.** FR 38a's chain says
   * which desk a request is sitting on, and that is the approval story's decision
   * about a request. This one answers the narrower question the balance has to ask
   * of anybody moving it: have you any standing here at all.
   */
  commit(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId)) {
      return about.refuseOpenly(
        actor,
        'commit',
        owner.employeeId,
        'is the person whose leave it is',
        APPROVAL_IS_SOMEBODY_ELSE,
      );
    }

    if (isSelf(actor, owner.managerId) || holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'commit', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'commit',
      owner.employeeId,
      'not their line manager, and holds no role that reads everybody',
      APPROVAL_IS_SOMEBODY_ELSE,
    );
  },

  /**
   * Granting a year's entitlement. FR 30, LMS 214.
   *
   * The same rule as {@link ledgerPolicy.adjust}, an HR Administrator's, and it is
   * worth saying why rather than leaving it to look like a copy.
   *
   * A grant and an adjustment are the same act from the balance's point of view: days
   * arriving with no request behind them and no way to take them back afterwards. What
   * differs is who chose the figure — a rule, written in advance and applying to
   * everybody, rather than a person deciding this morning — and that difference is
   * already protected, because writing the rule is `entitlementRulePolicy.create` and
   * is an HR Administrator's too. Letting an HR Officer *apply* figures only an
   * Administrator may *write* would put the whole of a year's entitlement one desk
   * lower than the decision behind it.
   *
   * The annual run passes as `theSystem`, which holds every role and is nobody.
   *
   * Refused openly, because anybody reaching this can already read the balance and
   * telling them which desk grants a year discloses nothing.
   */
  grant(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'grant', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'grant',
          owner.employeeId,
          'holds no role that grants a year of entitlement',
          'A year’s entitlement arrives from the rule that says what a leave type is ' +
            'worth, and applying it is the same desk that writes it — an HR ' +
            'Administrator’s. FR 30.',
        );
  },

  /**
   * Checking every balance in the company against the ledger. §7.4, LMS 213.
   *
   * The only decision in this file that names no record, because the reconciliation
   * names none: it reads every balance there is, which is every employee's leave in
   * one answer. So it goes to the roles that may read every record — the same rule
   * `auditPolicy.browse` uses for the same reason, that browsing without naming a
   * record *is* every record at once.
   *
   * The nightly run passes as `theSystem`, which holds every role and is nobody. A
   * person may run it too, and the story's "as an HR Officer" is why that is worth
   * allowing rather than reserving to the job: somebody who suspects a figure is wrong
   * should be able to ask the question this afternoon rather than wait for two in the
   * morning.
   *
   * Refused openly. A reconciliation names nobody, so there is no existence to
   * disclose, and the person meeting this refusal is asking a reasonable question at
   * the wrong desk.
   */
  reconcile(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'reconcile', null)
      : about.refuseOpenly(
          actor,
          'reconcile',
          null,
          'holds no role that reads every record',
          'Checking every balance against the ledger reads the whole company’s leave at ' +
            'once, so it is HR’s. Your own balance and its history are on your leave ' +
            'page. §7.4.',
        );
  },

  /**
   * Giving held days back, when a request is withdrawn, refused or cancelled.
   *
   * The widest of the three, and the same three standings as {@link ledgerPolicy.read}:
   * yours to withdraw, your manager's to refuse, HR's to cancel. Each of those is a
   * different operation and they share a rule here because they are one movement —
   * days that were held stop being held.
   *
   * Wide is the safe direction for this one alone. A release cannot take anything
   * from anybody: it gives days back, and {@link daysToRelease} will not give back
   * more than is held, so the worst a wrong release can do is unhold days that a
   * request still thinks it has — which is the request state machine's integrity to
   * keep rather than the balance's.
   */
  release(actor: Actor, owner: BalanceOwner): Decision {
    if (
      isSelf(actor, owner.employeeId) ||
      isSelf(actor, owner.managerId) ||
      holdsAny(actor, ...READS_EVERY_RECORD)
    ) {
      return about.allow(actor, 'release', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'release',
      owner.employeeId,
      'not their balance, not their line manager, and holds no role that reads everybody',
      'Held days are given back by the person who asked for the leave, by their line ' +
        'manager, or by HR.',
    );
  },
};
