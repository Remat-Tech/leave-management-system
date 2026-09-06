/** Several requests answered at one press. FR 51, FR 39, FR 48, §8.6a, LMS 328. */

import { type DecidingAction, readComment, requireAComment } from './leave-decision.js';

/** The verbs a queue may be cleared with. FR 51, FR 44. */
export const BULK_ACTIONS: readonly DecidingAction[] = ['APPROVE', 'REFUSE'];

export type BulkAction = 'APPROVE' | 'REFUSE';

/** The most one press may decide. FR 51. */
export const MOST_AT_ONCE = 50;

/** One row a batch names, with the version its queue handed out. NFR DAT 02, LMS 326. */
export interface RequestToDecide {
  requestId: string;
  /** Null where the caller had no screen behind it. */
  version: string | null;
}

/** A batch as it arrives. FR 51. */
export interface BulkAsSent {
  action: unknown;
  comment: unknown;
  requests: unknown;
}

/** The same, checked. FR 39, FR 51. */
export interface ValidatedBulkDecision {
  action: BulkAction;
  /** Required of a refusal, and the same words go on every one of them. FR 39. */
  comment: string | null;
  requests: RequestToDecide[];
}

/** A batch of a verb that is decided one request at a time. FR 44, FR 51. */
export class NotABulkAction extends Error {
  readonly code = 'NOT_A_BULK_ACTION';
  /** NFR USA 03. */
  readonly field = 'action';

  constructor(value: unknown) {
    super(
      `A queue is cleared by approving or turning down, and ${String(value)} is neither. ` +
        'Overturning a line manager’s decision is reasoned about one request at a time, so ' +
        'it has no batch: the justification FR 44 asks for is about that request and not ' +
        'about the ten beside it. FR 51.',
    );
    this.name = 'NotABulkAction';
  }
}

/** A batch that named nothing. FR 51. */
export class NothingToDecide extends Error {
  readonly code = 'NOTHING_TO_DECIDE';
  readonly field = 'requests';

  constructor() {
    super('Deciding several requests at once names the requests. Nothing was selected. FR 51.');
    this.name = 'NothingToDecide';
  }
}

/** More rows than one press decides. FR 51. */
export class TooManyToDecideAtOnce extends Error {
  readonly code = 'TOO_MANY_TO_DECIDE_AT_ONCE';
  readonly field = 'requests';

  constructor(asked: number) {
    super(
      `${asked} requests is more than the ${MOST_AT_ONCE} one press decides. Each is a ` +
        'decision of its own with a balance behind it, so a queue this long is cleared in ' +
        'two goes rather than in one that holds the connection for minutes. FR 51.',
    );
    this.name = 'TooManyToDecideAtOnce';
  }
}

/** Checks a batch on its way in, and applies FR 39's rule about the comment once for all of it. */
export function validateBulkDecision(sent: BulkAsSent): ValidatedBulkDecision {
  const action = readBulkAction(sent.action);

  /** FR 39. Refused before the selection is read, while the box is still open. */
  const comment = action === 'REFUSE' ? requireAComment(sent.comment) : readComment(sent.comment);

  const requests = readRequests(sent.requests);

  if (requests.length === 0) {
    throw new NothingToDecide();
  }

  if (requests.length > MOST_AT_ONCE) {
    throw new TooManyToDecideAtOnce(requests.length);
  }

  return { action, comment, requests };
}

/** What one press did, as the approver reads it. NFR USA 03, FR 51. */
export function bulkInWords(action: BulkAction, decided: number, undecided: number): string {
  const said = action === 'APPROVE' ? 'approved' : 'turned down';
  const asked = decided + undecided;

  if (undecided === 0) {
    return `${inRequests(asked)} ${said}.`;
  }

  const left = `${inRequests(undecided)} left where ${undecided === 1 ? 'it was' : 'they were'}, and each says why.`;

  return decided === 0 ? `Nothing was ${said}. ${left}` : `${decided} of ${asked} ${said}. ${left}`;
}

/** One of the two verbs, or the refusal naming what arrived. FR 44, FR 51. */
function readBulkAction(value: unknown): BulkAction {
  if (typeof value !== 'string' || !BULK_ACTIONS.includes(value as DecidingAction)) {
    throw new NotABulkAction(value);
  }

  return value as BulkAction;
}

/**
 * The rows a batch named, in the order it named them. FR 51, NFR DAT 02.
 *
 * A bare id is a caller with no screen behind it; a queue row carries LMS 326's version. An
 * entry naming nothing is dropped rather than refused, as `asIds` drops one at the door — what
 * FR 51 refuses on is whether anything was selected. The same request twice is one decision.
 */
function readRequests(value: unknown): RequestToDecide[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const named = new Map<string, RequestToDecide>();

  for (const one of value as unknown[]) {
    const row = asRequestToDecide(one);

    if (row !== null && !named.has(row.requestId)) {
      named.set(row.requestId, row);
    }
  }

  return [...named.values()];
}

function asRequestToDecide(value: unknown): RequestToDecide | null {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : { requestId: value.trim(), version: null };
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const { requestId, version } = value as { requestId?: unknown; version?: unknown };

  if (typeof requestId !== 'string' || requestId.trim() === '') {
    return null;
  }

  return {
    requestId: requestId.trim(),
    version: typeof version === 'string' && version !== '' ? version : null,
  };
}

function inRequests(count: number): string {
  return count === 1 ? '1 request' : `${count} requests`;
}
