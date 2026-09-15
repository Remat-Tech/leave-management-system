/** Signing in, and finding out who you are. LMS 109, LMS 110, LMS 401. */

import { type Request, type Response, Router } from 'express';
import { SignInRefused } from './sign-in.js';
import type { SignInService } from './sign-in.service.js';
import { actorOf, employeeOf } from '../../http/identify.js';
import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import type { DesksStaffed } from '../leave-request/approver-queue.js';
import { sectionsFor } from './sections.js';
import { mintSession, SESSION_COOKIE, sessionCookieOptions } from './session-cookie.routes.js';

export interface SessionRoutes {
  signIn: SignInService;
  /** From `SESSION_SECRET`. */
  secret: string;
}

/** The two routes anybody may reach without a session, mounted in front of `identify`. */
export function publicSessionRoutes({ signIn, secret }: SessionRoutes): Router {
  const routes = Router();

  /** The password step. */
  routes.post('/session', (request: Request, response: Response, next) => {
    const { email, password } = credentialsIn(request.body);

    void signIn
      .signIn(email, password)
      .then((outcome) => {
        if (outcome.status === 'CODE_SENT') {
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

  /** The code step. LMS 110. */
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

export interface SignedInSessionRoutes {
  guard: Guard;
  signIn: SignInService;
  /** The desks this person answers at, read the same way the queue screen reads them. */
  desksFor: (actor: Actor) => Promise<DesksStaffed>;
}

/** The routes that need a session, mounted behind `identify`. */
export function signedInSessionRoutes({ guard, signIn, desksFor }: SignedInSessionRoutes): Router {
  const routes = Router();

  /**
   * Who this is. §10.
   *
   * `mustChangePassword` is the one thing here that is not a name, and it is not a role by
   * another name either: it says which screen the person is owed, and the server refuses
   * every other route while it stands rather than trusting the page to. NFR SEC 01.
   */
  routes.get('/me', (_request: Request, response: Response) => {
    const actor = actorOf(response);
    const employee = employeeOf(response);

    response.json({
      employeeId: actor.employeeId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      mustChangePassword: response.locals.mustChangePassword === true,
    });
  });

  /** Somebody replacing their own password. NFR SEC 01. */
  routes.post('/session/password', (request: Request, response: Response, next) => {
    const { currentPassword, newPassword } = passwordsIn(request.body);

    void signIn
      .changeMyPassword(actorOf(response), currentPassword, newPassword)
      .then(() => {
        response.status(204).end();
      })
      .catch(next);
  });

  /**
   * Which HR sections this person may reach, so the rail draws only those.
   *
   * Its own route rather than fields on `/me`, which carries no roles and keeps none:
   * this answers what may be reached, and every screen is still refused by its own
   * policy whether or not a card was drawn.
   */
  routes.get('/me/sections', (_request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void desksFor(actor)
      .then((staffed) => {
        response.json({ sections: sectionsFor(actor, guard, staffed) });
      })
      .catch(next);
  });

  /** Signing out. */
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

/** A refusal, or something that is not one. */
function refusalOr(error: unknown, response: Response, next: (error: unknown) => void): void {
  if (error instanceof SignInRefused) {
    response.status(401).json({ error: 'SignInRefused', message: error.message });
    return;
  }

  next(error);
}

/** The two strings out of a JSON body, or two empty ones. */
function credentialsIn(body: unknown): { email: string; password: string } {
  return {
    email: stringIn(body, 'email'),
    password: stringIn(body, 'password'),
  };
}

function passwordsIn(body: unknown): { currentPassword: string; newPassword: string } {
  return {
    currentPassword: stringIn(body, 'currentPassword'),
    newPassword: stringIn(body, 'newPassword'),
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
