import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { DEFAULT_APPROVAL_CHAIN } from '../../src/features/leave-type/approval-chain.js';
import {
  type BalanceStatement,
  type BalanceStatementLine,
  NotOneOfTheirLeaveYears,
} from '../../src/features/balance/balance-statement.js';
import { EmployeeNotFound } from '../../src/features/employee/employee.js';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import { LeaveYearNotFound } from '../../src/features/leave-year/leave-year.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { BalanceStatementService } from '../../src/features/balance/balance-statement.service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The balance screen against a real database. FR 53, §7.4. LMS 401.
 *
 * ../unit/balance-statement.test.ts proves the arrangement — which rows, in which order,
 * with which sentence — because all of that is pure. What is here is the half it cannot
 * claim, and it is three things:
 *
 *   **The figures are the ones a real ledger produced.** The unit suite builds balances
 *   by hand; this one posts movements through the one door that writes them and reads the
 *   statement afterwards, so a projection that disagreed with `BUCKETS` would show up as
 *   a wrong number on the screen rather than as a passing test.
 *
 *   **Somebody else's statement is refused**, by the same three standings
 *   `ledgerPolicy.read` gives everywhere else — and refused *silently*, which is a
 *   property only a real actor against a real record can demonstrate.
 *
 *   **The type and year lists are the ones in the database**, including the seven
 *   statutory types and the gender restrictions on two of them. FR 05 against real rows
 *   rather than a fixture that agrees with the code by construction.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('balance statement integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let statements: BalanceStatementService;
let balances: BalanceService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: string;
let y2027: string;
let annualId: string;
let sickId: string;
let compassionateId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const cached = new BalanceRepository(db);

  statements = new BalanceStatementService(cached, guard, employees, types, years);
  balances = new BalanceService(cached, guard, employees, new Transactions(db));

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_decision, leave_request',
  );
  await restoreYears();
  await restoreTypes();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  y2027 = await yearIdOf('2027');
  annualId = await typeIdOf('ANNUAL');
  sickId = await typeIdOf('SICK');
  compassionateId = await typeIdOf('COMPASSIONATE');
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_decision, leave_request',
  );
  await restoreYears();
  await restoreTypes();

  await db?.destroy();
  await admin?.end();
});

/* --------------------------------------------------------------- every leave type */

describe('every leave type is on the statement', () => {
  /**
   * The story's first criterion against the seven types the migration ships.
   *
   * Adwoa is female, so the two `MALE` types are not hers and the two `FEMALE` ones are.
   * That is FR 05 read off `gender_restriction` rather than off a list written here — the
   * assertion names the codes, but nothing in the code being tested does.
   */
  it('lists every type this person is eligible for, in display order', async () => {
    const statement = await statements.forEmployee(asThemselves(), people.officer);

    /* §7.4's `display_order`, as the migrations leave it — including LMS 401's, which put
       unpaid leave third. The order is a decision somebody made rather than an
       alphabetical accident, so it is asserted as one. */
    expect(statement.lines.map((line) => line.code)).toEqual([
      'ANNUAL',
      'SICK',
      'UNPAID',
      'COMPASSIONATE',
      'MATERNITY',
      'MAT_EXT_UNPAID',
    ]);
  });

  it('and leaves out the ones restricted to the other gender', async () => {
    const statement = await statements.forEmployee(asTheirManager(), people.teamLead);

    expect(statement.lines.map((line) => line.code)).toContain('PATERNITY');
    expect(statement.lines.map((line) => line.code)).not.toContain('MATERNITY');
  });

  it('shows a type nothing has ever moved, at nought and saying so', async () => {
    const statement = await statements.forEmployee(asThemselves(), people.officer);
    const annual = lineOf(statement, 'ANNUAL');

    expect(annual.available).toBe(0);
    expect(annual.hasMoved).toBe(false);
    expect(annual.updatedAt).toBeNull();
  });

  /* The limb that stops a figure disappearing. A retired type is not offered to anybody
     and is still on the statement of everybody who has days in it. */
  it('and keeps a retired type on the statement of somebody who has days in it', async () => {
    await grant(people.officer, sickId, 3);
    await admin.query('UPDATE leave_type SET is_active = FALSE WHERE code = $1', ['SICK']);

    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'SICK').stillOffered).toBe(false);
    expect(lineOf(statement, 'SICK').entitled).toBe(3);
    expect(statement.lines.map((line) => line.code)).not.toContain('ANNUAL_RETIRED_PLACEHOLDER');
  });

  it('and drops a retired type from the statement of somebody who has none', async () => {
    await admin.query('UPDATE leave_type SET is_active = FALSE WHERE code = $1', ['SICK']);

    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(statement.lines.map((line) => line.code)).not.toContain('SICK');
  });
});

