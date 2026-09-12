import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { LedgerRepository } from '../../src/features/balance/ledger.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { EmailWordingRepository } from '../../src/features/notification/wording.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { SignInAccountRepository } from '../../src/features/sign-in/sign-in-account.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { buildApp } from '../../src/http/app.js';
import { mintSession, SESSION_COOKIE } from '../../src/features/sign-in/session-cookie.routes.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { delegationService } from '../support/delegations.js';

/** The email wording screen, over HTTP. FR 61, LMS 512. What an email says is ../unit/wording.test.ts. */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let people: Record<string, string>;

interface JsonEmail {
  name: string;
  label: string;
  readBy: string;
  subject: string;
  body: string;
  original: { subject: string; body: string };
  isReworded: boolean;
  updatedAt: string | null;
  placeholders: { name: string; meaning: string }[];
}

const REWORDED = {
  subject: 'We have your request for {{period}}',
  body: 'Dear {{firstName}},\n\nThank you. It is with {{nowWith}}.\n\nRemat Holdings HR',
};

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  const balances = new BalanceService(
    new BalanceRepository(db),
    guard,
    employees,
    new Transactions(db),
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    ledger: new LedgerRepository(db),
    adjustments: balances,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years: yearRepository,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: requestRepository,
    leaveRequests: new LeaveRequestService(
      balances,
      guard,
      employees,
      types,
      yearRepository,
      requestRepository,
      decisions,
      new LeaveRoutingRepository(db),
      new WithdrawalRepository(db),
      new ReclassificationRepository(db),
      new AttachmentRepository(db),
      new RoleRepository(db),
      delegationService(db, guard),
      new OrganisationRepository(db),
      new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
      new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
    ),
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
    holidayRecalculations: holidayRecalculationService(db, guard, balances),
    storage: new InMemoryStorage(),
    scanner: new SignatureScanner(),
    accounts,
    roles,
    delegations: delegationService(db, guard),
    organisation: new OrganisationRepository(db),
    emailWording: new EmailWordingRepository(db),
    secret: SECRET,
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await db?.destroy();
  await admin?.end();
});

describe('the line everything is mounted behind', () => {
  it('answers 401 without a session', async () => {
    expect((await fetch(`${origin}/api/email-wording`)).status).toBe(401);
  });
});

describe('reading the wording', () => {
  it('lists every email in the words it is sent in, with what it can fill in', async () => {
    const response = await send('GET', '/api/email-wording', people.hrOfficer);
    const page = (await response.json()) as { emails: JsonEmail[] };

    expect(response.status).toBe(200);

    const submitted = page.emails.find((one) => one.name === 'SUBMITTED');

    expect(page.emails.length).toBe(18);
    expect(submitted?.isReworded).toBe(false);
    expect(submitted?.subject).toBe('Your {{typeName}} for {{period}} has been submitted');
    expect(submitted?.placeholders.map((one) => one.name)).toContain('nowWith');
  });

  it('is refused, with a sentence, for somebody with no HR role', async () => {
    const response = await send('GET', '/api/email-wording', people.teamLead);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain('FR 61');
  });
});

describe('rewording an email', () => {
  it('is an HR Officer’s, and the next notice is composed from it', async () => {
    const response = await send('PUT', '/api/email-wording/SUBMITTED', people.hrOfficer, REWORDED);
    const saved = (await response.json()) as JsonEmail;

    expect(response.status).toBe(200);
    expect(saved.isReworded).toBe(true);
    expect(saved.subject).toBe(REWORDED.subject);
    expect(saved.original.subject).toBe('Your {{typeName}} for {{period}} has been submitted');

    expect(await new NotificationRepository(db).wordingFor('SUBMITTED')).toEqual(REWORDED);
  });

  it('is written down in the audit log, against who did it', async () => {
    await send('PUT', '/api/email-wording/SUBMITTED', people.hrOfficer, REWORDED);

    const { rows } = await admin.query<{ action: string; actor_employee_id: string }>(
      "SELECT action, actor_employee_id::text FROM audit_log WHERE entity = 'notification_template'",
    );

    expect(rows).toEqual([{ action: 'CREATE', actor_employee_id: people.hrOfficer }]);
  });

  it('is refused for somebody with no HR role', async () => {
    const response = await send('PUT', '/api/email-wording/SUBMITTED', people.teamLead, REWORDED);

    expect(response.status).toBe(403);
    expect(await new NotificationRepository(db).wordingFor('SUBMITTED')).toBeUndefined();
  });

  it('refuses a placeholder the email cannot fill in, naming the field', async () => {
    const response = await send('PUT', '/api/email-wording/SUBMITTED', people.hrOfficer, {
      ...REWORDED,
      body: 'Hello {{firstNmae}}',
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('body');
  });

  it('answers 404 for an email the system does not send', async () => {
    const response = await send('PUT', '/api/email-wording/BIRTHDAY', people.hrOfficer, REWORDED);

    expect(response.status).toBe(404);
  });
});

describe('previewing and putting back', () => {
  it('fills the wording in on a made up request, and saves nothing', async () => {
    const response = await send(
      'POST',
      '/api/email-wording/SUBMITTED/preview',
      people.hrOfficer,
      REWORDED,
    );
    const filled = (await response.json()) as { subject: string; body: string };

    expect(response.status).toBe(200);
    expect(filled.subject).toBe('We have your request for 2 March 2026 to 10 March 2026');
    expect(await new NotificationRepository(db).wordingFor('SUBMITTED')).toBeUndefined();
  });

  it('puts the original wording back', async () => {
    await send('PUT', '/api/email-wording/SUBMITTED', people.hrOfficer, REWORDED);

    const response = await send('DELETE', '/api/email-wording/SUBMITTED', people.hrOfficer);
    const email = (await response.json()) as JsonEmail;

    expect(response.status).toBe(200);
    expect(email.isReworded).toBe(false);
    expect(email.subject).toBe(email.original.subject);
    expect(await new NotificationRepository(db).wordingFor('SUBMITTED')).toBeUndefined();
  });
});

function send(
  method: string,
  path: string,
  employeeId: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
