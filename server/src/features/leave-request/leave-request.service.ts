/**
 * Asking for leave, being told what it costs first, and taking it back. FR 10, FR 11, FR 14, FR 26, §8., LMS 301, LMS 305, LMS 306, FR 16, FR 05, FR 15, LMS 303, §8.2, LMS 314, FR 38a, LMS 212, FR 39, FR 52, LMS 315, FR 48, §8.6, LMS 319, FR 59, §7.1., LMS 329, FR 17, FR 13.
 */

import type { Actor } from '../../auth/actor.js';
import { desksHandedTo, leaveRequestPolicy } from './policy.js';
import { delegatesOf, delegationsThatBearOn } from './delegation.js';
import type { ApprovalDelegationService } from './delegation.service.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import {
  type BulkAction,
  type BulkAsSent,
  bulkInWords,
  validateBulkDecision,
} from './bulk-decision.js';
import type { BalanceOwner } from '../balance/policy.js';
import type { Decision, Guard } from '../../auth/policy.js';
import type { Employee } from '../employee/employee.js';
import { EmployeeNotFound } from '../employee/employee.js';
import type { DayCount, LeavePeriod } from '../leave-calculator/leave-calculator.js';
import { validateLeavePeriod } from '../leave-calculator/leave-calculator.js';
import {
  type DecidingAction,
  desksThatApproved,
  desksThatRefused,
  isAnOverride,
  type LeaveDecision,
  type OverridingAction,
  overrideRequiredFor,
  readComment,
  requireAComment,
  requireAJustification,
  saysYes,
  theManagersDecision,
  whoDecidedWhere,
} from './leave-decision.js';
import { lineMoved, type ReportingLineMove, requestsThatFollow } from './reassignment.js';
import type { RecordedReassignment } from './reassignment.db.js';
import {
  type DeskOccupants,
  deskOccupants,
  type DesksAvailable,
  desksAvailable,
  routeFrom,
  standingOf,
  whatWouldRouteIt,
  whoCouldDecide,
} from './routing.js';
import { APPROVES_AS_HR } from '../role/roles.js';
import type { RoleRepository } from '../role/role.db.js';
import type { LeaveRoutingRepository } from './routing.db.js';
import type { WithdrawalRepository } from './withdrawal.db.js';
import { countUsable, type LeaveRequestAttachment } from './attachment.js';
import type { AttachmentRepository } from './attachment.db.js';
import {
  type ApprovalProgress,
  assertDocumentationIsAttached,
  assertNobodyGotThereFirst,
  certifiedDaysIn,
  assertItCostsSomething,
  assertShortNoticeIsAcknowledged,
  assertTheDaysAreThere,
  decisionTo,
  documentationGroundsFor,
  grantingAction,
  InvalidLeaveRequest,
  lateEntryFor,
  LeaveCannotBeMoved,
  LeaveCrossesAYearEnd,
  type LeaveRequest,
  type LeaveRequestQuote,
  LeaveRequestNotFound,
  LeaveOverlapsAnother,
  type NewLeaveRequest,
  NotEnoughDays,
  NothingLeftToGiveBack,
  noticeGiven,
  NothingToOverturn,
  OverrulingNeedsAnOverride,
  progressOf,
  quoteFor,
  reachesPastTheEndOf,
  reasonForApproval,
  reasonForGivingBackTakenDays,
  reasonForRelease,
  reasonForReservation,
  type ReleasingAction,
  settlementTo,
  StillNobodyToDecideIt,
  validateLeaveRequestChanges,
  validateNewLeaveRequest,
  whatIsLeftOf,
  withdrawalTo,
} from './leave-request.js';
import {
  NothingToAnswer,
  readReason,
  saysWhy,
  theOpenAsk,
  WithdrawalNeedsAReason,
} from './withdrawal.js';
import { decisionNews, endingNews } from '../notification/notification.js';
import {
  assertEligible,
  assertSomebodyApprovesIt,
  assertStillOffered,
  type LeaveType,
  LeaveTypeNotFound,
} from '../leave-type/leave-type.js';
import { type LeaveYear, LeaveYearNotFound } from '../leave-year/leave-year.js';
import { type CalendarDate, calendarDateIn, dayAfter } from '../../shared/time.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveDecisionRepository } from './leave-decision.db.js';
import type { LeaveRequestListOptions, LeaveRequestRepository } from './leave-request.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import type { OrganisationRepository } from '../organisation/organisation.db.js';
/** FR 44, LMS 505. */
import { OverridesAreSwitchedOff } from '../organisation/organisation.js';
import { BalanceOverdrawn } from '../balance/balance.js';
import type {
  BalanceService,
  LeaveApproved,
  LeaveReleased,
  LeaveRequested,
  LeaveRerouted,
  RequestToSubmit,
  WithdrawalAnswered,
  WithdrawalAsked,
} from '../balance/balance.service.js';
import type { LeaveCalculatorService } from '../leave-calculator/leave-calculator.service.js';
import type { NotificationService } from '../notification/notification.service.js';

/** What a period is priced from: a request without the two fields pricing does not read. */
export type QuotableLeave = Omit<
  NewLeaveRequest,
  'reason' | 'acknowledgesShortNotice' | 'lateEntryReason'
>;

/** One request a moved reporting line carried, and the handover recorded. FR 07, LMS 325. */
export interface RequestThatFollowed {
  request: LeaveRequest;
  reassignment: RecordedReassignment | null;
}

/** One request a batch left where it was, and what refused it. FR 51, LMS 328. */
export interface LeftUndecided {
  requestId: string;
  /** The refusal itself, so the boundary renders it as it renders every other. */
  because: unknown;
}

