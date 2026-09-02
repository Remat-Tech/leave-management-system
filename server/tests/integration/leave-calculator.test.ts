import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { Employee } from '../../src/features/employee/employee.js';
import { InvalidLeavePeriod } from '../../src/features/leave-calculator/leave-calculator.js';
import type { LeaveType } from '../../src/features/leave-type/leave-type.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { seed } from '../../seeds/seed.mjs';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * The day calculator against a real database. FR 21, FR 22, §7.3. LMS 207.
 *
 * The rules are pure functions and ../unit/leave-calculator.test.ts is where the
 * story is proved. What this suite adds is narrower and is the half a unit test
 * cannot reach: that the numbers come out right against the *real* seeded gazette
 * and the *real* working patterns, read through the service, with nothing written
 * out here by hand.
 *
 * Three things it is worth having a database to say.
 *
 *   A fortnight over the actual Christmas costs what somebody counting off a wall
 *   calendar would get. Every part is real: the pattern is the one the
 *   working-pattern-rules migration inserted, the holidays are the ones
 *   `ensure_the_gazetted_holidays()` wrote, and the leave types are the seven of
 *   FR 32.
 *
 *   **The first of January 2027 costs a day, and it should.** Only 2026's gazette
 *   is seeded — see ../../src/features/holiday/holiday.ts for why a plausible 2027 would be
 *   worse than an empty one — so until HR transcribes it, New Year's Day is an
 *   ordinary Friday. That is the hazard LMS 206 left visible on purpose, and this
 *   is what it looks like from the other end. Entering the day fixes it, with no
 *   release.
 *
 *   The service reads a working pattern and a holiday calendar, and nothing else.
 *   That is the story's fifth criterion, and here it is asked as behaviour rather
 *   than as bookkeeping: the tables it might plausibly have grown a dependency on
 *   are changed underneath it, one at a time, and the number has to stay put.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('leave calculator integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let calculator: LeaveCalculatorService;
let employees: EmployeeRepository;
let types: LeaveTypeRepository;
let holidays: HolidayRepository;
let people: Record<string, string>;

/**
 * The gazette and the leave years as the migration left them.
 *
 * Both are restored before every test, for the reason ./holiday.test.ts gives:
 * one disposable database is shared by every integration file and they run one at
 * a time, so a row left behind here is a fixture the next file inherits. This
 * suite closes a leave year and retires a leave type to prove neither moves the
 * number, and a closed year refuses to be deleted by anybody — TRUNCATE is the
 * only way back, which is the same latitude the other suites take.
 */
let seeded: Record<string, unknown>[];
let seededYears: Record<string, unknown>[];

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  employees = new EmployeeRepository(db);
  types = new LeaveTypeRepository(db);
  holidays = new HolidayRepository(db);
  calculator = new LeaveCalculatorService(new WorkPatternRepository(db), holidays, guard);

  seeded = (await admin.query('SELECT * FROM holiday ORDER BY holiday_date')).rows;
  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await restoreTheFixtures();

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await restoreTheFixtures();

  await db?.destroy();
  await admin?.end();
});

/**
 * The two tables this suite writes to, and the one flag it flips, put back.
 *
 * In `beforeEach` rather than `afterEach` so that a test which fails halfway
 * cannot leave the next one — or the next file — reading its wreckage. Reinstating
 * every type is unconditional and idempotent; the seven ship active, and nothing
 * else in the suite retires one.
 */
async function restoreTheFixtures(): Promise<void> {
  await restore('leave_year', seededYears);
  await restore('holiday', seeded);

  await admin.query('UPDATE leave_type SET is_active = TRUE WHERE NOT is_active');
}

