/**
 * Asking for leave, and knowing what it costs first. FR 10, FR 11, FR 14, FR 15, FR 16, FR 26, §6, §8., LMS 301, LMS 303, LMS 304, LMS 305, LMS 306, LMS 313, LMS 314, FR 38, FR 38a, FR 40, LMS 315, FR 39, FR 52, FR 16a, §8.3, FR 25, §8.2, FR 48, FR 48b.
 */

import {
  type ApproverRole,
  chainInWords,
  isApprovedBy,
  stagesNotApproved,
  stagesYetToDecide,
} from '../leave-type/approval-chain.js';
import {
  desksAsked,
  type DesksAvailable,
  type Routed,
  routeFrom,
  type SkippedStage,
  stagesSkipped,
  whatWouldRouteIt,
} from './routing.js';
import type { DecidingAction } from './leave-decision.js';
import type { DayCount, FreeDay, LeavePeriod } from '../leave-calculator/leave-calculator.js';
import {
  approvalChainInWords,
  balanceMayBeExceededWithDocument,
  type CountingBasis,
  countingBasisInWords,
  documentationRequired,
  type LeaveType,
  noticeShortfall,
} from '../leave-type/leave-type.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import {
  type CalendarDate,
  calendarDaysBetween,
  dayAfter,
  formatDay,
  isCalendarDate,
} from '../../shared/time.js';

