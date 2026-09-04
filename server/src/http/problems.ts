/** What a refusal looks like over HTTP. NFR USA 03, NFR SEC 03, LMS 401. */

import type { NextFunction, Request, Response } from 'express';
import { NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../auth/policy.js';

/** The body every refusal has. */
export interface Problem {
  /** The error's own name, for a client that wants to branch. */
  error: string;
  /** The sentence, as the domain wrote it. NFR USA 03. */
  message: string;
  /** Which input was wrong, where the domain said. */
  field?: string;
}

/** Where a failure that is nobody's fault but ours is written down. */
export interface FailureLog {
  record(failure: { at: Date; method: string; path: string; error: unknown }): void;
}

/** The default. */
export function failuresToStderr(): FailureLog {
  return {
    record({ at, method, path, error }) {
      console.error(
        JSON.stringify({
          event: 'http.failed',
          at: at.toISOString(),
          method,
          path,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
    },
  };
}

/**
 * The status and body for one thrown thing.
 *
 * Exported apart from the middleware so that it can be asked directly by a test, which is
 * the only way to assert the silent-refusal rule without provoking every policy in the
 * system through a socket.
 */
export function problemFor(error: unknown): { status: number; body: Problem } {
  if (error instanceof NotAuthorised) {
    /* The refusal that says nothing is answered as indistinguishably as it is worded. See
       the module note; this comparison is the whole of that rule. */
    return error.message === NOT_AUTHORISED_MESSAGE
      ? { status: 404, body: { error: 'NotFound', message: NOT_AUTHORISED_MESSAGE } }
      : { status: 403, body: { error: 'NotAuthorised', message: error.message } };
  }

  if (!(error instanceof Error)) {
    return unexpected();
  }

  /* Somebody's own record, named by an id they supplied. The id is never echoed and the
     sentence is the vague one, so that a route cannot be used to ask whether an employee
     number belongs to anybody — the pair of this and a silent refusal has to be one
     answer. Every other `NotFound` is about configuration, which anybody signed in may
     read anyway, so it keeps its own sentence. */
  if (error.name === 'EmployeeNotFound') {
    return { status: 404, body: { error: 'NotFound', message: NOT_AUTHORISED_MESSAGE } };
  }

  if (error.name.endsWith('NotFound')) {
    return { status: 404, body: { error: error.name, message: error.message } };
  }

  /* A real leave year that is not this person's. 404 rather than 403, because it is a
     statement that does not exist rather than one being withheld — and the sentence names
     the years that do, which is the whole of NFR USA 03 for this refusal. */
  if (error.name === 'NotOneOfTheirLeaveYears') {
    return { status: 404, body: { error: error.name, message: error.message } };
  }

  /**
   * A gap in the configuration rather than a bad request or a bug: the person is real,
   * the request is well formed, and there is no leave year for the answer to be about.
   *
   * 409 rather than 404, because nothing is missing that the caller named — what is
   * missing is a row only HR can create, which is what the sentence says. Answering 404
   * would send somebody to check their link; answering 500 would send a developer to
   * check the logs. Neither is the person who can fix it.
   */
  if (error.name === 'NoLeaveYearToShow') {
    return { status: 409, body: { error: error.name, message: error.message } };
  }

  /* The family every `/domain` validator throws, each carrying the field a form should
     put the message beside. NFR USA 03, and the reason those classes have a `field` at
     all. */
  if (error.name.startsWith('Invalid')) {
    return {
      status: 400,
      body: {
        error: error.name,
        message: error.message,
        field: fieldOf(error),
      },
    };
  }

  const refusal = REFUSED_BY_A_RULE[error.name];
  if (refusal !== undefined) {
    return { status: refusal, body: { error: error.name, message: error.message } };
  }

  return unexpected();
}

/**
 * The refusals a leave request can meet, and the status each is answered with. LMS 403.
 *
 * Every one of these is a well formed request that a rule says no to. Without this table they
 * fall through to {@link unexpected} and reach the browser as "Something went wrong. It has
 * been logged." — which is the exact failure LMS 403 is written against, because each of them
 * already carries the sentence that tells somebody what to do instead. `LeaveCrossesAYearEnd`
 * names the two dates to submit; `NotEnoughDays` names how many days could be asked for;
 * `TooLateToRecord` names who can still enter it. Throwing that away and logging a stack
 * trace sends a developer to the logs instead of the person who can fix it.
 *
 * ## Why a table rather than a family test
 *
 * The rules above match on shape — `Invalid*`, `*NotFound` — because those genuinely are
 * families with one answer between them. These are not. A retired leave type and a balance
 * with nothing left are both refusals and they are not the same kind of news, and a prefix
 * that happened to catch both would catch the next error somebody names similarly without
 * anybody deciding it should. Listing them is the decision being written down.
 *
 * ## Which status, and why only two of them
 *
 * **400** where the answer is to change what was typed: the dates cost nothing, or they run
 * past a year end. The form puts those beside the date inputs and the person edits them.
 *
 * **409** where what was typed is fine and the *state of the world* refuses it: leave already
 * booked over those days, a balance without the days in it, a type retired or unapproved, a
 * settled year, a date further back than the window allows. Nothing the person retypes fixes
 * those; they are told what stands in the way, exactly as `NoLeaveYearToShow` above is.
 *
 * `NotEligibleForLeaveType` is the one that could be argued to 403, and is not. FR 05 says
 * the column is "limited to eligibility checks only", and answering a leave type's gender
 * restriction with the status the authorisation layer uses would put a policy refusal and a
 * configuration fact behind one code. It is a conflict between the request and the record,
 * and the sentence says which — including the case where the record simply does not say.
 */
const REFUSED_BY_A_RULE: Readonly<Record<string, number>> = {
  /** FR 16a. The dates are the fix. */
  LeaveCountsNoDays: 400,
  /** FR 16. Two requests instead of one; the message names both dates. */
  LeaveCrossesAYearEnd: 400,
  /** FR 39. The comment box is the fix. LMS 315. */
  RefusalNeedsAComment: 400,
  /** FR 44. The justification box is the fix. LMS 318. */
  OverrideNeedsAJustification: 400,
  /**
   * FR 44. The other button is the fix, and the message names it. LMS 318.
   *
   * A 400 rather than a 409 because what has to change is what was sent — the verb — rather
   * than the state of the world. The request is in a state this desk may decide; it is the
   * plain verb that is wrong for a request the line manager already decided the other way.
   */
  OverrulingNeedsAnOverride: 400,
  /**
   * FR 19. The empty fields are the fix, and the message names them. LMS 302.
   *
   * A 400 rather than a 409: nothing about the world refuses this, and the draft is
   * exactly where it was. What is missing is what was sent.
   */
  DraftIsNotFinished: 400,
  /** FR 17. The tick is the fix and the dates are fine. LMS 307. */
  ShortNoticeNotAcknowledged: 400,
  /** FR 18. The reason box is the fix, and only HR ever sees this one. LMS 308. */
  LateEntryNeedsAReason: 400,
  /** FR 12. A different file is the fix, and renaming this one is not. LMS 310. */
  AttachmentTypeNotAccepted: 400,
  /** FR 12. A smaller file is the fix. LMS 310. */
  AttachmentTooLarge: 400,

  /** FR 44. There is nothing on this request to reverse. LMS 318. */
  NothingToOverturn: 409,

  /** FR 15, §5.6. Leave over leave already booked. */
  LeaveOverlapsAnother: 409,
  /** FR 14. And the same condition the quote shows as a warning. */
  NotEnoughDays: 409,
  /** §8.2. The same refusal from inside the lock, when a balance was spent mid form. */
  BalanceOverdrawn: 409,
  /** FR 21. Taken out of use on purpose. */
  LeaveTypeRetired: 409,
  /** FR 05. */
  NotEligibleForLeaveType: 409,
  /** FR 38a. A gap in the configuration, like `NoLeaveYearToShow`. */
  NobodyApprovesLeaveType: 409,
  /** FR 18. Only HR can enter it now, which the message says. */
  TooLateToRecord: 409,

  /** FR 12. Five is five; removing one is the fix. LMS 310. */
  TooManyAttachments: 409,
  /** NFR SEC 07. The file is real and was refused by the scanner. LMS 310. */
  AttachmentIsInfected: 409,
  /** NFR SEC 07. Nothing about the file changes this; the scan has to run. LMS 310. */
  AttachmentNotScanned: 409,
  /** FR 12. The request has moved past the point evidence goes on or comes off. LMS 310. */
  AttachmentsAreClosed: 409,
  /** §8.9. */
  LeaveYearIsClosed: 409,
};

/**
 * The last handler mounted, and the only thing that answers an unhandled throw.
 *
 * Four arguments, because that is how Express recognises an error handler and a
 * three-argument version is silently never called — which would mean every failure
 * arriving at the client as Express's own HTML stack trace.
 *
 * `next` is unused and must be declared all the same, for that reason.
 */
export function answerProblems(log: FailureLog = failuresToStderr()) {
  return (error: unknown, request: Request, response: Response, next: NextFunction): void => {
    const { status, body } = problemFor(error);

    if (status >= 500) {
      log.record({ at: new Date(), method: request.method, path: request.path, error });
    }

    /* Headers already sent means something wrote part of a response and then threw.
       Express cannot answer twice, so the connection is closed rather than corrupted. */
    if (response.headersSent) {
      next(error);
      return;
    }

    response.status(status).json(body);
  };
}

function unexpected(): { status: number; body: Problem } {
  return {
    status: 500,
    body: {
      error: 'Unexpected',
      message: 'Something went wrong. It has been logged.',
    },
  };
}

/** The field a validator named, where it named one. */
function fieldOf(error: Error): string | undefined {
  const field = (error as { field?: unknown }).field;

  return typeof field === 'string' ? field : undefined;
}
