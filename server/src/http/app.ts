/** The application, assembled. LMS 401, LMS 112. */

import express, { type Express, type Request, type Response } from 'express';
import type { Guard } from '../auth/policy.js';
import { ApproverQueueService } from '../features/leave-request/approver-queue.service.js';
import { BalanceStatementService } from '../features/balance/balance-statement.service.js';
import { EntitlementRuleService } from '../features/entitlement/entitlement-rule.service.js';
import { LeaveTypeService } from '../features/leave-type/leave-type.service.js';
import { RequestFormService } from '../features/leave-request/request-form.service.js';
import { RequestHistoryService } from '../features/leave-request/request-history.service.js';
import type { SignInService } from '../features/sign-in/sign-in.service.js';
import type { BalanceRepository } from '../features/balance/balance.db.js';
import type { DepartmentRepository } from '../features/department/department.db.js';
import type { EmployeeRepository } from '../features/employee/employee.db.js';
import { LeaveRequestDraftService } from '../features/leave-request/draft.service.js';
import type { LeaveRequestDraftRepository } from '../features/leave-request/draft.db.js';
import type { LeaveDecisionRepository } from '../features/leave-request/leave-decision.db.js';
import type { LeaveRoutingRepository } from '../features/leave-request/routing.db.js';
import type { WithdrawalRepository } from '../features/leave-request/withdrawal.db.js';
import type { LeaveRequestRepository } from '../features/leave-request/leave-request.db.js';
import type { LeaveRequestService } from '../features/leave-request/leave-request.service.js';
import type { LeaveTypeRepository } from '../features/leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../features/leave-year/leave-year.db.js';
import type { OrganisationRepository } from '../features/organisation/organisation.db.js';
import type { ApprovalDelegationService } from '../features/leave-request/delegation.service.js';
import type { RoleRepository } from '../features/role/role.db.js';
import type { SignInAccountRepository } from '../features/sign-in/sign-in-account.db.js';
import type { AttachmentRepository } from '../features/leave-request/attachment.db.js';
import type { AttachmentLinkRepository } from '../features/leave-request/attachment-link.db.js';
import { AttachmentService } from '../features/leave-request/attachment.service.js';
import { attachmentRoutes } from '../features/leave-request/attachment.routes.js';
import type { Scanner } from '../scanning/index.js';
import type { Storage } from '../storage/index.js';
import type { EntitlementRuleRepository } from '../features/entitlement/entitlement-rule.db.js';
import type { HolidayRepository } from '../features/holiday/holiday.db.js';
import { HolidayService } from '../features/holiday/holiday.service.js';
import type { HolidayRecalculationService } from '../features/holiday/recalculation.service.js';
import { earliestOpenDayFrom } from '../features/leave-year/leave-year.service.js';
import { balanceRoutes } from '../features/balance/routes.js';
import { BalanceAdjustmentService } from '../features/balance/adjustment.service.js';
import { balanceAdjustmentRoutes } from '../features/balance/adjustment.routes.js';
import { LeaverStatementService } from '../features/balance/leaver-statement.service.js';
import { leaverRoutes } from '../features/balance/leaver-statement.routes.js';
import { ReportService } from '../features/report/report.service.js';
import { reportRoutes } from '../features/report/routes.js';
import { LedgerService } from '../features/balance/ledger.service.js';
import type { LedgerRepository } from '../features/balance/ledger.db.js';
import type { BalanceService } from '../features/balance/balance.service.js';
import { entitlementRuleRoutes } from '../features/entitlement/routes.js';
import { holidayRoutes } from '../features/holiday/routes.js';
import { leaveTypeRoutes } from '../features/leave-type/routes.js';
import { organisationRoutes } from '../features/organisation/routes.js';
import { OrganisationService } from '../features/organisation/organisation.service.js';
import { teamRoutes } from '../features/team/routes.js';
import { TeamService } from '../features/team/team.service.js';
import { teamCalendarRoutes } from '../features/team/team-calendar.routes.js';
import { TeamCalendarService } from '../features/team/team-calendar.service.js';
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
  /** FR 27, LMS 506. The movements a cached balance is made of. */
  ledger: LedgerRepository;
  /**
   * FR 37, LMS 506. The one door a balance moves through, handed in whole as `leaveRequests` is.
   *
   * The same instance the write door below holds, so an adjustment and a request movement
   * cannot disagree about what a movement does to a cached figure.
   */
  adjustments: BalanceService;
  employees: EmployeeRepository;
  /** FR 57, LMS 409. What the away calendar is scoped to, and what HR filters it by. */
  departments: DepartmentRepository;
  types: LeaveTypeRepository;
  years: LeaveYearRepository;
  /** FR 31, LMS 502. What a leave type is worth, and from when. */
  entitlementRules: EntitlementRuleRepository;
  /** FR 22, LMS 504. The gazetted days the office is closed. */
  holidays: HolidayRepository;
  /**
   * FR 25, §8.8, LMS 508. Crediting a late-declared holiday back into leave people had.
   *
   * A service rather than a repository, and passed in whole for the reason `leaveRequests`
   * is: a credit moves a balance and tells somebody about it, so it needs a transaction and
   * a mailer. Building it here would put a mailer within reach of a balance screen, which
   * is the property `RequestFormService` was separated out to keep.
   */
  holidayRecalculations: HolidayRecalculationService;
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
  /** FR 48b. The stages a request's routing skipped. LMS 320. */
  routing: LeaveRoutingRepository;
  /** FR 47. The asks to take agreed leave off the books. LMS 324. */
  withdrawals: WithdrawalRepository;
  /** FR 19. Requests started and not finished. LMS 302. */
  drafts: LeaveRequestDraftRepository;
  /** FR 12. Certificates and supporting documents. LMS 310. */
  attachments: AttachmentRepository;
  /** NFR SEC 04. The short-lived links they are fetched through, and who fetched them. LMS 407. */
  attachmentLinks: AttachmentLinkRepository;
  /** NFR SEC 04. Where attachment bytes live, behind one interface. */
  storage: Storage;
  /** NFR SEC 07. */
  scanner: Scanner;
  accounts: SignInAccountRepository;
  roles: RoleRepository;
  /** FR 49. Who is covering for an approver who is away. LMS 327. */
  delegations: ApprovalDelegationService;
  /** FR 48c. Who the `CEO` desk resolves to. LMS 321. */
  organisation: OrganisationRepository;
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

  /* FR 37, FR 27, LMS 506. Putting a balance right by hand, with a reason that stays on it.
     Reading a ledger is the person's own, their manager's and HR's, and posting an adjustment
     is an HR Administrator's — `ledgerPolicy` decides both rather than the mounting. The write
     door is handed in rather than built, so this is the same `BalanceService` a request
     movement goes through. */
  app.use(
    '/api',
    balanceAdjustmentRoutes({
      adjustments: new BalanceAdjustmentService(
        new BalanceStatementService(
          parts.balances,
          parts.guard,
          parts.employees,
          parts.types,
          parts.years,
        ),
        new LedgerService(parts.ledger, parts.guard, parts.employees),
        parts.guard,
        parts.employees,
        parts.types,
      ),
      balances: parts.adjustments,
    }),
  );

  /* FR 37a, §8.6d, §8.7, LMS 509. What a leaver is owed on their last day, with its working.
     A read service built from repositories: the figure writes nothing, so it needs no
     transaction and no mailer. The read rule is the balance's — theirs, their manager's and
     HR's — and the picker is the directory's, which `ledgerPolicy` and `employeePolicy`
     decide rather than the mounting does. */
  app.use(
    '/api',
    leaverRoutes({
      leavers: new LeaverStatementService(
        parts.balances,
        parts.guard,
        parts.employees,
        parts.types,
        parts.years,
        new EntitlementRuleService(
          parts.entitlementRules,
          parts.guard,
          earliestOpenDayFrom(parts.years),
        ),
      ),
    }),
  );

  /* FR 63, LMS 510. HR's reports. Read only, built from repositories. */
  app.use(
    '/api',
    reportRoutes({
      reports: new ReportService(
        parts.guard,
        parts.employees,
        parts.departments,
        parts.types,
        parts.years,
        parts.balances,
        parts.requests,
      ),
    }),
  );

  /* FR 31, FR 32, LMS 501. Reading a type is anybody's — the person who most needs to know a
     notice window is the one about to miss it — and writing one is an HR Administrator's,
     which `leaveTypePolicy` decides rather than the mounting does. */
  app.use('/api', leaveTypeRoutes({ types: new LeaveTypeService(parts.types, parts.guard) }));

  /* FR 31, LMS 502. The figures behind those types, effective dated. The boundary a closed
     year sets is read from the leave year table rather than passed in, so the refusal that
     protects last year's figures cannot be configured away. */
  app.use(
    '/api',
    entitlementRuleRoutes({
      rules: new EntitlementRuleService(
        parts.entitlementRules,
        parts.guard,
        earliestOpenDayFrom(parts.years),
      ),
      types: new LeaveTypeService(parts.types, parts.guard),
      employees: parts.employees,
      departments: parts.departments,
      years: parts.years,
    }),
  );

  /* FR 22, LMS 504. The days the office is closed, kept by HR the day the gazette says so.
     Reading the calendar is anybody's — it is what a leave quote is priced against — and
     `holidayPolicy` decides the writes rather than the mounting. The closed-year boundary is
     read from the leave year table, so the trigger and the refusal cannot disagree. */
  app.use(
    '/api',
    holidayRoutes({
      holidays: new HolidayService(
        parts.holidays,
        parts.guard,
        earliestOpenDayFrom(parts.years),
        parts.years,
      ),
      years: parts.years,
      /* FR 25, §8.8, LMS 508. Crediting a late-declared day back is the same desk's act as
         declaring it, so it hangs off the calendar's own router. */
      recalculations: parts.holidayRecalculations,
    }),
  );

  /* FR 44, FR 48c, NFR SEC 06, LMS 505. The settings that are about the company rather than
     about a type, a year or a person. Reading them is everybody's, because the request form
     already says unpaid leave goes to the Chief Executive, and `organisationPolicy` decides
     the writes rather than the mounting. The notice and back-dating windows are read here
     and written through `leaveTypeRoutes` above, which stays the one door onto a type. */
  app.use(
    '/api',
    organisationRoutes({
      organisation: new OrganisationService(parts.organisation, parts.guard, parts.employees),
      types: new LeaveTypeService(parts.types, parts.guard),
    }),
  );

  /* FR 55, FR 56, LMS 405. A read service built from repositories, as the two above are:
     nothing a manager reads about their reports needs a transaction or a mailer. */
  app.use(
    '/api',
    teamRoutes({
      team: new TeamService(
        parts.guard,
        parts.employees,
        parts.balances,
        parts.requests,
        parts.types,
        parts.years,
      ),
    }),
  );

  /* FR 57, LMS 406, LMS 409. Everybody's screen, scoped to a department, and it is handed no
     leave type repository: a type name cannot be sent by a service that never reads the
     table. */
  app.use(
    '/api',
    teamCalendarRoutes({
      calendar: new TeamCalendarService(
        parts.guard,
        parts.employees,
        parts.requests,
        parts.years,
        parts.departments,
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
        parts.routing,
        parts.withdrawals,
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
      /* LMS 404. A read service built from repositories, like the two above and unlike the
         write door: nothing an approver queue shows needs a transaction or a mailer. */
      queue: new ApproverQueueService(
        parts.requests,
        parts.decisions,
        parts.guard,
        parts.employees,
        parts.organisation,
        parts.balances,
        parts.types,
        parts.years,
        /** FR 49, LMS 327. */
        parts.delegations,
      ),
      /** FR 49, LMS 327. */
      delegations: parts.delegations,
      /* FR 19, LMS 302. A draft holds nothing, so this needs no transaction and no
         balance — but finishing one is an ordinary submission, so it is handed the same
         write door rather than a second way into `leave_request`. */
      drafts: new LeaveRequestDraftService(
        parts.guard,
        parts.drafts,
        parts.employees,
        parts.leaveRequests,
      ),
      /* FR 51, LMS 328. A batch reports each row's refusal rather than throwing, so a fault
         among them reaches the same log `answerProblems` writes to and not neither. */
      failures: parts.failures,
    }),
  );

  /* FR 12, LMS 310. Its own router because the upload takes a raw body, which is
     route-level middleware rather than anything the JSON routes above want. */
  app.use(
    '/api',
    attachmentRoutes({
      attachments: new AttachmentService(
        parts.guard,
        parts.attachments,
        parts.attachmentLinks,
        parts.requests,
        parts.employees,
        parts.types,
        parts.organisation,
        parts.delegations,
        parts.storage,
        parts.scanner,
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
