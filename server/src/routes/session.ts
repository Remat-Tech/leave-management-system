/**
 * Signing in, and finding out who you are. LMS 109, LMS 110, and the route layer of
 * LMS 401.
 *
 * `SignInService` has done the work since LMS 109 and had nowhere to hand its answer.
 * These four routes are that door, and they add no rule of their own: the password check,
 * the code, the mandatory-code decision and every refusal are that service's, and this
 * file turns its return value into a cookie and a status code.
 *
 * ## The union is the whole of the shape
 *
 * `SignInOutcome` is `SIGNED_IN` or `CODE_SENT`, and that class's note explains why it is
 * a union rather than a nullable field: "a caller that treats the second as the first has
 * let somebody past a factor". This is that caller, and the branch is the only place the
 * distinction could be lost — so 200 with a session is written on one arm and 202 with
 * where the code went on the other, and there is no path that sets a cookie on both.
 *
 * ## Two refusals, one answer
 *
 * A wrong password, an address nobody has, and an account that has been closed all come
 * back as `SignInRefused`, and the service is deliberate that they are indistinguishable
 * from outside. That stays true here: **401 with the service's own sentence**, which is
 * already written to disclose nothing. A route that reported "no such account" separately
 * would turn the sign in form into a directory of who works here.
 *
 * ## What is still not built, and this story does not build it
 *
 * **No rate limit.** The README says the counter belongs in front of the route with the
 * one unlimited password guesses need, that it needs doing, and that it is not done. It is
 * still not done. This file is where it goes when it is, which is worth saying in the
 * place somebody will look.
 *
 * **No password reset.** HR sets a password through `SignInService.setPassword`; there is
 * no self service path and no route here for one.
 */

import { type Request, type Response, Router } from 'express';
import { SignInRefused } from '../auth/sign-in.js';
import type { SignInService } from '../services/sign-in-service.js';
import { actorOf } from './identify.js';
import { mintSession, SESSION_COOKIE, sessionCookieOptions } from './session-cookie.js';

export interface SessionRoutes {
  signIn: SignInService;
  /** From `SESSION_SECRET`. Resolved once at start-up; see ./app.ts. */
  secret: string;
}

/**
 * The two routes anybody may reach without a session, mounted in front of `identify`.
 *
 * Deliberately a separate router from {@link whoAmI} below, because "mounted in front of
 * identify" is the one property of this file that has to be visible: a public route is an
 * act somebody performed on purpose in ./app.ts, rather than an authentication check
 * missing from a handler.
 */
export function publicSessionRoutes({ signIn, secret }: SessionRoutes): Router {
  const routes = Router();

  /**
   * The password step. 200 and a cookie, or 202 and a code in a mailbox.
   *
   * The body is read defensively rather than trusted, because `SignInService.signIn` is
   * typed for two strings and a JSON body is whatever somebody posted. The service
   * refuses a wrong shape too — its own note says it "does not validate what it is
   * handed; it refuses it" — and this is the layer that stops a non-string reaching it at
   * all, which is what a route layer is for.
   */
  routes.post('/session', (request: Request, response: Response, next) => {
    const { email, password } = credentialsIn(request.body);

    void signIn
      .signIn(email, password)
      .then((outcome) => {
        if (outcome.status === 'CODE_SENT') {
          /* 202: the request was understood and nothing has been decided yet. No cookie,
             because nobody is in — which is the failure the union exists to prevent. */
          response.status(202).json({
            status: 'CODE_SENT',
            companyEmail: outcome.companyEmail,
            expiresAt: outcome.expiresAt.toISOString(),
          });
          return;
        }

        setSession(response, outcome.employee.id, secret);
        response.status(200).json(signedIn(outcome.employee));
      })
      .catch((error: unknown) => {
        refusalOr(error, response, next);
      });
  });

  /** The code step. The only way past a mandatory second factor. LMS 110. */
  routes.post('/session/code', (request: Request, response: Response, next) => {
    const { email, code } = codeIn(request.body);

    void signIn
      .submitCode(email, code)
      .then((outcome) => {
        setSession(response, outcome.employee.id, secret);
        response.status(200).json(signedIn(outcome.employee));
      })
      .catch((error: unknown) => {
        refusalOr(error, response, next);
      });
  });

  return routes;
}

/**
 * The two routes that need a session, mounted behind `identify`.
 *
 * `GET /me` is what a browser asks on load to find out whether it is signed in, and it is
 * the reason `identify` answering 401 has to be cheap: it is the first request every
 * page makes.
 */
export function signedInSessionRoutes(): Router {
  const routes = Router();

  /**
   * Who this is. Name and id, and nothing that is not already on every screen.
   *
   * **No roles**, deliberately. A client that knew what it held would start deciding what
   * to draw from it, and the day the two disagree the server is right and the screen has
   * been lying. What a person may do is answered by asking, which is the arrangement
   * §10's matrix is enforced by.
   */
  routes.get('/me', (_request: Request, response: Response) => {
    const actor = actorOf(response);

    response.json({ employeeId: actor.employeeId });
  });

  /**
   * Signing out. Clears the browser's copy and nothing else.
   *
   * There is no server side session to end — ./session-cookie.ts says so at length — so
   * this is honest rather than complete: the cookie stops being presented, and a copy
   * taken off the wire would still work until it expires. 204, because there is nothing
   * to say.
   */
  routes.delete('/session', (_request: Request, response: Response) => {
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    response.status(204).end();
  });

  return routes;
}

/** What a browser is told about the person it has just signed in as. */
function signedIn(employee: { id: string; firstName: string; lastName: string }): {
  employeeId: string;
  firstName: string;
  lastName: string;
} {
  return {
    employeeId: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
  };
}

function setSession(response: Response, employeeId: string, secret: string): void {
  response.cookie(SESSION_COOKIE, mintSession(employeeId, secret), sessionCookieOptions());
}

/**
 * A refusal, or something that is not one.
 *
 * `SignInRefused` is answered 401 with the service's own sentence, which is already
 * written not to say which of the reasons it was. Everything else — a database that is
 * down, a mailer that threw — goes to ./problems.ts, because a failure to send a code is
 * not a wrong password and telling somebody it is would have them retyping a correct one.
 */
function refusalOr(error: unknown, response: Response, next: (error: unknown) => void): void {
  if (error instanceof SignInRefused) {
    response.status(401).json({ error: 'SignInRefused', message: error.message });
    return;
  }

  next(error);
}

/**
 * The two strings out of a JSON body, or two empty ones.
 *
 * Empty rather than a 400, because "" is refused by the service with the same sentence a
 * wrong password gets — and a route that answered 400 for a missing password and 401 for
 * a wrong one would be telling a stranger which half of their guess was the problem.
 */
function credentialsIn(body: unknown): { email: string; password: string } {
  return {
    email: stringIn(body, 'email'),
    password: stringIn(body, 'password'),
  };
}

function codeIn(body: unknown): { email: string; code: string } {
  return {
    email: stringIn(body, 'email'),
    code: stringIn(body, 'code'),
  };
}

function stringIn(body: unknown, field: string): string {
  if (typeof body !== 'object' || body === null) {
    return '';
  }

  const value = (body as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : '';
}
