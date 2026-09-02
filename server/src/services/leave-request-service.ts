/**
 * Asking for leave, being told what it costs first, and taking it back. FR 10, FR 11, FR 14, FR 26, §8., LMS 301, LMS 305, LMS 306, FR 16, FR 05, FR 15, LMS 303, §8.2, LMS 314, FR 38a, LMS 212, FR 39, FR 52, LMS 315, FR 48, §8.6, LMS 319, FR 59, §7.1., LMS 329, FR 17, FR 13.
 */

import type { Actor } from '../auth/actor.js';
import { leaveRequestPolicy } from '../auth/leave-request-policy.js';
import { type ApproverRole, isApprovedBy } from '../domain/approval-chain.js';
import type { BalanceOwner } from '../auth/ledger-policy.js';
import type { Decision, Guard } from '../auth/policy.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import type { DayCount, LeavePeriod } from '../domain/leave-calculator.js';
import { validateLeavePeriod } from '../domain/leave-calculator.js';
import {
  desksThatApproved,
  type LeaveDecision,
  readComment,
  requireAComment,
} from '../domain/leave-decision.js';
import {
  approvalTo,
  type ApprovalProgress,
  assertItCostsSomething,
  assertTheDaysAreThere,
  InvalidLeaveRequest,
  isSettled,
  LeaveCrossesAYearEnd,
  type LeaveRequest,
  type LeaveRequestQuote,
  LeaveRequestNotFound,
  LeaveOverlapsAnother,
  type NewLeaveRequest,
  noticeGiven,
  progressOf,
  quoteFor,
  reachesPastTheEndOf,
  reasonForApproval,
  reasonForRelease,
  reasonForReservation,
  type ReleasingAction,
  settlementTo,
  validateLeaveRequestChanges,
  validateNewLeaveRequest,
} from '../domain/leave-request.js';
import { approvalNews, endingNews } from '../domain/notification.js';
import {
  assertEligible,
  assertSomebodyApprovesIt,
  assertStillOffered,
  type LeaveType,
  LeaveTypeNotFound,
} from '../domain/leave-type.js';
import { type LeaveYear, LeaveYearNotFound } from '../domain/leave-year.js';
import { type CalendarDate, calendarDateIn, dayAfter } from '../domain/time.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveDecisionRepository } from '../repositories/leave-decision-repository.js';
import type {
  LeaveRequestListOptions,
  LeaveRequestRepository,
} from '../repositories/leave-request-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type {
  BalanceService,
  LeaveApproved,
  LeaveReleased,
  LeaveRequested,
} from './balance-service.js';
import type { LeaveCalculatorService } from './leave-calculator-service.js';
import type { NotificationService } from './notification-service.js';

/** Leave asked for in a year that has been settled. §8.9.. */
export class LeaveYearIsClosed extends Error {
  readonly leaveYearId: string;

  constructor(year: LeaveYear) {
    super(
      `Leave year ${year.label} has been settled, so its balances are final and no ` +
        `further leave can be booked against it. Leave taken in a closed year is put on ` +
        `the record by HR as an adjustment with a reason. §8.9.`,
    );
    this.name = 'LeaveYearIsClosed';
    this.leaveYearId = year.id;
  }
}

export class LeaveRequestService {
  constructor(
    /**
     * The one door that writes a movement. LMS 212.
     *
     * A service rather than a repository, for the reason `LeaveEventService` gives: the
     * request row and its RESERVATION are written in one transaction, and the seam that
     * owns transactions is reachable from there and not from here.
     */
    private readonly balances: BalanceService,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    /** Which year the period falls in, and whether it has been settled. */
    private readonly years: LeaveYearRepository,
    /** For the reads; the writes go through {@link BalanceService}. */
    private readonly requests: LeaveRequestRepository,
    /**
     * What each desk said, for the reads. FR 39, FR 52. LMS 315.
     *
     * The same division `requests` above is held to, and for a stronger reason: a decision
     * has to land in the same transaction as the status it explains — the two are one act —
     * so the writing is `BalanceService`'s through the seam that owns transactions, and what
     * this service holds is the reading. A `record()` called from here would be a decision
     * that could commit while the move it describes rolled back.
     */
    private readonly decisions: LeaveDecisionRepository,
    /**
     * What the period costs. The one place this question is asked.
     *
     * A service rather than the domain function, because counting needs the working
     * pattern and the holiday calendar and those are reads with policies in front of
     * them — see ../services/leave-calculator-service.ts, which is where the two are
     * fetched for the period rather than for whatever somebody had in hand.
     */
    private readonly calculator: LeaveCalculatorService,
    /**
     * Who tells the employee what just happened. FR 59, §7.1. LMS 329.
     *
     * Required rather than defaulted, for the reason the guard is: a service that can be
     * built without one is a service somebody builds without one, and the failure is
     * silent. Everything works, every request is decided correctly, and nobody is told —
     * which is precisely the state this story exists to end.
     *
     * It is held by *this* service rather than by `BalanceService` because of where it must
     * be called from. The door owns the transaction; FR 59 says the notice goes out after
     * that transaction commits, never inside it. A `NotificationService` on the door would
     * be one `await` away from being called inside `allOrNothing`, at which point an SMTP
     * handshake sits inside `holdStill` and a rolled-back approval has already emailed
     * somebody to say their leave is agreed. Here there is no transaction to be inside.
     */
    private readonly notifications: NotificationService,
  ) {}

