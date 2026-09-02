/** The application, assembled. LMS 401, LMS 112. */

import express, { type Express, type Request, type Response } from 'express';
import type { Guard } from '../auth/policy.js';
import { BalanceStatementService } from '../features/balance/balance-statement.service.js';
import { LeaveTypeService } from '../features/leave-type/leave-type.service.js';
import { RequestFormService } from '../features/leave-request/request-form.service.js';
import { RequestHistoryService } from '../features/leave-request/request-history.service.js';
import type { SignInService } from '../features/sign-in/sign-in.service.js';
import type { BalanceRepository } from '../features/balance/balance.db.js';
import type { EmployeeRepository } from '../features/employee/employee.db.js';
import type { LeaveDecisionRepository } from '../features/leave-request/leave-decision.db.js';
import type { LeaveRequestRepository } from '../features/leave-request/leave-request.db.js';
import type { LeaveRequestService } from '../features/leave-request/leave-request.service.js';
import type { LeaveTypeRepository } from '../features/leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../features/leave-year/leave-year.db.js';
import type { RoleRepository } from '../features/role/role.db.js';
import type { SignInAccountRepository } from '../features/sign-in/sign-in-account.db.js';
import { balanceRoutes } from '../features/balance/routes.js';
import { identify } from './identify.js';
import { answerProblems, type FailureLog } from './problems.js';
import { requestRoutes } from '../features/leave-request/routes.js';
import { publicSessionRoutes, signedInSessionRoutes } from '../features/sign-in/session.routes.js';
import { sessionSecretFrom } from '../features/sign-in/session-cookie.routes.js';

/** What the application is built out of. */
export interface Application {
  guard: Guard;
  signIn: SignInService;
  balances: BalanceRepository;
  employees: EmployeeRepository;
  types: LeaveTypeRepository;
  years: LeaveYearRepository;
  /** FR 54. */
  requests: LeaveRequestRepository;
  /**
   * The one door that prices and writes a request. LMS 301, LMS 403.
   *
   * A service where every other part here is a repository, and it is the only one that could
   * be. Submitting holds days, which means a transaction, a balance service and a notifier;
   * `LeaveRequestService` is where those are already assembled and where the rule that a
   * quote and a submission count the same way lives. Building a second one here would be a
   * second answer to what a fortnight costs.
   */
  leaveRequests: LeaveRequestService;
  /** FR 39, FR 52. */
  decisions: LeaveDecisionRepository;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** Where a 500 is written down. */
  failures?: FailureLog;
  /** Read from `SESSION_SECRET` when not given. */
  secret?: string;
}

export function buildApp(parts: Application): Express {
  const app = express();

  app.use(express.json({ limit: '64kb' }));

  app.disable('x-powered-by');

  const secret = parts.secret ?? sessionSecretFrom();

  /** For a load balancer and for a developer who wants to know the process is up. */
  app.get('/api/health', (_request: Request, response: Response) => {
    response.json({ status: 'ok' });
  });

  app.use('/api', publicSessionRoutes({ signIn: parts.signIn, secret }));

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

  /** FR 54, and LMS 403's form, quote and submission. */
  app.use(
    '/api',
    requestRoutes({
      history: new RequestHistoryService(
        parts.requests,
        parts.decisions,
        parts.guard,
        parts.employees,
        parts.types,
        parts.years,
      ),
      /** LMS 403. What each kind of leave asks of somebody, before any dates. */
      form: new RequestFormService(
        new LeaveTypeService(parts.types, parts.guard),
        parts.guard,
        parts.employees,
      ),
      /* LMS 301, LMS 403. The write door, handed in whole rather than built here, because
         it is the one place a request is priced and the one place a request is written and
         those two have to be the same object — see `LeaveRequestService.quote`, which is
         emphatic that a quote and a submission ask the same questions of the same facts. */
      requests: parts.leaveRequests,
    }),
  );

  app.use('/api', (_request: Request, response: Response) => {
    response
      .status(404)
      .json({ error: 'NoSuchRoute', message: 'There is nothing at that address.' });
  });

  app.use(answerProblems(parts.failures));

  return app;
}
