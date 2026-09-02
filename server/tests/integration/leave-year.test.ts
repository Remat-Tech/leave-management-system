import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  InvalidLeaveYear,
  type LeaveYear,
  LeaveYearAlreadyClosed,
  LeaveYearLeavesAGap,
  LeaveYearNotFinished,
  LeaveYearNotFound,
  OverlappingLeaveYears,
} from '../../src/features/leave-year/leave-year.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import {
  earliestOpenDayFrom,
  LeaveYearService,
} from '../../src/features/leave-year/leave-year.service.js';
import { seed } from '../../seeds/seed.mjs';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';

/**
 * Leave years against a real database. §5.4. LMS 205.
 *
 * The unit suite covers what a year is and which day falls in which one;
 * ../unit/leave-year.test.ts is where the story is proved. What needs a database
 * is the half the database decides, and for this story that is most of the point:
 *
 *   2026 and 2027 are really on a migrated database. A production database is
 *   migrated and never seeded, so this is the only thing standing between an
 *   installation and a system where no balance can be opened at all.
 *
 *   The two rules that keep a day in exactly one year hold against a writer that
 *   never went near the domain — an exclusion constraint and a deferred trigger,
 *   refusing an overlap and a gap on the owner connection.
 *
 *   **A closed year cannot be reopened by anybody.** Not by the service, which
 *   has no method, not by `lms_app`, and not by the owner at a psql prompt. That
 *   is the whole of what "locked" means and it is the assertion this file exists
 *   for.
 *
 *   Closing one moves the boundary the entitlement rules of LMS 203 are judged
 *   against, which is the seam that story left and the thing this one had to
 *   join. ../integration/entitlement-rule.test.ts asks it from the other side.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('leave year integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let years: LeaveYearService;
let repository: LeaveYearRepository;
let people: Record<string, string>;

/**
 * The table as the migration left it, read once before anything has touched it.
 *
 * A snapshot rather than a list written out here, for the reason
 * ./leave-type.test.ts takes one: these are reference data owned by a migration,
 * and restating them would mean the suite asserting its own copy — so the first
 * assertion below, that a migrated database really has them, would be asserting
 * nothing at all.
 */
let seeded: Record<string, unknown>[];

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  repository = new LeaveYearRepository(db);
  years = new LeaveYearService(repository, guard);

  seeded = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await restoreTheSeededYears();

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await restoreTheSeededYears();

  await db?.destroy();
  await admin?.end();
});

/**
 * The table as the migration left it, exactly.
 *
 * TRUNCATE rather than DELETE, and that is not a convenience: a closed year
 * refuses to be deleted by anybody, which is FR-grade behaviour working as
 * designed, and half these tests close one. A row trigger does not fire on
 * TRUNCATE — emptying a table on purpose on the owner connection is not the thing
 * that refusal exists to prevent, which is the same latitude `employee` and
 * `audit_log` already take in the fixture seed.
 *
 * The ids come back with the rows because the audit log files its entries under
 * them.
 *
 * CASCADE since LMS 210. A leave year is now the heading a run of ledger entries is
 * filed under, and Postgres will not truncate a table something references without
 * being told what to do about the referencing rows. Emptying those alongside is
 * right rather than merely permitted: a ledger entry filed under a year that has
 * been replaced is a movement in a balance nobody can reconstruct.
 */
