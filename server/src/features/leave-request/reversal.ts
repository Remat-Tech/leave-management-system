/** The Chief Executive reversing a request every desk has finished deciding. */

import {
  InvalidLeaveRequest,
  type LeaveRequest,
  type RequestAction,
  type RequestStatus,
  transitionFor,
} from './leave-request.js';
import type { CalendarDate } from '../../shared/time.js';

export const REVERSAL_ACTIONS = ['REVERSE_APPROVAL', 'REVERSE_REFUSAL'] as const;

export type ReversalAction = (typeof REVERSAL_ACTIONS)[number];

export function isAReversal(action: RequestAction): action is ReversalAction {
  return (REVERSAL_ACTIONS as readonly RequestAction[]).includes(action);
}

/** What the caller supplies to record one. */
export interface NewReversal {
  leaveRequestId: string;
  action: ReversalAction;
  reason: string;
}

/** One as it comes back out. FR 52. */
export interface Reversal extends NewReversal {
  id: string;
  recordedBy: string;
  recordedByEmployeeId: string | null;
  recordedAt: Date;
}

/* ------------------------------------------------------------------- refusals */

export class ReversalNeedsAReason extends Error {
  readonly code = 'REVERSAL_NEEDS_A_REASON';
  readonly field = 'reason';

  constructor() {
    super(
      'Reversing a decision says why, in writing. The person whose leave it is, their ' +
        'manager and HR all read it.',
    );
    this.name = 'ReversalNeedsAReason';
  }
}

/** A request still being decided, or one that was withdrawn or cancelled. */
export class NothingToReverse extends Error {
  readonly code = 'NOTHING_TO_REVERSE';
  readonly leaveRequestId: string;

  constructor(request: LeaveRequest) {
    super(
      request.status === 'SUBMITTED' || request.status === 'UNROUTABLE'
        ? 'This request has not been fully decided yet, so there is no outcome to reverse.'
        : 'This request was taken back or cancelled, so there is no decision to reverse.',
    );
    this.name = 'NothingToReverse';
    this.leaveRequestId = request.id;
  }
}

export class AlreadyReversed extends Error {
  readonly code = 'ALREADY_REVERSED';
  readonly leaveRequestId: string;

  constructor(leaveRequestId: string) {
    super('This decision has already been reversed once, and a reversal is final.');
    this.name = 'AlreadyReversed';
    this.leaveRequestId = leaveRequestId;
  }
}

/** HR still has to answer the person's own ask about this leave. FR 47. */
export class AnAskIsOpen extends Error {
  readonly code = 'AN_ASK_IS_OPEN';
  readonly leaveRequestId: string;

  constructor(leaveRequestId: string) {
    super(
      'The person has asked for this leave to be cancelled and HR has not answered yet. ' +
        'Let HR answer that first, so there are not two decisions about the same leave.',
    );
    this.name = 'AnAskIsOpen';
    this.leaveRequestId = leaveRequestId;
  }
}

/** Approved leave that has started. Its days were taken. */
export class TooLateToReverse extends Error {
  readonly code = 'TOO_LATE_TO_REVERSE';
  readonly leaveRequestId: string;

  constructor(request: LeaveRequest) {
    super(
      `This leave started on ${request.from}, so its days have been taken and the approval ` +
        `can no longer be reversed. HR can adjust the balance with a reason if it should not ` +
        `have been taken.`,
    );
    this.name = 'TooLateToReverse';
    this.leaveRequestId = request.id;
  }
}

/* ------------------------------------------------------------------- the rules */

/**
 * Which reversal applies to this request today, and where it leaves it.
 *
 * Approved leave only before it starts; refused leave at any time.
 */
export function reversalOf(
  request: LeaveRequest,
  today: CalendarDate,
): { action: ReversalAction; to: RequestStatus } {
  const action: ReversalAction | null =
    request.status === 'APPROVED'
      ? 'REVERSE_APPROVAL'
      : request.status === 'REFUSED'
        ? 'REVERSE_REFUSAL'
        : null;

  const transition = action === null ? undefined : transitionFor(request.status, action);

  if (action === null || transition === undefined) {
    throw new NothingToReverse(request);
  }

  if (action === 'REVERSE_APPROVAL' && request.from <= today) {
    throw new TooLateToReverse(request);
  }

  return { action, to: transition.to };
}

export function validateReversal(input: NewReversal): NewReversal {
  const reason = input.reason.trim();

  if (reason === '') {
    throw new ReversalNeedsAReason();
  }

  if (!(REVERSAL_ACTIONS as readonly string[]).includes(input.action)) {
    throw new InvalidLeaveRequest('action', `${String(input.action)} is not a reversal.`);
  }

  return { leaveRequestId: input.leaveRequestId, action: input.action, reason };
}

/** One reversal, as a trail reads it. */
export function reversalInWords(reversal: Reversal): string {
  return reversal.action === 'REVERSE_APPROVAL'
    ? 'The Chief Executive reversed the approval. The leave is turned down and the days went back into the balance.'
    : 'The Chief Executive reversed the refusal. The leave is approved and the days came off the balance.';
}

/** The sentence on the ledger entries. FR 27. */
export function reasonForReversal(
  typeName: string,
  request: LeaveRequest,
  action: ReversalAction,
): string {
  const leave = `${request.days} days of ${typeName}, ${request.from} to ${request.to}`;

  return action === 'REVERSE_APPROVAL'
    ? `${leave}: approval reversed by the Chief Executive, days given back`
    : `${leave}: refusal reversed by the Chief Executive, days taken`;
}
