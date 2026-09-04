import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { AlreadyCarried } from '../../src/features/balance/balance.js';
import { type LeaveYear, LeaveYearNotFinished } from '../../src/features/leave-year/leave-year.js';
import {
  daysCarried,
  needsAttention,
  type YearRolloverRun,
} from '../../src/features/leave-year/year-rollover.js';
import {
  LeaveYearAheadIsClosed,
  NoLeaveYearAhead,
  YearRollover,
} from '../../src/features/leave-year/year-rollover.job.js';
import { AnnualGrant } from '../../src/features/entitlement/annual-grant.job.js';
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

/**
 * The year rollover, against a real database. FR 36, FR 36a, §11. LMS 217.
 *
 * ../unit/year-rollover.test.ts proves what carries and what does not, which is a pure
 * function. What needs a server is the half a pure function cannot have, and for this
 * story it is the two criteria the whole job exists for:
 *
 *   **Three acts, in an order that has to be that order.** Close the year that ended,
 *   carry what is left of it, grant the year that began. Closing first is what makes the
 *   figures final, and the only way to show that it happened is to look at the rows
 *   afterwards: a settled year, a `CARRY_FORWARD` in the year ahead of it, and a `GRANT`
 *   beside it.
 *
 *   **Running it twice changes nothing.** Not "does no harm" — nothing at all: the same
 *   ledger, the same balances, and a report that says line by line that it did nothing.
 *   That is the property somebody needs on the morning the first run stopped at employee
 *   three hundred, and it is a claim about a lock and a database rather than about care.
 *
 * ## The fixture rolls 2025 into 2026, and that is not a convenience
 *
 * A year can only be closed once it has ended, so the year being rolled has to be in the
 * past — which means the suite defines 2025 and gives it entitlement rules of its own.
 * That turns out to be the honest fixture rather than a workaround: it is the only shape
 * in which the resolution date can be seen at all. A rule effective from 2026 says
 * nothing about days earned in 2025, and FR 31 says it must not be allowed to — which is
 * a test below rather than a sentence in a comment.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, which is what the first of January is. */
const firstOfJanuary = theSystem('the year rollover');
const system = theSystem('year rollover integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let job: YearRollover;
let balances: BalanceService;
let entitlements: EntitlementRuleService;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2025: LeaveYear;
let y2026: LeaveYear;
let y2027: LeaveYear;
let annualId: string;
let sickId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(new LeaveYearRepository(db), guard);
  entitlements = new EntitlementRuleService(
    new EntitlementRuleRepository(db),
    guard,
    earliestOpenDayFrom(new LeaveYearRepository(db)),
  );

  job = new YearRollover(
    balances,
    years,
    entitlements,
    new AnnualGrant(balances, years, entitlements, employees, types),
    employees,
    types,
  );

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await withoutTheExtraType();
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0]
    .id as string;

  await aYearBefore();

  y2025 = (await years.byLabel(system, '2025'))!;
  y2026 = (await years.byLabel(system, '2026'))!;
  y2027 = (await years.byLabel(system, '2027'))!;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await withoutTheExtraType();
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/**
 * Removes the quota type one test below adds.
 *
 * `leave_type` is the one fixture table this suite writes to that nothing truncates
 * between files — the seven types are the migration's and every suite reads them as
 * given. A type left behind here would be an eighth one that `integration/leave-type.test.ts`
 * finds and cannot account for, which is a failure two files away from its cause.
 *
 * On the owner connection, because `lms_app` holds no DELETE on this table: a leave type
 * is the heading a report is filed under, and the application retires one rather than
 * removing it. That rule is the point, and a test fixture is exactly the exception the
 * owner connection exists for.
 */
async function withoutTheExtraType(): Promise<void> {
  await admin.query("DELETE FROM leave_type WHERE code = 'STUDY'");
}

