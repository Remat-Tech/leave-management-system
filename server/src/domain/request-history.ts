/**
 * What I asked for, and what became of it. FR 54, §7.4. LMS 402.
 *
 * The story is somebody checking what happened to their leave "without relying on memory
 * or email", and both halves of that sentence are load bearing. Memory is wrong about
 * whether the second approver ever answered; email is a record of what was sent rather
 * than of what is true now, and the message saying a manager approved a request is still
 * in the inbox after HR turned it down.
 *
 * So the screen is the rows, and this file is the arrangement of them: every request with
 * where it has got to, and the account of how it got there.
 *
 * ## The trail is composed here because the answer is in four tables
 *
 * `leave_request.status` says whether a request is still being decided.
 * `leave_request.awaiting_approval_from` says who is deciding it. `leave_request_decision`
 * says what each desk said and why. `leave_type_approval_step` says how many desks there
 * were meant to be. Any one of them read alone is a true fact and a misleading screen, and
 * the pairing that actually misleads people is the one LMS 316 was written about: the newest
 * approval, shown on its own, reads as agreement.
 *
 * ./leave-request.ts already put those four together once — {@link progressOf}, whose whole
 * subject is "is this leave mine to take" — and this file does not restate any of it.
 * {@link RequestHistoryEntry.progress} is that function's answer, carried whole. What is
 * added here is the *order*: a progress is a verdict about now, and a history is the
 * sequence that produced it.
 *
 * ## The trail contains what has not happened yet
 *
 * {@link trailFor} ends with the stages nobody has been asked yet, which is the single
 * decision in this file most worth arguing for, because a trail is naturally read as a list
 * of events and these are not events.
 *
 * A trail that stopped at the newest decision would say "approved by your line manager" and
 * stop, under a heading saying the request is still being decided, and the two would be read
 * as one sentence by somebody who has an aeroplane ticket in the other tab. That is the exact
 * misreading FR 41 exists to prevent and the one `progressInWords` already refuses to make in
 * a sentence. A list that ends "then HR — not yet asked" cannot be read that way.
 *
 * The steps that have not happened carry a null {@link TrailStep.at}, which is what tells
 * them apart from the ones that have without a screen having to know what the kinds mean.
 *
 * ## Two endings carry no name and no time, and that is reported rather than guessed
 *
 * A withdrawal and a cancellation are not decisions — ./leave-decision.ts's
 * {@link DECIDING_ACTIONS} is emphatic that "a decision recorded for either would put a
 * judgement in front of the requester that nobody made" — so there is no row in
 * `leave_request_decision` naming who did it or when.
 *
 * The tempting substitute is `leave_request.updated_at`, and it is wrong in a way that would
 * be hard to see: it is when the row last changed, and {@link LeaveRequestChanges} lets the
 * requester improve their reason afterwards, so a withdrawn request whose wording was tidied
 * up in March would report March as the day it was withdrawn. A date that is usually right is
 * worse than no date on a screen whose entire purpose is checking what happened.
 *
 * The audit log has both facts and is deliberately not read here. NFR AUD 02 makes it an
 * investigator's record — ./leave-decision.ts gives the argument in full — and a screen for
 * the person whose leave it is is not where it belongs. The gap is real, it is one story
 * wide, and what closes it is recording the two administrative endings as events of their
 * own rather than reading somebody else's record.
 *
 * ## Newest first, which is the opposite of the calendar
 *
 * `LeaveRequestRepository.list` orders by the day the leave starts, "because a leave page is
 * read as a calendar: what somebody wants to see is the shape of their year". A history is
 * read the other way round — the thing you are checking on is the thing you asked for most
 * recently — so {@link byMostRecentlyAsked} reverses it here rather than in a second query.
 *
 * The sort is stable and compares one field, so requests submitted in the same instant keep
 * the calendar order the repository gave them. That is a deterministic total order without a
 * tie break on an id, which for a `BIGINT` arriving as a string would have to be a numeric
 * comparison written in a file about words.
 *
 * ## No arithmetic, and in particular no re-pricing
 *
 * {@link RequestHistoryEntry.days} is `leave_request.days` — what the request cost when it
 * was made — and {@link RequestHistoryEntry.countingBasis} is the request's copy rather than
 * its type's. FR 11 is the whole argument and ./leave-request.ts makes it at length: an HR
 * Administrator moving a type from working days to calendar days must not restate last
 * March's fortnight as fourteen days on a screen beside a ledger still saying ten.
 *
 * A history is the screen where that would be most visible and least explicable, so this file
 * reads the stored columns and nothing else.
 *
 * ## What is not here
 *
 * **No clock**, and nothing that needs one. Which year to open on is a question the balance
 * screen has to answer because a statement is per year; a history is not, and its default is
 * every request there is.
 *
 * **No policy.** Whose history this is is decided by `leaveRequestPolicy.read` in the
 * service, exactly as ./balance-statement.ts leaves `ledgerPolicy.read` to its own.
 *
 * **No refusal for a year with nothing in it**, which is the one place this file deliberately
 * behaves differently from the balance statement. `NotOneOfTheirLeaveYears` exists there
 * because seven rows of nought read as "you have no leave" to somebody who was not employed
 * yet; an empty history reads as "you asked for no leave that year", which is exactly what it
 * means. A true answer needs no refusal.
 */

