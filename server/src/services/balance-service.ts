/**
 * The one place a balance changes. FR 26, FR 30, FR 36, FR 37, §5.7, §8.2., LMS 211, LMS 217, LMS 301, LMS 306, LMS 212, LMS 214, LMS 216, FR 27, LMS 314, §8.2, FR 17, FR 13, FR 38a.
 */

import type { Actor } from '../auth/actor.js';
import { leaveRequestPolicy } from '../auth/leave-request-policy.js';
import { type BalanceOwner, ledgerPolicy } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import {
  available,
  type BalanceKey,
  daysToCarry,
  daysToCommit,
  daysToGrant,
  daysToLapse,
  daysToRelease,
  daysToReserve,
  type LeaveBalance,
} from '../domain/balance.js';
import type { Employee } from '../domain/employee.js';
import { EmployeeNotFound } from '../domain/employee.js';
import {
  desksThatApproved,
  isADecision,
  type LeaveDecision,
  validateDecision,
} from '../domain/leave-decision.js';
import { type LeaveEvent, validateNewLeaveEvent } from '../domain/leave-event.js';
import type { ApproverRole } from '../domain/approval-chain.js';
import {
  approvalTo,
  isTheLastWord,
  type LeaveRequest,
  LeaveRequestNotFound,
  type ReleasingAction,
  type ReleasingStatus,
  settlementTo,
  type ValidatedLeaveRequest,
} from '../domain/leave-request.js';
import { LeaveTypeNotFound } from '../domain/leave-type.js';
import { LeaveYearNotFound } from '../domain/leave-year.js';
import type { CalendarDate } from '../domain/time.js';
import {
  correctionFor,
  type LedgerEntry,
  LedgerEntryNotFound,
  validateNewLedgerEntry,
} from '../domain/ledger.js';
import type { BalanceRepository } from '../repositories/balance-repository.js';
import { EmployeeRepository } from '../repositories/employee-repository.js';
import type { Repositories, Transactions } from '../repositories/transaction.js';

/** A balance with the figure the story is about beside it. §8.6. */
export type BalanceWithAvailable = LeaveBalance & { available: number };

/** What a caller supplies to move a balance. FR 37. */
export interface BalanceMovement extends BalanceKey {
  /** Positive and whole. FR 24. */
  days: number;
  /** FR 27. */
  reason: string;
}

/** What HR supplies to move a balance by hand. FR 37, LMS 216. */
export interface Adjustment extends BalanceKey {
  /** Signed, and the only movement in this class that is. FR 37, §8.6. */
  days: number;
  /** Mandatory, and the whole point of the story. FR 27. */
  reason: string;
}

/** A movement, and what the balance became. */
export interface BalanceMoved {
  entry: LedgerEntry;
  balance: BalanceWithAvailable;
}

/** What HR supplies to grant entitlement for something that happened. FR 32g, LMS 218. */
export interface EventGrant extends BalanceMovement {
  /** The day the thing happened, which is not the day it was recorded. */
  occurredOn: CalendarDate;
  /** FR 32e. */
  expiresOn: CalendarDate | null;
  /** HR's words about the occurrence itself. */
  note?: string | null;
}

/** What HR or the nightly run supplies to lapse one. FR 32e. */
export interface EventLapse extends BalanceMovement {
  /** The event whose grant has run out of time, and which this closes off. */
  leaveEventId: string;
}

/** A movement caused by a leave request. LMS 301. */
export interface RequestMovement extends BalanceMovement {
  leaveRequestId: string;
}

/** What `LeaveRequestService` supplies to submit one. FR 10, LMS 301. */
export interface RequestToSubmit {
  request: ValidatedLeaveRequest;
  /** FR 27. */
  reason: string;
}

/** What `LeaveRequestService` supplies to end one. FR 26, §8.2., LMS 306. */
export type RequestToSettle = {
  request: LeaveRequest;
  /** Where the table said that leaves it, as the caller read it a moment ago. §6. */
  to: ReleasingStatus;
  /** FR 27. */
  reason: string;
} & SettlingAct;

/**
 * Which of the three endings this is, and what has to be said about it. §6, FR 39, LMS 313, LMS 314, LMS 315.
 */
type SettlingAct =
  | { action: 'REFUSE'; comment: string }
  | { action: Exclude<ReleasingAction, 'REFUSE'>; comment: null };

/** What `LeaveRequestService` supplies to approve one. FR 38a, FR 40, LMS 314. */
export interface RequestToApprove {
  request: LeaveRequest;
  /** FR 38a. */
  chain: readonly ApproverRole[];
  /** FR 04. */
  chiefExecutiveId: string | null;
  /** FR 27. */
  reason: string;
  /** FR 39. */
  comment: string | null;
}

/** The request, the movement it caused, and the balance it left. */
export interface LeaveRequested extends BalanceMoved {
  request: LeaveRequest;
}

/**
 * The same three from the other end of a request's life, and what was said about it. LMS 306, LMS 315.
 */
export interface LeaveReleased extends LeaveRequested {
  /** FR 39. */
  decision: LeaveDecision | null;
}

/**
 * The same three from the middle of a request's life, with the entry allowed to be absent. FR 38a, LMS 314.
 */