/* ------------------------------------------------------------------- the figures */

describe('the figures are the ones the ledger produced', () => {
  /**
   * The whole of the story's first criterion, end to end.
   *
   * Every one of these movements goes through `BalanceService`, so the figures are
   * `rebuild_one_balance_from_the_ledger()`'s rather than this test's arithmetic. The
   * final assertion is the one that matters: the subtraction the screen shows can be
   * performed by the person reading it, from the numbers beside it.
   */
  it('carries entitled, carried over, adjustment, taken, pending and available', async () => {
    await grant(people.officer, annualId, 20);
    await carry(people.officer, annualId, 5);
    await adjust(people.officer, annualId, -2);

    const held = await askFor(people.officer, annualId, 6);
    await approve(held.request);
    await askFor(people.officer, annualId, 4);

    const statement = await statements.forEmployee(asThemselves(), people.officer);
    const annual = lineOf(statement, 'ANNUAL');

    expect(annual.entitled).toBe(20);
    expect(annual.carriedOver).toBe(5);
    expect(annual.adjustment).toBe(-2);
    expect(annual.taken).toBe(6);
    expect(annual.pending).toBe(4);
    expect(annual.owed).toBe(23);
    expect(annual.available).toBe(13);

    expect(
      annual.entitled + annual.carriedOver + annual.adjustment - annual.taken - annual.pending,
    ).toBe(annual.available);
  });

  /* §8.6b. Sick leave is a documentation threshold rather than a cap, so it goes below
     nought — and the screen has to show that rather than a clamp. */
  it('shows a sick balance that has gone negative as negative', async () => {
    await grant(people.officer, sickId, 3);
    const held = await askFor(people.officer, sickId, 5);
    await approve(held.request);

    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'SICK').available).toBe(-2);
  });

  it('and holds each leave type apart from the others', async () => {
    await grant(people.officer, annualId, 20);
    await grant(people.officer, sickId, 3);

    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'ANNUAL').available).toBe(20);
    expect(lineOf(statement, 'SICK').available).toBe(3);
  });
});

/* --------------------------------------------------------------- counting basis */

describe('the counting basis is shown per type', () => {
  /* The story's third criterion. FR 22: annual leave counts working days and maternity
     leave counts calendar days, and the same figure means different things on the two
     rows. Read off `counting_basis` in the database, never off the code. */
  it('says working days for one type and calendar days for another, in words', async () => {
    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'ANNUAL').countingBasis).toBe('WORKING_DAYS');
    expect(lineOf(statement, 'ANNUAL').countingBasisLabel).toBe('Working days');

    expect(lineOf(statement, 'MATERNITY').countingBasis).toBe('CALENDAR_DAYS');
    expect(lineOf(statement, 'MATERNITY').countingBasisLabel).toBe('Calendar days');
  });

  it('and follows the column when an administrator changes it', async () => {
    await admin.query('UPDATE leave_type SET counting_basis = $1 WHERE code = $2', [
      'CALENDAR_DAYS',
      'ANNUAL',
    ]);

    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'ANNUAL').countingBasisLabel).toBe('Calendar days');
  });

  /* FR 32g. Compassionate leave at nought in January is not somebody who has used it all,
     and the sentence beside the digit is the only thing that says so. */
  it('says an event type is granted per occasion rather than showing a bare nought', async () => {
    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'ANNUAL').allowanceInWords).toMatch(/yearly allowance/);
    expect(lineOf(statement, 'COMPASSIONATE').allowanceInWords).toMatch(
      /nothing here until an occasion arises/,
    );
  });

  it('and stops saying so once an occasion has granted some', async () => {
    await grant(people.officer, compassionateId, 5);

    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(lineOf(statement, 'COMPASSIONATE').allowanceInWords).not.toMatch(/nothing here until/);
  });
});

/* ------------------------------------------------------------------ prior years */