import { type ApproverRole, deskInWords } from './approval-chain.js';
import type { Employee } from './employee.js';
import type { LeaveDecision } from './leave-decision.js';
import {
  type ApprovalProgress,
  inWordsSettled,
  type LeaveRequest,
  progressOf,
  type RequestStatus,
} from './leave-request.js';
import { type CountingBasis, countingBasisLabel, type LeaveType } from './leave-type.js';
import { byStartDate, type LeaveYear } from './leave-year.js';
import type { CalendarDate } from './time.js';

/**
 * The kinds of thing that appear on a trail. FR 54's second criterion.
 *
 * Four, and they are not four statuses. A status says where a request has got to; these say
 * what happened on the way, which is why `ASKED` is one of them and `APPROVED` is not — the
 * approval that ends a request is a `DECIDED` step like the one before it, and what made it
 * the last word is that nothing follows it.
 *
 * A closed list rather than free text, so that a screen can give the four different shapes
 * without parsing a sentence. The sentence is there too — {@link TrailStep.inWords} — and it
 * is the one a person reads.
 */
export const TRAIL_STEPS = ['ASKED', 'DECIDED', 'ENDED', 'STILL_TO_ASK'] as const;

export type TrailStepKind = (typeof TRAIL_STEPS)[number];

/** One thing that happened to a request, or one thing that has not happened yet. */
export interface TrailStep {
  kind: TrailStepKind;
  /**
   * FR 52. The desk this step belongs to, where it belongs to one.
   *
   * Null for the asking and for the two endings nobody decides at a desk. For a `DECIDED`
   * step it is the desk the request was standing at, which for a refusal is not necessarily
   * the desk the person who refused it belongs to — see ./leave-decision.ts, which keeps
   * `onBehalfOf` and `decidedBy` apart for exactly that reason.
   */
  desk: ApproverRole | null;
  /**
   * FR 39. What the approver wrote, verbatim and unabridged.
   *
   * The story's second criterion, and the reason it says "including comments": a refusal
   * with the reason left off is the corridor conversation this system exists to replace.
   * Null where there was nothing to say, which an approval is allowed to be.
   */
  comment: string | null;
  /**
   * FR 52. Who made this decision, by name.
   *
   * Null on the steps nothing recorded a person for — the asking, which is by definition
   * this person, and the two endings the module note explains have no row.
   *
   * Resolved from `decidedByEmployeeId` rather than shown as `decidedBy`, and
   * {@link whoDecided} argues why: the recorded description is a handle rather than a name.
   */
  by: string | null;
  /**
   * When it happened, or null where it has not happened or nothing recorded when.
   *
   * The one field that tells a step that has occurred from one that is still to come, so a
   * screen never has to know what `STILL_TO_ASK` means to render it differently.
   */
  at: Date | null;
  /** NFR USA 03. The step in one sentence, composed here so that it is composed once. */
  inWords: string;
}

