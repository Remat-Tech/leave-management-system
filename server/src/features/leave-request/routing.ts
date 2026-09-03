/**
 * Where a request goes when the desk its chain names cannot decide it. FR 48, FR 48b, FR 04, §8.6a, LMS 320.
 */

import { type ApproverRole, APPROVER_ROLES, deskInWords } from '../leave-type/approval-chain.js';

/** What a desk amounts to for one particular request. FR 48, FR 48b. */
export const DESK_STANDINGS = ['CAN_DECIDE', 'ONLY_THE_REQUESTER', 'NOBODY_STAFFS_IT'] as const;

export type DeskStanding = (typeof DESK_STANDINGS)[number];

/** Who can be asked at each desk, for one request. FR 38a, FR 48b. */
export type DesksAvailable = Readonly<Record<ApproverRole, DeskStanding>>;

/**
 * Who answers for a desk that cannot answer for itself. FR 48b, §8.6a, §4.3.1.
 *
 * Written out rather than derived from an ordering, because the third entry points
 * downwards: there is nothing above FR 04's root.
 */
export const STAND_IN_FOR: Readonly<Record<ApproverRole, ApproverRole | null>> = {
  MANAGER: 'HR',
  HR: 'CEO',
  CEO: 'HR',
};

/**
 * One stage the chain named that another desk answered. FR 48b.
 *
 * A stage that went *nowhere* is not one of these: it is where the request stopped, and it
 * is recorded as the `UNROUTABLE` status and the alert rather than as a skip. Keeping it out
 * of here is what lets a re-route reconsider it once somebody is at the desk — a recorded
 * skip is never reconsidered, and a stage nobody ever answered has not been dealt with.
 */
export interface SkippedStage {
  stage: ApproverRole;
  /** The desk that took it instead. */
  routedTo: ApproverRole;
  /** NFR USA 03. */
  because: string;
}

/** Where a request goes next, and what had to be skipped on the way. FR 48b. */
export type Routed =
  | { kind: 'DESK'; desk: ApproverRole; skips: readonly SkippedStage[] }
  /** Every stage has had its say, so the decision just made is the last word. FR 41, FR 44. */
  | { kind: 'DECIDED'; skips: readonly SkippedStage[] }
  /** Neither this stage's desk nor its stand-in can be asked. FR 48b. */
  | {
      kind: 'UNROUTABLE';
      stranded: ApproverRole;
      /** NFR USA 03. What the alert says. */
      because: string;
      skips: readonly SkippedStage[];
    };

export interface RoutingQuestion {
  /** FR 38a. The type's chain as it stands now. */
  chain: readonly ApproverRole[];
  /** The desks that have decided, whichever way they went. FR 44. */
  decided: readonly ApproverRole[];
  /** The stages already skipped, as recorded against the request. */
  skipped: readonly SkippedStage[];
  available: DesksAvailable;
}

/** Whether somebody other than the requester answers there. */
export function canDecide(available: DesksAvailable, desk: ApproverRole): boolean {
  return available[desk] === 'CAN_DECIDE';
}

/**
 * The desk this request goes to, skipping every stage nobody can answer. FR 38a, FR 48, FR 48b, FR 41, §8.6a.
 *
 * A recorded skip is never reconsidered — the same rule LMS 316 gives a decision — so a
 * stage passed on Monday is not re-asked because somebody was hired on Wednesday.
 *
 * It stops at the first stage nobody can answer rather than looking ahead, and `DECIDED` is
 * reached only by stages deciding. Running out of desks that can be filled never approves
 * anything.
 */
export function routeFrom(question: RoutingQuestion): Routed {
  const { chain, decided, skipped, available } = question;

  const answeredBy = new Map<ApproverRole, ApproverRole>(
    skipped.map((skip) => [skip.stage, skip.routedTo]),
  );

  const skips: SkippedStage[] = [];

  for (const stage of chain) {
    const desk = answeredBy.get(stage) ?? standingAt(stage, available);

    if (desk === undefined) {
      return {
        kind: 'UNROUTABLE',
        stranded: stage,
        because: skipInWords(stage, null, available),
        skips,
      };
    }

    if (desk !== stage && !answeredBy.has(stage)) {
      skips.push({ stage, routedTo: desk, because: skipInWords(stage, desk, available) });
      answeredBy.set(stage, desk);
    }

    if (!decided.includes(desk)) {
      return { kind: 'DESK', desk, skips };
    }

    /* A desk that has already decided answers this stage too, so a chain whose stages
       collapse onto one desk asks that person once. */
  }

  return { kind: 'DECIDED', skips };
}

