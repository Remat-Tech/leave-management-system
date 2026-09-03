/**
 * Everything waiting on one approver, with what they need to decide it. FR 20, FR 40, FR 38a, FR 17, FR 18, FR 48, §8.6a, §8.6, NFR USA 03, LMS 404.
 */

import {
  type ApproverRole,
  chainInWordsAbout,
  possessively,
} from '../leave-type/approval-chain.js';
import {
  available,
  type BalanceKey,
  committed,
  type LeaveBalance,
  noMovementsYet,
  owed,
} from '../balance/balance.js';
import {
  type CountingBasis,
  countingBasisLabel,
  type LeaveType,
  noticeShortfall,
} from '../leave-type/leave-type.js';
import type { Employee } from '../employee/employee.js';
import {
  type DecidingAction,
  desksThatApproved,
  desksThatRefused,
  type LeaveDecision,
  type OverridingAction,
  overrideRequiredFor,
  saysYes,
  theManagersDecision,
} from './leave-decision.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import {
  type LeaveRequest,
  noticeGiven,
  periodsOverlap,
  progressOf,
  type RequestStatus,
} from './leave-request.js';
import { type CalendarDate, formatDay } from '../../shared/time.js';

/**
 * The desks one person answers at, and whose requests each reaches. FR 38a, FR 40, FR 04.
 *
 * Plain data rather than an `Actor`, for the reason `Standing` is a standing rather than a
 * `RoleCode`: which roles staff which desk is ./policy.ts's to say, and `desksStaffedBy` there
 * is the one place that says it.
 *
 * `managerId` is why this is not simply a list of desks. `HR` and `CEO` are staffed for the
 * whole company; `MANAGER` resolves through a reporting line, so reading it as "every request
 * at a manager's desk" would put the company's annual leave in front of the first person given
 * a report.
 */
export interface DesksStaffed {
  /** FR 38a. Every desk this person answers at, in {@link APPROVER_ROLES} order. */
  desks: readonly ApproverRole[];
  /** Their own id, where `MANAGER` is among the desks. Null where it is not. */
  managerId: string | null;
}

/** Whether this person answers at any desk at all. FR 40. */
export function staffsAnyDesk(staffed: DesksStaffed): boolean {
  return staffed.desks.length > 0;
}

/** The desks this person answers for the whole company, rather than for their own reports. */
export function companyWideDesks(staffed: DesksStaffed): ApproverRole[] {
  return staffed.desks.filter((desk) => desk !== 'MANAGER');
}

/* ------------------------------------------------------------------------ the flags */

/**
 * What is worth pointing out before somebody decides. FR 17, FR 18. The story's third criterion.
 *
 * Tokens rather than prose, as `QUOTE_WARNINGS` and `FORM_RULE_KINDS` are: a screen groups by
 * the token and composes nothing itself.
 *
 * Neither is a refusal, and the wording has to carry that. FR 17 warns and allows through
 * because "whether short notice is workable is a judgement for the approvers" — this is where
 * that judgement is made — and a backdated request is one `assertWithinBackdatingWindow`
 * already let through.
 *
 * `DOCUMENTATION_REQUIRED` is the obvious next one and is deliberately not here: LMS 404 asks
 * for two. The condition is `documentationRequired` and `quoteFor` has already written the
 * sentence, so the story that wants it adds a member and a branch in {@link flagsFor}.
 */
export const QUEUE_FLAGS = [
  /** FR 17. Less notice than the type expects. Advisory — the approver decides. */
  'SHORT_NOTICE',
  /** FR 18. The leave had already started when it was asked for. */
  'BACKDATED',
] as const;

export type QueueFlag = (typeof QUEUE_FLAGS)[number];

/** One thing worth knowing about a request, in the words the approver reads. NFR USA 03. */
export interface QueueWarning {
  code: QueueFlag;
  inWords: string;
}

/* ------------------------------------------------------------------------ the context */

/** Who is asking. FR 52. */
export interface Asker {
  employeeId: string;
  /** First and last, which is the whole of what a queue wants about a person. */
  name: string;
  jobTitle: string | null;
}

/**
 * What this request would spend, against what the person has. The story's balance context.
 *
 * `available` already has this request's days out of it, and the sentence has to be careful
 * about that: submitting reserved them into `pending`, and approving moves the same days into
 * `taken` and changes `available` by nothing. "Approving this leaves 9" is true; "9 now, 4
 * after" would show the deduction twice.
 */