/** The leave years as the migration left them. The same shape ./ledger.test.ts uses. */
async function restoreYears(): Promise<void> {
  const columns = Object.keys(seededYears[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await admin.query('TRUNCATE leave_year CASCADE');

  for (const row of seededYears) {
    await admin.query(
      `INSERT INTO leave_year (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('leave_year_id_seq', (SELECT max(id) FROM leave_year))`);
}

/**
 * 2025, open, with entitlement figures of its own.
 *
 * The year on the owner connection because it abuts the run the migration seeded and the
 * service's own rules are about the years as they stand; the figures through the service,
 * because they are exactly the rows HR would have written and because the resolution date
 * is the thing half this suite is about.
 *
 * Annual leave carries over, uncapped, which is FR 36a. Sick leave does not, which is
 * the story's third criterion — and it is stated here as a column rather than anywhere in
 * the code that reads it.
 */
async function aYearBefore(): Promise<void> {
  await admin.query(
    `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
  );

  await entitlements.create(asAdministrator(), {
    leaveTypeId: annualId,
    entitlementDays: 20,
    prorateOnJoin: true,
    carriesOver: true,
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-12-31',
    note: 'The 2025 annual figure, for the rollover suite',
  });

  await entitlements.create(asAdministrator(), {
    leaveTypeId: sickId,
    entitlementDays: 3,
    carriesOver: false,
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-12-31',
    note: 'The 2025 sick figure, for the rollover suite',
  });
}

/** Grants 2025 to everybody, so that there is something to carry. */
async function grant2025(): Promise<void> {
  await new AnnualGrant(
    balances,
    years,
    entitlements,
    new EmployeeRepository(db),
    new LeaveTypeRepository(db),
  ).run(system, y2025.id);
}

/** Approves `days` of the officer's 2025 annual leave, so her remainder is not the whole. */
async function takes(days: number): Promise<void> {
  const movement = {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2025.id,
    days,
    reason: `${days} days of 2025 annual leave`,
  };

  await takeDays(movement);
}

/** Holds `days` without approving them, so a request is still pending when the year ends. */
async function asksFor(days: number): Promise<void> {
  await holdDays({
    employeeId: people.partTimer,
    leaveTypeId: annualId,
    leaveYearId: y2025.id,
    days,
    reason: `${days} days asked for in December and never decided`,
  });
}

/**
 * Days taken, the way they are actually taken since LMS 301.
 *
 * A RESERVATION has to name a request and a request has to hold days, so "five days
 * gone" is no longer one call — it is a request that holds them and an approval that
 * turns the hold into days taken. The period runs from the first day of the leave year
 * so that any figure is a period the table accepts; what these tests are about is the
 * balance rather than the counting.
 */
async function takeDays(movement: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  days: number;
  reason: string;
}): Promise<void> {
  const { request } = await holdDays(movement);

  await balances.commit(asAdministrator(), { ...movement, leaveRequestId: request.id });
}

/** The holding half of {@link takeDays}, for leave nobody has decided yet. */
async function holdDays(movement: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  days: number;
  reason: string;
}) {
  const { rows } = await admin.query<{ start_date: string; end_date: string }>(
    `SELECT start_date, start_date + ($2::int - 1) AS end_date FROM leave_year WHERE id = $1`,
    [movement.leaveYearId, movement.days],
  );

  return balances.reserveForRequest(asAdministrator(), {
    request: {
      employeeId: movement.employeeId,
      leaveTypeId: movement.leaveTypeId,
      leaveYearId: movement.leaveYearId,
      from: rows[0].start_date,
      to: rows[0].end_date,
      reason: movement.reason,
      /** FR 18, LMS 308. */
      lateEntryReason: null,
      evidenceRequired: false,
      countingBasis: 'CALENDAR_DAYS' as const,
      days: movement.days,
      calendarDays: movement.days,
      status: 'SUBMITTED' as const,
      /* FR 38a. Where a request starts, which `LeaveRequestService` reads off the leave
         type's chain. This fixture goes straight to the door, so it says it. LMS 314. */
      awaitingApprovalFrom: 'MANAGER' as const,
      /** FR 48b. Nothing to skip: every desk can be asked. LMS 320. */
      skips: [],
    },
    reason: movement.reason,
  });
}
function balanceOf(employeeId: string, leaveTypeId: string, leaveYearId: string) {
  return balances.forOne(asAdministrator(), { employeeId, leaveTypeId, leaveYearId });
}

/** Every ledger entry of one kind, oldest first. */
async function entriesOfType(entryType: string): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query(
    'SELECT * FROM leave_ledger_entry WHERE entry_type = $1 ORDER BY id',
    [entryType],
  );

  return rows as Record<string, unknown>[];
}

/** Everything in the ledger, as a fingerprint two runs can be compared by. */
async function theWholeLedger(): Promise<unknown[]> {
  const { rows } = await admin.query(
    `SELECT employee_id, leave_type_id, leave_year_id, entry_type, days, reason
       FROM leave_ledger_entry ORDER BY id`,
  );

  return rows;
}

function carryFor(run: YearRolloverRun, employeeId: string, leaveTypeId: string) {
  return run.carried.find(
    (carry) => carry.employeeId === employeeId && carry.leaveTypeId === leaveTypeId,
  );
}

function notCarriedFor(run: YearRolloverRun, employeeId: string, leaveTypeId: string) {
  return run.notCarried.find(
    (one) => one.employeeId === employeeId && one.leaveTypeId === leaveTypeId,
  );
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/* ---------------------------------------------------------------- the three acts */

describe('a rollover closes a year, carries it forward, and grants the next', () => {
  it('closes the year that ended', async () => {
    const run = await job.run(firstOfJanuary, y2025.id);

    expect(run.closed).toBe('CLOSED_BY_THIS_RUN');
    expect((await years.byId(system, y2025.id)).isClosed).toBe(true);
  });

  /**
   * The story, as one employee's balance.
   *
   * Adwoa was granted twenty days of annual leave for 2025 and took sixteen. On the
   * second of January the four she never got round to are in her 2026 balance, and the
   * twenty the new year is worth are there beside them.
   */
  it('and the days somebody did not take are in the new year, beside the new year’s own', async () => {
    await grant2025();
    await takes(16);

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(carryFor(run, people.officer, annualId)?.days).toBe(4);

    const balance = await balanceOf(people.officer, annualId, y2026.id);

    expect(balance.carriedOver).toBe(4);
    expect(balance.entitled).toBe(20);
    expect(balance.available).toBe(24);
  });

  /* Not a figure written into `leave_balance` — nothing above the database may write one
     at all — but a row with a reason on it that names where the days came from. FR 27. */
  it('and each carry is a CARRY_FORWARD entry naming both years', async () => {
    await grant2025();
    await takes(16);
    await job.run(firstOfJanuary, y2025.id);

    const carried = await entriesOfType('CARRY_FORWARD');

    expect(carried.length).toBeGreaterThan(0);
    for (const entry of carried) {
      expect(entry.leave_year_id).toBe(y2026.id);
      expect(entry.reason).toMatch(/^Unused .* from 2025 carried into 2026$/);
      expect(entry.created_by).toContain('the year rollover');
      expect(Number(entry.days)).toBeGreaterThan(0);
    }
  });

  /* And the third act, delegated whole to the annual grant rather than reimplemented. */
  it('and grants the year that began, through the job that already does that', async () => {
    await grant2025();

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(run.grant.leaveYearLabel).toBe('2026');
    expect(run.grant.granted.length).toBeGreaterThan(0);
    expect((await balanceOf(people.officer, annualId, y2026.id)).entitled).toBe(20);
  });

  /**
   * And the order is visible in the rows rather than only in the code.
   *
   * The carry is posted into 2026 while 2025 is already settled, which is the whole
   * argument: had the carry come first it would have been computed from a year something
   * could still move, and had it been posted into 2025 the ledger would have refused it.
   */
  it('and the carry lands in the open year while the closed one is already settled', async () => {
    await grant2025();
    await job.run(firstOfJanuary, y2025.id);

    const carried = await entriesOfType('CARRY_FORWARD');

    expect(carried.every((entry) => entry.leave_year_id === y2026.id)).toBe(true);
    expect((await years.byId(system, y2025.id)).isClosed).toBe(true);
  });

  /**
   * And nothing is taken out of the year that closed.
   *
   * It goes on saying twenty granted, sixteen taken, four left, forever. That is not
   * double counting — the four days exist once, in the year they may now be booked
   * against — and removing them would be recalculating a settled year, which is the one
   * thing closing one forbids.
   */
  it('and the closed year still says exactly what it said', async () => {
    await grant2025();
    await takes(16);
    await job.run(firstOfJanuary, y2025.id);

    const was = await balanceOf(people.officer, annualId, y2025.id);

    expect(was).toMatchObject({ entitled: 20, taken: 16, carriedOver: 0, available: 4 });
    expect(await entriesOfType('EXPIRY')).toHaveLength(0);
  });
});

/* ------------------------------------------------- uncapped, and what does not carry */

describe('what carries and what does not, on a migrated database', () => {
  /**
   * Uncapped, which is the story's second criterion.
   *
   * Somebody who took none of their twenty days carries all twenty. There is no ceiling
   * anywhere, and the statutory figures say so by leaving two columns unset rather than
   * by nobody having written the code.
   */
  it('carries a whole unused year, because no statutory figure caps it', async () => {
    await grant2025();

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(carryFor(run, people.engineer, annualId)?.days).toBe(20);
    expect(carryFor(run, people.engineer, annualId)?.cappedFrom).toBeNull();
    expect((await balanceOf(people.engineer, annualId, y2026.id)).carriedOver).toBe(20);
  });

  /* And does not expire. FR 36a's other unset column: there is no EXPIRY entry anywhere
     after a rollover, and no job in this build that would post one. */
  it('and nothing expires, because no figure sets a month for it', async () => {
    await grant2025();
    await job.run(firstOfJanuary, y2025.id);

    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM leave_entitlement_rule WHERE carryover_expiry_month IS NOT NULL',
    );

    expect(rows[0].n).toBe(0);
    expect(await entriesOfType('EXPIRY')).toHaveLength(0);
  });

  /**
   * Sick leave does not carry. The third criterion, and the row that decides it.
   *
   * Everybody was granted three days of sick leave for 2025 and nobody took any, so
   * every one of those balances has three days left in it. Not one of them crosses the
   * boundary, and the only thing that stopped them is `carries_over` being false.
   */
  it('and sick leave carries nothing, however much of it is left', async () => {
    await grant2025();

    const run = await job.run(firstOfJanuary, y2025.id);

    expect((await balanceOf(people.officer, sickId, y2025.id)).available).toBe(3);
    expect(notCarriedFor(run, people.officer, sickId)?.because).toBe('DOES_NOT_CARRY');
    expect((await balanceOf(people.officer, sickId, y2026.id)).carriedOver).toBe(0);
  });

  it('and it is the column that decides it, not the type', async () => {
    const { rows } = await admin.query(
      `SELECT carries_over FROM leave_entitlement_rule
        WHERE leave_type_id = $1 AND effective_from = '2025-01-01'`,
      [sickId],
    );

    expect(rows[0].carries_over).toBe(false);
  });

  /**
   * Event based types do not carry. The fourth criterion.
   *
   * They never reach the decision at all — the job filters on `hasRunningBalance` before
   * a candidate is built — so this asserts the outcome rather than the mechanism: no
   * `CARRY_FORWARD` anywhere against a type whose entitlement arrives with an event.
   * FR 32g: a maternity allowance has no year end to survive.
   */
  it('and no event based type carries anything, in either direction', async () => {
    await grant2025();

    const run = await job.run(firstOfJanuary, y2025.id);

    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM leave_ledger_entry entry
         JOIN leave_type ON leave_type.id = entry.leave_type_id
        WHERE leave_type.entitlement_basis = 'EVENT'`,
    );

    const unpaidId = (
      await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'UNPAID'")
    ).rows[0].id;

    expect(rows[0].n).toBe(0);
    expect(run.carried.every((carry) => carry.leaveTypeId === annualId)).toBe(true);

    /* Every type the run considered at all is a quota type, which since LMS 401 is three
       of them rather than two: unpaid leave became a yearly allowance, so it reaches the
       decision and is reported as carrying nothing. The claim is unchanged — no event
       based type carries anything — and the list it is asserted against had to grow with
       the classification. */
    expect(
      run.notCarried.every((one) => [annualId, sickId, unpaidId].includes(one.leaveTypeId)),
    ).toBe(true);
  });

  it('and a balance with nothing left in it carries nothing, and says so', async () => {
    await grant2025();
    await takes(20);

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(notCarriedFor(run, people.officer, annualId)?.because).toBe('NOTHING_LEFT');
    expect((await balanceOf(people.officer, annualId, y2026.id)).carriedOver).toBe(0);
  });

  /**
   * And a balance in arrears is reported rather than carried or forgiven.
   *
   * An adjustment can take a balance below nought — FR 37, and where HR means to do that
   * they mean to do it. What must not happen is the debt quietly disappearing on the
   * first of January, which is the same failure as losing somebody's unused days pointed
   * the other way.
   */
  it('and a balance somebody has overdrawn is neither carried nor written off', async () => {
    await grant2025();
    await balances.adjust(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2025.id,
      days: -25,
      reason: 'Twenty five days taken in 2025 that were never recorded',
    });

    const run = await job.run(firstOfJanuary, y2025.id);

    expect((await balanceOf(people.officer, annualId, y2025.id)).available).toBe(-5);
    expect(notCarriedFor(run, people.officer, annualId)?.because).toBe('IN_ARREARS');
    expect((await balanceOf(people.officer, annualId, y2026.id)).carriedOver).toBe(0);
    expect(needsAttention(run)).toBe(true);
  });
});

