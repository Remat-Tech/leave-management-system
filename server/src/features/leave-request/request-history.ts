/**
 * What I asked for, and what became of it. FR 54, §7.4., LMS 402, LMS 316, FR 41, NFR AUD 02, FR 11.
 */

import { type ApproverRole, deskInWords } from '../leave-type/approval-chain.js';
import type { Employee } from '../employee/employee.js';
import {
  desksThatApproved,
  desksThatRefused,
  isAnOverride,
  type LeaveDecision,
} from './leave-decision.js';
import {
  type ApprovalProgress,
  inWordsSettled,
  type LeaveRequest,
  progressOf,
  type RequestStatus,
} from './leave-request.js';
import {
  type CountingBasis,
  countingBasisLabel,
  type LeaveType,
} from '../leave-type/leave-type.js';
import type { SkippedStage } from './routing.js';
import type { RecordedSkip } from './routing.db.js';
import { byStartDate, type LeaveYear } from '../leave-year/leave-year.js';
import type { CalendarDate } from '../../shared/time.js';

/** The kinds of thing that appear on a trail. FR 54, FR 44. */
export const TRAIL_STEPS = [
  'ASKED',
  'DECIDED',
  /** A decision that reversed the line manager's. FR 44, §7.2, LMS 318. */
  'OVERTURNED',
  'ENDED',
  'STILL_TO_ASK',
] as const;

export type TrailStepKind = (typeof TRAIL_STEPS)[number];

/** One thing that happened to a request, or one thing that has not happened yet. */
export interface TrailStep {
  kind: TrailStepKind;
  /** FR 52. */
  desk: ApproverRole | null;
  /** FR 39. */
  comment: string | null;
  /** FR 52. */
  by: string | null;
  /** When it happened, or null where it has not happened or nothing recorded when. */
  at: Date | null;
  /** NFR USA 03. */
  inWords: string;
}

/** One request, with its current standing and the account of how it reached it. */
export interface RequestHistoryEntry {
  requestId: string;
  leaveTypeId: string;
  /** The type's name as it stands. */
  typeName: string;
  leaveYearId: string;
  /** Ten characters. NFR DAT 03. */
  from: CalendarDate;
  to: CalendarDate;
  /** What the person said when they asked. */
  reason: string;
  /** FR 11. */
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  /** FR 24. */
  days: number;
  /** The span, counted or not. */
  calendarDays: number;
  status: RequestStatus;
  /** The story's first criterion, in a word a person says. */
  statusInWords: string;
  submittedAt: Date;
  /** FR 41, FR 42. */
  progress: ApprovalProgress;
  /** The story's second criterion. */
  trail: TrailStep[];
}

/** One person's requests, and the years they may narrow them to. */
export interface RequestHistory {
  employeeId: string;
  /** The year being shown, or null for every request there is. */
  year: LeaveYear | null;
  /** The years this person has asked for leave in, oldest first. */
  years: LeaveYear[];
  /** Newest asked for first. */
  entries: RequestHistoryEntry[];
}

/** Everything a history is assembled from, all of it read by the caller. */
export interface RequestHistoryFacts {
  employeeId: string;
  /** The year the caller narrowed to, already checked to be a real one. */
  year: LeaveYear | null;
  /** The years to offer, from yearsWithRequests. */
  years: readonly LeaveYear[];
  /** The requests to show. */
  requests: readonly LeaveRequest[];
  /** Every leave type there is, retired ones included — a history shows them all. */
  types: readonly LeaveType[];
  /** The decisions on those requests, in the order they were made. */
  decisions: readonly LeaveDecision[];
  /** FR 52. */
  deciders: readonly Employee[];
  /** FR 48b. The stages those requests' routing skipped. LMS 320. */
  skipped?: readonly RecordedSkip[];
}

/** Who decided a request, by employee id. */
export type Deciders = ReadonlyMap<string, string>;

/** The leave years this person may narrow their history to. */
export function yearsWithRequests(
  years: readonly LeaveYear[],
  requests: readonly LeaveRequest[],
): LeaveYear[] {
  const asked = new Set(requests.map((request) => request.leaveYearId));

  return [...years].filter((year) => asked.has(year.id)).sort(byStartDate);
}

/** Most recently asked for first. */
export function byMostRecentlyAsked(left: LeaveRequest, right: LeaveRequest): number {
  return right.submittedAt.getTime() - left.submittedAt.getTime();
}

/** Where a request has got to, as a person says it. FR 54. */
export function statusInWords(status: RequestStatus): string {
  if (status === 'SUBMITTED') {
    return 'waiting to be decided';
  }

  /** FR 48b, LMS 320. Not decided, and not waiting on anybody either. */
  if (status === 'UNROUTABLE') {
    return 'stopped — no approver could decide it';
  }

  return inWordsSettled(status);
}

/** Who made a decision, by name. FR 52. */
export function whoDecided(decision: LeaveDecision, deciders: Deciders): string {
  const named =
    decision.decidedByEmployeeId === null ? undefined : deciders.get(decision.decidedByEmployeeId);

  return named ?? decision.decidedBy;
}

/**
 * One decision, in the words the person whose leave it is reads. FR 39, FR 44. LMS 318.
 *
 * An override says what it reversed, because that is the sentence FR 44 asks to keep: a
 * trail reading "Approved by HR" under "Turned down at your line manager's stage" leaves the
 * reader to work out which one stood.
 */
function decisionInWords(decision: LeaveDecision): string {
  const desk = deskInWords(decision.onBehalfOf);

  switch (decision.action) {
    case 'APPROVE':
      return `Approved by ${desk}.`;
    case 'REFUSE':
      return `Turned down at ${desk}’s stage.`;
    case 'OVERTURN_REJECTION':
      return `${sentenceCase(desk)} overturned that decision and approved this leave.`;
    default:
      return `${sentenceCase(desk)} overturned that decision and turned this leave down.`;
  }
}

/** A phrase that starts a sentence. "HR" is already there; "your line manager" is not. */
function sentenceCase(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How one request got where it is, oldest first. FR 39, FR 41, FR 52. */
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
      /* FR 44. An override is its own kind of step, so a screen can show it as what it is
         rather than as an approval that happens to carry a comment. LMS 318. */
      kind: isAnOverride(decision.action) ? 'OVERTURNED' : 'DECIDED',
      desk: decision.onBehalfOf,
      comment: decision.comment,
      by: whoDecided(decision, deciders),
      at: decision.decidedAt,
      inWords: decisionInWords(decision),
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
  /** FR 48b. The stages this request's routing skipped. LMS 320. */
  skipped?: readonly SkippedStage[];
}): RequestHistoryEntry {
  const { request, type, decisions, deciders } = input;

  const progress = progressOf({
    request,
    chain: type?.approvalChain ?? [],
    approvedBy: desksThatApproved(decisions),
    /** FR 44. A stage that said no has decided, and is not waiting on anybody. LMS 318. */
    refusedBy: desksThatRefused(decisions),
    /** FR 48b, LMS 320. */
    skipped: input.skipped,
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

  const decisionsByRequest = byRequest(facts.decisions);
  /** FR 48b, LMS 320. */
  const skipsByRequest = byRequest(facts.skipped ?? []);

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
        skipped: skipsByRequest.get(request.id) ?? [],
      }),
    ),
  };
}

/** Rows of one page grouped by the request they belong to, in the order they arrived. */
function byRequest<T extends { leaveRequestId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const collected = grouped.get(row.leaveRequestId);

    if (collected === undefined) {
      grouped.set(row.leaveRequestId, [row]);
    } else {
      collected.push(row);
    }
  }

  return grouped;
}