/** Where a request has got to. LMS 301, LMS 306, LMS 314, LMS 209, LMS 320, FR 38a, FR 48b. */
export const REQUEST_STATUSES = [
  'SUBMITTED',
  'APPROVED',
  /**
   * Nobody can decide it. FR 48b, §8.6a, LMS 320.
   *
   * Neither an ending nor an approval: the days are still held and the leave is still
   * wanted, and what is missing is somebody to ask. `route` puts it back once there is one.
   */
  'UNROUTABLE',
  'WITHDRAWN',
  'CANCELLED',
  'REFUSED',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** The three endings that give the days back. FR 26, §8.2., LMS 306, LMS 212, LMS 314. */
export const RELEASING_STATUSES = ['WITHDRAWN', 'CANCELLED', 'REFUSED'] as const;

export type ReleasingStatus = (typeof RELEASING_STATUSES)[number];

/**
 * The statuses that hold a person's days. FR 15, §5.6., LMS 304, LMS 314, LMS 306, LMS 320.
 *
 * `UNROUTABLE` is one of them: its RESERVATION still stands, so the days are out of the
 * balance and the dates are still spoken for.
 */
export const LIVE_STATUSES: readonly RequestStatus[] = ['SUBMITTED', 'APPROVED', 'UNROUTABLE'];

/** Whether a request in this state still holds the days it covers. FR 15. */
export function blocksTheCalendar(status: RequestStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/** Whether this request has already been settled, and its days already given back. */
export function isSettled(status: RequestStatus): status is ReleasingStatus {
  return (RELEASING_STATUSES as readonly RequestStatus[]).includes(status);
}

/** A request being ended a second time. FR 26, §8.2., LMS 306. */
export class LeaveAlreadySettled extends Error {
  /** FR 26. */
  readonly code = 'ALREADY_SETTLED';
  readonly leaveRequestId: string;
  /** Where it had already got to. */
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
      actionInWords(transition.action),
    );

    super(
      `This leave has been ${inWordsSettled(request.status)}, and ${actionInWords(action)} ` +
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

/**
 * A request sent back into its chain that still has nowhere to go. FR 48b, §8.6a. LMS 320.
 *
 * What `route` answers when the organisation has not changed since the alert went out. It
 * names the desk that is still empty and what would fill it, because the person reading it
 * is being asked to change the organisation rather than to decide the leave.
 */
export class StillNobodyToDecideIt extends Error {
  /** FR 48b. */
  readonly code = 'STILL_UNROUTABLE';
  readonly leaveRequestId: string;
  /** The stage that has neither its own desk nor a stand-in. */
  readonly stranded: ApproverRole;

  constructor(request: LeaveRequest, stranded: ApproverRole, remedy: string) {
    super(
      `This request still has nobody who could decide it: ${chainInWords([stranded])} is ` +
        `the stage it stops at, and neither that desk nor the one that stands in for it ` +
        `has anybody at it who is not the person who asked. ${remedy} Nothing about the ` +
        `request is wrong, and it keeps its days until it is decided or taken back. FR 48b.`,
    );
    this.name = 'StillNobodyToDecideIt';
    this.leaveRequestId = request.id;
    this.stranded = stranded;
  }
}

/**
 * An override with no line manager's decision under it to reverse. FR 44, §7.2. LMS 318.
 *
 * Told apart from {@link LeaveCannotBeMoved} because the request may be sitting in exactly
 * the right place and still have nothing to overturn — leave nobody has decided yet, or
 * leave whose manager already agreed with the desk now looking at it.
 */
export class NothingToOverturn extends Error {
  /** FR 44. */
  readonly code = 'NOTHING_TO_OVERTURN';
  readonly leaveRequestId: string;
  /** What the line manager actually said, where they have said anything. */
  readonly managerSaid: DecidingAction | null;

  constructor(request: LeaveRequest, action: RequestAction, managerSaid: DecidingAction | null) {
    const wanted = action === 'OVERTURN_REJECTION' ? 'turned down' : 'approved';

    super(
      `An override reverses a line manager’s decision, and this leave has not been ` +
        `${wanted} by one. ${
          managerSaid === null
            ? 'No line manager has decided it.'
            : 'Their line manager decided it the same way you are about to.'
        } Decide it as you would any other request. FR 44.`,
    );
    this.name = 'NothingToOverturn';
    this.leaveRequestId = request.id;
    this.managerSaid = managerSaid;
  }
}

/**
 * A plain decision that would silently contradict a line manager. FR 44, §7.2. LMS 318.
 *
 * The refusal that makes "written justification mandatory" mean something. Approving leave
 * a manager turned down, or turning down leave a manager agreed to, is an override whether
 * or not the person pressing the button called it one — so the plain verb is refused and
 * the override is named, which is the one path that asks for the reason in writing.
 */
export class OverrulingNeedsAnOverride extends Error {
  /** FR 44. */
  readonly code = 'OVERRULING_NEEDS_AN_OVERRIDE';
  readonly leaveRequestId: string;
  /** The verb to use instead. */
  readonly instead: RequestAction;

  constructor(request: LeaveRequest, instead: RequestAction) {
    super(
      `This leave has already been decided the other way by the line manager, so ` +
        `${actionInWords(instead)} rather than deciding it afresh. Overturning a ` +
        `manager’s decision is recorded as what it is and asks for a justification in ` +
        `writing, which is what they and the person who asked for the leave will read. ` +
        `FR 44.`,
    );
    this.name = 'OverrulingNeedsAnOverride';
    this.leaveRequestId = request.id;
    this.instead = instead;
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
export const REQUEST_ACTIONS = [
  'WITHDRAW',
  'REFUSE',
  'CANCEL',
  'APPROVE',
  /** HR reversing a line manager's rejection. FR 44, §7.2, LMS 318. */
  'OVERTURN_REJECTION',
  /** HR reversing a line manager's approval. FR 44, §7.2, LMS 318. */
  'OVERTURN_APPROVAL',
  /**
   * Sending a request nobody could decide back into its chain. FR 48b, §8.6a, LMS 320.
   *
   * Not a decision — it says nothing about the leave and writes no ledger entry. It is the
   * act the alert asks HR for once the desk that came up empty has somebody at it.
   */
  'ROUTE',
] as const;

export type RequestAction = (typeof REQUEST_ACTIONS)[number];

/** A verb as a person says it, rather than as the column holds it. NFR USA 03, FR 44. */
export function actionInWords(action: RequestAction): string {
  switch (action) {
    case 'OVERTURN_REJECTION':
      return 'overturn the rejection';
    case 'OVERTURN_APPROVAL':
      return 'overturn the approval';
    /** FR 48b. */
    case 'ROUTE':
      return 'send it to an approver';
    default:
      return action.toLowerCase();
  }
}

/**
 * The two that end a request outright and give its days back. FR 26, §8.2, FR 44. LMS 306, LMS 314, LMS 318.
 *
 * The verbs `LeaveRequestService.settle` and `BalanceService.releaseForRequest` are typed
 * on. Neither is a decision at a desk: taking back your own leave and HR unwinding a row
 * that should not be on the books both end a request wherever it has got to.
 *
 * `REFUSE` left this list with LMS 318 — a refusal is a decision that may or may not end
 * the request, so it goes through the decision door like an approval and releases days
 * only when it is the last word.
 *
 * Written out rather than derived from {@link REQUEST_ACTIONS}, so that the next verb to
 * arrive does not join it by subtraction.
 */
export const RELEASING_ACTIONS = ['WITHDRAW', 'CANCEL'] as const;

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
 * ../features/leave-request/policy.ts to say which roles satisfy `LEAVE_ADMINISTRATION`. The
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
 * on the HR desk; only ../features/leave-request/policy.ts may know that an HR Officer and an
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
  /** Stages the routing had to skip on the way, to be recorded. FR 48b, LMS 320. */
  skips: readonly SkippedStage[];
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

  /* Turning down a request at the desk it is sitting on. FR 44, §7.2. LMS 318.

     `to` is where the *last* desk's no leaves it. A stage before the last records the
     refusal and hands the request on, exactly as an approval does — both are decisions,
     and neither is the answer until every stage has given one.

     Narrowed to `THE_DESK_IT_IS_WITH` by LMS 318, from the line manager and HR alike.
     A refusal now advances the chain, so one made away from the desk would mark a stage
     decided by somebody who was never asked. Unwinding a request that should not be on
     the books is still HR's, and is `CANCEL`. */
  { from: 'SUBMITTED', action: 'REFUSE', to: 'REFUSED', by: ['THE_DESK_IT_IS_WITH'] },

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

  /* The same two verbs said over a line manager who decided otherwise. FR 44, §7.2. LMS 318.

     An override is an ordinary decision at the desk the request is sitting on, and the
     only thing that distinguishes it is that an earlier stage said the opposite. It is a
     separate verb rather than a flag on the two above because it asks something of the
     person making it that the plain verbs do not — a justification in writing — and
     because it is the value FR 44 wants readable on the record for ever.

     Nothing moves out of an ending. `to` is where the *last* stage leaves it, as on the
     two rows above. */
  { from: 'SUBMITTED', action: 'OVERTURN_REJECTION', to: 'APPROVED', by: ['THE_DESK_IT_IS_WITH'] },
  { from: 'SUBMITTED', action: 'OVERTURN_APPROVAL', to: 'REFUSED', by: ['THE_DESK_IT_IS_WITH'] },

  /* A request nobody could be found to decide. FR 48b, §8.6a. LMS 320.

     No decision among them, which is the whole of it: a request is unroutable because
     nobody can decide it. `ROUTE` is what the alert asks HR for once somebody can. */
  {
    from: 'UNROUTABLE',
    action: 'WITHDRAW',
    to: 'WITHDRAWN',
    by: ['THE_REQUESTER', 'LEAVE_ADMINISTRATION'],
  },
  { from: 'UNROUTABLE', action: 'CANCEL', to: 'CANCELLED', by: ['LEAVE_ADMINISTRATION'] },
  { from: 'UNROUTABLE', action: 'ROUTE', to: 'SUBMITTED', by: ['LEAVE_ADMINISTRATION'] },
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
 * The projection ../features/leave-request/policy.ts decides on, and it is deliberately
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

/** Everything a decision's destination is worked out from. FR 38a, FR 44, FR 48b. */
export interface DecisionAtADesk {
  request: LeaveRequest;
  action: DecidingAction;
  /** FR 38a. The type's chain as it stands now. */
  chain: readonly ApproverRole[];
  /** FR 44. The desks that have decided, whichever way they went. */
  decidedAlready: readonly ApproverRole[];
  /** FR 48b. The stages already skipped, as recorded against this request. LMS 320. */
  skipped: readonly SkippedStage[];
  /** FR 48b. Who can be asked at each desk, for this request. LMS 320. */
  available: DesksAvailable;
}

/**
 * Where a decision leaves the request: on to the next desk, decided, or nowhere. FR 38, FR 38a, FR 40, FR 41, FR 42, FR 44, FR 48b, §6., §7.2, §8.6a, LMS 314, LMS 316, LMS 318, LMS 320.
 *
 * One walk for all four deciding verbs. What ends a request is the chain running out of
 * desks, not which way this desk went — so a line manager's rejection carries the request on
 * to HR exactly as their approval would, and the last stage to decide is the one whose verb
 * the request lands on.
 *
 * Since LMS 320 there is a third destination. Where the next stage has neither its own desk
 * nor a stand-in the request lands on `UNROUTABLE` rather than on the verb — running out of
 * people to ask never approves and never refuses anything.
 */
export function decisionTo(input: DecisionAtADesk): ApprovalOutcome {
  const { request, action, chain, decidedAlready, skipped, available } = input;

  const transition = transitionFor(request.status, action);

  if (transition === undefined) {
    throw refuseTheMove(request, action);
  }

  const desk = request.awaitingApprovalFrom;

  if (desk === null) {
    throw new LeaveCannotBeMoved(request, action);
  }

  /* FR 48b. The desks this request is actually asked at, which is its type's chain with
     every recorded skip substituted in — a request that fell to a stand-in is standing at a
     desk the chain itself does not name. */
  const asked = desksAsked(chain, skipped);

  if (!isApprovedBy(asked, desk)) {
    throw new ApprovalChainChanged(request, desk, asked);
  }

  const routed = routeFrom({
    chain,
    decided: [...decidedAlready, desk],
    skipped,
    available,
  });

  switch (routed.kind) {
    case 'DESK':
      return { by: desk, to: request.status, awaiting: routed.desk, skips: routed.skips };
    case 'UNROUTABLE':
      return { by: desk, to: 'UNROUTABLE', awaiting: null, skips: routed.skips };
    default:
      return { by: desk, to: transition.to, awaiting: null, skips: routed.skips };
  }
}

/**
 * Whether that decision was the last word, rather than a step towards one. FR 48b.
 *
 * Both halves are needed since LMS 320: a request that stopped because nobody could be asked
 * is also waiting on nobody, and it is emphatically not decided — no days move on it.
 */
export function isTheLastWord(outcome: ApprovalOutcome): boolean {
  return outcome.awaiting === null && outcome.to !== 'UNROUTABLE';
}

/** Where a request goes when it is sent back into its chain. FR 48b, §8.6a. LMS 320. */
export interface RoutedAgain {
  to: RequestStatus;
  awaiting: ApproverRole;
  skips: readonly SkippedStage[];
}

/**
 * Where sending an unroutable request back into its chain leaves it. FR 48b, §8.6a. LMS 320.
 *
 * The same walk a decision makes, with nothing decided by it: no desk answers, no ledger
 * entry is written, and the request goes back to being decided at whichever desk can now be
 * asked. Refused with {@link StillNobodyToDecideIt} where nothing has changed.
 */
export function routingTo(input: {
  request: LeaveRequest;
  chain: readonly ApproverRole[];
  decidedAlready: readonly ApproverRole[];
  skipped: readonly SkippedStage[];
  available: DesksAvailable;
}): RoutedAgain {
  const { request, chain, decidedAlready, skipped, available } = input;

  const transition = transitionFor(request.status, 'ROUTE');

  if (transition === undefined) {
    throw refuseTheMove(request, 'ROUTE');
  }

  const routed = routeFrom({ chain, decided: decidedAlready, skipped, available });

  if (routed.kind === 'UNROUTABLE') {
    throw new StillNobodyToDecideIt(
      request,
      routed.stranded,
      whatWouldRouteIt(routed.stranded, available),
    );
  }

  if (routed.kind === 'DECIDED') {
    /* Unreachable: a request is unroutable because a stage it reached had nobody to answer
       it, and a stage nobody answered has not decided. Answered rather than asserted,
       because the alternative is leave agreed by a stage that was never asked. */
    throw new LeaveCannotBeMoved(request, 'ROUTE');
  }

  return { to: transition.to, awaiting: routed.desk, skips: routed.skips };
}

/** How far through its chain a request has got. FR 41, FR 42, FR 44, FR 48b, LMS 316, LMS 318, LMS 320. */
export interface ApprovalProgress {
  /** FR 41. */
  agreed: boolean;
  /** FR 48b. Nobody can decide it, and HR has been told. LMS 320. */
  unroutable: boolean;
  /** The desks this request is asked at: the type's chain with its skips substituted in. */
  chain: readonly ApproverRole[];
  /** FR 48b. The stages that went somewhere else, and why. LMS 320. */
  skipped: readonly SkippedStage[];
  /** The stages that have said yes, in chain order. */
  approvedBy: readonly ApproverRole[];
  /** The stages that have said no, in chain order. FR 44, LMS 318. */
  refusedBy: readonly ApproverRole[];
  /** The stages still to be asked, in chain order. */
  stillToApprove: readonly ApproverRole[];
  /** The desk it is sitting on now, or null once it is sitting nowhere. */
  awaiting: ApproverRole | null;
  /** Stages of today's chain with no approval on this request, whatever its status. */
  stagesMissing: readonly ApproverRole[];
  /** NFR USA 03. */
  inWords: string;
}

/** Where a request stands, from the facts that say so. FR 41, FR 44, FR 48b. */
export function progressOf(input: {
  request: LeaveRequest;
  /** FR 38a. The type's chain, which the skips below are substituted into. */
  chain: readonly ApproverRole[];
  /** FR 41. */
  approvedBy: readonly ApproverRole[];
  /** FR 44, LMS 318. */
  refusedBy?: readonly ApproverRole[];
  /** FR 48b, LMS 320. */
  skipped?: readonly SkippedStage[];
}): ApprovalProgress {
  const { request, approvedBy } = input;
  const refusedBy = input.refusedBy ?? [];
  const skipped = input.skipped ?? [];

  /* FR 48b. The desks actually asked, so a skipped stage is not still owed an answer. */
  const chain = desksAsked(input.chain, skipped);

  const missing = stagesNotApproved(chain, approvedBy);
  const signed = chain.filter((desk) => approvedBy.includes(desk));
  const turnedDown = chain.filter((desk) => refusedBy.includes(desk));
  /* FR 44. Still to be *asked*, which is not the same as still to approve: a stage that
     turned the leave down has been asked and is not waiting on anybody. */
  const unasked = stagesYetToDecide(chain, [...approvedBy, ...refusedBy]);
  const beingDecided = request.status === 'SUBMITTED';
  const agreed = request.status === 'APPROVED';
  const unroutable = request.status === 'UNROUTABLE';

  return {
    agreed,
    unroutable,
    chain,
    skipped: stagesSkipped(input.chain, skipped),
    approvedBy: signed,
    refusedBy: turnedDown,
    stillToApprove: beingDecided ? unasked : [],
    awaiting: request.awaitingApprovalFrom,
    stagesMissing: missing,
    inWords: progressInWords(request, signed, turnedDown, unasked, agreed, unroutable),
  };
}

/** The sentence, and it says what has happened before it says what has not. NFR USA 03, FR 44. */
function progressInWords(
  request: LeaveRequest,
  approved: readonly ApproverRole[],
  refused: readonly ApproverRole[],
  unasked: readonly ApproverRole[],
  agreed: boolean,
  unroutable: boolean,
): string {
  const said = [
    approved.length === 0 ? null : `Approved by ${chainInWords(approved)}.`,
    /* FR 44. A stage that said no is on the record whether or not it was the last word,
       because a request carrying a rejection and still going to HR is precisely the state
       somebody would otherwise read as agreed. */
    refused.length === 0 ? null : `Turned down by ${chainInWords(refused)}.`,
  ]
    .filter((sentence): sentence is string => sentence !== null)
    .join(' ');

  const soFar = said === '' ? 'Nobody has decided it yet.' : said;

  if (agreed) {
    return `This leave is agreed and is yours to take. ${soFar}`;
  }

  /** FR 48b, LMS 320. */
  if (unroutable) {
    return (
      `This leave is not agreed, and it is waiting on nobody: there is no approver left ` +
      `who could decide it, so it has stopped rather than been turned down. ${soFar} HR ` +
      `has been told, and the days are still held. Do not book anything on it.`
    );
  }

  if (isSettled(request.status)) {
    return (
      `This leave was ${inWordsSettled(request.status)} and is not yours to take. ${soFar} ` +
      `The days are back in your balance.`
    );
  }

  return (
    `This leave is not agreed yet, so do not book anything on it. ${soFar} It still ` +
    `needs ${chainInWords(unasked)}.`
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
  /** `SUBMITTED`, or `UNROUTABLE` where nobody can be asked at all. FR 48b, LMS 320. */
  status: RequestStatus;
  /**
   * FR 38a, FR 48b. The desk this starts at, or null where there is none. LMS 314, LMS 320.
   *
   * Not a field the caller supplies: {@link validateNewLeaveRequest} reads it off the
   * routing, because a caller who could name the desk could name the last one and have a
   * fortnight approved by whoever answered first.
   */
  awaitingApprovalFrom: ApproverRole | null;
  /** FR 48b. The stages skipped on the way to that desk, to be recorded. LMS 320. */
  skips: readonly SkippedStage[];
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
    /** FR 48b, LMS 320. */
    case 'UNROUTABLE':
      return 'left with no approver who could decide it';
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
 * become possible in — see ../features/leave-request/leave-request.service.ts. What is left is the
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
  /** FR 48b. Who can be asked at each desk, for this requester. LMS 320. */
  available: DesksAvailable;
}): ValidatedLeaveRequest {
  const routed = theFirstDesk(input.approvalChain, input.available);

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
    status: routed.kind === 'DESK' ? 'SUBMITTED' : 'UNROUTABLE',
    /* FR 38a, FR 48b, and the same argument one line up. A caller that could name the desk
       could name the last one, and a fortnight would be one signature from approved. */
    awaitingApprovalFrom: routed.kind === 'DESK' ? routed.desk : null,
    /** FR 48b. */
    skips: routed.skips,
  };
}

/**
 * The desk a new request starts at. FR 38, FR 38a, FR 48b. LMS 314, LMS 320.
 *
 * Read off the chain and nowhere else, which is the whole criterion: annual leave starts
 * with the line manager because its chain starts with `MANAGER`, and unpaid leave starts
 * with HR because its chain starts with `HR` — not because anything here knows which type
 * is which. Design principle 5.
 *
 * A chain with nobody in it is refused rather than defaulted, and `assertSomebodyApprovesIt`
 * has already said so in a sentence naming the type. A chain nobody can *staff* is a
 * different thing and is not refused: the leave is real, the days are held, and FR 48b
 * answers it with `UNROUTABLE` and an alert rather than by sending the person away.
 */
function theFirstDesk(chain: readonly ApproverRole[], available: DesksAvailable): Routed {
  if (chain.length === 0) {
    throw new InvalidLeaveRequest(
      'approvalChain',
      'This kind of leave has nobody set up to approve it, so a request for it would sit ' +
        'in no queue at all. Ask an HR Administrator to say who approves it.',
    );
  }

  const routed = routeFrom({ chain, decided: [], skipped: [], available });

  if (routed.kind === 'DECIDED') {
    /* Unreachable: a non-empty chain whose first stage can be answered returns `DESK`, and
       one that cannot returns `UNROUTABLE`. Answered rather than asserted, because the
       alternative is a request created already approved. */
    throw new InvalidLeaveRequest(
      'approvalChain',
      'This request would be agreed by nobody having to decide it, which is not something ' +
        'a submission can produce. FR 48b.',
    );
  }

  return routed;
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
