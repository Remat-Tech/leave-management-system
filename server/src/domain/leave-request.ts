/**
 * Asking for leave, and knowing what it costs first. FR 10, FR 11, FR 14, FR 15, FR 16,
 * FR 26, §6, §8. LMS 301, the refusals of LMS 303, LMS 304 and LMS 305, the three
 * endings of LMS 306, and the state machine of LMS 313.
 *
 * The story is an employee who wants no surprises when the days come off their
 * balance, and the whole of this file follows from taking that literally: the figure
 * a person is shown before they submit and the figure that is stored afterwards are
 * produced by the same function from the same facts, and once stored the figure is
 * never derived again.
 *
 * LMS 306 is the same sentence read from the other end. Days held are days gone from what
 * somebody may book, so the moment a request stops standing they have to come back — and
 * come back *once*. {@link RELEASING_STATUSES}, {@link settlementTo} and
 * {@link reasonForRelease} are that story's whole share of this file; the movement is
 * `BalanceService.releaseForRequest` and the desks are in ../auth/leave-request-policy.ts.
 *
 * LMS 313 gathered the state machine those two stories had left in three places — the
 * from-state in one function, the destination at each call site, the actor in each policy
 * decision — into {@link TRANSITIONS}. Every one of the three was correct; none of them
 * could answer "what can happen to a submitted request", which is the question somebody
 * has when a request is stuck. §6, and see the note on that table.
 *
 * LMS 314 is the story that table was built for. Approval is the first verb that does not
 * always move the status — a manager approving stage one of manager-then-HR sends the
 * request on rather than deciding it — and the first destination that leaves a request
 * alive. {@link approvalTo} is the whole of the routing, {@link ApprovalOutcome} is what it
 * answers, and {@link LeaveRequest.awaitingApprovalFrom} is the second of the two facts a
 * request now carries about where it has got to. FR 38, FR 38a, FR 40.
 *
 * LMS 315 adds what the approver *said*, and adds none of it here. A decision is its own
 * record — the verb, the reason, the desk it was made at and the person who made it — so it
 * is ./leave-decision.ts and a table of its own, for the reason the chain is rows rather than
 * columns: a request collects one decision per stage, and anything whose shape follows from
 * how many desks there are cannot be a field on the request. What this file keeps is where a
 * request may go; what somebody said on the way is filed beside it. FR 39, FR 52.
 *
 * ## The quote and the request are the same arithmetic
 *
 * {@link LeaveRequestQuote} is what a form shows. {@link ValidatedLeaveRequest} is
 * what is stored. The second carries the first's numbers, unchanged, because
 * `LeaveRequestService` counts once for the quote and again inside the transaction
 * that writes — and if those two ever disagreed, the disagreement would be the
 * surprise the story exists to prevent. What makes them agree is that neither does
 * any arithmetic of its own: both call {@link countLeaveDays}, which is pure and
 * gives the same answer for the same period, pattern, calendar and basis.
 *
 * ## Why the basis is copied, and what it protects
 *
 * The story's third criterion, and it is a criterion about the *future* rather than
 * about today. `leave_type.counting_basis` is configuration — an HR Administrator may
 * change it, `leaveTypePolicy.update` says so, and moving one type from WORKING_DAYS
 * to CALENDAR_DAYS is one dropdown. If a request read the basis off the type every
 * time it was rendered, that single edit would restate every request ever made under
 * the old rule: last March's fortnight of annual leave would begin displaying as
 * fourteen days rather than ten, on a screen beside a ledger still saying ten, and
 * nothing anywhere would say which was right.
 *
 * So the basis, the day count and the calendar span are written onto the row at
 * submission and the database refuses to let them move —
 * `refuse_rewriting_what_a_request_cost()`. This file holds the same rule in the type
 * system: every one of those fields is on {@link ValidatedLeaveRequest} and none of
 * them is on {@link LeaveRequestChanges}.
 *
 * It is the same argument three other tables in this schema have already made, and
 * that is worth knowing rather than rediscovering. `leave_entitlement_event` stores
 * `expires_on` so that changing a type's expiry months cannot move a deadline already
 * given. `leave_ledger_entry` stores `days` so that changing an entitlement figure
 * cannot restate a grant. `leave_balance` is a cache checked nightly against the rows
 * it was built from. In each case the rule is design principle 1: **what was recorded
 * is what happened**, and configuration describes what happens *next*.
 *
 * ## Dates that are obviously wrong are refused here, and refused at once
 *
 * FR 16, FR 16a, §8.3, LMS 303. The story is somebody finding out while the form is
 * still open rather than after two days in a queue, and three refusals answer it:
 *
 *   **The dates run backwards.** {@link validateLeavePeriod}, which owns
 *   {@link LeavePeriod} and is asked before anything at all is fetched.
 *
 *   **Nothing in the period is charged.** {@link assertItCostsSomething}, on the
 *   {@link DayCount} the calculator gave back.
 *
 *   **The period runs past the end of its leave year.** {@link reachesPastTheEndOf},
 *   and then {@link LeaveCrossesAYearEnd} with both years named and the two dates to
 *   resubmit on.
 *
 * LMS 304 added a fourth, which is not about the dates being wrong but about the days
 * being taken:
 *
 *   **The period runs over leave the person already has.** {@link periodsOverlap} and
 *   {@link LIVE_STATUSES}, and then {@link LeaveOverlapsAnother} naming the leave in the
 *   way. Unlike the three above it is a rule about *another row*, so the domain holds
 *   the predicate and the list while the service does the reading — and
 *   `leave_request_never_overlaps` holds the same rule where two submissions race.
 *
 * LMS 305 added a fifth, which is not about the days being taken but about their not
 * being there at all:
 *
 *   **The balance does not hold what is being asked for.**
 *   {@link assertTheDaysAreThere}, and then {@link NotEnoughDays} naming the figure and
 *   the number of days that could be asked for instead. Like the overlap it is a rule
 *   about something the domain cannot see, so the service reads the balance and this
 *   judges it — and `daysToReserve` holds the same rule inside the lock, which is
 *   where the guarantee is. See that function's note below.
 *
 * **All five are refusals about a request, and none of them is the calculator's.**
 * LMS 303 moved the second one here from ./leave-calculator.ts, and the reason is the
 * reason it belongs beside the other two: that a fortnight over Christmas costs eight
 * days, or that a Saturday costs none, is arithmetic about a calendar, and the
 * calculator answers it for anybody who asks — including FR 25's recalculation, which
 * has to be able to ask "what does this cost now" and get *nought* rather than an
 * exception. Whether a person may submit that is a rule about submissions.
 *
 * The practical half of that division: the calculator stays pure and total, so every
 * one of its cases is arithmetic a unit test can assert without a database, and every
 * refusal a person can actually see is in one file with one voice.
 *
 * ## What is not here
 *
 * **No counting.** ./leave-calculator.ts counts, and it is where the working pattern,
 * the holiday calendar and the counting basis meet. This file is handed the answer and
 * judges it.
 *
 * **No balance, and no arithmetic on one.** {@link assertTheDaysAreThere} is handed the
 * figure and compares it; it does not read a balance, add one up, or know what the five
 * columns are. ./balance.ts owns all of that, and the number arrives from
 * `BalanceService.forOne` through the service.
 *
 * **And this is not where affordability is guaranteed.** §8.2: the figure a domain
 * function is handed was read a moment before it was judged, and somebody else may be
 * spending it in that moment. `daysToReserve` decides it again inside the lock, and that
 * is the answer that binds. What this one buys is the sentence, said while the form is
 * still open — see {@link NotEnoughDays}.
 *
 * **No resolving a desk to a person.** {@link approvalTo} says a request now waits on the
 * `HR` desk; which of the two HR role codes staffs it, and whether this actor holds one, is
 * ../auth/leave-request-policy.ts — the same division {@link Standing} makes for the other
 * three. FR 48's harder half is not here either: the manager who raised the request
 * themselves and the Chief Executive with nobody above them are FR 48b, and both are rules
 * about a reporting line rather than about a request.
 *
 * **No commitment of days.** Approval turns a hold into days taken, which is a `DEDUCTION`
 * and is `BalanceService`'s — the ledger has one door. This file says where the approval
 * leaves the request and whether it was the last word; what that costs the balance is
 * `daysToCommit` in ./balance.ts.
 *
 * **No policy.** There is no {@link Actor} here and there is none in a `/domain` file
 * anywhere. Who may ask for leave, and which of the three endings a given person may
 * reach, is ../auth/leave-request-policy.ts. What this file says is that a request ends
 * once.
 */

import {
  type ApproverRole,
  chainInWords,
  firstApprover,
  isApprovedBy,
  nextUnapproved,
  stagesNotApproved,
} from './approval-chain.js';
import type { DayCount, FreeDay, LeavePeriod } from './leave-calculator.js';
import {
  approvalChainInWords,
  balanceMayBeExceededWithDocument,
  type CountingBasis,
  countingBasisInWords,
  documentationRequired,
  type LeaveType,
  noticeShortfall,
} from './leave-type.js';
import type { LeaveYear } from './leave-year.js';
import {
  type CalendarDate,
  calendarDaysBetween,
  dayAfter,
  formatDay,
  isCalendarDate,
} from './time.js';

/**
 * Where a request has got to. LMS 301, the three endings of LMS 306, and the approval of
 * LMS 314.
 *
 * Five values, and the rule LMS 209 set is what keeps the list honest: a CHECK naming
 * states nothing can reach is a promise the schema cannot keep, so a status arrives in
 * the same story as the transition that reaches it. Every one of these is reachable by a
 * method that exists — the three endings through {@link RELEASING_STATUSES}, and
 * `APPROVED` through {@link approvalTo} once the last desk in FR 38a's chain has said
 * yes.
 *
 * **`APPROVED` is the only one of the five that is not an ending**, and that is the
 * distinction every list in this file turns on. It still holds the days — it holds them
 * harder, as `taken` rather than as `pending` — so it is in {@link LIVE_STATUSES} and not
 * in {@link RELEASING_STATUSES}, and nothing moves out of it yet.
 *
 * `leave_request_status_known` in the route-a-request-through-its-chain migration holds
 * exactly this list, and the integration suite reads it back out of `pg_constraint` and
 * asserts the two agree.
 */