export interface LeaveApproved extends Omit<LeaveRequested, 'entry'> {
  /** The `DEDUCTION`, where this approval decided it. */
  entry: LedgerEntry | null;
  /** FR 39, FR 52. */
  decision: LeaveDecision;
}

/** A movement, the balance it left, and the event it belongs to. */
export interface EventGranted extends BalanceMoved {
  event: LeaveEvent;
}

/** The same, from a lapse. */
export type EventLapsed = EventGranted;

export class BalanceService {
  constructor(
    /** For reads, which take no lock and need no transaction. */
    private readonly balances: BalanceRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** The employee records, for one question only: who is this person's line manager. */
    private readonly employees: EmployeeRepository,
    /** Where a movement is written. LMS 212. */
    private readonly transactions: Transactions,
  ) {}

  /**
   * Every balance this person has, oldest leave year first and in the order leave types are shown in. FR 53, FR 55, FR 56, LMS 211.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    leaveYearId?: string,
  ): Promise<BalanceWithAvailable[]> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(employeeId)));

    return (await this.balances.forEmployee(employeeId, leaveYearId)).map(withAvailable);
  }

  /** One balance: this person, this leave type, this leave year. */
  async forOne(actor: Actor, key: BalanceKey): Promise<BalanceWithAvailable> {
    this.guard.enforce(ledgerPolicy.read(actor, await this.ownerOf(key.employeeId)));

    return withAvailable(await this.balances.forOne(key));
  }

  /** Records a leave request and holds the days it costs. FR 10, FR 26, §8.2., LMS 301, FR 32a. */
  async reserveForRequest(actor: Actor, submission: RequestToSubmit): Promise<LeaveRequested> {
    const { request, reason } = submission;
    const owner = await this.ownerOf(request.employeeId);

    this.guard.enforce(ledgerPolicy.reserve(actor, owner));

    const key = keyOf(request);

    return this.transactions.allOrNothing(async (repositories) => {
      /**
       * The lock first, and before either row is written: the figure this is checked against has to be held still from the moment it is read until the move… §8.2..
       */
      const held = await repositories.balances.holdStill(key);

      const type = await repositories.types.findById(request.leaveTypeId);

      if (type === undefined) {
        throw new LeaveTypeNotFound(request.leaveTypeId);
      }

      const days = daysToReserve(held, request.days, type.exceedableWithDocument);

      const written = await repositories.requests.submit(actor, request);

      const entry = await repositories.entries.post(
        actor,
        validateNewLedgerEntry({
          ...key,
          entryType: 'RESERVATION',
          days: -days,
          reason,
          leaveRequestId: written.id,
        }),
      );

      return {
        request: written,
        entry,
        balance: withAvailable(await repositories.balances.forOne(key)),
      };
    });
  }

  /**
   * Ends a leave request and gives back the days it was holding. FR 26, §8.2., LMS 306, FR 39, FR 52, LMS 315.
   */
  async releaseForRequest(actor: Actor, settlement: RequestToSettle): Promise<LeaveReleased> {
    const { request, action, comment, reason } = settlement;
    const owner = await this.ownerOf(request.employeeId);

    /** FR 48, §8.6a. */
    if (isADecision(action)) {
      this.guard.enforce(leaveRequestPolicy.notTheirOwn(actor, owner, action));
    }

    this.guard.enforce(ledgerPolicy.release(actor, owner));

    const key = keyOf(request);

    return this.transactions.allOrNothing(async (repositories) => {
      const held = await repositories.balances.holdStill(key);

      const current = await repositories.requests.findById(request.id);

      if (current === undefined) {
        throw new LeaveRequestNotFound(request.id);
      }

      /**
       * Where the table says this act leaves the request as it stands *now*, rather than the destination the caller worked out before the lock. §6, LMS 313.
       */
      const to = settlementTo(current, action);

      const days = daysToRelease(held, current.days);

      /** FR 39, FR 52. */
      const desk = current.awaitingApprovalFrom;

      if (comment !== null && desk === null) {
        throw new Error(
          `Leave request ${current.id} is being refused and is standing at no desk, so ` +
            `there is no stage for the decision to be recorded at. A request being decided ` +
            `waits on exactly one. FR 38a, FR 52.`,
        );
      }

      /* The desk goes with the status, in one statement, because
         `leave_request_waits_at_a_desk` is an equivalence between the two: a request that
         has ended is waiting on nobody, and leaving a settled row saying "awaiting HR"
         would keep leave that is over in somebody's queue for ever. */
      const written = await repositories.requests.moveTo(actor, current.id, to, null);

      /* Unreachable for the same reason, and one statement later. */
      if (written === undefined) {
        throw new LeaveRequestNotFound(request.id);
      }

      const entry = await repositories.entries.post(
        actor,
        validateNewLedgerEntry({
          ...key,
          entryType: 'RELEASE',
          days,
          reason,
          leaveRequestId: current.id,
        }),
      );

      return {
        request: written,
        entry,
        /* FR 39. Only a refusal is a decision at a desk. Withdrawing is somebody taking
           their own request back and cancelling is HR unwinding a row that should not be on
           the books, and a decision recorded for either would put a judgement in front of
           the requester that nobody made. The union on {@link SettlingAct} is what makes
           this branch a narrowing rather than a guess: a non-null comment is a refusal. */
        decision:
          comment === null || desk === null
            ? null
            : await repositories.decisions.record(
                actor,
                validateDecision({
                  leaveRequestId: current.id,
                  action: 'REFUSE',
                  onBehalfOf: desk,
                  comment,
                }),
              ),
        balance: withAvailable(await repositories.balances.forOne(key)),
      };
    });
  }

