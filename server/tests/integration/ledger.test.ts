import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import {
  InvalidLedgerEntry,
  LEDGER_ENTRY_TYPES,
  REQUEST_MOVEMENTS,
  LedgerEntryNotFound,
  type LedgerEntryType,
} from '../../src/domain/ledger.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';
import { BalanceRepository } from '../../src/repositories/balance-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { LeaveYearRepository } from '../../src/repositories/leave-year-repository.js';
import { LedgerRepository } from '../../src/repositories/ledger-repository.js';
import { Transactions } from '../../src/repositories/transaction.js';
import { type Adjustment, BalanceService } from '../../src/services/balance-service.js';
import { LedgerService } from '../../src/services/ledger-service.js';
import { LeaveYearService } from '../../src/services/leave-year-service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The balance ledger against a real database. FR 27, §5.7. LMS 210.
 *
 * The unit suite covers what an entry is and what makes one valid; ../unit/ledger.test.ts
 * is where the pure half is proved. What needs a database is the half the database
 * decides, and for this story that is more of the total than usual, because the
 * story's central claim is one only the database can make:
 *
 *   **No connection can change or remove an entry.** Not the application, which
 *   holds no UPDATE or DELETE on the table. Not the owner either, which is the one
 *   that matters — an immutability that the migration user can step around is a
 *   convention, and FR 27 asks for a property. Everything below that says "by
 *   anybody" is run on the owner connection deliberately.
 *
 *   **Who wrote it and when are not the writer's to say.** The application sends
 *   neither, and a writer that sends both is overruled. That is a trigger, so it
 *   holds for a psql prompt too.
 *
 *   **The same eight kinds of movement, and the same signs.** The domain holds a
 *   list and the column holds a CHECK; a disagreement between them is a write that
 *   fails at the last moment or a row nothing can render.
 *
 *   **A settled leave year takes no new figures — except an adjustment.** §8.9's
 *   exception, which is the one rule here that no other table in this schema has,
 *   and the one most likely to be "tidied up" by somebody who has read the holiday
 *   rules and assumes this table works the same way.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('ledger integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let ledger: LedgerService;
let balances: BalanceService;
let repository: LedgerRepository;
let yearRepository: LeaveYearRepository;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

/** The 2026 leave year and annual leave, which nearly every test posts against. */
let y2026: LeaveYear;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  repository = new LedgerRepository(db);
  yearRepository = new LeaveYearRepository(db);
  years = new LeaveYearService(yearRepository, guard);
  ledger = new LedgerService(repository, guard, new EmployeeRepository(db));
  balances = new BalanceService(
    new BalanceRepository(db),
    guard,
    new EmployeeRepository(db),
    new Transactions(db),
  );

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  /* The ledger first: its rows point at employees and leave years, and neither can
     be replaced underneath them. TRUNCATE rather than DELETE because the table
     refuses a DELETE on every connection, which is the property this file exists to
     prove — and a row trigger does not fire on TRUNCATE, which is the door the
     migration leaves open for exactly this and for the seed. */
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/**
 * The leave years as the migration left them.
 *
 * The same shape ../integration/holiday.test.ts uses, and for the same reason: half
 * these tests close a year, and a closed year refuses to be deleted by anybody.
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
 * 2025, closed, so that the settled-year rules have something to hold.
 *
 * Written on the owner connection because the service refuses a year overlapping
 * 2026, and dated a year back so it stays finished however long this suite lives.
 * It has to abut the run the migration seeded, which is why it is the whole of 2025.
 */
async function aSettledYear(): Promise<LeaveYear> {
  await admin.query(
    `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
  );

  const y2025 = (await years.byLabel(system, '2025'))!;
  await years.close(asAdministrator(), y2025.id);

  return y2025;
}

/** An entry written straight to the table, bypassing every layer above it. */
async function writeDirectly(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    employee_id: people.officer,
    leave_type_id: annualId,
    leave_year_id: y2026.id,
    entry_type: 'GRANT',
    days: '20.00',
    reason: 'straight to the table',
    corrects_id: null,
    ...overrides,
  };

  /* LMS 301: a RESERVATION, DEDUCTION, RELEASE or RECALCULATION has to name a request,
     and a request has to hold days — so a suite writing one of these straight to the
     table builds the request too. It is the same rule from the other side of the door as
     everything else in this file: what the database refuses is refused whoever asked.

     The two cases differ in which entry does the holding. A RESERVATION *is* the hold,
     so it goes in the same transaction as the request it holds days for and nothing else
     is written. The other three draw one down, so a request already holding days is set
     up first and they name it. */
  const movesForARequest =
    (REQUEST_MOVEMENTS as readonly string[]).includes(row.entry_type as string) &&
    row.leave_request_id === undefined;

  if (movesForARequest && row.entry_type === 'RESERVATION') {
    return withARequestOfItsOwn(row);
  }

  if (movesForARequest) {
    row.leave_request_id = await aRequestHoldingDays(row);
  }

  return insertEntry(row);
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

/** A RESERVATION and the request whose days it holds, in one transaction. */
async function withARequestOfItsOwn(
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await admin.query('BEGIN');
  try {
    const written = await insertEntry({ ...row, leave_request_id: await insertRequest(row, 1) });
    await admin.query('COMMIT');

    return written;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

/**
 * A request and the RESERVATION that holds its days, written together.
 *
 * `leave_request_holds_its_days` is deferred and judged at COMMIT, so the pair has to
 * be one transaction — which is exactly the shape `BalanceService.reserveForRequest`
 * writes them in. The period runs from the first day of the leave year so that any
 * figure is a period the table accepts.
 */
async function aRequestHoldingDays(key: Record<string, unknown>): Promise<string> {
  await admin.query('BEGIN');
  try {
    const id = await insertRequest(key, 1);

    await admin.query(
      `INSERT INTO leave_ledger_entry (
          employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       VALUES ($1, $2, $3, 'RESERVATION', '-1.00', 'held for the suite', $4)`,
      [key.employee_id, key.leave_type_id, key.leave_year_id, id],
    );

    await admin.query('COMMIT');
    return id;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

/** The request row alone, for a caller that has a transaction open. */
async function insertRequest(key: Record<string, unknown>, days: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO leave_request (
        employee_id, leave_type_id, leave_year_id,
        start_date, end_date, reason, counting_basis, days, calendar_days, status)
     SELECT $1, $2, $3, y.start_date, y.start_date + ($4::int - 1), 'a request for the suite',
            'CALENDAR_DAYS', $4, $4, 'SUBMITTED'
       FROM leave_year y WHERE y.id = $3
     RETURNING id`,
    [key.employee_id, key.leave_type_id, key.leave_year_id, days],
  );

  return rows[0].id;
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/** The team lead, who is `officer`'s and `partTimer`'s line manager. */
function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** Somebody with no standing at all towards the officer's balance. */
function asAColleague() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/**
 * The two writers this story shipped, which are `BalanceService`'s since LMS 212.
 *
 * That story's first criterion is that exactly one class posts a balance movement, so
 * `LedgerService` reads the account and writes nothing. These two are shims and are
 * named for what they were: everything below is about what the *table* does to an
 * entry, and which service handed it over is not what any of it is testing.
 *
 * They unwrap `.entry`, because a movement now comes back with the balance it
 * produced beside it.
 */
async function adjust(actor: ReturnType<typeof asAdministrator>, adjustment: Adjustment) {
  return (await balances.adjust(actor, adjustment)).entry;
}

async function correct(actor: ReturnType<typeof asAdministrator>, entryId: string, reason: string) {
  return (await balances.correct(actor, entryId, reason)).entry;
}

/** An adjustment posted by HR, which is the one writer this story ships. */
function anAdjustment(days: number, reason = 'Opening balance at go live') {
  return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id, days, reason };
}

/* ---------------------------------------------- the table holds what it says */

describe('the eight kinds of movement, on a migrated database', () => {
  /* The domain holds a list and the column holds a CHECK. A type the domain knows
     and the column refuses is a write that fails at the last moment; one the column
     allows and the domain does not is days moving for a reason no screen can
     render. Asked of the server rather than of the SQL text, which is the
     authoritative answer. */
  it.each(LEDGER_ENTRY_TYPES)('%s is a movement the column accepts', async (entryType) => {
    const days = entryType === 'GRANT' ? 20 : signFor(entryType);

    const written = await writeDirectly({ entry_type: entryType, days: days.toFixed(2) });

    expect(written.entry_type).toBe(entryType);
  });

  it('and a ninth is not', async () => {
    await expect(writeDirectly({ entry_type: 'WRITE_OFF' })).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_type_known',
    });
  });

  it('refuses a movement of no days, whatever kind it is', async () => {
    for (const entryType of LEDGER_ENTRY_TYPES) {
      await expect(
        writeDirectly({ entry_type: entryType, days: '0.00' }),
        entryType,
      ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_sign_matches_the_type' });
    }
  });

  it('refuses a movement that goes the wrong way for its kind', async () => {
    for (const entryType of LEDGER_ENTRY_TYPES) {
      if (entryType === 'ADJUSTMENT') continue;

      await expect(
        writeDirectly({ entry_type: entryType, days: (-signFor(entryType)).toFixed(2) }),
        entryType,
      ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_sign_matches_the_type' });
    }
  });

  it('refuses an entry with no reason on it', async () => {
    await expect(writeDirectly({ reason: '   ' })).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_reason_not_blank',
    });
  });

  /* A movement filed under an employee, leave type or leave year that is not there
     is a movement no balance can be rebuilt from. Unlike audit_log, which
     deliberately has no foreign key on its actor, this table is the filing. */
  it('refuses an entry filed under a balance that does not exist', async () => {
    await expect(writeDirectly({ employee_id: 987654321 })).rejects.toMatchObject({
      code: '23503',
    });
    await expect(writeDirectly({ leave_type_id: 987654321 })).rejects.toMatchObject({
      code: '23503',
    });
    await expect(writeDirectly({ leave_year_id: 987654321 })).rejects.toMatchObject({
      code: '23503',
    });
  });
});