describe('prior years are selectable', () => {
  it('offers the years defined, oldest first, and opens on the one covering today', async () => {
    const statement = await statements.forEmployee(asThemselves(), people.officer);

    expect(statement.years.map((year) => year.label)).toEqual(['2026', '2027']);
    expect(statement.year.label).toBe('2026');
  });

  it('shows a named year instead, with that year’s figures', async () => {
    await grant(people.officer, annualId, 20);
    await grant(people.officer, annualId, 25, y2027);

    const thisYear = await statements.forEmployee(asThemselves(), people.officer);
    const nextYear = await statements.forEmployee(asThemselves(), people.officer, {
      leaveYearId: y2027,
    });

    expect(thisYear.year.label).toBe('2026');
    expect(lineOf(thisYear, 'ANNUAL').entitled).toBe(20);

    expect(nextYear.year.label).toBe('2027');
    expect(lineOf(nextYear, 'ANNUAL').entitled).toBe(25);
  });

  /* FR 29a. Kojo left on the last day of July 2026, so 2027 was never his — and a
     statement of noughts for it would read as "you have no leave" rather than as "you had
     left". `employedPortionOf` is what decides, which is the same function the pro rata
     grant asks. */
  it('stops at the year a leaver left in', async () => {
    const statement = await statements.forEmployee(asAdministrator(), people.leaver);

    expect(statement.years.map((year) => year.label)).toEqual(['2026']);
  });

  it('and refuses a real year that was never theirs, naming the ones that were', async () => {
    await expect(
      statements.forEmployee(asAdministrator(), people.leaver, { leaveYearId: y2027 }),
    ).rejects.toThrow(NotOneOfTheirLeaveYears);

    await expect(
      statements.forEmployee(asAdministrator(), people.leaver, { leaveYearId: y2027 }),
    ).rejects.toThrow(/2026/);
  });

  /**
   * The safety net limb, against a real adjustment.
   *
   * HR files a correction under a year the person was not employed for — which nothing
   * refuses, because §8.9 makes an adjustment the one entry a settled year accepts and
   * there is no rule tying one to an employment date. The figure exists, so the year has
   * to become reachable, or the days are on no screen at all.
   */
  it('offers a year they were not employed for once a figure exists in it', async () => {
    await adjust(people.leaver, annualId, 3, y2027);

    const statement = await statements.forEmployee(asAdministrator(), people.leaver);

    expect(statement.years.map((year) => year.label)).toEqual(['2026', '2027']);

    const carriedOver = await statements.forEmployee(asAdministrator(), people.leaver, {
      leaveYearId: y2027,
    });

    expect(lineOf(carriedOver, 'ANNUAL').adjustment).toBe(3);
  });

  it('refuses a leave year id that is nobody’s', async () => {
    await expect(
      statements.forEmployee(asThemselves(), people.officer, { leaveYearId: '999999' }),
    ).rejects.toThrow(LeaveYearNotFound);
  });
});

/* ---------------------------------------------------------------- who may read one */

describe('whose statement it is', () => {
  it('is their own to read. FR 53', async () => {
    await expect(statements.forEmployee(asThemselves(), people.officer)).resolves.toBeDefined();
  });

  it('and their line manager’s. FR 55', async () => {
    await expect(statements.forEmployee(asTheirManager(), people.officer)).resolves.toBeDefined();
  });

  it('and HR’s. FR 56', async () => {
    await expect(statements.forEmployee(asAdministrator(), people.officer)).resolves.toBeDefined();
  });

  /**
   * Silently, which is the whole of ../../src/auth/policy.ts's argument.
   *
   * A colleague is told that no record they have access to matches, in the same words a
   * record that is not there produces — so the pair of them cannot be used to ask whether
   * an employee id belongs to anybody.
   */
  it('and nobody else’s, refused in the words that disclose nothing', async () => {
    await expect(statements.forEmployee(asAColleague(), people.officer)).rejects.toThrow(
      NotAuthorised,
    );

    await expect(statements.forEmployee(asAColleague(), people.officer)).rejects.toThrow(
      /No record you have access to matches that/,
    );
  });

  /* Two levels down is not a direct report. The subtree is deliberately not FR 55's, and
     the argument for stopping at one level is ../../src/features/employee/policy.ts's. */
  it('and not a skip level manager’s', async () => {
    await expect(statements.forEmployee(asTheirManager(), people.engineer)).rejects.toThrow(
      NotAuthorised,
    );
  });

  it('refuses an employee id that is nobody at all', async () => {
    await expect(statements.forEmployee(asAdministrator(), '999999')).rejects.toThrow(
      EmployeeNotFound,
    );
  });
});

/* ------------------------------------------------------------------------ fixtures */

function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** The team lead, who is `officer`'s line manager and `engineer`'s nobody. */
function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

/** Somebody with no standing at all towards the officer's balance. */
function asAColleague() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function grant(employeeId: string, leaveTypeId: string, days: number, leaveYearId = y2026) {
  return balances.grantTheYear(system, {
    employeeId,
    leaveTypeId,
    leaveYearId,
    days,
    reason: 'Entitlement for the year',
  });
}

function carry(employeeId: string, leaveTypeId: string, days: number, leaveYearId = y2026) {
  return balances.carryForward(system, {
    employeeId,
    leaveTypeId,
    leaveYearId,
    days,
    reason: 'Carried from last year',
  });
}

function adjust(employeeId: string, leaveTypeId: string, days: number, leaveYearId = y2026) {
  return balances.adjust(system, {
    employeeId,
    leaveTypeId,
    leaveYearId,
    days,
    reason: 'Corrected by hand',
  });
}