  /**
   * Sends a request on to the next desk in its chain, or — where there is none — approves
   * it and turns its held days into taken ones. FR 26, FR 38, FR 38a, FR 40, §8.2. LMS 314.
   *
   * The third door a request's life goes through, and the one that does two different
   * things under one name because they are two outcomes of one act. Somebody at a desk says
   * yes; whether that yes decides the request is a question about the chain, and
   * {@link approvalTo} is where it is asked.
   *
   * ## An intermediate approval writes no movement, and that is not an omission
   *
   * A manager approving stage one of manager-then-HR has changed who the request is waiting
   * on and nothing else. The days have been held since it was submitted, and they go on
   * being held while HR looks at it: `pending` does not move, `taken` does not move, and
   * available is exactly where it was. There is no movement to write, and writing one — a
   * `DEDUCTION` at each stage, a `RESERVATION` re-posted — would be a line in somebody's
   * balance history recording that nothing happened.
   *
   * So the ledger's one-door rule is kept without a movement passing through it, which is
   * the first time that has happened here. What justifies the method living in this class
   * anyway is the other outcome: the last desk's yes **is** a movement, and it has to land
   * in the same transaction as the status. A service that wrote the status elsewhere and
   * called `commit` afterwards would be the two-statement version of exactly the failure
   * `releaseForRequest` exists to prevent.
   *
   * ## Every approval writes a decision, and that is the one thing both outcomes do
   *
   * FR 39, FR 52. LMS 315. The movement is written only by the last desk and the decision is
   * written by all of them, which is the asymmetry {@link LeaveApproved} is shaped around: an
   * intermediate approval changes no figure in any balance and *does* change what somebody at
   * a desk has said, and the second of those is a fact this schema had nowhere to put until
   * `leave_request_decision` existed.
   *
   * The desk it is filed under is `outcome.by` — the stage the walk found inside this lock —
   * rather than anything the caller read. `leave_request_records_its_decision` judges the
   * pair at COMMIT and refuses a move at a desk that recorded nothing, which is what makes
   * the two one act rather than two statements that usually both run.
   *
   * ## The lock, and what it is for when nothing moves
   *
   * The balance is held still for both outcomes, and for the intermediate one it is not
   * protecting a figure — it is serialising the request against the other things that can
   * happen to it. Every move a request makes goes through this class and every one of them
   * takes this lock, so an approval and a withdrawal arriving together are ordered rather
   * than interleaved: the second waits, re-reads a request the first has already moved, and
   * meets {@link LeaveAlreadySettled} or {@link LeaveCannotBeMoved} rather than writing a
   * desk onto a request that has ended.
   *
   * That is the same argument {@link BalanceService.releaseForRequest} makes and it is
   * stronger here, because the alternative is not merely a wrong figure: without it the
   * pair of statements can leave a `WITHDRAWN` request waiting at a desk, which
   * `leave_request_waits_at_a_desk` would refuse at the write with a message about
   * equivalences rather than about leave.
   *
   * ## The chain is re-read inside the lock too
   *
   * `LeaveRequestService` read it to decide whether this actor is at the desk; this reads it
   * again to decide where the request goes. They are the same rows and they agree in every
   * case but one — an HR Administrator changing the chain in between — and in that case the
   * answer that binds is this one, which is the answer that will be true when the row is
   * written. {@link ApprovalChainChanged} is what comes back where the change removed the
   * desk the request is standing on; see it for why that refuses rather than guesses.
   *
   * **How many days is not this method's to choose**, exactly as it is not the release
   * door's. It is what the request was priced at, frozen since submission by
   * `refuse_rewriting_what_a_request_cost()`, and `daysToCommit` refuses to take more out of
   * the hold than is in it — which is what makes approving the same request twice impossible
   * rather than merely unlikely, and is the second line of defence behind
   * `leave_request_commits_once`.
   */
  async approveForRequest(actor: Actor, approval: RequestToApprove): Promise<LeaveApproved> {
    const { request, chain, chiefExecutiveId, comment, reason } = approval;
    const owner = await this.ownerOf(request.employeeId);

    /* FR 48, §8.6a. LMS 319. The same first question the release door asks, in the same
       words, at the top of the other decision door. It is redundant twice over here —
       `ledgerPolicy.commit` refuses the requester on the next line and
       `leaveRequestPolicy.approve` refuses them inside the lock — and it is written anyway,
       because "the identity check is the first thing every decision method does" is a
       property somebody should be able to confirm by looking rather than by working out
       that two other rules happen to cover it between them. */
    this.guard.enforce(leaveRequestPolicy.notTheirOwn(actor, owner, 'APPROVE'));

    /* The ledger's standing question, and the one that refuses somebody approving their
       own leave. `leaveRequestPolicy.approve` has already asked whether this actor is the
       desk; this asks whether they have any business moving this balance at all, and it is
       asked for the intermediate outcome as well as the final one — a stage approved by
       somebody who may not move the balance is a stage that would have to be unpicked. */
    this.guard.enforce(ledgerPolicy.commit(actor, owner, chiefExecutiveId));

    const key = keyOf(request);

    return this.transactions.allOrNothing(async (repositories) => {
      const held = await repositories.balances.holdStill(key);

      const current = await repositories.requests.findById(request.id);

      /* Unreachable: the caller read this row a moment ago and `leave_request_is_never_
         deleted` refuses to remove one on any connection. Answered rather than asserted,
         because the alternative is approving leave that is not there. */
      if (current === undefined) {
        throw new LeaveRequestNotFound(request.id);
      }

      /* **The desk, re-decided against the row as it stands now**, and this is the check
         that closes the one window a lock alone would leave open here.

         `releaseForRequest` needs no equivalent: two withdrawals of one request are the same
         act by the same standing, so re-reading the status is enough. Approval is not — the
         desk moves as the request advances, and the same person clicking twice is two
         *different* questions. Without this, the second click of a manager approving a
         two-stage chain would find the request sitting at the HR desk, walk it to the end,
         and approve the leave outright.

         The service asked the same question a moment ago, for the sentence. This is the one
         that binds, and it is here rather than there for the reason `settlementTo` is asked
         again in the release door: the answer that matters is the one taken against the row
         nobody else can move. */
      this.guard.enforce(
        leaveRequestPolicy.approve(actor, {
          ...owner,
          awaiting: current.awaitingApprovalFrom,
          chiefExecutiveId,
        }),
      );

      /* FR 41, LMS 316. Which stages have signed, read inside the lock and against the rows
         as they stand — the same discipline the status and the desk are held to, and it
         matters here for the sharpest reason of the three. Two approvals of one request
         arriving together are two movements on one balance, so this lock orders them: the
         second waits, reads the decision the first wrote, and finds one fewer stage
         outstanding. Read outside it, both would see an empty list, both would route to the
         same next desk, and the second could approve leave a stage had not seen. */
      const outcome = approvalTo(
        current,
        chain,
        desksThatApproved(await repositories.decisions.forRequest(current.id)),
      );

      const written = await repositories.requests.moveTo(
        actor,
        current.id,
        outcome.to,
        outcome.awaiting,
      );

      /* Unreachable for the same reason, and one statement later. */
      if (written === undefined) {
        throw new LeaveRequestNotFound(request.id);
      }

      return {
        request: written,
        /* FR 39, FR 52. What this desk said, written whichever of the two things the
           approval did — and `outcome.by` rather than anything the caller supplied, for the
           same reason `outcome.to` is what gets stored: the desk that binds is the one the
           walk found against the row nobody else can move. An approval recorded against the
           stage a screen was showing a minute ago is a record of somebody signing for a desk
           they were not at.

           Written before the entry below, so that a decision exists by the time
           `leave_request_records_its_decision` is judged at COMMIT — which it would be
           either way, and the order is for the reader rather than for the trigger. */
        decision: await repositories.decisions.record(
          actor,
          validateDecision({
            leaveRequestId: current.id,
            action: 'APPROVE',
            onBehalfOf: outcome.by,
            comment,
          }),
        ),
        entry: isTheLastWord(outcome)
          ? await repositories.entries.post(
              actor,
              validateNewLedgerEntry({
                ...key,
                entryType: 'DEDUCTION',
                /* Negative, as every consuming movement is. The projection of LMS 211 is
                   what makes a DEDUCTION the one entry type that moves two buckets: it
                   takes the days out of `pending` and puts the same days into `taken`, so
                   available does not move and the balance stops saying the leave is still
                   being decided. */
                days: -daysToCommit(held, current.days),
                reason,
                leaveRequestId: current.id,
              }),
            )
          : null,
        balance: withAvailable(await repositories.balances.forOne(key)),
      };
    });
  }