/* ------------------------------------------------------------------ FR 36a’s cap */

describe('a cap, where HR has written one', () => {
  /* Nothing this company runs on sets one. Exercised anyway, for the reason
     `unit/pro-rata.test.ts` exercises a rule that is not in force: a column the code
     ignores is a setting that lies to whoever fills it in. */
  it('takes only as much as the cap allows, and says what it was capped from', async () => {
    await entitlements.create(asAdministrator(), {
      leaveTypeId: annualId,
      employeeId: people.engineer,
      entitlementDays: 20,
      carriesOver: true,
      carryoverMaxDays: 5,
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
      note: 'Five days is all that crosses, for this one person',
    });

    await grant2025();

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(carryFor(run, people.engineer, annualId)).toMatchObject({ days: 5, cappedFrom: 20 });
    expect((await balanceOf(people.engineer, annualId, y2026.id)).carriedOver).toBe(5);
  });

  it('and the entry says so, so nobody has to work out where the days went', async () => {
    await entitlements.create(asAdministrator(), {
      leaveTypeId: annualId,
      employeeId: people.engineer,
      entitlementDays: 20,
      carriesOver: true,
      carryoverMaxDays: 5,
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
    });

    await grant2025();
    await job.run(firstOfJanuary, y2025.id);

    const { rows } = await admin.query(
      `SELECT reason FROM leave_ledger_entry
        WHERE entry_type = 'CARRY_FORWARD' AND employee_id = $1`,
      [people.engineer],
    );

    expect(rows[0].reason).toMatch(/capped at 5 of 20 days\. FR 36a/);
  });
});

