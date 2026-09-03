/**
 * What an approver said, and who said it. FR 39, FR 52, §6., LMS 315, LMS 314, LMS 301, NFR AUD 02, FR 45, FR 41, FR 44, §7.2, LMS 318.
 */

import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { RequestAction } from './leave-request.js';

/** The verbs that are a decision at a desk. FR 39, FR 44, LMS 315, LMS 318. */
export const DECIDING_ACTIONS = [
  'APPROVE',
  'REFUSE',
  'OVERTURN_REJECTION',
  'OVERTURN_APPROVAL',
] as const;

export type DecidingAction = (typeof DECIDING_ACTIONS)[number];

/** The two that reverse a decision somebody else made. FR 44, §7.2, LMS 318. */
export const OVERRIDING_ACTIONS = ['OVERTURN_REJECTION', 'OVERTURN_APPROVAL'] as const;

export type OverridingAction = (typeof OVERRIDING_ACTIONS)[number];

/** The two that answer a stage of the chain. FR 41, FR 44, LMS 318. */
export const ANSWERING_ACTIONS: readonly DecidingAction[] = ['APPROVE', 'OVERTURN_REJECTION'];

/** The three that are owed a reason in writing. FR 39, FR 44. */
export const ACTIONS_THAT_SAY_WHY: readonly DecidingAction[] = [
  'REFUSE',
  'OVERTURN_REJECTION',
  'OVERTURN_APPROVAL',
];

/** Whether this verb is somebody at a desk deciding, rather than a request being unwound. */
export function isADecision(action: RequestAction): action is DecidingAction {
  return (DECIDING_ACTIONS as readonly RequestAction[]).includes(action);
}

/** Whether this verb reverses a decision already on the record. FR 44. */
export function isAnOverride(action: RequestAction): action is OverridingAction {
  return (OVERRIDING_ACTIONS as readonly RequestAction[]).includes(action);
}

/** Whether this verb says yes, first time or by overturning a rejection. FR 41, FR 44. */
export function saysYes(action: DecidingAction): boolean {
  return ANSWERING_ACTIONS.includes(action);
}

/** Which verb an override reverses: a rejection, or an approval. FR 44. */
export function reverses(action: OverridingAction): DecidingAction {
  return action === 'OVERTURN_REJECTION' ? 'REFUSE' : 'APPROVE';
}

/** A refusal with nothing said about it. FR 39, NFR USA 03, LMS 315. */
export class RefusalNeedsAComment extends Error {
  /** FR 39. */
  readonly code = 'REFUSAL_NEEDS_A_COMMENT';
  /** NFR USA 03. */
  readonly field = 'comment';

  constructor() {
    super(
      'Turning leave down says why. Whoever asked for it is owed the reason in writing — ' +
        'it is what they will act on, and it is the only account of this decision that ' +
        'will exist when somebody asks about it next year. Approving needs no comment; ' +
        'refusing does.',
    );
    this.name = 'RefusalNeedsAComment';
  }
}

/** A decision the record cannot hold. NFR USA 03, FR 44. */
export class InvalidDecision extends Error {
  readonly code = 'INVALID_DECISION';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecision';
  }
}

/** An override with nothing said about it. FR 44, §7.2, LMS 318. */
export class OverrideNeedsAJustification extends Error {
  /** FR 44. */
  readonly code = 'OVERRIDE_NEEDS_A_JUSTIFICATION';
  /** NFR USA 03. */
  readonly field = 'justification';

  constructor() {
    super(
      'Overturning a line manager’s decision says why, in writing. It is what the manager ' +
        'whose decision is being reversed will read, what the person who asked for the ' +
        'leave is owed, and the only account of why policy prevailed over a local ' +
        'decision that will exist when somebody asks next year. FR 44.',
    );
    this.name = 'OverrideNeedsAJustification';
  }
}

/** What is written down, once the rules about the comment have been applied. */
export interface ValidatedDecision {
  leaveRequestId: string;
  action: DecidingAction;
  /** FR 52. */
  onBehalfOf: ApproverRole;
  /** Required of a refusal and of an override, null on an approval that said nothing. */
  comment: string | null;
  /** The refusal this overturns; set exactly on an override. FR 44, LMS 318. */
  overridesDecisionId: string | null;
}

/** A decision as it comes back out. */
export interface LeaveDecision {
  id: string;
  leaveRequestId: string;
  action: DecidingAction;
  /** FR 52. */
  onBehalfOf: ApproverRole;
  comment: string | null;
  /** FR 44, LMS 318. */
  overridesDecisionId: string | null;
  /** Who, in words. */
  decidedBy: string;
  /** Who, as an id to join on. */
  decidedByEmployeeId: string | null;
  decidedAt: Date;
}

/** The reason a refusal has to carry. FR 39. */
export function requireAComment(value: unknown): string {
  const said = readComment(value);

  if (said === null) {
    throw new RefusalNeedsAComment();
  }

  return said;
}

