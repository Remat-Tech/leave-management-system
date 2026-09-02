/**
 * The application, assembled. LMS 401.
 *
 * The first HTTP layer in this system. Everything below it has been built and tested
 * without one for three phases — deliberately, because "LMS 112 put authorisation in the
 * service layer, which is the half that has to be right whatever the interface does" —
 * and this is the interface arriving to sit on top of what was already correct.
 *
 * It adds no rule. What is decided here is the order things are mounted in, and that
 * order is the one security property a route layer has to get right on its own.
 *
 * ## The mounting order is the authorisation model
 *
 * Three tiers, and the middle one is why this file exists rather than each router
 * checking for itself:
 *
 *   **In front of everything: the body parser, and nothing else.** No logger that could
 *   print a password, no cookie parser — ./session-cookie.ts reads the one cookie this
 *   application has and needs no library for it.
 *
 *   **Public, before {@link identify}: the two sign in routes.** These are the only
 *   routes in the system reachable without a session, and they are the only ones that
 *   *could* be — nobody has a cookie yet. Two, listed, in one place.
 *
 *   **Everything else, behind {@link identify}.** A route mounted after that line cannot
 *   be reached without a verified session, whatever its handler does or forgets to do.
 *
 * That is the arrangement the README asks for in its layering rule: "**A route never
 * contains an authorisation check either.** Every service method takes an `Actor` and asks
 * the policy for its resource; a route identifies the request and passes the actor down.
 * See Authorisation for why that is the only arrangement in which forgetting is impossible
 * rather than merely unlikely."
 *
 * So a new route is added behind `identify` by default and made public by an edit to
 * *this* file, which somebody reviews. The alternative — a route that opts in to being
 * guarded — is the arrangement where forgetting is a silent hole.
 *
 * ## The error handler is mounted last, and that is not a style choice
 *
 * Express dispatches to error handlers in the order they were added, so one mounted
 * before a router never sees that router's failures. ./problems.ts is the only thing that
 * answers a throw, and it goes on the end.
 *
 * ## No CORS, and that is a decision
 *
 * The client is served by Vite in development and is proxied to this server on the same
 * origin — see `client/vite.config.ts` — so no request this application answers is
 * cross-origin. Adding CORS to make development convenient would mean shipping a
 * relaxation nobody needs, and `SameSite=Strict` on the session cookie is standing in for
 * a CSRF token: a cross-origin credentialed request has to be impossible for that to hold.
 * The day this API is called from another origin, both decisions change together.
 *
 * ## What this does not do
 *
 * **No rate limit**, which the README lists as outstanding and which is still outstanding.
 * It belongs in front of the sign in routes below.
 *
 * **No static file serving.** The client is a separate build; in development Vite serves
 * it and proxies here, and in production it is files behind whatever is in front of this
 * process. A Node process serving its own assets is a deployment decision, not a Phase 4
 * one.
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Guard } from '../auth/policy.js';
import { BalanceStatementService } from '../services/balance-statement-service.js';
import type { SignInService } from '../services/sign-in-service.js';
import type { BalanceRepository } from '../repositories/balance-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type { RoleRepository } from '../repositories/role-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';
import { balanceRoutes } from './balances.js';
import { identify } from './identify.js';
import { answerProblems, type FailureLog } from './problems.js';
import { publicSessionRoutes, signedInSessionRoutes } from './session.js';
import { sessionSecretFrom } from './session-cookie.js';

/**
 * What the application is built out of.
 *
 * Repositories and the two services that have routes, passed in rather than constructed
 * here, so that the integration suite can build the same application against a disposable
 * database without a second assembly that could differ from the real one. ../main.ts is
 * the composition root; this is the shape.
 */
export interface Application {
  guard: Guard;
  signIn: SignInService;
  balances: BalanceRepository;
  employees: EmployeeRepository;
  types: LeaveTypeRepository;
  years: LeaveYearRepository;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** Where a 500 is written down. Defaulted to stderr; a test passes its own. */
  failures?: FailureLog;
  /** Read from `SESSION_SECRET` when not given. Tests pass their own. */
  secret?: string;
}

export function buildApp(parts: Application): Express {
  const app = express();

  /* The one thing every route needs and nothing else. A limit, because a body this
     application will never legitimately receive should be refused before it is parsed
     rather than after it is in memory. */
  app.use(express.json({ limit: '64kb' }));

  /* Never disclose the server. Express advertises itself by default, which tells anybody
     asking which stack to look up advisories for. */
  app.disable('x-powered-by');

  const secret = parts.secret ?? sessionSecretFrom();

  /** For a load balancer and for a developer who wants to know the process is up. */
  app.get('/api/health', (_request: Request, response: Response) => {
    response.json({ status: 'ok' });
  });

  /* --- public. The only two routes reachable without a session, and the whole list. --- */
  app.use('/api', publicSessionRoutes({ signIn: parts.signIn, secret }));

  /* --- the line. Everything below needs a verified session. -------------------------- */
  app.use(
    '/api',
    identify({
      employees: parts.employees,
      accounts: parts.accounts,
      roles: parts.roles,
      secret,
    }),
  );

  app.use('/api', signedInSessionRoutes());

  app.use(
    '/api',
    balanceRoutes({
      statements: new BalanceStatementService(
        parts.balances,
        parts.guard,
        parts.employees,
        parts.types,
        parts.years,
      ),
    }),
  );

  /* An unknown path under /api is 404 as JSON rather than as Express's HTML, so a client
     that expects JSON gets it whatever it asked for.

     It is behind `identify`, so a caller with no session meets 401 here instead and never
     learns which addresses exist. That is the mounting order doing something useful rather
     than an accident of where this sits: which routes an internal system has is not a
     stranger's business either. */
  app.use('/api', (_request: Request, response: Response) => {
    response
      .status(404)
      .json({ error: 'NoSuchRoute', message: 'There is nothing at that address.' });
  });

  /* Last. See the module note; an error handler mounted earlier sees nothing. */
  app.use(answerProblems(parts.failures));

  return app;
}
