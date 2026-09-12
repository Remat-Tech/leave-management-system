import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { type Actor, signedInAs, theSystem } from '../../src/auth/actor.js';
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

/** HR reporting over HTTP, against a real ledger. FR 63, LMS 510. */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const guard = new Guard();
const system = theSystem('reports api fixtures');

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let movements: BalanceService;
let leaveRequests: LeaveRequestService;
let people: Record<string, string>;

let y2026: string;
let annualId: string;

interface JsonLiabilityLine {
  leaveTypeId: string;
  people: number;
  entitled: number;
  taken: number;
  unused: number;
}

interface JsonLiability {
  year: { id: string; label: string };
  years: { id: string }[];
  departments: { name: string; headcount: number; lines: JsonLiabilityLine[] }[];
  company: JsonLiabilityLine[];
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const requestRows = new LeaveRequestRepository(db);

  movements = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));

  leaveRequests = new LeaveRequestService(
    movements,
    guard,
    employees,
    types,
    years,
    requestRows,
    decisions,
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    roles,
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    ledger: new LedgerRepository(db),
    adjustments: movements,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: requestRows,
    leaveRequests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
    holidayRecalculations: holidayRecalculationService(db, guard, movements),
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
  /* FR 18. The fixture days are months behind today. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, ' +
      'leave_request_reclassification, leave_request_attachment, leave_request_decision, ' +
      'leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
  );

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await admin.query<{ id: string }>("SELECT id FROM leave_year WHERE label = '2026'"))
    .rows[0].id;
  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
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

describe('who may read them', () => {
  it('needs a session', async () => {
    expect((await fetch(`${origin}/api/reports/liability`)).status).toBe(401);
  });

  it('is HR, and anybody else is told why not', async () => {
    const refused = await get('/api/reports/overdue-requests', people.engineer);

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain('HR’s');

    expect((await get('/api/reports/overdue-requests', people.hrOfficer)).status).toBe(200);
  });
});

describe('leave liability by department', () => {
  it('is the unused days a real ledger holds, per department and for the company', async () => {
    await twentyDaysFor(people.engineer);
    await twentyDaysFor(people.opsManager);
    await approvedLeaveFor(people.engineer);

    const report = await json<JsonLiability>(`/api/reports/liability?leaveYearId=${y2026}`);
    const engineering = report.departments.find((one) => one.name === 'Product & Engineering');

    expect(report.year.label).toBe('2026');
    expect(report.years.length).toBeGreaterThan(0);
    expect(engineering?.lines.find((line) => line.leaveTypeId === annualId)).toMatchObject({
      people: 1,
      entitled: 20,
      taken: 6,
      unused: 14,
    });
    expect(report.company.find((line) => line.leaveTypeId === annualId)).toMatchObject({
      people: 2,
      unused: 34,
    });
  });
});

describe('leave taken by type and period', () => {
  it('counts approved days in the month they start', async () => {
    await twentyDaysFor(people.engineer);
    await approvedLeaveFor(people.engineer);

    const report = await json<{
      months: string[];
      lines: { leaveTypeId: string; requests: number; days: number; byMonth: number[] }[];
    }>('/api/reports/leave-taken?from=2026-03-01&to=2026-04-30');

    expect(report.months).toEqual(['2026-03', '2026-04']);
    expect(report.lines.find((line) => line.leaveTypeId === annualId)).toMatchObject({
      requests: 1,
      days: 6,
      byMonth: [6, 0],
    });
  });

  it('refuses a period that ends before it starts, naming the field', async () => {
    const answer = await get(
      '/api/reports/leave-taken?from=2026-04-01&to=2026-03-01',
      people.headOfHr,
    );

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { field: string }).field).toBe('to');
  });
});

describe('requests pending beyond the agreed turnaround', () => {
  it('lists a request waiting longer than the turnaround, and not one inside it', async () => {
    await twentyDaysFor(people.engineer);
    const id = await askForLeave(people.engineer);

    const fresh = await json<{ requests: { requestId: string }[] }>(
      '/api/reports/overdue-requests?turnaroundDays=5',
    );

    expect(fresh.requests).toEqual([]);

    await submittedDaysAgo(id, 10);

    const aged = await json<{
      turnaroundDays: number;
      requests: { requestId: string; daysWaiting: number; awaiting: string; name: string }[];
    }>('/api/reports/overdue-requests?turnaroundDays=5');

    expect(aged.turnaroundDays).toBe(5);
    expect(aged.requests).toEqual([
      expect.objectContaining({
        requestId: id,
        daysWaiting: 10,
        awaiting: 'MANAGER',
        name: 'Yram Kudjo',
      }),
    ]);
  });

  it('refuses a turnaround that is not a whole number of days', async () => {
    const answer = await get('/api/reports/overdue-requests?turnaroundDays=soon', people.headOfHr);

    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { field: string }).field).toBe('turnaroundDays');
  });
});

describe('zero leave taken, and carried over balances', () => {
  it('names somebody given days who took none', async () => {
    await twentyDaysFor(people.engineer);

    const report = await json<{ zero: { employeeId: string; leaveTypeId: string }[] }>(
      `/api/reports/usage?leaveYearId=${y2026}`,
    );

    expect(report.zero).toContainEqual(
      expect.objectContaining({ employeeId: people.engineer, leaveTypeId: annualId }),
    );
  });

  it('lists no carried balance where nothing was carried', async () => {
    await twentyDaysFor(people.engineer);

    const report = await json<{ year: { label: string }; balances: unknown[] }>(
      `/api/reports/carried-over?leaveYearId=${y2026}`,
    );

    expect(report.year.label).toBe('2026');
    expect(report.balances).toEqual([]);
  });
});

describe('filters and export. FR 58, FR 64, LMS 511', () => {
  it('narrows a report to one department and lists what may be chosen', async () => {
    await twentyDaysFor(people.engineer);
    await twentyDaysFor(people.opsManager);
    const engineering = await departmentIdOf('Product & Engineering');

    const report = await json<JsonLiability & { choices: { departments: { id: string }[] } }>(
      `/api/reports/liability?leaveYearId=${y2026}&departmentId=${engineering}`,
    );

    expect(report.departments.map((one) => one.name)).toEqual(['Product & Engineering']);
    expect(report.company.find((line) => line.leaveTypeId === annualId)?.people).toBe(1);
    expect(report.choices.departments).toContainEqual(expect.objectContaining({ id: engineering }));
  });

  it('saves a report as CSV, with the same filters', async () => {
    await twentyDaysFor(people.engineer);

    const answer = await get(
      `/api/reports/liability/export?format=csv&leaveYearId=${y2026}&leaveTypeId=${annualId}`,
      people.headOfHr,
    );
    const text = await answer.text();

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('text/csv');
    expect(answer.headers.get('content-disposition')).toBe(
      'attachment; filename="leave-liability-2026.csv"',
    );
    expect(text).toContain('Department,Leave type,Counted in,People');
    expect(text).toContain('Product & Engineering,Annual Leave');
  });

  it('saves a report as XLSX', async () => {
    const answer = await get('/api/reports/overdue-requests/export?format=xlsx', people.headOfHr);
    const bytes = Buffer.from(await answer.arrayBuffer());

    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('refuses a format it does not write, and an export to anybody but HR', async () => {
    const wrong = await get('/api/reports/usage/export?format=pdf', people.headOfHr);

    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { field: string }).field).toBe('format');
    expect((await get('/api/reports/usage/export?format=csv', people.engineer)).status).toBe(403);
  });

  it('refuses a department that does not exist', async () => {
    const answer = await get(
      '/api/reports/usage?departmentId=00000000-0000-0000-0000-000000000000',
      people.headOfHr,
    );

    expect(answer.status).toBe(404);
  });

  it('lets an employee save their own balances and requests', async () => {
    await twentyDaysFor(people.engineer);
    await askForLeave(people.engineer);

    const balances = await get(
      `/api/me/balances/export?format=csv&leaveYearId=${y2026}`,
      people.engineer,
    );
    const requests = await get('/api/me/requests/export?format=xlsx', people.engineer);

    expect(balances.status).toBe(200);
    expect(await balances.text()).toMatch(/Annual Leave,[^\r\n]*,20,/);
    expect(requests.status).toBe(200);
    expect(requests.headers.get('content-disposition')).toContain(
      'my-leave-requests-all-years.xlsx',
    );
  });
});

/* --------------------------------------------------------------------- helpers */

async function departmentIdOf(name: string): Promise<string> {
  return (await admin.query<{ id: string }>('SELECT id FROM department WHERE name = $1', [name]))
    .rows[0].id;
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

async function json<T>(path: string): Promise<T> {
  const answer = await get(path, people.headOfHr);

  expect(answer.status).toBe(200);

  return (await answer.json()) as T;
}

async function twentyDaysFor(employeeId: string): Promise<void> {
  await movements.grantTheYear(system, {
    employeeId,
    leaveTypeId: annualId,
    leaveYearId: y2026,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
}

async function askForLeave(
  employeeId: string,
  from = '2026-11-02',
  to = '2026-11-06',
): Promise<string> {
  const { request } = await leaveRequests.submit(asTheEngineer(), {
    employeeId,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'My sister is getting married',
    acknowledgesShortNotice: true,
  });

  return request.id;
}

/** Six days in March through the whole chain. */
async function approvedLeaveFor(employeeId: string): Promise<void> {
  const id = await askForLeave(employeeId, '2026-03-02', '2026-03-10');

  await leaveRequests.approve(asTheHeadOfEngineering(), id);
  await leaveRequests.approve(asTheHeadOfHr(), id);
}

/** Ages a request. `submitted_at` is frozen, so its guard is lifted for the one update. */
async function submittedDaysAgo(id: string, days: number): Promise<void> {
  await admin.query('ALTER TABLE leave_request DISABLE TRIGGER leave_request_says_what_it_said');

  try {
    await admin.query(
      `UPDATE leave_request SET submitted_at = now() - make_interval(days => $2) WHERE id = $1`,
      [id, days],
    );
  } finally {
    await admin.query('ALTER TABLE leave_request ENABLE TRIGGER leave_request_says_what_it_said');
  }
}

function asTheEngineer(): Actor {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheHeadOfEngineering(): Actor {
  return signedInAs(people.headOfEngineering, { roles: ['EMPLOYEE'], isManager: true });
}

function asTheHeadOfHr(): Actor {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}