  /**
   * What this leave would cost, before anything is written. The story's second
   * criterion.
   *
   * Writes nothing, reserves nothing, and is safe to call on every keystroke that
   * changes a date. What it returns is {@link LeaveRequestQuote}: the day count, the
   * basis it was reached by *in words*, the days inside the period that were free and
   * why, what the balance holds now and what it would hold afterwards, who would decide
   * it, and anything worth knowing that is not a refusal.
   *
   * The refusals it can raise are the ones that mean there is nothing to quote — a
   * period that is not a period, a type nobody may request, a year nobody has defined —
   * and they come from the domain unchanged, because a service that reworded them would
   * be a second copy of the message NFR USA 03 asks for.
   *
   * **It is not a promise.** A quote taken on Monday and submitted on Friday is counted
   * again on Friday, and if a public holiday was gazetted inside the period in between,
   * the second answer is the one that is charged. That is the honest behaviour and the
   * reason the count is never passed in.
   */
  async quote(actor: Actor, input: NewLeaveRequest): Promise<LeaveRequestQuote> {
    const { employee, type, year, period } = await this.resolve(actor, input);

    const count = await this.countFor(actor, employee, type, period);

    return quoteFor({
      type,
      period,
      count,
      availableNow: await this.availableFor(actor, employee, type, year),
      daysOfNotice: noticeGiven(this.today(), period.from),
    });
  }

  /**
   * Records the request and holds the days. FR 10, FR 26.
   *
   * Everything {@link LeaveRequestService.quote} asked, asked again, and then one write
   * through the one door. The two rows — the request and its RESERVATION — land
   * together or neither does.
   *
   * Returns the request, the movement and the balance it left, because the caller is a
   * screen that has just submitted something and has to say what happened: how many
   * days it cost, and what is left.
   *
   * Throws {@link InvalidLeavePeriod} for two dates that are not a period,
   * {@link LeaveCountsNoDays} where nothing in it counts, {@link LeaveTypeRetired} and
   * {@link NotEligibleForTheType} for a type that may not be asked for,
   * {@link LeaveCrossesAYearEnd} for a period spanning a year end,
   * {@link LeaveOverlapsAnother} for leave over leave already booked,
   * {@link LeaveYearIsClosed} for a settled year, and {@link NotEnoughDays} where the
   * balance does not hold what is being asked for — or {@link BalanceOverdrawn} from the
   * door instead, in the one case this method's check cannot cover: a balance spent
   * between the read here and the lock there. Same refusal, and the difference is only
   * which of them got to say it.
   */
  async submit(actor: Actor, input: NewLeaveRequest): Promise<LeaveRequested> {
    const { employee, type, year, period } = await this.resolve(actor, input);

    this.guard.enforce(leaveRequestPolicy.submit(actor, ownerOf(employee)));

    /* FR 38a. A type nobody is configured to approve produces a request that would sit
       in no queue, and the person would find out by waiting. Asked here rather than
       when the type was created because a chain can be emptied afterwards. */
    assertSomebodyApprovesIt(type);

    if (year.isClosed) {
      throw new LeaveYearIsClosed(year);
    }

    /* Counted again, inside no transaction yet but from the same facts, and it is this
       answer that is stored. See the module note for why it is not the caller's. */
    const count = await this.countFor(actor, employee, type, period);

    /* FR 14, LMS 305. The days, checked while the form is still open and against the
       same figure the quote showed. `daysToReserve` checks it again inside the lock and
       that is the answer that binds; this is the one that can name the leave type, the
       figure and what to ask for instead. */
    assertTheDaysAreThere(
      type,
      period,
      count,
      await this.availableFor(actor, employee, type, year),
    );

    const request = validateNewLeaveRequest({
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: year.id,
      from: period.from,
      to: period.to,
      reason: input.reason,
      /* The story's third criterion, taken here and never read off the type again. */
      countingBasis: type.countingBasis,
      days: count.days,
      calendarDays: count.calendarDays,
      /* FR 38a, LMS 314's first criterion. The chain is handed over and the *first* stage
         of it is written onto the row; `assertSomebodyApprovesIt` above has already refused
         an empty one with the type named. Annual leave starts with the line manager and
         unpaid leave starts with HR because that is what their chains say, and nothing on
         this path knows which type is which. */
      approvalChain: type.approvalChain,
    });

    const submitted = await this.balances.reserveForRequest(actor, {
      request,
      reason: reasonForReservation(type.name, period, count.days),
    });

    /* FR 59, LMS 329. The first of the three call sites, and all three have the same shape:
       the door has returned, so the transaction has committed, and every fact the message is
       composed from is read off what came back rather than off what was sent in. See
       ./notification-service.ts for why it can neither throw nor be moved inside. */
    await this.notifications.tell({
      event: 'SUBMITTED',
      employee,
      request: submitted.request,
      typeName: type.name,
      /* Nobody has decided anything yet. The desk it is *waiting* on is on the request. */
      decidedBy: null,
      comment: null,
      availableAfter: submitted.balance.available,
    });

    return submitted;
  }

