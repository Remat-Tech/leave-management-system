import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  DuplicateHoliday,
  type Holiday,
  HolidayInASettledYear,
  HolidayNotFound,
  InvalidHoliday,
} from '../../src/domain/holiday.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';
import { HolidayRepository } from '../../src/repositories/holiday-repository.js';
import { LeaveYearRepository } from '../../src/repositories/leave-year-repository.js';
import { HolidayService } from '../../src/services/holiday-service.js';
import { earliestOpenDayFrom, LeaveYearService } from '../../src/services/leave-year-service.js';
import { seed } from '../../seeds/seed.mjs';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';

/**
 * The public holiday calendar against a real database. FR 22, §5.4. LMS 206.
 *
 * The unit suite covers what a holiday is and how a stretch of days reads against
 * the calendar; ../unit/holiday.test.ts is where the pure half is proved. What
 * needs a database is the half the database decides, and for this story that is
 * three things:
 *
 *   Ghana's 2026 calendar is really on a migrated database. A production database
 *   is migrated and never seeded, so this is the only thing standing between an
 *   installation and a first December where everybody is charged for Christmas.
 *
 *   One holiday to a day holds against a writer that never went near the domain,
 *   and the refusal comes back as a leave-calendar problem rather than as a driver
 *   error.
 *
 *   **A settled leave year keeps its days.** Not by the service alone, but by a
 *   trigger, so it holds for the owner at a psql prompt too — which matters
 *   because a holiday is exactly the kind of row somebody fixes by hand at six in
 *   the evening. That is the tie back to LMS 205 and the assertion this file exists
 *   for.
 *
 * The three acceptance criteria — add, edit and remove, per year, mid year — are
 * exercised here rather than only in the unit suite, because each of them is a
 * privilege as much as a rule: `lms_app` holds DELETE on this table and on only
 * one other, and a story that could not remove a day would be one where the first
 * mistake is permanent.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('holiday integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let holidays: HolidayService;
let repository: HolidayRepository;
let yearRepository: LeaveYearRepository;
let years: LeaveYearService;
let people: Record<string, string>;

/**
 * The calendar as the migration left it, read once before anything has touched it.
 *
 * A snapshot rather than a list written out here, for the reason ./leave-type.ts
 * and ./leave-year.test.ts take one: these are reference data owned by a
 * migration, and restating them would mean the suite asserting its own copy — so
 * the first assertion below, that a migrated database really has them, would be
 * asserting nothing at all.
 */
let seeded: Record<string, unknown>[];
let seededYears: Record<string, unknown>[];

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  repository = new HolidayRepository(db);
  yearRepository = new LeaveYearRepository(db);
  years = new LeaveYearService(yearRepository, guard);
  holidays = new HolidayService(
    repository,
    guard,
    earliestOpenDayFrom(yearRepository),
    yearRepository,
  );

  seeded = (await admin.query('SELECT * FROM holiday ORDER BY holiday_date')).rows;
  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await restore('leave_year', seededYears);
  await restore('holiday', seeded);

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await restore('leave_year', seededYears);
  await restore('holiday', seeded);

  await db?.destroy();
  await admin?.end();
});

/**
 * A table as the migration left it, exactly.
 *
 * TRUNCATE rather than DELETE, and for the reason ./leave-year.test.ts gives:
 * half these tests close a leave year, and a closed year refuses to be deleted by
 * anybody — as does a holiday inside one. A row trigger does not fire on TRUNCATE,
 * and emptying a table on purpose on the owner connection is not the thing either
 * refusal exists to prevent.
 *
 * The leave years go back first and come out last, because a holiday inside a
 * closed one cannot be written while that year is still there.
 *
 * The ids come back with the rows because the audit log files its entries under
 * them.
 */
