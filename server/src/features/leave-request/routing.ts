/**
 * Where a request goes when the desk its chain names cannot decide it. FR 48, FR 48b, FR 48c, FR 48d, FR 04, §8.6a, LMS 320, LMS 321, LMS 322.
 */

import { type ApproverRole, APPROVER_ROLES, deskInWords } from '../leave-type/approval-chain.js';

/** What a desk amounts to for one particular request. FR 48, FR 48b. */
export const DESK_STANDINGS = ['CAN_DECIDE', 'ONLY_THE_REQUESTER', 'NOBODY_STAFFS_IT'] as const;

export type DeskStanding = (typeof DESK_STANDINGS)[number];

/**
 * The same, once who has already decided this request is known. FR 48d, LMS 322.
 *
 * Staffed, and by nobody but a hand already on this request. Outside {@link DESK_STANDINGS}
 * because {@link standingOf} cannot see it: it is a fact about a request.
 */
export type DeskStandingNow = DeskStanding | 'ALREADY_DECIDED_IT';

/** Who can be asked at each desk, for one request. FR 38a, FR 48b. */
export type DesksAvailable = Readonly<Record<ApproverRole, DeskStanding>>;

/** Who is at each desk who could decide this request: the requester excluded. FR 48d, LMS 322. */
export type DeskOccupants = Readonly<Record<ApproverRole, readonly string[]>>;

/** One desk that has decided, and who decided at it. FR 44, FR 48d, LMS 322. */
export interface DeskDecision {
  desk: ApproverRole;
  /** Null where nothing named them — a job, a migration, a seed. */
  by: string | null;
}

/** Nobody is at any desk, because nobody has decided yet. FR 48d, LMS 322. */
export const NO_OCCUPANTS_NAMED: DeskOccupants = { MANAGER: [], HR: [], CEO: [] };

/**
 * Who answers for a desk that cannot answer for itself. FR 48b, §8.6a, §4.3.1.
 *
 * Written out rather than derived from an ordering, because the third entry points
 * downwards: there is nobody above the Chief Executive to fall to.
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
  | {
      kind: 'DECIDED';
      skips: readonly SkippedStage[];
      /** FR 48d. One named person answered a chain that asked for more than one. LMS 322. */
      singleApprover: boolean;
    }
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
  /** The desks that have decided and who decided at each, whichever way they went. FR 44, FR 48d. */
  decided: readonly DeskDecision[];
  /** The stages already skipped, as recorded against the request. */
  skipped: readonly SkippedStage[];
  available: DesksAvailable;
  /** FR 48d. Who could still be asked at each desk. LMS 322. */
  occupants: DeskOccupants;
}

/** Whether somebody other than the requester answers there. */
export function canDecide(available: DesksAvailable, desk: ApproverRole): boolean {
  return available[desk] === 'CAN_DECIDE';
}

/** Whether that desk has had its say. FR 44. */
function hasDecided(decided: readonly DeskDecision[], desk: ApproverRole): boolean {
  return decided.some((one) => one.desk === desk);
}

/** Whether that person has already decided this request. FR 48d, LMS 322. */
export function decidedBy(decided: readonly DeskDecision[], who: string): boolean {
  return decided.some((one) => one.by === who);
}

/**
 * The desk this request goes to, skipping every stage nobody can answer. FR 38a, FR 48, FR 48b, FR 48d, FR 41, §8.6a.
 *
 * A recorded skip is never reconsidered — the same rule LMS 316 gives a decision — so a
 * stage passed on Monday is not re-asked because somebody was hired on Wednesday.
 *
 * It stops at the first stage nobody can answer rather than looking ahead, and `DECIDED` is
 * reached only by stages deciding. Running out of desks that can be filled never approves
 * anything.
 *
 * Since LMS 322 it knows who is at a desk as well as whether anybody is: a stage its own
 * people have already decided goes to a second officer where the company has one, and where
 * it has none the stage falls to the desk that hand signed at and the request is `DECIDED` by
 * a single approver. FR 48d.
 */
