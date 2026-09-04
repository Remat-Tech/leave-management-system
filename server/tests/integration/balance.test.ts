import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  available,
  type BalanceKey,
  BalanceOverdrawn,
  InvalidBalanceMovement,
  NotEnoughHeld,
} from '../../src/features/balance/balance.js';
import { EmployeeNotFound } from '../../src/features/employee/employee.js';
import {
  BUCKETS,
  InvalidLedgerEntry,
  LEDGER_ENTRY_TYPES,
  type LedgerEntryType,
  REQUEST_MOVEMENTS,
  validateNewLedgerEntry,
} from '../../src/features/balance/ledger.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { LedgerRepository } from '../../src/features/balance/ledger.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The cached balance against a real database. §5.7, design principle 1. LMS 211.
 *
 * Nearly the whole story is here rather than in ../unit/balance.test.ts, and that is
 * the design rather than a shortfall in the unit suite. The arithmetic this story is
 * about is SQL: `rebuild_one_balance_from_the_ledger()` in the cached-balance-table
 * migration is the only implementation of the projection anywhere, deliberately, so
 * the only place it can be asked whether it is right is against a server.
 *
 * Four claims, and each is one the database has to make rather than the application:
 *
 *   **Every kind of movement lands in the column `BUCKETS` names.** The domain
 *   states the projection and the migration performs it. A disagreement between them
 *   would be days moving in the ledger and the wrong figure moving on the screen —
 *   the one failure a cache can have that nothing else in the system would notice.
 *
 *   **The balance moves in the entry's transaction, or not at all.** The story's
 *   second criterion. Held by a trigger, so it is true of the six entry types whose
 *   writers have not been written yet as much as of the one that has.
 *
 *   **No connection writes a balance by hand.** Not the application, which holds
 *   SELECT and had its INSERT revoked. Not the owner either, which is the one that
 *   matters: everything below that says "by anybody" runs on the owner connection
 *   deliberately.
 *
 *   **The cache is a function of the ledger.** Throw all five figures away and they
 *   come back identical, because they were never anything but a sum of rows that are
 *   all still there.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('balance integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let balances: BalanceService;
let repository: BalanceRepository;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

/** The 2026 leave year and the leave types nearly every test posts against. */
let y2026: LeaveYear;
let annualId: string;
let sickId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  repository = new BalanceRepository(db);
  years = new LeaveYearService(new LeaveYearRepository(db), guard);
  balances = new BalanceService(
    repository,
    guard,
    new EmployeeRepository(db),
    new Transactions(db),
  );

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  /* The cache first and the ledger second, which is the order they depend in. Both
     by TRUNCATE, because `leave_balance` refuses a DELETE on every connection and
     `leave_ledger_entry` refuses one too — and no row trigger fires on TRUNCATE,
     which is the door both migrations leave open for exactly this. */
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_attachment, leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request',
  );
  await restoreYears();

  /* LMS 301: the requests went with the entries, so the next test builds its own. */
  currentRequest = undefined;

  /* And with them the days they claimed, so the next test starts at the year's first
     again. LMS 304. */
  nextRequestDay = 0;

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0]
    .id as string;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_attachment, leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request',
  );
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/**
 * The leave years as the migration left them.
 *
 * The same shape ./ledger.test.ts and ./holiday.test.ts use, and for the same
 * reason: one test below closes a year, and a closed year refuses to be deleted by
 * anybody.
 */
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
 * The request the request-shaped entries of this test are filed under. LMS 301.
 *
 * Since the create-and-submit-a-leave-request migration a RESERVATION, DEDUCTION,
 * RELEASE or RECALCULATION has to name a request —
 * `leave_ledger_entry_request_movements_name_a_request` — and a request has to hold
 * days, judged at COMMIT by `leave_request_holds_its_days`. So a suite writing these
 * directly has to build the pair rather than the entry alone.
 *
 * The pattern below is the real one rather than a fixture convenience: a RESERVATION
 * brings a request of its own, and the DEDUCTION or RELEASE that follows draws down the
 * same one. Reset for each test by `beforeEach`.
 */
let currentRequest: string | undefined;

function movesForARequest(entryType: LedgerEntryType): boolean {
  return (REQUEST_MOVEMENTS as readonly string[]).includes(entryType);
}

/**
 * Where the next fixture request starts, counted in days from its leave year's first.
 *
 * Every request in this file used to begin on the first of January, which was fine until
 * `leave_request_never_overlaps` arrived with LMS 304: one person may not hold the same
 * day twice. Advancing the start day gives each fixture a period of its own — which is
 * what these rows were always meant to represent, since what this file is about is the
 * balance rather than the calendar.
 *
 * Reset for each test alongside the tables, so a run's requests do not walk off the end
 * of the leave year and meet `leave_request_falls_in_its_leave_year` instead.
 */
let nextRequestDay = 0;

/**
 * A request row, inside whatever transaction the caller has open.
 *
 * The period runs `days` days from wherever the last one ended, which is the one shape
 * that satisfies every rule on the table for any figure a test asks for: inside the year,
 * ending on or after it starts, spanning at least as many days as it costs, and not on
 * top of a period this person already holds.
 */
async function insertRequest(
  key: { employee_id: unknown; leave_type_id: unknown; leave_year_id: unknown },
  days: number,
): Promise<string> {
  const startsOn = nextRequestDay;
  nextRequestDay += days;

  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO leave_request (
        employee_id, leave_type_id, leave_year_id,
        start_date, end_date, reason, counting_basis, days, calendar_days, status,
        awaiting_approval_from)
     SELECT $1, $2, $3,
            y.start_date + $5::int, y.start_date + $5::int + ($4::int - 1),
            'a request for the suite', 'CALENDAR_DAYS', $4, $4, 'SUBMITTED', 'MANAGER'
       FROM leave_year y WHERE y.id = $3
     RETURNING id`,
    [key.employee_id, key.leave_type_id, key.leave_year_id, days, startsOn],
  );

  return rows[0].id;
}

async function insertEntry(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  const { rows } = await admin.query(
    `INSERT INTO leave_ledger_entry (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    Object.values(row),
  );

  return rows[0] as Record<string, unknown>;
}

