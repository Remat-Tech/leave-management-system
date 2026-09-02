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
 * ## Approving is the chain's, and this is the file that maps a desk onto a person
 *
 * LMS 314. This file said for two stories that there was deliberately no `approve` here,
 * "because a decision here would be a way to reach the transition without passing the check
 * that knows which desk the request is actually sitting on". {@link leaveRequestPolicy.approve}
 * is that check rather than a way around it: its subject is a {@link RequestAtADesk}, so the
 * question cannot be asked without saying where the request has got to.
 *
 * The three desks FR 38a names are three different kinds of fact and {@link isAt} is where
 * that is resolved — a reporting line, a pair of granted roles, and the one employee FR 04
 * leaves without a manager. None of them is a role code called MANAGER or CEO, and the
 * leave-type-approval-chain migration is emphatic that making them into one is the trap.
 *
 * **A rank admits nobody here.** A line manager has no standing over a request whose chain
 * does not name `MANAGER`, and HR has none over one that is still sitting with a manager.
 * That is the point of routing rather than a restriction on top of it.
 *
 * ## Nobody decides their own request, and it is asked before anything else
 *
 * FR 48, §8.6a. LMS 319. {@link leaveRequestPolicy.notTheirOwn} is the first question
 * {@link mayMove} asks of a deciding verb, and it is the only rule in this file that no role,
 * no relationship and no desk can satisfy — the answer depends on one comparison and nothing
 * else, so there is no configuration that admits somebody to their own request.
 *
 * **It is asked of the verb rather than of the standing**, and that is the change LMS 319
 * made rather than a restatement of what was already true. `THE_DESK_IT_IS_WITH` used to
 * carry the exclusion itself — an HR Officer asking for unpaid leave staffs the desk their
 * own request starts at — which was correct about approving and said nothing about refusing.
 * `LEAVE_ADMINISTRATION` is on the `REFUSE` row, so the same officer could turn their own
 * request down: a decision at a desk, recorded against their own leave, by them. Moving the
 * check up to the verb answers both, and answers whatever deciding verb arrives next by
 * default rather than by somebody remembering.
 *
 * **The two administrative verbs are deliberately outside it.** {@link isADecision} is the
 * line, and it is the same line ../domain/leave-decision.ts draws for the record: withdrawing
 * your own request is the whole point of withdrawing, and cancelling is HR unwinding a row
 * that should not be on the books. A rule that refused those would refuse a person taking
 * back their own leave, which is the one thing everybody may do.
 *
 * **It is asked again where it binds**, twice. `ledgerPolicy.commit` refuses the same person
 * at the ledger door, `BalanceService` asks this decision again inside the balance lock, and
 * `leave_request_never_decided_by_the_requester` refuses the row on every connection — so an
 * admin screen, a bulk action or a psql prompt meets it as surely as the one service method
 * does. The refusal itself is a {@link NotAuthorised} through {@link Guard.enforce}, which is
 * the 403 a route will return and the entry the denial log gets; see ./policy.ts.
 *
 * ## What is not here
 *
 * **No routing upwards.** FR 48b — the manager who raised their own request, the Chief
 * Executive who has nobody above them — is a rule about a reporting line rather than about a
 * leave type, and it is a story of its own. It is the other half of the sentence
 * {@link leaveRequestPolicy.notTheirOwn} makes: this file refuses the self-decision, and
 * nothing yet sends the request to whoever should have made it, so such a request waits at a
 * desk nobody can fill. That is visible and stuck rather than quietly approved, which is the
 * side to be wrong on.
 *
 * **And no decision about the comment.** FR 39 makes a refusal say why, LMS 315 records who
 * said it and on whose behalf, and none of that is a power somebody holds: the same people
 * may approve and refuse as could before, and what changed is what they have to write while
 * doing it. A `mayComment` here would be a policy with nothing on the other side of it. The
 * rule that a refusal carries a reason is ../domain/leave-decision.ts's, where every other
 * rule about the shape of a thing lives.
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

