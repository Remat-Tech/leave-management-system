/** The application, assembled. LMS 401, LMS 112. */

import express, { type Express, type Request, type Response } from 'express';
import type { Guard } from '../auth/policy.js';
import { BalanceStatementService } from '../services/balance-statement-service.js';
import { RequestHistoryService } from '../services/request-history-service.js';
import type { SignInService } from '../services/sign-in-service.js';
import type { BalanceRepository } from '../repositories/balance-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveDecisionRepository } from '../repositories/leave-decision-repository.js';
import type { LeaveRequestRepository } from '../repositories/leave-request-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type { RoleRepository } from '../repositories/role-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';
import { balanceRoutes } from './balances.js';
import { identify } from './identify.js';
import { answerProblems, type FailureLog } from './problems.js';
import { requestRoutes } from './requests.js';
import { publicSessionRoutes, signedInSessionRoutes } from './session.js';
import { sessionSecretFrom } from './session-cookie.js';

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

  /** FR 54. */
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
