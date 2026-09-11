/** The server entry point. LMS 401. */

import { config as loadEnv } from 'dotenv';
import { Guard } from './auth/policy.js';
import { createDatabase } from './db/index.js';
import { createMailer } from './mail/mailer.js';
import { BalanceRepository } from './features/balance/balance.db.js';
import { DepartmentRepository } from './features/department/department.db.js';
import { EmployeeRepository } from './features/employee/employee.db.js';
import { EntitlementRuleRepository } from './features/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from './features/holiday/holiday.db.js';
import { ApprovalDelegationRepository } from './features/leave-request/delegation.db.js';
import { AttachmentRepository } from './features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from './features/leave-request/attachment-link.db.js';
import { LeaveDecisionRepository } from './features/leave-request/leave-decision.db.js';
import { LeaveRequestDraftRepository } from './features/leave-request/draft.db.js';
import { LeaveRoutingRepository } from './features/leave-request/routing.db.js';
import { WithdrawalRepository } from './features/leave-request/withdrawal.db.js';
import { LeaveRequestRepository } from './features/leave-request/leave-request.db.js';
import { LeaveTypeRepository } from './features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from './features/leave-year/leave-year.db.js';
import { LedgerRepository } from './features/balance/ledger.db.js';
import { NotificationRepository } from './features/notification/notification.db.js';
import { OrganisationRepository } from './features/organisation/organisation.db.js';
import { RoleRepository } from './features/role/role.db.js';
import { SignInAccountRepository } from './features/sign-in/sign-in-account.db.js';
import { Transactions } from './db/transaction.js';
import { WorkPatternRepository } from './features/work-pattern/work-pattern.db.js';
import { buildApp } from './http/app.js';
import { createScanner } from './scanning/index.js';
import { createStorage } from './storage/index.js';
import { sessionSecretFrom } from './features/sign-in/session-cookie.routes.js';
import { BalanceService } from './features/balance/balance.service.js';
import { LeaveCalculatorService } from './features/leave-calculator/leave-calculator.service.js';
import { ApprovalDelegationService } from './features/leave-request/delegation.service.js';
import { LeaveRequestService } from './features/leave-request/leave-request.service.js';
import { NotificationService } from './features/notification/notification.service.js';
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
/** FR 57, LMS 409. */
const departments = new DepartmentRepository(db);
const accounts = new SignInAccountRepository(db);
const roles = new RoleRepository(db);
const types = new LeaveTypeRepository(db);
const years = new LeaveYearRepository(db);
/** FR 31, LMS 502. */
const entitlementRules = new EntitlementRuleRepository(db);
/** FR 22, LMS 206, LMS 504. */
const holidays = new HolidayRepository(db);
const requests = new LeaveRequestRepository(db);
const decisions = new LeaveDecisionRepository(db);
/** FR 48b, LMS 320. */
const routing = new LeaveRoutingRepository(db);
/** FR 47, LMS 324. */
const withdrawals = new WithdrawalRepository(db);
/** FR 19, LMS 302. Requests started and not finished. */
const drafts = new LeaveRequestDraftRepository(db);
/** FR 12, LMS 310. */
const attachments = new AttachmentRepository(db);
/** NFR SEC 04, LMS 407. */
const attachmentLinks = new AttachmentLinkRepository(db);
const balances = new BalanceRepository(db);
/** FR 48c. Who the `CEO` desk resolves to. LMS 321. */
const organisation = new OrganisationRepository(db);
/** FR 49, LMS 327. */
const delegations = new ApprovalDelegationService(
  new ApprovalDelegationRepository(db),
  guard,
  employees,
  roles,
);

const mailer = createMailer();

/**
 * The one place a balance moves. §5.7, FR 37, LMS 506.
 *
 * Built once and handed to both doors below it, so an adjustment posted from the HR screen
 * and a day held by a leave request are the same act against the same cache.
 */
const movements = new BalanceService(balances, guard, employees, new Transactions(db));

/** FR 27, LMS 506. The movements behind a balance, which the adjustment screen reads. */
const ledger = new LedgerRepository(db);

/**
 * The write door, built once here. LMS 301, LMS 403.
 *
 * Everything below it is what asking for leave actually needs: a balance service to hold the
 * days, a calculator to count them against the working pattern and the holiday calendar, and
 * a notifier to say what happened once the transaction has committed. The read services in
 * `buildApp` construct themselves out of repositories precisely so that none of this has to
 * exist for a balance screen to render — see `RequestFormService`, which argues it.
 */
const leaveRequests = new LeaveRequestService(
  movements,
  guard,
  employees,
  types,
  years,
  requests,
  decisions,
  routing,
  withdrawals,
  attachments,
  roles,
  delegations,
  organisation,
  new LeaveCalculatorService(new WorkPatternRepository(db), holidays, guard),
  new NotificationService(new NotificationRepository(db), mailer, guard),
);

const app = buildApp({
  guard,
  signIn: new SignInService(accounts, employees, roles, mailer, guard),
  balances,
  /** FR 27, FR 37, LMS 506. */
  ledger,
  adjustments: movements,
  employees,
  departments,
  types,
  years,
  entitlementRules,
  holidays,
  requests,
  leaveRequests,
  decisions,
  routing,
  withdrawals,
  drafts,
  attachments,
  attachmentLinks,
  /* Both built once here, as the mailer is: the driver each resolves to is a deployment's
     decision, and nothing above them may know which one it got. NFR SEC 04, NFR SEC 07. */
  storage: createStorage(),
  scanner: createScanner(),
  accounts,
  roles,
  delegations,
  organisation,
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