  /**
   * Grants a year's entitlement. FR 30, LMS 214.
   *
   * The first movement that puts days *into* a balance rather than moving days already
   * there, and the one an employee sees first: this is what you have for the year.
   *
   * **Once per balance per year**, checked inside the lock and refused with
   * {@link AlreadyGranted}. That is what makes the annual job safe to run twice — which
   * is not a hypothetical, it is what happens when it errors halfway through a January
   * morning and somebody runs it again. The alternative is a job that remembers, and a
   * job that remembers is a job that forgets.
   *
   * Named for the year rather than called `grant`, and the name is the rule. An event
   * type's entitlement arrives with the event — FR 32g — and a second confinement in
   * one leave year is correctly a second `GRANT`. That story adds its own method here
   * rather than loosening this one, because "once a year" is true of the annual grant
   * and false of the ledger's `GRANT` entries in general.
   *
   * **The figure is not this method's to choose.** It comes from the entitlement rule
   * in force on the first day of the year — `EntitlementRuleService.entitlementOn` —
   * and arrives here already resolved. A service that looked the figure up as well as
   * posting it would be the place a future story quietly added a second way of working
   * out what somebody is owed.
   *
   * No pro rata. FR 29's proportion for a mid year joiner is a different story with a
   * formula in it; ../jobs/annual-grant.ts passes such a person over and reports that it
   * did.
   */
  async grantTheYear(actor: Actor, grant: BalanceMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(grant.employeeId);

    this.guard.enforce(ledgerPolicy.grant(actor, owner));

    return this.moving(actor, grant, async (_held, repositories) => ({
      entryType: 'GRANT' as const,
      days: daysToGrant(
        grant.days,
        (
          await repositories.entries.entriesFor({
            employeeId: grant.employeeId,
            leaveTypeId: grant.leaveTypeId,
            leaveYearId: grant.leaveYearId,
            entryTypes: ['GRANT'],
          })
        ).length,
      ),
    }));
  }