export const REQUEST_STATUSES = [
  'SUBMITTED',
  'APPROVED',
  'WITHDRAWN',
  'CANCELLED',
  'REFUSED',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * The three endings that give the days back. FR 26, §8.2. LMS 306.
 *
 * Withdrawn by the person who asked, cancelled by HR, refused by a manager. Three
 * different acts by three different desks, and one movement: days that were held stop
 * being held. `ledgerPolicy.release` has said exactly that since LMS 212 — "yours to
 * withdraw, your manager's to refuse, HR's to cancel… they share a rule here because
 * they are one movement" — and this is the list that act can leave a request in.
 *
 * **It was the exact complement of {@link LIVE_STATUSES} until LMS 314, and it was never
 * defined as one.** The note here used to say why in the future tense: writing
 * `REQUEST_STATUSES.filter(not live)` would be a definition that silently absorbs whatever
 * arrives next, and `APPROVED` "is not live in the sense of *releasing* — it is live in the
 * sense of holding days, and it would land in this list by arithmetic and release the days
 * of every approved request in the system". `APPROVED` has now arrived, it joined
 * {@link LIVE_STATUSES} and not this one, and the arithmetic that would have caught it is
 * the arithmetic nobody wrote. A status joins this list because somebody decided it ends a
 * request and gives the days back, which is a decision rather than a subtraction.
 *
 * The same three are the transition trigger's list in the migration, and the integration
 * suite asserts the two agree — so neither can be extended alone.
 */
export const RELEASING_STATUSES = ['WITHDRAWN', 'CANCELLED', 'REFUSED'] as const;

export type ReleasingStatus = (typeof RELEASING_STATUSES)[number];

/**
 * The statuses that hold a person's days. FR 15, §5.6. LMS 304.
 *
 * **A request blocks the same days being asked for again only while it is still live**,
 * and this is the list of what live means. Everything in it is leave the person still
 * has or is still expecting: drafted, waiting to be decided, or agreed. Everything
 * outside it is leave that came back — withdrawn, cancelled, refused — and days that
 * came back are days somebody may book again, which is the ordinary thing to do after
 * a request is turned down.
 *
 * **Two values since LMS 314, and both halves of that were decisions.** Until the three
 * endings existed this list and {@link REQUEST_STATUSES} held the same single value, and
 * every query filtering by it was filtering nothing; LMS 306 added three statuses, none of
 * them joined this list, and the queries written against it started excluding rows without
 * a line of them changing. What that buys, concretely: a fortnight in March is no longer
 * blocked by leave that was refused in January, and somebody whose request was turned down
 * can book the same days again.
 *
 * LMS 314 then added `APPROVED`, which **is** live and does join it — and that is the
 * decision this list exists to force somebody to make. Leave that has been agreed is the
 * most live leave there is: the person will be away, the days are gone from the balance as
 * `taken`, and booking something else on top of them is the exact defect FR 15 is about. A
 * status added to `REQUEST_STATUSES` without a thought about this one either blocks days
 * that came back or lets somebody book over leave that was agreed.
 *
 * `leave_request_never_overlaps` holds the same list as the predicate on an exclusion
 * constraint, and the integration suite asserts the two agree — so neither can be
 * extended alone.
 */
export const LIVE_STATUSES: readonly RequestStatus[] = ['SUBMITTED', 'APPROVED'];

/**
 * Whether a request in this state still holds the days it covers. FR 15.
 *
 * Asked of the status rather than of a list at each call site, for the reason
 * {@link countsWorkingDays} is asked of the basis rather than of the code: the question
 * "does this one block" should have one answer, and a second `includes` written
 * somewhere else is a second answer waiting to disagree.
 */
export function blocksTheCalendar(status: RequestStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/**
 * Whether this request has already been settled, and its days already given back.
 *
 * The complement of {@link blocksTheCalendar} for the five statuses that exist, and asked
 * separately for the reason neither list is defined as a subtraction. This note used to say
 * the two would "part company the moment `APPROVED` arrives, which holds days and has
 * certainly not ended", and what actually happened when it arrived is more instructive:
 * somebody had to answer both questions about it, the answers went opposite ways — live,
 * not ended — and the two lists came out complements again by agreement rather than by
 * arithmetic. A subtraction would have put it in {@link RELEASING_STATUSES} and released the
 * days of every approved request in the system.
 */
export function isSettled(status: RequestStatus): status is ReleasingStatus {
  return (RELEASING_STATUSES as readonly RequestStatus[]).includes(status);
}

/**
 * A request being ended a second time. FR 26, §8.2. LMS 306.
 *
 * The refusal that makes "my days cannot be given back twice" true rather than hoped for,
 * and the mirror of `NotEnoughHeld` in ./balance.ts. Withdrawing an already withdrawn
 * request would post a second `RELEASE` against a hold the first one emptied — and where
 * the person has other leave pending in the same balance there would be days there to
 * take, so the ledger would accept it and credit them for a fortnight nobody was holding.
 *
 * **Which is why the guard is the status and not the balance.** `daysToRelease` refuses
 * to give back more than the balance holds, but the balance is per employee, leave type
 * and leave year — it cannot tell one request's held days from another's.
 * `ledgerPolicy.release` says so in as many words: the worst a wrong release can do "is
 * unhold days that a request still thinks it has — which is the request state machine's
 * integrity to keep rather than the balance's". This is the state machine keeping it.
 *
 * The message names what happened rather than only refusing, because the overwhelmingly
 * likely reader is somebody who pressed the button twice, or two people acting on the
 * same request from different screens — and "this was already withdrawn" is the whole of
 * what either of them needs to know.
 */
export class LeaveAlreadySettled extends Error {
  /** FR 26. What a client branches on, as `CROSS_LEAVE_YEAR` and the others are. */
  readonly code = 'ALREADY_SETTLED';
  readonly leaveRequestId: string;
  /** Where it had already got to. Never a live status; see {@link settlementTo}. */
  readonly status: RequestStatus;

  constructor(request: LeaveRequest) {
    super(
      `This leave was already ${inWordsSettled(request.status)} and its days have been ` +
        `given back, so there is nothing left to give back. A request ends once. If the ` +
        `days are wanted again, ask for them again — they are back in the balance.`,
    );
    this.name = 'LeaveAlreadySettled';
    this.leaveRequestId = request.id;
    this.status = request.status;
  }
}

/**
 * A move the table does not hold, on a request that has not ended. §6. LMS 314.
 *
 * The refusal `APPROVED` made necessary, and it exists because the sentence
 * {@link LeaveAlreadySettled} says would be a lie about it. "This leave was already
 * approved and its days have been given back, so there is nothing left to give back" is
 * wrong twice over: the days are not back, they are taken, and the request has not ended.
 *
 * The overwhelmingly likely reader is somebody looking at leave that has been agreed and
 * reaching for withdraw, which is a reasonable thing to want and is FR 26's cancellation of
 * approved leave — a different movement, against the `DEDUCTION` rather than the
 * `RESERVATION`, and not built. So the message says what state the request is in, what can
 * still be done to it, and where to go for the thing that cannot.
 *
 * **What can still be done is read off {@link transitionsFrom} rather than written out**,
 * for the reason every list in this file is read rather than restated: the day a row out of
 * `APPROVED` is added, this sentence starts offering it without anybody remembering to come
 * back here.
 */
export class LeaveCannotBeMoved extends Error {
  /** FR 26. What a client branches on, as `ALREADY_SETTLED` is. */
  readonly code = 'MOVE_NOT_AVAILABLE';
  readonly leaveRequestId: string;
  readonly status: RequestStatus;
  readonly action: RequestAction;

  constructor(request: LeaveRequest, action: RequestAction) {
    const instead = transitionsFrom(request.status).map((transition) =>
      transition.action.toLowerCase(),
    );

    super(
      `This leave has been ${inWordsSettled(request.status)}, and ${action.toLowerCase()} ` +
        `is not something that can be done to it from there. ` +
        (instead.length > 0
          ? `What it can be is ${listOf(instead)}.`
          : `Leave that has been agreed is taken off the books by HR, who put the days ` +
            `back as a correction — the days are spent rather than held, so there is no ` +
            `hold left to release. Speak to them.`),
    );
    this.name = 'LeaveCannotBeMoved';
    this.leaveRequestId = request.id;
    this.status = request.status;
    this.action = action;
  }
}

/**
 * A request waiting at a desk its type's chain no longer has. FR 31, FR 38a, FR 41. LMS 314,
 * LMS 316.
 *
 * The one seam in reading the chain live rather than copying it onto the request, and it is
 * refused by name because letting the approval through is worse than saying so.
 *
 * The situation: annual leave goes manager then HR, somebody's request is sitting with
 * their manager, and an HR Administrator changes the chain to HR alone — which FR 31 says
 * they may, without a developer and without a deployment. The manager now approves, at a
 * desk the policy no longer asks.
 *
 * **LMS 314 refused it because approving would have been the likely reading**, and said so:
 * `approverAfter` answered undefined for a desk outside the chain, "nobody left to ask" would
 * have approved the leave without HR — the only stage the new chain has — ever seeing it, and
 * "start again from the first stage" would have silently un-approved a stage somebody signed.
 *
 * **LMS 316 removed both of those and left the refusal standing**, which is worth reading as
 * a change of grounds rather than as the same note. {@link nextUnapproved} does not answer
 * undefined here: a chain the desk has been dropped from still has stages nobody has signed,
 * so the walk would route the request to the first of them and nothing would be approved
 * early. What the refusal protects now is the claim itself — **every approval on record has
 * to belong to a stage**, or "every stage has approved" is a statement about a set with
 * strangers in it, and a manager's signature would sit in a request's history looking exactly
 * like one that counted.
 *
 * So it refuses, and the message is written for the two people who will meet it: the
 * approver, who needs to know this is not their mistake, and whoever fixes it, who needs to
 * know what the chain says now. Both chains are in the sentence.
 *
 * It is rare and it is not hypothetical — the window is exactly as long as a request waits,
 * which is days. Copying the chain onto the request at submission is the durable answer and
 * is the argument FR 11 already made about the counting basis; it is a table of its own.
 */
export class ApprovalChainChanged extends Error {
  /** FR 38a. What a client branches on, so a screen can offer to route it again. */
  readonly code = 'CHAIN_CHANGED';
  readonly leaveRequestId: string;
  /** The desk it is standing on, which the chain no longer names. */
  readonly awaiting: ApproverRole;
  /** The chain as it now stands. */
  readonly chain: readonly ApproverRole[];

  constructor(request: LeaveRequest, awaiting: ApproverRole, chain: readonly ApproverRole[]) {
    super(
      `This request is waiting on ${chainInWords([awaiting])}, and the approvers for this ` +
        `kind of leave have since been changed to ${chainInWords(chain)} — which no longer ` +
        `includes that stage, so there is no next approver to send it to. Nothing is wrong ` +
        `with the request. Ask an HR Administrator to put the approval chain back, or ` +
        `withdraw this and ask again so it starts at the first stage of the new one.`,
    );
    this.name = 'ApprovalChainChanged';
    this.leaveRequestId = request.id;
    this.awaiting = awaiting;
    this.chain = [...chain];
  }
}

/* ------------------------------------------------------- the state machine, §6 */

/**
 * What somebody may do to a request. §6, LMS 313, LMS 314.
 *
 * Verbs rather than destinations, and the difference is the whole reason
 * {@link TRANSITIONS} is keyed by one of these instead of by a target status. "Withdraw"
 * is a thing a person does; `WITHDRAWN` is where it leaves the request. Keying a state
 * machine by its destinations reads fine while every act has its own — and stops the
 * afternoon two acts land in one state, at which point the table can no longer say which
 * happened and the audit log is the only thing that knows.
 *
 * **`APPROVE` is the verb that does not always move the status**, which is LMS 314's whole
 * shape and is why keying by verbs mattered before there was a second kind of move. A
 * manager approving annual leave leaves the request `SUBMITTED` and sends it on to HR; the
 * HR officer approving it afterwards is the same verb and makes it `APPROVED`. Which of the
 * two happened is {@link approvalTo}, and it is a question about the chain rather than
 * about the status — see that function.
 */
export const REQUEST_ACTIONS = ['WITHDRAW', 'REFUSE', 'CANCEL', 'APPROVE'] as const;

export type RequestAction = (typeof REQUEST_ACTIONS)[number];

/**
 * The three that end a request and give its days back. FR 26, §8.2. LMS 306, LMS 314.
 *
 * The verbs {@link RELEASING_STATUSES} are the destinations of, and the list
 * `LeaveRequestService.settle` and `BalanceService.releaseForRequest` are typed on — so
 * the one action neither of them can be handed is `APPROVE`, which commits days rather
 * than releasing them and goes through its own door.
 *
 * **Written out rather than derived from {@link REQUEST_ACTIONS}**, for the reason
 * {@link RELEASING_STATUSES} is written out rather than derived from
 * {@link REQUEST_STATUSES}: "every action but the approving one" is a definition that
 * absorbs whatever verb arrives next, and the next verb — FR 26's cancelling of leave
 * already agreed — is one that would land here by subtraction and post a `RELEASE` against
 * days that have already been taken. The unit suite asserts every member of this list is a
 * member of that one and lands in a releasing status.
 */
export const RELEASING_ACTIONS = ['WITHDRAW', 'REFUSE', 'CANCEL'] as const;

export type ReleasingAction = (typeof RELEASING_ACTIONS)[number];

/**
 * Where somebody stands towards a request. §6, §10. LMS 313.
 *
 * **These are not roles, and the distinction is load bearing rather than pedantic.** Two
 * of the three transitions turn on a *relationship* — it is your leave, or you are the
 * manager it was addressed to — and a table keyed by role codes could not express either.
 * It would have to widen them into "anybody with a role that reads every record", which
 * is how a manager comes to be able to withdraw a stranger's leave.
 *
 * They are also what lets the table live here at all. `/domain` holds plain types and
 * pure functions and imports nothing — the layering rule — so it cannot name a
 * {@link RoleCode}. What it can name is the standing a transition requires, leaving
 * ../auth/leave-request-policy.ts to say which roles satisfy `LEAVE_ADMINISTRATION`. The
 * rule and the roster stay in the layers that own them, and neither can drift from the
 * other, because there is one list of standings and the policy has a branch for each.
 *
 * ## `THE_DESK_IT_IS_WITH` is the standing that reads a column
 *
 * LMS 314, and it is the fourth because the first three were not enough to say who may
 * approve. The other three are answered from the actor and the employee record alone —
 * your leave, your report, your roles — and none of them can express "the desk FR 38a's
 * chain has this particular request sitting on this afternoon", which is a fact about the
 * *request* and moves as the request moves.
 *
 * It is still a standing rather than a role for exactly the reason the other three are.
 * The desk is `MANAGER`, `HR` or `CEO` — {@link ApproverRole} — and each of those resolves
 * to a person by a different mechanism: a reporting line, a pair of granted roles, and the
 * one employee FR 04 leaves without a manager. `/domain` may know that a request is waiting
 * on the HR desk; only ../auth/leave-request-policy.ts may know that an HR Officer and an
 * HR Administrator both staff it.
 */
export const STANDINGS = [
  'THE_REQUESTER',
  'THEIR_LINE_MANAGER',
  'LEAVE_ADMINISTRATION',
  'THE_DESK_IT_IS_WITH',
] as const;

export type Standing = (typeof STANDINGS)[number];

/**
 * One permitted move: from this state, by this act, performed by somebody standing
 * thus, to that state.
 */
export interface Transition {
  from: RequestStatus;
  action: RequestAction;
  to: RequestStatus;
  /** Any one of these is enough. Empty would be a move nobody can make. */
  by: readonly Standing[];
}

/**
 * What one approval did: moved the request on, or decided it. FR 38a. LMS 314.
 *
 * The move, described from all three sides — the desk that said yes, where that leaves the
 * request, and who is next. There is deliberately **no** `isFinal` flag beside them:
 * `awaiting === null` already says it, and a flag beside a field it is derived from is a
 * flag that can disagree with it. {@link isTheLastWord} is that reading, named once.
 */
export interface ApprovalOutcome {
  /**
   * The desk this approval came from — the one the request was standing on, not the one it
   * is going to.
   *
   * Carried so the caller does not have to reach back into the request for it and does not
   * have to answer a null the walk has already refused. It is what
   * {@link reasonForApproval} names in the ledger.
   */
  by: ApproverRole;
  /**
   * Where the request lands. `SUBMITTED` while stages remain, `APPROVED` when none does —
   * and read off {@link TRANSITIONS} rather than named by {@link approvalTo}.
   */
  to: RequestStatus;
  /** The desk it now waits on, or null once there is nobody left to ask. */
  awaiting: ApproverRole | null;
}

/**
 * Every move a request may make, and there are no others. §6. LMS 313, LMS 314.
 *
 * The story's first criterion, and the reason it is a *table* rather than three methods
 * that each know their own rule. Before this, the same state machine was spread over
 * three places: the from-state in `assertMayBeSettled`, the destination in whichever
 * service method you were reading, and the actor in whichever policy decision it called.
 * Every one of those was correct. None of them could answer "what can happen to a
 * submitted request", which is the question somebody actually has when a request is stuck
 * — and the story is precisely about a request nobody can explain or resolve.
 *
 * Read down the `from` column and that question is answered by looking.
 *
 * ## What the table does not contain, and why each absence is a decision
 *
 * **No row out of a settled state.** `WITHDRAWN`, `CANCELLED` and `REFUSED` appear in the
 * `to` column and never in the `from` column, which is what makes them terminal — not a
 * separate rule saying so, and not a flag on the status. A request ends once, and the
 * absence of a row is where that is written. `refuse_an_impossible_transition()` holds
 * the same shape where no service can reach.
 *
 * **No row out of `APPROVED` either, and that one is a boundary rather than a rule.** LMS
 * 314 gets a request as far as leave that has been agreed and stops there. Taking agreed
 * leave off the books afterwards is a real thing FR 26 asks for, and it is none of the
 * three verbs here: by then the days are `taken` rather than `pending`, so giving them back
 * is a movement against a `DEDUCTION` rather than against a `RESERVATION`, and
 * `daysToRelease` would find nothing held to release. The story that offers it brings that
 * movement and a row here. Until it does, {@link LeaveCannotBeMoved} is what somebody
 * reaching for withdraw on approved leave is told — which is why that refusal had to exist
 * the moment a live state stopped answering every verb.
 *
 * **One row whose `to` is live, and whose destination the table alone cannot give.**
 * `APPROVE` out of `SUBMITTED` lands in `APPROVED` — the first destination here that does
 * not end the request — but only once the chain has nobody left to ask. A manager approving
 * the first stage of a two-stage chain leaves the request `SUBMITTED` and sends it on to the
 * next desk, which is not a status change at all. {@link approvalTo} is where the two are
 * told apart, and it reads the destination off this row rather than naming one.
 */
export const TRANSITIONS: readonly Transition[] = [
  /* Taking back your own request, or HR doing it for somebody who was away and could
     not. The undoing of submitting, so it carries the standings `submit` carries. */
  {
    from: 'SUBMITTED',
    action: 'WITHDRAW',
    to: 'WITHDRAWN',
    by: ['THE_REQUESTER', 'LEAVE_ADMINISTRATION'],
  },

  /* Turning down somebody else's request. Deliberately not the requester's: marking your
     own leave refused is a record of a decision nobody made. */
  {
    from: 'SUBMITTED',
    action: 'REFUSE',
    to: 'REFUSED',
    by: ['THEIR_LINE_MANAGER', 'LEAVE_ADMINISTRATION'],
  },

  /* Unwinding a request that should not be on the books — the wrong person, entered
     twice, days in the wrong year. Nobody's own leave and nobody's own report. */
  { from: 'SUBMITTED', action: 'CANCEL', to: 'CANCELLED', by: ['LEAVE_ADMINISTRATION'] },

  /* Saying yes at the desk the chain has it sitting on. FR 38, FR 38a, FR 40. LMS 314.

     `to` is where the *last* desk leaves it; every desk before that leaves the status
     alone and moves the request on. `approvalTo` is what tells the two apart, and this row
     is where it reads the destination from.

     One standing, and it is the narrowest in the table: not HR by virtue of being HR, and
     not the line manager by virtue of the reporting line, but whoever is at the desk this
     request is actually waiting on. A chain that does not name the manager does not admit
     the manager, which is the whole of the third criterion. */
  { from: 'SUBMITTED', action: 'APPROVE', to: 'APPROVED', by: ['THE_DESK_IT_IS_WITH'] },
];

/**
 * The move this action makes from this state, or undefined where there is not one.
 *
 * The one way the table is read. Every caller — the service before it writes, the policy
 * deciding who may, `BalanceService` inside its lock — goes through here rather than
 * filtering {@link TRANSITIONS} itself, because a second `find` written somewhere else is
 * a second answer waiting to disagree with this one.
 */
export function transitionFor(from: RequestStatus, action: RequestAction): Transition | undefined {
  return TRANSITIONS.find((transition) => transition.from === from && transition.action === action);
}

/** Everything that can happen to a request in this state. What a screen offers. */
export function transitionsFrom(from: RequestStatus): readonly Transition[] {
  return TRANSITIONS.filter((transition) => transition.from === from);
}

/**
 * Who may perform this action, wherever the table permits it at all. §6, §10. LMS 313.
 *
 * The projection ../auth/leave-request-policy.ts decides on, and it is deliberately
 * **not** keyed by the from-status even though {@link TRANSITIONS} is.
 *
 * The two layers are answering two questions and the order they are asked in is a
 * disclosure rule rather than a preference. The policy asks *is this your business* —
 * your leave, your report, your desk — and it has to answer that before anything reads
 * the request's state aloud, or a colleague probing ids learns that somebody's leave was
 * refused. {@link settlementTo} then asks *is this move available*, and answers a
 * request that has already ended with {@link LeaveAlreadySettled} or one that has gone
 * somewhere the verb does not reach with {@link LeaveCannotBeMoved} — which between them
 * are the sentences the person pressing the button actually needs.
 *
 * Refusing on the from-status here instead would collapse both into `NotAuthorised`:
 * somebody withdrawing their own withdrawn leave would be told they may not, which is
 * untrue and unactionable, and the specific refusal would be unreachable.
 *
 * **A union across the rows for that action, and today each action has exactly one.**
 * The unit suite pins that, so the union is that row. A story giving one action
 * different desks in different states — cancelling an approved request being HR's alone
 * where cancelling a submitted one is wider — makes this a genuine union and too
 * permissive, and the test that fails is the one asserting each action has a single row.
 * That story passes the from-status through here and this becomes a lookup.
 *
 * **`APPROVE` is the one whose standing is not fully answerable from the action alone**,
 * and that is by design rather than an exception here. This says the move belongs to
 * `THE_DESK_IT_IS_WITH`; which desk that is, this afternoon, for this request, is
 * {@link LeaveRequest.awaitingApprovalFrom} and is handed to the policy beside the actor.
 * The projection stays a function of the verb, and the request stays the thing that says
 * where it has got to.
 */
export function standingsFor(action: RequestAction): readonly Standing[] {
  return [
    ...new Set(
      TRANSITIONS.filter((transition) => transition.action === action).flatMap(
        (transition) => transition.by,
      ),
    ),
  ];
}

/**
 * Where this settlement leaves the request, refusing a move the table does not hold.
 * §6, FR 26. LMS 313, LMS 314.
 *
 * **The destination is read off the table rather than passed in**, which is the half of
 * the story that makes the table load bearing instead of documentation. Before LMS 313
 * the service named the target status at each call site — `settle(actor, id, 'WITHDRAWN',
 * …)` — so the table could have said anything and the code would still have written
 * whatever the caller asked for. Now there is nowhere to say it.
 *
 * **It is not the guarantee**, and the arrangement is the one LMS 304, LMS 305 and LMS
 * 306 all made. Two tabs withdrawing the same request both read `SUBMITTED` here and both
 * pass. What closes that window is the balance lock in
 * `BalanceService.releaseForRequest` — both withdrawals move the same balance, so the
 * second waits and re-reads a request the first has already settled — and
 * `leave_request_moves_as_the_table_says` behind even that, for a writer that found
 * another way in. What this buys is the sentence.
 *
 * **It takes a {@link ReleasingAction} rather than any action**, which is LMS 314 drawing
 * in the type system the line it drew in the ledger. `APPROVE` reaches a state that still
 * holds days, so a release door handed it would give back days approval had just
 * committed; {@link approvalTo} is that verb's lookup and `BalanceService.approveForRequest`
 * is its door. The narrowing is what makes the `isSettled` answer below unreachable rather
 * than merely unlikely.
 *
 * Which of the two refusals a miss produces is {@link refuseTheMove}, and the distinction
 * arrived with `APPROVED`: until there was a live state with a gap in it, every miss was a
 * request that had already ended.
 */
export function settlementTo(request: LeaveRequest, action: ReleasingAction): ReleasingStatus {
  const transition = transitionFor(request.status, action);

  if (transition === undefined) {
    throw refuseTheMove(request, action);
  }

  if (!isSettled(transition.to)) {
    /* Unreachable: the parameter is a `ReleasingAction`, and the unit suite asserts every
       row for one of those ends the request. It is answered rather than asserted because
       the failure it would otherwise cause is silent and expensive — `releaseForRequest`
       giving back days an approval had just committed, with both the status and the ledger
       looking entirely reasonable afterwards — and because the row that made it thinkable
       now exists: `APPROVE` lands somewhere live, and the only thing keeping it out of this
       function is the type. */
    throw new Error(
      `A ${action} leaves this request ${transition.to}, which does not end it, so its ` +
        `days are not the release door's to give back. A transition that keeps a request ` +
        `alive needs the movement that matches it — approval commits days rather than ` +
        `releasing them. §6.`,
    );
  }

  return transition.to;
}

/**
 * Where an approval leaves the request: on to the next desk, or agreed. FR 38, FR 38a, FR
 * 40, FR 41, FR 42, §6. LMS 314, LMS 316.
 *
 * The whole of the routing in one function. It is handed the request — which carries the desk
 * it is sitting at — the chain off its leave type, and the desks that have already signed,
 * and it answers the only question an approval has: **is there anybody left to ask.**
 *
 * ## What "anybody left" means, and why it changed
 *
 * LMS 316, and it is one line of code and the whole of that story. LMS 314 asked
 * `approverAfter(chain, desk)` — the stage after the one signing — which is a question about
 * a position in a list, and answered it against a cursor the request carries. LMS 316 asks
 * {@link nextUnapproved} instead: the first stage in the chain that has no approval recorded
 * against it.
 *
 * The two agree in every ordinary case, and the case they part on is the one FR 41 is about.
 * A stage added *in front of* a request in flight — annual leave goes manager then HR, a
 * request is with HR because the manager has signed, and an HR Administrator changes the
 * chain to CEO, manager, HR — leaves the cursor pointing at the last position of the new
 * list. "The one after HR" is nothing, so HR's yes would approve the leave outright and the
 * Chief Executive, a stage the policy now names, would never see it. The employee is told
 * their leave is agreed. That is the sentence the story exists to make true, and asking which
 * desk has *not* signed cannot get it wrong, because it is a question about the whole chain.
 *
 * **The desks that have signed are a parameter rather than something read here**, for the
 * reason the day count and the balance are parameters: `/domain` imports nothing and touches
 * nothing, and the rows live in `leave_request_decision`. `desksThatApproved()` in
 * ./leave-decision.ts turns them into the list, and `LeaveRequestService` carries it across.
 *
 * **The desk approving now counts towards it.** The caller passes what was signed *before*
 * this approval, and this adds the one being given — so the last desk in a chain of two sees
 * both and finds nobody left. Doing it the other way round, with the caller adding its own
 * desk first, would make every call site responsible for the same increment.
 *
 * ## Two shapes of yes, and only one of them is a status change
 *
 * A manager approving the first stage of manager-then-HR has not approved the leave. They
 * have said their part of it, and the request goes on to HR still `SUBMITTED`, still
 * holding its days as `pending`, with {@link ApprovalOutcome.awaiting} moved along. The HR
 * officer who approves it afterwards is the last desk, and *that* is the transition —
 * `APPROVED`, and the hold becomes days taken.
 *
 * Writing both as status changes was the obvious alternative and it is the one that goes
 * wrong: it needs a state per stage — `AWAITING_HR`, `AWAITING_CEO` — so the number of
 * states grows with the number of desks, `TRANSITIONS` grows as their product, and adding a
 * fourth desk to FR 38a's three becomes a migration rather than a row in
 * `leave_type_approval_step`. Design principle 5 forbids exactly that: the chain is
 * configuration, so the *number of stages* cannot be in the schema.
 *
 * So the status says whether the request is still being decided and the desk says who is
 * deciding it, and those are two different facts held in two columns.
 *
 * **The destination still comes off {@link TRANSITIONS}.** This function names no status:
 * the last desk's answer is `transitionFor(status, 'APPROVE').to`, and an intermediate
 * stage returns the status the request already had. That is the same discipline
 * {@link settlementTo} keeps, and it matters for the same reason — a function that could
 * name `APPROVED` is a function that could name it one desk early.
 *
 * ## The chain is read now, not at submission, and this is what protects that
 *
 * FR 31 gives the chain to HR and `leaveTypePolicy.setApprovalChain` lets them change it,
 * which means the chain a request was submitted under is not necessarily the chain it is
 * being walked with. Where the change is a widening — HR adds the Chief Executive after
 * themselves — the walk simply finds a further stage and the request keeps going, which is
 * the behaviour HR asked for.
 *
 * Where it removes the desk the request is *standing on*, {@link ApprovalChainChanged} is
 * still the answer, and LMS 316 narrowed what that refusal is protecting rather than making
 * it unnecessary. The danger LMS 314 named — reading "no next stage" as "nobody left to ask"
 * and approving the leave — is gone, because a chain the desk has dropped still has stages
 * nobody has signed and the walk routes to the first of them. What remains is the reason to
 * refuse anyway: **every approval this system records has to belong to a stage**, or "every
 * stage has approved" is a claim about a set that has strangers in it. Letting a desk the
 * chain no longer names sign would put one there.
 *
 * Copying the whole chain onto the request at submission is the other answer, and it is the
 * one FR 11 gave for the counting basis. It is a table of its own and a story of its own;
 * what this does is make the gap loud instead of silent in the meantime.
 */
export function approvalTo(
  request: LeaveRequest,
  chain: readonly ApproverRole[],
  /**
   * FR 41. The desks that had approved before this one. LMS 316.
   *
   * Empty for a request nobody has decided yet, which is what a first approval is handed.
   * Read off `leave_request_decision` by the service — see `desksThatApproved()`.
   */
  approvedAlready: readonly ApproverRole[],
): ApprovalOutcome {
  const transition = transitionFor(request.status, 'APPROVE');

  if (transition === undefined) {
    throw refuseTheMove(request, 'APPROVE');
  }

  const desk = request.awaitingApprovalFrom;

  if (desk === null) {
    /* Unreachable: `leave_request_waits_at_a_desk` makes the column present for exactly
       the status this row is keyed from. Answered rather than asserted, because the
       alternative is approving leave nobody was asked about. */
    throw new LeaveCannotBeMoved(request, 'APPROVE');
  }

  if (!isApprovedBy(chain, desk)) {
    throw new ApprovalChainChanged(request, desk, chain);
  }

  const next = nextUnapproved(chain, [...approvedAlready, desk]);

  return next === undefined
    ? { by: desk, to: transition.to, awaiting: null }
    : { by: desk, to: request.status, awaiting: next };
}

/** Whether that approval was the last word, rather than a step towards one. */
export function isTheLastWord(outcome: ApprovalOutcome): boolean {
  return outcome.awaiting === null;
}

/**
 * How far through its chain a request has got. FR 41, FR 42. LMS 316.
 *
 * The reading half of the story, and the half its "so that" is about: *I never take leave
 * believing it was agreed when it was not*. Every fact needed to be wrong about that is
 * already stored — the status, the desk, the decisions, the chain — and it is stored in four
 * places, which is exactly the arrangement in which a screen shows the newest approval and a
 * person reads it as the answer.
 *
 * So there is one function that puts them together, and {@link ApprovalProgress.agreed} is
 * what anybody asking "is this leave mine to take" reads.
 *
 * ## `agreed` is the status, and the rest is the explanation
 *
 * It is `status === 'APPROVED'` and nothing cleverer, which is worth being explicit about
 * because the tempting definition is `everyStageApproved(chain, approvedBy)`. That second one
 * is a claim about the chain *as it stands this afternoon*, and a chain that has grown a stage
 * since a request was approved would make it false about leave that was properly agreed and
 * whose days are already taken. What was recorded is what happened — design principle 1 — and
 * the status is the record.
 *
 * {@link stagesNotApproved} is asked all the same, and disagreeing with the status is what
 * {@link ApprovalProgress.stagesMissing} reports rather than hides: an approved request whose
 * type has since gained a desk is a real and legitimate state, and a screen that wants to say
 * "agreed under the old policy" can. It is also the shape a defect would take, which is why
 * `leave_request_is_approved_by_every_stage` refuses one at the moment of approval and this
 * only describes what it finds afterwards.
 *
 * ## `stillToApprove` is empty for anything that is not being decided
 *
 * A withdrawn request is not waiting on its manager, and neither is an approved one. Both
 * would otherwise read as "still waiting on HR" for ever, which is the queue entry
 * `leave_request_waits_at_a_desk` exists to stop the schema holding — said here in the
 * reading rather than in a column.
 */
export interface ApprovalProgress {
  /**
   * FR 41. Whether this leave is agreed and may be taken. The one field a person acts on.
   */
  agreed: boolean;
  /** The chain as the type has it now, in order. */
  chain: readonly ApproverRole[];
  /** The stages that have said yes, in chain order. */
  approvedBy: readonly ApproverRole[];
  /** The stages still to be asked, in chain order. Empty unless it is being decided. */
  stillToApprove: readonly ApproverRole[];
  /** The desk it is sitting on now, or null once it is sitting nowhere. */
  awaiting: ApproverRole | null;
  /**
   * Stages of today's chain with no approval on this request, whatever its status.
   *
   * Empty for everything the system does normally. Non-empty means either a request still
   * being decided — where it is the same list as `stillToApprove` — or an approved one whose
   * type has gained a desk since, which is the honest reading rather than a fault.
   */
  stagesMissing: readonly ApproverRole[];
  /** NFR USA 03. What a person is told, in one sentence. */
  inWords: string;
}

/**
 * Where a request stands, from the four facts that say so.
 *
 * Pure, and assembled here rather than in the service for the reason {@link quoteFor} is: the
 * sentence somebody reads before they book a flight is a rule about what they are owed, and
 * it should be testable without a database.
 */
export function progressOf(input: {
  request: LeaveRequest;
  chain: readonly ApproverRole[];
  /** FR 41. The desks that have approved, from `desksThatApproved()`. */
  approvedBy: readonly ApproverRole[];
}): ApprovalProgress {
  const { request, chain, approvedBy } = input;

  const missing = stagesNotApproved(chain, approvedBy);
  const signed = chain.filter((desk) => approvedBy.includes(desk));
  const beingDecided = request.status === 'SUBMITTED';
  const agreed = request.status === 'APPROVED';

  return {
    agreed,
    chain: [...chain],
    approvedBy: signed,
    stillToApprove: beingDecided ? missing : [],
    awaiting: request.awaitingApprovalFrom,
    stagesMissing: missing,
    inWords: progressInWords(request, signed, missing, agreed),
  };
}

/**
 * The sentence, and it says what has happened before it says what has not.
 *
 * NFR USA 03. A person reading this has an aeroplane ticket in the other tab, so the shape is
 * the answer first: agreed, or not yet and who is left. "Approved by your line manager" on its
 * own is the sentence this whole story exists to stop being the whole sentence — which is why
 * the two halves are one string composed once rather than two fields a screen may show one of.
 *
 * The chain is not consulted for the agreed case. See {@link progressOf}.
 */
function progressInWords(
  request: LeaveRequest,
  approved: readonly ApproverRole[],
  missing: readonly ApproverRole[],
  agreed: boolean,
): string {
  const signed =
    approved.length === 0
      ? 'Nobody has approved it yet.'
      : `Approved by ${chainInWords(approved)}.`;

  if (agreed) {
    return `This leave is agreed and is yours to take. ${signed}`;
  }

  if (isSettled(request.status)) {
    return (
      `This leave was ${inWordsSettled(request.status)} and is not yours to take. ${signed} ` +
      `The days are back in your balance.`
    );
  }

  return (
    `This leave is not agreed yet, so do not book anything on it. ${signed} It still ` +
    `needs ${chainInWords(missing)}.`
  );
}

/**
 * Which of the two refusals a move the table does not hold deserves. §6. LMS 314.
 *
 * One place, because the two are told apart by one question and asking it twice is how
 * somebody eventually gets the wrong sentence. Until `APPROVED` existed there was nothing
 * to tell apart: every state that was not settled answered every verb, so every miss was a
 * request that had already ended and {@link settlementTo} said so directly.
 *
 * `APPROVED` is the first state that is running and does not answer everything, and the
 * difference matters to the person reading it. "This leave was already withdrawn and its
 * days are back" is true of a settled request and false of an approved one, where the days
 * are emphatically not back and the answer is a different desk.
 */
function refuseTheMove(request: LeaveRequest, action: RequestAction): Error {
  return isSettled(request.status)
    ? new LeaveAlreadySettled(request)
    : new LeaveCannotBeMoved(request, action);
}

/** What somebody fills in. FR 10's four fields, and nothing else. */
export interface NewLeaveRequest {
  employeeId: string;
  leaveTypeId: string;
  from: CalendarDate;
  to: CalendarDate;
  /**
   * Why. Mandatory, unlike an entitlement event's note, and the difference is who
   * reads it: an event is a fact HR recorded, and a request is somebody asking a
   * manager for something. A manager looking at five days in March with nothing
   * against them is being asked to approve something they know nothing about.
   */
  reason: string;
}

/**
 * The shape a validated request has by the time it reaches the repository.
 *
 * Everything the reservation was calculated from, resolved. `leaveYearId` is the year
 * covering the period rather than today's; `countingBasis`, `days` and `calendarDays`
 * are the copy the story is named for. None of them is supplied by the caller — a
 * caller who could hand over the day count could hand over a smaller one.
 */
export interface ValidatedLeaveRequest {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: CalendarDate;
  to: CalendarDate;
  reason: string;
  countingBasis: CountingBasis;
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /**
   * FR 38a. The first desk in the type's chain, which is where this starts. LMS 314.
   *
   * The story's first criterion, and — like `status` — not a field the caller supplies.
   * {@link validateNewLeaveRequest} takes the chain and reads the front of it, because a
   * caller who could name the desk could name the last one and have a fortnight approved by
   * whoever answered first.
   */
  awaitingApprovalFrom: ApproverRole;
}

/**
 * The only fields an existing request may change.
 *
 * `reason` explains rather than decides, which is the same line
 * `leave_entitlement_event` draws around its `note`. Everything else was what the days
 * were priced from, and the database refuses to move any of it on any connection.
 *
 * `status` is absent because moving it is the state machine's, through the one method
 * the README insists on, rather than an ordinary edit.
 */
export interface LeaveRequestChanges {
  reason?: string;
}

/** A request as it comes back out. */
export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: CalendarDate;
  to: CalendarDate;
  reason: string;
  /**
   * FR 11. The basis this was priced under, as it stood at submission.
   *
   * Read this rather than `leaveType.countingBasis` when rendering a request, always.
   * They agree today and the whole reason the column exists is the day they do not.
   */
  countingBasis: CountingBasis;
  /** What it cost. Whole days, FR 24, and what the RESERVATION took. */
  days: number;
  /** The span, counted or not. "Nine days off, seven of them counted." */
  calendarDays: number;
  status: RequestStatus;
  /**
   * FR 38a, FR 40. The desk this request is sitting on, or null once it is not sitting
   * anywhere. LMS 314.
   *
   * Where a request has got to is two facts, and this is the second of them: `status` says
   * whether it is still being decided, and this says who is deciding it. Held apart rather
   * than folded into one column of `AWAITING_MANAGER`, `AWAITING_HR`, `AWAITING_CEO`
   * because the number of stages is configuration — see {@link approvalTo}, which is the
   * whole argument.
   *
   * Not null exactly while the status is `SUBMITTED`, which `leave_request_waits_at_a_desk`
   * holds as an equivalence on every connection: a request being decided is always sitting
   * with somebody, and one that has been approved, withdrawn, cancelled or refused is
   * waiting on nobody. An approved request that still read "awaiting HR" would put leave
   * that had been agreed in somebody's queue for ever.
   */
  awaitingApprovalFrom: ApproverRole | null;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------- refusals */

/**
 * A request that is not a request.
 *
 * The same shape as {@link InvalidLeaveType} and {@link InvalidLeavePeriod}, and for
 * the same reason, NFR USA 03: the message has to reach the form beside the input it
 * is about.
 */
export class InvalidLeaveRequest extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeaveRequest';
    this.field = field;
  }
}