/** What one press did. FR 51, LMS 328. */
export interface BulkDecided {
  action: BulkAction;
  decided: LeaveApproved[];
  undecided: LeftUndecided[];
  inWords: string;
}

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
     * The stages a request's routing skipped, for the reads. FR 48b, LMS 320.
     *
     * The same division `decisions` is held to, and for the same reason: a skip has to land
     * in the same transaction as the desk it explains, so the writing is `BalanceService`'s.
     */
    private readonly routing: LeaveRoutingRepository,
    /**
     * The asks to take agreed leave off the books, and HR's answers, for the reads. FR 47, LMS 324.
     *
     * The same division `decisions` is held to: an answer lands in the same transaction as
     * the days it moves, so the writing is `BalanceService`'s.
     */
    private readonly withdrawals: WithdrawalRepository,
    /**
     * The evidence waiting to go on a request, for the reads. FR 13, LMS 311.
     *
     * The same division `decisions` is held to: the files land in the same transaction as the
     * request they evidence, so the writing is `BalanceService`'s and this is the reading —
     * which is what {@link assertDocumentationIsAttached} is answered from.
     */
    private readonly attachments: AttachmentRepository,
    /**
     * Who holds an HR role, so that the HR desk's occupants are never a copy. FR 48b, LMS 320.
     *
     * The one question asked of it: is there anybody in HR who is not the person asking.
     */
    private readonly roles: RoleRepository,
    /**
     * Who is covering for an approver who is away. FR 49, §8.6a, LMS 327.
     *
     * Beside `roles` for the same reason: a delegate is at a desk, so it is one more question
     * about who can be asked there. A service rather than the repository, because what a
     * delegation reaches depends on what its approver holds today.
     */
    private readonly delegations: ApprovalDelegationService,
    /**
     * Who the `CEO` desk resolves to. FR 48c, LMS 321.
     *
     * Beside `roles` because it is the same question about the other desk that is not a
     * reporting line. It was `EmployeeRepository.findRoot` until LMS 321.
     */
    private readonly organisation: OrganisationRepository,
    /**
     * What the period costs. The one place this question is asked.
     *
     * A service rather than the domain function, because counting needs the working
     * pattern and the holiday calendar and those are reads with policies in front of
     * them — see ../features/leave-calculator/leave-calculator.service.ts, which is where the two are
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
   *
   * **The reason is not one of its inputs**, and the signature says so since LMS 403. What
   * a period costs is a question about a type, two dates and a working pattern; a form that
   * prices a fortnight on every keystroke would otherwise have to send whatever half-written
   * sentence was in the box, and a reader of this method would be entitled to wonder whether
   * it counted for something. `submit` takes the whole of {@link NewLeaveRequest}, which
   * still satisfies this.
   *
   * Nor is the acknowledgement. FR 17, LMS 307: the warning is what a quote is for.
   */
  async quote(actor: Actor, input: QuotableLeave): Promise<LeaveRequestQuote> {
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
   * {@link LeaveYearIsClosed} for a settled year, {@link TooLateToRecord} and
   * {@link LateEntryNeedsAReason} for leave dated further back than the type's window,
   * and {@link NotEnoughDays} where the
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

    /* FR 17, FR 18. The two windows, answered before anything is counted: the only refusals
       on this path that need no read at all. Notice is measured once and both read it. */
    const daysOfNotice = noticeGiven(this.today(), period.from);

    /* FR 17, LMS 307. Warned at the quote and answered here. */
    assertShortNoticeIsAcknowledged(
      type,
      period,
      daysOfNotice,
      input.acknowledgesShortNotice === true,
    );

    /* FR 18, LMS 308. Recording an absence on the way back in is ordinary and answers null;
       past the window it is HR's to enter, with a reason. */
    const lateEntryReason = lateEntryFor({
      type,
      period,
      daysOfNotice,
      mayRecordLate: this.guard.permits(leaveRequestPolicy.recordLate(actor, ownerOf(employee))),
      reason: input.lateEntryReason,
    });

    /* Counted again, inside no transaction yet but from the same facts, and it is this
       answer that is stored. See the module note for why it is not the caller's. */
    const count = await this.countFor(actor, employee, type, period);

    /* Read once, and both of the next two rules are decided from it: what a person is
       refused on and what they are asked for evidence for are the same figure. */
    const availableNow = await this.availableFor(actor, employee, type, year);

    /* FR 14, LMS 305. The days, checked while the form is still open and against the
       same figure the quote showed. `daysToReserve` checks it again inside the lock and
       that is the answer that binds; this is the one that can name the leave type, the
       figure and what to ask for instead. */
    assertTheDaysAreThere(type, period, count, availableNow);

    /* FR 13, FR 32a, LMS 311. The two documentation thresholds, and the evidence that has
       been waiting under this person's name to answer them. Asked here — while the form is
       still open and the sentence can name what to upload — and held again by
       `leave_request_that_needed_evidence_has_it` as the transaction below commits. */
    const grounds = documentationGroundsFor({ type, days: count.days, availableNow });
    const evidence = await this.evidenceWaitingFor(employee, input.evidence ?? []);

    assertDocumentationIsAttached({
      type,
      period,
      days: count.days,
      availableNow,
      grounds,
      usable: countUsable(evidence),
      waiting: evidence.length - countUsable(evidence),
    });

    /** FR 48b, LMS 320. Who can be asked, before the first desk is chosen. */
    const { available, occupants } = await this.whoCanDecide(employee);

    const request = validateNewLeaveRequest({
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYearId: year.id,
      from: period.from,
      to: period.to,
      reason: input.reason,
      /** FR 10. The type's rule, brought here as `countingBasis` is. */
      reasonRequired: type.reasonRequired,
      /** FR 18, LMS 308. Decided above; null on everything inside the window. */
      lateEntryReason,
      /** FR 13, FR 32a, LMS 311. Decided above, and copied onto the row it was true of. */
      evidenceRequired: grounds.length > 0,
      /* FR 32a, §8.6b, LMS 312. How many of the days the certificate is carrying, from the
         same reading the ground was found in. */
      certifiedDays: certifiedDaysIn({ type, days: count.days, availableNow }),
      /* The story's third criterion, taken here and never read off the type again. */
      countingBasis: type.countingBasis,
      days: count.days,
      calendarDays: count.calendarDays,
      /* FR 38a, LMS 314's first criterion. The chain is handed over and the *first* stage
         of it is written onto the row; `assertSomebodyApprovesIt` above has already refused
         an empty one with the type named. Annual leave starts with the manager and
         unpaid leave starts with HR because that is what their chains say, and nothing on
         this path knows which type is which. */
      approvalChain: type.approvalChain,
      /* FR 48b, LMS 320's first criterion. A stage nobody can answer is skipped to its
         stand-in, and a stage with no stand-in either leaves the request `UNROUTABLE`. */
      available,
    });

    const submitted = await this.reserve(actor, type, period, {
      request,
      reason: reasonForReservation(type.name, period, count.days),
      /* FR 13, LMS 311. The files go onto the request in the same transaction as the row,
         which is what "the evidence arrives with the request" means when it is written down:
         a request that needed documentation and a certificate that never reached it cannot
         be two halves of one commit. */
      evidence: evidence.map((file) => file.id),
    });

    /* FR 48b. Nobody can decide it, so HR is told rather than the request being refused —
       the leave is real and its days are held. LMS 320. */
    if (submitted.request.status === 'UNROUTABLE') {
      await this.alertThatNobodyCanDecideIt(submitted, employee, type, { available, occupants });

      return submitted;
    }

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
   * Holds the days, and says the lock's refusal in the submission's words. FR 14, LMS 410.
   *
   * `daysToReserve` is still the check that binds; nothing here weakens it. What changes is who
   * the refusal is addressed to. {@link BalanceOverdrawn} is composed inside the lock from days
   * and a balance, so it names no leave type and nothing to do. {@link NotEnoughDays} is the
   * same fact with the type and period in hand. Only this path translates — the door keeps its
   * own refusal for every other caller.
   */
  private async reserve(
    actor: Actor,
    type: LeaveType,
    period: LeavePeriod,
    submission: RequestToSubmit,
  ): Promise<LeaveRequested> {
    try {
      return await this.balances.reserveForRequest(actor, submission);
    } catch (error) {
      if (error instanceof BalanceOverdrawn) {
        throw new NotEnoughDays(type, period, error.requested, error.available);
      }

      throw error;
    }
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
    return this.settle(actor, id, 'WITHDRAW', (owner) => leaveRequestPolicy.withdraw(actor, owner));
  }
  /**
   * Unwinds a request that should not be on the books, and gives the days back. FR 26.
   *
   * HR's alone — leave booked against the wrong person, a request entered twice, days
   * that belong in another year. See {@link leaveRequestPolicy.cancel}.
   */
  async cancel(actor: Actor, id: string): Promise<LeaveReleased> {
    return this.settle(actor, id, 'CANCEL', (owner) => leaveRequestPolicy.cancel(actor, owner));
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
   *   the Chief Executive, who is nobody's manager and holds no role, so a read asked
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
   *   **The Chief Executive.** FR 48c makes it a setting rather than a role or a reporting
   *   line, so the desk resolves to an id and the id comes from
   *   `OrganisationRepository.chiefExecutiveId`. LMS 321.
   *
   * Throws {@link LeaveRequestNotFound} for an id that is nobody's, {@link NotAuthorised}
   * for somebody who may not see the request or is not the desk it is waiting on,
   * {@link LeaveAlreadySettled} for leave that has ended, {@link LeaveCannotBeMoved} for
   * leave that has already been approved, and {@link ApprovalChainChanged} where the chain
   * has moved out from under it.
   */
  async approve(
    actor: Actor,
    id: string,
    comment?: string,
    /** NFR DAT 02, §8.1. The version the screen was drawn from, where it named one. LMS 326. */
    versionSeen?: string | null,
  ): Promise<LeaveApproved> {
    return this.decide(actor, id, 'APPROVE', readComment(comment), versionSeen);
  }

  /**
   * Turns down leave at the desk it is sitting on. FR 26, FR 39, FR 42, FR 44. LMS 315, LMS 317, LMS 318.
   *
   * The same door as {@link LeaveRequestService.approve} since LMS 318: a rejection is a
   * decision at a stage, so it records the no and hands the request on to the next desk.
   * The days come back only when the last desk is the one saying it.
   */
  async refuse(
    actor: Actor,
    id: string,
    comment: string,
    /** NFR DAT 02, §8.1. LMS 326. */
    versionSeen?: string | null,
  ): Promise<LeaveApproved> {
    return this.decide(actor, id, 'REFUSE', requireAComment(comment), versionSeen);
  }

  /**
   * Overturns the manager's decision, with the reason in writing. FR 44, §7.2. LMS 318.
   *
   * An ordinary decision at the desk the request is sitting on, asking two things a plain
   * one does not: a justification, and a manager's decision to actually be reversing.
   *
   * Throws {@link OverrideNeedsAJustification} for one with nothing said, before anything
   * is read, and {@link NothingToOverturn} where the manager decided the same way or
   * has not decided at all.
   */
  async override(
    actor: Actor,
    id: string,
    action: OverridingAction,
    justification: string,
    /** NFR DAT 02, §8.1. LMS 326. */
    versionSeen?: string | null,
  ): Promise<LeaveApproved> {
    return this.decide(actor, id, action, requireAJustification(justification), versionSeen);
  }

  /**
   * Answers several requests at one press. FR 51, FR 39, FR 48, §8.6a. LMS 328.
   *
   * Every item goes through {@link LeaveRequestService.decide}, so a batch is not a second way
   * of deciding: the self-approval refusal, the desk, the version and the lock are asked of
   * each one. One request that cannot be decided does not stop the rest, and the report says
   * which went through and what refused the others.
   *
   * Sequential, and that is load bearing. Each decision takes the balance lock and then the
   * request; running them at once would be those two locks in as many orders as there are rows.
   *
   * A fault is one item's answer rather than the batch's, for the same reason: the decisions
   * already committed cannot be unsaid by throwing the report away.
   */
  async decideMany(actor: Actor, sent: BulkAsSent): Promise<BulkDecided> {
    const { action, comment, requests } = validateBulkDecision(sent);

    const decided: LeaveApproved[] = [];
    const undecided: LeftUndecided[] = [];

    for (const one of requests) {
      try {
        decided.push(await this.decide(actor, one.requestId, action, comment, one.version));
      } catch (error) {
        undecided.push({ requestId: one.requestId, because: error });
      }
    }

    return {
      action,
      decided,
      undecided,
      inWords: bulkInWords(action, decided.length, undecided.length),
    };
  }

  /**
   * The one path a desk decides by. FR 38, FR 38a, FR 40, FR 44, §6, §7.2. LMS 314, LMS 318.
   *
   * Four verbs, one method, and which of the three things it does — hand the request on,
   * agree it, or turn it down — is the chain's answer rather than the caller's.
   *
   * The order of the questions is a disclosure rule. Whose leave it is, then whether the
   * asker may see it at all — asked only of somebody who is not the desk, because being
   * the desk is its own reason to be looking — then whether there is a decision to make,
   * then whether it contradicts the manager, and last whether this actor is the desk.
   */
  private async decide(
    actor: Actor,
    id: string,
    action: DecidingAction,
    comment: string | null,
    /** NFR DAT 02, §8.1. What the screen deciding this was drawn from. LMS 326. */
    versionSeen: string | null = null,
  ): Promise<LeaveApproved> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);
    const owner = ownerOf(employee);

    /** FR 48, §8.6a. LMS 319. */
    this.guard.enforce(leaveRequestPolicy.notTheirOwn(actor, owner, action));

    const type = await this.typeFor(request.leaveTypeId);

    /** FR 04, FR 48b, FR 48d. Who staffs each desk, and who FR 04's seat is. LMS 320, LMS 322. */
    const { available, occupants, chiefExecutiveId } = await this.whoCanDecide(employee);

    /** FR 49, LMS 327. Whose approvals this actor answers today, if anybody's. */
    const standingIn = desksHandedTo(
      actor,
      chiefExecutiveId,
      await this.delegations.standingInFor(actor.employeeId),
    );

    const standing = leaveRequestPolicy.decide(actor, action, {
      ...owner,
      awaiting: request.awaitingApprovalFrom,
      chiefExecutiveId,
      standingIn,
    });

    if (!standing.allowed) {
      this.guard.enforce(leaveRequestPolicy.read(actor, owner));
    }

    const decisions = await this.decisions.forRequest(request.id);

    /* NFR DAT 02, §8.1. Somebody answered this while it was being decided. LMS 326. Asked
       here for the sentence, before the walk below can call it an impossible move, and again
       inside the lock, where it binds. */
    assertNobodyGotThereFirst({
      request,
      deskTheyStoodAt: request.awaitingApprovalFrom,
      decisions,
      versionSeen,
    });

    /* FR 44. Which stage has not *decided*, rather than which has not approved. Asked again
       inside the lock, where the answer binds. */
    const outcome = decisionTo({
      request,
      action,
      chain: type.approvalChain,
      decidedAlready: whoDecidedWhere(decisions),
      /** FR 48d, LMS 322. */
      decider: actor.employeeId,
      skipped: await this.routing.forRequest(request.id),
      available,
      occupants,
    });

    /** FR 44, §7.2, LMS 505. */
    const overturns = this.whatThisReverses(
      request,
      action,
      decisions,
      await this.organisation.overridesAreAllowed(),
    );

    /* FR 48d. A standing question, so it is asked here with the others rather than before
       them: somebody reaching for leave that has since been approved is told that. LMS 322.
       The answer that binds is the same question inside the lock. */
    this.guard.enforce(
      leaveRequestPolicy.eachStageADifferentPerson(
        actor,
        owner,
        action,
        whoDecidedWhere(decisions),
      ),
    );

    this.guard.enforce(standing);

    const decided = await this.balances.decideForRequest(actor, {
      request,
      action,
      chain: type.approvalChain,
      chiefExecutiveId,
      available,
      occupants,
      /** FR 49, LMS 327. Carried into the lock, where the desk it answers for is settled. */
      standingIn,
      comment,
      overturns,
      /** NFR DAT 02, §8.1. Carried into the lock, where the same question binds. LMS 326. */
      versionSeen,
      reasonForTaking: reasonForApproval(type.name, request, request.days, outcome.by),
      reasonForGivingBack: reasonForRelease(type.name, request, request.days, 'REFUSED'),
    });

    await this.tellThemAbout(decided, employee, type.name);

    /* FR 48b. The decision was recorded and there is nowhere left to send it. LMS 320. */
    if (decided.request.status === 'UNROUTABLE') {
      await this.alertThatNobodyCanDecideIt(decided, employee, type, { available, occupants });
    }

    return decided;
  }

  /**
   * Asks for leave every desk has agreed to be taken off the books. FR 47, §8.2. LMS 324.
   *
   * The person's own act, and only theirs. It writes one row and moves nothing; what changes
   * is that HR has something to answer, and they are told so.
   *
   * Throws {@link LeaveCannotBeMoved} for leave that is not agreed — a request still being
   * decided is withdrawn — and {@link AlreadyAskedToWithdraw} for a second ask while the
   * first is unanswered.
   */
  async askToWithdraw(actor: Actor, id: string, reason: string): Promise<WithdrawalAsked> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(leaveRequestPolicy.askToWithdraw(actor, ownerOf(employee)));

    /** FR 47. Refused before anything else is read, while the box is still open. */
    const said = readReason(reason);

    if (said === null) {
      throw new WithdrawalNeedsAReason('ASK_TO_WITHDRAW');
    }

    /* Read off `TRANSITIONS` for its refusal, and asked again inside the lock. */
    withdrawalTo(request, 'ASK_TO_WITHDRAW');

    const type = await this.types.findById(request.leaveTypeId);
    const typeName = type?.name ?? 'leave';

    const asked = await this.balances.askToWithdraw(actor, { request, reason: said });

    /* FR 59, FR 47. HR hears, because HR is who answers it. */
    for (const recipient of await this.employees.findAllById(await this.employeesInHr())) {
      if (recipient.id === employee.id) {
        continue;
      }

      await this.notifications.tell({
        event: 'WITHDRAWAL_ASKED',
        employee,
        recipient,
        request: asked.request,
        typeName,
        /** FR 52. An ask is not a decision at a desk. */
        decidedBy: null,
        comment: said,
        availableAfter: asked.balance.available,
      });
    }

    return asked;
  }

  /**
   * Agrees to it, putting back the days that were not taken. FR 47, §8.2. LMS 324.
   *
   * One method for both of the story's grants, because which applies is the calendar's
   * answer rather than HR's — {@link grantingAction}. What comes back is counted rather than
   * supplied: the whole request before it starts, {@link whatIsLeftOf} it once it has.
   *
   * Throws {@link NothingToAnswer} where nobody has asked, {@link WithdrawalNeedsAReason} for
   * an amendment with nothing said, and {@link NothingLeftToGiveBack} for leave that is over.
   */
  async grantWithdrawal(actor: Actor, id: string, reason?: string): Promise<WithdrawalAnswered> {
    const { request, employee, type, typeName } = await this.aWithdrawalToAnswer(actor, id);

    const action = grantingAction(request, this.today());
    const said = readReason(reason);

    /** FR 47. Refused here as well as by the column, so the message names the field. */
    if (saysWhy(action) && said === null) {
      throw new WithdrawalNeedsAReason(action);
    }

    const days =
      action === 'WITHDRAW_APPROVED'
        ? request.days
        : await this.daysNotYetTaken(actor, employee, type, request, typeName);

    const answered = await this.balances.answerAWithdrawal(actor, {
      request,
      action,
      reason: said,
      days,
      reasonForGivingBack: reasonForGivingBackTakenDays(typeName, request, days, action),
    });

    /** FR 59. */
    await this.notifications.tell({
      event: action === 'WITHDRAW_APPROVED' ? 'WITHDRAWAL_GRANTED' : 'LEAVE_AMENDED',
      employee,
      request: answered.request,
      typeName,
      /** FR 52. Answering an ask is not a decision at a desk. */
      decidedBy: null,
      comment: said,
      availableAfter: answered.balance.available,
      /** FR 47. What came back, off the entry that was written. */
      daysBack: answered.entry?.days ?? days,
    });

    return answered;
  }

  /**
   * Turns it down, and says why. FR 47, FR 39. LMS 324.
   *
   * Moves nothing and is written down anyway. Asking again once circumstances change is a
   * new ask; what is refused is two open at once.
   */
  async refuseWithdrawal(actor: Actor, id: string, reason: string): Promise<WithdrawalAnswered> {
    const { request, employee, typeName } = await this.aWithdrawalToAnswer(actor, id);

    const said = readReason(reason);

    if (said === null) {
      throw new WithdrawalNeedsAReason('REFUSE_WITHDRAWAL');
    }

    const answered = await this.balances.answerAWithdrawal(actor, {
      request,
      action: 'REFUSE_WITHDRAWAL',
      reason: said,
      /* Ignored on this branch: no days move. */
      days: request.days,
      reasonForGivingBack: reasonForGivingBackTakenDays(
        typeName,
        request,
        request.days,
        'WITHDRAW_APPROVED',
      ),
    });

    /** FR 59. */
    await this.notifications.tell({
      event: 'WITHDRAWAL_REFUSED',
      employee,
      request: answered.request,
      typeName,
      decidedBy: null,
      comment: said,
      availableAfter: answered.balance.available,
    });

    return answered;
  }

  /**
   * The reads and the questions both answers share. FR 47, FR 48. LMS 324.
   *
   * Standing before state, the disclosure rule the settlement path keeps. {@link NothingToAnswer}
   * is asked here for the sentence and again inside the lock, where it binds.
   */
  private async aWithdrawalToAnswer(
    actor: Actor,
    id: string,
  ): Promise<{ request: LeaveRequest; employee: Employee; type: LeaveType; typeName: string }> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);
    const owner = ownerOf(employee);

    /** FR 48, §8.6a. Nobody answers their own ask. LMS 319. */
    this.guard.enforce(leaveRequestPolicy.notTheirOwn(actor, owner, 'WITHDRAW_APPROVED'));
    this.guard.enforce(leaveRequestPolicy.answerAWithdrawal(actor, 'WITHDRAW_APPROVED', owner));

    if (theOpenAsk(await this.withdrawals.forRequest(request.id)) === undefined) {
      throw new NothingToAnswer(request.id);
    }

    const type = await this.typeFor(request.leaveTypeId);

    return { request, employee, type, typeName: type.name };
  }

  /**
   * What is left of an approved period, in days. FR 11, FR 47. LMS 324.
   *
   * Counted rather than subtracted, on the basis the request was priced under.
   */
  private async daysNotYetTaken(
    actor: Actor,
    employee: Employee,
    type: LeaveType,
    request: LeaveRequest,
    typeName: string,
  ): Promise<number> {
    const left = whatIsLeftOf(request, this.today());

    if (left === null) {
      throw new NothingLeftToGiveBack(request, typeName);
    }

    /** FR 11, LMS 303. The request's basis, not the type's as it now stands. */
    const count = await this.calculator.count(
      actor,
      employee,
      { ...type, countingBasis: request.countingBasis },
      left,
    );

    if (count.days <= 0) {
      throw new NothingLeftToGiveBack(request, typeName);
    }

    return count.days;
  }

  /**
   * Sends a request nobody could decide back into its chain. FR 48b, §8.6a. LMS 320.
   *
   * What the alert asks HR for once the desk that came up empty has somebody at it. It
   * decides nothing and moves no days — the request goes back to `SUBMITTED` at whichever
   * desk can now be asked, and the person is told it is moving again.
   *
   * Throws {@link StillNobodyToDecideIt} where nothing has changed, {@link LeaveCannotBeMoved}
   * for a request that is not stuck, and {@link NotAuthorised} for anybody but HR.
   */
  async route(actor: Actor, id: string): Promise<LeaveRerouted> {
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employeeFor(request.employeeId);

    this.guard.enforce(leaveRequestPolicy.route(actor, ownerOf(employee)));

    const type = await this.typeFor(request.leaveTypeId);

    const { available, occupants } = await this.whoCanDecide(employee);

    const rerouted = await this.balances.rerouteRequest(actor, {
      request,
      chain: type.approvalChain,
      available,
      occupants,
    });

    /** FR 59. It is moving again, and the person who asked hears the same as at submission. */
    await this.notifications.tell({
      event: 'SUBMITTED',
      employee,
      request: rerouted.request,
      typeName: type.name,
      decidedBy: null,
      comment: null,
      availableAfter: rerouted.balance.available,
    });

    return rerouted;
  }

  /**
   * Carries somebody's pending leave to their new manager. FR 07, §8.4, FR 59. LMS 325.
   *
   * What a reporting-line change does to the requests waiting on it. The `MANAGER` desk is
   * the line, so a request waiting there is the new manager's the moment the line moves and
   * the walk usually leaves it exactly where it is; what this adds is the record of the
   * handover, the new manager being told, and the two cases where the desk itself moves — a
   * request an empty manager's desk had stranded, and one this change empties.
   *
   * Nothing is decided and no days move. Approvals already given stand, attributed to
   * whoever gave them, which is why only stages nobody has answered are carried.
   *
   * One request that cannot be moved does not stop the rest: the reporting line has already
   * changed, and it is not undone by leave that had nowhere to go.
   */
  async followTheReportingLine(
    actor: Actor,
    move: ReportingLineMove,
  ): Promise<RequestThatFollowed[]> {
    if (!lineMoved(move)) {
      return [];
    }

    const employee = await this.employeeFor(move.employeeId);

    this.guard.enforce(leaveRequestPolicy.route(actor, ownerOf(employee)));

    const waiting = [
      ...(await this.requests.list({ employeeId: employee.id, status: 'SUBMITTED' })),
      ...(await this.requests.list({ employeeId: employee.id, status: 'UNROUTABLE' })),
    ];

    const followed: RequestThatFollowed[] = [];

    for (const request of requestsThatFollow(waiting)) {
      const carried = await this.carry(actor, employee, request, move);

      if (carried !== null) {
        followed.push(carried);
      }
    }

    return followed;
  }

  /** One request carried, or null where the walk had nowhere new to put it. FR 07, LMS 325. */
  private async carry(
    actor: Actor,
    employee: Employee,
    request: LeaveRequest,
    move: ReportingLineMove,
  ): Promise<RequestThatFollowed | null> {
    const type = await this.typeFor(request.leaveTypeId);
    const desks = await this.whoCanDecide(employee);

    let carried: LeaveRerouted;

    try {
      carried = await this.balances.rerouteRequest(actor, {
        request,
        chain: type.approvalChain,
        available: desks.available,
        occupants: desks.occupants,
        /** FR 07. What is being recorded against every request this moves. */
        movedBy: move,
      });
    } catch (error) {
      /* A request this line did not unstick stays stuck, and one whose remaining stages have
         all signed stays where it is. Neither is a failure of the change to the record. */
      if (error instanceof StillNobodyToDecideIt || error instanceof LeaveCannotBeMoved) {
        return null;
      }

      throw error;
    }

    await this.tellThemItMoved(carried, employee, type, desks);

    return { request: carried.request, reassignment: carried.reassignment };
  }

  /** Who hears about a request the reporting line moved. FR 07, FR 59, §8.4. LMS 325. */
  private async tellThemItMoved(
    carried: LeaveRerouted,
    employee: Employee,
    type: LeaveType,
    desks: { available: DesksAvailable; occupants: DeskOccupants },
  ): Promise<void> {
    const { request } = carried;

    /** FR 48b. The change emptied the desk under it, so it is the alert LMS 320 wrote. */
    if (request.status === 'UNROUTABLE') {
      await this.alertThatNobodyCanDecideIt(carried, employee, type, desks);
      return;
    }

    const manager =
      request.awaitingApprovalFrom === 'MANAGER' && employee.managerId !== null
        ? await this.employees.findById(employee.managerId)
        : undefined;

    /** FR 07. The story's third criterion: the manager who has inherited the decision. */
    if (manager !== undefined) {
      await this.notifications.tell({
        event: 'REASSIGNED',
        employee,
        recipient: manager,
        request,
        typeName: type.name,
        decidedBy: null,
        comment: null,
        availableAfter: carried.balance.available,
      });

      return;
    }

    /* The stage went to a desk that is not a reporting line, so there is nobody new to name.
       The person whose leave it is hears where it has got to, as they do at submission. */
    await this.notifications.tell({
      event: 'SUBMITTED',
      employee,
      request,
      typeName: type.name,
      decidedBy: null,
      comment: null,
      availableAfter: carried.balance.available,
    });
  }

  /**
   * Tells the person and HR that nobody can decide a request. FR 48b, FR 59, §8.6a. LMS 320.
   *
   * The last criterion's alert, and it goes to two kinds of reader: the person whose leave
   * has stopped, and whoever can change the organisation so that it has not. HR and the
   * Chief Executive both get it, because the desk that is empty is very often HR's own.
   *
   * After the transaction, like every other notice, and it can no more throw than they can —
   * a request that is stuck is not made better by the alert failing to send.
   */
  private async alertThatNobodyCanDecideIt(
    stuck: { request: LeaveRequest; balance: { available: number } },
    employee: Employee,
    type: LeaveType,
    desks: { available: DesksAvailable; occupants: DeskOccupants },
  ): Promise<void> {
    const { available, occupants } = desks;

    /* The stage it stopped at, worked out from the same walk that stopped there, so the
       sentence in the alert is the walk's own account rather than a second opinion. */
    const routed = routeFrom({
      chain: type.approvalChain,
      decided: whoDecidedWhere(await this.decisions.forRequest(stuck.request.id)),
      skipped: await this.routing.forRequest(stuck.request.id),
      available,
      occupants,
    });

    const said =
      routed.kind === 'UNROUTABLE'
        ? `${routed.because} ${whatWouldRouteIt(routed.stranded, available)}`
        : null;

    for (const recipient of await this.whoShouldHearAboutIt(employee)) {
      await this.notifications.tell({
        event: 'UNROUTABLE',
        employee,
        recipient: recipient.id === employee.id ? undefined : recipient,
        request: stuck.request,
        typeName: type.name,
        decidedBy: null,
        comment: said,
        availableAfter: stuck.balance.available,
      });
    }
  }

  /** The person whose leave it is, then everybody who could unstick it. FR 48b, LMS 320. */
  private async whoShouldHearAboutIt(employee: Employee): Promise<Employee[]> {
    const ids = new Set<string>(await this.employeesInHr());

    /** FR 48c. The configured Chief Executive, not FR 04's root. LMS 321. */
    const chiefExecutiveId = await this.organisation.chiefExecutiveId();

    if (chiefExecutiveId !== null) {
      ids.add(chiefExecutiveId);
    }

    ids.delete(employee.id);

    return [employee, ...(await this.employees.findAllById([...ids]))];
  }

  /**
   * The manager's decision this verb reverses, or null where it reverses nothing. FR 44, §7.2. LMS 318.
   *
   * What makes the justification unavoidable: a plain verb that would contradict the line
   * manager is refused and pointed at the override, and an override that contradicts nobody
   * is refused too.
   */
  private whatThisReverses(
    request: LeaveRequest,
    action: DecidingAction,
    decisions: readonly LeaveDecision[],
    /** FR 44, LMS 505. Off makes the manager's word final. */
    overridesAreAllowed: boolean,
  ): string | null {
    const managers = theManagersDecision(decisions);
    const required = overrideRequiredFor(action, decisions);

    if (!isAnOverride(action)) {
      if (required !== null) {
        /* Switched off, so the plain verb is not pointed at an override that would also be
           refused. The manager's answer stands and nothing here changes it. */
        throw overridesAreAllowed
          ? new OverrulingNeedsAnOverride(request, required)
          : new OverridesAreSwitchedOff();
      }

      return null;
    }

    if (!overridesAreAllowed) {
      throw new OverridesAreSwitchedOff();
    }

    if (required !== action || managers === undefined) {
      throw new NothingToOverturn(request, action, managers?.action ?? null);
    }

    return managers.id;
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
   * manager sees it, and a role that reads every record sees it; a colleague sees
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

    const decisions = await this.decisions.forRequest(request.id);

    return progressOf({
      request,
      chain: type.approvalChain,
      approvedBy: desksThatApproved(decisions),
      /** FR 44. A stage that said no has had its say and is not waiting on anybody. */
      refusedBy: desksThatRefused(decisions),
      /** FR 48b. A stage that was skipped is not still owed an answer. LMS 320. */
      skipped: await this.routing.forRequest(request.id),
    });
  }

  /**
   * Every request waiting at a desk, with who it is waiting on. FR 48, FR 49, FR 50, FR 60. LMS 330.
   *
   * The daily reminder's read, and the one place outside the approver queue that answers
   * "whose answer is this waiting for". `whoCanDecide` is the same resolution the decide door
   * makes, so nobody is chased about a request they could not decide — the requester is never
   * at their own desk, and a delegate covering for an approver is. FR 49.
   *
   * Memoised per asker, because one person's three pending requests resolve the same desks.
   */
  async everythingAwaitingADecision(actor: Actor): Promise<AwaitingADecision[]> {
    this.guard.enforce(leaveRequestPolicy.chaseTheCompany(actor));

    const desksFor = new Map<string, WhoIsThere>();
    const waiting: AwaitingADecision[] = [];

    for (const request of await this.requests.awaitingAnyDesk()) {
      const employee = await this.employeeFor(request.employeeId);
      const type = await this.typeFor(request.leaveTypeId);

      const desks = desksFor.get(employee.id) ?? (await this.whoCanDecide(employee));
      desksFor.set(employee.id, desks);

      /* Unreachable: `awaitingAnyDesk` filters on the desk being set. */
      const desk = request.awaitingApprovalFrom;

      waiting.push({
        request,
        employee,
        typeName: type.name,
        approvers:
          desk === null ? [] : await this.employees.findAllById([...desks.occupants[desk]]),
      });
    }

    return waiting;
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
   * Who can be asked at each of the three desks, and who the `CEO` desk resolves to. FR 04, FR 38a, FR 48, FR 48b, FR 48c, §8.6a. LMS 314, LMS 320, LMS 321.
   *
   * Three lookups, one per desk, and the requester's own id is what turns "staffed" into
   * "can decide this" — LMS 319's rule read as a fact about the desk rather than as a
   * refusal at the door.
   *
   * **The Chief Executive is read for every chain**, where LMS 314 read them only for a chain
   * naming `CEO`. Since LMS 320 they stand in for HR, so they can be the desk a request is
   * sitting on without the type's chain mentioning them at all — and a null here
   * would mean the one person who *can* decide it being refused at their own desk.
   *
   * **Since LMS 321 they are a setting**, not FR 04's root. FR 48c.
   *
   * A terminated record staffs nothing: somebody who has left cannot sign in, and a desk
   * held only by a leaver is a desk a request would wait at for ever. Being *away* is FR 49
   * and is not this.
   */
  private async whoCanDecide(employee: Employee): Promise<WhoIsThere> {
    /** FR 48c. Sequential, because the id is what the lookup below needs. */
    const chiefExecutiveId = await this.organisation.chiefExecutiveId();

    const [manager, chiefExecutive, inHr] = await Promise.all([
      employee.managerId === null
        ? Promise.resolve(undefined)
        : this.employees.findById(employee.managerId),
      chiefExecutiveId === null
        ? Promise.resolve(undefined)
        : this.employees.findById(chiefExecutiveId),
      this.employeesInHr(),
    ]);

    const themselves: Record<ApproverRole, string[]> = {
      /** FR 04. A reporting line, never a role. */
      MANAGER: stillHere(manager),
      /** Two role codes staff one desk. FR 38a. */
      HR: inHr,
      /** FR 48c. A setting, never a job title. */
      CEO: stillHere(chiefExecutive),
    };

    /* FR 49, LMS 327. Whoever is covering for the people at those desks is at them too, so
       the walk finds a desk answerable where its occupant is away. A delegation of the
       requester's own carries nothing, which is LMS 319 read as a fact about the desk. */
    const covering = delegationsThatBearOn(
      await this.delegations.delegatesAt([...new Set(Object.values(themselves).flat())]),
      employee.id,
    );

    const atTheDesk: DeskOccupants = deskOccupants((desk) => [
      ...themselves[desk],
      ...delegatesOf(covering, themselves[desk]),
    ]);

    return {
      available: desksAvailable((desk) => standingOf(atTheDesk[desk], employee.id)),
      /* FR 48d, LMS 322. The same read said as names rather than as a standing, because a
         second officer is a person: `available` says whether a desk can be asked at all and
         this says who is there to ask. */
      occupants: deskOccupants((desk) => whoCouldDecide(atTheDesk[desk], employee.id)),
      /* FR 48c. The configured id, not `stillHere`'s answer: being the desk and the desk
         being able to decide are different questions, and the second is `available`. */
      chiefExecutiveId,
    };
  }

  /** Everybody holding a role that approves as HR, who has not left. FR 38a, FR 48b. */
  private async employeesInHr(): Promise<string[]> {
    const ids = new Set<string>();

    for (const code of APPROVES_AS_HR) {
      for (const id of await this.roles.employeeIdsHolding(code)) {
        ids.add(id);
      }
    }

    const records = await this.employees.findAllById([...ids]);

    return records.flatMap(stillHere);
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
   *   whose leave it is and who their manager is, and neither is knowable from an
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

    const settled = await this.balances.releaseForRequest(actor, { request, action, to, reason });

    /* FR 59, LMS 329. Both endings tell the person, and they tell them different things —
       days coming back look identical in a balance whether somebody changed their mind or
       HR unwound a row. */
    await this.notifications.tell({
      event: endingNews(action === 'WITHDRAW' ? 'WITHDRAWN' : 'CANCELLED'),
      employee,
      request: settled.request,
      typeName,
      /** FR 52. Neither of these is a decision at a desk. */
      decidedBy: null,
      comment: null,
      availableAfter: settled.balance.available,
    });

    return settled;
  }

  /**
   * Tells the people a decision concerns. FR 59, FR 44, §7.1. LMS 329, LMS 318.
   *
   * The requester always, and the manager as well where their decision was the one
   * reversed — which is FR 44's last criterion. Both notices go out after the transaction
   * has committed, and both are composed from the rows that were written rather than from
   * what the caller expected.
   */
  private async tellThemAbout(
    decided: LeaveApproved,
    employee: Employee,
    typeName: string,
  ): Promise<void> {
    const { decision, request, balance } = decided;
    const saidYes = saysYes(decision.action);

    await this.notifications.tell({
      event: decisionNews(request, saidYes),
      employee,
      request,
      typeName,
      decidedBy: decision.onBehalfOf,
      comment: decision.comment,
      availableAfter: balance.available,
    });

    if (decision.overridesDecisionId === null) {
      return;
    }

    /* FR 44. The manager, told their decision was overturned and why. Read back off
       the committed rows: the decision that was reversed says which desk made it and which
       way it went, and the employee record says who to send it to. */
    const reversed = (await this.decisions.forRequest(request.id)).find(
      (one) => one.id === decision.overridesDecisionId,
    );

    const manager =
      employee.managerId === null ? undefined : await this.employees.findById(employee.managerId);

    /* A manager who has since left, or a decision that has somehow gone: the override
       stands either way, and a notice nobody can be sent is not a reason to unpick it. */
    if (manager === undefined || reversed === undefined) {
      return;
    }

    await this.notifications.tell({
      event: 'DECISION_OVERTURNED',
      employee,
      recipient: manager,
      request,
      typeName,
      decidedBy: decision.onBehalfOf,
      comment: decision.comment,
      availableAfter: balance.available,
      overturned: {
        desk: reversed.onBehalfOf,
        said: saysYes(reversed.action) ? 'APPROVE' : 'REFUSE',
      },
    });
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
   * manager's, or a role that reads everybody — because a request is the reason a
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
   * see ../features/leave-request/policy.ts. Everything the days were priced from is
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

    /** FR 10. Judged by the same rule the submission was, so a reason cannot be blanked
        on a type that asks for one. */
    const type = await this.typeFor(existing.leaveTypeId);

    const changes = validateLeaveRequestChanges({ reason }, type.reasonRequired);
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
    /* Without the reason, which nothing here reads and which `validateNewLeaveRequest`
       checks on the submission path where it is actually going to be stored — and without
       the acknowledgement, which is `submit`'s alone. FR 17, LMS 307. */
    input: QuotableLeave,
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
   * The files this submission named, of the ones actually waiting for it. FR 13, LMS 311.
   *
   * Every id is looked up against *this person's* waiting pile rather than fetched by id and
   * checked afterwards, so an id belonging to somebody else is not found rather than refused
   * — the same silence `leaveRequestPolicy.attach` keeps, and it means a request cannot be
   * used to discover that a colleague uploaded a medical certificate this morning.
   *
   * An id that reaches nothing is dropped rather than refused. What matters to FR 13 is
   * whether anything usable arrived, and {@link assertDocumentationIsAttached} says that in a
   * sentence about the leave; "attachment 41 is not yours" would say it about an identifier.
   */
  private async evidenceWaitingFor(
    employee: Employee,
    ids: readonly string[],
  ): Promise<LeaveRequestAttachment[]> {
    if (ids.length === 0) {
      return [];
    }

    const waiting = await this.attachments.waitingFor(employee.id);
    const named = new Set(ids);

    return waiting.filter((file) => named.has(file.id));
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
   * is a permission of its own — ../features/balance/policy.ts — and it is that service's to
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
/** Who staffs each desk for one request, and who the `CEO` desk resolves to. FR 48b, FR 48c, LMS 320, LMS 321. */
/** One request waiting at a desk, and who it is waiting on. FR 50, FR 60, LMS 330. */
export interface AwaitingADecision {
  request: LeaveRequest;
  /** Whose leave it is, named in a message written to somebody else. */
  employee: Employee;
  typeName: string;
  /** Who is at the desk it sits at: delegates included, the requester never. FR 48, FR 49. */
  approvers: Employee[];
}

interface WhoIsThere {
  available: DesksAvailable;
  /** FR 48d, LMS 322. */
  occupants: DeskOccupants;
  /** FR 48c. */
  chiefExecutiveId: string | null;
}

function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}

/** Somebody's id, where they are a record that can still answer at a desk. FR 06, FR 48b. */
function stillHere(employee: Employee | undefined): string[] {
  return employee === undefined || employee.employmentStatus === 'TERMINATED' ? [] : [employee.id];
}