/* ------------------------------------------------------- which year's rule decides */

describe('the rule that decides is the one that covered the days', () => {
  /**
   * FR 31, and the reason the resolution date is the last day of the closing year.
   *
   * HR decides in January that this person's unused days will no longer carry. That is a
   * rule about 2026 onwards, and the days sitting in the 2025 balance were earned under a
   * policy that said they carry. A rollover that asked the new rule would strip them —
   * which is a closed year being recalculated by a figure written after it ended, and is
   * exactly what FR 31 forbids.
   */
  it('so a rule taking effect in the new year does not strip last year’s days', async () => {
    await entitlements.create(asAdministrator(), {
      leaveTypeId: annualId,
      employeeId: people.engineer,
      entitlementDays: 20,
      carriesOver: false,
      effectiveFrom: '2026-01-01',
      note: 'From 2026, this person’s unused days stop carrying',
    });

    await grant2025();

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(carryFor(run, people.engineer, annualId)?.days).toBe(20);
    expect((await balanceOf(people.engineer, annualId, y2026.id)).carriedOver).toBe(20);
  });

  /* And a type nobody has written a figure for carries nothing, reported apart from a
     figure that says no. Unpaid leave has no rule at all, deliberately — but it is an
     event type, so the case has to be made with a quota type that has none. */
  it('and a quota type with no figure at all is reported rather than passed over', async () => {
    await admin.query(
      `INSERT INTO leave_type (code, name, counting_basis, entitlement_basis, display_order)
       VALUES ('STUDY', 'Study Leave', 'WORKING_DAYS', 'QUOTA', 90)`,
    );

    const run = await job.run(firstOfJanuary, y2025.id);
    const studyId = (await admin.query("SELECT id FROM leave_type WHERE code = 'STUDY'")).rows[0]
      .id as string;

    expect(notCarriedFor(run, people.officer, studyId)?.because).toBe('NO_ENTITLEMENT_RULE');
  });
});

