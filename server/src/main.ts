/**
 * The server entry point. LMS 401.
 *
 * The composition root, and the first one this system has had. Three phases of jobs and
 * services have each said they had nowhere to be hung — "no server entry point, no route
 * layer and no scheduler" — and this is where that stops for the route layer. It is
 * deliberately still not a scheduler: nothing here runs the reconciliation, the annual
 * grant or the expiry job, because when to run those is a deployment decision and hanging
 * them off a web process is the arrangement where they stop running the day somebody adds
 * a second one.
 *
 * ## Everything is constructed once, here, and passed down
 *
 * One pool, one guard, one of each repository, and the two services that have routes.
 * Nothing below this file constructs a dependency for itself, which is what makes
 * ./routes/app.ts buildable against a disposable database by the integration suite — the
 * same assembly, different connection, rather than a second wiring that could differ from
 * the real one in the way that matters.
 *
 * ## It fails at start-up rather than on the first request
 *
 * `sessionSecretFrom` throws on a missing or default `SESSION_SECRET`, `createDatabase`
 * throws on a missing `DATABASE_URL`, and `SignInService` resolves its domains and code
 * settings in its constructor for exactly this reason — "so that a misconfigured
 * environment stops the application starting rather than letting the first sign in
 * attempt discover it".
 *
 * That is the whole argument for doing the work here rather than lazily: a process that
 * starts and then refuses every request is one a health check calls healthy.
 */

import { config as loadEnv } from 'dotenv';
import { Guard } from './auth/policy.js';
import { createDatabase } from './db/index.js';
import { createMailer } from './mail/mailer.js';
import { BalanceRepository } from './repositories/balance-repository.js';
import { EmployeeRepository } from './repositories/employee-repository.js';
import { LeaveTypeRepository } from './repositories/leave-type-repository.js';
import { LeaveYearRepository } from './repositories/leave-year-repository.js';
import { RoleRepository } from './repositories/role-repository.js';
import { SignInAccountRepository } from './repositories/sign-in-account-repository.js';
import { buildApp } from './routes/app.js';
import { sessionSecretFrom } from './routes/session-cookie.js';
import { SignInService } from './services/sign-in-service.js';

loadEnv();

/**
 * The port, checked rather than coerced.
 *
 * `Number('')` is 0 and `Number('http')` is NaN, and both would be listened on or bound
 * to nothing with no complaint. A port that is not a port stops the process here.
 */
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