export interface AskerBalance {
  leaveTypeId: string;
  leaveYearId: string;
  /** Everything granted: entitled, carried over and adjusted. */
  owed: number;
  /** Days already spent on leave that was approved. */
  taken: number;
  /** Days held by requests still being decided — this one among them. */
  pending: number;
  /** What is left, this request's days already held out of it. May be negative. §8.6b. */
  available: number;
  /** NFR USA 03. */
  inWords: string;
}

/** One other person on the team who is away over the same days. FR 20. */
export interface TeamAway {
  employeeId: string;
  /** Their name, or null where this approver has no standing to be told it. {@link TeamContext}. */
  name: string | null;
  from: CalendarDate;
  to: CalendarDate;
  days: number;
  /** `SUBMITTED` or `APPROVED` — asked for, or agreed. Both keep somebody off the desk. */
  status: RequestStatus;
  typeName: string;
}

/**
 * Who else is away, out of how many. The story's team context.
 *
 * The question a manager arrives with is not "may they have the days" — the balance answers
 * that — but *can I spare them that week*. So the team is whoever shares the asker's line
 * manager, and what is reported is their live leave over the same days.
 *
 * Names are shown only where the approver may already read that person's leave, asked per
 * colleague through `leaveRequestPolicy.read`. The manager's desk and the HR desk see them; the
 * Chief Executive, who is nobody's line manager and holds no role, sees the count and no names
 * — which is the half the decision turns on anyway.
 */
export interface TeamContext {
  /** How many people report to the asker's line manager, the asker included. Nought where nobody does. */
  size: number;
  /** Soonest first. */
  away: TeamAway[];
  /** NFR USA 03. */
  inWords: string;
}

/* ------------------------------------------------------------------------- the queue */

/** One request waiting on this approver, with everything the decision needs beside it. */
export interface QueueItem {
  requestId: string;
  asker: Asker;
  leaveTypeId: string;
  typeName: string;
  leaveYearId: string;
  /** Ten characters. NFR DAT 03. */
  from: CalendarDate;
  to: CalendarDate;
  /** What the person said when they asked. FR 10. */
  reason: string;
  /** FR 11. Read off the request, never off the type. */
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  /** FR 24. */
  days: number;
  calendarDays: number;
  submittedAt: Date;

  /** FR 38a. The desk it is sitting on — which is one of this approver's. */
  desk: ApproverRole;
  /** The chain as the type has it now, in order. */
  chain: readonly ApproverRole[];
  /** The stages that have already said yes. FR 41. */
  approvedBy: readonly ApproverRole[];
  /** The stages still to be asked, this one among them. */
  stillToApprove: readonly ApproverRole[];
  /** Where it has got to, said to the approver rather than to the requester. NFR USA 03. */
  stageInWords: string;

  /** FR 17. Calendar days between the asking and the first day off. Negative where backdated. */
  noticeGivenDays: number;
  /** FR 17. Days short of what the type expects, or nought. */
  shortNoticeBy: number;
  /** FR 18. Days the leave had already run when it was asked for, or nought. */
  backdatedBy: number;
  /** Calendar days from today to the first day off. Negative once it has started. */
  startsInDays: number;
  /** The story's third criterion. */
  warnings: QueueWarning[];

  balance: AskerBalance;
  team: TeamContext;

  /** FR 48, §8.6a. False for the approver's own request. The story's second criterion. */
  actionable: boolean;
  /** The policy's own sentence, where it is not. Null where it is. NFR USA 03. */
  notActionableBecause: string | null;

  /** FR 44, §7.2. What the line manager said, where they have decided. LMS 318. */
  managersDecision: ManagersDecision | null;
  /**
   * FR 44. The override deciding this way would be, or null where it overrules nobody.
   *
   * What the two buttons on the screen have to know: pressing them on a request the line
   * manager decided the other way is an override, and an override asks for a justification.
   */
  approvingIs: OverridingAction | null;
  refusingIs: OverridingAction | null;
}

