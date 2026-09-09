/** A failure, as the person who met it needs it. NFR USA 03, LMS 410. */

import { ApiError, UNREACHABLE } from './api';
import { Icon } from './Icon';

/** NFR SEC 04, LMS 407. A download link spent, expired, or never issued. */
const LINK_IS_GONE = 410;

export interface Problem {
  /** What is wrong and what to do, in one sentence. The server's, wherever there is one. */
  what: string;
  /** Which input, where the server named one. */
  field: string | undefined;
  /** Whether the same act, tried again, could come out differently. */
  worthRetrying: boolean;
}

/**
 * Whatever was thrown, as something to show.
 *
 * Nothing here rewords a refusal: the domain writes both halves and a second copy would
 * eventually disagree with it. Only the two failures the server never wrote one for are
 * composed here — a call that did not arrive, and a fault in this page.
 *
 * `worthRetrying` is the offline case, a fault at our end, and a spent download link, where
 * the next press mints a new one. A rule that said no is not made true by asking twice.
 */
export function problemFrom(error: unknown): Problem {
  if (error instanceof ApiError) {
    return {
      what: error.message,
      field: error.field,
      worthRetrying:
        error.status === UNREACHABLE || error.status >= 500 || error.status === LINK_IS_GONE,
    };
  }

  return {
    what:
      'This page could not finish what it was doing. Reload it and try again — and if it ' +
      'keeps happening, tell IT which screen you were on.',
    field: undefined,
    worthRetrying: true,
  };
}

/** A failure on the screen. `role="alert"`: it arrives after a press, so it is read out. */
export function Notice({
  problem,
  onRetry,
  retrying = false,
  id,
}: {
  problem: Problem;
  /** Left out where the act is the form still on screen. */
  onRetry?: () => void;
  retrying?: boolean;
  /** So an input the refusal named can point at it. */
  id?: string;
}) {
  return (
    <div className="notice" role="alert" id={id}>
      <p>{problem.what}</p>

      {onRetry === undefined || !problem.worthRetrying ? null : (
        <button type="button" className="linkish retry" disabled={retrying} onClick={onRetry}>
          <Icon name="again" />
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      )}
    </div>
  );
}
