import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { LeaveAlreadyDecided } from '../../src/features/leave-request/leave-decision.js';
import {
  type LeaveRequest,
  LeaveOverlapsAnother,
  NotEnoughDays,
  versionOf,
} from '../../src/features/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
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
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * Concurrency suite. §8.1, §8.2, §12.
 *
 * Races through the service doors, not the balance door. Every test ends on
 * `assertNoDoubleDeduction`.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('concurrency integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** Working Tuesdays, no holidays. One day each. */
const TUESDAYS = [
  '2026-06-02',
  '2026-06-09',
  '2026-06-16',
  '2026-06-23',
  '2026-06-30',
  '2026-07-07',
  '2026-07-14',
  '2026-07-21',
  '2026-07-28',
  '2026-08-11',
];

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    new LeaveRequestRepository(db),
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
  );
});

beforeEach(async () => {
  /** FR 18. Fixture days are behind today. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;
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
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, ' +
      'leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_request',
  );
}

/* --------------------------------------------------------------------- fixtures */

async function grant(days: number): Promise<void> {
  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
    days,
    reason: 'Annual entitlement for 2026',
  });
}

function submit(from: string, to = from) {
  return requests.submit(asAdwoa(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'Family matters',
    acknowledgesShortNotice: true,
  });
}

/** Past the manager, waiting at HR. */
async function waitingOnHr(day: string): Promise<LeaveRequest> {
  const { request } = await submit(day);
  const atHr = await requests.approve(asTheirManager(), request.id);

  expect(atHr.request.awaitingApprovalFrom).toBe('HR');

  return atHr.request;
}

async function balanceNow() {
  return balances.forOne(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
  });
}

async function countOf(entryType: string): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    'SELECT count(*) FROM leave_ledger_entry WHERE entry_type = $1',
    [entryType],
  );

  return Number(rows[0].count);
}

/** At most one DEDUCTION a request, and cache agrees with ledger. */
async function assertNoDoubleDeduction(): Promise<void> {
  const doubled = await admin.query(
    `SELECT leave_request_id FROM leave_ledger_entry
      WHERE entry_type = 'DEDUCTION'
      GROUP BY leave_request_id HAVING count(*) > 1`,
  );
  const disagreeing = await admin.query('SELECT * FROM balances_that_disagree_with_the_ledger');

  expect(doubled.rows).toEqual([]);
  expect(disagreeing.rows).toEqual([]);

  const balance = await balanceNow();

  expect(balance.available).toBeGreaterThanOrEqual(0);
}

function fulfilled<T>(outcomes: PromiseSettledResult<T>[]): T[] {
  return outcomes
    .filter((one): one is PromiseFulfilledResult<T> => one.status === 'fulfilled')
    .map((one) => one.value);
}

function succeeded(outcomes: PromiseSettledResult<unknown>[]): number {
  return outcomes.filter((one) => one.status === 'fulfilled').length;
}

function reasons(outcomes: PromiseSettledResult<unknown>[]): unknown[] {
  return outcomes
    .filter((one): one is PromiseRejectedResult => one.status === 'rejected')
    .map((one) => one.reason);
}

function asAdwoa() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

function asTheOtherOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/* ------------------------------------------ simultaneous submissions. §8.2 */

describe('simultaneous submissions against a thin balance', () => {
  it('lets through only as many as the balance covers', async () => {
    await grant(3);

    const outcomes = await Promise.allSettled(TUESDAYS.map((day) => submit(day)));

    expect(fulfilled(outcomes)).toHaveLength(3);
    expect(fulfilled(outcomes).every(({ request }) => request.days === 1)).toBe(true);

    const refused = reasons(outcomes);

    expect(refused).toHaveLength(TUESDAYS.length - 3);
    refused.forEach((reason) => expect(reason).toBeInstanceOf(NotEnoughDays));

    expect(await countOf('RESERVATION')).toBe(3);
    expect(await balanceNow()).toMatchObject({ pending: 3, available: 0 });

    await assertNoDoubleDeduction();
  });

  it('lets one of two identical submissions through', async () => {
    await grant(5);

    const outcomes = await Promise.allSettled([
      submit('2026-06-08', '2026-06-12'),
      submit('2026-06-08', '2026-06-12'),
    ]);

    expect(succeeded(outcomes)).toBe(1);

    const [reason] = reasons(outcomes);

    expect(reason instanceof NotEnoughDays || reason instanceof LeaveOverlapsAnother).toBe(true);

    expect(await countOf('RESERVATION')).toBe(1);
    expect(await balanceNow()).toMatchObject({ pending: 5, available: 0 });

    await assertNoDoubleDeduction();
  });

  /** Then approved, one by one: still no more deducted than granted. */
  it('and what got through deducts once when approved', async () => {
    await grant(2);

    const through = fulfilled(await Promise.allSettled(TUESDAYS.slice(0, 5).map((d) => submit(d))));

    expect(through).toHaveLength(2);

    for (const { request } of through) {
      await requests.approve(asTheirManager(), request.id);
      await requests.approve(asTheOtherOfficer(), request.id);
    }

    expect(await countOf('DEDUCTION')).toBe(2);
    expect(await balanceNow()).toMatchObject({ taken: 2, pending: 0, available: 0 });

    await assertNoDoubleDeduction();
  });
});