export function routeFrom(question: RoutingQuestion): Routed {
  const { chain, decided, skipped } = question;

  const answeredBy = new Map<ApproverRole, ApproverRole>(
    skipped.map((skip) => [skip.stage, skip.routedTo]),
  );

  const skips: SkippedStage[] = [];

  for (const stage of chain) {
    const desk = answeredBy.get(stage) ?? answeringFor(stage, question);

    if (desk === undefined) {
      return {
        kind: 'UNROUTABLE',
        stranded: stage,
        because: skipInWords(stage, null, standingNow(stage, question)),
        skips,
      };
    }

    if (desk !== stage && !answeredBy.has(stage)) {
      skips.push({
        stage,
        routedTo: desk,
        because: skipInWords(stage, desk, standingNow(stage, question)),
      });
      answeredBy.set(stage, desk);
    }

    if (!hasDecided(decided, desk)) {
      return { kind: 'DESK', desk, skips };
    }

    /* A desk that has already decided answers this stage too, so a chain whose stages
       collapse onto one desk asks that person once. */
  }

  return { kind: 'DECIDED', skips, singleApprover: decidedBySingleApprover(chain, decided) };
}

/**
 * The desk that answers a stage: itself, its stand-in, the desk that hand signed at, or
 * nobody. FR 48b, FR 48d.
 *
 * The order is the rule: a desk that has decided, then either desk with somebody left to ask
 * — FR 48d's second officer — and only then a desk whose people have all signed already.
 */
function answeringFor(stage: ApproverRole, question: RoutingQuestion): ApproverRole | undefined {
  const standIn = STAND_IN_FOR[stage];

  if (hasDecided(question.decided, stage)) {
    return stage;
  }

  for (const desk of [stage, standIn]) {
    if (desk !== null && standingNow(desk, question) === 'CAN_DECIDE') {
      return desk;
    }
  }

  /** FR 48d. Nobody new to ask, so the stage falls to the desk that hand signed at. LMS 322. */
  for (const desk of [stage, standIn]) {
    if (desk !== null && standingNow(desk, question) === 'ALREADY_DECIDED_IT') {
      return whereTheyDecided(desk, question);
    }
  }

  return undefined;
}

/** What a desk amounts to for this request, once who has decided it is known. FR 48b, FR 48d. */
function standingNow(desk: ApproverRole, question: RoutingQuestion): DeskStandingNow {
  const standing = question.available[desk];

  if (standing !== 'CAN_DECIDE') {
    return standing;
  }

  const there = question.occupants[desk];

  /* Empty is the caller having no person to name rather than an empty desk — `available`
     has just said somebody is there — so it routes as LMS 320 always did. */
  return there.length > 0 && there.every((who) => decidedBy(question.decided, who))
    ? 'ALREADY_DECIDED_IT'
    : 'CAN_DECIDE';
}

/** The desk somebody at this one already decided at. FR 48d, LMS 322. */
function whereTheyDecided(desk: ApproverRole, question: RoutingQuestion): ApproverRole | undefined {
  return question.decided.find(
    (one) => one.by !== null && question.occupants[desk].includes(one.by),
  )?.desk;
}