async function restoreTheSeededYears(): Promise<void> {
  const columns = Object.keys(seeded[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await admin.query('TRUNCATE leave_year CASCADE');

  for (const row of seeded) {
    await admin.query(
      `INSERT INTO leave_year (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('leave_year_id_seq', (SELECT max(id) FROM leave_year))`);
}

async function byLabel(label: string): Promise<LeaveYear> {
  const found = await years.byLabel(system, label);
  expect(found, `no leave year called ${label}`).toBeDefined();
  return found!;
}

/**
 * A year that has ended, so that closing it is a legal thing to do.
 *
 * Written on the owner connection because the service refuses to create one that
 * overlaps 2026, and dated two years back so it stays finished however long this
 * suite lives. The gap rule is why it is not simply "last year": it has to abut
 * the run of years the migration seeded, so it is every year from its start to the
 * end of 2025.
 */
async function aFinishedYear(): Promise<LeaveYear> {
  await admin.query(
    `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
  );

  return byLabel('2025');
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: false });
}

describe('2026 and 2027, which the story asks for', () => {
  /* A production database is migrated and never seeded. Reference data, like the
     seven leave types and the standard Monday to Friday week, and for the same
     reason: a leave system with no leave year is one where no balance can be
     opened at all. */
  it('are both there on a database nothing has seeded, in the order they run', async () => {
    expect((await years.list(system)).map((year) => year.label)).toEqual(['2026', '2027']);
  });

  it('cover whole calendar years, inclusive at both ends', async () => {
    expect(await byLabel('2026')).toMatchObject({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      isClosed: false,
      closedAt: null,
    });

    expect(await byLabel('2027')).toMatchObject({
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      isClosed: false,
    });
  });

  /* 2026 is the year the statutory entitlement figures take effect from — the
     entitlement-rule migration dated them to the first of January 2026 and called
     it "the first of the two LMS 205 seeds". The two files agree, and this is
     what stops them quietly disagreeing later. */
  it('start on the day the statutory entitlement figures take effect', async () => {
    const { rows } = await admin.query<{ effective_from: string }>(
      `SELECT DISTINCT effective_from FROM leave_entitlement_rule`,
    );

    expect(rows).toEqual([{ effective_from: (await byLabel('2026')).startDate }]);
  });

  it('run one straight after the other, with no day between them', async () => {
    const [first, second] = await years.list(system);

    expect(second.startDate > first.endDate).toBe(true);
    expect(await years.covering(system, first.endDate)).toMatchObject({ label: '2026' });
    expect(await years.covering(system, second.startDate)).toMatchObject({ label: '2027' });
  });

  /* Both open on a fresh database, which is what makes entering the current
     policy from the first of January possible at all. */
  it('are both open, so nothing is settled on a database that has just been built', async () => {
    for (const year of await years.list(system)) {
      expect(year.isClosed, `${year.label} arrived closed`).toBe(false);
    }

    expect(await earliestOpenDayFrom(repository)()).toBeNull();
  });
});

describe('which year a day is in', () => {
  it('finds the one year that covers it', async () => {
    expect(await years.covering(system, '2026-07-31')).toMatchObject({ label: '2026' });
    expect(await years.covering(system, '2027-12-31')).toMatchObject({ label: '2027' });
  });

  /* Undefined rather than an error, and it is the honest answer: this system
     holds no leave year before 2026 and none past whatever HR has defined. */
  it('answers nothing for a day nobody has drawn a year around', async () => {
    expect(await years.covering(system, '2025-12-31')).toBeUndefined();
    expect(await years.covering(system, '2028-01-01')).toBeUndefined();
  });
});

describe('defining a year, which never waits on a developer', () => {
  it('adds the next one, carrying straight on from the last', async () => {
    const created = await years.create(asAdministrator(), {
      label: '2028',
      startDate: '2028-01-01',
      endDate: '2028-12-31',
    });

    expect(created).toMatchObject({ label: '2028', isClosed: false, closedAt: null });
    expect((await years.list(system)).map((year) => year.label)).toEqual(['2026', '2027', '2028']);
  });

  it('refuses one that shares a day with a year already there', async () => {
    await expect(
      years.create(asAdministrator(), {
        label: '2027 again',
        startDate: '2027-06-01',
        endDate: '2028-05-31',
      }),
    ).rejects.toBeInstanceOf(OverlappingLeaveYears);
  });

  /* The quiet failure, refused loudly. Leave taken in the gap would draw on a
     balance nobody opened, and the rollover of FR 36 would have nothing to carry
     into. */
  it('refuses one that would leave days in no year at all', async () => {
    await expect(
      years.create(asAdministrator(), {
        label: '2030',
        startDate: '2030-01-01',
        endDate: '2030-12-31',
      }),
    ).rejects.toBeInstanceOf(LeaveYearLeavesAGap);
  });

  it('refuses a second year under one name', async () => {
    await expect(
      years.create(asAdministrator(), {
        label: '2026',
        startDate: '2028-01-01',
        endDate: '2028-12-31',
      }),
    ).rejects.toThrow(/already a leave year called/);
  });

  /* The label is a column rather than arithmetic on the start date, and this is
     the case it exists for: a company running April to March calls the year
     everybody says out loud '2028/29'. */
  it('takes a year that does not run January to December', async () => {
    await years.create(asAdministrator(), {
      label: '2028/29',
      startDate: '2028-01-01',
      endDate: '2029-03-31',
    });

    expect(await years.covering(system, '2029-02-14')).toMatchObject({ label: '2028/29' });
  });
});

describe('correcting one while it is still open', () => {
  it('moves its dates, and the day it covers moves with them', async () => {
    const y2027 = await byLabel('2027');

    await years.update(asAdministrator(), y2027.id, { endDate: '2028-03-31' });

    expect(await years.covering(system, '2028-02-14')).toMatchObject({ label: '2027' });
  });

  it('renames it without touching the days it covers', async () => {
    const y2026 = await byLabel('2026');

    const updated = await years.update(asAdministrator(), y2026.id, { label: 'Leave year 2026' });

    expect(updated).toMatchObject({
      label: 'Leave year 2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  /* A year always overlaps itself, so a correction judged against its own row
     would be refused every time. The service passes every year but this one. */
  it('does not refuse a year for overlapping itself', async () => {
    const y2027 = await byLabel('2027');

    await expect(
      years.update(asAdministrator(), y2027.id, { endDate: '2028-06-30' }),
    ).resolves.toMatchObject({ endDate: '2028-06-30' });
  });

  it('refuses a correction that would open a gap beside it', async () => {
    const y2027 = await byLabel('2027');

    await expect(
      years.update(asAdministrator(), y2027.id, { startDate: '2027-02-01' }),
    ).rejects.toBeInstanceOf(LeaveYearLeavesAGap);
  });

  it('reports an id that is nobody rather than silently doing nothing', async () => {
    await expect(
      years.update(asAdministrator(), '9999', { label: 'Nothing' }),
    ).rejects.toBeInstanceOf(LeaveYearNotFound);
  });
});

describe('closing a year, which is the story', () => {
  it('settles it, and stamps when', async () => {
    const y2025 = await aFinishedYear();

    const closed = await years.close(asAdministrator(), y2025.id);

    expect(closed.isClosed).toBe(true);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  /* The mistake that actually happens: it is the third of January, somebody is
     tidying up, and the year they reach for is the one that started two days
     ago. A year still running has requests in flight. */
  it('refuses a year that has not finished yet', async () => {
    const y2027 = await byLabel('2027');

    await expect(years.close(asAdministrator(), y2027.id)).rejects.toBeInstanceOf(
      LeaveYearNotFinished,
    );

    expect((await byLabel('2027')).isClosed).toBe(false);
  });

  it('refuses to close one twice, rather than quietly succeeding', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    await expect(years.close(asAdministrator(), y2025.id)).rejects.toBeInstanceOf(
      LeaveYearAlreadyClosed,
    );
  });

  it('refuses to move the days a closed year covered', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    await expect(
      years.update(asAdministrator(), y2025.id, { endDate: '2026-01-31' }),
    ).rejects.toBeInstanceOf(LeaveYearAlreadyClosed);
  });

  /* And lets it be called something better, which is the same exemption an
     entitlement rule in effect makes for its note: explaining a year better does
     not change what anybody was owed in it. */
  it('lets a closed year be renamed, which changes nothing about what it covered', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    await expect(
      years.update(asAdministrator(), y2025.id, { label: 'Leave year 2025' }),
    ).resolves.toMatchObject({ label: 'Leave year 2025', isClosed: true });
  });
});

describe('a closed year cannot be reopened by anybody', () => {
  /**
   * The assertion this file exists for.
   *
   * A lock the person holding it can undo is not a lock, so the test is not "the
   * service refuses" — it is that there is no way at all. The service has no
   * method, `lms_app` cannot write the flag back, and the owner connection is
   * refused by the trigger.
   */
  it('offers no service method that could', () => {
    const surface = [
      ...Object.getOwnPropertyNames(LeaveYearService.prototype),
      ...Object.getOwnPropertyNames(LeaveYearRepository.prototype),
    ];

    expect(surface.filter((name) => /reopen|unclose/i.test(name))).toEqual([]);
  });

  it('refuses the owner connection at a psql prompt', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    await expect(
      admin.query('UPDATE leave_year SET is_closed = FALSE WHERE id = $1', [y2025.id]),
    ).rejects.toThrow(/cannot be reopened/);
  });

  it('refuses the owner connection moving its dates', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    await expect(
      admin.query(`UPDATE leave_year SET end_date = '2026-06-30' WHERE id = $1`, [y2025.id]),
    ).rejects.toThrow(/cannot be changed/);
  });

  /* A leave year is the heading a year of balances and ledger entries is filed
     under, so deleting a closed one is the same rewrite by another route. */
  it('refuses the owner connection deleting it', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    await expect(admin.query('DELETE FROM leave_year WHERE id = $1', [y2025.id])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  /* And the application role has no DELETE at all, which is what keeps an *open*
     year from being removed out from under whatever already points at it. */
  it('gives the application role no way to delete a year of any kind', async () => {
    const { rows } = await admin.query<{ del: boolean; upd: boolean; ins: boolean }>(
      `SELECT has_table_privilege('lms_app', 'leave_year', 'DELETE') AS del,
              has_table_privilege('lms_app', 'leave_year', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'leave_year', 'INSERT') AS ins`,
    );

    expect(rows[0]).toEqual({ del: false, upd: true, ins: true });
  });
});

describe('the rules are held by the database as well as by the domain', () => {
  /**
   * Written straight to the table on the owner connection, going round the domain
   * entirely — which is the point. The validation in ../../src/domain makes the
   * refusal name the year it collided with; these make the row impossible for
   * every writer, including a migration correcting data and somebody at a psql
   * prompt at nine on a Friday.
   *
   * Both of these rules are deferred, so the refusal arrives when the statement's
   * own transaction commits rather than as it runs. That is what lets a boundary
   * between two years be moved in one transaction, and it is asserted below.
   */
  async function writeYear(label: string, start: string, end: string): Promise<void> {
    await admin.query(`INSERT INTO leave_year (label, start_date, end_date) VALUES ($1, $2, $3)`, [
      label,
      start,
      end,
    ]);
  }

  it('refuses two years that share a day', async () => {
    await expect(writeYear('overlapping', '2026-06-01', '2027-06-30')).rejects.toThrow(
      /leave_year_never_overlaps/,
    );
  });

  it('refuses a year that leaves days in no year at all', async () => {
    await expect(writeYear('2030', '2030-01-01', '2030-12-31')).rejects.toMatchObject({
      constraint: 'leave_year_leaves_no_gap',
      message: expect.stringContaining('in no leave year'),
    });
  });

  it('refuses a year that ends before it starts', async () => {
    await expect(writeYear('backwards', '2028-12-31', '2028-01-01')).rejects.toThrow(
      /leave_year_runs_forwards/,
    );
  });

  it('refuses a second year under one name, however it was cased', async () => {
    await expect(writeYear('2026', '2028-01-01', '2028-12-31')).rejects.toThrow(
      /leave_year_label_unique/,
    );
  });

  /* The flag and the stamp stand or fall together, and each half is held by a
     different thing. A closed year with no stamp is unreachable because the
     trigger writes one — asserted below — so what the CHECK is actually left
     guarding is the other direction: a closing date on a year nobody closed,
     which is a fact about an event that did not happen. */
  it('refuses a closing date on a year that is not closed', async () => {
    await expect(
      admin.query(`UPDATE leave_year SET closed_at = now() WHERE label = '2026'`),
    ).rejects.toThrow(/leave_year_closed_at_agrees/);
  });

  it('stamps the closing date itself, so a year cannot be closed without one', async () => {
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date, is_closed)
       VALUES ('2025', '2025-01-01', '2025-12-31', TRUE)`,
    );

    expect(await byLabel('2025')).toMatchObject({ isClosed: true });
    expect((await byLabel('2025')).closedAt).toBeInstanceOf(Date);
  });

  it('refuses closing a year that has not ended, on the owner connection too', async () => {
    await expect(
      admin.query(`UPDATE leave_year SET is_closed = TRUE WHERE label = '2027'`),
    ).rejects.toThrow(/has not finished yet/);
  });

  /* The intermediate state both deferred rules exist to permit: moving the
     boundary between two years is one statement that overlaps and one that puts
     it right, and at COMMIT only the state that will be stored is judged.
     Nothing in this story performs it — there is no service method — and the
     constraints are deferred so that the story which does is a service method
     rather than a migration. */
  it('permits a boundary between two years being moved in one transaction', async () => {
    await admin.query('BEGIN');
    await admin.query(`UPDATE leave_year SET end_date = '2027-03-31' WHERE label = '2026'`);
    await admin.query(`UPDATE leave_year SET start_date = '2027-04-01' WHERE label = '2027'`);
    await admin.query('COMMIT');

    expect(await years.covering(system, '2027-02-14')).toMatchObject({ label: '2026' });
    expect(await years.covering(system, '2027-04-01')).toMatchObject({ label: '2027' });
  });

  it('refuses the same move as two statements of their own', async () => {
    await expect(
      admin.query(`UPDATE leave_year SET end_date = '2027-03-31' WHERE label = '2026'`),
    ).rejects.toThrow(/leave_year_never_overlaps/);
  });

  /* And the repository reports a refusal as a leave year problem rather than
     letting a driver error surface. */
  it('reports a refusal from outside the domain against the field it is about', async () => {
    await expect(
      repository.create(system, {
        label: 'straight over 2026',
        startDate: '2026-03-01',
        endDate: '2026-09-30',
      }),
    ).rejects.toBeInstanceOf(InvalidLeaveYear);
  });
});

