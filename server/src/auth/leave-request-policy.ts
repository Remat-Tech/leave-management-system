/**
 * Who may ask for leave, and who may see what somebody asked for. FR 10, NFR SEC 02.
 * §10. LMS 301.
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
 * **No withdrawal, and no cancellation.** Both move `status`, both release days, and
 * both belong with the state machine. `ledgerPolicy.release` is already written and
 * waiting for them.
 *
 * **No quoting decision.** Asking what a fortnight would cost is not a separate power:
 * it reads a working pattern, a public holiday calendar and a balance, and each of
 * those is decided by its own policy at the moment it is read. Adding a fourth would
 * be a decision with nothing behind it — and, worse, one somebody could later widen
 * without noticing they had widened the three underneath.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import type { BalanceOwner } from './ledger-policy.js';
import { type Decision, policyFor } from './policy.js';
import { MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from './roles.js';

const about = policyFor('leave request');

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