/* -------------------------------------------- simultaneous approvals. §8.1 */

describe('simultaneous approvals of one request', () => {
  beforeEach(async () => {
    await grant(20);
  });

  it('lets one of every HR approver, and a double click, through', async () => {
    const request = await waitingOnHr(TUESDAYS[0]);

    const outcomes = await Promise.allSettled([
      requests.approve(asTheHeadOfHr(), request.id),
      requests.approve(asTheOtherOfficer(), request.id),
      requests.approve(asTheOtherOfficer(), request.id),
      requests.approve(asTheHeadOfHr(), request.id, undefined, versionOf(request)),
    ]);

    expect(succeeded(outcomes)).toBe(1);
    reasons(outcomes).forEach((reason) => expect(reason).toBeInstanceOf(LeaveAlreadyDecided));

    expect(await countOf('DEDUCTION')).toBe(1);
    expect(await balanceNow()).toMatchObject({ taken: 1, pending: 0 });

    await assertNoDoubleDeduction();
  });

  it('lets one of a single and a bulk approval through', async () => {
    const request = await waitingOnHr(TUESDAYS[0]);

    const [single, bulk] = await Promise.allSettled([
      requests.approve(asTheHeadOfHr(), request.id),
      requests.decideMany(asTheOtherOfficer(), {
        action: 'APPROVE',
        comment: null,
        requests: [{ requestId: request.id, version: versionOf(request) }],
      }),
    ]);

    expect(bulk.status).toBe('fulfilled');

    const decidedInBulk = bulk.status === 'fulfilled' ? bulk.value.decided.length : 0;

    expect((single.status === 'fulfilled' ? 1 : 0) + decidedInBulk).toBe(1);

    expect(await countOf('DEDUCTION')).toBe(1);
    expect(await balanceNow()).toMatchObject({ taken: 1, pending: 0 });

    await assertNoDoubleDeduction();
  });

  it('moves the days once when an approval meets a withdrawal', async () => {
    const request = await waitingOnHr(TUESDAYS[0]);

    const outcomes = await Promise.allSettled([
      requests.approve(asTheHeadOfHr(), request.id),
      requests.withdraw(asAdwoa(), request.id),
    ]);

    expect(succeeded(outcomes)).toBe(1);

    const settled = await requests.byId(system, request.id);
    const approved = settled.status === 'APPROVED';

    expect(['APPROVED', 'WITHDRAWN']).toContain(settled.status);
    expect(await countOf('DEDUCTION')).toBe(approved ? 1 : 0);
    expect(await countOf('RELEASE')).toBe(approved ? 0 : 1);
    expect(await balanceNow()).toMatchObject({ taken: approved ? 1 : 0, pending: 0 });

    await assertNoDoubleDeduction();
  });
});

/* -------------------------------------------------- both at once. §8.1, §8.2 */

describe('approvals and submissions on one balance at once', () => {
  it('neither deadlocks nor double deducts', async () => {
    await grant(3);

    const first = await waitingOnHr(TUESDAYS[0]);
    const second = await waitingOnHr(TUESDAYS[1]);

    const outcomes = await Promise.allSettled([
      requests.approve(asTheHeadOfHr(), first.id),
      requests.approve(asTheOtherOfficer(), first.id),
      requests.approve(asTheOtherOfficer(), second.id),
      requests.approve(asTheHeadOfHr(), second.id),
      ...TUESDAYS.slice(2, 6).map((day) => submit(day)),
    ]);

    const approvals = outcomes.slice(0, 4);
    const submissions = outcomes.slice(4);

    expect(succeeded(approvals)).toBe(2);
    reasons(approvals).forEach((reason) => expect(reason).toBeInstanceOf(LeaveAlreadyDecided));

    expect(succeeded(submissions)).toBe(1);
    reasons(submissions).forEach((reason) => expect(reason).toBeInstanceOf(NotEnoughDays));

    expect(await countOf('DEDUCTION')).toBe(2);
    expect(await balanceNow()).toMatchObject({ taken: 2, pending: 1, available: 0 });

    await assertNoDoubleDeduction();
  });
});