/** Whether one named hand answered a chain that asked for more than one. FR 48d, LMS 322. */
function decidedBySingleApprover(
  chain: readonly ApproverRole[],
  decided: readonly DeskDecision[],
): boolean {
  const [first] = decided;

  return (
    chain.length > 1 &&
    first !== undefined &&
    first.by !== null &&
    decided.every((one) => one.by === first.by)
  );
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

/** Why a stage was skipped and where it went, in one sentence. NFR USA 03, FR 48b, FR 48d. */
export function skipInWords(
  stage: ApproverRole,
  routedTo: ApproverRole | null,
  standing: DeskStandingNow,
): string {
  const desk = sentenceCase(deskInWords(stage));
  const because = deskCannotDecideReason(stage, standing);

  return routedTo === null
    ? `${desk} could not decide this request — ${because} — and neither could ` +
        `${deskInWords(STAND_IN_FOR[stage] ?? stage)}, so there is nobody left to ask. FR 48b.`
    : `${desk} could not decide this request — ${because} — so this stage went to ` +
        `${deskInWords(routedTo)} instead. Nobody approved it on the way. FR 48b.`;
}

/** What is empty about a desk. FR 04, FR 48, FR 48b, FR 48c, FR 48d. */
function deskCannotDecideReason(stage: ApproverRole, standing: DeskStandingNow): string {
  /** FR 48, LMS 319. Staffed, and by the one person who may never answer at it. */
  if (standing === 'ONLY_THE_REQUESTER') {
    return (
      'the only person at that desk is the one who asked for the leave, and nobody ' +
      'decides their own request'
    );
  }

  /** FR 48d, LMS 322. Staffed, and by nobody but a hand already on this request. */
  if (standing === 'ALREADY_DECIDED_IT') {
    return (
      'everybody at that desk has already decided this request at an earlier stage, and ' +
      'one person does not approve the same leave twice'
    );
  }

  switch (stage) {
    case 'MANAGER':
      /** FR 04. */
      return 'they have no manager, which is what being at the top of the reporting lines is';
    case 'HR':
      return 'nobody holds an HR role';
    default:
      /* FR 48c. Both halves, because a desk that nobody staffs cannot tell them apart and
         the fix differs: name somebody, or name their successor. LMS 321. */
      return (
        'the organisation names no Chief Executive in its settings, or the person it ' +
        'names has left'
      );
  }
}

/** What would move an unroutable request, for the alert. FR 48b, NFR USA 03. */
export function whatWouldRouteIt(stranded: ApproverRole, available: DesksAvailable): string {
  const standIn = STAND_IN_FOR[stranded];

  const fixes = [deskCannotDecideRemedy(stranded, available[stranded])].concat(
    standIn === null ? [] : [deskCannotDecideRemedy(standIn, available[standIn])],
  );

  return `Either would move it: ${fixes.join(', or ')}.`;
}

/** The one change that would fill a desk. FR 04, FR 48b, FR 48c. */
function deskCannotDecideRemedy(desk: ApproverRole, standing: DeskStanding): string {
  if (standing === 'ONLY_THE_REQUESTER') {
    return desk === 'CEO'
      ? 'the organisation’s settings naming somebody other than the person who asked as ' +
          'the Chief Executive'
      : `somebody other than the person who asked staffing ${deskInWords(desk)}`;
  }

  switch (desk) {
    case 'MANAGER':
      return 'giving them a manager';
    case 'HR':
      return 'granting somebody an HR role';
    default:
      /** FR 48c, LMS 321. A setting an HR Administrator writes, never a job title. */
      return (
        'an HR Administrator naming a current employee as the Chief Executive in the ' +
        'organisation’s settings'
      );
  }
}

/** Every desk answered, so a caller building one cannot omit a desk. FR 38a. */
export function desksAvailable(standingAt: (desk: ApproverRole) => DeskStanding): DesksAvailable {
  return Object.fromEntries(
    APPROVER_ROLES.map((desk) => [desk, standingAt(desk)]),
  ) as DesksAvailable;
}

/** Every desk answered, as {@link desksAvailable} is. FR 48d, LMS 322. */
export function deskOccupants(peopleAt: (desk: ApproverRole) => readonly string[]): DeskOccupants {
  return Object.fromEntries(APPROVER_ROLES.map((desk) => [desk, peopleAt(desk)])) as DeskOccupants;
}

/** Who at a desk could decide this request. The requester never can. FR 48, FR 48d. */
export function whoCouldDecide(occupants: readonly string[], requesterId: string): string[] {
  return occupants.filter((id) => id !== requesterId);
}

/** One desk's standing, from who is there and who may not answer. FR 48, FR 48b. */
export function standingOf(occupants: readonly string[], requesterId: string): DeskStanding {
  if (occupants.length === 0) {
    return 'NOBODY_STAFFS_IT';
  }

  return occupants.some((id) => id !== requesterId) ? 'CAN_DECIDE' : 'ONLY_THE_REQUESTER';
}

function sentenceCase(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