  /**
   * Takes back leave that was asked for, and gives the days back. FR 26, FR 46. LMS 306,
   * LMS 323.
   *
   * The requester's own act, or HR's on their behalf. What it writes is a `RELEASE` and
   * a status, in one transaction — see {@link BalanceService.releaseForRequest} — and
   * what a caller gets back is the settled request, the movement and the balance it left,
   * because a screen that has just withdrawn something has to say what came back.
   *
   * ## It is FR 46's cancellation, and it works at every stage of a chain
   *
   * LMS 323, and the story's word for this is *cancel*: an employee taking back a request
   * they have not had approved, so that plans that change cost them no days and cost an
   * approver no time. This method is that act. `LeaveRequestService.cancel` deliberately is
   * not — that is HR unwinding a row which should not be on the books, and the two are
   * different acts by different people that the ledger records differently.
   *
   * **Nothing about it asks where the request has got to**, and that is the property the
   * story turns on rather than an omission. `TRANSITIONS` keys a `WITHDRAW` by the
   * from-status alone, and `SUBMITTED` is the whole of "not yet approved" — however long the
   * type's chain is and however many of its desks have already agreed. So a request two
   * approvers have signed is taken back by the person who asked, in full, without anybody
   * being asked to release it: an intermediate approval writes no movement, so the whole hold
   * is still there.
   *
   * That was untestable when LMS 306 wrote it, because a request could only ever be standing
   * at its first desk. `../../tests/unit/state-machine.test.ts` now pins it against the table
   * and `../../tests/integration/leave-request.test.ts` walks it at every desk there is.
   *
   * **What an approver already said is not unsaid.** `leave_request_decision` is append only,
   * so a request taken back after the manager agreed reads afterwards as exactly that. And
   * the desk goes to null with the status, which `leave_request_waits_at_a_desk` makes an
   * equivalence — so leave that has been taken back cannot be left sitting in a queue.
   *
   * **Where it stops.** Leave that has been *approved* is not this: the days are `taken` by
   * then rather than `pending`, so giving them back is a movement against the `DEDUCTION` and
   * needs HR. {@link LeaveCannotBeMoved} is what somebody reaching for this is told, and
   * asking for agreed leave to be taken off the books is FR 47's story. Being *told* that a
   * request went away — the approver who had it in their queue — is FR 59's, which owns
   * notification for every event in a request's life; what this guarantees is that there is
   * something true to tell them.
   */
  async withdraw(actor: Actor, id: string): Promise<LeaveReleased> {
    return this.settle(actor, id, 'WITHDRAW', null, (owner) =>
      leaveRequestPolicy.withdraw(actor, owner),
    );
  }

  /**
   * Turns down leave somebody asked for, and gives the days back. FR 26. LMS 306.
   *
   * The line manager's, or HR's. See {@link leaveRequestPolicy.refuse} for why this is
   * not yet FR 38a's chain and why the approval story narrows it rather than replacing
   * it.
   *
   * **The days come back at the moment of the refusal**, which is the half of the story
   * that matters to the person who asked: leave they were turned down for is not leave
   * that goes on being deducted from what they may book while somebody gets round to
   * tidying it up.
   *
   * ## And it says why. FR 39, FR 52. LMS 315
   *
   * The one ending that takes a comment, and the only method here that requires one. A
   * refusal is a decision made about somebody by somebody else, and the person it is made
   * about is owed the reason in the record rather than in a corridor: {@link LeaveDecision}
   * is where it lands, with the desk it was decided at and the name of whoever decided it,
   * in the same transaction as the status and the `RELEASE`.
   *
   * **Refused before anything at all is read**, which is a deliberate choice about the
   * order rather than an optimisation. `settle` below asks *may you*, then *is this move
   * available*, and both of those answers describe a request; asking for the reason first
   * means an approver who forgot the box is told so without a single row being fetched, and
   * without the refusal depending on whether the id was anybody's. {@link requireAComment}
   * asks it again inside the transaction that writes, and
   * `leave_request_refusal_says_why` asks it a third time where no service can reach.
   *
   * ## And never by the person who asked for it. FR 48, §8.6a. LMS 319
   *
   * The other decision method, and the one that needed this story. Approving your own leave
   * has been refused since LMS 314 — the desk excluded the requester — but refusing it was
   * not: the `REFUSE` row admits `LEAVE_ADMINISTRATION`, so an HR Officer or Administrator
   * asking for their own leave could turn it down, recorded as a decision at a desk under
   * their own name. {@link leaveRequestPolicy.refuse} now asks {@link
   * leaveRequestPolicy.notTheirOwn} before it consults a standing at all, and
   * `BalanceService.releaseForRequest` asks it again inside the lock.
   *
   * **Withdrawing is what that person wanted**, and it is untouched. The refusal names it —
   * see `DECIDING_IS_SOMEBODY_ELSE` — because somebody who no longer wants their own leave
   * has an act of their own to reach for, and being told only "no" would leave them looking
   * for a colleague to do something they never needed done.
   *
   * Throws {@link RefusalNeedsAComment} for a refusal with nothing said, before
   * {@link LeaveRequestNotFound} and before {@link NotAuthorised}.
   */
  async refuse(actor: Actor, id: string, comment: string): Promise<LeaveReleased> {
    return this.settle(actor, id, 'REFUSE', requireAComment(comment), (owner) =>
      leaveRequestPolicy.refuse(actor, owner),
    );
  }