/** The justification an override has to carry. FR 44. */
export function requireAJustification(value: unknown): string {
  const said = readComment(value);

  if (said === null) {
    throw new OverrideNeedsAJustification();
  }

  return said;
}

/** The reason an approval may carry, or nothing. */
export function readComment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const said = value.trim();

  return said === '' ? null : said;
}

/** Checks a decision on its way to being written, and applies the rules about the comment. */
export function validateDecision(input: {
  leaveRequestId: string;
  action: DecidingAction;
  onBehalfOf: ApproverRole;
  comment: unknown;
  /** FR 44. The decision being reversed, on an override and on nothing else. */
  overridesDecisionId?: string | null;
}): ValidatedDecision {
  const overriding = isAnOverride(input.action);
  const overturns = input.overridesDecisionId ?? null;

  /* An equivalence, held here and by `leave_request_decision_override_names_what_it_
     reverses` on every connection: an override without the decision it reverses is a
     record of nothing, and a pointer on an ordinary approval is a claim it did not make. */
  if (overriding !== (overturns !== null)) {
    throw new InvalidDecision(
      overriding
        ? 'An override names the decision it reverses. FR 44.'
        : `A ${input.action.toLowerCase()} decides a request for the first time and ` +
            `reverses nothing. FR 44.`,
    );
  }

  return {
    leaveRequestId: input.leaveRequestId,
    action: input.action,
    onBehalfOf: input.onBehalfOf,
    comment: commentFor(input.action, input.comment),
    overridesDecisionId: overturns,
  };
}

/** The reason this verb is owed, where it is owed one. FR 39, FR 44. */
function commentFor(action: DecidingAction, value: unknown): string | null {
  if (!ACTIONS_THAT_SAY_WHY.includes(action)) {
    return readComment(value);
  }

  return action === 'REFUSE' ? requireAComment(value) : requireAJustification(value);
}

/** The refusal among a request's decisions, where there is one. LMS 201, LMS 301, FR 45. */
export function theRefusal(decisions: readonly LeaveDecision[]): LeaveDecision | undefined {
  return decisions.find((decision) => decision.action === 'REFUSE');
}

/** The desks that have said yes to this request. FR 41, FR 44, LMS 316, LMS 318, FR 31. */
export function desksThatApproved(decisions: readonly LeaveDecision[]): ApproverRole[] {
  return decisions.filter((decision) => saysYes(decision.action)).map((one) => one.onBehalfOf);
}

/** The desks that have said no to this request. FR 44, LMS 318. */
export function desksThatRefused(decisions: readonly LeaveDecision[]): ApproverRole[] {
  return decisions.filter((decision) => !saysYes(decision.action)).map((one) => one.onBehalfOf);
}

/** The desks that have had their say, whichever way they went. FR 44, LMS 318. */
export function desksThatDecided(decisions: readonly LeaveDecision[]): ApproverRole[] {
  return decisions.map((decision) => decision.onBehalfOf);
}

/** Whether an override has already reversed this decision. FR 44, LMS 318. */
export function wasOverturned(
  decision: LeaveDecision,
  decisions: readonly LeaveDecision[],
): boolean {
  return decisions.some((other) => other.overridesDecisionId === decision.id);
}

/**
 * The line manager's decision this kind of override reverses, where one still stands. FR 44, §7.2. LMS 318.
 *
 * The `MANAGER` desk and no other: FR 44 is HR overruling a local decision, and a
 * judgement made at HR's own stage or the Chief Executive's is not one HR overrules.
 */
export function theManagersDecisionReversedBy(
  action: OverridingAction,
  decisions: readonly LeaveDecision[],
): LeaveDecision | undefined {
  const reversed = reverses(action);

  return decisions.find(
    (decision) =>
      decision.onBehalfOf === 'MANAGER' &&
      decision.action === reversed &&
      !wasOverturned(decision, decisions),
  );
}

/** What the line manager said about this request, where they have said anything. FR 44. */
export function theManagersDecision(
  decisions: readonly LeaveDecision[],
): LeaveDecision | undefined {
  return decisions.find((decision) => decision.onBehalfOf === 'MANAGER');
}

/**
 * The override this plain verb would have to be, or null where it contradicts nobody. FR 44, §7.2. LMS 318.
 *
 * What makes the justification mandatory rather than offered: a desk about to decide the
 * opposite way to the line manager is overruling them whether it calls itself that or not.
 */
export function overrideRequiredFor(
  action: DecidingAction,
  decisions: readonly LeaveDecision[],
): OverridingAction | null {
  const managers = theManagersDecision(decisions);

  if (managers === undefined || saysYes(managers.action) === saysYes(action)) {
    return null;
  }

  return saysYes(action) ? 'OVERTURN_REJECTION' : 'OVERTURN_APPROVAL';
}

/** Every override on a request, oldest first. FR 44, NFR AUD 02. */
export function theOverrides(decisions: readonly LeaveDecision[]): LeaveDecision[] {
  return decisions.filter((decision) => isAnOverride(decision.action));
}