async function restore(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const columns = Object.keys(rows[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await admin.query(`TRUNCATE ${table}`);

  for (const row of rows) {
    await admin.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('${table}_id_seq', (SELECT max(id) FROM ${table}))`);
}

async function byName(name: string): Promise<Holiday> {
  const found = (await holidays.list(system)).find((holiday) => holiday.name === name);
  expect(found, `no holiday called ${name}`).toBeDefined();
  return found!;
}

async function yearLabelled(label: string): Promise<LeaveYear> {
  const found = await years.byLabel(system, label);
  expect(found, `no leave year called ${label}`).toBeDefined();
  return found!;
}

/**
 * 2025, closed, so that the settled-year rules have something to hold.
 *
 * Written on the owner connection because the service refuses to create a year
 * that overlaps 2026, and dated two years back so it stays finished however long
 * this suite lives. It has to abut the run of years the migration seeded, which is
 * why it is the whole of 2025.
 */
async function aSettledYear(): Promise<LeaveYear> {
  await admin.query(
    `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
  );

  const y2025 = await yearLabelled('2025');
  await years.close(asAdministrator(), y2025.id);

  return y2025;
}

function asOfficer() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: false });
}

describe("Ghana's 2026 calendar, which the story asks to be seeded", () => {
  /* A production database is migrated and never seeded. Reference data, like the
     seven leave types and the first two leave years, and for a reason of its own:
     a leave system that charges everybody a day for Christmas on its first
     December is one nobody trusts again. */
  it('is there on a database nothing has seeded', async () => {
    expect((await holidays.list(system)).length).toBe(14);
  });

  /* The nine fixed by the Public Holidays Act, on the days the Act names. These
     are the ones a calculation could have produced and are asserted anyway,
     because the Act is the source and this file is the transcription. */
  it('holds the days fixed by statute, on the days the statute fixes', async () => {
    const calendar = Object.fromEntries(
      (await holidays.list(system)).map((holiday) => [holiday.name, holiday.date]),
    );

    expect(calendar).toMatchObject({
      "New Year's Day": '2026-01-01',
      'Constitution Day': '2026-01-07',
      'Independence Day': '2026-03-06',
      'May Day': '2026-05-01',
      'African Union Day': '2026-05-25',
      "Founders' Day": '2026-08-04',
      'Kwame Nkrumah Memorial Day': '2026-09-21',
      'Christmas Day': '2026-12-25',
      'Boxing Day': '2026-12-26',
    });
  });

  /* And the five that move: Easter, Farmers' Day on the first Friday of December,
     and the two Eids. All within 2026, which is what makes them a transcription of
     one gazette rather than an extrapolation of several. */
  it('holds the movable days too, all of them inside the year it transcribes', async () => {
    const calendar = await holidays.list(system);

    for (const holiday of calendar) {
      expect(holiday.date.slice(0, 4), `${holiday.name} is not in 2026`).toBe('2026');
    }

    expect(await holidays.on(system, '2026-04-03')).toMatchObject({ name: 'Good Friday' });
    expect(await holidays.on(system, '2026-04-06')).toMatchObject({ name: 'Easter Monday' });
    expect(await holidays.on(system, '2026-12-04')).toMatchObject({ name: "Farmers' Day" });
  });

  /* One row per day, on the seeded data as well as on anything written later. A
     day carrying two rows would be subtracted twice by whatever counts it. */
  it('holds no day twice', async () => {
    const dates = (await holidays.list(system)).map((holiday) => holiday.date);

    expect(dates.length).toBe(new Set(dates).size);
  });

  /**
   * 2027 is empty, and the point of this test is that the emptiness is visible.
   *
   * Two of the fourteen are fixed by the Minister after the moon is sighted, so a
   * seeded 2027 would be twelve thirteenths right — believed silently, wrong
   * twice. What makes an empty year safe is that somebody is told about it before
   * December rather than after.
   */
  it('leaves the next leave year empty, and says so when asked', async () => {
    expect((await holidays.yearsAwaitingACalendar(system)).map((year) => year.label)).toEqual([
      '2027',
    ]);
  });
});