  /**
   * Records something that happened, and grants the entitlement it brings. FR 32g,
   * §8.6aa. LMS 218.
   *
   * The third movement that puts days into a balance from outside it, and the only one
   * that writes a row in another table while it does. That is the whole shape of this
   * method: **the `GRANT` and the event it was made for are one act**, so they land in
   * one transaction or neither does. A grant with nothing behind it is a hundred and
   * twenty days nobody can explain, and an event that granted nothing is a record of a
   * birth that did the employee no good at all.
   *
   * It goes here rather than in `LeaveEventService` for the reason nothing else posts a
   * movement: the ledger has one door. What that service does is work out *whether* an
   * event may be recorded and what it is worth; this writes it.
   *
   * **No once-per-balance check, and that is the difference from the two above.**
   * `grantTheYear` refuses a second grant and `carryForward` refuses a second carry,
   * because a year is granted once and carried once. An event type is granted *per
   * qualifying occurrence* — FR 32g — so a second bereavement in one leave year is
   * correctly a second `GRANT`, and refusing it would be the rule of the annual grant
   * applied where it is false. What stops a birth being recorded twice is
   * `leave_entitlement_event_one_per_day`, which is a rule about the event rather than
   * about the balance, and it refuses with {@link EventAlreadyRecorded}.
   *
   * **No lock either**, for the same reason there is none on an adjustment: nothing is
   * being checked against what is there. The transaction is here to make the two rows
   * one act rather than to hold a figure still.
   *
   * The deadline arrives already resolved — `expiryFor` in ../domain/leave-event.ts,
   * from `leave_type.entitlement_expiry_months` — and is written to the event row so
   * that changing that column later cannot move a deadline already given. FR 32e.
   */
  async grantForAnEvent(actor: Actor, grant: EventGrant): Promise<EventGranted> {
    const owner = await this.ownerOf(grant.employeeId);

    this.guard.enforce(ledgerPolicy.grantForAnEvent(actor, owner));

    const key = keyOf(grant);

    return this.transactions.allOrNothing(async (repositories) => {
      const entry = await repositories.entries.post(
        actor,
        validateNewLedgerEntry({
          ...key,
          entryType: 'GRANT',
          days: daysToGrant(grant.days, 0),
          reason: grant.reason,
        }),
      );

      const event = await repositories.events.record(
        actor,
        validateNewLeaveEvent({
          ...key,
          occurredOn: grant.occurredOn,
          expiresOn: grant.expiresOn,
          note: grant.note,
          grantedEntryId: entry.id,
        }),
      );

      return { entry, event, balance: withAvailable(await repositories.balances.forOne(key)) };
    });
  }

  /**
   * Lapses whatever is left of an event grant whose time is up. FR 32e, LMS 218.
   *
   * The story's third criterion, and the only movement in this class that takes days
   * away from somebody without a request or a person behind it.
   *
   * **A `LAPSE` and not an `EXPIRY`**, and the difference is which bucket the days go
   * back into. An `EXPIRY` takes days out of `carriedOver`, where FR 36a's carry put
   * them; these days came from a `GRANT`, so they go back out of `entitled`. Using the
   * wrong one would leave a paternity balance reading `carriedOver: -14` on a type that
   * cannot carry a single day — available right, column false. See `BUCKETS` in
   * ../domain/ledger.ts.
   *
   * **Once per event**, checked inside the transaction by the repository's guarded
   * update and refused with {@link AlreadyLapsed}. Per *event* rather than per balance,
   * which is the one place this differs from every other "already" in the class: two
   * births in one leave year each have their own deadline, and counting `LAPSE` entries
   * in the balance would refuse the second one because the first had already run.
   *
   * The event row is closed off in the same transaction as the entry, so a run that
   * fails between the two leaves neither — which is what makes a nightly job safe to
   * run every night rather than safe to run once.
   *
   * **How many days is not this method's to choose.** It is `available` on the balance,
   * decided by `decideTheLapse` in ../domain/leave-event.ts, which is also what refuses
   * to lapse anything while another grant in the same balance is still live.
   */
  async lapse(actor: Actor, lapse: EventLapse): Promise<EventLapsed> {
    const owner = await this.ownerOf(lapse.employeeId);

    this.guard.enforce(ledgerPolicy.lapse(actor, owner));

    const key = keyOf(lapse);

    return this.transactions.allOrNothing(async (repositories) => {
      const entry = await repositories.entries.post(
        actor,
        validateNewLedgerEntry({
          ...key,
          entryType: 'LAPSE',
          days: -daysToLapse(lapse.days),
          reason: lapse.reason,
        }),
      );

      const event = await repositories.events.markLapsed(actor, lapse.leaveEventId, entry.id);

      return { entry, event, balance: withAvailable(await repositories.balances.forOne(key)) };
    });
  }