/**
 * A ledger entry written straight to the table, bypassing every layer above it.
 *
 * Most of this file posts entries this way rather than through `BalanceService`,
 * because six of the nine kinds have no service writer and because what is being proved
 * is that the balance follows a *ledger entry* rather than a service call.
 *
 * Since LMS 301 the four request-shaped kinds cannot be written alone — see
 * {@link currentRequest} — so this builds the request they name.
 */
async function post(
  entryType: LedgerEntryType,
  days: number,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    employee_id: people.officer,
    leave_type_id: annualId,
    leave_year_id: y2026.id,
    entry_type: entryType,
    days: days.toFixed(2),
    reason: `a ${entryType.toLowerCase()} for the suite`,
    ...overrides,
  };

  if (!movesForARequest(entryType) || row.leave_request_id !== undefined) {
    return insertEntry(row);
  }

  /* A reservation and the request it holds days for are one act, so they go in one
     transaction — which is the only way the deferred check can pass. */
  if (entryType === 'RESERVATION') {
    await admin.query('BEGIN');
    try {
      currentRequest = await insertRequest(
        row as { employee_id: unknown; leave_type_id: unknown; leave_year_id: unknown },
        Math.abs(days),
      );
      const written = await insertEntry({ ...row, leave_request_id: currentRequest });
      await admin.query('COMMIT');
      return written;
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }

  /* Anything else draws down a hold, so there has to be one. Most tests reserve first
     and this reuses that request; the few that do not are asking about a column rather
     than about arithmetic, and a reservation of the same size in front of them changes
     nothing they assert. */
  if (currentRequest === undefined) {
    await post('RESERVATION', -Math.abs(days), overrides);
  }

  return insertEntry({ ...row, leave_request_id: currentRequest ?? null });
}

/** The balance this file's default entry lands in. */
function theBalance(overrides: Partial<BalanceKey> = {}): BalanceKey {
  return {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
    ...overrides,
  };
}