describe('reading the calendar', () => {
  it('finds the holiday on a day, and says nothing for a working day', async () => {
    expect(await holidays.on(system, '2026-03-06')).toMatchObject({ name: 'Independence Day' });
    expect(await holidays.on(system, '2026-03-07')).toBeUndefined();
  });

  /* Both bounds inclusive, because a leave request's last day is a day somebody is
     away — and the fortnight over Christmas is the case it matters on. */
  it('reads the days a request spans, inclusive at both ends', async () => {
    expect(
      (await holidays.list(system, { from: '2026-12-21', to: '2026-12-31' })).map((h) => h.name),
    ).toEqual(['Christmas Day', 'Boxing Day']);
  });

  /* Per year, which is the story's own word, and it is a range read over the
     year's own days rather than a column on the row. */
  it('reads a whole leave year, without the holiday knowing which year it is in', async () => {
    expect((await holidays.calendarFor(system, await yearLabelled('2026'))).length).toBe(14);
    expect(await holidays.calendarFor(system, await yearLabelled('2027'))).toEqual([]);
  });

  it('reports an id that is nobody rather than silently doing nothing', async () => {
    await expect(holidays.byId(system, '999999')).rejects.toBeInstanceOf(HolidayNotFound);
  });
});

describe('adding a day mid year, which the story asks for', () => {
  /* The case the story was written for. A day of national mourning, an election
     day, or the Monday the Minister declares because Boxing Day 2026 falls on a
     Saturday. None of them are known when the year starts, and none of them wait
     for a release. */
  it('adds a day the gazette declared after the year began', async () => {
    const added = await holidays.add(asOfficer(), {
      name: 'Day of national mourning',
      date: '2026-07-14',
    });

    expect(added).toMatchObject({ name: 'Day of national mourning', date: '2026-07-14' });
    expect(await holidays.on(system, '2026-07-14')).toMatchObject({ id: added.id });
  });

  /* And into a year nobody has transcribed yet, which is how 2027 gets filled in.
     The year stops being reported as awaiting a calendar the moment it has one. */
  it('adds a day to a year that had no calendar at all', async () => {
    await holidays.add(asOfficer(), { name: 'Christmas Day', date: '2027-12-25' });

    expect(await holidays.yearsAwaitingACalendar(system)).toEqual([]);
  });

  /* A day is closed once however many things fall on it. The gazette names the day
     for both, which is a name and not a second row. */
  it('refuses a second holiday on a day that already has one', async () => {
    await expect(
      holidays.add(asOfficer(), { name: 'Founders Day again', date: '2026-08-04' }),
    ).rejects.toBeInstanceOf(DuplicateHoliday);
  });

  it('refuses a date that is not written as one', async () => {
    await expect(
      holidays.add(asOfficer(), { name: 'Independence Day', date: '06/03/2027' }),
    ).rejects.toBeInstanceOf(InvalidHoliday);
  });
});

describe('moving a day, which is what the moon requires', () => {
  /* The reason "edit" is an acceptance criterion rather than a courtesy: Eid
     al-Fitr and Eid al-Adha are fixed by the Minister after the moon is sighted,
     and whatever the calendar was seeded with is a projection until then. */
  it('moves a projected feast to the day the gazette fixed', async () => {
    const eid = await byName('Eid al-Fitr');

    const moved = await holidays.correct(asOfficer(), eid.id, { date: '2026-03-21' });

    expect(moved.date).toBe('2026-03-21');
    expect(await holidays.on(system, '2026-03-20')).toBeUndefined();
    expect(await holidays.on(system, '2026-03-21')).toMatchObject({ name: 'Eid al-Fitr' });
  });

  it('renames a day without moving it', async () => {
    const eid = await byName('Eid al-Adha');

    const renamed = await holidays.correct(asOfficer(), eid.id, { name: 'Eid ul-Adha' });

    expect(renamed).toMatchObject({ name: 'Eid ul-Adha', date: eid.date });
  });

  it('refuses a move onto a day that already has a holiday', async () => {
    const boxingDay = await byName('Boxing Day');

    await expect(
      holidays.correct(asOfficer(), boxingDay.id, { date: '2026-12-25' }),
    ).rejects.toBeInstanceOf(DuplicateHoliday);
  });

  it('reports an id that is nobody rather than silently doing nothing', async () => {
    await expect(
      holidays.correct(asOfficer(), '999999', { name: 'Nothing' }),
    ).rejects.toBeInstanceOf(HolidayNotFound);
  });
});