  /**
   * Carries last year's unused days into this one. FR 36, LMS 217.
   *
   * The second movement that puts days into a balance from outside it, and the sibling of
   * {@link BalanceService.grantTheYear} in every respect — same shape, same lock, same
   * once-per-balance refusal, same desk. What differs is where the figure comes from: a
   * grant's is the entitlement rule for the year, and a carry's is what was left of the
   * year before.
   *
   * **Once per balance**, checked inside the lock and refused with {@link AlreadyCarried}.
   * That is the story's "safely re-runnable", and it is the same argument the annual grant
   * makes: the rollover that failed at employee three hundred on a January morning is run
   * again by somebody who does not know how far it got.
   *
   * **The figure is not this method's to choose.** It is `available` on the closing year's
   * balance, decided by `decideTheCarry` in ../domain/year-rollover.ts and arriving here
   * already resolved — including whether the type carries at all and FR 36a's cap. A
   * service that worked the figure out as well as posting it would be the second place
   * this system decided what carries.
   *
   * **The source balance is read outside this lock, and that is safe because it is
   * closed.** ../jobs/year-rollover.ts closes the year before it reads a single figure out
   * of it, which is what makes the number final: after that the ledger's settled-year
   * trigger refuses every entry type but an `ADJUSTMENT`, so nothing can move it except a
   * deliberate correction with somebody's name on it. The lock here is on the
   * *destination*, which is the balance being written and the one two runs could collide
   * over.
   *
   * Nothing is subtracted from the year that closed; see ../domain/year-rollover.ts for
   * why that is the design rather than an omission.
   */
  async carryForward(actor: Actor, carry: BalanceMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(carry.employeeId);

    this.guard.enforce(ledgerPolicy.carryForward(actor, owner));

    return this.moving(actor, carry, async (_held, repositories) => ({
      entryType: 'CARRY_FORWARD' as const,
      days: daysToCarry(
        carry.days,
        (
          await repositories.entries.entriesFor({
            employeeId: carry.employeeId,
            leaveTypeId: carry.leaveTypeId,
            leaveYearId: carry.leaveYearId,
            entryTypes: ['CARRY_FORWARD'],
          })
        ).length,
      ),
    }));
  }

  /**
   * Turns held days into taken days, which is what approval does. FR 26.
   *
   * **This does not consume days a second time.** The reservation already did that;
   * a `DEDUCTION` moves the same days from `pending` to `taken` and leaves available
   * exactly where it was. Anything that instead subtracted them again would be the
   * double deduction this story is named after, and it would look right in every test
   * that never reserved first.
   *
   * Refused with {@link NotEnoughHeld} where there are not that many days held. That
   * is what makes approving the same request twice impossible rather than merely
   * unlikely: the second attempt asks to take five days out of a hold the first one
   * emptied.
   *
   * **Approving a request goes through {@link BalanceService.approveForRequest} instead**,
   * and the difference is the one {@link BalanceService.release} has with the release door:
   * this posts the entry and leaves the request saying it is still waiting to be decided,
   * which is a balance and a request that disagree. This is the primitive rather than the
   * door, and it stays for the same reason `release` does — the movement is a real one and a
   * story that commits days for a reason other than a chain running out will want it.
   */
  async commit(actor: Actor, movement: RequestMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(movement.employeeId);

    this.guard.enforce(ledgerPolicy.commit(actor, owner));

    return this.moving(actor, movement, async (held) =>
      Promise.resolve({
        entryType: 'DEDUCTION' as const,
        days: -daysToCommit(held, movement.days),
      }),
    );
  }

  /**
   * Gives held days back. The movement, without the request that occasioned it.
   *
   * The mirror of {@link BalanceService.reserve}, and refused by the same rule as
   * {@link BalanceService.commit}: days can only be given back out of days that are
   * held, so a second release of the same five is refused rather than crediting
   * somebody twice.
   *
   * It gives back what was held, never what was taken. Undoing an *approved* absence
   * is a different act with a different entry behind it — FR 25's `RECALCULATION` for
   * a holiday inside approved leave, or an `ADJUSTMENT` where HR has decided — and
   * neither is a release.
   *
   * **Ending a request goes through {@link BalanceService.releaseForRequest} instead**,
   * and the difference is the status. This method posts the entry and leaves the request
   * saying it is still waiting to be decided; that one moves both in a single
   * transaction, which is what LMS 306's story actually asks for. A request whose days
   * came back while it still reads `SUBMITTED` holds nothing and blocks the calendar
   * anyway — `blocksTheCalendar` reads the status, not the ledger.
   *
   * So this is the primitive rather than the door for a withdrawal, and it stays because
   * `leave_request_releases_once` draws the line where the design does: **one RELEASE per
   * request, because a request ends once.** Giving back *part* of what a live request
   * holds — FR 32b converting a day of booked annual leave into sick leave — is a
   * `RECALCULATION`, which is the entry type that exists for exactly that and is
   * deliberately not this one.
   */
  async release(actor: Actor, movement: RequestMovement): Promise<BalanceMoved> {
    const owner = await this.ownerOf(movement.employeeId);

    this.guard.enforce(ledgerPolicy.release(actor, owner));

    return this.moving(actor, movement, async (held) =>
      Promise.resolve({
        entryType: 'RELEASE' as const,
        days: daysToRelease(held, movement.days),
      }),
    );
  }