/** No such request. */
export class LeaveRequestNotFound extends Error {
  readonly leaveRequestId: string;

  constructor(id: string) {
    super(`There is no leave request ${id}.`);
    this.name = 'LeaveRequestNotFound';
    this.leaveRequestId = id;
  }
}

/**
 * A period of leave that costs nothing at all. FR 16a.
 *
 * A Saturday to Sunday of annual leave against a Monday to Friday week, or a single
 * public holiday. Refused rather than stored, and the reason is that every caller
 * downstream would otherwise have to invent the same handling: a request worth no days
 * deducts nothing from a balance, waits in a queue for an approval that changes nothing,
 * and shows on a team calendar as an absence that cost nobody anything. There is no
 * sensible thing for any of them to do with it. `leave_request_costs_at_least_a_day`
 * says the same where no sentence can reach.
 *
 * The message names the days rather than only the verdict, because the person looking at
 * it has typed two dates they believe in and needs to see which part of the period the
 * system thinks is free. Somebody who genuinely meant to record a weekend has not made a
 * mistake about the dates — they have chosen the wrong kind of leave, and a type counting
 * calendar days is the answer.
 *
 * It moved here from ./leave-calculator.ts in LMS 303 with its message unchanged; see the
 * module note for why a refusal about a request does not belong in the arithmetic.
 */