/** What the line manager decided, for the desk about to disagree with them. FR 44, LMS 318. */
export interface ManagersDecision {
  said: DecidingAction;
  /** FR 39. Their reason, which is the thing HR is weighing. */
  comment: string | null;
  /** FR 52. */
  by: string;
  at: Date;
  /** NFR USA 03. */
  inWords: string;
}

/** Everything waiting on one person. */
export interface ApproverQueue {
  approverId: string;
  /** FR 38a. The desks these items came from, so a screen can say which hat is being worn. */
  desks: readonly ApproverRole[];
  /** Soonest to start first. */
  items: QueueItem[];
  /** NFR USA 03. */
  inWords: string;
}

/** Everything a queue is assembled from, all of it read by the caller. As `RequestHistoryFacts`. */
export interface QueueFacts {
  approverId: string;
  staffed: DesksStaffed;
  /** The requests sitting at those desks, from `LeaveRequestRepository.awaiting`. */
  requests: readonly LeaveRequest[];
  /** The people who asked, and their teammates. Keyed by id below. */
  people: readonly Employee[];
  /** Every leave type, for each request's name and its chain as it now stands. */
  types: readonly LeaveType[];
  /** The leave years the requests fall in, for the balance sentence's label. */
  years: readonly LeaveYear[];
  /** FR 41. The decisions already made on those requests. */
  decisions: readonly LeaveDecision[];
  /** The balance for each request's own type and year. Missing keys read as nought. */
  balances: readonly LeaveBalance[];
  /** The live leave the askers' teammates have, from `LeaveRequestRepository.liveOverlapping`. */
  teamLeave: readonly LeaveRequest[];
  /** Today, for {@link QueueItem.startsInDays}. NFR DAT 03. */
  today: CalendarDate;
  /**
   * Whether this approver may be told a colleague's leave. {@link TeamContext}.
   *
   * A predicate, so the policy stays in the layer that owns it and this file stays pure. The
   * service hands over `leaveRequestPolicy.read` asked through `Guard.permits`, which answers
   * without logging — a name withheld from a team line is not a refused attempt.
   */
  mayBeNamed: (colleague: Employee) => boolean;
  /**
   * FR 48. Why this approver may not decide a request, or null where they may.
   *
   * `leaveRequestPolicy.notTheirOwn`'s own answer, handed in rather than re-derived here, so
   * the queue and the approve door cannot disagree about who may decide what.
   */
  whyNotDecidable: (request: LeaveRequest) => string | null;
}

/**
 * The queue, from the facts the service has gathered. FR 20, FR 40, LMS 404.
 *
 * **Own requests are in it.** The story says *never actionable*, and the shape that rules out
 * is a queue that hides them. §8.6a's case is ordinary rather than adversarial — unpaid leave
 * goes to HR first, so an HR Officer's own unpaid leave starts at the desk she staffs, and FR
 * 48b's routing upwards is not built, so it waits there. `docs/domain-rules.md` settles it:
 * *stuck and visible is the side to be wrong on*. Filtering it out would make the one request
 * nobody can move the one request nobody can see, on the screen that exists so nothing sits
 * unnoticed.
 *
 * So it appears, marked `actionable: false`, carrying the policy's own sentence — which names
 * withdrawing, because whoever reads it wanted their leave gone rather than approved.
 *
 * **Soonest to start first**, because what makes a pending request urgent is the leave
 * beginning rather than the request being old. Backdated ones sort to the top by the same rule,
 * which is where they belong: they are the only ones where an answer is already late.
 */
export function queueFor(facts: QueueFacts): ApproverQueue {
  const peopleById = new Map(facts.people.map((person) => [person.id, person] as const));
  const typesById = new Map(facts.types.map((type) => [type.id, type] as const));
  const yearsById = new Map(facts.years.map((year) => [year.id, year] as const));
  const balancesByKey = new Map(facts.balances.map((one) => [keyOf(one), one] as const));

  const decisionsByRequest = new Map<string, LeaveDecision[]>();

  for (const decision of facts.decisions) {
    const collected = decisionsByRequest.get(decision.leaveRequestId);

    if (collected === undefined) {
      decisionsByRequest.set(decision.leaveRequestId, [decision]);
    } else {
      collected.push(decision);
    }
  }

  const items = [...facts.requests].sort(bySoonestToStart).map((request) =>
    itemFor({
      request,
      asker: peopleById.get(request.employeeId),
      type: typesById.get(request.leaveTypeId),
      year: yearsById.get(request.leaveYearId),
      decisions: decisionsByRequest.get(request.id) ?? [],
      balance: balancesByKey.get(keyOf(request)),
      peopleById,
      typesById,
      teamLeave: facts.teamLeave,
      today: facts.today,
      mayBeNamed: facts.mayBeNamed,
      whyNotDecidable: facts.whyNotDecidable,
    }),
  );

  return {
    approverId: facts.approverId,
    desks: [...facts.staffed.desks],
    items,
    inWords: queueInWords(items),
  };
}