/** Which way each kind of movement has to go, so a test can post a valid one. */
function signFor(entryType: LedgerEntryType): number {
  return ['RESERVATION', 'DEDUCTION', 'EXPIRY', 'LAPSE'].includes(entryType) ? -1 : 1;
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

/** The team lead, who is `officer`'s line manager. */
function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Somebody with no standing at all towards the officer's balance. */
/**
 * Somebody asking for days, through the door LMS 301 put in front of them.
 *
 * `reserve` was replaced by `reserveForRequest` because a RESERVATION now has to name a
 * request and a request has to hold days — so there is no way to write one without the
 * other, which is the point rather than an inconvenience.
 *
 * Each period runs as many days as are being asked for, counted as calendar days, so that
 * any figure a test wants is a period the table accepts. What the tests below are about
 * is the balance rather than the counting; ./leave-request.test.ts is where the counting
 * is proved.
 *
 * **Each one starts where the last left off**, which since LMS 304 is what makes two of
 * them possible at all: `leave_request_never_overlaps` refuses one person two requests
 * over the same day, and these all used to begin on the first of January. The days are
 * claimed synchronously, before the first `await`, so that the two callers of the
 * concurrency tests below take different periods rather than racing for one — the race
 * those tests are about is for the *balance*, and a fixture that made them collide on
 * the calendar instead would be proving something else.
 */
async function askFor(
  overrides: Partial<BalanceKey> & { days?: number } = {},
  who = asThemselves(),
) {
  const { days = 5, ...key } = overrides;
  const balance = theBalance(key);
  const span = Math.max(1, Math.trunc(Math.abs(days)) || 1);

  const startsOn = nextRequestDay;
  nextRequestDay += span;

  const { rows } = await admin.query<{ start_date: string; end_date: string }>(
    `SELECT start_date + $3::int AS start_date, start_date + $3::int + ($2::int - 1) AS end_date
       FROM leave_year WHERE id = $1`,
    [balance.leaveYearId, span, startsOn],
  );

  return balances.reserveForRequest(who, {
    request: {
      ...balance,
      from: rows[0].start_date,
      to: rows[0].end_date,
      reason: 'Five days in December',
      /** FR 18, LMS 308. */
      lateEntryReason: null,
      evidenceRequired: false,
      countingBasis: 'CALENDAR_DAYS' as const,
      days,
      calendarDays: span,
      status: 'SUBMITTED' as const,
      /* FR 38a. Where a request starts, which `LeaveRequestService` reads off the leave
         type's chain. These fixtures go straight to the door, so they say it. LMS 314. */
      awaitingApprovalFrom: 'MANAGER' as const,
      /** FR 48b. Nothing to skip: every desk can be asked. LMS 320. */
      skips: [],
    },
    reason: 'Five days in December',
  });
}

/**
 * A movement drawing down a hold, which since LMS 301 has to name the request the days
 * are held for.
 *
 * `leave_ledger_entry_request_movements_name_a_request` refuses a DEDUCTION or a RELEASE
 * without one, and `RequestMovement` refuses it a statement earlier — so every one of
 * these carries the id `askFor` handed back.
 */
function against(requestId: string, overrides: Partial<BalanceKey> & { days?: number } = {}) {
  const { days = 5, ...key } = overrides;

  return { ...theBalance(key), days, reason: 'Five days in December', leaveRequestId: requestId };
}

function asAColleague() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

/* -------------------------------------------- one row per employee, type and year */

describe('a balance is opened by the first movement in it', () => {
  it('does not exist before anything has moved', async () => {
    const { rows } = await admin.query('SELECT count(*) FROM leave_balance');

    expect(rows[0].count).toBe('0');
  });

  /* And an absent row reads as nought rather than as an absence. A joiner whose
     grant has not run yet has no days, which is a figure a screen can show. */
  it('and reads as nought, saying that nothing has moved it', async () => {
    const balance = await balances.forOne(asThemselves(), theBalance());

    expect(balance.available).toBe(0);
    expect(balance.updatedAt).toBeNull();
  });

  it('appears with the first entry posted against it', async () => {
    await post('GRANT', 20);

    const balance = await balances.forOne(asThemselves(), theBalance());

    expect(balance.entitled).toBe(20);
    expect(balance.available).toBe(20);
    expect(balance.updatedAt).toBeInstanceOf(Date);
  });

  /* The story's third criterion. Twelve movements, one row: two rows for one
     balance would be two answers to "what have I got left", and a screen would show
     whichever the query reached first. */
  it('and stays one row however many movements it has', async () => {
    for (let month = 0; month < 6; month += 1) {
      await post('RESERVATION', -1);
      await post('DEDUCTION', -1);
    }

    const { rows } = await admin.query(
      'SELECT count(*) FROM leave_balance WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year_id = $3',
      [people.officer, annualId, y2026.id],
    );

    expect(rows[0].count).toBe('1');
  });

  /* One per employee, per leave type, per leave year — all three, held by the
     database rather than by the trigger being careful. Asked of the server rather
     than of the SQL text, which is the authoritative answer. */
  it('and the uniqueness is a constraint on all three columns', async () => {
    const { rows } = await admin.query(
      `SELECT string_agg(held.attname, ', ' ORDER BY key.position) AS columns
         FROM pg_constraint one
         CROSS JOIN LATERAL unnest(one.conkey) WITH ORDINALITY AS key(column_number, position)
         JOIN pg_attribute held
           ON held.attrelid = one.conrelid AND held.attnum = key.column_number
        WHERE one.conname = 'leave_balance_one_per_year' AND one.contype = 'u'`,
    );

    expect(rows[0].columns).toBe('employee_id, leave_type_id, leave_year_id');
  });

  it('and a different leave type is a different balance', async () => {
    await post('GRANT', 20);
    await post('GRANT', 12, { leave_type_id: sickId });

    const held = await balances.forEmployee(asThemselves(), people.officer);

    expect(held).toHaveLength(2);
    expect(held.map((balance) => balance.entitled)).toEqual([20, 12]);
  });
});

/* --------------------------------------- the projection, checked against the domain */

/**
 * `BUCKETS` in features/balance/ledger.ts against the trigger that performs it.
 *
 * This is the test the whole story turns on. LMS 210 wrote down which of the five
 * columns each kind of movement moves, in the file that knows what an entry means,
 * and declined to implement it — "a total computed in two places is the drift the
 * cached balance exists to be checked against". LMS 211 implemented it once, in SQL.
 * What keeps the statement and the implementation in step is this: one entry of each
 * of the eight kinds, and the columns that actually moved compared with the columns
 * the domain says should have.
 */
describe('every kind of movement lands where the domain says it does', () => {
  it.each(LEDGER_ENTRY_TYPES)('%s moves exactly the columns BUCKETS names', async (entryType) => {
    /* Since LMS 301 a DEDUCTION, RELEASE or RECALCULATION has to name a request that
       is already holding days, so the hold is set up before the reading is taken —
       what is being measured is what *this* entry moved. A RESERVATION brings its own
       request, which is why it is not in this list: it is the hold. */
    if (movesForARequest(entryType) && entryType !== 'RESERVATION') {
      await post('RESERVATION', -5);

      /* FR 47, LMS 324. A RECALCULATION gives back days that were taken, and
         `leave_request_gives_back_no_more_than_it_took` refuses one against a request that
         never spent any — so the hold is drawn down before the reading is taken. */
      if (entryType === 'RECALCULATION') {
        await post('DEDUCTION', -5);
      }
    }

    const before = await repository.forOne(theBalance());

    await post(entryType, signFor(entryType) * 5);

    const after = await repository.forOne(theBalance());
    const moved = (['entitled', 'carriedOver', 'adjustment', 'taken', 'pending'] as const).filter(
      (bucket) => after[bucket] !== before[bucket],
    );

    expect([...moved].sort()).toEqual([...BUCKETS[entryType]].sort());
  });

  /* And in the right direction. A RESERVATION is −5 days in the ledger and five days
     *pending* in the cache, which is the sign convention every ad hoc balance query
     gets backwards — and getting it backwards adds days to somebody every time they
     ask for leave. */
  it('holds days asked for as a positive count of what is spoken for', async () => {
    await post('GRANT', 20);
    await post('RESERVATION', -5);

    const balance = await repository.forOne(theBalance());

    expect(balance.pending).toBe(5);
    expect(available(balance)).toBe(15);
  });

  /**
   * The case the ledger migration named as the one to get right first.
   *
   * Approval does not consume days a second time — the reservation already did — so
   * `DEDUCTION` moves them from `pending` to `taken` and available does not budge.
   * The second assertion is the point: a cache that added the signed movements
   * together would say ten days are gone, and would be wrong by five in the
   * direction that lets somebody book leave they do not have.
   */
  it('and approval moves them to taken without spending them again', async () => {
    await post('GRANT', 20);
    await post('RESERVATION', -5);
    const held = await repository.forOne(theBalance());

    await post('DEDUCTION', -5);
    const approved = await repository.forOne(theBalance());

    expect(available(held)).toBe(15);
    expect(available(approved)).toBe(15);
    expect(approved.pending).toBe(0);
    expect(approved.taken).toBe(5);

    /* And what a sum of the signed movements would have said instead. */
    const { rows } = await admin.query('SELECT sum(days) AS total FROM leave_ledger_entry');
    expect(Number(rows[0].total)).toBe(10);
  });

  /* FR 36 and FR 36a share a column, because carried days and the lapsing of carried
     days are the same days. */
  it('lapsed carry over comes out of what was carried', async () => {
    await post('CARRY_FORWARD', 5);
    await post('EXPIRY', -2);

    const balance = await repository.forOne(theBalance());

    expect(balance.carriedOver).toBe(3);
    expect(balance.entitled).toBe(0);
  });

  /* FR 37 is kept apart from the entitlement on purpose: "the policy gave me this"
     and "somebody decided this" are what an employee reading a surprising figure
     most needs told apart. */
  it('a manual adjustment never touches what the year granted', async () => {
    await post('GRANT', 20);
    await balances.adjust(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: -3,
      reason: 'Days taken before the system went live',
    });

    const balance = await repository.forOne(theBalance());

    expect(balance.entitled).toBe(20);
    expect(balance.adjustment).toBe(-3);
    expect(available(balance)).toBe(17);
  });

  /**
   * §8.6b: sick leave is exceedable with a certificate, so the balance goes below
   * nought and the system says so rather than clamping. FR 32a.
   *
   * The RESERVATION is posted as well as the DEDUCTION, and not for tidiness. A
   * `DEDUCTION` finalises a hold that a `RESERVATION` took, so it *releases* days
   * from `pending` as it moves them into `taken` — which is what `BUCKETS` says and
   * what the test above proves. A history with the deduction and no reservation in
   * front of it is not one this system produces, and a cache asked to project it
   * faithfully reports pending days that were never held.
   *
   * Nothing refuses that history, deliberately: there is no CHECK on any of the five
   * figures, because the write a CHECK would refuse is the trigger's, and a rolled
   * back trigger takes the *ledger entry* down with it. A movement that genuinely
   * happened has to be recordable even when the cache of it looks impossible; that
   * is what §7.4's reconciliation report is for.
   */
  it('goes below nought where the leave type allows it', async () => {
    await post('GRANT', 12, { leave_type_id: sickId });
    await post('RESERVATION', -15, { leave_type_id: sickId });
    await post('DEDUCTION', -15, { leave_type_id: sickId });

    const balance = await balances.forOne(asThemselves(), theBalance({ leaveTypeId: sickId }));

    expect(balance.available).toBe(-3);
  });
});

