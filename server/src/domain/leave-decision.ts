/**
 * What an approver said, and who said it. FR 39, FR 52, §6., LMS 315, LMS 314, LMS 301, NFR AUD 02, FR 45, FR 41.
 */

import type { ApproverRole } from './approval-chain.js';
import type { RequestAction } from './leave-request.js';

/** The two verbs that are a decision at a desk. FR 39, LMS 315, FR 26. */
export const DECIDING_ACTIONS = ['APPROVE', 'REFUSE'] as const;

export type DecidingAction = (typeof DECIDING_ACTIONS)[number];

/** Whether this verb is somebody at a desk deciding, rather than a request being unwound. */
export function isADecision(action: RequestAction): action is DecidingAction {
  return (DECIDING_ACTIONS as readonly RequestAction[]).includes(action);
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

/** What is written down, once the two rules about the comment have been applied. */
export interface ValidatedDecision {
  leaveRequestId: string;
  action: DecidingAction;
  /** FR 52. */
  onBehalfOf: ApproverRole;
  /** Required of a refusal, null on an approval that said nothing. */
  comment: string | null;
}

/** A decision as it comes back out. */
export interface LeaveDecision {
  id: string;
  leaveRequestId: string;
  action: DecidingAction;
  /** FR 52. */
  onBehalfOf: ApproverRole;
  comment: string | null;
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

/** The reason an approval may carry, or nothing. */
export function readComment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const said = value.trim();

  return said === '' ? null : said;
}

/** Checks a decision on its way to being written, and applies the rule about the comment. */
export function validateDecision(input: {
  leaveRequestId: string;
  action: DecidingAction;
  onBehalfOf: ApproverRole;
  comment: unknown;
}): ValidatedDecision {
  return {
    leaveRequestId: input.leaveRequestId,
    action: input.action,
    onBehalfOf: input.onBehalfOf,
    comment:
      input.action === 'REFUSE' ? requireAComment(input.comment) : readComment(input.comment),
  };
}

/** The refusal among a request's decisions, where there is one. LMS 201, LMS 301, FR 45. */
export function theRefusal(decisions: readonly LeaveDecision[]): LeaveDecision | undefined {
  return decisions.find((decision) => decision.action === 'REFUSE');
}

/** The desks that have said yes to this request. FR 41, LMS 316, FR 31. */
export function desksThatApproved(decisions: readonly LeaveDecision[]): ApproverRole[] {
  return decisions
    .filter((decision) => decision.action === 'APPROVE')
    .map((decision) => decision.onBehalfOf);
}