/** One request, with its current standing and the account of how it reached it. */
export interface RequestHistoryEntry {
  requestId: string;
  leaveTypeId: string;
  /** The type's name as it stands. A history of `leaveTypeId`s is a history of nothing. */
  typeName: string;
  leaveYearId: string;
  /** Ten characters. Not an instant. NFR DAT 03. */
  from: CalendarDate;
  to: CalendarDate;
  /** What the person said when they asked. What the approvers decided on. */
  reason: string;
  /** FR 11. The request's own copy, never the type's. See the module note. */
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  /** FR 24. What it cost, as priced at submission. */
  days: number;
  /** The span, counted or not. "Nine days off, seven of them counted." */
  calendarDays: number;
  status: RequestStatus;
  /** The story's first criterion, in a word a person says. `SUBMITTED` is not one. */
  statusInWords: string;
  submittedAt: Date;
  /**
   * FR 41, FR 42. Where this stands, from {@link progressOf} unchanged.
   *
   * Carried whole rather than unpacked into fields of this interface, because
   * `progress.agreed` is the one field anybody acts on and a copy of it beside the original
   * is a copy that can disagree.
   */
  progress: ApprovalProgress;
  /** The story's second criterion. Oldest first, which is the order it happened in. */
  trail: TrailStep[];
}

/** One person's requests, and the years they may narrow them to. */
export interface RequestHistory {
  employeeId: string;
  /** The year being shown, or null for every request there is. */
  year: LeaveYear | null;
  /** The years this person has asked for leave in, oldest first. */
  years: LeaveYear[];
  /** Newest asked for first. See {@link byMostRecentlyAsked}. */
  entries: RequestHistoryEntry[];
}

/** Everything a history is assembled from, all of it read by the caller. */
export interface RequestHistoryFacts {
  employeeId: string;
  /** The year the caller narrowed to, already checked to be a real one. */
  year: LeaveYear | null;
  /** The years to offer, from {@link yearsWithRequests}. */
  years: readonly LeaveYear[];
  /** The requests to show. Already filtered to the year, where there is one. */
  requests: readonly LeaveRequest[];
  /** Every leave type there is, retired ones included — a history shows them all. */
  types: readonly LeaveType[];
  /**
   * The decisions on those requests, in the order they were made.
   *
   * Across all of them rather than per request, because that is one query rather than one
   * per row; {@link trailFor} groups them. The order within a request is the caller's, and
   * `LeaveDecisionRepository` sorts by id for the reason it gives — `now()` is identical
   * for everything written in one transaction, so an account sorted by time could reorder
   * itself between two reads.
   */
  decisions: readonly LeaveDecision[];
  /**
   * FR 52. The people who made those decisions, for their names. See {@link whoDecided}.
   *
   * Records rather than a map, because reading them is `EmployeeRepository.findAllById` and
   * turning a list into a lookup is this file's business rather than a repository's. Leavers
   * included, and deliberately: a manager who has since left still approved what they
   * approved, and a trail that stopped naming them would be a record quietly rewritten by
   * somebody's resignation.
   */
  deciders: readonly Employee[];
}

/** Who decided a request, by employee id. Built by {@link historyFor} from the records. */
export type Deciders = ReadonlyMap<string, string>;

/* --------------------------------------------------------------------- which years */

/**
 * The leave years this person may narrow their history to. Oldest first.
 *
 * The years they have **asked for leave in**, and nothing else — which is a narrower rule
 * than {@link yearsToChooseFrom} keeps for the balance screen, deliberately and for a reason
 * that is the mirror of that one. A balance exists for every year somebody was employed,
 * whether or not anything moved it, so a picker built from movements would hide a year with
 * a real allowance in it. A request either exists or does not, so a year with none has
 * nothing to show and offering it is offering an empty page.
 *
 * Ordered by the day the year starts rather than by its id, for the reason
 * `BalanceRepository.forEmployee` gives: a company moving to an April start inserts a year
 * whose id is newer than the year it precedes.
 */
export function yearsWithRequests(
  years: readonly LeaveYear[],
  requests: readonly LeaveRequest[],
): LeaveYear[] {
  const asked = new Set(requests.map((request) => request.leaveYearId));

  return [...years].filter((year) => asked.has(year.id)).sort(byStartDate);
}

/* ---------------------------------------------------------------------- the order */

/**
 * Most recently asked for first.
 *
 * The reverse of the repository's calendar order, and the module note argues why a history
 * reads backwards where a leave page reads forwards. It compares one field on purpose:
 * `Array.prototype.sort` is stable, so requests submitted in the same instant — which two
 * written in one transaction are — keep the order they arrived in rather than needing a tie
 * break on a `BIGINT` that reaches this file as a string.
 */
export function byMostRecentlyAsked(left: LeaveRequest, right: LeaveRequest): number {
  return right.submittedAt.getTime() - left.submittedAt.getTime();
}

/* ----------------------------------------------------------------------- the words */