  /**
   * Moves a balance by hand. FR 37, and the whole of LMS 216. Moved here from
   * `LedgerService` by LMS 212.
   *
   * The story is a genuine mistake being fixed without editing history or losing the
   * explanation, and all three of its parts are already true of the table this writes
   * to. What is left for the method is to be the door: signed days, a mandatory
   * reason, and an entry that reads in the history like any other movement.
   *
   * **Signed, and it is the only movement that is.** FR 37 says "positive or
   * negative" and `ADJUSTMENT` is the one entry type free in its sign, so a caller
   * that wants to give three days passes `3` and one that wants to take two passes
   * `-2`. The other five methods take a positive figure and decide the direction
   * themselves; here there is nothing to decide it from, because there is no request
   * and no rule behind an adjustment — only somebody's judgement.
   *
   * **An HR Administrator's, and nobody else's** — see ../auth/ledger-policy.ts. The
   * story says HR Officer and §10's matrix has an ✗ against that column; the matrix
   * is what the code follows, for the reason the policy file gives at length. An
   * Officer meets an open refusal naming the desk that can, rather than a silent one.
   *
   * **The reason is mandatory** and there is no default for it anywhere in the tree,
   * because a reason that can be omitted is omitted by the writer with the most to
   * explain. `validateNewLedgerEntry` trims it and refuses a blank one with the field
   * name on the message, which is what a form needs; the column refuses one too, for
   * the writer that never came through here.
   *
   * **No lock, and no check against what is there.** That is the difference between
   * an adjustment and the three request movements rather than an omission: it moves
   * days by fiat, so there is no limit to check and nothing for a lock to protect. It
   * may take a balance negative, and where HR means to do that they mean to do it.
   *
   * **The three ids are checked, which they are nowhere else.** This is the one
   * movement whose employee, leave type and leave year come straight from a person
   * filling in a form — the other five are called by the annual run or by the request
   * story, each holding records it has already resolved, and `correct` takes its key
   * off the row it is putting right. So this is the one that would otherwise answer a
   * mistyped id with a foreign key violation, which is the `check_violation` that
   * ../domain/ledger.ts argues is no use to a screen. See
   * {@link BalanceService.filedUnder}.
   *
   * Throws {@link InvalidLedgerEntry} for a figure that is not a movement or a reason
   * that is blank, and {@link EmployeeNotFound}, {@link LeaveTypeNotFound} or
   * {@link LeaveYearNotFound} for an id that is nobody's. A **closed** leave year is
   * not among them: §8.9 makes an adjustment the one kind of entry a settled year
   * accepts, and it is the only way to put a settled figure right. What a closed year
   * refuses is being recalculated quietly by a rule or a job; a deliberate,
   * attributed, permanent correction is not that.
   */
  async adjust(actor: Actor, adjustment: Adjustment): Promise<BalanceMoved> {
    const owner = await this.ownerOf(adjustment.employeeId);

    this.guard.enforce(ledgerPolicy.adjust(actor, owner));

    const key = keyOf(adjustment);

    return this.transactions.allOrNothing(async (repositories) => {
      await this.filedUnder(key, repositories);

      return {
        entry: await repositories.entries.post(
          actor,
          validateNewLedgerEntry({
            ...key,
            entryType: 'ADJUSTMENT',
            days: adjustment.days,
            reason: adjustment.reason,
          }),
        ),
        balance: withAvailable(await repositories.balances.forOne(key)),
      };
    });
  }

  /**
   * Puts an earlier entry right, by posting its exact opposite. Moved here from
   * `LedgerService` by LMS 212, because it is a movement and movements are written
   * here.
   *
   * The amount is the negation of what was posted and is not the caller's to choose.
   * A correction somebody could size is a correction that can be the wrong size, and
   * "an adjustment of −18 correcting a grant of 20" is a row that looks reconciled
   * and leaves two days behind. Anybody who wants a different figure wants an
   * ordinary {@link BalanceService.adjust}, which is a different thing and reads as
   * one in the history.
   *
   * Decided by the same rule as any other adjustment, because that is what it is. The
   * one thing the caller must supply is what went wrong.
   */
  async correct(actor: Actor, entryId: string, reason: string): Promise<BalanceMoved> {
    return this.transactions.allOrNothing(async (repositories) => {
      const wrong = await repositories.entries.findById(entryId);

      /* Refused with {@link LedgerEntryNotFound} for an id that is nobody's, and with
         the policy's silent refusal a line later for an id that is somebody else's —
         deliberately the same outcome from outside, so the pair is not an existence
         oracle. See the note at the top of ../auth/policy.ts. */
      if (wrong === undefined) {
        throw new LedgerEntryNotFound(entryId);
      }

      const owner = await this.ownerOf(wrong.employeeId, repositories.employees);

      this.guard.enforce(ledgerPolicy.adjust(actor, owner));

      return {
        entry: await repositories.entries.post(
          actor,
          validateNewLedgerEntry(correctionFor(wrong, reason)),
        ),
        balance: withAvailable(await repositories.balances.forOne(keyOf(wrong))),
      };
    });
  }