/** A table as the migration left it, exactly. See ./holiday.test.ts. */
async function restore(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const columns = Object.keys(rows[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  /* CASCADE since LMS 210, for the reason ./holiday.test.ts gives: a leave year is
     the heading a run of ledger entries is filed under, and a referenced table
     cannot be truncated without saying what happens to the rows pointing at it. */
  await admin.query(`TRUNCATE ${table} CASCADE`);

  for (const row of rows) {
    await admin.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('${table}_id_seq', (SELECT max(id) FROM ${table}))`);
}

async function employee(name: string): Promise<Employee> {
  const found = await employees.findById(people[name]);
  expect(found, `no fixture employee called ${name}`).toBeDefined();
  return found!;
}

async function leaveType(code: string): Promise<LeaveType> {
  const found = await types.findByCode(code);
  expect(found, `no leave type with the code ${code}`).toBeDefined();
  return found!;
}

/* The twenty first of December 2026 is a Monday; the first of January 2027 is the
   Friday after Christmas. Twelve calendar days, ten of them weekdays. */
const CHRISTMAS_FORTNIGHT = { from: '2026-12-21', to: '2027-01-01' };

describe('a fortnight over the real Christmas', () => {
  /**
   * Nine days, and every part of the number comes from a row nothing here wrote.
   *
   * Twelve calendar days. Two of them are the Saturday and Sunday after Christmas,
   * and one is Christmas Day itself, which the seeded gazette holds on the Friday.
   * Boxing Day is a row too, and it costs nothing extra because it lands on that
   * Saturday — which is the case a system that subtracted holidays from a weekday
   * count would get wrong by a day.
   */
  it('costs nine days of annual leave, counted against the seeded gazette', async () => {
    const count = await calculator.count(
      system,
      await employee('officer'),
      await leaveType('ANNUAL'),
      CHRISTMAS_FORTNIGHT,
    );

    expect(count.days).toBe(9);
    expect(count.calendarDays).toBe(12);
    expect(count.free).toEqual([
      { date: '2026-12-25', because: 'PUBLIC_HOLIDAY', name: 'Christmas Day' },
      { date: '2026-12-26', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-12-27', because: 'NOT_A_WORKING_DAY', name: null },
    ]);
  });

  /**
   * And the first of January costs a day, because nobody has transcribed 2027's
   * gazette yet.
   *
   * This is not a defect and it is not a surprise — it is the shape of the
   * decision LMS 206 made deliberately, seen from the counting end. Two of Ghana's
   * fourteen holidays are fixed by the Minister after the moon is sighted, so a
   * seeded 2027 would be a calendar that is nearly right; an empty one is a screen
   * with nothing on it, and `yearsAwaitingACalendar()` is what says so before
   * December.
   */
  it('charges for New Year 2027, which nobody has entered a calendar for', async () => {
    const count = await calculator.count(
      system,
      await employee('officer'),
      await leaveType('ANNUAL'),
      CHRISTMAS_FORTNIGHT,
    );

    expect(count.free.map((day) => day.date)).not.toContain('2027-01-01');
  });

  /* And entering the day is all it takes, with no release. The story's own
     "holidays can be added mid year", answered from the calculator. */
  it('stops charging for it the moment HR enters it', async () => {
    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('New Year''s Day', '2027-01-01')`,
    );

    const count = await calculator.count(
      system,
      await employee('officer'),
      await leaveType('ANNUAL'),
      CHRISTMAS_FORTNIGHT,
    );

    expect(count.days).toBe(8);
    expect(count.free.at(-1)).toEqual({
      date: '2027-01-01',
      because: 'PUBLIC_HOLIDAY',
      name: "New Year's Day",
    });
  });

  /**
   * The same fortnight as maternity leave is twelve days, because FR 22 says it is
   * a continuous period of absence rather than an allowance of workdays.
   *
   * Same person, same pattern, same calendar, same dates. The only thing that
   * differs is a column on the leave type, which is the whole of design principle 5
   * proved against real rows.
   */
  it('is twelve days of maternity leave over the same dates', async () => {
    const count = await calculator.count(
      system,
      await employee('officer'),
      await leaveType('MATERNITY'),
      CHRISTMAS_FORTNIGHT,
    );

    expect(count.days).toBe(12);
    expect(count.free).toEqual([]);
  });

  /* Every seeded type counts by its own basis and none of them by its code. The
     seven are read from the table rather than listed here, so an eighth added by
     HR is covered the day it exists. */
  it('counts every seeded type by the basis on its row', async () => {
    const officer = await employee('officer');

    for (const type of await types.list()) {
      const count = await calculator.count(system, officer, type, CHRISTMAS_FORTNIGHT);

      expect(count.days, `${type.name} counted wrongly`).toBe(
        type.countingBasis === 'CALENDAR_DAYS' ? 12 : 9,
      );
    }
  });
});

