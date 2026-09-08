/** Pending leave following a reporting line that moved. FR 07, §8.4, FR 48b, LMS 325. */

import { type ApproverRole, deskInWordsAbout } from '../leave-type/approval-chain.js';
import type { LeaveRequest } from './leave-request.js';
import type { ReportingLineMove } from '../employee/employee.js';

export type { ReportingLineMove };

/** One request the move carried, as it is recorded. FR 07. */
export interface Reassignment {
  /** The desk it was waiting at, and the desk it waits at now. Null is nobody. */
  movedFrom: ApproverRole | null;
  movedTo: ApproverRole | null;
  /** Who managed them, and who does now. FR 04. */
  from: string | null;
  to: string | null;
  /** NFR USA 03. */
  because: string;
}

/** Whether the line actually moved. A record with the same manager on it carried nothing. */
export function lineMoved(move: ReportingLineMove): boolean {
  return move.from !== move.to;
}

/**
 * The requests a reporting-line move carries with it. FR 07, §8.4.
 *
 * A stage waiting at the `MANAGER` desk, because that desk is the line; and an `UNROUTABLE`
 * one, because an empty manager's desk is one of the things that strands a request.
 *
 * Everything else stays put, which is what keeps approvals already given standing: a stage
 * that decided has moved the request off that desk, and its decision is on the record for
 * good. FR 44.
 */
export function requestsThatFollow(requests: readonly LeaveRequest[]): LeaveRequest[] {
  return requests.filter(
    (request) =>
      request.status === 'UNROUTABLE' ||
      (request.status === 'SUBMITTED' && request.awaitingApprovalFrom === 'MANAGER'),
  );
}

/** The handover to record, from where the request was and where the walk put it. FR 07. */
export function reassignmentFor(
  request: Pick<LeaveRequest, 'awaitingApprovalFrom'>,
  routed: { awaiting: ApproverRole | null },
  move: ReportingLineMove,
): Reassignment {
  const moved = {
    movedFrom: request.awaitingApprovalFrom,
    movedTo: routed.awaiting,
    from: move.from,
    to: move.to,
  };

  return { ...moved, because: reassignmentInWords(moved) };
}

/** Why this request moved, in one sentence. NFR USA 03, FR 07. */
export function reassignmentInWords(reassignment: Omit<Reassignment, 'because'>): string {
  const { movedFrom, movedTo, to } = reassignment;

  const line =
    to === null ? 'This person no longer has a manager' : 'This person’s manager changed';

  if (movedFrom === movedTo) {
    return (
      `${line}, so the stage waiting at ${deskInWordsAbout('MANAGER', 'their')} is now ` +
      `theirs to decide. Nothing has been decided on it. FR 07.`
    );
  }

  if (movedTo === null) {
    return (
      `${line}, and nobody is left who could answer the stage it was waiting at, so it ` +
      `has stopped there. FR 07, FR 48b.`
    );
  }

  return (
    `${line}, so the stage it was waiting at went to ${deskInWordsAbout(movedTo, 'their')} ` +
    `instead. Nobody approved it on the way. FR 07, FR 48b.`
  );
}