describe('the boundary a closed year sets, LMS 203', () => {
  /**
   * The seam LMS 203 left, joined.
   *
   * That story wrote `EarliestOpenDay` as a function taking no arguments and
   * passed it `NOTHING_IS_CLOSED_YET`, saying: "LMS 205 brings `leave_year` and
   * with it the real implementation — the day after the last closed year ends."
   * This is that implementation, reading the rows.
   */
  const boundary = () => earliestOpenDayFrom(repository)();

  it('is nothing at all while no year has been closed', async () => {
    expect(await boundary()).toBeNull();
  });

  it('is the day after the closed year ends', async () => {
    const y2025 = await aFinishedYear();
    await years.close(asAdministrator(), y2025.id);

    expect(await boundary()).toBe('2026-01-01');
  });

  /* Read fresh every time, which is the reason the type is a function rather
     than a date: the rollover of LMS 217 closes a year while the process is
     running, and a service holding a boundary read at start up would go on
     accepting figures into a year that had since been settled. */
  it('moves the moment a year is closed, without anything being rebuilt', async () => {
    const y2025 = await aFinishedYear();

    expect(await boundary()).toBeNull();

    await years.close(asAdministrator(), y2025.id);

    expect(await boundary()).toBe('2026-01-01');
  });
});

describe('who may close a year, LMS 112', () => {
  /* The matrix belongs to ../unit/policy.test.ts; what is asserted here is that
     the service asks before it reads or writes anything. */
  it('is refused to an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
    const y2025 = await aFinishedYear();

    await expect(years.close(adwoa, y2025.id)).rejects.toBeInstanceOf(NotAuthorised);
    await expect(
      years.create(adwoa, { label: '2028', startDate: '2028-01-01', endDate: '2028-12-31' }),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('is refused to an HR Officer, who may do almost everything else', async () => {
    const efua = signedInAs(people.hrOfficer ?? people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_OFFICER'],
      isManager: false,
    });
    const y2025 = await aFinishedYear();

    await expect(years.close(efua, y2025.id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  /* And reading is open, because when the year ends is what everybody plans
     around — FR 36, and the reason December is the month everybody books. */
  it('is readable by an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    expect((await years.list(adwoa)).map((year) => year.label)).toEqual(['2026', '2027']);
    expect(await years.covering(adwoa, '2026-07-31')).toMatchObject({ label: '2026' });
  });

  it('is closed by an HR Administrator', async () => {
    const y2025 = await aFinishedYear();

    await expect(years.close(asAdministrator(), y2025.id)).resolves.toMatchObject({
      isClosed: true,
    });
  });
});

describe('every change is in the audit log, NFR AUD 01', () => {
  async function entriesFor(id: string) {
    const { rows } = await admin.query<{
      action: string;
      actor: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      `SELECT action, actor, before, after
         FROM audit_log
        WHERE entity = 'leave_year' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [id],
    );

    return rows;
  }

  /* Closing a year is the largest single act an HR Administrator can perform in
     this system: after it, nothing about the year can move. `closed_at` says
     when and this says who, which is the pair a dispute about a settled balance
     is answered with. */
  it('names the administrator who closed a year, and what it was before', async () => {
    const y2025 = await aFinishedYear();

    await years.close(asAdministrator(), y2025.id);

    const last = (await entriesFor(y2025.id)).at(-1);

    expect(last?.action).toBe('UPDATE');
    expect(last?.actor).toContain(people.headOfHr);
    expect(last?.before?.is_closed).toBe(false);
    expect(last?.after?.is_closed).toBe(true);
    expect(last?.after?.closed_at).not.toBeNull();
  });

  it('writes nothing for a change that changed nothing', async () => {
    const y2026 = await byLabel('2026');
    const before = (await entriesFor(y2026.id)).length;

    await years.update(asAdministrator(), y2026.id, { label: y2026.label });

    expect((await entriesFor(y2026.id)).length).toBe(before);
  });
});

describe('putting the first years back, and refusing to rewrite them', () => {
  async function ensureTheFirstYears(): Promise<number> {
    const { rows } = await admin.query<{ inserted: number }>(
      'SELECT ensure_the_first_leave_years() AS inserted',
    );

    return rows[0].inserted;
  }

  /* The state every already migrated database is in. Doing nothing has to be
     genuinely nothing: not a no-op insert, not an audit entry. */
  it('does nothing at all where both years are already there', async () => {
    const before = await admin.query('SELECT * FROM leave_year ORDER BY start_date');

    expect(await ensureTheFirstYears()).toBe(0);

    expect((await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows).toEqual(
      before.rows,
    );
  });

  /* The case it exists for, and it is not hypothetical here: 2026 will be closed
     one day, and a database restored from a backup taken before that is one where
     the year itself is missing rather than merely its flag. */
  it('puts back a year that has gone missing', async () => {
    await admin.query(`DELETE FROM leave_year WHERE label = '2027'`);

    expect(await ensureTheFirstYears()).toBe(1);
    expect(await byLabel('2027')).toMatchObject({
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      isClosed: false,
    });
  });

  /* It inserts and it never rewrites. A company that has moved to an April start
     keeps theirs — the guard asks whether anything already covers those days or
     holds that name, not whether this exact row is there. */
  it('leaves a year somebody has already changed alone', async () => {
    const y2027 = await byLabel('2027');
    await years.update(asAdministrator(), y2027.id, { endDate: '2028-03-31' });

    expect(await ensureTheFirstYears()).toBe(0);
    expect((await byLabel('2027')).endDate).toBe('2028-03-31');
  });

  it('names itself in the audit log as the writer of a year it put back', async () => {
    await admin.query(`DELETE FROM leave_year WHERE label = '2027'`);
    await ensureTheFirstYears();

    const { rows } = await admin.query<{ actor: string }>(
      `SELECT actor FROM audit_log
        WHERE entity = 'leave_year' AND action = 'CREATE'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );

    expect(rows[0].actor).toBe('ensure_the_first_leave_years()');
  });

  /* Restoring reference data is an operator's job, done knowingly. */
  it('belongs to the owner rather than to the application', async () => {
    const { rows } = await admin.query<{ may: boolean }>(
      `SELECT has_function_privilege('lms_app', 'ensure_the_first_leave_years()', 'EXECUTE') AS may`,
    );

    expect(rows[0].may).toBe(false);
  });
});
