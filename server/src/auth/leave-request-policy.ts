/**
 * Who may ask for leave, who may see what somebody asked for, and who may end it. FR 10,
 * FR 26, NFR SEC 02. §6, §10. LMS 301, the three endings of LMS 306, and the transition
 * table of LMS 313.
 *
 * The first policy about something an employee *does* rather than something recorded
 * about them, and the difference shows in which way the defaults run. Everything in
 * ./employee-policy.ts and ./ledger-policy.ts starts from "who is entitled to see
 * this"; this one starts from "this is the thing everybody in the company does", and
 * the interesting decisions are the narrow ones rather than the wide ones.
 *
 * ## Asking is yours, and HR's on your behalf
 *
 * Exactly the rule `ledgerPolicy.reserve` already holds, and deliberately not a second
 * opinion about it. Submitting a request reserves the days, so a caller who may submit
 * one may move a balance — and if these two files disagreed about who that is, the
 * narrower would be doing nothing and the wider would be the real rule. Asked in both
 * places anyway, because they answer different questions: this one is about the
 * request, that one is about the balance, and a story that later lets somebody submit
 * without reserving would find the second check waiting.
 *
 * FR 18 is why HR is on it. Somebody who was off sick for a week could not fill a form
 * in on the Monday, and an HR Officer entering it afterwards is ordinary work rather
 * than an exception — which is the same argument the holiday calendar makes about
 * being an Officer's rather than an Administrator's.
 *
 * **A line manager is deliberately not on it.** This is the one place in the system
 * where their standing over a report does not carry, and `ledgerPolicy.reserve` gives
 * the reason: a manager who could ask for leave on somebody's behalf could reduce what
 * that person may book without ever approving anything. Reading their requests is a
 * different matter and they have it.
 *
 * ## Reading follows the balance, not the record
 *
 * `ledgerPolicy.read`'s three standings — yours, your line manager's, or a role that
 * reads everybody — and it is worth saying why a request is filed with the balance
 * rather than with the employee record.
 *
 * A request is why a figure is what it is. Somebody looking at five days missing from
 * a balance and the reservation that took them is owed the request behind it, and
 * standing to see one without the other would be standing to see half an explanation.
 * That is the same sentence `LeaveEventService.forEmployee` makes about an entitlement
 * event, and the two are the same kind of thing: the record a movement was made
 * against.
 *
 * ## What is not here
 *
 * **No approval.** Deciding a request is FR 38a's chain, it needs the request and the
 * reporting line in hand, and it is the approval story's decision. There is no
 * `approve` in this file and its absence is deliberate rather than pending — a
 * decision here would be a way to reach the transition without passing the check that
 * knows which desk the request is actually sitting on.
 *
 * ## The three endings, and why they are three decisions rather than one
 *
 * LMS 306. Withdrawing, cancelling and refusing are one *movement* — days that were held
 * stop being held, and `ledgerPolicy.release` decides all three together for that reason.
 * They are three *decisions* here because they are three different acts, and who may
 * perform them differs at every one:
 *
 * | | May | Because |
 * |---|---|---|
 * | {@link leaveRequestPolicy.withdraw} | the requester, or HR | it is the undoing of submitting, so it is the rule `submit` already has |
 * | {@link leaveRequestPolicy.refuse} | the line manager, or HR | a decision about somebody else's request, which is what a manager is for |
 * | {@link leaveRequestPolicy.cancel} | HR | an administrative unwinding that is nobody's own leave and nobody's own report |
 *
 * A single `settle(actor, owner)` decision would have to be the union of those three,
 * which is `ledgerPolicy.release` — and it would let a manager withdraw a report's leave
 * and a requester mark their own leave refused. Both would write a perfectly valid
 * `RELEASE` and a record of something that did not happen.
 *
 * The service asks the matching one and then takes a single path through the transition,
 * so there is one place a request ends and three places it is decided that somebody may
 * end it.
 *
 * **Since LMS 313 the desks are read rather than written.** Each of the three used to
 * carry its own `isSelf(...) || holdsAny(...)`; all three were correct, and together they
 * were a second copy of the state machine — one that could be widened without
 * `TRANSITIONS` changing, at which point the widened copy is the real rule and the table
 * is a comment. Now {@link mayMove} asks the table which standings a move admits and
 * {@link hasStanding} says which roles satisfy each, so the rule is in one place and this
 * file is what maps it onto people.
 *
 * ../../tests/unit/policy.test.ts is where the answers are pinned, against hardcoded
 * actors rather than against the table — because a test that asked the table what to
 * expect would now be asking the same question twice and agreeing with itself.
 *
 * **No quoting decision.** Asking what a fortnight would cost is not a separate power:
 * it reads a working pattern, a public holiday calendar and a balance, and each of
 * those is decided by its own policy at the moment it is read. Adding a fourth would
 * be a decision with nothing behind it — and, worse, one somebody could later widen
 * without noticing they had widened the three underneath.
 */