/* ------------------------------------------------------------ safely re-runnable */

describe('running it again does nothing, and says so', () => {
  /**
   * The story's fifth criterion, and the reason it is a criterion at all: the run that
   * failed at employee three hundred on a January morning has to be safe to start again
   * by somebody who does not know how far it got.
   */
  it('writes not one further ledger row', async () => {
    await grant2025();
    await takes(16);
    await job.run(firstOfJanuary, y2025.id);

    const after = await theWholeLedger();

    await job.run(firstOfJanuary, y2025.id);

    expect(await theWholeLedger()).toEqual(after);
  });

  it('and leaves every balance exactly where it was', async () => {
    await grant2025();
    await takes(16);
    await job.run(firstOfJanuary, y2025.id);

    const { rows: before } = await admin.query(
      'SELECT * FROM leave_balance ORDER BY employee_id, leave_type_id, leave_year_id',
    );

    await job.run(firstOfJanuary, y2025.id);

    const { rows: after } = await admin.query(
      'SELECT * FROM leave_balance ORDER BY employee_id, leave_type_id, leave_year_id',
    );

    expect(after).toEqual(before);
  });

  /**
   * And reports it, act by act, rather than silently doing nothing.
   *
   * That is the stronger half: somebody can run it, read the report, and know whether the
   * first run finished. A job that quietly did nothing would look identical to one that
   * had never run.
   */
  it('and reports each act as having happened already', async () => {
    await grant2025();
    await job.run(firstOfJanuary, y2025.id);

    const again = await job.run(firstOfJanuary, y2025.id);

    expect(again.closed).toBe('ALREADY_CLOSED');
    expect(again.carried).toHaveLength(0);
    expect(notCarriedFor(again, people.engineer, annualId)?.because).toBe('ALREADY_CARRIED');
    expect(again.grant.granted).toHaveLength(0);
    expect(
      again.grant.notGranted.find(
        (one) => one.employeeId === people.officer && one.leaveTypeId === annualId,
      )?.because,
    ).toBe('ALREADY_GRANTED');
  });

  /* The refusal is the ledger's, read inside the lock, rather than the job remembering.
     A second carry posted directly through the one door is refused the same way. */
  it('and a second carry against the same balance is refused inside the lock', async () => {
    await grant2025();
    await job.run(firstOfJanuary, y2025.id);

    await expect(
      balances.carryForward(asAdministrator(), {
        employeeId: people.engineer,
        leaveTypeId: annualId,
        leaveYearId: y2026.id,
        days: 20,
        reason: 'a second helping of 2025',
      }),
    ).rejects.toBeInstanceOf(AlreadyCarried);
  });

  /* A run that is interrupted leaves the balances it reached correct and the rest
     untouched, because every carry is its own transaction. The second run finishes the
     job rather than starting it over. */
  it('and a run that only half happened is finished rather than repeated', async () => {
    await grant2025();

    /* One person carried by hand, as though the first run had reached them and stopped. */
    await balances.carryForward(asAdministrator(), {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'Unused Annual Leave from 2025 carried into 2026',
    });

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(notCarriedFor(run, people.engineer, annualId)?.because).toBe('ALREADY_CARRIED');
    expect(carryFor(run, people.officer, annualId)?.days).toBe(20);
    expect((await balanceOf(people.engineer, annualId, y2026.id)).carriedOver).toBe(20);
  });
});