import type { ApproverRole } from '../domain/approval-chain.js';
import { type DecidingAction, isADecision } from '../domain/leave-decision.js';
import { type RequestAction, type Standing, standingsFor } from '../domain/leave-request.js';
import { type Actor, holdsAny, isSelf } from './actor.js';
import type { BalanceOwner } from './ledger-policy.js';
import { type Decision, policyFor } from './policy.js';
import { APPROVES_AS_HR, MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from './roles.js';

const about = policyFor('leave request');

/**
 * Everything a decision about a request is made from, beyond who is asking. §6, §10.
 * LMS 314.
 *
 * {@link BalanceOwner}'s two ids, plus the two facts `THE_DESK_IT_IS_WITH` needs. Both of
 * the new ones are nullable and neither is optional, which is the distinction that makes
 * this type worth having: a caller that has not looked up the Chief Executive and a caller
 * that has looked and found nobody are different situations, and only one of them is a bug.
 * Requiring the field means the first cannot happen quietly.
 *
 * The two are read by `LeaveRequestService` from the request and the employee table, and
 * they are read there rather than here for the reason no policy in this system touches a
 * database: a decision that could fetch is a decision whose answer depends on when it was
 * asked.
 */
export interface RequestAtADesk extends BalanceOwner {
  /**
   * FR 38a. The desk this request is waiting on, straight off
   * `leave_request.awaiting_approval_from`.
   *
   * Null for a request that is not waiting on anybody — approved, withdrawn, cancelled or
   * refused — and a null satisfies no standing, so a decision about one is refused rather
   * than accidentally allowed. Which is right: the reason it is not waiting is a reason
   * nobody is due to approve it.
   */
  awaiting: ApproverRole | null;
  /**
   * FR 04. The one employee with no line manager, or null where the table has none.
   *
   * The `CEO` desk resolves to a *position* rather than to a grant — nobody holds a role
   * that says Chief Executive, and the leave-type-approval-chain migration is emphatic that
   * turning the three desks into three role codes is the trap. So the person is found the
   * only way FR 04 offers, `EmployeeRepository.findRoot`, and handed here as an id.
   *
   * Null is a company with no root, which `employee_one_root` makes impossible and a
   * half-loaded test database makes real. It refuses rather than allowing, for the reason
   * {@link isSelf} refuses two nulls: nobody is not somebody.
   */
  chiefExecutiveId: string | null;
}

/**
 * The facts a standing may be decided from, whether or not the caller has all of them.
 *
 * The three standings LMS 313 wrote need only {@link BalanceOwner}, and their decisions go
 * on taking exactly that — widening `withdraw`, `refuse` and `cancel` to demand a desk and a
 * Chief Executive they have no use for would be three signatures made worse to serve a
 * fourth. So the shared helpers take this, {@link RequestAtADesk} satisfies it, and a
 * `BalanceOwner` on its own satisfies it too with the desk simply absent.
 *
 * An absent desk denies, which is the safe direction and is also the true one: a decision
 * made without knowing where a request is sitting cannot be a decision that somebody is
 * sitting there.
 */
type StandingFacts = BalanceOwner & Partial<Pick<RequestAtADesk, 'awaiting' | 'chiefExecutiveId'>>;

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
function hasStanding(actor: Actor, subject: StandingFacts, standing: Standing): boolean {
  switch (standing) {
    case 'THE_REQUESTER':
      return isSelf(actor, subject.employeeId);
    case 'THEIR_LINE_MANAGER':
      return isSelf(actor, subject.managerId);
    case 'LEAVE_ADMINISTRATION':
      return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS);
    case 'THE_DESK_IT_IS_WITH':
      /* The requester's exclusion used to be the other half of this line. It moved up to
         {@link mayMove} in LMS 319, because it is a rule about deciding rather than about
         standing at a desk: written here it answered `APPROVE`, which is the only row that
         names this standing, and left `REFUSE` — whose standings are a relationship and a
         role — for an HR Officer to use on their own request. Left here as well it would be
         a second copy of a rule this file states once and three layers ask. */
      return isAt(actor, subject);
  }
}