/**
 * Where a request has got to, as a person says it. FR 54's first criterion.
 *
 * `inWordsSettled` for the four that have happened, so that this screen, the ledger's
 * sentence and the two refusals a person meets when they press a button twice all use the
 * same word for the same state. It is exported from ./leave-request.ts rather than copied
 * for that reason, and this is the caller its own note declines to answer: `SUBMITTED` falls
 * to that function's default of "decided", which is wrong here and right there.
 *
 * So the one status it cannot answer is answered here, and it is answered as a *state*
 * rather than as an event, because that is what a status column is. "Waiting to be decided"
 * is the only one of the five that describes something still happening.
 */
export function statusInWords(status: RequestStatus): string {
  return status === 'SUBMITTED' ? 'waiting to be decided' : inWordsSettled(status);
}

/**
 * Who made a decision, by name. FR 52.
 *
 * **`LeaveDecision.decidedBy` is deliberately not what is shown**, and the reason is worth
 * being exact about because the field is right there and reads like an answer. It is
 * `Actor.description`, which `signedInAs` composes as `employee 10` — a handle for a log,
 * written so that a denial or an audit entry can be attributed without a join. "Turned down
 * by employee 10" is not a sentence to put in front of somebody whose leave was refused.
 *
 * So the id is resolved against records the caller read, and the recorded description is the
 * fallback rather than the answer. It is reached in two cases and both are honest there: a
 * decision with no employee id behind it, which is the system or something unattributed, and
 * an id whose record the caller did not read — which would be a bug rather than a state, and
 * `not named by the writer` is a better thing to show than a blank.
 */
export function whoDecided(decision: LeaveDecision, deciders: Deciders): string {
  const named =
    decision.decidedByEmployeeId === null ? undefined : deciders.get(decision.decidedByEmployeeId);

  return named ?? decision.decidedBy;
}

/* ----------------------------------------------------------------------- the trail */

/**
 * How one request got where it is, oldest first. FR 39, FR 41, FR 52. The story's second
 * criterion.
 *
 * Four kinds of step and the order they are put in is the order they happened in:
 *
 *   **Asked for.** Always first and always present, because a request that was never made
 *   is not a request. `submittedAt` is stamped by the database rather than supplied, so it
 *   is the one instant on the trail nothing can have moved.
 *
 *   **Each decision, with what was said.** In the order they were made, which is the order
 *   the caller supplies — see {@link RequestHistoryFacts.decisions}. A refusal names the
 *   *stage* it was made at rather than the person's own desk, because those are two facts
 *   and ./leave-decision.ts keeps them apart: "turned down at your line manager's stage" by
 *   an HR Officer is a sentence somebody needs to be able to read.
 *
 *   **The ending, where nobody decided it.** Withdrawn or cancelled only. An approval or a
 *   refusal already ended the request in a step above, and repeating it would make the
 *   trail say the same thing twice in two voices.
 *
 *   **The stages still to be asked.** Only while the request is being decided, and the
 *   module note argues at length why they are on the list at all.
 *
 * ## The chain is read as it stands now
 *
 * Which is the same reading `LeaveRequestService.approve` and `progressFor` make, and it is
 * what keeps a screen from describing a request differently from the system that is routing
 * it. A chain that has gained a stage since a request was approved shows an approved request
 * with a stage nobody signed — {@link ApprovalProgress.stagesMissing} is that fact, reported
 * rather than hidden — and this trail does not invent a pending step for it, because the
 * request is not waiting for anybody. `stillToApprove` is empty for anything that is not
 * being decided, and that is the field this reads.
 */
export function trailFor(
  request: LeaveRequest,
  progress: ApprovalProgress,
  decisions: readonly LeaveDecision[],
  deciders: Deciders,
): TrailStep[] {
  const steps: TrailStep[] = [
    {
      kind: 'ASKED',
      desk: null,
      comment: null,
      by: null,
      at: request.submittedAt,
      inWords: 'You asked for this leave.',
    },
  ];

  for (const decision of decisions) {
    steps.push({
      kind: 'DECIDED',
      desk: decision.onBehalfOf,
      comment: decision.comment,
      by: whoDecided(decision, deciders),
      at: decision.decidedAt,
      inWords:
        decision.action === 'APPROVE'
          ? `Approved by ${deskInWords(decision.onBehalfOf)}.`
          : `Turned down at ${deskInWords(decision.onBehalfOf)}’s stage.`,
    });
  }

  /* The two endings with nothing behind them but the status. `at` is null rather than
     `updatedAt`, and the module note gives the whole argument: a reworded reason moves that
     column, so it is when the row last changed and not when the request ended. */
  if (request.status === 'WITHDRAWN' || request.status === 'CANCELLED') {
    steps.push({
      kind: 'ENDED',
      desk: null,
      comment: null,
      by: null,
      at: null,
      inWords:
        request.status === 'WITHDRAWN'
          ? 'Taken back before it was decided, and the days went back into the balance.'
          : 'Cancelled by HR and taken off the books, and the days went back into the ' +
            'balance.',
    });
  }

  for (const desk of progress.stillToApprove) {
    steps.push({
      kind: 'STILL_TO_ASK',
      desk,
      comment: null,
      by: null,
      at: null,
      inWords:
        desk === progress.awaiting
          ? `Waiting with ${deskInWords(desk)} now.`
          : `Then ${deskInWords(desk)}, who has not been asked yet.`,
    });
  }

  return steps;
}