/* ------------------------------------------------------- what it refuses to do at all */

describe('what a rollover will not do', () => {
  /* The mistake that actually happens: it is the third of January and the year somebody
     reaches for is the one that started two days ago. */
  it('refuses a year that has not ended, before anything is written', async () => {
    await expect(job.run(firstOfJanuary, y2026.id)).rejects.toBeInstanceOf(LeaveYearNotFinished);

    expect(await theWholeLedger()).toEqual([]);
    expect((await years.byId(system, y2026.id)).isClosed).toBe(false);
  });

  /**
   * And a year with nowhere to roll into, refused before the close rather than after it.
   *
   * Closing a year and then finding there is nothing on the other side would strand the
   * days in a year nobody can reopen. `leave_year_leaves_no_gap` means the next year is
   * either defined or does not exist, so this is HR not having got to it yet — which is
   * an ordinary thing to have happened in December.
   */
  it('and a year with no year after it, without closing it first', async () => {
    await expect(job.run(firstOfJanuary, y2027.id)).rejects.toBeInstanceOf(NoLeaveYearAhead);

    expect((await years.byId(system, y2027.id)).isClosed).toBe(false);
  });

  /**
   * And one whose successor is already closed.
   *
   * Unreachable by any ordinary sequence, which is why the fixture has to reach for two
   * more years and close the later of the pair — nothing in this system refuses closing
   * 2024 while 2023 is still open, and the README says why the boundary is read from the
   * latest closed year rather than the earliest open one for exactly that reason.
   *
   * Worth refusing up front all the same: the alternative is a run that closes the old
   * year and then fails on every single carry with a settled-year refusal from the
   * ledger, which is four hundred confusing failures instead of one sentence.
   */
  it('and one whose successor is already closed, which takes no new figures', async () => {
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date) VALUES
         ('2023', '2023-01-01', '2023-12-31'), ('2024', '2024-01-01', '2024-12-31')`,
    );

    const y2023 = (await years.byLabel(system, '2023'))!;
    await years.close(asAdministrator(), (await years.byLabel(system, '2024'))!.id);

    await expect(job.run(firstOfJanuary, y2023.id)).rejects.toBeInstanceOf(LeaveYearAheadIsClosed);

    expect((await years.byId(system, y2023.id)).isClosed).toBe(false);
  });
});

/* ---------------------------------------------------- days nobody ever decided about */

describe('a request still pending when its year closed', () => {
  /**
   * The one thing a rollover can see that nobody else will.
   *
   * Days held for a request nobody decided are not unused — `available` has already left
   * them out — so they do not carry. What makes them worth a line of the report is that
   * they can never be approved either: the ledger refuses a `DEDUCTION` into a settled
   * year, so the request is stuck and the days are held against a balance that no longer
   * matters.
   */
  it('is reported, so somebody releases or adjusts the days', async () => {
    await grant2025();
    await asksFor(5);

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(run.unsettled).toContainEqual(
      expect.objectContaining({ employeeId: people.partTimer, pending: 5 }),
    );
    expect(needsAttention(run)).toBe(true);
  });

  /* And the held days do not cross the boundary, because they are spoken for rather than
     unused. Fifteen of the twenty carry; the five somebody is waiting on do not. */
  it('and the days held for it do not carry', async () => {
    await grant2025();
    await asksFor(5);

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(carryFor(run, people.partTimer, annualId)?.days).toBe(15);
    expect((await balanceOf(people.partTimer, annualId, y2026.id)).carriedOver).toBe(15);
  });
});

/* ---------------------------------------------------------------- whose job it is */

describe('who may roll a year over', () => {
  it('an HR Administrator, or the system on the first of January', async () => {
    await grant2025();

    await expect(job.run(asAdministrator(), y2025.id)).resolves.toMatchObject({
      closed: 'CLOSED_BY_THIS_RUN',
    });
  });

  /* It stops at the close, which is `leaveYearPolicy.close` and an HR Administrator's
     since LMS 205. Nothing is written on the way to the refusal. */
  it('and not an HR Officer, who cannot close a year', async () => {
    await expect(job.run(asOfficer(), y2025.id)).rejects.toBeInstanceOf(NotAuthorised);

    expect((await years.byId(system, y2025.id)).isClosed).toBe(false);
    expect(await theWholeLedger()).toEqual([]);
  });

  /**
   * And the carry has a decision of its own, refused at the same desk.
   *
   * Applying the rule that says whether a type carries is the same desk that writes it —
   * an HR Administrator's — for the reason `ledgerPolicy.grant` gives about a year's
   * entitlement.
   */
  it('and carrying one balance forward is an HR Administrator’s too', async () => {
    await grant2025();

    await expect(
      balances.carryForward(asOfficer(), {
        employeeId: people.officer,
        leaveTypeId: annualId,
        leaveYearId: y2026.id,
        days: 4,
        reason: 'Unused Annual Leave from 2025 carried into 2026',
      }),
    ).rejects.toThrow(/HR Administrator/);
  });
});

/* ---------------------------------------------------------------- the whole story */

describe('the rollover, read as one run', () => {
  /**
   * Everything the story asks for, in one assertion somebody can read.
   *
   * Adwoa took sixteen of her twenty days. Kwame took none. Neither carries any sick
   * leave. Both start 2026 with the year's own twenty in front of them and last year's
   * remainder behind.
   */
  it('carries what was left, grants what is new, and loses nothing', async () => {
    await grant2025();
    await takes(16);

    const run = await job.run(firstOfJanuary, y2025.id);

    expect(run.fromLeaveYearLabel).toBe('2025');
    expect(run.intoLeaveYearLabel).toBe('2026');
    expect(daysCarried(run)).toBeGreaterThan(0);

    expect(await balanceOf(people.officer, annualId, y2026.id)).toMatchObject({
      carriedOver: 4,
      entitled: 20,
      available: 24,
    });
    expect(await balanceOf(people.engineer, annualId, y2026.id)).toMatchObject({
      carriedOver: 20,
      entitled: 20,
      available: 40,
    });
    expect((await balanceOf(people.officer, sickId, y2026.id)).carriedOver).toBe(0);
  });
});