  /**
   * Unwinds a request that should not be on the books, and gives the days back. FR 26.
   *
   * HR's alone — leave booked against the wrong person, a request entered twice, days
   * that belong in another year. See {@link leaveRequestPolicy.cancel}.
   */
  async cancel(actor: Actor, id: string): Promise<LeaveReleased> {
    return this.settle(actor, id, 'CANCEL', null, (owner) =>
      leaveRequestPolicy.cancel(actor, owner),
    );
  }

  /**
   * Says yes at the desk this request is waiting on, and sends it to the next one or agrees
   * it. FR 38, FR 38a, FR 40. LMS 314.
   *
   * The whole of the story from the outside: one method, one verb, and which of the two
   * things it does is decided by the chain rather than by the caller. A manager approving
   * annual leave moves it on to HR; the HR officer approving it afterwards approves the
   * leave and the days become taken. Neither of them says which they are doing.
   *
   * What comes back is the request, the balance and — only where this was the last word —
   * the `DEDUCTION`. A caller telling the two apart reads `awaitingApprovalFrom`, which is
   * null exactly when there is nobody left to ask.
   *
   * ## Four questions, and the order is a disclosure rule
   *
   * The settlement path asks *may you* and then *is this move available*, and
   * `standingsFor` argues at length that reversing them would read a stranger's request
   * state aloud. Approval asks four, and the order of the last three is different for a
   * reason worth being exact about: **the standing question here is itself a question about
   * the state.** Who may approve depends on which desk the request is sitting on, so a
   * decision made before the state is known is no decision at all.
   *
   *   **Is this your own request?** FR 48, §8.6a, LMS 319.
   *   {@link leaveRequestPolicy.notTheirOwn}, asked before anything but the employee record
   *   that says whose leave this is — because nothing read after it could change the answer.
   *   It is not part of the ordering argument below at all: the other three are questions
   *   about a chain and a state, and this one is a comparison of two ids that is the same
   *   whatever either of them says. Asked again by {@link leaveRequestPolicy.approve} below,
   *   and a third time at the door inside the lock.
   *
   *   **May you see this at all?** {@link leaveRequestPolicy.read}, which is the disclosure
   *   gate the settlement path gets for free from its own narrowness. A colleague probing
   *   ids is refused here, silently, and learns nothing — which is the property the order
   *   below would otherwise cost. It is asked only of somebody who is *not* the desk,
   *   because being the desk is its own reason to be looking: FR 32h routes unpaid leave to
   *   the Chief Executive, who is nobody's line manager and holds no role, so a read asked
   *   of everybody would refuse the one approver §4.3.1 names.
   *
   *   **Is there an approval to give?** {@link approvalTo}, which answers a request that has
   *   ended with {@link LeaveAlreadySettled}, one already approved with
   *   {@link LeaveCannotBeMoved}, and one standing on a desk its chain has dropped with
   *   {@link ApprovalChainChanged}. Asked before the standing check so that the person who
   *   clicks approve on leave somebody withdrew a minute ago is told *that*, rather than
   *   being told they are not the approver of a request that is waiting on nobody — which is
   *   true, and useless.
   *
   *   **Are you the desk it is with?** {@link leaveRequestPolicy.approve}, and then again
   *   inside the lock, where it is the answer that binds.
   *
   * ## What it reads
   *
   *   **The leave type, for its chain.** FR 38a's chain is a property of the type and this
   *   is the one place it is read for a request. It is read *now* rather than taken off the
   *   request, because the request does not carry it — see {@link ApprovalChainChanged} for
   *   the seam that leaves and why it is refused by name rather than guessed at.
   *
   *   **The Chief Executive, and only where the chain names them.** FR 04 makes it the one
   *   employee with no line manager, and there is no role that says so — so the desk
   *   resolves to an id and the id comes from `EmployeeRepository.findRoot`. Asked only for
   *   a chain with a `CEO` stage in it, because it is a query every other approval in the
   *   company would otherwise pay for to answer a question about the two unpaid types.
   *
   * Throws {@link LeaveRequestNotFound} for an id that is nobody's, {@link NotAuthorised}
   * for somebody who may not see the request or is not the desk it is waiting on,
   * {@link LeaveAlreadySettled} for leave that has ended, {@link LeaveCannotBeMoved} for
   * leave that has already been approved, and {@link ApprovalChainChanged} where the chain
   * has moved out from under it.
   */
  async approve(actor: Actor, id: string, comment?: string): Promise<LeaveApproved> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);
    const owner = ownerOf(employee);

    /* FR 48, §8.6a. LMS 319. First, and before the chain, the type or the Chief Executive is
       read, because none of them can change the answer: whatever this request's approvers
       are and wherever it has got to, the person who asked for it is not one of them. It is
       the first question of the two paths below rather than a fourth, and it is asked as
       soon as whose leave this is has been established — which is the earliest anything can
       be asked at all, since an id says nothing about whose it is. */
    this.guard.enforce(leaveRequestPolicy.notTheirOwn(actor, owner, 'APPROVE'));

    const type = await this.typeFor(request.leaveTypeId);
    const chiefExecutiveId = await this.chiefExecutiveFor(type.approvalChain);

    const standing = leaveRequestPolicy.approve(actor, {
      ...owner,
      awaiting: request.awaitingApprovalFrom,
      chiefExecutiveId,
    });

    /* Somebody who is not the desk has to have some other reason to be looking at this
       request before it is described to them, and being the desk is itself a reason — which
       is why the read is asked only of everybody else. The Chief Executive is why it has to
       be that way round rather than a read for all comers: FR 32h routes unpaid leave to
       them, and they are nobody's line manager and hold no role, so `read` refuses the one
       approver §4.3.1 names. A colleague with no standing at all meets that refusal, which
       is silent — see ../auth/policy.ts. */
    if (!standing.allowed) {
      this.guard.enforce(leaveRequestPolicy.read(actor, owner));
    }

    /* Where this leaves it, and the refusals for a request that has nowhere to go. Asked
       before the standing is enforced, so that somebody clicking approve on leave that was
       withdrawn a minute ago is told *that* rather than told they are not the approver of a
       request waiting on nobody — which is true and useless. It is safe in that order
       because everybody who reaches this line may already read the request.

       The outcome is also what lets the `DEDUCTION`'s sentence name the desk that decided
       it. It is worked out again inside the lock, and that is the answer that binds.

       FR 41, LMS 316. The desks that have already signed are read here for the same reason
       the chain is: the walk asks which stage has *not* approved rather than which comes
       after this one, so it needs the decisions and not only the cursor. Read again inside
       the lock, where the answer binds — see `approveForRequest`. */
    const outcome = approvalTo(
      request,
      type.approvalChain,
      desksThatApproved(await this.decisions.forRequest(request.id)),
    );

    this.guard.enforce(standing);

    const approved = await this.balances.approveForRequest(actor, {
      request,
      chain: type.approvalChain,
      chiefExecutiveId,
      /* FR 39, LMS 315. Optional, and normalised here rather than at the door so that an
         approver who typed two spaces and one who typed nothing produce the same row.
         The desk it is filed under is not this method's — see `approveForRequest`. */
      comment: readComment(comment),
      reason: reasonForApproval(type.name, request, request.days, outcome.by),
    });

    /* FR 59, LMS 329. Which of the two pieces of news this was is {@link approvalNews},
       read off the committed row rather than off `outcome` above — the walk was made twice
       and only the one inside the lock decided anything, so a chain that gained a stage
       while somebody was reading a screen produces "your manager approved it, HR still has
       to" rather than "your leave is agreed". The desk and the comment are the decision's
       own, for the same reason. */
    await this.notifications.tell({
      event: approvalNews(approved.request),
      employee,
      request: approved.request,
      typeName: type.name,
      decidedBy: approved.decision.onBehalfOf,
      comment: approved.decision.comment,
      availableAfter: approved.balance.available,
    });

    return approved;
  }

  /**
   * What each desk said about this request, in the order they said it. FR 39, FR 52. LMS
   * 315.
   *
   * The reading half of the story, and the reason the writing half is worth anything: a
   * refusal recorded and never shown is the corridor conversation with a database behind it.
   * What comes back is one row per decision — the verb, the comment, the desk it was decided
   * at, who decided it and when — oldest first, so a request that went to a manager and then
   * to HR reads as the account of how it got where it is.
   *
   * **Decided by `leaveRequestPolicy.read`**, which is exactly the rule that decides who may
   * see the request itself, and deliberately not a narrower one. A decision is the
   * explanation of a status, and standing to see the status without the reason for it would
   * be standing to see half an answer — the same sentence this file's policy makes about a
   * request and the balance it moves. So the requester sees why they were turned down, their
   * line manager sees it, and a role that reads every record sees it; a colleague sees
   * neither the request nor this.
   *
   * Throws {@link LeaveRequestNotFound} for an id that is nobody's, and {@link NotAuthorised}
   * — silently, as `read` refuses — for somebody with no standing to see the request.
   */
  /**
   * Whether this leave is agreed, and who is still to agree it. FR 41, FR 42. LMS 316.
   *
   * The story's "so that", answered in one call: *I never take leave believing it was agreed
   * when it was not*. Every fact needed to be wrong about that is already readable — the
   * status, the desk it is with, the decisions, the chain — and it is readable in four
   * places, which is exactly the arrangement in which a screen shows the newest approval and
   * a person reads it as the answer. {@link ApprovalProgress.agreed} is the answer.
   *
   * **The chain is read now**, as it is everywhere else in this file, so the stages still to
   * approve are the ones the policy asks for today rather than the ones it asked for when
   * the request was made. That is the same reading `approve` makes and it is what keeps the
   * two from ever describing a request differently.
   *
   * Decided by {@link leaveRequestPolicy.read}, the same rule that decides who may see the
   * request itself and who may read its decisions — refused silently, because somebody
   * asking after leave that is not theirs has not been shown that it exists.
   */
  async progressFor(actor: Actor, id: string): Promise<ApprovalProgress> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    const type = await this.typeFor(request.leaveTypeId);

    return progressOf({
      request,
      chain: type.approvalChain,
      approvedBy: desksThatApproved(await this.decisions.forRequest(request.id)),
    });
  }

  async decisionsFor(actor: Actor, id: string): Promise<LeaveDecision[]> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    return this.decisions.forRequest(request.id);
  }

  /**
   * FR 04. The one employee with no line manager, where this chain asks for one.
   *
   * Only for a chain with a `CEO` stage, and the narrowness is the point rather than an
   * optimisation for its own sake: two of the seven leave types route to the Chief
   * Executive — unpaid leave and the unpaid maternity extension, §4.3.1 — so every other
   * approval in the company would be paying for a query about a stage it does not have.
   *
   * Keyed on the *chain* rather than on the desk the request is standing at, because the
   * answer is carried into the lock and the desk may have moved by the time it is used
   * there. A chain that ends at the Chief Executive needs the id whichever stage the
   * request is on today.
   *
   * Undefined comes back as null rather than as an error, and both policies treat a null as
   * nobody: an organisation with no root is one `employee_one_root` says cannot exist, and
   * the honest behaviour if it somehow does is to refuse the approval rather than to admit
   * whoever asked.
   */
  private async chiefExecutiveFor(chain: readonly ApproverRole[]): Promise<string | null> {
    if (!isApprovedBy(chain, 'CEO')) {
      return null;
    }

    return (await this.employees.findRoot())?.id ?? null;
  }

  /**
   * The one path a request ends by. FR 26, §8.2. LMS 306.
   *
   * The README's rule is that only the state machine moves a request, and this is it:
   * three public verbs, one transition. What each of them supplies is the decision — the
   * three differ in *who* may do it and in nothing else — so the guard is a parameter
   * and everything after it is written once.
   *
   * That shape is the point rather than a tidiness. A `withdraw` that assembled its own
   * release reason, read its own leave type and called the door itself would be a second
   * implementation of ending a request, and the day one of the three forgot
   * {@link assertMayBeSettled} it would be the one that released days twice.
   *
   * ## The order, and what each step is for
   *
   *   **The request, then the employee, then the decision.** The policy needs to know
   *   whose leave it is and who their line manager is, and neither is knowable from an
   *   id. {@link LeaveRequestNotFound} comes before the guard because there is no
   *   standing to have towards a request that does not exist.
   *
   *   **Then whether it may be ended at all.** {@link assertMayBeSettled}, which is the
   *   sentence a person reads when they press twice. It is asked again inside the lock,
   *   where it is the answer that binds — see {@link BalanceService.releaseForRequest}
   *   for why the lock closes that window completely here, unlike at submission.
   *
   *   **Then the leave type, and only for its name.** The `RELEASE` says "6 days of
   *   Annual Leave given back", and a row carries a `leaveTypeId` that nobody reading a
   *   balance would recognise. The same read the overlap refusal makes, for the same
   *   reason.
   *
   * Throws {@link LeaveRequestNotFound} for an id that is nobody's, {@link NotAuthorised}
   * for a desk that may not, and {@link LeaveAlreadySettled} for leave that has already
   * ended.
   */
  private async settle(
    actor: Actor,
    id: string,
    action: ReleasingAction,
    /**
     * FR 39. The reason, for the one of the three that is a decision. LMS 315.
     *
     * A string for a refusal and null for the other two, checked by whichever verb built
     * it — {@link LeaveRequestService.refuse} is the only one that can produce a string, and
     * it does so with {@link requireAComment} before this method is entered.
     *
     * It stays a plain parameter here and becomes a discriminated union at the door, where
     * `SettlingAct` makes the pairing something the compiler holds rather than something
     * this method promises.
     */
    comment: string | null,
    decide: (owner: BalanceOwner) => Decision,
  ): Promise<LeaveReleased> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(decide(ownerOf(employee)));

    /* Where this leaves it, read off `TRANSITIONS` rather than named here. The policy
       above has already refused a move the table does not hold; this is the same lookup
       asked for its answer rather than for its verdict, and it is asked a third time
       inside the lock where it binds. */
    const to = settlementTo(request, action);

    const type = await this.types.findById(request.leaveTypeId);

    /* Unreachable: `leave_request.leave_type_id` is NOT NULL with a foreign key behind it,
       and nothing deletes a leave type — retiring one clears `is_active`. Answered rather
       than asserted, for the reason the overlap refusal answers it: a ledger entry reading
       "6 days of undefined given back" is worse than one that says less, and since LMS 329
       the same string is the one an email says it to somebody about. */
    const typeName = type?.name ?? 'leave';

    const reason = reasonForRelease(typeName, request, request.days, to);

    /* The one branch on the way to the one path, and it is a narrowing rather than a
       decision: `SettlingAct` pairs the verb with what has to be said about it, so a
       refusal is handed over with its reason and the other two with an explicit null.
       Writing it as a spread of `{ action, comment }` would compile and would let a
       withdrawal carry a comment, which is the mistake the union exists to make
       unwritable. */
    const settled = await this.balances.releaseForRequest(
      actor,
      action === 'REFUSE'
        ? { request, action, to, reason, comment: requireAComment(comment) }
        : { request, action, to, reason, comment: null },
    );

    /* FR 59, LMS 329. All three endings tell the person, and they tell them three different
       things — five days coming back look identical in a balance whether somebody changed
       their mind, a manager turned it down or HR unwound a row, which is the argument
       `reasonForRelease` already makes about the ledger's sentence.

       The status is taken off the committed row rather than from `to` above, the same
       discipline the door itself keeps: `to` was worked out before the lock, and while the
       door would have refused an ending that disagreed with it, the row is what happened.
       The narrowing cannot fail — a request that came back from the release door has
       settled — and `to` is the answer if it somehow did. */
    await this.notifications.tell({
      event: endingNews(isSettled(settled.request.status) ? settled.request.status : to),
      employee,
      request: settled.request,
      typeName,
      /* FR 52. Only a refusal was decided at a desk; the other two carry null, which is the
         same asymmetry `LeaveReleased.decision` has and for the same reason. */
      decidedBy: settled.decision?.onBehalfOf ?? null,
      comment: settled.decision?.comment ?? null,
      availableAfter: settled.balance.available,
    });

    return settled;
  }

  /** One request, if the actor may see whose it is. */
  async byId(actor: Actor, id: string): Promise<LeaveRequest> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    return request;
  }

  /**
   * The leave somebody has asked for, the earliest first.
   *
   * Decided by exactly the rule that decides who may read their balance — yours, your
   * line manager's, or a role that reads everybody — because a request is the reason a
   * figure is what it is, and standing to see one without the other would be standing
   * to see half an explanation.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: Omit<LeaveRequestListOptions, 'employeeId'> = {},
  ): Promise<LeaveRequest[]> {
    const employee = await this.employeeFor(employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    return this.requests.list({ ...options, employeeId: employee.id });
  }

  /**
   * Improves the reason on a request already submitted.
   *
   * The only field of substance that may change, and only by the person who wrote it —
   * see ../auth/leave-request-policy.ts. Everything the days were priced from is
   * refused by the database on every connection, so this method's narrowness is a
   * convenience rather than the protection.
   */
  async reword(actor: Actor, id: string, reason: string): Promise<LeaveRequest> {
    const existing = await this.requests.findById(id);

    if (existing === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(existing.employeeId);

    this.guard.enforce(leaveRequestPolicy.reword(actor, ownerOf(employee)));

    const changes = validateLeaveRequestChanges({ reason });
    const written = await this.requests.reword(actor, id, changes.reason);

    /* Unreachable: the row was read a statement ago and nothing deletes one. Answered
       rather than asserted, because the alternative is returning undefined from a
       method whose type says it does not. */
    if (written === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    return written;
  }

  /**
   * The four facts every method here needs, resolved and checked once.
   *
   * Shared by {@link LeaveRequestService.quote} and {@link LeaveRequestService.submit}
   * so that a quote cannot be produced for something a submission would refuse. A
   * person who is shown "7 days, and you would have 13 left" and is then told the type
   * is retired has been misled by a system that knew.
   *
   * The period is validated before the leave year is looked up, because the lookup is
   * bounded by the two dates: a `from` of `31/07/2026` reaching a `WHERE start_date <=`
   * is a driver error where it should have been a sentence beside the input.
   */
  private async resolve(
    actor: Actor,
    input: NewLeaveRequest,
  ): Promise<{ employee: Employee; type: LeaveType; year: LeaveYear; period: LeavePeriod }> {
    const employee = await this.employeeFor(input.employeeId);
    const type = await this.typeFor(input.leaveTypeId);

    /* Both before anything is counted. A fortnight of a type nobody may ask for is
       work done to produce a refusal, and the refusal is better said first. */
    assertStillOffered(type);
    assertEligible(type, employee.gender);

    const period = validateLeavePeriod({ from: input.from, to: input.to });

    /* Reading the balance and the calendar are both permissions of their own, asked by
       the services that do the reading. What this one asks is the request's own
       question, and only where a request is what is being made — a quote reads nothing
       a balance screen would not already show its owner. */
    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    const year = await this.yearCovering(period);

    await this.assertNothingIsAlreadyBooked(employee, period);

    return { employee, type, year, period };
  }

  /**
   * Refuses leave asked for over leave the person already has. FR 15, §5.6. LMS 304.
   *
   * Last in {@link LeaveRequestService.resolve}, because it is the only check there that
   * costs a query the happy path would not otherwise run, and because everything above
   * it refuses on the dates alone. A period the wrong way round should be told so
   * without a table being consulted about it.
   *
   * **Asked by `quote` as well as by `submit`.** A quote is where somebody finds out,
   * and the story is that the system stops them booking over leave they already have
   * rather than letting them price it first and refusing them afterwards.
   *
   * The conflicting request's leave type is read only to be named, and only on the way
   * to a refusal — a row carries a `leaveTypeId` and nobody has recognised their own
   * leave from one. It is very often a different type from the one being asked for,
   * which is what makes naming it worth a query nobody pays for unless they are being
   * refused.
   *
   * **This is not the guarantee.** Two submissions of the same fortnight racing each
   * other both reach this with a table that has no conflict in it, and both pass; what
   * refuses the second is `leave_request_never_overlaps` as the row is written. The
   * repository turns that into the same refusal. What this method buys is the sentence
   * naming the leave in the way, for everybody who is not in a race — which is
   * everybody.
   */
  private async assertNothingIsAlreadyBooked(
    employee: Employee,
    period: LeavePeriod,
  ): Promise<void> {
    const conflict = await this.requests.findOverlapping(employee.id, period);

    if (conflict === undefined) {
      return;
    }

    const type = await this.types.findById(conflict.leaveTypeId);

    throw new LeaveOverlapsAnother(period, {
      request: conflict,
      /* Unreachable: `leave_request.leave_type_id` is NOT NULL with a foreign key behind
         it, and nothing deletes a leave type — retiring one clears `is_active`. Answered
         rather than asserted, because a refusal that reads "5 days of undefined" is worse
         than one that says less. */
      typeName: type?.name ?? 'leave',
    });
  }

  /**
   * What this person has left of this type, this year. FR 14, FR 53.
   *
   * The one place either method asks, for the reason {@link LeaveRequestService.countFor}
   * is the one place either counts: the figure a person is shown in a quote and the
   * figure they are refused against have to be the same figure, read the same way. Two
   * call sites assembling the same three-part key is how they stop being.
   *
   * `BalanceService.forOne` rather than a repository, because reading somebody's balance
   * is a permission of its own — ../auth/ledger-policy.ts — and it is that service's to
   * enforce. A balance nothing has moved yet comes back as nought rather than as an
   * absence, so somebody asking for a type they have never used is refused with a figure
   * rather than met with an error about a missing row.
   *
   * **No lock, and this is not where affordability is decided.** §8.2. The figure is
   * true when it is read and may be spent a moment later by an approval landing in
   * another connection; `daysToReserve` inside `BalanceService.reserveForRequest` is the
   * check that cannot be beaten. See {@link NotEnoughDays}.
   */
  private async availableFor(
    actor: Actor,
    employee: Employee,
    type: LeaveType,
    year: LeaveYear,
  ): Promise<number> {
    const balance = await this.balances.forOne(actor, {
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: year.id,
    });

    return balance.available;
  }

  /**
   * What the period costs, refused where that is nothing. FR 16a.
   *
   * The one place either method counts, so the refusal cannot end up on the submission
   * and not on the quote — which would be the exact failure the story is written
   * against: a person shown a figure, told it is fine, and refused after they commit.
   *
   * The judgement is one line and it is deliberately not inlined at the two call sites.
   * {@link assertItCostsSomething} is the rule and lives in the domain; this is where it
   * meets the answer, and there is one such place.
   */
  private async countFor(
    actor: Actor,
    employee: Employee,
    type: LeaveType,
    period: LeavePeriod,
  ): Promise<DayCount> {
    const count = await this.calculator.count(actor, employee, type, period);

    assertItCostsSomething(type, period, count);

    return count;
  }

  /**
   * The leave year the whole period falls in. FR 16.
   *
   * Found from the first day and then checked at the last, which is the only order that
   * gives a useful refusal: a period straddling a year end has a real year at one end
   * and the message can name it, where "no leave year covers 28 December to 5 January"
   * would be true of nothing and helpful to nobody.
   *
   * The year being crossed *into* is looked up only once the crossing is established,
   * and that is the whole reason {@link reachesPastTheEndOf} is a predicate rather than
   * an assertion taking both years. A quote is safe to call on every keystroke that
   * changes a date, so a second query asked on the way to answering "no" every time
   * would be paid for by every request that is fine.
   *
   * It is looked up rather than derived because a leave year need not be a calendar year
   * — §5.4 — so only the row can say whether the year after 2026 is called '2027' or
   * '2027/28'. Undefined where nobody has defined it yet, which is legitimate: a gap
   * after the last leave year is next year's decision rather than a hole.
   *
   * `refuse_a_request_outside_its_leave_year()` holds the same rule for every other
   * writer, so the two cannot drift.
   */
  private async yearCovering(period: LeavePeriod): Promise<LeaveYear> {
    const year = await this.years.findCovering(period.from);

    if (year === undefined) {
      throw new LeaveYearNotFound(
        `covering ${period.from}. Define the leave year that day falls in first`,
      );
    }

    if (reachesPastTheEndOf(year, period)) {
      throw new LeaveCrossesAYearEnd(
        period,
        year,
        await this.years.findCovering(dayAfter(year.endDate)),
      );
    }

    return year;
  }

  private async employeeFor(employeeId: unknown): Promise<Employee> {
    if (typeof employeeId !== 'string' || employeeId.trim() === '') {
      throw new InvalidLeaveRequest('employeeId', 'A leave request has to name whose leave it is.');
    }

    const employee = await this.employees.findById(employeeId.trim());

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId.trim());
    }

    return employee;
  }

  private async typeFor(leaveTypeId: unknown): Promise<LeaveType> {
    if (typeof leaveTypeId !== 'string' || leaveTypeId.trim() === '') {
      throw new InvalidLeaveRequest(
        'leaveTypeId',
        'A leave request has to name the kind of leave being asked for.',
      );
    }

    const type = await this.types.findById(leaveTypeId.trim());

    if (type === undefined) {
      throw new LeaveTypeNotFound(leaveTypeId.trim());
    }

    return type;
  }

  /**
   * Today, in UTC, which is the day the database's `current_date` is having.
   *
   * The same clock `LeaveYearService`, `LeaveEventService` and the expiry job read, so
   * that notice is measured against the same day everywhere. Accra is UTC+0 all year,
   * so it is also the day the person at the screen is having. NFR DAT 03.
   */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/**
 * Whose leave this is, as the policies want it.
 *
 * The same two ids {@link BalanceOwner} carries, and deliberately that type rather than
 * one of this file's own: a request and the balance it moves are decided by the same
 * standings, and two structurally identical types would be an invitation for them to
 * stop being identical.
 */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