/**
 * FR 24 and §8.6d, inside one column.
 *
 * This is the condition on which ../unit/migrations.test.ts permits the only
 * fractional column in the schema. If it ever stops holding, that permission should
 * go with it.
 */
describe('whole days, and the one place a fraction belongs', () => {
  it.each(['RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'] as LedgerEntryType[])(
    '%s follows a request, so the column refuses half a day',
    async (entryType) => {
      await expect(
        writeDirectly({ entry_type: entryType, days: (signFor(entryType) * 5.5).toFixed(2) }),
      ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_requests_move_whole_days' });
    },
  );

  /* §8.6d: a joiner on 1 July is owed 20 × 184/365 = 10.08 days. */
  it('a pro rated grant keeps its hundredths', async () => {
    const written = await writeDirectly({ days: '10.08' });

    expect(written.days).toBe('10.08');
  });

  it('and what comes back out is a number rather than the text the driver sends', async () => {
    await adjust(asAdministrator(), anAdjustment(10.08));

    const [entry] = await ledger.history(asAdministrator(), people.officer);

    expect(entry.days).toBe(10.08);
    expect(typeof entry.days).toBe('number');
  });
});

/* ------------------------------------------- who wrote it, and when, and not */

describe('the writer and the time are stamped rather than supplied', () => {
  it('records the person the application named', async () => {
    const posted = await adjust(asAdministrator(), anAdjustment(3, 'Goodwill day'));

    expect(posted.createdByEmployeeId).toBe(people.headOfHr);
    expect(posted.createdBy).toContain(people.headOfHr);
  });

  /* A year rollover posts a GRANT for every employee and has no person behind it.
     "not named by the writer" is an answer where a null is a question. */
  it('records that nobody was named, when nobody was', async () => {
    const written = await writeDirectly();

    expect(written.created_by).toBe('not named by the writer');
    expect(written.created_by_employee_id).toBeNull();
  });

  /**
   * And a writer that names somebody else is overruled.
   *
   * The value of "who posted this" is that nobody could have chosen it. A DEFAULT
   * would only apply to a writer that said nothing, which is the honest writer.
   */
  it('overrules a writer that tries to post under another name', async () => {
    const written = await writeDirectly({
      created_by: 'somebody else entirely',
      created_by_employee_id: people.ceo,
    });

    expect(written.created_by).toBe('not named by the writer');
    expect(written.created_by_employee_id).toBeNull();
  });

  /**
   * And one that tries to date an entry into the past.
   *
   * A balance is rebuilt from these rows in the order they were written, so an
   * entry dated backwards rewrites a settled figure without changing any existing
   * row — the one door the immutability triggers do not cover.
   */
  it('overrules a writer that tries to date one', async () => {
    const written = await writeDirectly({ created_at: '2020-01-01T00:00:00Z' });

    expect(new Date(written.created_at as string).getFullYear()).toBe(new Date().getFullYear());
  });
});

/* ------------------------------------------------- nothing is ever changed */

describe('an entry cannot be changed or removed by anybody', () => {
  /* The application first, which is the writer an attacker reaches. It holds
     SELECT and INSERT and was never granted anything else. */
  it('the application holds no UPDATE or DELETE on the table', async () => {
    const { rows } = await admin.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'lms_app' AND table_name = 'leave_ledger_entry'
        ORDER BY privilege_type`,
    );

    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  /**
   * And the owner is refused too, which is the half that matters.
   *
   * An immutability the migration user can step around is a convention. FR 27 asks
   * for a property, and a trigger is what makes it one — loudly, with a SQLSTATE,
   * rather than the `DO INSTEAD NOTHING` rule §5.7 proposes: a silent success is
   * the worst possible answer to somebody rewriting a balance by hand.
   */
  it('the owner is refused an update, with a hint saying what to do instead', async () => {
    const written = await writeDirectly();

    await expect(
      admin.query('UPDATE leave_ledger_entry SET days = $1 WHERE id = $2', ['1.00', written.id]),
    ).rejects.toMatchObject({ code: '23001' });

    await expect(
      admin.query('UPDATE leave_ledger_entry SET reason = $1 WHERE id = $2', ['x', written.id]),
    ).rejects.toThrow(/never changed once written/);
  });

  it('the owner is refused a delete, likewise', async () => {
    const written = await writeDirectly();

    await expect(
      admin.query('DELETE FROM leave_ledger_entry WHERE id = $1', [written.id]),
    ).rejects.toThrow(/never deleted/);
  });

  /* The hint has to be the ledger's rather than the employee record's. Before this
     story `refuse_delete()` said "deactivate the record instead", which is the
     right sentence for an employee and nonsense for a movement in a balance. */
  it('and the hint tells them to post a compensating entry', async () => {
    const written = await writeDirectly();

    try {
      await admin.query('DELETE FROM leave_ledger_entry WHERE id = $1', [written.id]);
      throw new Error('That was accepted, and should not have been.');
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/compensating ADJUSTMENT/);
    }
  });

  /* The same repair applied to the audit log, which had been getting the employee
     record's hint since LMS 113 for the same reason. */
  it('as does the audit log, which shared the wrong one', async () => {
    const { rows } = await admin.query('SELECT id FROM audit_log LIMIT 1');

    try {
      await admin.query('DELETE FROM audit_log WHERE id = $1', [rows[0].id]);
      throw new Error('That was accepted, and should not have been.');
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/account of what happened/);
    }
  });

  /* There is no method to call. The repository offers `post` and reads, and the
     absence of the other two verbs is the file's shape rather than an omission. */
  it('and there is no verb in the repository that would try', () => {
    const verbs = Object.getOwnPropertyNames(LedgerRepository.prototype);

    expect(verbs).not.toContain('update');
    expect(verbs).not.toContain('remove');
    expect(verbs).not.toContain('delete');
    expect(verbs).toContain('post');
  });
});

/* ------------------------------------------------------------- corrections */

describe('a mistake is put right by a new entry', () => {
  it('posts the exact opposite, naming what it corrects', async () => {
    const wrong = await adjust(asAdministrator(), anAdjustment(20, 'Opening balance'));

    const putRight = await correct(
      asAdministrator(),
      wrong.id,
      'Opening balance was posted against the wrong leave type',
    );

    expect(putRight).toMatchObject({ entryType: 'ADJUSTMENT', days: -20, correctsId: wrong.id });
  });

  it('leaves the entry it corrects exactly as it was', async () => {
    const wrong = await adjust(asAdministrator(), anAdjustment(20, 'Opening balance'));

    await correct(asAdministrator(), wrong.id, 'posted twice');

    expect(await repository.findById(wrong.id)).toMatchObject({
      days: 20,
      reason: 'Opening balance',
    });
  });

  it('shows both, and in the order they were written', async () => {
    const wrong = await adjust(asAdministrator(), anAdjustment(20, 'Opening balance'));
    await correct(asAdministrator(), wrong.id, 'posted twice');

    const account = await ledger.history(asAdministrator(), people.officer);

    expect(account.map((entry) => entry.days)).toEqual([20, -20]);
    expect(account.map((entry) => entry.after)).toEqual([20, 0]);
  });

  it('answers "is this the figure that counts" from either end', async () => {
    const wrong = await adjust(asAdministrator(), anAdjustment(20));
    const putRight = await correct(asAdministrator(), wrong.id, 'posted twice');

    expect((await ledger.explain(asAdministrator(), wrong.id)).map((entry) => entry.id)).toEqual([
      wrong.id,
      putRight.id,
    ]);
  });

  /* Only an ADJUSTMENT may carry one, so that a correction is always findable as a
     correction rather than disguised as an ordinary grant. */
  it('is refused as any other kind of movement, by the column', async () => {
    const wrong = await writeDirectly();

    await expect(writeDirectly({ corrects_id: wrong.id })).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_only_an_adjustment_corrects',
    });
  });

  /**
   * And it stays inside one balance.
   *
   * A correction crossing an employee, a leave type or a leave year would be days
   * appearing in one balance because of a mistake in another. Both would be
   * internally consistent, both would be wrong, and the row that explains it says
   * "correction" in a way that makes it look explained.
   */
  it('is refused across two balances, by the trigger', async () => {
    const wrong = await writeDirectly();

    await expect(
      writeDirectly({
        employee_id: people.engineer,
        entry_type: 'ADJUSTMENT',
        days: '-20.00',
        corrects_id: wrong.id,
      }),
    ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_corrects_the_same_balance' });

    await expect(
      writeDirectly({
        leave_year_id: (await years.byLabel(system, '2027'))!.id,
        entry_type: 'ADJUSTMENT',
        days: '-20.00',
        corrects_id: wrong.id,
      }),
    ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_corrects_the_same_balance' });
  });

  it('and the repository reports that as a problem with the entry, not a driver fault', async () => {
    const wrong = await adjust(asAdministrator(), anAdjustment(20));

    await expect(
      repository.post(asAdministrator(), {
        employeeId: people.engineer,
        leaveTypeId: annualId,
        leaveYearId: y2026.id,
        entryType: 'ADJUSTMENT',
        days: -20,
        reason: 'wrong balance',
        correctsId: wrong.id,
        leaveRequestId: null,
      }),
    ).rejects.toBeInstanceOf(InvalidLedgerEntry);
  });

  it('refuses to correct an entry that is not there', async () => {
    await expect(correct(asAdministrator(), '987654321', 'x')).rejects.toBeInstanceOf(
      LedgerEntryNotFound,
    );
  });
});

/* ----------------------------------------------- a settled year, and §8.9 */

describe('a settled leave year takes no new figures, with one exception', () => {
  it('refuses every kind of movement but an adjustment', async () => {
    const y2025 = await aSettledYear();

    for (const entryType of LEDGER_ENTRY_TYPES) {
      if (entryType === 'ADJUSTMENT') continue;

      await expect(
        writeDirectly({
          leave_year_id: y2025.id,
          entry_type: entryType,
          days: signFor(entryType).toFixed(2),
        }),
        entryType,
      ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_leaves_settled_years_alone' });
    }
  });

  /**
   * And permits an adjustment, which is §8.9 and is the point.
   *
   * "If HR genuinely needs to change a closed year, that is a manual ADJUSTMENT
   * entry with a reason, not a rule edit." What a closed year refuses is being
   * *recalculated* — quietly, by a rule or a job, with nobody's name on it. A
   * deliberate, attributed, permanent correction is not that, and taking it away
   * would leave a psql prompt as the only way to fix a settled figure.
   *
   * This is the one rule here no other table in this schema has, and the one most
   * likely to be tidied away by somebody who has read the holiday rules.
   */
  it('permits an adjustment, because that is the only way to fix a settled figure', async () => {
    const y2025 = await aSettledYear();

    const posted = await adjust(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2025.id,
      days: -2,
      reason: 'Two days taken in 2025 were never recorded; agreed with the employee.',
    });

    expect(posted).toMatchObject({ entryType: 'ADJUSTMENT', days: -2 });
  });

  it('and a correction of an entry in one, which is the same thing', async () => {
    const y2025 = await aSettledYear();

    const wrong = await adjust(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2025.id,
      days: -2,
      reason: 'posted in error',
    });

    await expect(
      correct(asAdministrator(), wrong.id, 'that absence was 2026, not 2025'),
    ).resolves.toMatchObject({ days: 2 });
  });

  it('reports the refusal against the leave year, naming when it was closed', async () => {
    const y2025 = await aSettledYear();

    await expect(
      repository.post(asAdministrator(), {
        employeeId: people.officer,
        leaveTypeId: annualId,
        leaveYearId: y2025.id,
        entryType: 'GRANT',
        days: 20,
        reason: 'late grant',
        correctsId: null,
        leaveRequestId: null,
      }),
    ).rejects.toMatchObject({ name: 'InvalidLedgerEntry', field: 'leaveYearId' });
  });
});

/* --------------------------------------------------------- who may see it */

describe('who may read a balance, FR 53, FR 55, FR 56', () => {
  beforeEach(async () => {
    await adjust(asAdministrator(), anAdjustment(20, 'Opening balance at go live'));
  });

  it('the person themselves', async () => {
    expect((await ledger.history(asThemselves(), people.officer)).length).toBe(1);
  });

  it('their line manager', async () => {
    expect((await ledger.history(asTheirManager(), people.officer)).length).toBe(1);
  });

  it('and HR', async () => {
    expect((await ledger.history(asOfficer(), people.officer)).length).toBe(1);
  });

  /* Refused silently rather than openly, the default of ../src/auth/policy.ts:
     "you may not read employee 4471's leave" tells somebody that 4471 is
     somebody. */
  it('and nobody else', async () => {
    await expect(ledger.history(asAColleague(), people.officer)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  /* FR 55, direct reports only. The team lead manages the officer; the operations
     director is two levels up and sees nothing here. */
  it('not a manager two levels up, which is FR 55 rather than an oversight', async () => {
    const skipLevel = signedInAs(people.opsDirector, { roles: ['EMPLOYEE'], isManager: true });

    await expect(ledger.history(skipLevel, people.officer)).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('and explaining one entry obeys the same rule', async () => {
    const [entry] = await ledger.history(asAdministrator(), people.officer);

    await expect(ledger.explain(asAColleague(), entry.id)).rejects.toBeInstanceOf(NotAuthorised);
    await expect(ledger.explain(asThemselves(), entry.id)).resolves.toHaveLength(1);
  });
});

describe('who may move a balance by hand, FR 37', () => {
  it('an HR Administrator, and that is the whole list', async () => {
    await expect(adjust(asAdministrator(), anAdjustment(3))).resolves.toMatchObject({
      days: 3,
    });
  });

  /* Narrower than every other write in this system, and §10 says so: an adjustment
     moves days by fiat, with no request and no rule behind it, and can never be
     removed — only compensated. */
  it('and not an HR Officer, who may do almost everything else', async () => {
    await expect(adjust(asOfficer(), anAdjustment(3))).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('nor a manager, nor the person themselves', async () => {
    await expect(adjust(asTheirManager(), anAdjustment(3))).rejects.toBeInstanceOf(NotAuthorised);
    await expect(adjust(asThemselves(), anAdjustment(3))).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('and correcting an entry is decided by exactly the same rule', async () => {
    const wrong = await adjust(asAdministrator(), anAdjustment(20));

    await expect(correct(asOfficer(), wrong.id, 'x')).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('refuses an adjustment against somebody who does not exist', async () => {
    await expect(
      adjust(asAdministrator(), { ...anAdjustment(3), employeeId: '987654321' }),
    ).rejects.toBeInstanceOf(EmployeeNotFound);
  });

  it('refuses one with no reason, before it reaches the database', async () => {
    await expect(adjust(asAdministrator(), anAdjustment(3, '  '))).rejects.toBeInstanceOf(
      InvalidLedgerEntry,
    );
  });
});

/* -------------------------------------------------------------- the reading */

describe('reading one balance', () => {
  it('is oldest first, with the figure each movement left behind it', async () => {
    const first = await adjust(asAdministrator(), anAdjustment(20, 'Opening balance'));
    const second = await adjust(asAdministrator(), anAdjustment(-5, 'Days taken in March'));

    const account = await ledger.history(asAdministrator(), people.officer);

    expect(account.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(account.map((entry) => entry.after)).toEqual([20, 15]);
  });

  /**
   * Two entries written in one transaction share a timestamp, and the order still
   * holds.
   *
   * A year rollover posts a CARRY_FORWARD and a GRANT together, so `now()` is
   * identical on both. An account that reorders itself between two reads is one
   * nobody can check twice, which is why the index and the query both break the tie
   * on the id.
   */
  it('holds its order for entries written in the same transaction', async () => {
    const posted = await repository.postAll(asAdministrator(), [
      {
        employeeId: people.officer,
        leaveTypeId: annualId,
        leaveYearId: y2026.id,
        entryType: 'CARRY_FORWARD',
        days: 3,
        reason: 'Carried from 2025',
        correctsId: null,
        leaveRequestId: null,
      },
      {
        employeeId: people.officer,
        leaveTypeId: annualId,
        leaveYearId: y2026.id,
        entryType: 'GRANT',
        days: 20,
        reason: 'Annual entitlement for 2026',
        correctsId: null,
        leaveRequestId: null,
      },
    ]);

    expect(posted[0].createdAt.getTime()).toBe(posted[1].createdAt.getTime());

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const account = await ledger.history(asAdministrator(), people.officer);
      expect(account.map((entry) => entry.id)).toEqual([posted[0].id, posted[1].id]);
    }
  });

  /* Written together or not at all. Half of a rollover landing is a balance that
     explains itself wrongly rather than not at all. */
  it('writes a batch as one transaction, so a bad entry takes the good one with it', async () => {
    const sound = {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      entryType: 'GRANT' as const,
      days: 20,
      reason: 'Annual entitlement',
      correctsId: null,
      leaveRequestId: null,
    };

    await expect(
      repository.postAll(asAdministrator(), [sound, { ...sound, employeeId: '987654321' }]),
    ).rejects.toBeInstanceOf(InvalidLedgerEntry);

    expect(await repository.entriesFor({ employeeId: people.officer })).toEqual([]);
  });

  it('narrows to one leave type, one year, or one kind of movement', async () => {
    await adjust(asAdministrator(), anAdjustment(20, 'Opening balance'));
    await writeDirectly({ entry_type: 'RESERVATION', days: '-5.00', reason: 'March request' });

    expect(
      (await ledger.history(asAdministrator(), people.officer, { leaveYearId: y2026.id })).length,
    ).toBe(2);
    expect(
      (
        await ledger.history(asAdministrator(), people.officer, {
          entryTypes: ['RESERVATION'],
        })
      ).map((entry) => entry.days),
    ).toEqual([-5]);
    expect(
      (
        await ledger.history(asAdministrator(), people.officer, {
          leaveYearId: (await years.byLabel(system, '2027'))!.id,
        })
      ).length,
    ).toBe(0);
  });

  it('is empty for a balance nothing has moved', async () => {
    expect(await ledger.history(asAdministrator(), people.engineer)).toEqual([]);
  });
});

/**
 * Which way a kind of movement goes, for a test that needs a valid amount.
 *
 * Deliberately a second copy of `ENTRY_SIGNS` rather than an import of it: a test
 * that asked the code under test which sign to use would agree with it however
 * wrong both were. This one agrees with §5.7.
 */
function signFor(entryType: LedgerEntryType): number {
  return ['RESERVATION', 'DEDUCTION', 'EXPIRY', 'LAPSE'].includes(entryType) ? -1 : 1;
}