/**
 * Nobody decides their own request, whatever they hold. FR 48, §8.6a, §10. LMS 319.
 *
 * The one rule in this file that is a comparison rather than a lookup, and the one nothing
 * can be granted to pass. Every other decision here has some answer that admits somebody —
 * a role, a reporting line, the desk a chain has a request sitting on — and this has none:
 * the subject is the person the leave is *for*, the actor is whoever is asking, and if they
 * are the same person the answer is no.
 *
 * ## Why it is a decision of its own rather than a clause in the other two
 *
 * Because it has to be asked in three places and be the same rule in all three. {@link mayMove}
 * asks it of `approve` and `refuse` before any standing is consulted; `BalanceService` asks it
 * again at both doors, inside the lock, where the answer binds; and it is the sentence a person
 * is shown in each case. A clause inside `approve` and a second inside `refuse` would be two
 * rules that agree today, and the widening of one of them would be invisible in the other.
 *
 * It takes a {@link DecidingAction} rather than any {@link RequestAction}, which is the same
 * narrowing `settlementTo` makes with {@link ReleasingAction}: withdrawing is a person taking
 * their own request back and cancelling is HR unwinding a row that should not be on the books,
 * and neither is a decision at a desk. A door handed this rule for a withdrawal would refuse
 * the one act everybody in the company may perform on their own leave, and the type is what
 * makes that unwritable rather than merely unwise.
 *
 * ## The system is never anybody
 *
 * `theSystem` has a null `employeeId` and {@link isSelf} refuses two nulls, so the annual run
 * and the nightly jobs pass this as they pass everything else — by being nobody rather than by
 * being excused. Nothing here needs a branch for them, which is the property ../auth/actor.ts
 * argues for at length.
 *
 * Refused openly, and to the one person it can ever refuse: they are looking at their own
 * leave, so there is nothing to disclose, and the sentence has to name the alternative because
 * somebody who wanted this request gone has a legitimate way to get it gone.
 */
function notTheirOwn(actor: Actor, owner: BalanceOwner, action: DecidingAction): Decision {
  const said = action.toLowerCase();

  return isSelf(actor, owner.employeeId)
    ? about.refuseOpenly(
        actor,
        said,
        owner.employeeId,
        'is the person who asked for the leave, and nobody decides their own request',
        DECIDING_IS_SOMEBODY_ELSE,
      )
    : about.allow(actor, said, owner.employeeId);
}

/**
 * Whether this actor is the person the chain's current desk resolves to. FR 38a, FR 48.
 * LMS 314.
 *
 * The half of FR 38a that only this layer may know, and it is three questions rather than
 * one because the three desks are three different kinds of fact. The
 * leave-type-approval-chain migration says so at length and the short of it is:
 *
 *   **MANAGER is a relationship**, so it is the reporting line and nothing else. Holding
 *   HR_ADMIN does not make somebody the manager stage of a chain — that is precisely the
 *   widening that lets a stranger sign off a request addressed to a team lead.
 *
 *   **HR is a grant**, and two codes staff it — {@link APPROVES_AS_HR}, which is a list of
 *   its own so that changing who maintains employee records cannot quietly change who
 *   approves leave.
 *
 *   **CEO is a position**, and the one employee FR 04 leaves without a manager. It is
 *   compared by id rather than by any role, because nobody grants it.
 *
 * A desk of null is a request waiting on nobody, and nobody is at that desk.
 */