export class LeaveCountsNoDays extends Error {
  readonly leaveTypeId: string;
  readonly period: LeavePeriod;
  readonly free: FreeDay[];

  constructor(type: LeaveType, period: LeavePeriod, free: FreeDay[]) {
    super(
      `${period.from} to ${period.to} costs no ${type.name} at all: ${inWords(free)}. ` +
        `Leave that costs nothing is leave nobody needs to ask for. Check the dates — ` +
        `or, if the whole period really is meant to be recorded, it is a kind of ` +
        `leave that counts every day rather than only working ones.`,
    );
    this.name = 'LeaveCountsNoDays';
    this.leaveTypeId = type.id;
    this.period = period;
    this.free = free;
  }
}

/**
 * A period that runs past the end of a leave year. FR 16.
 *
 * Refused rather than split, and refused with both years named so the person at the
 * form knows what to do instead of only that they may not do this.
 *
 * A request is one period against one balance and a balance belongs to one leave year,
 * so twenty-eighth of December to fifth of January is two balances. Reserving all ten
 * days against either one would be a figure that reconciles and is wrong: days taken
 * in January charged to last year's entitlement, or the reverse. `leave_type.may_be_split`
 * and `assertMayBeSplit()` are what a story offering the split would use, and it is a
 * decision — two requests with one approval between them — rather than an arithmetic
 * anything here could perform.
 *
 * ## The message is two sentences, and the second one is the useful one
 *
 * "This request crosses into the 2027 leave year. Submit one request ending 31 December
 * 2026, and another starting 1 January 2027." NFR USA 03: a refusal that only says no
 * leaves somebody at a form doing date arithmetic to find out what they are allowed to
 * type, and they will get it wrong at exactly the boundary that produced the refusal.
 *
 * **Every year and every date in it is read off the record.** The boundary is
 * `year.endDate`, the day to resume on is {@link dayAfter} of it, and the year being
 * crossed into is whatever HR called it — '2027' here, '2027/28' at a company running
 * April to March, which is why `next` is looked up rather than derived from the month.
 * Nothing here assumes a leave year is a calendar year, because §5.4 is explicit that it
 * need not be and a hard-coded 'the thirty-first of December' would be wrong for the
 * first company that changes.
 *
 * `next` is undefined where nobody has defined the year after this one yet — a gap after
 * the last leave year is allowed, and the database ships with 2026 and 2027 and nothing
 * beyond. The label then falls back to the year part of the day to resume on, which is
 * still read off the record rather than written down: the sentence stays true and the two
 * dates in it stay right, which is the half somebody acts on.
 */
