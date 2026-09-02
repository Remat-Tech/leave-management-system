/**
 * What a refusal looks like over HTTP. NFR USA 03, NFR SEC 03. LMS 401.
 *
 * Every service in this system refuses by throwing something with a sentence in it — the
 * sentences are most of what `/domain` is — and this is the one place those become status
 * codes. It is a translation and nothing more: **no rule is decided here**, and a status
 * code invented in a handler would be the beginning of a route layer with opinions.
 *
 * ## The two refusals stay two refusals
 *
 * ../auth/policy.ts draws the line this file has to keep. A refusal that says why has
 * already decided that saying so discloses nothing — "anybody who reaches this can
 * already read the balance" — and it becomes **403 with its own sentence**. A refusal
 * that says nothing is deliberately word for word identical to a record that is not
 * there, because "two messages that differ are a way of asking the server whether a
 * record exists", and it becomes **404 with that same sentence**.
 *
 * A silent refusal answered 403 would undo the whole arrangement in one line: 403 means
 * "it is there and you may not", which is precisely the fact the message declines to
 * state. So the status has to be as vague as the words are.
 *
 * `NotAuthorised.attempt` is never read. It carries the accurate account for the log, and
 * that class's own note is explicit that nothing reaching a screen may turn it back into
 * a message.
 *
 * ## Families rather than a list of imports
 *
 * The mapping is by the `name` every error in `/domain` sets on itself, in three families
 * — `…NotFound`, `Invalid…`, and the ones named here — rather than by importing three
 * dozen classes into the HTTP layer.
 *
 * That is a deliberate trade and worth stating. The cost is that renaming an error class
 * changes its status code silently; ../../tests/integration/balances-api.test.ts is what
 * makes that a failing test rather than a discovery. The gain is that a story adding a
 * domain error gets a sensible answer without editing this file — and a route layer that
 * had to import every error in the system to answer at all would be one nobody keeps up
 * to date.
 *
 * ## And an unrecognised error is a 500 that says nothing
 *
 * Everything not in a family is a bug in this application, and the browser is told so in
 * four words. Not the message, which for a Postgres error is a constraint name and for a
 * programming error is a stack — neither is any use to the person at the screen and both
 * describe the inside of the system to whoever asked. It is logged in full instead, which
 * is where somebody can act on it.
 */

import type { NextFunction, Request, Response } from 'express';
import { NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../auth/policy.js';

/** The body every refusal has. One shape, so a client has one thing to read. */
export interface Problem {
  /** The error's own name, for a client that wants to branch. Never a stack. */
  error: string;
  /** The sentence, as the domain wrote it. NFR USA 03. */
  message: string;
  /** Which input was wrong, where the domain said. `InvalidLeaveType.field` and friends. */
  field?: string;
}

/**
 * Where a failure that is nobody's fault but ours is written down.
 *
 * The same shape `DenialLog` and `NoticeLog` have and for the same reason: the thing that
 * must not happen is a failure disappearing, and an interface is what lets a test read one
 * back rather than watch stderr.
 */
export interface FailureLog {
  record(failure: { at: Date; method: string; path: string; error: unknown }): void;
}

/** The default. One JSON line per failure, on stderr, as the denial log writes one. */
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

  return unexpected();
}

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
