/** Turning a request into an Actor. NFR SEC 02, §10.. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type Actor, signedInAs } from '../auth/actor.js';
import { PasswordMustChange, whyNotSignIn } from '../features/sign-in/sign-in.js';
import type { RoleCode } from '../features/role/roles.js';
import type { Employee } from '../features/employee/employee.js';
import type { EmployeeRepository } from '../features/employee/employee.db.js';
import type { OrganisationRepository } from '../features/organisation/organisation.db.js';
import type { RoleRepository } from '../features/role/role.db.js';
import type { SignInAccountRepository } from '../features/sign-in/sign-in-account.db.js';
import {
  cookieFrom,
  isDueARefresh,
  mintSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  whoIsThis,
} from '../features/sign-in/session-cookie.routes.js';

/** What identify needs to answer "who is this". */
export interface Identity {
  employees: EmployeeRepository;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** FR 48c. Who the Chief Executive is; nobody is, where this is absent. */
  organisation?: OrganisationRepository;
  /** From `SESSION_SECRET`, resolved once at start-up by ./app.ts. */
  secret: string;
}

/** The actor for a request, and the record it was derived from. */
declare module 'express' {
  interface Locals {
    actor?: Actor;
    employee?: Employee;
    /** NFR SEC 01. The password on this login is still the one somebody else set. */
    mustChangePassword?: boolean;
  }
}

/**
 * Every door but the one that changes it, while a password somebody else set is on the account.
 *
 * Mounted behind {@link identify}, so it is the whole signed-in surface rather than a habit
 * each route has to remember. The three it lets through are what changing a password takes:
 * knowing who you are, changing it, and leaving.
 *
 * The screen asks for the change as well — but a screen is a request somebody may not make,
 * and the account holds a certificate somebody else's doctor wrote. NFR SEC 01.
 */
export function insistOnANewPassword(): RequestHandler {
  const openAnyway = new Set(['/me', '/session', '/session/password']);

  return (request: Request, response: Response, next: NextFunction) => {
    if (response.locals.mustChangePassword !== true || openAnyway.has(request.path)) {
      next();
      return;
    }

    next(new PasswordMustChange());
  };
}

/** The actor for this request, or a failure that is a bug rather than a refusal. */
export function actorOf(response: Response): Actor {
  const actor = response.locals.actor;

  if (actor === undefined) {
    throw new Error(
      'This route was reached without an actor, which means it was mounted in front of ' +
        'identify() rather than behind it. Every route that reads or writes a record ' +
        'needs one; see http/app.ts.',
    );
  }

  return actor;
}

/** The employee record this request's actor was derived from. */
export function employeeOf(response: Response): Employee {
  const employee = response.locals.employee;

  if (employee === undefined) {
    throw new Error(
      'This route was reached without an employee record, which means it was mounted in ' +
        'front of identify() rather than behind it. See http/app.ts.',
    );
  }

  return employee;
}

/** Establishes who is asking, or answers 401. */
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
    response.clearCookie(SESSION_COOKIE, { path: '/' });
    return undefined;
  }

  const [employee, account] = await Promise.all([
    identity.employees.findById(said.employeeId),
    identity.accounts.findByEmployeeId(said.employeeId),
  ]);

  if (account === undefined || whyNotSignIn(account, employee) !== null || employee === undefined) {
    return undefined;
  }

  const [roles, reports, chiefExecutiveId] = await Promise.all([
    identity.roles.codesFor(account.id),
    identity.employees.countReports(employee.id),
    identity.organisation?.chiefExecutiveId() ?? null,
  ]);

  response.locals.employee = employee;
  response.locals.mustChangePassword = account.mustChangePassword;

  /* Activity slides the idle expiry forward. Once a minute at most, so not every request
     sets a cookie. */
  if (isDueARefresh(said.seenAt)) {
    response.cookie(
      SESSION_COOKIE,
      mintSession(employee.id, identity.secret),
      sessionCookieOptions(),
    );
  }

  return signedInAs(employee.id, {
    roles: roles as RoleCode[],
    isManager: reports > 0,
    isChiefExecutive: chiefExecutiveId === employee.id,
  });
}