/* -------------------------------------------- fractions where they belong, and not */

describe('what somebody is owed may carry a fraction; what they have taken may not', () => {
  /* §8.6d: a joiner on 1 July is owed 20 × 184/365 = 10.08 days. */
  it('a pro rated grant keeps its hundredths through the cache', async () => {
    await post('GRANT', 10.08);
    await post('CARRY_FORWARD', 2.5);

    const balance = await balances.forOne(asThemselves(), theBalance());

    expect(balance.entitled).toBe(10.08);
    expect(balance.carriedOver).toBe(2.5);
    expect(balance.available).toBe(12.58);
  });

  /* And the two columns that count days out of a request are whole numbers in the
     schema, not merely whole by habit. FR 24, LMS 209. */
  it('and the columns counting taken and pending days are integers', async () => {
    await post('RESERVATION', -5);

    const { rows } = await admin.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'leave_balance'
          AND column_name IN ('entitled', 'carried_over', 'adjustment', 'taken', 'pending')
        ORDER BY column_name`,
    );

    expect(rows).toEqual([
      { column_name: 'adjustment', data_type: 'numeric' },
      { column_name: 'carried_over', data_type: 'numeric' },
      { column_name: 'entitled', data_type: 'numeric' },
      { column_name: 'pending', data_type: 'integer' },
      { column_name: 'taken', data_type: 'integer' },
    ]);
  });

  /* The three accrued figures come back from the driver as text and the two counts
     do not, which is the same distinction the columns are declared with. The
     repository is the one place either becomes a number. */
  it('and every figure the repository hands back is a number', async () => {
    await post('GRANT', 10.08);
    await post('DEDUCTION', -2);

    const balance = await repository.forOne(theBalance());

    expect(typeof balance.entitled).toBe('number');
    expect(typeof balance.taken).toBe('number');
    expect(balance.entitled).toBe(10.08);
    expect(balance.taken).toBe(2);
  });
});

/* ----------------------------------- in the same transaction as the entry, or not at all */

describe('the balance moves with the entry that caused it', () => {
  /**
   * The story's second criterion, from the side that proves it is one transaction
   * rather than two: the entry is visible and so is the balance, on the same
   * connection, before anything has committed.
   */
  it('is already right inside the transaction that posted the entry', async () => {
    await admin.query('BEGIN');
    await post('GRANT', 20);

    const { rows } = await admin.query('SELECT entitled FROM leave_balance');
    expect(Number(rows[0].entitled)).toBe(20);

    await admin.query('COMMIT');
  });

  /**
   * Several entries in one transaction, which is the shape a year rollover has.
   *
   * `postAll()` writes a `CARRY_FORWARD` and a `GRANT` together because half of
   * either landing is a balance that explains itself wrongly rather than not at all.
   * The trigger fires once per row and recomputes the whole balance each time, so
   * two entries in one balance recompute it twice and land on the same figures — the
   * recompute is idempotent, which is the property that makes firing per row safe
   * rather than merely tolerable.
   */
  it('and is right after several entries written together', async () => {
    const rollover = [
      { entryType: 'CARRY_FORWARD' as const, days: 5, reason: 'Carried from 2025' },
      { entryType: 'GRANT' as const, days: 20, reason: 'Annual entitlement for 2026' },
    ].map((entry) =>
      validateNewLedgerEntry({
        employeeId: people.officer,
        leaveTypeId: annualId,
        leaveYearId: y2026.id,
        ...entry,
      }),
    );

    await new LedgerRepository(db).postAll(system, rollover);

    const balance = await repository.forOne(theBalance());

    expect(balance.carriedOver).toBe(5);
    expect(balance.entitled).toBe(20);
    expect(available(balance)).toBe(25);
  });

  /* And the other side of the same criterion. A cache that survived the rollback of
     the entry that made it would be a figure with nothing behind it — which is
     exactly the state design principle 1 exists to make impossible. */
  it('and is rolled back with it', async () => {
    await post('GRANT', 20);

    await admin.query('BEGIN');
    await post('ADJUSTMENT', 7);
    await admin.query('ROLLBACK');

    const balance = await repository.forOne(theBalance());

    expect(balance.entitled).toBe(20);
    expect(balance.adjustment).toBe(0);
  });

  /**
   * Two people posting against one balance at the same time, and neither entry
   * lost.
   *
   * The reason `rebuild_one_balance_from_the_ledger()` takes the row's lock in one
   * statement and computes the sums in the next. Written as a single upsert with the
   * aggregate inside it, both transactions would read the ledger before either took
   * the lock and the second would overwrite the first's total with a sum that was
   * missing a row — a cache short by a day, with nothing in the ledger to say why.
   *
   * The first connection commits last on purpose. That is the shape a lost update
   * actually takes.
   */
  it('and survives two transactions posting against it at once', async () => {
    const posting = async (days: number, holdFor: number) => {
      const client = new Client({ connectionString: testDatabaseUrl });
      await client.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO leave_ledger_entry (employee_id, leave_type_id, leave_year_id, entry_type, days, reason)
           VALUES ($1, $2, $3, 'GRANT', $4, 'posted concurrently')`,
          [people.officer, annualId, y2026.id, days.toFixed(2)],
        );
        await new Promise((resolve) => setTimeout(resolve, holdFor));
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    };

    await Promise.all([posting(3, 400), posting(4, 50)]);

    const balance = await repository.forOne(theBalance());

    expect(balance.entitled).toBe(7);
  });

  /* §8.9's exception, followed through to the cache. A closed leave year refuses
     every kind of entry but an ADJUSTMENT, and the one it accepts moves the figure
     like any other — a settled year that could be corrected in the ledger and not in
     the balance would be two answers to the same question. */
  it('and a settled leave year still caches the one entry it accepts', async () => {
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
    );
    const y2025 = (await years.byLabel(system, '2025'))!;
    await years.close(asAdministrator(), y2025.id);

    await balances.adjust(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2025.id,
      days: 2,
      reason: 'Two days owed from 2025, agreed with the head of HR',
    });

    const settled = await balances.forOne(asAdministrator(), theBalance({ leaveYearId: y2025.id }));

    expect(settled.adjustment).toBe(2);
    expect(settled.available).toBe(2);
  });
});