import { type RequestAction, type Standing, standingsFor } from '../domain/leave-request.js';
import { type Actor, holdsAny, isSelf } from './actor.js';
import type { BalanceOwner } from './ledger-policy.js';
import { type Decision, policyFor } from './policy.js';
import { MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from './roles.js';

const about = policyFor('leave request');

/**
 * Which roles satisfy each standing the transition table names. §6, §10. LMS 313.
 *
 * The half of the state machine that lives on this side of the layering rule.
 * `TRANSITIONS` says a `REFUSE` is made by `THEIR_LINE_MANAGER` or by
 * `LEAVE_ADMINISTRATION`; being a line manager is a fact on a record and being HR is a
 * role, and only this file may know the second. See {@link Standing} for why the table
 * names standings rather than role codes.
 *
 * A `switch` with a branch per standing rather than a lookup object, because the compiler
 * then refuses a standing added to the list and not answered here — which is the one
 * failure mode this arrangement has. A missing entry in a map is `undefined`, and
 * `undefined` denies silently: the transition would simply stop being performable by
 * anybody, and the first person to notice would be somebody whose request was stuck.
 */
function hasStanding(actor: Actor, owner: BalanceOwner, standing: Standing): boolean {
  switch (standing) {
    case 'THE_REQUESTER':
      return isSelf(actor, owner.employeeId);
    case 'THEIR_LINE_MANAGER':
      return isSelf(actor, owner.managerId);
    case 'LEAVE_ADMINISTRATION':
      return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS);
  }
}

/**
 * Whether this actor may make this move, decided against the table. §6. LMS 313.
 *
 * The three decisions below are this function with three sets of words, and that is the
 * story's first criterion arriving in the authorisation layer: **who may do what is read
 * off `TRANSITIONS` rather than restated here.** Before LMS 313 each of them carried its
 * own `isSelf(...) || holdsAny(...)`, which was correct and was also a second copy of the
 * state machine — one that could be widened without the table changing, and would then be
 * the real rule.
 *
 * **The from-status is deliberately not part of this decision**, even though the table is
 * keyed by it. `standingsFor` says at length why, and the short of it is the order two
 * questions have to be asked in: this one answers *is this your business* — your leave,
 * your report, your desk — and `settlementTo` then answers *is this move available*.
 *
 * Refusing on the state here as well would collapse both into a `NotAuthorised`. Somebody
 * withdrawing leave they have already withdrawn would be told they may not, which is
 * untrue and unactionable, and {@link LeaveAlreadySettled} — the sentence that names what
 * happened and says the days are already back — would be unreachable. Asking it the other
 * way round instead would read a stranger's request state aloud before deciding whether
 * they may see it at all.
 *
 * Refused openly, all three. Anybody reaching one of these can already read the request,
 * so there is no existence to disclose, and the person meeting it is doing legitimate
 * work at the wrong window.
 */
function mayMove(
  actor: Actor,
  owner: BalanceOwner,
  action: RequestAction,
  words: { because: string; told: string },
): Decision {
  const said = action.toLowerCase();

  return standingsFor(action).some((standing) => hasStanding(actor, owner, standing))
    ? about.allow(actor, said, owner.employeeId)
    : about.refuseOpenly(actor, said, owner.employeeId, words.because, words.told);
}

/**
 * Said openly to everybody it refuses, including a line manager.
 *
 * Nothing is disclosed by it — anybody reaching this has already been allowed to read
 * the balance they are trying to move — and the person most likely to meet it is a
 * manager doing somebody a favour, who is owed an explanation rather than the generic
 * refusal.
 */
const ASKING_IS_YOURS =
  'Leave is asked for by the person taking it, or entered by HR on their behalf where ' +
  'somebody was away and could not ask. A manager approves leave rather than ' +
  'requesting it. FR 18.';