/**
 * The queue narrowed to what a line manager turned down. FR 44, §7.2. LMS 318's first criterion.
 *
 * The dedicated view, and it is a narrowing of the approver queue rather than a second
 * screen assembled from its own query — a rejection no longer ends a request, so every one
 * of these is already sitting at HR's desk with the balance and the team beside it. What
 * makes it its own view is that the decision on it is a different one: not "should this
 * leave happen" but "should this manager's answer stand".
 */
export function rejectionsToReview(queue: ApproverQueue): ApproverQueue {
  const items = queue.items.filter((item) => item.approvingIs === 'OVERTURN_REJECTION');

  return { ...queue, items, inWords: rejectionsInWords(items) };
}

/** NFR USA 03. */
function rejectionsInWords(items: readonly QueueItem[]): string {
  if (items.length === 0) {
    return 'No line manager has turned anything down that is waiting on you.';
  }

  const decidable = items.filter((item) => item.actionable).length;
  const held = items.length === 1 ? '1 request' : `${items.length} requests`;

  return (
    `${held} that a line manager turned down and that policy may still allow. ` +
    (decidable === items.length
      ? 'Approving one overturns their decision and asks you why, in writing.'
      : `${decidable} of them are yours to decide.`)
  );
}

/** Soonest to start first, then longest waiting. {@link queueFor}. */
export function bySoonestToStart(left: LeaveRequest, right: LeaveRequest): number {
  if (left.from !== right.from) {
    return left.from < right.from ? -1 : 1;
  }

  return left.submittedAt.getTime() - right.submittedAt.getTime();
}

/**
 * One item, from the facts about one request.
 *
 * A missing type, asker or year gives a reduced item rather than throwing — the same answer
 * `entryFor` gives, unreachable for the same reason. A queue that threw would show none of the
 * other rows, which is the failure this story exists to stop.
 */
