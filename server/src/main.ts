/** The server entry point. LMS 401. */

import { config as loadEnv } from 'dotenv';
import { Guard } from './auth/policy.js';
import { createDatabase } from './db/index.js';
import { createMailer } from './mail/mailer.js';
import { AuditRepository } from './features/audit/audit.db.js';
import { BalanceRepository } from './features/balance/balance.db.js';
import { DepartmentRepository } from './features/department/department.db.js';
import { EmployeeRepository } from './features/employee/employee.db.js';
import { EntitlementRuleRepository } from './features/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from './features/holiday/holiday.db.js';
import { HolidayRecalculationRepository } from './features/holiday/recalculation.db.js';
import { ApprovalDelegationRepository } from './features/leave-request/delegation.db.js';
import { AttachmentRepository } from './features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from './features/leave-request/attachment-link.db.js';
import { LeaveDecisionRepository } from './features/leave-request/leave-decision.db.js';
import { LeaveRequestDraftRepository } from './features/leave-request/draft.db.js';
import { LeaveRoutingRepository } from './features/leave-request/routing.db.js';
import { ReclassificationRepository } from './features/leave-request/reclassification.db.js';
import { WithdrawalRepository } from './features/leave-request/withdrawal.db.js';
import { ReversalRepository } from './features/leave-request/reversal.db.js';
import { LeaveRequestRepository } from './features/leave-request/leave-request.db.js';
import { LeaveTypeRepository } from './features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from './features/leave-year/leave-year.db.js';
import { LedgerRepository } from './features/balance/ledger.db.js';
import { NotificationRepository } from './features/notification/notification.db.js';
import { EmailWordingRepository } from './features/notification/wording.db.js';
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
import { HolidayRecalculationService } from './features/holiday/recalculation.service.js';
import { LeaveCalculatorService } from './features/leave-calculator/leave-calculator.service.js';
import { earliestOpenDayFrom } from './features/leave-year/leave-year.service.js';
import { ApprovalDelegationService } from './features/leave-request/delegation.service.js';
import { LeaveRequestService } from './features/leave-request/leave-request.service.js';
import { NotificationService } from './features/notification/notification.service.js';
import { SignInService } from './features/sign-in/sign-in.service.js';
import { LeaveEventRepository } from './features/leave-event/leave-event.db.js';
import {
  EntitlementExpiry,
  summaryOf as summaryOfEntitlementExpiry,
} from './features/entitlement/entitlement-expiry.job.js';
import { theSystem } from './auth/actor.js';
import { EntitlementRuleService } from './features/entitlement/entitlement-rule.service.js';
import { calendarDateIn } from './shared/time.js';
import { LeaveYearService } from './features/leave-year/leave-year.service.js';
import { AnnualGrant } from './features/entitlement/annual-grant.job.js';
import { summaryOf as summaryOfGrant } from './features/entitlement/annual-grant.js';
import { YearRollover } from './features/leave-year/year-rollover.job.js';
import { summaryOf as summaryOfRollover } from './features/leave-year/year-rollover.js';
import { CarryoverExpiry } from './features/leave-year/carryover-expiry.job.js';
import { summaryOf as summaryOfCarryoverExpiry } from './features/leave-year/carryover-expiry.js';
import { AttachmentPurge } from './features/leave-request/attachment-purge.job.js';
import { BalanceReconciliation } from './features/balance/balance-reconciliation.job.js';
import { ReconciliationRepository } from './features/balance/reconciliation.db.js';
import { reportOf } from './features/balance/reconciliation.js';
import {
  DailyApproverReminders,
  summaryOf as summaryOfReminders,
} from './features/notification/reminder.job.js';
import { UndeliveredNotices } from './features/notification/delivery.job.js';
import { summaryOf as summaryOfDelivery } from './features/notification/delivery.js';

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
const reversals = new ReversalRepository(db);
/** FR 32c, LMS 507. */
const reclassifications = new ReclassificationRepository(db);
/** FR 25, LMS 508. The holidays declared late and credited back. */
const recalculations = new HolidayRecalculationRepository(db);
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

/** FR 23. Which days each person works. */
const patterns = new WorkPatternRepository(db);

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
 * FR 59. Built once here, as the mailer is, and handed to both doors that write news.
 *
 * LMS 508 is the second caller: a holiday credited back is told in the same words and
 * through the same retry as an approval, and a second instance would be a second backoff.
 */
const notifications = new NotificationService(new NotificationRepository(db), mailer, guard);

/** FR 31. The entitlement rules, asked what per-occasion leave is worth. */
const entitlementLookup = new EntitlementRuleService(
  entitlementRules,
  guard,
  earliestOpenDayFrom(years),
);

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
  reclassifications,
  attachments,
  roles,
  delegations,
  organisation,
  new LeaveCalculatorService(patterns, holidays, guard),
  notifications,
  /* FR 32g. What per-occasion leave is worth, so it is capped when asked for and granted
     when approved. */
  async (employee, leaveTypeId, on) =>
    (
      await entitlementLookup.entitlementOn(
        theSystem('the figure an occasion grants'),
        employee,
        leaveTypeId,
        on,
      )
    )?.entitlementDays,
);

/**
 * FR 25, §8.8, LMS 508. The second write door, built here for the same reason the first is.
 *
 * Crediting a holiday back moves a balance and tells everybody it moved, so it needs the
 * transaction door and the notifier — and `buildApp` is deliberately not a place either is
 * reachable from.
 */
const holidayRecalculations = new HolidayRecalculationService(
  holidays,
  recalculations,
  requests,
  employees,
  types,
  patterns,
  movements,
  notifications,
  guard,
  earliestOpenDayFrom(years),
);

/** FR 32g, FR 32e, LMS 218. Births, bereavements and the like, and the grants they caused. */
const events = new LeaveEventRepository(db);