describe('taking a day off the calendar, which is a real delete', () => {
  /* A projected day the gazette never confirmed. Nothing is filed under a holiday
     — a request stores the days it cost rather than which days those were — so the
     row can simply go, and a system that could only ever add days would be one
     where the first mistake is permanent. */
  it('removes a day, and the office is open on it again', async () => {
    const eid = await byName('Eid al-Fitr');

    await holidays.remove(asOfficer(), eid.id);

    expect(await holidays.on(system, eid.date)).toBeUndefined();
    expect((await holidays.list(system)).length).toBe(13);
  });

  it('reports an id that is nobody rather than silently doing nothing', async () => {
    await expect(holidays.remove(asOfficer(), '999999')).rejects.toBeInstanceOf(HolidayNotFound);
  });

  /* The privilege that makes it possible, and it is one of only two in the
     configuration half of the schema. leave_type and leave_year hold none, because
     those rows are headings a year of history is filed under. */
  it('is a privilege the application actually holds', async () => {
    const { rows } = await admin.query<{ del: boolean; upd: boolean; ins: boolean }>(
      `SELECT has_table_privilege('lms_app', 'holiday', 'DELETE') AS del,
              has_table_privilege('lms_app', 'holiday', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'holiday', 'INSERT') AS ins`,
    );

    expect(rows[0]).toEqual({ del: true, upd: true, ins: true });
  });
});

describe('a settled leave year keeps its days, LMS 205', () => {
  /**
   * The assertion this file exists for.
   *
   * Every request over a day in a closed year was counted against the calendar as
   * it stood, and a closed year is never recalculated. So all three verbs are
   * refused inside one, and the refusal names the earliest day that can still be
   * changed — which is the fact somebody at a form can act on.
   */
  it('refuses a day being added to one', async () => {
    await aSettledYear();

    await expect(
      holidays.add(asOfficer(), { name: 'Something in 2025', date: '2025-06-01' }),
    ).rejects.toBeInstanceOf(HolidayInASettledYear);
  });

  it('refuses a day being taken out of one', async () => {
    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('Christmas Day 2025', '2025-12-25')`,
    );
    await aSettledYear();

    const christmas2025 = await byName('Christmas Day 2025');

    await expect(holidays.remove(asOfficer(), christmas2025.id)).rejects.toBeInstanceOf(
      HolidayInASettledYear,
    );
  });

  /* Both ends of a move, and the first is the one a check on the new date alone
     would have let through — which is the more likely of the two, because dragging
     a stale day out of last year looks like tidying up. */
  it('refuses a day being moved out of one, not only into one', async () => {
    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('Christmas Day 2025', '2025-12-25')`,
    );
    await aSettledYear();

    const christmas2025 = await byName('Christmas Day 2025');

    await expect(
      holidays.correct(asOfficer(), christmas2025.id, { date: '2026-12-24' }),
    ).rejects.toBeInstanceOf(HolidayInASettledYear);
  });

  it('refuses a day being moved into one', async () => {
    await aSettledYear();

    const newYear = await byName("New Year's Day");

    await expect(
      holidays.correct(asOfficer(), newYear.id, { date: '2025-12-31' }),
    ).rejects.toBeInstanceOf(HolidayInASettledYear);
  });

  /* And leaves the open years entirely alone, which is most of the calendar most
     of the time. */
  it('lets the open years be maintained as freely as before', async () => {
    await aSettledYear();

    await expect(
      holidays.add(asOfficer(), { name: 'Day of national mourning', date: '2026-07-14' }),
    ).resolves.toMatchObject({ date: '2026-07-14' });
  });

  /* A day in no leave year at all is not settled. The database ships with 2026 and
     2027 and nothing after; a holiday in 2029 is somebody getting ahead. */
  it('allows a day in a year nobody has drawn around yet', async () => {
    await aSettledYear();

    await expect(
      holidays.add(asOfficer(), { name: 'Christmas Day', date: '2029-12-25' }),
    ).resolves.toMatchObject({ date: '2029-12-25' });
  });
});