function itemFor(input: {
  request: LeaveRequest;
  asker: Employee | undefined;
  type: LeaveType | undefined;
  year: LeaveYear | undefined;
  decisions: readonly LeaveDecision[];
  balance: LeaveBalance | undefined;
  peopleById: ReadonlyMap<string, Employee>;
  typesById: ReadonlyMap<string, LeaveType>;
  teamLeave: readonly LeaveRequest[];
  today: CalendarDate;
  mayBeNamed: (colleague: Employee) => boolean;
  whyNotDecidable: (request: LeaveRequest) => string | null;
}): QueueItem {
  const { request, asker, type, year, decisions, peopleById, today } = input;

  const askerName = asker === undefined ? 'This person' : nameOf(asker);
  const typeName = type?.name ?? 'leave';

  const progress = progressOf({
    request,
    chain: type?.approvalChain ?? [],
    approvedBy: desksThatApproved(decisions),
    refusedBy: desksThatRefused(decisions),
  });

  /* FR 44, §7.2. LMS 318. What the line manager said, and which of this desk's two verbs
     would be overruling them. Both are read from the decisions rather than decided here, so
     the queue and the decide door cannot disagree about what counts as an override. */
  const managers = theManagersDecision(decisions);

  /* FR 17, FR 18. Measured when the request was made rather than as at today, because notice is
     how much warning somebody gave: recomputing it now would shorten it every morning the
     approver did not answer, reporting their own delay as the requester's short notice.
     `startsInDays` is the figure that moves, and it is urgency rather than a judgement. */
  const noticeGivenDays = noticeGiven(dayOf(request.submittedAt), request.from);
  const shortNoticeBy = type === undefined ? 0 : noticeShortfall(type, noticeGivenDays);
  const backdatedBy = Math.max(0, -noticeGivenDays);

  const balance = balanceFor({
    request,
    balance: input.balance,
    typeName,
    askerName,
    yearLabel: year?.label ?? request.leaveYearId,
  });

  const team = teamFor({
    request,
    asker,
    peopleById,
    teamLeave: input.teamLeave,
    /* Every type, not this request's: a colleague away the same week is often away on a
       different kind of leave, and "leave" for all of it loses what a manager reads it for. */
    typesById: input.typesById,
    mayBeNamed: input.mayBeNamed,
  });

  const notActionableBecause = input.whyNotDecidable(request);

  return {
    requestId: request.id,
    asker: {
      employeeId: request.employeeId,
      name: askerName,
      jobTitle: asker?.jobTitle ?? null,
    },
    leaveTypeId: request.leaveTypeId,
    typeName,
    leaveYearId: request.leaveYearId,
    from: request.from,
    to: request.to,
    reason: request.reason,
    countingBasis: request.countingBasis,
    countingBasisLabel: countingBasisLabel(request.countingBasis),
    days: request.days,
    calendarDays: request.calendarDays,
    submittedAt: request.submittedAt,

    /* Not null: every row came back from a query on the desk column, which
       `leave_request_waits_at_a_desk` keeps non-null while a request is being decided. Answered
       rather than asserted, because a throw here would hide every other row. */
    desk: request.awaitingApprovalFrom ?? progress.chain[0] ?? 'MANAGER',
    chain: progress.chain,
    approvedBy: progress.approvedBy,
    stillToApprove: progress.stillToApprove,
    stageInWords: stageInWords(request, progress.approvedBy, progress.stillToApprove, askerName),

    noticeGivenDays,
    shortNoticeBy,
    backdatedBy,
    startsInDays: noticeGiven(today, request.from),
    warnings: flagsFor({ typeName, shortNoticeBy, backdatedBy, noticeGivenDays, type }),

    balance,
    team,

    actionable: notActionableBecause === null,
    notActionableBecause,

    /** FR 44, §7.2. LMS 318. */
    managersDecision:
      managers === undefined
        ? null
        : {
            said: managers.action,
            comment: managers.comment,
            by: managers.decidedBy,
            at: managers.decidedAt,
            inWords: managersDecisionInWords(managers, askerName),
          },
    approvingIs: overrideRequiredFor('APPROVE', decisions),
    refusingIs: overrideRequiredFor('REFUSE', decisions),
  };
}

/** What the line manager did, said to the desk now holding the request. FR 44, NFR USA 03. */
function managersDecisionInWords(managers: LeaveDecision, askerName: string): string {
  const whose = possessively(askerName);

  const said = saysYes(managers.action)
    ? `${managers.decidedBy} approved this at ${whose} line manager’s stage.`
    : `${managers.decidedBy} turned this down at ${whose} line manager’s stage.`;

  const weighing = saysYes(managers.action)
    ? 'Turning it down here overturns that decision, and asks you for a reason in writing.'
    : 'Approving it here overturns that decision, and asks you for a reason in writing.';

  return managers.comment === null ? `${said} ${weighing}` : `${said} ${weighing}`;
}

/* ------------------------------------------------------------------ the sentences */

/** The flags, in the order an approver needs them. FR 17, FR 18. The story's third criterion. */
export function flagsFor(input: {
  typeName: string;
  shortNoticeBy: number;
  backdatedBy: number;
  noticeGivenDays: number;
  type: LeaveType | undefined;
}): QueueWarning[] {
  const { typeName, shortNoticeBy, backdatedBy, noticeGivenDays, type } = input;
  const warnings: QueueWarning[] = [];

  /* FR 18 first, because it is the stronger news. A backdated request is short of notice by
     definition — `noticeShortfall` takes any negative notice as the full shortfall — so the two
     appear together, and the order stops the weaker sentence being the headline. */
  if (backdatedBy > 0) {
    warnings.push({
      code: 'BACKDATED',
      inWords:
        `This leave had already started when it was asked for — it began ${days(backdatedBy)} ` +
        `before the request was made. Recording leave after the fact is allowed within the ` +
        `window ${typeName} sets, and what it means here is that the days have been taken ` +
        `whatever is decided. FR 18.`,
    });
  }

  if (shortNoticeBy > 0) {
    warnings.push({
      code: 'SHORT_NOTICE',
      inWords: shortNoticeInWords(typeName, noticeGivenDays, shortNoticeBy, type),
    });
  }

  return warnings;
}