/** The desk that answers a stage: itself, its stand-in, or nobody. FR 48b. */
function standingAt(stage: ApproverRole, available: DesksAvailable): ApproverRole | undefined {
  if (canDecide(available, stage)) {
    return stage;
  }

  const standIn = STAND_IN_FOR[stage];

  return standIn !== null && canDecide(available, standIn) ? standIn : undefined;
}

/**
 * The desks this request will actually be asked at. FR 38a, FR 48b.
 *
 * The type's chain with every recorded skip substituted in, deduplicated in order. What
 * `ApprovalChainChanged` and `progressOf` read, because a request that fell to a stand-in is
 * standing at a desk its type's chain does not name.
 */
export function desksAsked(
  chain: readonly ApproverRole[],
  skipped: readonly SkippedStage[],
): ApproverRole[] {
  const answeredBy = new Map<ApproverRole, ApproverRole>(
    skipped.map((skip) => [skip.stage, skip.routedTo]),
  );

  const asked: ApproverRole[] = [];

  for (const stage of chain) {
    const desk = answeredBy.get(stage) ?? stage;

    if (!asked.includes(desk)) {
      asked.push(desk);
    }
  }

  return asked;
}

/** The stages of this chain that went somewhere else, in chain order. FR 48b. */
export function stagesSkipped(
  chain: readonly ApproverRole[],
  skipped: readonly SkippedStage[],
): SkippedStage[] {
  return chain.flatMap((stage) => skipped.filter((skip) => skip.stage === stage));
}

/** Why a stage was skipped and where it went, in one sentence. NFR USA 03, FR 48b. */
export function skipInWords(
  stage: ApproverRole,
  routedTo: ApproverRole | null,
  available: DesksAvailable,
): string {
  const desk = sentenceCase(deskInWords(stage));
  const because = whyNot(stage, available[stage]);

  return routedTo === null
    ? `${desk} could not decide this request — ${because} — and neither could ` +
        `${deskInWords(STAND_IN_FOR[stage] ?? stage)}, so there is nobody left to ask. FR 48b.`
    : `${desk} could not decide this request — ${because} — so this stage went to ` +
        `${deskInWords(routedTo)} instead. Nobody approved it on the way. FR 48b.`;
}

/** What is empty about a desk. FR 04, FR 48, FR 48b. */
function whyNot(stage: ApproverRole, standing: DeskStanding): string {
  /** FR 48, LMS 319. Staffed, and by the one person who may never answer at it. */
  if (standing === 'ONLY_THE_REQUESTER') {
    return (
      'the only person at that desk is the one who asked for the leave, and nobody ' +
      'decides their own request'
    );
  }

  switch (stage) {
    case 'MANAGER':
      /** FR 04. */
      return 'they have no line manager, which is what the head of the organisation is';
    case 'HR':
      return 'nobody holds an HR role';
    default:
      return 'there is no employee without a line manager, so FR 04’s seat is empty';
  }
}

/** What would move an unroutable request, for the alert. FR 48b, NFR USA 03. */
export function whatWouldRouteIt(stranded: ApproverRole, available: DesksAvailable): string {
  const standIn = STAND_IN_FOR[stranded];

  const fixes = [remedyFor(stranded, available[stranded])].concat(
    standIn === null ? [] : [remedyFor(standIn, available[standIn])],
  );

  return `Either would move it: ${fixes.join(', or ')}.`;
}

/** The one change that would fill a desk. FR 04, FR 48b. */
function remedyFor(desk: ApproverRole, standing: DeskStanding): string {
  if (standing === 'ONLY_THE_REQUESTER') {
    return desk === 'CEO'
      ? 'somebody other than the person who asked holding FR 04’s seat'
      : `somebody other than the person who asked staffing ${deskInWords(desk)}`;
  }

  switch (desk) {
    case 'MANAGER':
      return 'giving them a line manager';
    case 'HR':
      return 'granting somebody an HR role';
    default:
      return 'an employee record with no line manager, which is FR 04’s head of the organisation';
  }
}

/** Every desk answered, so a caller building one cannot omit a desk. FR 38a. */
export function desksAvailable(standingAt: (desk: ApproverRole) => DeskStanding): DesksAvailable {
  return Object.fromEntries(
    APPROVER_ROLES.map((desk) => [desk, standingAt(desk)]),
  ) as DesksAvailable;
}

/** One desk's standing, from who is there and who may not answer. FR 48, FR 48b. */
export function standingOf(whoIsThere: readonly string[], requesterId: string): DeskStanding {
  if (whoIsThere.length === 0) {
    return 'NOBODY_STAFFS_IT';
  }

  return whoIsThere.some((id) => id !== requesterId) ? 'CAN_DECIDE' : 'ONLY_THE_REQUESTER';
}

function sentenceCase(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