describe('the rules are held by the database as well as by the domain', () => {
  /**
   * Written straight to the table on the owner connection, going round the domain
   * entirely — which is the point. The validation in ../../src/domain makes the
   * refusal name the earliest open day; these make the row impossible for every
   * writer, including a migration correcting data and somebody at a psql prompt at
   * six in the evening, which is exactly how a holiday actually gets fixed.
   */
  it('refuses two holidays on one day', async () => {
    await expect(
      admin.query(
        `INSERT INTO holiday (name, holiday_date) VALUES ('Independence Day again', '2026-03-06')`,
      ),
    ).rejects.toThrow(/holiday_one_per_day/);
  });

  it('refuses a holiday with no name', async () => {
    await expect(
      admin.query(`INSERT INTO holiday (name, holiday_date) VALUES ('   ', '2026-07-14')`),
    ).rejects.toThrow(/holiday_name_not_blank/);
  });

  it('refuses a day added to a settled year, on the owner connection too', async () => {
    await aSettledYear();

    await expect(
      admin.query(`INSERT INTO holiday (name, holiday_date) VALUES ('In 2025', '2025-06-01')`),
    ).rejects.toMatchObject({
      constraint: 'holiday_leaves_settled_years_alone',
      message: expect.stringContaining('2025'),
    });
  });

  it('refuses a day deleted from a settled year, on the owner connection too', async () => {
    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('Christmas Day 2025', '2025-12-25')`,
    );
    await aSettledYear();

    await expect(
      admin.query(`DELETE FROM holiday WHERE holiday_date = '2025-12-25'`),
    ).rejects.toThrow(/cannot be deleted|was closed on/);
  });

  /* And the repository reports a refusal as a calendar problem rather than letting
     a driver error surface. */
  it('reports a duplicate from outside the domain as a holiday problem', async () => {
    await expect(
      repository.create(system, { name: 'Independence Day again', date: '2026-03-06' }),
    ).rejects.toBeInstanceOf(DuplicateHoliday);
  });

  it('reports a settled year from outside the domain against the date', async () => {
    await aSettledYear();

    await expect(
      repository.create(system, { name: 'In 2025', date: '2025-06-01' }),
    ).rejects.toBeInstanceOf(InvalidHoliday);
  });
});

describe('who may keep the calendar, LMS 112', () => {
  /* The matrix belongs to ../unit/policy.test.ts; what is asserted here is that
     the service asks before it reads or writes anything — and that the answer is
     the one this table is different about. */
  it('is an HR Officer, which no other configuration table is', async () => {
    await expect(
      holidays.add(asOfficer(), { name: 'Day of national mourning', date: '2026-07-14' }),
    ).resolves.toMatchObject({ name: 'Day of national mourning' });
  });

  it('is refused to an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
    const christmas = await byName('Christmas Day');

    await expect(
      holidays.add(adwoa, { name: 'A day off', date: '2026-07-14' }),
    ).rejects.toBeInstanceOf(NotAuthorised);
    await expect(holidays.remove(adwoa, christmas.id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  /* And reading is open, because a public holiday is in the gazette and on the
     front page of every newspaper in Accra. */
  it('is readable by an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    expect((await holidays.list(adwoa)).length).toBe(14);
    expect(await holidays.on(adwoa, '2026-12-25')).toMatchObject({ name: 'Christmas Day' });
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
        WHERE entity = 'holiday' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [id],
    );

    return rows;
  }

  /* A holiday added in March changes what a request approved in February cost —
     FR 25's recalculation — and "who added the twenty eighth of December, and
     when" is the question a disputed recalculation turns on. */
  it('names the officer who added a day, and the day they added', async () => {
    const added = await holidays.add(asOfficer(), {
      name: 'Day of national mourning',
      date: '2026-07-14',
    });

    const [entry] = await entriesFor(added.id);

    expect(entry.action).toBe('CREATE');
    expect(entry.actor).toContain(people.headOfHr);
    expect(entry.after?.holiday_date).toBe('2026-07-14');
  });

  /* And a removal, which is the one that matters most: after it the row is gone,
     and the log is the only record that the day was ever on the calendar. */
  it('keeps the whole of a day that was taken off the calendar', async () => {
    const eid = await byName('Eid al-Fitr');

    await holidays.remove(asOfficer(), eid.id);

    const last = (await entriesFor(eid.id)).at(-1);

    expect(last?.action).toBe('DELETE');
    expect(last?.before?.name).toBe('Eid al-Fitr');
    expect(last?.before?.holiday_date).toBe('2026-03-20');
    expect(last?.after).toBeNull();
  });

  it('writes nothing for a change that changed nothing', async () => {
    const christmas = await byName('Christmas Day');
    const before = (await entriesFor(christmas.id)).length;

    await holidays.correct(asOfficer(), christmas.id, { name: christmas.name });

    expect((await entriesFor(christmas.id)).length).toBe(before);
  });
});

describe('putting the gazette back, and refusing to rewrite it', () => {
  async function ensureTheGazettedHolidays(): Promise<number> {
    const { rows } = await admin.query<{ inserted: number }>(
      'SELECT ensure_the_gazetted_holidays() AS inserted',
    );

    return rows[0].inserted;
  }

  /* The state every already migrated database is in. Doing nothing has to be
     genuinely nothing: not a no-op insert, not an audit entry. */
  it('does nothing at all where the whole calendar is already there', async () => {
    const before = await admin.query('SELECT * FROM holiday ORDER BY holiday_date');

    expect(await ensureTheGazettedHolidays()).toBe(0);

    expect((await admin.query('SELECT * FROM holiday ORDER BY holiday_date')).rows).toEqual(
      before.rows,
    );
  });

  it('puts back a day that has gone missing', async () => {
    await admin.query(`DELETE FROM holiday WHERE holiday_date = '2026-12-25'`);

    expect(await ensureTheGazettedHolidays()).toBe(1);
    expect(await holidays.on(system, '2026-12-25')).toMatchObject({ name: 'Christmas Day' });
  });

  /**
   * The case the double guard exists for, and it is not hypothetical.
   *
   * HR moves Eid al-Fitr to the twenty first because the gazette said so; the
   * database is later restored from a backup taken before that. A guard reading
   * only the date would put the twentieth back beside it — two rows for one feast,
   * on a table whose whole rule is one row per day.
   */
  it('leaves a feast somebody has already moved alone', async () => {
    const eid = await byName('Eid al-Fitr');
    await holidays.correct(asOfficer(), eid.id, { date: '2026-03-21' });

    expect(await ensureTheGazettedHolidays()).toBe(0);
    expect(await holidays.on(system, '2026-03-20')).toBeUndefined();
    expect(await holidays.on(system, '2026-03-21')).toMatchObject({ name: 'Eid al-Fitr' });
  });

  /* And the name guard is scoped to its own year, so entering 2027's Christmas
     does not stop 2026's being put back. */
  it('puts 2026 back on a database where somebody has entered 2027', async () => {
    await holidays.add(asOfficer(), { name: 'Christmas Day', date: '2027-12-25' });
    await admin.query(`DELETE FROM holiday WHERE holiday_date = '2026-12-25'`);

    expect(await ensureTheGazettedHolidays()).toBe(1);
    expect(await holidays.on(system, '2026-12-25')).toMatchObject({ name: 'Christmas Day' });
  });

  it('names itself in the audit log as the writer of a day it put back', async () => {
    await admin.query(`DELETE FROM holiday WHERE holiday_date = '2026-12-25'`);
    await ensureTheGazettedHolidays();

    const { rows } = await admin.query<{ actor: string }>(
      `SELECT actor FROM audit_log
        WHERE entity = 'holiday' AND action = 'CREATE'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );

    expect(rows[0].actor).toBe('ensure_the_gazetted_holidays()');
  });

  /* Restoring reference data is an operator's job, done knowingly. */
  it('belongs to the owner rather than to the application', async () => {
    const { rows } = await admin.query<{ may: boolean }>(
      `SELECT has_function_privilege('lms_app', 'ensure_the_gazetted_holidays()', 'EXECUTE') AS may`,
    );

    expect(rows[0].may).toBe(false);
  });
});