/* ------------------------------------------------ nothing writes a balance by hand */

describe('a balance is written by the ledger and by nothing else', () => {
  /* On the owner connection, which is the one that matters: a refusal the migration
     user can step around is a convention rather than a property. */
  it.each([
    ['an insert', `INSERT INTO leave_balance (employee_id, leave_type_id, leave_year_id) VALUES`],
    ['an update', 'UPDATE leave_balance SET entitled = 999'],
    ['a delete', 'DELETE FROM leave_balance'],
  ])('refuses %s by anybody', async (_what, statement) => {
    await post('GRANT', 20);

    const sql = statement.endsWith('VALUES')
      ? `${statement} (${people.officer}, ${annualId}, ${y2026.id})`
      : statement;

    await expect(admin.query(sql)).rejects.toMatchObject({
      constraint: 'leave_balance_comes_only_from_the_ledger',
      code: '23001',
    });
  });

  /* And says what to do instead, rather than only that the door is locked. NFR USA
     03 — the person meeting this is somebody who can see that a figure is wrong. */
  it('and the refusal names the way through', async () => {
    await post('GRANT', 20);

    await expect(admin.query('UPDATE leave_balance SET entitled = 999')).rejects.toMatchObject({
      hint: expect.stringContaining('leave_ledger_entry'),
    });
  });

  /**
   * The application's half, which is privileges rather than a trigger.
   *
   * `leave_balance` is the one table in this schema that gives the default
   * privileges back: the restricted-application-role migration grants SELECT and
   * INSERT on every future table, and this one revokes the INSERT because nothing
   * above the database writes here.
   */
  it('and lms_app may read a balance and may not write one', async () => {
    await post('GRANT', 20);

    await admin.query('BEGIN');
    await admin.query('SET LOCAL ROLE lms_app');

    const { rows } = await admin.query('SELECT entitled FROM leave_balance');
    expect(Number(rows[0].entitled)).toBe(20);

    for (const statement of [
      `INSERT INTO leave_balance (employee_id, leave_type_id, leave_year_id) VALUES (${people.officer}, ${sickId}, ${y2026.id})`,
      'UPDATE leave_balance SET entitled = 999',
      'DELETE FROM leave_balance',
    ]) {
      await expect(admin.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      await admin.query('ROLLBACK');
      await admin.query('BEGIN');
      await admin.query('SET LOCAL ROLE lms_app');
    }

    await admin.query('ROLLBACK');
  });

  /**
   * And posting an entry as the application still moves the balance, which is what
   * makes the two rules above compatible rather than merely both true.
   *
   * `rebuild_one_balance_from_the_ledger()` is SECURITY DEFINER for exactly this: a
   * role that cannot write the table still cannot write it, and the ledger it *can*
   * write keeps the cache in step on its behalf.
   */
  it('and an entry posted as lms_app still moves it', async () => {
    await admin.query('BEGIN');
    await admin.query('SET LOCAL ROLE lms_app');
    await admin.query(
      `INSERT INTO leave_ledger_entry (employee_id, leave_type_id, leave_year_id, entry_type, days, reason)
       VALUES ($1, $2, $3, 'GRANT', '20.00', 'posted as the application')`,
      [people.officer, annualId, y2026.id],
    );

    const { rows } = await admin.query('SELECT entitled FROM leave_balance');
    expect(Number(rows[0].entitled)).toBe(20);

    await admin.query('COMMIT');
  });

  /* Nothing here is audited, and its absence is the decision. `audit_log` records
     that a row changed; this table changes only because a ledger entry was written,
     and the ledger entry is the account. An audit trigger here would write a second
     copy of it that could disagree. */
  it('and nothing about a balance reaches the audit log', async () => {
    await post('GRANT', 20);
    await post('DEDUCTION', -2);

    const { rows } = await admin.query(
      `SELECT count(*) FROM audit_log WHERE entity IN ('leave_balance', 'leave_ledger_entry')`,
    );

    expect(rows[0].count).toBe('0');
  });
});

/* ------------------------------------------------ the cache is a function of the ledger */

describe('every figure can be thrown away and comes back the same', () => {
  /**
   * Design principle 1, as an experiment rather than as a sentence.
   *
   * The five figures are deleted outright and rebuilt from the rows that produced
   * them, and they come back identical — because they were never anything but a sum
   * of those rows. This is also the whole of §7.4's reconciliation: what that story
   * still has to bring is the walk over every balance, the comparison, and somebody
   * to tell.
   */
  it('because they are a sum of ledger rows that are all still there', async () => {
    await post('GRANT', 10.08);
    await post('CARRY_FORWARD', 5);
    await post('EXPIRY', -1.5);
    await post('ADJUSTMENT', 2);
    await post('RESERVATION', -4);
    await post('DEDUCTION', -4);
    /* FR 47, LMS 324. Against the request that spent the days, which is this one. */
    await post('RECALCULATION', 1);
    await post('RESERVATION', -3);
    await post('RELEASE', 1);

    const before = await repository.forOne(theBalance());

    await admin.query('TRUNCATE leave_balance');
    await admin.query('SELECT rebuild_one_balance_from_the_ledger($1, $2, $3)', [
      people.officer,
      annualId,
      y2026.id,
    ]);

    const after = await repository.forOne(theBalance());

    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    expect(after.entitled).toBe(10.08);
    expect(after.carriedOver).toBe(3.5);
    expect(after.adjustment).toBe(2);
    expect(after.taken).toBe(3);
    expect(after.pending).toBe(2);
    expect(available(after)).toBe(10.58);
  });
});

/* --------------------------------------------------------------- who may read one */

describe('who may read a balance', () => {
  beforeEach(async () => {
    await post('GRANT', 20);
  });

  /* FR 53. The point of the system, and the story's own "as an employee". */
  it('their own', async () => {
    expect((await balances.forOne(asThemselves(), theBalance())).available).toBe(20);
  });

  /* FR 55. Direct reports only — the argument for stopping at one level is
     features/employee/policy.ts's and is not repeated here. */
  it('their line manager', async () => {
    expect(await balances.forEmployee(asTheirManager(), people.officer)).toHaveLength(1);
  });

  /* FR 56. */
  it('and anybody holding a role that reads every record', async () => {
    expect((await balances.forOne(asAdministrator(), theBalance())).available).toBe(20);
  });

  /**
   * And nobody else, silently.
   *
   * The same decision `LedgerService.history` is refused by, deliberately: a balance
   * is the ledger added up, so who may see it is not a second question and there is
   * no second policy file for one of the two to drift out of.
   */
  it('and nobody else, without being told the person exists', async () => {
    await expect(balances.forOne(asAColleague(), theBalance())).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(balances.forEmployee(asAColleague(), people.officer)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  it('and an id that is nobody is not a balance at all', async () => {
    await expect(balances.forEmployee(asAdministrator(), '987654321')).rejects.toBeInstanceOf(
      EmployeeNotFound,
    );
  });
});

/* ------------------------------------------------------------------ what a screen reads */

describe('the read a balance screen does', () => {
  /* §7.4 orders the balance read by `display_order`, which is why that column
     exists: the order a screen lists annual, sick and compassionate leave in is a
     decision somebody made rather than an alphabetical accident. */
  it('is in the order leave types are shown in', async () => {
    const types = (
      await admin.query(
        "SELECT id, code FROM leave_type WHERE code IN ('ANNUAL', 'SICK', 'COMPASSIONATE') ORDER BY display_order, id",
      )
    ).rows as { id: string; code: string }[];

    /* Posted in the reverse of the order they should come back in. */
    for (const type of [...types].reverse()) {
      await post('GRANT', 5, { leave_type_id: type.id });
    }

    const held = await balances.forEmployee(asThemselves(), people.officer, y2026.id);

    expect(held.map((balance) => balance.leaveTypeId)).toEqual(types.map((type) => type.id));
  });

  /* And earlier leave years come first, because carried days mean last year is
     still worth reading. */
  it('and puts an earlier leave year before a later one', async () => {
    const y2027 = (await years.byLabel(system, '2027'))!;

    await post('GRANT', 20, { leave_year_id: y2027.id });
    await post('GRANT', 18);

    const held = await balances.forEmployee(asThemselves(), people.officer);

    expect(held.map((balance) => balance.leaveYearId)).toEqual([y2026.id, y2027.id]);
  });

  /* One row read, and the available figure beside it. The whole of "a glance rather
     than a wait": nothing here walks a history. */
  it('and carries the figure the story is about', async () => {
    await post('GRANT', 20);
    await post('CARRY_FORWARD', 5);
    await post('RESERVATION', -3);
    await post('DEDUCTION', -3);
    await post('RESERVATION', -2);

    const [balance] = await balances.forEmployee(asThemselves(), people.officer, y2026.id);

    expect(balance).toMatchObject({
      entitled: 20,
      carriedOver: 5,
      adjustment: 0,
      taken: 3,
      pending: 2,
      available: 20,
    });
  });

  /* Everybody's figures for one year, which is FR 63's liability report and the
     rollover's read. `leave_balance_by_year` is exactly this. */
  it('and a whole leave year can be read at once', async () => {
    await post('GRANT', 20);
    await post('GRANT', 15, { employee_id: people.engineer });
    await post('GRANT', 12, { employee_id: people.teamLead, leave_type_id: sickId });

    const everybody = await repository.forYear(y2026.id);
    const annualOnly = await repository.forYear(y2026.id, annualId);

    expect(everybody).toHaveLength(3);
    expect(annualOnly.map((balance) => balance.entitled).sort((one, other) => one - other)).toEqual(
      [15, 20],
    );
  });
});

/* --------------------------------------------- reserve, commit and release. LMS 212 */

/**
 * The three operations a leave request moves a balance through. FR 26, §8.2.
 *
 * The unit suite proves the arithmetic of the rules; what needs a server is that they
 * are applied to a figure nobody else can be moving at the time, and that the movement
 * and the cache land together. Every test below goes through `BalanceService`, because
 * the story's first criterion is that there is nothing else to go through.
 */
describe('holding days, spending them, and giving them back', () => {
  /** Twelve days of annual leave, which is what most of these are asked against. */
  async function twelveDays(): Promise<void> {
    await post('GRANT', 12);
  }

  it('holds days, and takes them out of what may be booked', async () => {
    await twelveDays();

    const { entry, balance } = await askFor();

    expect(entry.entryType).toBe('RESERVATION');
    expect(entry.days).toBe(-5);
    expect(balance.pending).toBe(5);
    expect(balance.taken).toBe(0);
    expect(balance.available).toBe(7);
  });

  /* FR 26. The refusal carries the arithmetic, because a screen that says "you have 12
     and asked for 15" is telling somebody what to ask for instead. */
  it('and refuses days that are not there, saying how short it is', async () => {
    await twelveDays();

    await expect(askFor({ days: 15 })).rejects.toBeInstanceOf(BalanceOverdrawn);
  });

  /**
   * And a refused reserve writes nothing at all.
   *
   * Two things could have been left behind and neither is: a ledger entry, which
   * would be days held against a request that was refused, and a row of zeros in the
   * cache, which is why `hold_one_balance_while_it_is_checked()` declines to open one.
   */
  it('and a refused reserve leaves no entry and no balance behind', async () => {
    await expect(askFor()).rejects.toBeInstanceOf(BalanceOverdrawn);

    expect((await admin.query('SELECT count(*) FROM leave_ledger_entry')).rows[0].count).toBe('0');
    expect((await admin.query('SELECT count(*) FROM leave_balance')).rows[0].count).toBe('0');
  });

  /* FR 32a and §8.6b. Sick leave is a documentation threshold rather than a cap, read
     off `exceedable_with_document` — no leave type code is compared to anything. */
  it('and lets a balance that may be exceeded go below nought', async () => {
    await post('GRANT', 3, { leave_type_id: sickId });

    const { balance } = await askFor({ leaveTypeId: sickId, days: 5 });

    expect(balance.available).toBe(-2);
  });

  it('and days already held count against the next request', async () => {
    await twelveDays();
    await askFor();

    await expect(askFor({ days: 8 })).rejects.toBeInstanceOf(BalanceOverdrawn);

    const { balance } = await askFor({ days: 7 });
    expect(balance.available).toBe(0);
  });

  /**
   * Approval moves held days to taken days and spends nothing again.
   *
   * The case the whole design turns on. Available is unmoved by the commit, because
   * the reserve already took the days out of it — anything that subtracted them a
   * second time would be the double deduction this story is named after.
   */
  it('turns held days into taken days without spending them twice', async () => {
    await twelveDays();
    const { request } = await askFor();

    const { entry, balance } = await balances.commit(asTheirManager(), against(request.id));

    expect(entry.entryType).toBe('DEDUCTION');
    expect(balance.pending).toBe(0);
    expect(balance.taken).toBe(5);
    expect(balance.available).toBe(7);
  });

  /**
   * And the second approval of the same five days is refused.
   *
   * The story's "so that", proved end to end. There is nothing held for the second
   * commit to draw down, because the first one emptied it, and the refusal says how
   * many days actually are held rather than failing obscurely.
   */
  it('and refuses to approve the same days a second time', async () => {
    await twelveDays();
    const { request } = await askFor();
    await balances.commit(asTheirManager(), against(request.id));

    await expect(balances.commit(asTheirManager(), against(request.id))).rejects.toBeInstanceOf(
      NotEnoughHeld,
    );

    const balance = await balances.forOne(asThemselves(), theBalance());
    expect(balance.taken).toBe(5);
    expect(balance.available).toBe(7);
  });

  it('gives held days back, and refuses to give back more than is held', async () => {
    await twelveDays();
    const { request } = await askFor();

    const { entry, balance } = await balances.release(
      asThemselves(),
      against(request.id, { days: 3 }),
    );

    expect(entry.entryType).toBe('RELEASE');
    expect(balance.pending).toBe(2);
    expect(balance.available).toBe(10);

    await expect(
      balances.release(asThemselves(), against(request.id, { days: 3 })),
    ).rejects.toBeInstanceOf(NotEnoughHeld);
  });

  /* Days that were taken are not days that are held. Undoing an approved absence is
     FR 25's recalculation or an adjustment, and neither of them is a release. */
  it('and will not give back days that have already been taken', async () => {
    await twelveDays();
    const { request } = await askFor();
    await balances.commit(asTheirManager(), against(request.id));

    await expect(balances.release(asThemselves(), against(request.id))).rejects.toBeInstanceOf(
      NotEnoughHeld,
    );
  });

  /* FR 24 and LMS 209, refused before the column ever sees it so the message names the
     field. Which way the balance moves is the method that was called, never the sign. */
  it('and refuses half a day, and a figure with a sign on it', async () => {
    await twelveDays();

    await expect(askFor({ days: 2.5 })).rejects.toBeInstanceOf(InvalidBalanceMovement);
    await expect(askFor({ days: -5 })).rejects.toBeInstanceOf(InvalidBalanceMovement);
  });

  /* A settled year takes no new figures but an adjustment, which is the ledger's own
     rule reaching an operation that knows nothing about it. §8.9. */
  it('and a settled leave year takes no reservation', async () => {
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
    );
    const y2025 = (await years.byLabel(system, '2025'))!;
    await post('GRANT', 12, { leave_year_id: y2025.id });
    await years.close(asAdministrator(), y2025.id);

    await expect(askFor({ leaveYearId: y2025.id })).rejects.toBeInstanceOf(InvalidLedgerEntry);
  });

  /* Every movement comes back with the balance it produced, read inside the same
     transaction — so it is the figure this movement made rather than the figure at the
     time of asking. */
  it('and every movement hands back the balance it produced', async () => {
    await twelveDays();

    const held = await askFor();
    const stored = await balances.forOne(asThemselves(), theBalance());

    expect(held.balance).toEqual(stored);
  });
});

/* --------------------------------------------------- the window, held open. §8.2 */

describe('two screens asking for the same days', () => {
  /**
   * The story's fourth criterion, and the failure it exists to prevent.
   *
   * Five days available and two requests for five days, sent at the same instant.
   * Without the lock both read five, both find five affordable, and both write — ten
   * days held against a balance that covered five. With it, the second waits at
   * `holdStill()` until the first commits, then re-reads a balance with nothing left
   * in it.
   *
   * Exactly one succeeds, and the assertions say so from three directions: what each
   * call returned, what the ledger holds, and what the cache says.
   */
  it('lets exactly one of them through', async () => {
    await post('GRANT', 5);

    const asking = () => askFor();

    const outcomes = await Promise.allSettled([asking(), asking()]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(BalanceOverdrawn);

    const { rows } = await admin.query(
      "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RESERVATION'",
    );
    expect(rows[0].count).toBe('1');

    const balance = await balances.forOne(asThemselves(), theBalance());
    expect(balance.pending).toBe(5);
    expect(balance.available).toBe(0);
  });

  /* And where there are days for both, both get them. A lock that made the second
     caller wait and then refused them would be a lock that had stopped being about
     the days. */
  it('and lets both through when the days are there for both', async () => {
    await post('GRANT', 12);

    const asking = (days: number) => askFor({ days });

    await Promise.all([asking(5), asking(5)]);

    const balance = await balances.forOne(asThemselves(), theBalance());
    expect(balance.pending).toBe(10);
    expect(balance.available).toBe(2);
  });

  /* The same window around approval. Two approvers pressing the button on one request
     is the same race, and the loser is refused rather than deducting the days again. */
  it('and lets only one of two approvals of one hold through', async () => {
    await post('GRANT', 12);
    const { request } = await askFor();

    const approving = () => balances.commit(asTheirManager(), against(request.id));

    const outcomes = await Promise.allSettled([approving(), approving()]);

    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const balance = await balances.forOne(asThemselves(), theBalance());
    expect(balance.taken).toBe(5);
    expect(balance.pending).toBe(0);
  });
});

/* ------------------------------------------------------- who may move one, FR 26 */

describe('who may move a balance', () => {
  beforeEach(async () => {
    await post('GRANT', 20);
  });

  it('is asked for by the person taking the leave', async () => {
    await expect(askFor()).resolves.toMatchObject({
      balance: { pending: 5 },
    });
  });

  /* The one place a line manager's standing over a report does not carry. They may
     read the balance and approve against it; asking for leave on somebody's behalf is
     HR's, FR 18. */
  it('and not asked for by their line manager', async () => {
    await expect(askFor({}, asTheirManager())).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('and approved by their line manager, never by themselves', async () => {
    const { request } = await askFor();

    await expect(balances.commit(asThemselves(), against(request.id))).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(balances.commit(asTheirManager(), against(request.id))).resolves.toMatchObject({
      balance: { taken: 5 },
    });
  });

  it('and never moved by a colleague, in any of the three ways', async () => {
    const { request } = await askFor();

    for (const move of [
      () => askFor({}, asAColleague()),
      () => balances.commit(asAColleague(), against(request.id)),
      () => balances.release(asAColleague(), against(request.id)),
    ]) {
      await expect(move()).rejects.toBeInstanceOf(NotAuthorised);
    }
  });

  /* And a refusal costs no lock: the policy is asked before the transaction opens, so
     a colleague guessing at ids cannot make anybody else wait. */
  it('and a refused movement never opened a transaction to be refused in', async () => {
    await expect(askFor({}, asAColleague())).rejects.toBeInstanceOf(NotAuthorised);

    expect((await admin.query('SELECT count(*) FROM leave_ledger_entry')).rows[0].count).toBe('1');
    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('0');
  });

  it('and an id that is nobody is not a balance at all', async () => {
    await expect(askFor({ employeeId: '987654321' }, asAdministrator())).rejects.toBeInstanceOf(
      EmployeeNotFound,
    );
  });
});