export class LeaveCrossesAYearEnd extends Error {
  /**
   * FR 16. What a client branches on, where the message is what a person reads.
   *
   * The one refusal in this file carrying a code, and the story asks for it by name
   * because this is the one a form is expected to *do* something about — offer the split
   * as two prefilled requests rather than only printing the sentence. A message is
   * reworded the first time somebody reads it aloud; a code is a contract.
   */
  readonly code = 'CROSS_LEAVE_YEAR';
  readonly period: LeavePeriod;
  readonly leaveYearId: string;
  /** The last day one request may cover, and the first day the other may. */
  readonly endsOn: CalendarDate;
  readonly resumesOn: CalendarDate;

  constructor(period: LeavePeriod, year: LeaveYear, next: LeaveYear | undefined) {
    const resumesOn = dayAfter(year.endDate);

    super(
      `This request crosses into the ${next?.label ?? resumesOn.slice(0, 4)} leave year. ` +
        `Submit one request ending ${formatDay(year.endDate)}, and another starting ` +
        `${formatDay(resumesOn)}.`,
    );
    this.name = 'LeaveCrossesAYearEnd';
    this.period = period;
    this.leaveYearId = year.id;
    this.endsOn = year.endDate;
    this.resumesOn = resumesOn;
  }
}

/**
 * The leave already in the way, as the refusal needs to say it. FR 15.
 *
 * The request and the name of its type, because the row carries a `leaveTypeId` and
 * nobody has ever recognised their own leave from one. The conflict is very often of a
 * different kind from the one being asked for — sick leave inside a booked fortnight is
 * the case FR 32b is about — so naming the kind is what makes the sentence recognisable
 * rather than merely true.
 */