/** NFR SEC 04. Shared by the attachment routes and the certificate purge. */
const storage = createStorage();

const app = buildApp({
  guard,
  signIn: new SignInService(accounts, employees, roles, mailer, guard),
  balances,
  /** FR 27, FR 37, LMS 506. */
  ledger,
  adjustments: movements,
  /** FR 32g, LMS 218. */
  events,
  employees,
  departments,
  types,
  years,
  entitlementRules,
  holidays,
  /** FR 25, §8.8, LMS 508. */
  holidayRecalculations,
  requests,
  leaveRequests,
  decisions,
  routing,
  withdrawals,
  reversals,
  drafts,
  attachments,
  attachmentLinks,
  /* Both built once here, as the mailer is: the driver each resolves to is a deployment's
     decision, and nothing above them may know which one it got. NFR SEC 04, NFR SEC 07. */
  storage,
  scanner: createScanner(),
  accounts,
  roles,
  delegations,
  organisation,
  /** FR 61, LMS 512. */
  emailWording: new EmailWordingRepository(db),
  /** NFR AUD 01, LMS 513. */
  audit: new AuditRepository(db),
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

/*
 * The scheduled jobs. In process rather than a cron: every job is safe to rerun, so a restart
 * or a sleeping instance only means it runs again when the process wakes.
 */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** FR 50. Not before the working day starts. */
const REMIND_FROM_HOUR_UTC = 8;

const yearService = new LeaveYearService(years, guard);
const annualGrant = new AnnualGrant(movements, yearService, entitlementLookup, employees, types);
const rollover = new YearRollover(
  movements,
  yearService,
  entitlementLookup,
  annualGrant,
  employees,
  types,
);
const carryoverExpiry = new CarryoverExpiry(
  movements,
  balances,
  entitlementLookup,
  years,
  employees,
  types,
);
const entitlementExpiry = new EntitlementExpiry(movements, events, types, years);
const attachmentPurge = new AttachmentPurge(attachments, organisation, storage);
const reconciliation = new BalanceReconciliation(
  new ReconciliationRepository(db),
  guard,
  roles,
  employees,
  mailer,
);
const reminders = new DailyApproverReminders(leaveRequests, notifications);
const undelivered = new UndeliveredNotices(notifications);

/** Runs one job and logs its summary, or its failure. Undefined means nothing worth logging. */
async function runJob(job: string, work: () => Promise<string | undefined>): Promise<void> {
  try {
    const summary = await work();

    if (summary !== undefined) {
      console.log(JSON.stringify({ event: `job.${job}`, at: new Date().toISOString() }));
      console.log(summary);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: `job.${job}.failed`,
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Runs now and then every interval, skipping a tick while the last one is still going. */
function every(intervalMs: number, work: () => Promise<void>): NodeJS.Timeout {
  let running = false;

  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    void work().finally(() => {
      running = false;
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return timer;
}

/** FR 36, §11. Every open year that has ended, oldest first, closed from the day after. */
async function rollOverFinishedYears(): Promise<string | undefined> {
  const actor = theSystem('the year rollover');
  const today = calendarDateIn(new Date(), 'UTC');
  const finished = (await years.list({ openOnly: true })).filter((year) => year.endDate < today);
  const summaries: string[] = [];

  for (const year of finished) {
    summaries.push(summaryOfRollover(await rollover.run(actor, year.id)));
  }

  return summaries.length === 0 ? undefined : summaries.join('\n\n');
}

/** FR 30. The current year, which also reaches anyone who joined since the last run. */
async function grantTheCurrentYear(): Promise<string | undefined> {
  const actor = theSystem('the annual grant');
  const year = await yearService.current(actor);

  if (year === undefined) {
    return undefined;
  }

  const run = await annualGrant.run(actor, year.id);

  return run.granted.length === 0 ? undefined : summaryOfGrant(run);
}

/* Daily, in sequence: the balance moves first, and the reconciliation checks what they left. */
const dailyTimer = every(DAY_MS, async () => {
  await runJob('year-rollover', rollOverFinishedYears);
  await runJob('annual-grant', grantTheCurrentYear);
  await runJob('carryover-expiry', async () =>
    summaryOfCarryoverExpiry(await carryoverExpiry.run(theSystem('the carryover expiry'))),
  );
  await runJob('entitlement-expiry', async () =>
    summaryOfEntitlementExpiry(await entitlementExpiry.run(theSystem('the entitlement expiry'))),
  );
  await runJob('attachment-purge', async () => {
    const run = await attachmentPurge.run();

    return `Certificate purge as at ${run.asAt}: ${String(run.deleted.length)} stored files deleted.`;
  });
  await runJob('balance-reconciliation', async () =>
    reportOf(await reconciliation.run(theSystem('the balance reconciliation'))),
  );
});

/* FR 50, FR 60. Hourly so a restart cannot skip a day; the job reminds nobody twice in one. */
const reminderTimer = every(HOUR_MS, () =>
  runJob('approver-reminders', async () => {
    if (new Date().getUTCHours() < REMIND_FROM_HOUR_UTC) {
      return undefined;
    }

    const run = await reminders.run(theSystem('the daily approver reminders'));

    return run.reminded.length === 0 ? undefined : summaryOfReminders(run);
  }),
);

/* FR 59, LMS 331. Every minute, the shortest backoff. */
const deliveryTimer = every(MINUTE_MS, () =>
  runJob('notification-retry', async () => {
    const run = await undelivered.run(theSystem('the notification retry'));

    return run.due === 0 ? undefined : summaryOfDelivery(run);
  }),
);

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

  clearInterval(dailyTimer);
  clearInterval(reminderTimer);
  clearInterval(deliveryTimer);

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