function isAt(actor: Actor, subject: StandingFacts): boolean {
  switch (subject.awaiting) {
    case 'MANAGER':
      return isSelf(actor, subject.managerId);
    case 'HR':
      return holdsAny(actor, ...APPROVES_AS_HR);
    case 'CEO':
      return isSelf(actor, subject.chiefExecutiveId ?? null);
    default:
      return false;
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
  subject: StandingFacts,
  action: RequestAction,
  words: { because: string; told: string },
): Decision {
  const said = action.toLowerCase();

  /* FR 48, §8.6a. LMS 319. The identity check, and it is first because it is the one answer
     no standing can overturn: a person who holds every role in the company and manages
     everybody is still not somebody else about their own leave. Asked of the verb rather than
     of a standing, so that it covers `refuse` — whose standings are a relationship and a role
     — as surely as it covers `approve`, and covers whatever deciding verb arrives next
     without anybody remembering to add it. */
  if (isADecision(action)) {
    const theirs = notTheirOwn(actor, subject, action);

    if (!theirs.allowed) {
      return theirs;
    }
  }

  return standingsFor(action).some((standing) => hasStanding(actor, subject, standing))
    ? about.allow(actor, said, subject.employeeId)
    : about.refuseOpenly(actor, said, subject.employeeId, words.because, words.told);
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

/**
 * Said openly, and to the only person it can ever be said to. FR 48, §8.6a. LMS 319.
 *
 * They are looking at their own request, so there is nothing about it to keep from them, and
 * the sentence names the two things they may actually do instead — because the likely reader
 * is not somebody trying it on. It is an HR Officer who submitted a request on Friday, found
 * it in their own queue on Monday because they staff the desk it starts at, and has no idea
 * that clicking the button they can see would be the defect this rule exists to stop.
 */
const DECIDING_IS_SOMEBODY_ELSE =
  'Leave is decided by somebody other than the person taking it, whatever roles they hold ' +
  'and wherever the request is sitting. If you no longer want this leave, withdraw it; if ' +
  'it should not be on the books at all, HR cancels it. FR 48.';

export const leaveRequestPolicy = {
  resource: about.resource,

  /**
   * Nobody decides their own request. FR 48, §8.6a. LMS 319.
   *
   * Exported as well as asked internally, because the two doors in `BalanceService` ask it
   * again inside the balance lock — the same discipline `approve` is held to there, and for
   * the same reason: the answer that binds is the one taken against the row nobody else can
   * move. See {@link notTheirOwn} for why it is one rule rather than a clause in two.
   */
  notTheirOwn,

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
   * Taking back leave you asked for. FR 26, FR 46. LMS 306, LMS 323.
   *
   * The requester's, and HR's on their behalf — deliberately the same rule as
   * {@link leaveRequestPolicy.submit} rather than a narrower one, because withdrawing is
   * the undoing of submitting and the same FR 18 argument applies to both. Somebody who
   * was off sick when they should have cancelled their annual leave is exactly the case
   * an Officer exists to enter on their behalf.
   *
   * **The desk plays no part in it**, which is FR 46 in the shape a policy can hold. The
   * `WITHDRAW` row admits `THE_REQUESTER` and `LEAVE_ADMINISTRATION` and nothing about where
   * the request has got to, so a person whose request has moved past two approvers takes it
   * back exactly as they would have on the morning they made it. `THE_DESK_IT_IS_WITH` here
   * would be the change that quietly breaks the story: leave still holding somebody's days,
   * which they cannot release until an approver acts. The unit suite asserts that standing is
   * not on the row.
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
   * **It is still not the approval chain, and LMS 314 deliberately left it that way.**
   * This note used to say the chain did not exist yet and that "the approval story narrows
   * this rather than replacing it". The chain now exists — {@link leaveRequestPolicy.approve}
   * walks it — and narrowing this one was not done with it, because it is a change to who
   * may turn leave down rather than a consequence of routing.
   *
   * What that leaves is worth stating plainly rather than leaving to be discovered: **a line
   * manager may refuse unpaid leave that they could not approve.** Its chain is HR then the
   * Chief Executive — §4.3.1, "Decided by HR and the Chief Executive" — so the manager is
   * not a desk on it, and `approve` refuses them. This decision does not, because it was
   * written before there was a chain to ask.
   *
   * It is a one-line change to the `REFUSE` row — `THE_DESK_IT_IS_WITH` in place of
   * `THEIR_LINE_MANAGER` — and it is not a one-line consequence: it needs this decision to
   * take a {@link RequestAtADesk}, and it takes away a manager's ability to turn down a
   * kind of leave they can currently turn down. That is somebody's decision to make rather
   * than a side effect of building the routing, and the story that puts an approver's queue
   * in front of people is where it belongs.
   *
   * **The requester is not on it, and since LMS 319 that holds against a role as well.**
   * `THE_REQUESTER` was never one of the `REFUSE` row's standings, so somebody with no role
   * could never mark their own leave refused — but `LEAVE_ADMINISTRATION` is on that row, and
   * an HR Officer or Administrator asking for their own leave held one. They could turn it
   * down: a decision at a desk, about their own request, made by them, recorded under their
   * own name as a refusal nobody else agreed to. {@link notTheirOwn} is what closes that, and
   * it closes it in front of every standing rather than by taking `LEAVE_ADMINISTRATION` off
   * the row — HR turning down somebody *else's* leave is exactly what that standing is for.
   *
   * Somebody refusing their own leave is withdrawing it, and the two are not interchangeable
   * in the record: `reasonForRelease` writes which of them happened into the ledger, and
   * "refused" against somebody's own name would read as a decision that was never made.
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
   * Saying yes at the desk the chain has this request sitting on. FR 38, FR 38a, FR 40.
   * LMS 314.
   *
   * The decision this file said for two stories it did not have, and the note it was
   * refused with is worth reading against what arrived. It said: "Deciding a request is FR
   * 38a's chain, it needs the request and the reporting line in hand, and it is the
   * approval story's decision. There is no `approve` in this file and its absence is
   * deliberate rather than pending — a decision here would be a way to reach the transition
   * without passing the check that knows which desk the request is actually sitting on."
   *
   * This is that check. The subject is a {@link RequestAtADesk} rather than a
   * {@link BalanceOwner}, so there is no way to ask this question without saying where the
   * request has got to, and `THE_DESK_IT_IS_WITH` is decided from that column — see
   * {@link isAt}.
   *
   * ## It is the chain that admits somebody, not a rank
   *
   * The third criterion, and it is worth being exact about what it rules out. **A line
   * manager has no standing here at all unless the chain names `MANAGER` and the request is
   * at that stage.** Unpaid leave goes HR then the Chief Executive — §4.3.1 says of both
   * unpaid types "Decided by HR and the Chief Executive" — so somebody's manager cannot
   * approve their unpaid leave, cannot see it advance by doing so, and is refused with a
   * sentence naming the desks that can.
   *
   * **And HR is not admitted by being HR.** {@link MAINTAINS_EMPLOYEE_RECORDS} carries the
   * three endings, because unwinding a request that should not be on the books is
   * administration; it carries nothing here. An HR officer approving annual leave that is
   * still sitting with a line manager would be approving something the manager has not seen,
   * which is the stage the chain exists to insist on.
   *
   * ## The requester is never at the desk, however they got there
   *
   * {@link notTheirOwn} refuses them before a standing is consulted at all, and the case that
   * makes it necessary is ordinary rather than adversarial: unpaid leave goes to the HR
   * desk, and an HR Officer asking for unpaid leave holds a code that staffs it. Without the
   * exclusion they would approve their own first stage on the way past.
   *
   * **The check moved up in LMS 319** from `THE_DESK_IT_IS_WITH`, where it answered only this
   * verb, to {@link mayMove}, where it answers every deciding one. Nothing about approving
   * changed; what changed is that {@link leaveRequestPolicy.refuse} now carries the same rule,
   * which it did not.
   *
   * `ledgerPolicy.commit` refuses the same thing at the ledger door — "approving your own
   * leave is the failure the seed fixtures are built to expose by name" — and both are asked,
   * which is the arrangement `submit` and `ledgerPolicy.reserve` already have. The narrower
   * is the real rule, and if these two ever disagreed the wider would be doing nothing.
   *
   * **What this does not do is route around it.** A manager who raises their own leave, and
   * the Chief Executive who has no manager to send it to, are left waiting at a desk nobody
   * can fill. That is FR 48b — the request routes *upwards* — and it is a rule about a
   * reporting line rather than about a leave type, which is why the
   * leave-type-approval-chain migration left it out of the chain table and why this story
   * leaves it out of the walk. It is a real gap and it is named rather than papered over: a
   * request in it is refused, visibly, rather than approved by somebody the chain never
   * asked.
   *
   * Refused openly. Anybody reaching this can already read the request, and the person most
   * likely to meet it is an approver at the wrong stage of a chain they cannot see.
   */
  approve(actor: Actor, subject: RequestAtADesk): Decision {
    return mayMove(actor, subject, 'APPROVE', {
      because: 'is not the approver this request is currently waiting on',
      told:
        'Leave is approved by each desk in its type’s approval chain, in order, and ' +
        'this request is not waiting on you. Most kinds of leave go to the line manager ' +
        'and then to HR; unpaid leave goes to HR and then to the Chief Executive. FR 38a.',
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