/**
 * FR 17. What short notice says, and whose judgement it is.
 *
 * Worded close to `quoteFor`'s `SHORT_NOTICE`, because the two are one condition from its two
 * sides: the requester was told "whoever approves it will see that it was short", and this is
 * that person seeing it. It ends by naming the judgement as theirs, or the flag reads as the
 * system having found something wrong.
 */
function shortNoticeInWords(
  typeName: string,
  noticeGivenDays: number,
  shortNoticeBy: number,
  type: LeaveType | undefined,
): string {
  const expected = type?.minNoticeCalendarDays ?? shortNoticeBy;

  return (
    `${typeName} normally wants ${days(expected)}’ notice and this gave ` +
    `${noticeGivenDays < 0 ? 'none — it was asked for after the leave began' : days(noticeGivenDays)}` +
    `, ${days(shortNoticeBy)} short. Short notice is not a reason to refuse on its own; ` +
    `whether it is workable is yours to judge. FR 17.`
  );
}

/**
 * Where the request has got to, said to the approver holding it. FR 41, FR 38a.
 *
 * `progressOf`'s own `inWords` is written to the person whose leave it is — "do not book
 * anything on it" — and every such sentence is about somebody else here. The *reading* is
 * shared, which is `progressOf`; only the voice differs, through `chainInWordsAbout`.
 */
export function stageInWords(
  request: LeaveRequest,
  approvedBy: readonly ApproverRole[],
  stillToApprove: readonly ApproverRole[],
  askerName: string,
): string {
  const whose = possessively(askerName);
  const after = stillToApprove.filter((desk) => desk !== request.awaitingApprovalFrom);

  const signed =
    approvedBy.length === 0
      ? 'Nobody has approved it yet.'
      : `Already approved by ${chainInWordsAbout(approvedBy, whose)}.`;

  const next =
    after.length === 0
      ? 'Yours is the last approval it needs.'
      : `After you it goes to ${chainInWordsAbout(after, whose)}.`;

  return `${signed} ${next}`;
}

/**
 * What this request would spend, against what the person has. §8.6, FR 53.
 *
 * A missing balance reads as nought rather than as an absence, which is `BalanceRepository`'s
 * own answer: a type somebody has never used is a balance of nothing rather than no balance.
 */
export function balanceFor(input: {
  request: LeaveRequest;
  balance: LeaveBalance | undefined;
  typeName: string;
  askerName: string;
  yearLabel: string;
}): AskerBalance {
  const { request, typeName, askerName, yearLabel } = input;

  const balance = input.balance ?? noMovementsYet(balanceKeyOf(request));
  const left = available(balance);
  const granted = owed(balance);

  return {
    leaveTypeId: balance.leaveTypeId,
    leaveYearId: balance.leaveYearId,
    owed: granted,
    taken: balance.taken,
    pending: balance.pending,
    available: left,
    inWords:
      `${days(request.days)} of ${possessively(askerName)} ${granted} days of ${typeName} for ` +
      `${yearLabel}. ${sentenceCase(days(balance.taken))} taken and ${days(committed(balance) - balance.taken)} ` +
      `held while requests are decided — approving this leaves ${days(left)}, which it already ` +
      `counts.` +
      /* §8.6b. A negative figure is legitimate on a type FR 32a lets go past its allowance, and
         an approver seeing one bare would reasonably think something had gone wrong. */
      (left < 0 ? ' The balance is past its allowance, which some kinds of leave allow.' : ''),
  };
}

/**
 * Who else on the team is away over the same days. FR 20. The story's team context.
 *
 * The team is whoever reports to the asker's line manager — counted with them, listed without
 * them. FR 04's one employee has no line manager and so no team, and the sentence says so
 * rather than reporting a team of one.
 *
 * {@link periodsOverlap} is the same predicate FR 15's refusal and `leave_request_never_overlaps`
 * state, asked about two people rather than one. It is asked here rather than in SQL because the
 * query took the whole queue's span in one statement, so this is where each row is narrowed.
 */