export interface ConflictingLeave {
  request: LeaveRequest;
  /** The kind of leave, as a person would say it. `leaveType.name`. */
  typeName: string;
}

/**
 * Leave asked for over leave the person already has. FR 15, §5.6.
 *
 * The days would be reserved twice and come off the balance twice, and nothing in the
 * ledger would look wrong while it happened: both reservations reconcile, both are
 * explainable, and the figure is still incorrect. It is the one defect design principle
 * 1 cannot catch by itself, because the record is faithful and the request should never
 * have been made.
 *
 * **The message names the leave in the way.** "You cannot book those days" tells
 * somebody nothing they can act on — they are looking at a form they believe in, and the
 * clash is with a row they cannot see. So the sentence carries the other request's dates,
 * what it cost and what kind it is, which between them identify it on any leave page, and
 * {@link ConflictingLeave} is on the error so a screen can link to it rather than parse a
 * message for it.
 *
 * ## The one case where it cannot name anything
 *
 * `conflict` is undefined when the refusal came from `leave_request_never_overlaps`
 * rather than from the service's own check — two submissions of the same fortnight
 * racing each other, where both checks read a table with no conflict in it and the
 * database refused the second INSERT. There is no arrangement of application code that
 * closes that window, and by the time the violation is caught the transaction is aborted
 * and cannot be asked which row it collided with.
 *
 * The same class and the same code either way, because a caller catching this wants to
 * know the days clash and should not have to handle two shapes of that. What changes is
 * the second sentence, which says to look rather than pretending to have looked.
 */
export class LeaveOverlapsAnother extends Error {
  /**
   * FR 15. What a client branches on, as `CROSS_LEAVE_YEAR` is.
   *
   * The second refusal here to carry one, and for the same reason: this is a refusal a
   * form is expected to *do* something with — show the clashing leave, offer to jump to
   * it — rather than only print.
   */
  readonly code = 'OVERLAPPING_REQUEST';
  readonly period: LeavePeriod;
  /** The leave in the way. Undefined only on the race; see the class note. */
  readonly conflict: ConflictingLeave | undefined;

  constructor(period: LeavePeriod, conflict?: ConflictingLeave) {
    super(
      conflict === undefined
        ? `Those days overlap leave this person already has. One period of leave per ` +
            `person per day — the same days cannot be booked twice, or they come off a ` +
            `balance twice. Another request for them was submitted at the same moment as ` +
            `this one; reload the leave page and check the dates before asking again.`
        : `You already have leave from ${formatDay(conflict.request.from)} to ` +
            `${formatDay(conflict.request.to)} — ${conflict.request.days} ` +
            `${conflict.request.days === 1 ? 'day' : 'days'} of ${conflict.typeName}. The ` +
            `same days cannot be booked twice, or they come off your balance twice. ` +
            `Withdraw that request, or ask for dates outside it.`,
    );
    this.name = 'LeaveOverlapsAnother';
    this.period = period;
    this.conflict = conflict;
  }
}

/**
 * Leave asked for that the balance does not hold. FR 14, FR 26, NFR USA 03. LMS 305.
 *
 * The story is being told *at once* rather than waiting days for a rejection, and the
 * word doing the work is "told". A person who is refused has to be able to act on the
 * refusal without going and looking anything up, so the sentence carries all three
 * figures they would otherwise have to assemble: what they asked for, what they have,
 * and what they could ask for instead.
 *
 * ## Why this exists when `daysToReserve` already refuses
 *
 * It is the same rule at a different altitude, and the pair is the same arrangement
 * {@link LeaveOverlapsAnother} makes with `leave_request_never_overlaps`.
 *
 * `daysToReserve` is the **guarantee**. It is the only check made against a figure held
 * still — §8.2 — so it is the one that cannot be beaten by two submissions racing, and
 * it must stay where it is. What it cannot do is speak: it is handed a number of days
 * and a balance and knows nothing about leave, so {@link BalanceOverdrawn} says "That is
 * 6 days against a balance of 3" with no leave type in it, no dates, and nothing to do
 * about it. That is the ledger's voice, and it is correct for the ledger.
 *
 * This one is the **sentence**, for everybody who is not in a race — which is everybody.
 * It is raised from the submission path, where the leave type and the period are in
 * hand, so a refusal reads as a refusal about leave.
 *
 * ## What the message says instead of no
 *
 * > This is 6 days of Annual Leave and you have 3 left — 3 days more than the balance
 * > holds. Ask for 3 days or fewer, or speak to HR if the balance itself looks wrong.
 *
 * The second sentence is the useful one, exactly as it is in
 * {@link LeaveCrossesAYearEnd}: a refusal that only says no leaves somebody at a form
 * guessing, and the guess this one produces is "try four days" followed by another
 * refusal. So the figure they may actually ask for is in it.
 *
 * **And it is a whole number of days, floored.** FR 24. A balance of 2.5 — §8.6d
 * pro rates a mid year joiner, so fractions are ordinary — is two days somebody may
 * book, and telling them to ask for 2.5 would be telling them to do the one thing
 * `requireWholeDays` refuses. Where the floor is nought there is nothing to suggest and
 * the sentence stops offering, rather than inviting a request for no days.
 *
 * `available` may itself be negative, which is not a contradiction: §8.6b lets a type
 * that {@link balanceMayBeExceededWithDocument} go past its allowance, and a balance
 * left below nought by one of those is still a balance somebody may later ask against
 * for a type that may not. The figure is reported as it stands rather than clamped —
 * see the note at the top of ./balance.ts about what a clamped figure stops explaining.
 */
export class NotEnoughDays extends Error {
  /**
   * FR 14. What a client branches on, as `CROSS_LEAVE_YEAR` and `OVERLAPPING_REQUEST`
   * are — and deliberately the same token as the {@link QuoteWarning} of that name.
   *
   * The warning and the refusal are one condition seen twice: before somebody commits,
   * where it is worth saying, and at the moment they do, where it stops them. A form
   * that highlights the balance on the quote highlights it on the refusal with the same
   * branch, which is what stops the two being drawn as unrelated problems.
   */
  readonly code = 'NOT_ENOUGH_DAYS';
  readonly leaveTypeId: string;
  readonly period: LeavePeriod;
  /** What the request costs. Whole days, FR 24. */
  readonly requested: number;
  /** What the balance held when this was judged. May be fractional, and may be below nought. */
  readonly available: number;
  /** Positive. How many days short the request is. */
  readonly shortBy: number;
  /** The largest whole request this balance would take. Nought where there is nothing. */
  readonly couldAskFor: number;

  constructor(type: LeaveType, period: LeavePeriod, requested: number, availableDays: number) {
    const couldAskFor = Math.max(0, Math.floor(availableDays));

    super(
      `${daysAgainstTheBalance(type, requested, availableDays)}` +
        (couldAskFor > 0
          ? ` — ${inDays(round(requested - availableDays))} more than the balance holds. ` +
            `Ask for ${inDays(couldAskFor)} or fewer, or speak to HR if the balance ` +
            `itself looks wrong.`
          : `, so there is nothing left to book against. Speak to HR if the balance ` +
            `itself looks wrong.`),
    );
    this.name = 'NotEnoughDays';
    this.leaveTypeId = type.id;
    this.period = period;
    this.requested = requested;
    this.available = availableDays;
    this.shortBy = round(requested - availableDays);
    this.couldAskFor = couldAskFor;
  }
}

/* ------------------------------------------------------- refusing the dates */

/**
 * Whether two periods share a day. FR 15.
 *
 * Inclusive at both ends on both sides, which is the whole of it: leave from the first
 * to the tenth and leave from the tenth to the twelfth share the tenth, and a comparison
 * that missed it would be one day booked twice — the exact shape of the defect. Two
 * string comparisons, for the reason {@link coversDay} is two: a {@link CalendarDate} is
 * ten characters that sort correctly.
 *
 * The same predicate `daterange(start_date, end_date, '[]') WITH &&` states in
 * `leave_request_never_overlaps`, said in the language this half of the system is
 * written in.
 */
export function periodsOverlap(one: LeavePeriod, other: LeavePeriod): boolean {
  return one.from <= other.to && other.from <= one.to;
}

