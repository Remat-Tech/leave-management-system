/** Turning a request into an Actor. NFR SEC 02, §10., LMS 401, LMS 112. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type Actor, signedInAs } from '../auth/actor.js';
import { whyNotSignIn } from '../features/sign-in/sign-in.js';
import type { RoleCode } from '../features/role/roles.js';
import type { Employee } from '../features/employee/employee.js';
import type { EmployeeRepository } from '../features/employee/employee.db.js';
import type { RoleRepository } from '../features/role/role.db.js';
import type { SignInAccountRepository } from '../features/sign-in/sign-in-account.db.js';
import {
  cookieFrom,
  SESSION_COOKIE,
  whoIsThis,
} from '../features/sign-in/session-cookie.routes.js';

/** What identify needs to answer "who is this". */
export interface Identity {
  employees: EmployeeRepository;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** From `SESSION_SECRET`, resolved once at start-up by ./app.ts. */
  secret: string;
}

/** The actor for a request, and the record it was derived from. */
declare module 'express' {
  interface Locals {
    actor?: Actor;
    employee?: Employee;
  }
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

  const [roles, reports] = await Promise.all([
    identity.roles.codesFor(account.id),
    identity.employees.countReports(employee.id),
  ]);

  response.locals.employee = employee;

  return signedInAs(employee.id, { roles: roles as RoleCode[], isManager: reports > 0 });
}
