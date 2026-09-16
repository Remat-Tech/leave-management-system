import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import type { CarryoverExpiryRun } from '../../src/features/leave-year/carryover-expiry.js';
import { CarryoverExpiry } from '../../src/features/leave-year/carryover-expiry.job.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { EntitlementRuleService } from '../../src/features/entitlement/entitlement-rule.service.js';
import {
  earliestOpenDayFrom,
  LeaveYearService,
} from '../../src/features/leave-year/leave-year.service.js';
import { seed } from '../../seeds/seed.mjs';

/** Carried annual leave expiring at the end of June, against the migrated rule. FR 36a. */

const testDatabaseUrl = await databaseForThisFile();

const nightly = theSystem('the carryover expiry');
const system = theSystem('carryover expiry integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let job: CarryoverExpiry;
let balances: BalanceService;
let entitlements: EntitlementRuleService;
let people: Record<string, string>;

let y2026: LeaveYear;
let y2027: LeaveYear;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const yearRows = new LeaveYearRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  entitlements = new EntitlementRuleService(
    new EntitlementRuleRepository(db),
    guard,
    earliestOpenDayFrom(yearRows),
  );

  job = new CarryoverExpiry(
    balances,
    new BalanceRepository(db),
    entitlements,
    yearRows,
    employees,
    new LeaveTypeRepository(db),
  );

  const years = new LeaveYearService(yearRows, guard);
  y2026 = (await years.byLabel(system, '2026'))!;
  y2027 = (await years.byLabel(system, '2027'))!;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE leave_request_recalculation, leave_entitlement_event, leave_ledger_entry',
  );

  people = (await seed(admin)) as Record<string, string>;

  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

async function carries(days: number, year: LeaveYear = y2027): Promise<void> {
  await balances.carryForward(asAdministrator(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: year.id,
    days,
    reason: `${days} days carried for the expiry suite`,
  });
}

/** Holds `days` from a month into the year; approves them unless `pending`. */
async function books(days: number, pending = false, month = 0): Promise<void> {
  const { rows } = await admin.query<{ start_date: string; end_date: string }>(
    `SELECT (start_date + make_interval(months => $3))::date AS start_date,
            (start_date + make_interval(months => $3))::date + ($2::int - 1) AS end_date
       FROM leave_year WHERE id = $1`,
    [y2027.id, days, month],
  );

  const movement = {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2027.id,
    days,
    reason: `${days} days of 2027 annual leave`,
  };

  const { request } = await balances.reserveForRequest(asAdministrator(), {
    request: {
      ...movement,
      from: rows[0].start_date,
      to: rows[0].end_date,
      lateEntryReason: null,
      evidenceRequired: false,
      certifiedDays: 0,
      countingBasis: 'CALENDAR_DAYS' as const,
      calendarDays: days,
      status: 'SUBMITTED' as const,
      awaitingApprovalFrom: 'MANAGER' as const,
      skips: [],
    },
    reason: movement.reason,
  });

  if (!pending) {
    await balances.commit(asAdministrator(), { ...movement, leaveRequestId: request.id });
  }
}

function officer2027() {
  return balances.forOne(asAdministrator(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2027.id,
  });
}

async function expiries(): Promise<Record<string, unknown>[]> {
  return (await admin.query("SELECT * FROM leave_ledger_entry WHERE entry_type = 'EXPIRY'")).rows;
}

function outcomeFor(run: CarryoverExpiryRun, leaveYearLabel = '2027') {
  const match = (one: { employeeId: string; leaveYearLabel: string }) =>
    one.employeeId === people.officer && one.leaveYearLabel === leaveYearLabel;

  return run.expired.find(match) ?? run.notExpired.find(match);
}

describe('carried annual leave expires at the end of June', () => {
  it('is what the migrated rule says for days carried into 2027', async () => {
    const employee = (await new EmployeeRepository(db).findById(people.officer))!;
    const rule = await entitlements.entitlementOn(system, employee, annualId, '2027-01-01');

    expect(rule).toMatchObject({ entitlementDays: 20, carriesOver: true, carryoverExpiryMonth: 6 });
  });

  it('expires nothing up to and including 30 June', async () => {
    await carries(8);

    const run = await job.run(nightly, '2027-06-30');

    expect(outcomeFor(run)).toMatchObject({ because: 'NOT_YET' });
    expect(await expiries()).toHaveLength(0);
  });

  it('expires whatever taken leave did not use, from 1 July', async () => {
    await carries(8);
    await books(3);

    const run = await job.run(nightly, '2027-07-01');

    expect(outcomeFor(run)).toMatchObject({ days: 5, deadline: '2027-06-30' });
    expect(await officer2027()).toMatchObject({ carriedOver: 3, taken: 3, available: 0 });
    expect((await expiries())[0].reason).toBe(
      'Annual Leave carried into 2027 and not used by 2027-06-30 expired. FR 36a',
    );
  });

  /* Leave asked for by the deadline uses carried days whatever its dates. */
  it('counts leave still pending as having used them', async () => {
    await carries(8);
    await books(8, true);

    const run = await job.run(nightly, '2027-07-01');

    expect(outcomeFor(run)).toMatchObject({ because: 'NOTHING_LEFT' });
    expect(await expiries()).toHaveLength(0);
  });

  it('changes nothing when run again', async () => {
    await carries(8);
    await books(3);
    await job.run(nightly, '2027-07-01');

    const again = await job.run(nightly, '2027-07-02');

    expect(outcomeFor(again)).toMatchObject({ because: 'NOTHING_LEFT' });
    expect(await expiries()).toHaveLength(1);
  });

  it('expires days a request gives back after the deadline on the next run', async () => {
    await carries(8);
    await books(3);
    await books(5, true, 7);
    await job.run(nightly, '2027-07-01');

    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM leave_request WHERE employee_id = $1 AND status = 'SUBMITTED'`,
      [people.officer],
    );
    await balances.release(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2027.id,
      days: 5,
      reason: 'Withdrawn in July',
      leaveRequestId: rows[0].id,
    });

    const again = await job.run(nightly, '2027-07-10');

    expect(outcomeFor(again)).toMatchObject({ days: 5 });
    expect(await officer2027()).toMatchObject({ carriedOver: 3, taken: 3, available: 0 });
  });

  it('leaves days carried into 2026 alone, because the rule then named no month', async () => {
    await carries(4, y2026);

    const run = await job.run(nightly, '2026-07-01');

    expect(outcomeFor(run, '2026')).toMatchObject({ because: 'NEVER_EXPIRES' });
    expect(await expiries()).toHaveLength(0);
  });

  it('is posted only by an HR Administrator', async () => {
    await carries(8);

    await expect(
      balances.expireCarriedOver(
        signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false }),
        {
          employeeId: people.officer,
          leaveTypeId: annualId,
          leaveYearId: y2027.id,
          days: 8,
          reason: 'An officer trying',
        },
      ),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });
});