  /**
   * Hold the balance still, decide what the movement is, write it, and read back what
   * it left. The shape all three request movements share. §8.2.
   *
   * The order is the whole of the concurrency argument and none of it is incidental:
   *
   *   **The lock comes first**, before the balance is read, so the figure the rule is
   *   checked against cannot move under it. A read followed by a lock would be a
   *   check on a stale number with a lock protecting nothing.
   *
   *   **The rule is decided inside the window**, by ../domain/balance.ts, which is
   *   handed the held figure rather than fetching one.
   *
   *   **The entry is written in the same transaction**, so the lock is still held
   *   when the movement lands. The trigger of LMS 211 recomputes the cache in that
   *   same transaction, which is why the read at the end is the figure this movement
   *   produced rather than the figure at the time of asking.
   *
   * Whatever the rule throws rolls the transaction back and comes out unchanged, so a
   * caller catches {@link BalanceOverdrawn} exactly as it would outside one — and no
   * lock outlives the refusal.
   */
  private async moving(
    actor: Actor,
    movement: BalanceMovement | RequestMovement,
    decide: (
      held: LeaveBalance,
      repositories: Repositories,
    ) => Promise<{
      entryType: 'GRANT' | 'CARRY_FORWARD' | 'DEDUCTION' | 'RELEASE';
      days: number;
    }>,
  ): Promise<BalanceMoved> {
    const key = keyOf(movement);

    return this.transactions.allOrNothing(async (repositories) => {
      const held = await repositories.balances.holdStill(key);
      const { entryType, days } = await decide(held, repositories);

      const entry = await repositories.entries.post(
        actor,
        validateNewLedgerEntry({
          ...key,
          entryType,
          days,
          reason: movement.reason,
          /* Present for the two request movements and absent for the two entitlement
             ones, which is the same equivalence `validateNewLedgerEntry` refuses on
             either side. Read off the movement rather than passed by each caller, so
             that a method added here cannot forget it — it either has a request or it
             does not, and the type says which. */
          leaveRequestId: 'leaveRequestId' in movement ? movement.leaveRequestId : null,
        }),
      );

      return { entry, balance: withAvailable(await repositories.balances.forOne(key)) };
    });
  }

  /**
   * Whose balance this is, and who their line manager is.
   *
   * {@link EmployeeNotFound} for an id that is nobody, raised before any policy
   * decision because there is no balance to have standing towards, and — for the four
   * movements that can raise it before opening one — before any transaction, because
   * a refusal should cost no lock.
   *
   * `employees` is the pool's repository except inside a transaction, where it is
   * that transaction's. A correction reads the entry it is putting right and then
   * this, and both reads belong on the connection holding the work: a record read on
   * the pool could be one the same transaction has already changed.
   */
  private async ownerOf(
    employeeId: string,
    employees: EmployeeRepository = this.employees,
  ): Promise<BalanceOwner> {
    const employee: Employee | undefined = await employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return { employeeId: employee.id, managerId: employee.managerId };
  }

  /**
   * That the leave type and the leave year a movement names are real ones. LMS 216.
   *
   * The immutable-leave-ledger migration puts it well: a leave type and a leave year
   * are headings things are filed under, and the ledger is the table doing the
   * filing. Both are real foreign keys there, so a mistyped id is already refused —
   * the question this answers is what the person who mistyped it is told.
   *
   * Without this they are told `insert or update on table "leave_ledger_entry"
   * violates foreign key constraint`, which is exactly the `check_violation`
   * ../domain/ledger.ts says a screen cannot use. With it they are told which of the
   * two fields is wrong, in a sentence, which is NFR USA 03.
   *
   * **Only {@link BalanceService.adjust} calls this**, and the reason is in that
   * method: it is the one movement whose ids are typed rather than carried in from a
   * record something upstream already resolved. Adding it to the four locked
   * movements would put two reads in front of a lock to improve a message nobody is
   * going to see, and `reserve` reads the leave type inside the window regardless —
   * it needs the row rather than its existence, for FR 32a.
   *
   * The employee is not checked here because {@link BalanceService.ownerOf} has
   * already checked it, before the transaction, so that a refusal costs nothing.
   *
   * A **closed** leave year passes deliberately. §8.9 makes an adjustment the one
   * entry a settled year accepts, and the trigger that enforces that is the right
   * place for it; a check here would be a second copy that could disagree.
   */
  private async filedUnder(key: BalanceKey, repositories: Repositories): Promise<void> {
    if ((await repositories.types.findById(key.leaveTypeId)) === undefined) {
      throw new LeaveTypeNotFound(key.leaveTypeId);
    }

    if ((await repositories.years.findById(key.leaveYearId)) === undefined) {
      throw new LeaveYearNotFound(key.leaveYearId);
    }
  }
}

function withAvailable(balance: LeaveBalance): BalanceWithAvailable {
  return { ...balance, available: available(balance) };
}

/** The three columns a balance is keyed by, taken off whatever was passed in. */
function keyOf(key: BalanceKey): BalanceKey {
  return {
    employeeId: key.employeeId,
    leaveTypeId: key.leaveTypeId,
    leaveYearId: key.leaveYearId,
  };
}
