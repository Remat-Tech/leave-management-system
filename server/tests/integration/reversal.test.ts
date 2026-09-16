import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { calendarDateIn } from '../../src/shared/time.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { ReversalRepository } from '../../src/features/leave-request/reversal.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { RequestHistoryService } from '../../src/features/leave-request/request-history.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/** The Chief Executive reversing a settled request, against a real database. */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('reversal integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let history: RequestHistoryService;
let balances: BalanceService;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const routing = new LeaveRoutingRepository(db);
  const withdrawals = new WithdrawalRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    requestRepository,
    decisions,
    routing,
    withdrawals,
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  history = new RequestHistoryService(
    requestRepository,
    decisions,
    guard,
    employees,
    types,
    yearRepository,
    routing,
    withdrawals,
    new ReversalRepository(db),
  );
});

beforeEach(async () => {
  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await balances.grantTheYear(system, {
    ...theBalance(),
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
});

afterAll(async () => {
  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_request',
  );
}

function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return calendarDateIn(day, 'UTC');
}

function theBalance() {
  return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id };
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asTheChiefExecutive() {
  return signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true, isChiefExecutive: true });
}

async function aRequest(offset = 7): Promise<string> {
  const { request } = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: daysFromToday(offset),
    to: daysFromToday(offset + 4),
    reason: 'A week away',
    acknowledgesShortNotice: true,
  });

  return request.id;
}

async function anApprovedRequest(offset = 7): Promise<string> {
  const id = await aRequest(offset);

  await requests.approve(asTheirManager(), id);
  await requests.approve(asAnHrOfficer(), id);

  return id;
}

async function aRefusedRequest(): Promise<string> {
  const id = await aRequest();

  await requests.refuse(asTheirManager(), id, 'Too busy that week');
  await requests.refuse(asAnHrOfficer(), id, 'Agreed, too busy');

  return id;
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await admin.query<{ status: string }>(
    'SELECT status FROM leave_request WHERE id = $1',
    [id],
  );

  return rows[0].status;
}

async function entryTypesFor(id: string): Promise<string[]> {
  const { rows } = await admin.query<{ entry_type: string }>(
    'SELECT entry_type FROM leave_ledger_entry WHERE leave_request_id = $1 ORDER BY id',
    [id],
  );

  return rows.map((row) => row.entry_type);
}

async function available(): Promise<number> {
  return (await balances.forOne(system, theBalance())).available;
}

describe('reversing an approval', () => {
  it('turns the leave down and gives every day back', async () => {
    const before = await available();
    const id = await anApprovedRequest();

    expect(await available()).toBeLessThan(before);

    const reversed = await requests.reverse(asTheChiefExecutive(), id, 'Needed for the audit');

    expect(reversed.request.status).toBe('REFUSED');
    expect(reversed.reversal.action).toBe('REVERSE_APPROVAL');
    expect(await available()).toBe(before);
    expect(await entryTypesFor(id)).toEqual(['RESERVATION', 'DEDUCTION', 'RECALCULATION']);
  });

  it('but not once the leave has started', async () => {
    const id = await anApprovedRequest(-1);

    await expect(
      requests.reverse(asTheChiefExecutive(), id, 'Needed for the audit'),
    ).rejects.toMatchObject({ code: 'TOO_LATE_TO_REVERSE' });

    expect(await statusOf(id)).toBe('APPROVED');
  });
});

describe('reversing a refusal', () => {
  it('approves the leave and takes the days', async () => {
    const before = await available();
    const id = await aRefusedRequest();

    expect(await available()).toBe(before);

    const reversed = await requests.reverse(asTheChiefExecutive(), id, 'It can be covered');

    expect(reversed.request.status).toBe('APPROVED');
    expect(await available()).toBe(before - reversed.request.days);
    expect(await entryTypesFor(id)).toEqual(['RESERVATION', 'RELEASE', 'RESERVATION', 'DEDUCTION']);
  });

  it('but not where there are not enough days left', async () => {
    const id = await aRefusedRequest();

    await balances.adjust(system, {
      ...theBalance(),
      days: -19,
      reason: 'Most of the year spent elsewhere',
    });

    await expect(
      requests.reverse(asTheChiefExecutive(), id, 'It can be covered'),
    ).rejects.toMatchObject({ name: 'BalanceOverdrawn' });

    expect(await statusOf(id)).toBe('REFUSED');
  });
});

describe('the rules around it', () => {
  it('happens once', async () => {
    const id = await aRefusedRequest();

    await requests.reverse(asTheChiefExecutive(), id, 'It can be covered');

    await expect(
      requests.reverse(asTheChiefExecutive(), id, 'Changed my mind again'),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('needs a reason', async () => {
    const id = await anApprovedRequest();

    await expect(requests.reverse(asTheChiefExecutive(), id, '  ')).rejects.toMatchObject({
      code: 'REVERSAL_NEEDS_A_REASON',
    });
  });

  it('is the Chief Executive’s alone', async () => {
    const id = await anApprovedRequest();

    for (const actor of [asAnHrOfficer(), asTheirManager(), asTheEmployee()]) {
      await expect(requests.reverse(actor, id, 'Not mine to do')).rejects.toThrow(NotAuthorised);
    }

    expect(await statusOf(id)).toBe('APPROVED');
  });

  it('leaves a request still being decided alone', async () => {
    const id = await aRequest();

    await expect(requests.reverse(asTheChiefExecutive(), id, 'Too early')).rejects.toMatchObject({
      code: 'NOTHING_TO_REVERSE',
    });
  });

  it('tells the person, their manager and HR', async () => {
    const id = await anApprovedRequest();

    await requests.reverse(asTheChiefExecutive(), id, 'Needed for the audit');

    const { rows } = await admin.query<{ employee_id: string }>(
      "SELECT employee_id FROM notification WHERE event = 'DECISION_REVERSED'",
    );
    const told = rows.map((row) => row.employee_id);

    expect(told).toContain(people.officer);
    expect(told).toContain(people.teamLead);
    expect(told).toContain(people.hrOfficer);
    expect(told).not.toContain(people.ceo);
  });

  it('and the database refuses a reversal nobody recorded', async () => {
    const id = await anApprovedRequest();

    await expect(
      admin.query("UPDATE leave_request SET status = 'REFUSED' WHERE id = $1", [id]),
    ).rejects.toThrow();
  });
});

describe('everybody’s leave', () => {
  it('is on one page for the Chief Executive, with the reversal on the trail', async () => {
    const id = await anApprovedRequest();

    await requests.reverse(asTheChiefExecutive(), id, 'Needed for the audit');

    const everyone = await history.forEveryone(asTheChiefExecutive(), {
      leaveYearId: y2026.id,
    });
    const entry = everyone.entries.find((one) => one.requestId === id);

    expect(entry).toMatchObject({ employeeId: people.officer, reversed: true, status: 'REFUSED' });
    expect(entry?.trail.map((step) => step.kind)).toContain('REVERSED');
  });

  it('and nobody else’s', async () => {
    await expect(history.forEveryone(asAnHrOfficer())).rejects.toThrow(NotAuthorised);
  });
});