/**
 * Days asked for, through the door LMS 301 put in front of them.
 *
 * The same shape ./balance.test.ts uses: a RESERVATION has to name a request and a request
 * has to hold days, so there is no way to write one without the other. Each period starts
 * where the last left off, because `leave_request_never_overlaps` refuses one person two
 * requests over the same day.
 */
let nextRequestDay = 0;

async function askFor(employeeId: string, leaveTypeId: string, days: number) {
  const startsOn = nextRequestDay;
  nextRequestDay += days;

  const { rows } = await admin.query<{ start_date: string; end_date: string }>(
    `SELECT start_date + $2::int AS start_date, start_date + $2::int + ($3::int - 1) AS end_date
       FROM leave_year WHERE id = $1`,
    [y2026, startsOn, days],
  );

  return balances.reserveForRequest(system, {
    request: {
      employeeId,
      leaveTypeId,
      leaveYearId: y2026,
      from: rows[0].start_date,
      to: rows[0].end_date,
      reason: 'Some days off',
      countingBasis: 'CALENDAR_DAYS' as const,
      days,
      calendarDays: days,
      status: 'SUBMITTED' as const,
      awaitingApprovalFrom: 'MANAGER' as const,
    },
    reason: `${String(days)} days held while it is decided`,
  });
}

/**
 * Leave approved all the way, which is what turns held days into taken ones.
 *
 * **Both desks, by two different people**, and there is no shortcut. Three separate rules
 * refuse an abbreviated fixture and each of them is one this system is built on:
 * `leaveRequestPolicy.approve` refuses anybody the request is not waiting on, so
 * `theSystem()` cannot stand in even holding every role; `approvalTo` walks the type's own
 * chain rather than one the caller names; and `leave_request_approved_by_every_stage`
 * judges the pair at COMMIT and answers "was approved without HR" to anything that got
 * past the first two.
 *
 * So the fixture is a real manager-then-HR approval, which is `DEFAULT_APPROVAL_CHAIN` and
 * is what every type here is configured with. The first call moves the request on a stage
 * and posts nothing — LMS 314 — and the second is the last word and posts the `DEDUCTION`.
 * What these tests are about is the figure that lands on the screen;
 * ./approval-chain.test.ts is where the walk itself is proved.
 *
 * The request is the row the previous call handed back rather than one built here, because
 * each door re-reads it inside the lock and the desk it is standing at has just moved.
 */
async function approve(request: LeaveRequest): Promise<void> {
  const atTheManager = await balances.approveForRequest(asTheirManager(), {
    request,
    chain: [...DEFAULT_APPROVAL_CHAIN],
    chiefExecutiveId: null,
    reason: `${String(request.days)} days taken`,
    comment: null,
  });

  await balances.approveForRequest(asAdministrator(), {
    request: atTheManager.request,
    chain: [...DEFAULT_APPROVAL_CHAIN],
    chiefExecutiveId: null,
    reason: `${String(request.days)} days taken`,
    comment: null,
  });
}

function lineOf(statement: BalanceStatement, code: string): BalanceStatementLine {
  const line = statement.lines.find((one) => one.code === code);

  if (line === undefined) {
    throw new Error(
      `No line for ${code}. The statement had ${statement.lines
        .map((one) => one.code)
        .join(', ')}.`,
    );
  }

  return line;
}

async function yearIdOf(label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_year WHERE label = $1', [
    label,
  ]);

  return rows[0].id;
}

async function typeIdOf(code: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_type WHERE code = $1', [
    code,
  ]);

  return rows[0].id;
}

/**
 * The leave years as the migration left them.
 *
 * The same shape ./balance.test.ts and ./ledger.test.ts use, and for the same reason: the
 * rows have to be identical for every test, and a closed year refuses to be deleted by
 * anybody.
 */
async function restoreYears(): Promise<void> {
  const columns = Object.keys(seededYears[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${String(index + 1)}`).join(', ');

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
 * The leave types as the migration left them.
 *
 * Two tests here retire one and one changes a counting basis, which is the point of both —
 * every rule is a column, so the way to test one is to change the column. This puts them
 * back rather than leaving the next file to discover a retired sick leave type.
 */
async function restoreTypes(): Promise<void> {
  await admin.query('UPDATE leave_type SET is_active = TRUE WHERE NOT is_active');
  await admin.query(
    "UPDATE leave_type SET counting_basis = 'WORKING_DAYS' WHERE code IN ('ANNUAL', 'SICK', 'COMPASSIONATE', 'UNPAID')",
  );
  await admin.query(
    "UPDATE leave_type SET counting_basis = 'CALENDAR_DAYS' WHERE code IN ('MATERNITY', 'PATERNITY', 'MAT_EXT_UNPAID')",
  );
}