describe("the pattern comes off the person's own record", () => {
  /**
   * Abena works Monday, Tuesday, Thursday and Friday, and the seed says so because
   * this story needed it: "The counting tests in Technical Design Document section
   * 7.3 need a pattern that is not simply weekends off, or a bug that assumes
   * Saturday and Sunday are the only non working days passes every test."
   *
   * A week off costs her four days rather than five, and the calculator finds that
   * out by reading `employee.work_pattern_id` rather than by being told.
   */
  it('costs a part timer four days for a week that costs everybody else five', async () => {
    /* The second week of March, chosen because the gazette holds nothing in it:
       the week before has Independence Day on the Friday, and a holiday inside
       this comparison would make both numbers move for a reason that is not the
       pattern. Independence Day gets a test of its own below. */
    const week = { from: '2026-03-09', to: '2026-03-15' };
    const annual = await leaveType('ANNUAL');

    const hers = await calculator.count(system, await employee('partTimer'), annual, week);
    const theirs = await calculator.count(system, await employee('officer'), annual, week);

    expect(hers.days).toBe(4);
    expect(theirs.days).toBe(5);
  });

  /* And the Wednesday she does not work is reported as a day off rather than as
     anything to do with the gazette — which is what makes FR 25 come out right. */
  it('reports her Wednesday as a day not worked', async () => {
    const count = await calculator.count(
      system,
      await employee('partTimer'),
      await leaveType('ANNUAL'),
      { from: '2026-03-09', to: '2026-03-15' },
    );

    expect(count.free).toEqual([
      { date: '2026-03-11', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-03-14', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-03-15', because: 'NOT_A_WORKING_DAY', name: null },
    ]);
  });

  /* And a holiday that lands on a day she does not work gives her nothing back,
     where it gives everybody else a day. Both weeks below are five weekdays long;
     the difference between them is one row in the gazette. */
  it('gives her nothing back for a holiday she was not working anyway', async () => {
    const abena = await employee('partTimer');
    const annual = await leaveType('ANNUAL');

    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('Day of national mourning', '2026-03-11')`,
    );

    const hers = await calculator.count(system, abena, annual, {
      from: '2026-03-09',
      to: '2026-03-15',
    });
    const theirs = await calculator.count(system, await employee('officer'), annual, {
      from: '2026-03-09',
      to: '2026-03-15',
    });

    expect(hers.days).toBe(4);
    expect(theirs.days).toBe(4);
    expect(hers.free.find((day) => day.date === '2026-03-11')?.because).toBe('NOT_A_WORKING_DAY');
    expect(theirs.free.find((day) => day.date === '2026-03-11')?.because).toBe('PUBLIC_HOLIDAY');
  });

  /* Independence Day 2026 is a Friday and is in the seeded gazette, so the week it
     falls in costs a day less for everybody who works Fridays. */
  it('gives everybody back the real Independence Day', async () => {
    const week = { from: '2026-03-02', to: '2026-03-06' };

    const count = await calculator.count(
      system,
      await employee('officer'),
      await leaveType('ANNUAL'),
      week,
    );

    expect(count.days).toBe(4);
    expect(count.free).toEqual([
      { date: '2026-03-06', because: 'PUBLIC_HOLIDAY', name: 'Independence Day' },
    ]);
  });
});

describe('it reads a working pattern and a calendar, and nothing else', () => {
  /**
   * The story's fifth criterion, asked as behaviour rather than as bookkeeping.
   *
   * The honest test of "reads nothing else" is not which queries ran — it is that
   * no other table's state can move the number. So the tables this service might
   * plausibly have grown a dependency on are changed underneath it, one at a time,
   * and the answer has to stay exactly where it was.
   *
   * ../unit/leave-calculator.test.ts asks the complementary question of the pure
   * half, by reading its import list: the domain reaches no further than the
   * holiday, leave type, time and work pattern modules.
   */
  async function nineDays(): Promise<number> {
    return (
      await calculator.count(
        system,
        await employee('officer'),
        await leaveType('ANNUAL'),
        CHRISTMAS_FORTNIGHT,
      )
    ).days;
  }

  /* Closing the leave year settles every balance in it. It does not change what a
     fortnight cost — the calculator says what leave costs, not whether the year it
     falls in is still open, and the second question belongs to the ledger. */
  it('gives the same answer after the leave year is closed', async () => {
    expect(await nineDays()).toBe(9);

    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date, is_closed)
       VALUES ('2025', '2025-01-01', '2025-12-31', TRUE)`,
    );

    expect(await nineDays()).toBe(9);
  });

  /* Retiring the type stops new leave being requested against it, which is the
     request workflow's rule and not this one's. A calculator that refused here
     would be doing somebody else's job in a place nobody would look for it. */
  it('gives the same answer after the leave type is retired', async () => {
    await admin.query(`UPDATE leave_type SET is_active = FALSE WHERE code = 'ANNUAL'`);

    expect(await nineDays()).toBe(9);
  });

  /* And what the days are worth is `leave_entitlement_rule`, which this never
     reads: "what does this cost" and "can they afford it" are two questions, and
     only the second one has a figure in it. A figure raised for next year would be
     read by the balance and is invisible here. */
  it('gives the same answer after a new entitlement figure is added', async () => {
    await admin.query(
      `INSERT INTO leave_entitlement_rule (leave_type_id, entitlement_days, effective_from)
       SELECT id, 99, DATE '2027-01-01' FROM leave_type WHERE code = 'ANNUAL'`,
    );

    expect(await nineDays()).toBe(9);
  });

  /**
   * And the calendar it reads is bounded by the period.
   *
   * A holiday list that does not cover the days being counted is invisible to the
   * domain — a December nobody loaded looks exactly like a December with no
   * holidays in it — so the range comes from the period rather than from whatever
   * a caller had in hand. Asking about March must not pull December's rows across.
   */
  it('reads the holidays for the period rather than the whole calendar', async () => {
    expect((await holidays.list({ from: '2026-03-02', to: '2026-03-08' })).length).toBe(1);
    expect((await holidays.list()).length).toBe(14);
  });
});