/**
 * Whether the period runs out of the year it started in. FR 16.
 *
 * A string comparison against the year's last day, which is all "crosses a year end"
 * means once {@link coversDay} has found the year the first day is in. The service
 * asks this before it looks up the year being crossed into, because that lookup is a
 * second query and every quote a person's keystrokes produce would otherwise pay for it
 * to answer a question almost every request answers no to.
 *
 * `refuse_a_request_outside_its_leave_year()` holds the same rule for every other
 * writer, so the two cannot drift.
 */
export function reachesPastTheEndOf(year: LeaveYear, period: LeavePeriod): boolean {
  return period.to > year.endDate;
}

/**
 * Refuses a period that nothing in is charged. FR 16a.
 *
 * Takes the count rather than recounting, which is what keeps the number a person is
 * refused on the same number they were quoted: there is one walk over the days and this
 * reads its answer. The free days come from the same {@link DayCount}, so the message
 * names the days that were actually free rather than a second opinion about them.
 *
 * Nought is the only refusable answer. A count cannot come back negative — the walk
 * increments — and every other value is a request somebody may make, affordable or not:
 * whether the days are *there* is the ledger's, and §8.6b lets sick leave go past its
 * allowance on purpose.
 */
export function assertItCostsSomething(
  type: LeaveType,
  period: LeavePeriod,
  count: DayCount,
): void {
  if (count.days === 0) {
    throw new LeaveCountsNoDays(type, period, count.free);
  }
}

/**
 * Refuses a request the balance does not hold. FR 14, FR 26. LMS 305.
 *
 * Takes the count and the figure rather than fetching either, which is what keeps the
 * number a person is refused on the same number they were quoted: `LeaveRequestService`
 * reads the balance once and both the quote's warning and this refusal are made from it.
 *
 * **A type that may be exceeded is not refused, and that is a column rather than a
 * judgement here.** {@link balanceMayBeExceededWithDocument} is FR 32a: sick leave's
 * allowance is the point at which a medical certificate is asked for and not a cap, so
 * going past it is a request for evidence — §8.6b, "sick balances go negative, and that
 * is correct". The quote still warns; see {@link quoteFor}, which says so in the other
 * of its two sentences. That helper has sat in ./leave-type.ts since LMS 201 saying the
 * check "belongs to the submission path, which is the only thing that knows what the
 * balance is". This is that path.
 *
 * **It is not the guarantee**, and {@link NotEnoughDays} says at length why not. The
 * figure was read outside the lock, so between this line and the write somebody's
 * approval may spend it; `daysToReserve` decides again inside the lock and its answer is
 * the one that binds. What is bought here is that almost nobody meets the other one.
 */
export function assertTheDaysAreThere(
  type: LeaveType,
  period: LeavePeriod,
  count: DayCount,
  availableNow: number,
): void {
  if (balanceMayBeExceededWithDocument(type)) {
    return;
  }

  if (count.days > availableNow) {
    throw new NotEnoughDays(type, period, count.days, availableNow);
  }
}

/**
 * What is being asked for against what is there, in the one clause both say.
 *
 * The quote's `NOT_ENOUGH_DAYS` warning and {@link NotEnoughDays} open with this and
 * then diverge, because they are the same fact told at two moments and a person who
 * meets both should not be shown two descriptions of it. What differs is what follows —
 * "so this can still be submitted" against the figure to ask for instead — and that
 * difference is the whole of what each is for.
 *
 * The leave type is named because a balance is per type. "You have 3 left" is a figure
 * somebody will check against the wrong number on their own leave page; "3 days of
 * Annual Leave" is one they can find.
 */
function daysAgainstTheBalance(type: LeaveType, requested: number, availableDays: number): string {
  return `This is ${inDays(requested)} of ${type.name} and you have ${availableDays} left`;
}

/** A count with its noun agreeing, for the sentences that read as sentences. */
function inDays(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Two decimal places, which is the precision a balance is held to.
 *
 * The same rounding ./balance.ts applies to {@link BalanceOverdrawn}'s shortfall and
 * for the same reason: `6 - 2.52` in doubles is a figure with a tail of decimal places
 * on it, and a refusal telling somebody they are `3.4800000000000004` days short is a
 * refusal that has stopped being a sentence. It changes no decision — the comparison
 * above is made on the figures as they were read.
 */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}

/**
 * The free days as a person would say them, for the one message that needs it.
 *
 * Named rather than counted, because "the twenty fifth is Christmas Day" is what makes a
 * refusal actionable and "3 days were free" is what makes somebody ask which. Capped at
 * four, because a refusal listing a hundred and twenty days is a refusal nobody reads to
 * the end of.
 */