export function teamFor(input: {
  request: LeaveRequest;
  asker: Employee | undefined;
  peopleById: ReadonlyMap<string, Employee>;
  teamLeave: readonly LeaveRequest[];
  typesById: ReadonlyMap<string, LeaveType>;
  mayBeNamed: (colleague: Employee) => boolean;
}): TeamContext {
  const { request, asker, peopleById, teamLeave, typesById, mayBeNamed } = input;

  const managerId = asker?.managerId ?? null;

  if (managerId === null) {
    return {
      size: 0,
      away: [],
      inWords:
        'Nobody shares a line manager with this person, so there is no team calendar to ' +
        'check this against.',
    };
  }

  const team = [...peopleById.values()].filter((person) => person.managerId === managerId);
  const teammates = new Set(
    team.map((person) => person.id).filter((id) => id !== request.employeeId),
  );

  const away: TeamAway[] = teamLeave
    .filter(
      (other) =>
        other.id !== request.id &&
        teammates.has(other.employeeId) &&
        periodsOverlap(request, other),
    )
    .sort(bySoonestToStart)
    .map((other) => {
      const colleague = peopleById.get(other.employeeId);

      return {
        employeeId: other.employeeId,
        name: colleague !== undefined && mayBeNamed(colleague) ? nameOf(colleague) : null,
        from: other.from,
        to: other.to,
        days: other.days,
        status: other.status,
        typeName: typesById.get(other.leaveTypeId)?.name ?? 'leave',
      };
    });

  return { size: team.length, away, inWords: teamInWords(team.length, away) };
}

/** The team sentence, which says the count before it says the names. NFR USA 03. */
function teamInWords(size: number, away: readonly TeamAway[]): string {
  const others = size - 1;

  if (away.length === 0) {
    return others <= 0
      ? 'There is nobody else on this team to be away.'
      : `None of the ${String(others)} others on this team is away over these dates.`;
  }

  const counted =
    `${String(away.length)} of the ${String(others)} others on this team ` +
    `${away.length === 1 ? 'is' : 'are'} away over these dates`;

  const named = away
    .filter((one): one is TeamAway & { name: string } => one.name !== null)
    .map(
      (one) =>
        `${one.name} (${formatDay(one.from)} to ${formatDay(one.to)}, ` +
        `${one.status === 'APPROVED' ? 'agreed' : 'asked for and not yet decided'})`,
    );

  return named.length === 0 ? `${counted}.` : `${counted}: ${listOf(named)}.`;
}

/** How many are waiting, said before anything else on the screen. NFR USA 03. */
function queueInWords(items: readonly QueueItem[]): string {
  const decidable = items.filter((item) => item.actionable).length;
  const held = items.length - decidable;

  if (items.length === 0) {
    return 'Nothing is waiting on you.';
  }

  const waiting =
    `${String(items.length)} ${items.length === 1 ? 'request is' : 'requests are'} ` +
    'waiting on you, soonest to start first.';

  /* FR 48, §8.6a. Said in the headline as well as on the card: a queue of one that nobody can
     move is not a queue of one, and the difference is the thing worth knowing. */
  return held === 0
    ? waiting
    : `${waiting} ${String(held)} of ${held === 1 ? 'them is' : 'them are'} your own and ` +
        `${held === 1 ? 'is' : 'are'} for somebody else to decide.`;
}

/* --------------------------------------------------------------------------- helpers */

/** The balance a request was priced against: its own type and its own year, never today's. §5.7. */
export function balanceKeyOf(request: LeaveRequest): BalanceKey {
  return {
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    leaveYearId: request.leaveYearId,
  };
}

/** The three columns a balance is keyed by, as one string a `Map` can hold. */
function keyOf(key: BalanceKey): string {
  return `${key.employeeId}/${key.leaveTypeId}/${key.leaveYearId}`;
}

/** A person, as a queue names them. FR 52. */
function nameOf(person: Employee): string {
  return `${person.firstName} ${person.lastName}`;
}

/** A count with its noun agreeing, as every other sentence in this feature writes it. */
function days(count: number): string {
  return `${String(count)} ${count === 1 ? 'day' : 'days'}`;
}

/** "a, b and c". The team line's own list, said the way a person says one. */
function listOf(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function sentenceCase(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The day an instant fell on, in UTC — the clock `LeaveRequestService.today` reads. NFR DAT 03. */
function dayOf(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}
