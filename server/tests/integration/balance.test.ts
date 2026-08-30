import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { available, type BalanceKey } from '../../src/domain/balance.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import {
  BUCKETS,
  LEDGER_ENTRY_TYPES,
  type LedgerEntryType,
  validateNewLedgerEntry,
} from '../../src/domain/ledger.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';
import { BalanceRepository } from '../../src/repositories/balance-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { LeaveYearRepository } from '../../src/repositories/leave-year-repository.js';
import { LedgerRepository } from '../../src/repositories/ledger-repository.js';
import { BalanceService } from '../../src/services/balance-service.js';
import { LedgerService } from '../../src/services/ledger-service.js';
import { LeaveYearService } from '../../src/services/leave-year-service.js';
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

const testDatabaseUrl = inject('testDatabaseUrl');

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('balance integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let balances: BalanceService;
let repository: BalanceRepository;
let ledger: LedgerService;
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
  balances = new BalanceService(repository, guard, new EmployeeRepository(db));
  ledger = new LedgerService(new LedgerRepository(db), guard, new EmployeeRepository(db));

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  /* The cache first and the ledger second, which is the order they depend in. Both
     by TRUNCATE, because `leave_balance` refuses a DELETE on every connection and
     `leave_ledger_entry` refuses one too — and no row trigger fires on TRUNCATE,
     which is the door both migrations leave open for exactly this. */
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_ledger_entry');
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0]
    .id as string;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_ledger_entry');
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
 * A ledger entry written straight to the table, bypassing every layer above it.
 *
 * Most of this file posts entries this way rather than through `LedgerService`,
 * because six of the eight kinds have no service writer and because what is being
 * proved is that the balance follows a *ledger entry* rather than a service call.
 */
async function post(
  entryType: LedgerEntryType,
  days: number,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const row = {
    employee_id: people.officer,
    leave_type_id: annualId,
    leave_year_id: y2026.id,
    entry_type: entryType,
    days: days.toFixed(2),
    reason: `a ${entryType.toLowerCase()} for the suite`,
    ...overrides,
  };

  const columns = Object.keys(row);
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  const { rows } = await admin.query(
    `INSERT INTO leave_ledger_entry (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    Object.values(row),
  );

  return rows[0] as Record<string, unknown>;
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
  return ['RESERVATION', 'DEDUCTION', 'EXPIRY'].includes(entryType) ? -1 : 1;
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
 * `BUCKETS` in domain/ledger.ts against the trigger that performs it.
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
    await ledger.adjust(asAdministrator(), {
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

    await ledger.adjust(asAdministrator(), {
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
    await post('RESERVATION', -3);
    await post('RELEASE', 1);
    await post('RECALCULATION', 1);

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
     auth/employee-policy.ts's and is not repeated here. */
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