function inWords(free: readonly FreeDay[]): string {
  if (free.length === 0) {
    /* Unreachable: a period holds at least one day, and a day that did not count put a
       reason in the list. Answered rather than assumed, because a refusal that trails
       off mid sentence is worse than a clumsy one. */
    return 'no day in it counts';
  }

  const named = free
    .slice(0, 4)
    .map((day) => (day.name === null ? day.date : `${day.date} (${day.name})`));
  const rest = free.length - named.length;

  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

/* --------------------------------------------------------------- the quote */

/**
 * Something worth telling somebody before they submit, that is not a refusal.
 *
 * The difference from an error is whether the request may still go ahead. A period
 * that costs nothing is refused; a period with four days' notice where the type asks
 * for seven is submitted, and the person is told. FR 17 is explicitly a warning rather
 * than a bar — leave is sometimes needed at short notice and the system's job is to
 * make sure nobody is surprised, not to make it impossible.
 */
export const QUOTE_WARNINGS = [
  /** FR 17. Less notice than the type asks for. Advisory; the approver decides. */
  'SHORT_NOTICE',
  /** FR 13. This length of this type needs something attached to it. */
  'DOCUMENTATION_REQUIRED',
  /**
   * FR 14. The days are not there.
   *
   * The one warning that is usually a refusal: {@link assertTheDaysAreThere} raises
   * {@link NotEnoughDays} on the same condition at submission, under the same code.
   * It stays a *warning* here because of the one type it is not a refusal for — FR
   * 32a's exceedable allowance — and because a quote's job is to tell somebody where
   * they stand rather than to stop them reading it.
   */
  'NOT_ENOUGH_DAYS',
] as const;

export type QuoteWarning = (typeof QUOTE_WARNINGS)[number];

export interface RequestWarning {
  code: QuoteWarning;
  /** In words the person at the form can act on. NFR USA 03. */
  message: string;
}

/**
 * What a period would cost, before anything is written. The story's second criterion.
 *
 * Everything a form needs to say "this is what you are asking for" in a sentence
 * somebody accepts: the number, the basis it was reached by, the days inside the
 * period that were free and why, what the balance is now and what it would become,
 * and anything worth knowing that is not a refusal.
 *
 * `free` is what turns a number into an explanation. "Nine days off cost you seven" is
 * an assertion; "the twenty-fifth is Christmas Day and the twenty-sixth is Boxing Day"
 * is the reason, and NFR USA 03 asks for the second.
 *
 * `availableAfter` may be negative, and legitimately: §8.6b lets sick leave go past
 * its allowance because FR 32a makes that a documentation threshold rather than a cap.
 * A quote showing −3 with a `DOCUMENTATION_REQUIRED` warning beside it is the honest
 * account of what somebody is about to ask for.
 */
export interface LeaveRequestQuote {
  leaveTypeId: string;
  leaveTypeName: string;
  from: CalendarDate;
  to: CalendarDate;
  /** FR 11. The basis this was counted under, which is what would be copied onto it. */
  countingBasis: CountingBasis;
  /** In words, for a screen: "working days" or "every day, weekends included". */
  countingBasisInWords: string;
  days: number;
  calendarDays: number;
  free: DayCount['free'];
  /** What the balance holds now, and what it would hold if this were submitted. */
  availableNow: number;
  availableAfter: number;
  /** Who would decide it, in words. FR 38a. */
  approvedBy: string;
  warnings: RequestWarning[];
}

/**
 * The quote, from the facts the service has gathered.
 *
 * Pure, and assembled here rather than in the service for the reason every rule in
 * this system lives in `/domain`: the sentence a person is shown before they commit to
 * a fortnight is a rule about what they are owed an explanation of, and it should be
 * testable without a database.
 *
 * The warnings are read off the leave type by the helpers that have been sitting in
 * ./leave-type.ts unused since LMS 201 — {@link noticeShortfall} and
 * {@link documentationRequired} — which is what those were built for.
 */
export function quoteFor(input: {
  type: LeaveType;
  period: LeavePeriod;
  count: DayCount;
  availableNow: number;
  daysOfNotice: number;
}): LeaveRequestQuote {
  const { type, period, count, availableNow, daysOfNotice } = input;
  const warnings: RequestWarning[] = [];

  const shortfall = noticeShortfall(type, daysOfNotice);
  if (shortfall > 0) {
    warnings.push({
      code: 'SHORT_NOTICE',
      message:
        `${type.name} normally wants ${type.minNoticeCalendarDays} days' notice and this ` +
        `gives ${daysOfNotice}. It can still be submitted — whoever approves it will see ` +
        `that it was short by ${shortfall}.`,
    });
  }

  if (documentationRequired(type, count.days)) {
    warnings.push({
      code: 'DOCUMENTATION_REQUIRED',
      message:
        `${count.days} days of ${type.name} needs supporting documentation. Have it ready ` +
        `— whoever approves this will ask for it.`,
    });
  }

  if (count.days > availableNow) {
    warnings.push({
      code: 'NOT_ENOUGH_DAYS',
      message: balanceMayBeExceededWithDocument(type)
        ? `${daysAgainstTheBalance(type, count.days, availableNow)}. ${type.name} may go ` +
          `past its allowance with documentation, so this can still be submitted.`
        : `${daysAgainstTheBalance(type, count.days, availableNow)}, so it cannot be ` +
          `submitted as it stands.`,
    });
  }

  return {
    leaveTypeId: type.id,
    leaveTypeName: type.name,
    from: period.from,
    to: period.to,
    countingBasis: type.countingBasis,
    countingBasisInWords: countingBasisInWords(type.countingBasis),
    days: count.days,
    calendarDays: count.calendarDays,
    free: count.free,
    availableNow,
    availableAfter: availableNow - count.days,
    approvedBy: approvalChainInWords(type),
    warnings,
  };
}

/**
 * How many days' notice a request submitted today gives. FR 17.
 *
 * Calendar days between the day it is asked for and the first day off, so a request
 * made on Monday for the following Monday gives seven whatever the person's working
 * pattern is. Notice is about how much warning somebody had, and a manager's warning
 * does not shorten because the requester does not work Wednesdays.
 *
 * Zero for leave starting today, and negative for leave that has already begun — which
 * is FR 18's backdating, a real thing HR does for somebody who was off sick and could
 * not ask. {@link noticeShortfall} takes any negative as the full shortfall; the
 * magnitude is carried anyway, because "three weeks late" and "a day late" are not the
 * same conversation and a screen showing the number should show the true one.
 *
 * Both directions go through {@link calendarDaysBetween}, which counts inclusively and
 * clamps at zero for a pair the wrong way round — so each direction is asked with its
 * own arguments in the right order rather than one subtraction being trusted to go
 * negative.
 */
export function noticeGiven(asAt: CalendarDate, from: CalendarDate): number {
  return from >= asAt
    ? calendarDaysBetween(asAt, from) - 1
    : -(calendarDaysBetween(from, asAt) - 1);
}

/**
 * What the RESERVATION says it is for. FR 27.
 *
 * The sentence somebody reads beside five days missing from their balance, so it
 * carries the three things they would otherwise have to go and look up: what kind of
 * leave, how much, and when. The request id is not in it and does not need to be —
 * `leave_ledger_entry.leave_request_id` is the join, and a reason full of identifiers
 * is a reason nobody reads.
 *
 * Composed here rather than in the service for the reason `reasonForGrant` is: the
 * words in somebody's balance history are part of what the system promises, and a
 * service assembling them is a service that can assemble them differently next time.
 */
export function reasonForReservation(typeName: string, period: LeavePeriod, days: number): string {
  return (
    `${days} ${days === 1 ? 'day' : 'days'} of ${typeName} requested, ` +
    `${period.from} to ${period.to}, held while it is decided`
  );
}

/**
 * What the RELEASE says it is for. FR 27, LMS 306.
 *
 * The other half of {@link reasonForReservation}, and the sentence somebody reads beside
 * five days arriving back in their balance. The pair read as a pair in a history — "held
 * while it is decided", then "given back, the request was withdrawn" — which is what
 * makes a balance explain itself to the person looking at it rather than merely
 * reconcile.
 *
 * **Which of the three endings it was is in the sentence**, because that is the part
 * nobody can reconstruct from the figures. Five days coming back look identical whether
 * the person changed their mind, a manager turned it down or HR unwound it, and those are
 * three different conversations. The request id is not in it and does not need to be —
 * `leave_ledger_entry.leave_request_id` is the join, and a reason full of identifiers is a
 * reason nobody reads.
 */
export function reasonForRelease(
  typeName: string,
  period: LeavePeriod,
  days: number,
  to: ReleasingStatus,
): string {
  return (
    `${days} ${days === 1 ? 'day' : 'days'} of ${typeName} given back, ` +
    `${period.from} to ${period.to}, the request was ${inWordsSettled(to)}`
  );
}

/**
 * What the DEDUCTION says it is for. FR 27, FR 38a. LMS 314.
 *
 * The third of the trio, and the one whose figures do not move: a `DEDUCTION` takes the
 * days out of `pending` and puts the same days into `taken`, so available is exactly where
 * it was. Somebody reading their balance sees a number that has not changed beside a line
 * that has to explain why it appears at all — which is what "held while it is decided" has
 * stopped being true and "now taken" has started being true, said in one sentence.
 *
 * **The last approver is named as a desk rather than as a person**, and that is deliberate.
 * The ledger is a record of what happened to a balance and is read by whoever is looking at
 * one; who signed the request off belongs to the request and to the audit log, which carries
 * the actor on the row it wrote. Putting a name here would also put it in front of every
 * colleague a balance is ever shown to.
 */
export function reasonForApproval(
  typeName: string,
  period: LeavePeriod,
  days: number,
  by: ApproverRole,
): string {
  return (
    `${days} ${days === 1 ? 'day' : 'days'} of ${typeName} taken, ` +
    `${period.from} to ${period.to}, approved by ${chainInWords([by])}`
  );
}

/**
 * What happened to a request, as a person says it. "withdrawn", not `WITHDRAWN`.
 *
 * A function of the status rather than of anything else, for the reason
 * {@link countingBasisInWords} is: a screen never shows an underscored constant, and one
 * mapping in one place is what stops the ledger's word and the refusal's word drifting
 * apart. Three callers here — {@link reasonForRelease}, {@link LeaveAlreadySettled} and
 * {@link LeaveCannotBeMoved} — and the first two are precisely the pair a person meets in
 * sequence when they press the button twice.
 *
 * **Exported since LMS 402**, which is the fourth caller and the first outside this file.
 * `statusInWords` in ./request-history.ts puts the same word on the history screen, and the
 * alternative was a second mapping written for a `<span>` — at which point a request could
 * read "refused" in a balance's history and "declined" in its own, and neither screen would
 * be wrong about anything except the other one.
 *
 * `APPROVED` is in it since LMS 314 and `SUBMITTED` deliberately is not: every caller here is
 * describing something that has already happened to the request, and "this leave has been
 * submitted" is not a refusal anybody needs. It falls to the default, which says less
 * rather than something wrong. The history screen is the one caller that has to say
 * something about a request still being decided, and it answers that status itself rather
 * than widening this — a status column describing a state that is still running is that
 * screen's problem, and "decided" would be a worse answer there than a missing one.
 */
export function inWordsSettled(status: RequestStatus): string {
  switch (status) {
    case 'WITHDRAWN':
      return 'withdrawn';
    case 'CANCELLED':
      return 'cancelled';
    case 'REFUSED':
      return 'refused';
    case 'APPROVED':
      return 'approved';
    default:
      /* Unreachable in the two release callers, which take a `ReleasingStatus`, and
         reachable in principle from {@link LeaveCannotBeMoved} — which is thrown only for a
         state with a gap in its row, and `SUBMITTED` has none. Answered rather than
         asserted, because a sentence that reads "the request was undefined" is worse than
         one that says less. */
      return 'decided';
  }
}

/**
 * "withdrawn, refused or cancelled". A list a person reads rather than a JSON array.
 *
 * Here rather than at the one call site because {@link chainInWords} makes the same
 * sentence about approvers and the two should read alike — a refusal that says "withdraw,
 * refuse, cancel" beside one that says "your line manager then HR" is two voices in one
 * screen.
 */
function listOf(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? 'nothing')
    : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/* ------------------------------------------------------------ what is stored */

/**
 * That the four fields somebody filled in are four fields.
 *
 * The dates are checked for shape only. Whether they are a *period* — the right way
 * round, and costing something, and inside one leave year — is
 * {@link validateLeavePeriod}, {@link assertItCostsSomething} and
 * {@link reachesPastTheEndOf}, each of which refuses with a message naming the days.
 * Asking the same question twice in two voices is how two different sentences come to be
 * shown for one mistake, so this asks none of them again.
 *
 * By the time anything reaches here all three have been asked, in the order the answers
 * become possible in — see ../services/leave-request-service.ts. What is left is the
 * four fields being four fields.
 */
export function validateNewLeaveRequest(input: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: CalendarDate;
  to: CalendarDate;
  reason: string;
  countingBasis: CountingBasis;
  days: number;
  calendarDays: number;
  /**
   * FR 38a. The type's chain, from which the first stage is taken. LMS 314.
   *
   * The chain rather than the desk, for the reason `countingBasis` is the basis rather
   * than the day count: what the caller hands over is what it read off the leave type, and
   * the reading of it happens once, here.
   */
  approvalChain: readonly ApproverRole[];
}): ValidatedLeaveRequest {
  return {
    employeeId: requireId('employeeId', input.employeeId),
    leaveTypeId: requireId('leaveTypeId', input.leaveTypeId),
    leaveYearId: requireId('leaveYearId', input.leaveYearId),
    from: requireDay('from', input.from),
    to: requireDay('to', input.to),
    reason: requireReason(input.reason),
    countingBasis: input.countingBasis,
    days: requireWholeDays('days', input.days),
    calendarDays: requireWholeDays('calendarDays', input.calendarDays),
    /* Not a parameter. A caller that could choose the status could submit something
       already approved, and the README's rule is that only the state machine moves
       one — which starts with only one thing being able to create one. */
    status: 'SUBMITTED',
    /* FR 38a, and the same argument one line up. A caller that could name the desk could
       name the last one, and a fortnight would be one signature from approved. */
    awaitingApprovalFrom: theFirstDesk(input.approvalChain),
  };
}

/**
 * The desk a new request starts at. FR 38, FR 38a. LMS 314's first criterion.
 *
 * Read off the chain and nowhere else, which is the whole criterion: annual leave starts
 * with the line manager because its chain starts with `MANAGER`, and unpaid leave starts
 * with HR because its chain starts with `HR` — not because anything here knows which type
 * is which. Design principle 5, and the README's version of it: "If either appears as an
 * `if` on a type code, that is a bug."
 *
 * A chain with nobody in it is refused rather than defaulted, and `assertSomebodyApprovesIt`
 * has already said so in a sentence naming the type — this is the same refusal one layer in,
 * where there is no leave type in hand to name. Defaulting to {@link DEFAULT_APPROVAL_CHAIN}
 * here is the tempting alternative and it is the one ./approval-chain.ts argues against at
 * length: a fallback read would route a request somewhere the configuration screen shows
 * nothing for.
 */
function theFirstDesk(chain: readonly ApproverRole[]): ApproverRole {
  const first = firstApprover(chain);

  if (first === undefined) {
    throw new InvalidLeaveRequest(
      'approvalChain',
      'This kind of leave has nobody set up to approve it, so a request for it would sit ' +
        'in no queue at all. Ask an HR Administrator to say who approves it.',
    );
  }

  return first;
}

/**
 * A changed reason, or nothing.
 *
 * Deliberately not a general update. The one editable field is checked the same way
 * it was on the way in, so a reason cannot be blanked afterwards by a path the create
 * would have refused.
 */
export function validateLeaveRequestChanges(changes: LeaveRequestChanges): { reason: string } {
  if (changes.reason === undefined) {
    throw new InvalidLeaveRequest(
      'reason',
      'There is nothing to change. The dates, the kind of leave and what it cost are ' +
        'what the days were reserved against and cannot be edited; only the reason can.',
    );
  }

  return { reason: requireReason(changes.reason) };
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveRequest(field, `${field} is required.`);
  }

  return value.trim();
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidLeaveRequest(
      field,
      `${field} is a date in the form YYYY-MM-DD. 03/04/2026 and 04/03/2026 are the ` +
        `same ten characters meaning two different days.`,
    );
  }

  return value;
}

/**
 * FR 10, and the argument for it being mandatory is in {@link NewLeaveRequest}.
 *
 * Trimmed, never defaulted, and unconstrained beyond being something — the same rule a
 * ledger entry's reason is held to, and for the same reason: a reason nobody can write
 * freely is a reason everybody writes 'leave' in.
 */
function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveRequest(
      'reason',
      'A leave request says why. Whoever approves it is being asked to agree to ' +
        'something, and a request with nothing against it asks them to agree to it blind.',
    );
  }

  return value.trim();
}

/** FR 24. Leave is requested in whole days; the ledger's fractions are entitlement. */
function requireWholeDays(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidLeaveRequest(
      field,
      `${field} is a whole number of days, at least one. Leave is requested in whole ` +
        `days — FR 24 — and a morning off is settled with a manager rather than here.`,
    );
  }

  return value;
}