export const leaveRequestPolicy = {
  resource: about.resource,

  /**
   * Asking for leave. FR 10.
   *
   * Yours, or HR's on your behalf. The owner is the person the leave is *for*, never
   * the person filling the form in, which is what makes the self case mean anything.
   *
   * Refused openly; see {@link ASKING_IS_YOURS}.
   */
  submit(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId) || holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'submit', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'submit',
      owner.employeeId,
      'not their own leave, and holds no role that enters leave for somebody else',
      ASKING_IS_YOURS,
    );
  },

  /**
   * Reading one person's requests, or one of them.
   *
   * The three standings a balance has, for the reason in the module note: a request is
   * the explanation of a movement, and the two are read together or not at all.
   *
   * Refused silently rather than openly, the default of ./policy.ts, because somebody
   * asking after leave that is not theirs and not their report's has not been shown
   * that the person exists — and "you may not read employee 4471's leave" would tell
   * them that 4471 is somebody.
   */
  read(actor: Actor, owner: BalanceOwner): Decision {
    if (
      isSelf(actor, owner.employeeId) ||
      isSelf(actor, owner.managerId) ||
      holdsAny(actor, ...READS_EVERY_RECORD)
    ) {
      return about.allow(actor, 'read', owner.employeeId);
    }

    return about.refuse(
      actor,
      'read',
      owner.employeeId,
      'not their leave, not their line manager, and holds no role that reads everybody',
    );
  },

  /**
   * Taking back leave you asked for. FR 26. LMS 306.
   *
   * The requester's, and HR's on their behalf — deliberately the same rule as
   * {@link leaveRequestPolicy.submit} rather than a narrower one, because withdrawing is
   * the undoing of submitting and the same FR 18 argument applies to both. Somebody who
   * was off sick when they should have cancelled their annual leave is exactly the case
   * an Officer exists to enter on their behalf.
   *
   * **A line manager is deliberately not on it**, for the reason they are not on
   * `submit`: a manager who could withdraw somebody's leave could empty their calendar
   * without ever refusing anything, and without the record saying a decision was made. A
   * manager who does not want the leave to happen refuses it — see
   * {@link leaveRequestPolicy.refuse} — which is the same movement wearing its own name.
   *
   * Refused openly; see {@link ASKING_IS_YOURS}, which is the same sentence because it is
   * the same rule.
   */
  withdraw(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'WITHDRAW', {
      because: 'not their own leave, and holds no role that maintains leave for somebody else',
      told: ASKING_IS_YOURS,
    });
  },

  /**
   * Turning down leave somebody asked for. FR 26, and half of FR 38a. LMS 306.
   *
   * The line manager's, and HR's. `ledgerPolicy.release` has described this desk since
   * LMS 212 — "yours to withdraw, your manager's to refuse, HR's to cancel" — and this is
   * the decision that names it.
   *
   * **It is not the approval chain, and the difference is worth being exact about.** FR
   * 38a gives each leave type an ordered chain of approvers, and deciding *which desk a
   * given request is currently sitting on* needs the chain, the type and how far the
   * request has got. None of that exists yet: there is no `APPROVED`, so there is no
   * partly-approved request to be sitting anywhere. What this holds is the standing
   * question — is this person in a position to decide this request at all — which is a
   * manager's or HR's however the chain is later walked.
   *
   * The approval story narrows this rather than replacing it, and narrowing is the safe
   * direction: a chain check added in front of a decision that already refuses
   * strangers cannot accidentally widen it.
   *
   * **The requester is not on it**, which is the one place this differs from every other
   * decision here. Somebody refusing their own leave is withdrawing it, and the two are
   * not interchangeable in the record: `reasonForRelease` writes which of them happened
   * into the ledger, and "refused" against somebody's own name would read as a decision
   * that was never made.
   *
   * Refused openly. Anybody reaching this can already read the request.
   */
  refuse(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'REFUSE', {
      because: 'is not their line manager and holds no role that decides leave for the company',
      told:
        'Leave is turned down by the line manager it was addressed to, or by HR. Taking ' +
        'back your own request is withdrawing it. FR 38a.',
    });
  },

  /**
   * Unwinding a request that should not stand. FR 26, FR 37. LMS 306.
   *
   * HR's alone, and the narrowest of the three endings. A cancellation is the one that is
   * nobody's own decision about their own leave and nobody's decision about their own
   * report: it is the administrative act of saying this request should not be on the
   * books — leave booked against the wrong person, a request entered twice, days that
   * belong in a different year.
   *
   * **Narrower than {@link ledgerPolicy.release}, deliberately.** That decision admits
   * the requester and the manager as well, because it is about a *movement* and a release
   * cannot take anything from anybody. This one is about which act somebody may perform,
   * and the two are asked in that order: a person who may cancel may certainly release,
   * and if these files disagreed the narrower would be the real rule. Which is the
   * arrangement `submit` and `ledgerPolicy.reserve` already have, and for the same
   * reason.
   *
   * Refused openly, naming the desk that can. Somebody reaching this is doing legitimate
   * work at the wrong window.
   */
  cancel(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'CANCEL', {
      because: 'holds no role that maintains leave for the company',
      told:
        'Cancelling a request is HR unwinding something that should not be on the ' +
        'books. Taking back your own leave is withdrawing it, and a manager who ' +
        'does not agree to it refuses it.',
    });
  },

  /**
   * Improving the reason on a request already submitted.
   *
   * The author's alone — not their manager's, and not HR's. That is narrower than
   * {@link leaveRequestPolicy.submit} and it is the one place in this file where being
   * able to create something does not carry the right to edit it.
   *
   * The reason is the requester's account of why they need the leave, and it is what
   * an approver decides on. Somebody else rewriting it changes what a manager thinks
   * they agreed to, with the person who asked none the wiser — and unlike every figure
   * on the row, no trigger can refuse it, because the field is deliberately editable.
   * HR entering a request under FR 18 writes the reason then; changing it afterwards is
   * a different act.
   *
   * Refused openly. Anybody reaching this can already read the request.
   */
  reword(actor: Actor, owner: BalanceOwner): Decision {
    return isSelf(actor, owner.employeeId)
      ? about.allow(actor, 'reword', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'reword',
          owner.employeeId,
          'is not the person who asked for the leave',
          'The reason on a request is the account given by the person who asked for it, ' +
            'and it is what an approver decides on. Only they may change it.',
        );
  },
};
