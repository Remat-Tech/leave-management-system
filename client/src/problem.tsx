/** A failure, as the person who met it needs it. NFR USA 03, LMS 410. */

import { ApiError, UNREACHABLE } from './api';
import { Icon } from './Icon';

/**
 * One failure, ready to draw.
 *
 * The sentence is the server's wherever there is one, and that is the arrangement rather than
 * an implementation detail: the domain knows what a leave year is, what a balance holds and
 * what a person may do about either, and every refusal in `server/src` is written to say both
 * halves — what is wrong, and what to do. A browser that reworded them would be a second
 * account of a rule, and the day the two disagree the server is right and the page has been
 * lying. So nothing here composes a message except for the two failures the server never got
 * to write one for: a call that did not arrive, and a fault in this page.
 */
export interface Problem {
  /** What is wrong and what to do, in one sentence. */
  what: string;
  /** Which input, where the server named one, so a form can put it beside the box. */
  field: string | undefined;
  /** Whether the same act, tried again, could come out differently. */
  worthRetrying: boolean;
}

/**
 * Whatever was thrown, as something to show. LMS 410.
 *
 * The ten copies of `error instanceof Error ? error.message : 'Something went wrong.'` this
 * replaces each had the same hole in it, and it was the branch nobody reads: the fallback told
 * a person their leave request had failed and then declined to say anything else at all.
 *
 * **`worthRetrying` is about the act, not the mood.** A dropped connection and a fault at our
 * end are the two failures where pressing the same button again is genuinely the fix, so they
 * are the two that offer it. A rule that said no — a balance without the days in it, leave over
 * leave already booked — is not made true by asking twice, and a button offering that would be
 * telling somebody to do the one thing that cannot work.
 */
export function problemFrom(error: unknown): Problem {
  if (error instanceof ApiError) {
    return {
      what: error.message,
      field: error.field,
      worthRetrying: error.status === UNREACHABLE || error.status >= 500,
    };
  }

  /* Not a refusal: something in this page threw. Nobody upstream wrote a sentence for it, so
     this is the one place in the client that writes its own. */
  return {
    what:
      'This page could not finish what it was doing. Reload it and try again — and if it ' +
      'keeps happening, tell IT which screen you were on.',
    field: undefined,
    worthRetrying: true,
  };
}

/**
 * A failure on the screen. LMS 410.
 *
 * `role="alert"` because a refusal that arrives after a button press is read out rather than
 * merely drawn — somebody who submitted a fortnight and is waiting to hear is exactly the
 * person a silent replacement fails.
 *
 * The button is the "what to do" made pressable, and it appears only when the caller has
 * somewhere to retry to *and* retrying could come out differently. Where it does not appear,
 * the sentence carries the act on its own, which is what every refusal in the domain is
 * written to do.
 */
export function Notice({
  problem,
  onRetry,
  retrying = false,
}: {
  problem: Problem;
  /** What to do again. Left out where the act is the form still on screen. */
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="notice" role="alert">
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
