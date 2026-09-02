/**
 * Turning a request into an {@link Actor}. NFR SEC 02, §10. LMS 401.
 *
 * The seam the whole authorisation layer has been waiting for since LMS 112, and the
 * README's *what is not built* describes it exactly: "A route layer has to derive its own
 * from whatever identifies a request; an actor must never arrive over the wire."
 *
 * This is that derivation, and it is the only one. Every route in this application gets
 * its actor from here; nothing constructs one from a body, a header or a query parameter,
 * and ../../tests/unit/one-actor.test.ts reads the source to keep that true.
 *
 * ## Four reads, and the last three are the point
 *
 * The cookie says an employee id and nothing else — ./session-cookie.ts argues why — so
 * everything that decides what this person may do is read here, now, against the database
 * as it stands:
 *
 *   **The employee record.** Whether they are still employed, and who their line manager
 *   is. `whyNotSignIn` is asked with it, so somebody terminated at nine o'clock stops
 *   being able to read anything at one minute past, without waiting for a cookie to
 *   expire.
 *
 *   **The login.** Whether it has been closed. `SignInService.close` is the answer the
 *   README gives to "revoke this person now", and it only works if something asks.
 *
 *   **Their roles**, from `user_role`, fresh. This is the half the README says is a
 *   snapshot, and here it is not: an `HR_ADMIN` revoked while somebody is working is gone
 *   on their next request. It costs one small query, which is the price the README says
 *   it would be and is worth paying at a route rather than at every policy check — the
 *   thing it was declined for.
 *
 *   **Their reporting lines**, because being a manager is a relationship and not a role.
 *   `Authority` is emphatic about that and `countReports` is how every other part of the
 *   system asks.
 *
 * The four are the two halves of `Authority` plus the two questions that decide whether
 * there is anybody to build one for, and they are made in the order they can refuse in.
 *
 * ## A refusal here is 401 and never 403
 *
 * The distinction the whole of ../auth/policy.ts is built on: 401 is "I do not know who
 * you are", 403 is "I know, and no". Nothing in this file has an opinion about what
 * anybody may do — it establishes who is asking and hands the actor down, and every
 * question about permission is asked afterwards by a policy, against a record.
 *
 * So this never consults a policy and never logs a denial. A missing cookie is not a
 * denied attempt; it is a browser that has not signed in, which is the ordinary state of
 * a browser. Recording those would fill the denial log with the business of loading a
 * page, which is the argument ../auth/policy.ts makes about `Guard.would`.
 *
 * ## And no route may forget to ask
 *
 * {@link identify} is mounted once, in ./app.ts, in front of everything under `/api`
 * except the sign in routes themselves. A route that wanted to be public would have to be
 * mounted before it deliberately, which is a visible act in one file rather than a check
 * somebody left out of a handler.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type Actor, signedInAs } from '../auth/actor.js';
import { whyNotSignIn } from '../auth/sign-in.js';
import type { RoleCode } from '../auth/roles.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { RoleRepository } from '../repositories/role-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';
import { cookieFrom, SESSION_COOKIE, whoIsThis } from './session-cookie.js';

/**
 * What {@link identify} needs to answer "who is this".
 *
 * Repositories rather than services, and it is the same argument `BalanceService` makes
 * about holding an `EmployeeRepository`: this is one part of the system asking another
 * what it holds, at a moment when there is no actor yet to authorise the asking with. A
 * service call here would need one, and the only one available would be a system actor —
 * which is how a route layer acquires a caller that holds every role.
 */
export interface Identity {
  employees: EmployeeRepository;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** From `SESSION_SECRET`, resolved once at start-up by ./app.ts. */
  secret: string;
}

/**
 * The actor for a request, where one has been established.
 *
 * Attached to `res.locals` rather than to the request, because `res.locals` is the object
 * Express documents for exactly this and because a property added to `req` is one a body
 * parser could in principle be talked into setting. Read through {@link actorOf}, which is
 * the only thing that takes it off again.
 */
declare module 'express' {
  interface Locals {
    actor?: Actor;
  }
}

/**
 * The actor for this request, or a failure that is a bug rather than a refusal.
 *
 * Unreachable where {@link identify} is mounted, which is everywhere it is called from,
 * and answered rather than asserted because the alternative is a handler quietly treating
 * an authenticated request as an anonymous one. A route reachable without an actor is a
 * mounting mistake in ./app.ts, and this is the sentence that names it.
 */
export function actorOf(response: Response): Actor {
  const actor = response.locals.actor;

  if (actor === undefined) {
    throw new Error(
      'This route was reached without an actor, which means it was mounted in front of ' +
        'identify() rather than behind it. Every route that reads or writes a record ' +
        'needs one; see routes/app.ts.',
    );
  }

  return actor;
}

/**
 * Establishes who is asking, or answers 401.
 *
 * The employment check comes before the account check for the reason `whyNotSignIn` gives
 * about the same order: it is the reason that is true of the person rather than of the
 * login, and it is the one that matters. Neither is reported to the browser in any
 * detail, because a stranger holding a stale cookie learns nothing from a 401 and could
 * learn something from "that person has left".
 */
export function identify(identity: Identity): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    void establish(identity, request, response)
      .then((actor) => {
        if (actor === undefined) {
          response.status(401).json({
            error: 'NotSignedIn',
            message: 'Sign in to see this.',
          });
          return;
        }

        response.locals.actor = actor;
        next();
      })
      /* A database that is down is not an authentication failure, and reporting it as one
         would send somebody to the sign in screen to fix an outage. Handed to the error
         handler in ./problems.ts, which answers 500 and says nothing about the cause. */
      .catch(next);
  };
}

async function establish(
  identity: Identity,
  request: Request,
  response: Response,
): Promise<Actor | undefined> {
  const cookie = cookieFrom(request.headers.cookie, SESSION_COOKIE);

  if (cookie === undefined) {
    return undefined;
  }

  const said = whoIsThis(cookie, identity.secret);

  if ('refused' in said) {
    /* Cleared, so that a browser holding a cookie signed with a rotated secret or one
       that has simply run out stops presenting it on every request for the next eight
       hours. The refusal itself is not disclosed; see the module note. */
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    return undefined;
  }

  const [employee, account] = await Promise.all([
    identity.employees.findById(said.employeeId),
    identity.accounts.findByEmployeeId(said.employeeId),
  ]);

  /* A login that has gone is a cookie for somebody who no longer has an account here, and
     `whyNotSignIn` is asked with the record rather than instead of it — one function, the
     same answer as the sign in door gives, so the two cannot drift about who may be in. */
  if (account === undefined || whyNotSignIn(account, employee) !== null || employee === undefined) {
    return undefined;
  }

  const [roles, reports] = await Promise.all([
    identity.roles.codesFor(account.id),
    identity.employees.countReports(employee.id),
  ]);

  return signedInAs(employee.id, { roles: roles as RoleCode[], isManager: reports > 0 });
}
