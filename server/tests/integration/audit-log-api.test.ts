import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { calendarDateIn, dayAfter, dayBefore, displayTimezone } from '../../src/shared/time.js';
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
import { AuditRepository } from '../../src/features/audit/audit.db.js';
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

/** The audit log screen, over HTTP. NFR AUD 01, NFR AUD 02, LMS 513. */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let people: Record<string, string>;

interface JsonAuditLog {
  entries: {
    entity: string;
    entityLabel: string;
    entityId: string;
    action: string;
    actor: string;
    actorEmployeeId: string | null;
    changes: { field: string; from: unknown; to: unknown }[];
  }[];
  entities: { name: string; label: string }[];
  moreThanShown: boolean;
}

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
    audit: new AuditRepository(db),
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
    expect((await fetch(`${origin}/api/audit`)).status).toBe(401);
  });
});

describe('who may search it', () => {
  it('is an HR Administrator', async () => {
    expect((await send('GET', '/api/audit', people.headOfHr)).status).toBe(200);
  });

  it('is a System Administrator', async () => {
    await grant(people.engineer, 'SYS_ADMIN');

    expect((await send('GET', '/api/audit', people.engineer)).status).toBe(200);
  });

  it('is not an HR Officer, a manager or anybody else, and they are told who is', async () => {
    for (const who of [people.hrOfficer, people.teamLead, people.officer]) {
      const response = await send('GET', '/api/audit', who);

      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toContain('LMS 513');
    }
  });
});

describe('searching by record', () => {
  it('finds every change to one record, with who made it and what moved', async () => {
    await retitle(people.officer, 'Senior Operations Officer', people.headOfHr);

    const log = await search({ entity: 'employee', entityId: people.officer });
    const [latest] = log.entries;

    expect(log.entries.every((one) => one.entityId === people.officer)).toBe(true);
    expect(latest.action).toBe('UPDATE');
    expect(latest.entityLabel).toBe('Employee');
    expect(latest.actorEmployeeId).toBe(people.headOfHr);
    expect(latest.actor).not.toMatch(/^employee \d+$/);
    expect(latest.changes).toEqual([
      { field: 'job_title', from: 'Operations Officer', to: 'Senior Operations Officer' },
    ]);
  });

  it('offers every kind of record the log keeps', async () => {
    const log = await search({});

    expect(log.entities.map((one) => one.name)).toContain('leave_request');
  });

  it('refuses an id without its kind, naming the field', async () => {
    const response = await send('GET', `/api/audit?entityId=${people.officer}`, people.headOfHr);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('entity');
  });
});

describe('searching by date', () => {
  it('finds today’s changes and none outside the period', async () => {
    await retitle(people.officer, 'Senior Operations Officer', people.headOfHr);

    const today = calendarDateIn(new Date(), displayTimezone());
    const narrowed = { entity: 'employee', entityId: people.officer };

    expect((await search({ ...narrowed, from: today, to: today })).entries).not.toHaveLength(0);
    expect((await search({ ...narrowed, from: dayAfter(today) })).entries).toHaveLength(0);
    expect((await search({ ...narrowed, to: dayBefore(today) })).entries).toHaveLength(0);
  });

  it('refuses a period that ends before it starts', async () => {
    const response = await send('GET', '/api/audit?from=2026-03-02&to=2026-03-01', people.headOfHr);

    expect(response.status).toBe(400);
  });
});

describe('read only, NFR AUD 02', () => {
  it('has nowhere to write, even for an administrator', async () => {
    await grant(people.headOfHr, 'SYS_ADMIN');

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await send(method, '/api/audit', people.headOfHr, {});

      expect(response.status).toBe(404);
    }
  });
});

/** Searches as the HR Administrator. */
async function search(asked: Record<string, string>): Promise<JsonAuditLog> {
  const response = await send(
    'GET',
    `/api/audit?${new URLSearchParams(asked).toString()}`,
    people.headOfHr,
  );

  expect(response.status).toBe(200);

  return (await response.json()) as JsonAuditLog;
}

/** Changes a job title, attributed to somebody. */
async function retitle(employeeId: string, jobTitle: string, by: string): Promise<void> {
  await admin.query('BEGIN');
  await admin.query(
    "SELECT set_config('lms.audit.actor', $1, true), set_config('lms.audit.actor_employee_id', $2, true)",
    [`employee ${by}`, by],
  );
  await admin.query('UPDATE employee SET job_title = $1 WHERE id = $2', [jobTitle, employeeId]);
  await admin.query('COMMIT');
}

async function grant(employeeId: string, code: string): Promise<void> {
  await admin.query(
    `INSERT INTO user_role (user_id, role_id)
     SELECT u.id, r.id FROM app_user u, role r WHERE u.employee_id = $1 AND r.code = $2`,
    [employeeId, code],
  );
}

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
