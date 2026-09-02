/** The server entry point. LMS 401. */

import { config as loadEnv } from 'dotenv';
import { Guard } from './auth/policy.js';
import { createDatabase } from './db/index.js';
import { createMailer } from './mail/mailer.js';
import { BalanceRepository } from './features/balance/balance.db.js';
import { EmployeeRepository } from './features/employee/employee.db.js';
import { LeaveDecisionRepository } from './features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from './features/leave-request/leave-request.db.js';
import { LeaveTypeRepository } from './features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from './features/leave-year/leave-year.db.js';
import { RoleRepository } from './features/role/role.db.js';
import { SignInAccountRepository } from './features/sign-in/sign-in-account.db.js';
import { buildApp } from './http/app.js';
import { sessionSecretFrom } from './features/sign-in/session-cookie.routes.js';
import { SignInService } from './features/sign-in/sign-in.service.js';

loadEnv();

/** The port, checked rather than coerced. */
function portFrom(env: NodeJS.ProcessEnv): number {
  const port = Number(env.PORT ?? '3000');

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT is ${String(env.PORT)}, which is not a port. Set it to a whole number between ` +
        '1 and 65535, or leave it unset for 3000. See .env.example.',
    );
  }

  return port;
}

const db = createDatabase();
const guard = new Guard();

const employees = new EmployeeRepository(db);
const accounts = new SignInAccountRepository(db);
const roles = new RoleRepository(db);

const app = buildApp({
  guard,
  signIn: new SignInService(accounts, employees, roles, createMailer(), guard),
  balances: new BalanceRepository(db),
  employees,
  types: new LeaveTypeRepository(db),
  years: new LeaveYearRepository(db),
  requests: new LeaveRequestRepository(db),
  decisions: new LeaveDecisionRepository(db),
  accounts,
  roles,
  /* Resolved here as well as inside buildApp, so that a missing secret stops the process
     before a socket is opened rather than while the first request is being served. */
  secret: sessionSecretFrom(),
});

const port = portFrom(process.env);

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      event: 'http.listening',
      at: new Date().toISOString(),
      port,
      environment: process.env.NODE_ENV ?? 'development',
    }),
  );
});

/**
 * Stop taking new connections, finish the ones in flight, then close the pool.
 *
 * In that order, and the order is the point: closing the pool first would fail every
 * request that was halfway through a query, which for this application means somebody's
 * leave request landing in neither state. `Transactions.allOrNothing` would roll those
 * back correctly — nothing is corrupted either way — but a deploy that answers five
 * hundreds it did not have to is a deploy people learn to fear.
 */
function shutDown(signal: string): void {
  console.log(JSON.stringify({ event: 'http.closing', at: new Date().toISOString(), signal }));

  server.close(() => {
    void db.destroy().then(() => {
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => {
  shutDown('SIGTERM');
});
process.on('SIGINT', () => {
  shutDown('SIGINT');
});