/* --------------------------------------------------------------------- the history */

/**
 * One entry: the request as it was priced, where it stands, and how it got there.
 *
 * The type is looked up rather than joined in SQL, and a type that is somehow missing gives
 * a name of "leave" and an empty chain rather than throwing. That is the same answer
 * `LeaveRequestService.settle` gives for the same lookup — "a ledger entry reading '6 days
 * of undefined given back' is worse than one that says less" — and it is unreachable for the
 * same reason: `leave_request.leave_type_id` is NOT NULL with a foreign key behind it and
 * nothing deletes a type. A history that threw would be a screen that showed nothing at all
 * because one row of configuration had gone.
 */
export function entryFor(input: {
  request: LeaveRequest;
  type: LeaveType | undefined;
  decisions: readonly LeaveDecision[];
  deciders: Deciders;
}): RequestHistoryEntry {
  const { request, type, decisions, deciders } = input;

  const progress = progressOf({
    request,
    chain: type?.approvalChain ?? [],
    approvedBy: decisions
      .filter((decision) => decision.action === 'APPROVE')
      .map((decision) => decision.onBehalfOf),
  });

  return {
    requestId: request.id,
    leaveTypeId: request.leaveTypeId,
    typeName: type?.name ?? 'leave',
    leaveYearId: request.leaveYearId,
    from: request.from,
    to: request.to,
    reason: request.reason,
    countingBasis: request.countingBasis,
    countingBasisLabel: countingBasisLabel(request.countingBasis),
    days: request.days,
    calendarDays: request.calendarDays,
    status: request.status,
    statusInWords: statusInWords(request.status),
    submittedAt: request.submittedAt,
    progress,
    trail: trailFor(request, progress, decisions, deciders),
  };
}

/**
 * The history, from the facts the service has gathered.
 *
 * Pure, and assembled here rather than in the service for the reason `statementFor` and
 * `quoteFor` are: what a person is shown about their own leave is a rule about what they
 * are owed an explanation of, and it should be testable without a database.
 *
 * `desksThatApproved` in ./leave-decision.ts is the same filter {@link entryFor} makes over
 * one request's decisions, and it is not called here for the reason that file gives about
 * its own layering: this file has the decisions grouped already, and importing a helper to
 * re-derive one line of it would buy nothing. The unit suite asserts the two agree.
 */
export function historyFor(facts: RequestHistoryFacts): RequestHistory {
  const typesById = new Map(facts.types.map((type) => [type.id, type] as const));

  /* FR 52. Names rather than records, because a name is the whole of what a trail wants and
     handing the entries an `Employee` would put a work email and a start date within reach of
     a screen that has no business with either. */
  const deciders: Deciders = new Map(
    facts.deciders.map((person) => [person.id, `${person.firstName} ${person.lastName}`] as const),
  );

  const decisionsByRequest = new Map<string, LeaveDecision[]>();

  for (const decision of facts.decisions) {
    const collected = decisionsByRequest.get(decision.leaveRequestId);

    if (collected === undefined) {
      decisionsByRequest.set(decision.leaveRequestId, [decision]);
    } else {
      collected.push(decision);
    }
  }

  return {
    employeeId: facts.employeeId,
    year: facts.year,
    years: [...facts.years],
    entries: [...facts.requests].sort(byMostRecentlyAsked).map((request) =>
      entryFor({
        request,
        type: typesById.get(request.leaveTypeId),
        decisions: decisionsByRequest.get(request.id) ?? [],
        deciders,
      }),
    ),
  };
}