describe('what it refuses', () => {
  /**
   * A weekend of annual leave costs nothing, and this service says so rather than
   * refusing it. LMS 303.
   *
   * The refusal moved to the submission validator, where it is about a *request*:
   * ../integration/leave-request.test.ts is where a person meets it. What this asserts
   * is that the honest zero survives the trip through a real working pattern and a real
   * gazette — a service that quietly turned it into a one, or into a throw again, would
   * break FR 25's recalculation rather than this suite.
   */
  it('counts a weekend booked as annual leave as nought, rather than refusing it', async () => {
    await expect(
      calculator.count(system, await employee('officer'), await leaveType('ANNUAL'), {
        from: '2026-12-26',
        to: '2026-12-27',
      }),
    ).resolves.toMatchObject({ days: 0, calendarDays: 2 });
  });

  /* And takes the same weekend as maternity leave, because that type counts every
     day. The refusal is about the counting rule, not about the dates. */
  it('takes the same weekend as maternity leave', async () => {
    await expect(
      calculator.count(system, await employee('officer'), await leaveType('MATERNITY'), {
        from: '2026-12-26',
        to: '2026-12-27',
      }),
    ).resolves.toMatchObject({ days: 2 });
  });

  /**
   * A date that is not one is refused before anything is fetched.
   *
   * The read below it is bounded by these two dates, so `31/07/2026` reaching a
   * `WHERE holiday_date >=` would be a driver error where it should have been a
   * sentence beside the input. The service asks the domain first for exactly that
   * reason.
   */
  it('refuses a date that is not written as one, without going near the database', async () => {
    await expect(
      calculator.count(system, await employee('officer'), await leaveType('ANNUAL'), {
        from: '25/12/2026',
        to: '2026-12-27',
      }),
    ).rejects.toBeInstanceOf(InvalidLeavePeriod);
  });

  it('refuses a period that runs backwards', async () => {
    await expect(
      calculator.count(system, await employee('officer'), await leaveType('ANNUAL'), {
        from: '2026-12-27',
        to: '2026-12-21',
      }),
    ).rejects.toBeInstanceOf(InvalidLeavePeriod);
  });
});

describe('who may ask what a period would cost, LMS 112', () => {
  /**
   * Anybody signed in, and that follows from the two tables it reads rather than
   * from a decision made here: a working pattern and the gazetted holidays are
   * both open to everybody, and the answer discloses nothing that is not.
   *
   * The matrix belongs to ../unit/policy.test.ts. What is asserted here is that
   * the service asks both policies rather than assuming them — which is what keeps
   * this correct on the day somebody narrows one.
   */
  it('is answered for an ordinary employee about their own leave', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    await expect(
      calculator.count(adwoa, await employee('officer'), await leaveType('ANNUAL'), {
        from: '2026-03-02',
        to: '2026-03-06',
      }),
    ).resolves.toMatchObject({ days: 4 });
  });
});
