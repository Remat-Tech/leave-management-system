import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  DefaultWorkPatternRequired,
  DuplicateWorkPatternName,
  InvalidWorkPattern,
  MONDAY_TO_FRIDAY,
  STANDARD_PATTERN_NAME,
  WorkPatternInUse,
  WorkPatternNotFound,
} from '../../src/domain/work-pattern.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { WorkPatternService } from '../../src/services/work-pattern-service.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * Working patterns against a real database. FR 23, LMS 106.
 *
 * The unit suite covers the rules. What needs a database is everything the
 * database itself decides: that the standard Monday to Friday week is in every
 * migrated database rather than only in a seeded one, that a pattern always names
 * a whole week, that exactly one pattern is the default however many people are
 * writing at once, and that a pattern somebody works cannot be deleted.
 *
 * The two deferred triggers get particular attention. Both exist to permit a
 * legitimate intermediate state — a week with no days for the length of one
 * statement, a table with no default for the length of another — so both are
 * tested from the outside in a transaction, which is the only place the
 * difference between "deferred" and "not" is visible.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

const DOMAINS = ['rematholdings.com'];

/**
 * The actor these fixtures are built by, and the guard the services are given.
 *
 * {@link theSystem} rather than a person, because that is what this is: work
 * nobody asked for, setting up an organisation for the assertions below to be
 * about. It holds every role and is nobody, so no policy refuses it and no
 * "this is my own record" rule can accidentally match it.
 *
 * Whether the policies refuse the right people is not this suite's question. It
 * is server/tests/integration/authorisation.test.ts, and the rules themselves
 * are server/tests/unit/policy.test.ts.
 *
 * The guard writes refusals to stderr, which is the default. Nothing here should
 * provoke one, so a line appearing in the output is a failing test explaining
 * itself.
 */
const system = theSystem('working pattern integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let patterns: WorkPatternService;
let employees: EmployeeService;
let people: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  patterns = new WorkPatternService(new WorkPatternRepository(db), guard);
  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    { domains: DOMAINS },
  );
});

beforeEach(async () => {
  /* Whatever a test left as the default, put the standard week back before the
     seed runs. The seed deletes every pattern that is not the default, so a test
     that moved the default and failed half way through would otherwise have the
     next seed delete the standard week out from under the rest of the suite. */
  await restoreStandardDefault();

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

async function restoreStandardDefault(): Promise<void> {
  /* Two statements, because two defaults are refused immediately and none is
     permitted until COMMIT — the same order makeDefault() is forced into.
     Both in one query string rather than one round trip each: a multi statement
     query carries no parameters and runs in an implicit transaction, which is
     exactly what this needs and is a third of the network cost. This runs before
     every test in the file, and the database is usually a Neon branch at the end
     of a network. */
  await admin.query(
    `UPDATE work_pattern SET is_default = false WHERE is_default;
     UPDATE work_pattern SET is_default = true WHERE name = '${STANDARD_PATTERN_NAME}'`,
  );
}

/**
 * Runs statements in one transaction on the owner connection.
 *
 * A deferred trigger fires at COMMIT, so a test that wants to see one refuse
 * something has to get as far as committing. The rollback in the catch is what
 * keeps a refusal from leaving the connection in an aborted transaction and
 * failing every test after it.
 */
async function inTransaction(...statements: string[]): Promise<void> {
  await admin.query('BEGIN');
  try {
    for (const statement of statements) {
      await admin.query(statement);
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

/** The part timer's pattern, which the seed creates: Wednesdays off. */
async function partTime() {
  const found = await patterns.byName(system, 'Part time, Wednesdays off');
  expect(found).toBeDefined();
  return found!;
}

describe('the standard week every database has', () => {
  it('is there because the migration put it there, not because anything was seeded', async () => {
    /* The acceptance criterion, and the reason it is a migration rather than
       fixture data: a production database is migrated and never seeded, and
       employee.work_pattern_id is NOT NULL. Asserted through the service, which
       is how EmployeeService.create() finds it. */
    const standard = await patterns.standard(system);

    expect(standard.name).toBe(STANDARD_PATTERN_NAME);
    expect(standard.isDefault).toBe(true);
    // The same week the domain calls Monday to Friday. The migration writes it in
    // SQL and this is what keeps the two saying the same thing.
    expect(standard.workingDays).toEqual([...MONDAY_TO_FRIDAY]);
  });

  it('names all seven days, saying which two are not worked', async () => {
    const standard = await patterns.standard(system);

    const { rows } = await admin.query<{ day_of_week: number; is_working_day: boolean }>(
      'SELECT day_of_week, is_working_day FROM work_pattern_day WHERE work_pattern_id = $1 ORDER BY day_of_week',
      [standard.id],
    );

    // Saturday and Sunday are rows saying "not worked", not absent rows. That is
    // what keeps a day count out of the hands of whichever join was written.
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => !row.is_working_day).map((row) => row.day_of_week)).toEqual([6, 7]);
  });

  it('survives the seed being run again', async () => {
    // The seed no longer owns this row. It deletes the patterns it does own and
    // leaves the default alone, so reloading the fixtures cannot take reference
    // data with it.
    const before = await patterns.standard(system);

    await seed(admin);

    expect((await patterns.standard(system)).id).toBe(before.id);
  });
});

describe('creating a working pattern', () => {
  it('stores the name and the week, and reads both back', async () => {
    const created = await patterns.create(system, {
      name: 'Four days, Fridays off',
      workingDays: [1, 2, 3, 4],
    });

    const readBack = await patterns.byId(system, created.id);

    expect(readBack).toMatchObject({
      name: 'Four days, Fridays off',
      workingDays: [1, 2, 3, 4],
      isDefault: false,
    });
  });

  it('writes the whole week, not only the days that are worked', async () => {
    const created = await patterns.create(system, { name: 'Weekends only', workingDays: [6, 7] });

    const { rows } = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM work_pattern_day WHERE work_pattern_id = $1',
      [created.id],
    );

    expect(rows[0].count).toBe(7);
  });

  it('never makes a new pattern the default', async () => {
    // Making one the default unmakes another, which changes the week every
    // future joiner is given. It is said deliberately or not at all.
    const created = await patterns.create(system, { name: 'Nights', workingDays: [1, 2, 3, 4, 5] });

    expect(created.isDefault).toBe(false);
    expect((await patterns.standard(system)).name).toBe(STANDARD_PATTERN_NAME);
  });

  it('refuses a second pattern with the same name, whatever case it is in', async () => {
    await expect(
      patterns.create(system, { name: 'standard mon-fri', workingDays: [1, 2, 3, 4, 5] }),
    ).rejects.toBeInstanceOf(DuplicateWorkPatternName);
  });

  it('refuses a blank name before the write, and says which field', async () => {
    await expect(patterns.create(system, { name: '  ', workingDays: [1] })).rejects.toBeInstanceOf(
      InvalidWorkPattern,
    );
  });

  it('refuses the duplicate at the database, not merely in the code', async () => {
    // Straight past the service, as the seed or a data fixing migration would
    // go. The unique index is what makes this a fact rather than a convention.
    await expect(
      admin.query("INSERT INTO work_pattern (name) VALUES ('STANDARD MON-FRI')"),
    ).rejects.toThrow(/work_pattern_name_unique/);
  });

  it('leaves nothing behind when the week is refused', async () => {
    // The pattern row and its seven days are one write. A pattern row with no
    // days is not half a pattern, it is one that answers nothing.
    await expect(
      patterns.create(system, { name: 'Never', workingDays: [] }),
    ).rejects.toBeInstanceOf(InvalidWorkPattern);

    expect(await patterns.byName(system, 'Never')).toBeUndefined();
  });
});

describe('a pattern always names a whole week', () => {
  it('refuses a pattern with no days at all, at COMMIT', async () => {
    /* The database's half of the rule, reached the way a bulk import would reach
       it. The trigger is deferred, so the INSERT itself is accepted and the
       refusal arrives when the transaction tries to become permanent. */
    await expect(
      inTransaction("INSERT INTO work_pattern (name) VALUES ('Nothing but a name')"),
    ).rejects.toMatchObject({ code: '23514', constraint: 'work_pattern_week_complete' });

    expect(await patterns.byName(system, 'Nothing but a name')).toBeUndefined();
  });

  it('refuses a pattern that names only the days it works', async () => {
    await expect(
      inTransaction(
        `INSERT INTO work_pattern (name) VALUES ('Five rows only')`,
        `INSERT INTO work_pattern_day (work_pattern_id, day_of_week)
         SELECT id, d FROM work_pattern, generate_series(1, 5) AS d
          WHERE name = 'Five rows only'`,
      ),
    ).rejects.toThrow(/names 5 of the seven days/);
  });

  it('refuses a week with no working day in it, at the database too', async () => {
    await expect(
      inTransaction(
        `INSERT INTO work_pattern (name) VALUES ('Works never')`,
        `INSERT INTO work_pattern_day (work_pattern_id, day_of_week, is_working_day)
         SELECT id, d, false FROM work_pattern, generate_series(1, 7) AS d
          WHERE name = 'Works never'`,
      ),
    ).rejects.toThrow(/works none of the seven days/);
  });

  it('refuses a day being taken away from a pattern that exists', async () => {
    const standard = await patterns.standard(system);

    await expect(
      inTransaction(`DELETE FROM work_pattern_day WHERE work_pattern_id = ${standard.id}
                       AND day_of_week = 7`),
    ).rejects.toMatchObject({ constraint: 'work_pattern_week_complete' });
  });

  it('permits a week being replaced, which is what deferring it is for', async () => {
    /* The seven day rows are deleted and seven more written. Between those two
       statements the pattern names no days at all, which a per statement rule
       would refuse — and it is the ordinary way of changing a week. */
    const created = await patterns.create(system, { name: 'Half days', workingDays: [1, 2] });

    const changed = await patterns.update(system, created.id, { workingDays: [3, 4, 5] });

    expect(changed.workingDays).toEqual([3, 4, 5]);
    expect((await patterns.byId(system, created.id)).workingDays).toEqual([3, 4, 5]);
  });
});

describe('editing a working pattern', () => {
  it('renames one without moving the id anybody points at', async () => {
    const before = await partTime();

    const renamed = await patterns.update(system, before.id, { name: 'Part time, midweek off' });

    expect(renamed.name).toBe('Part time, midweek off');
    // The point of editing rather than replacing: everybody on the pattern moves
    // with it and nobody is reassigned.
    expect(renamed.id).toBe(before.id);
    expect(await patterns.headcount(system, before.id)).toBeGreaterThan(0);
  });

  it('moves updated_at, including when only the week changed', async () => {
    const before = await partTime();

    const changed = await patterns.update(system, before.id, { workingDays: [1, 2, 3, 4] });

    /* The work_pattern_set_updated_at trigger, attached to the same
       set_updated_at() the employee and department tables use. The days are the
       part most likely to be behind a day count somebody disputes, so a change
       to them alone still has to show. */
    expect(changed.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(changed.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it('refuses renaming one onto a name that already belongs to another', async () => {
    const before = await partTime();

    await expect(
      patterns.update(system, before.id, { name: STANDARD_PATTERN_NAME.toLowerCase() }),
    ).rejects.toBeInstanceOf(DuplicateWorkPatternName);
  });

  it('says so plainly when there is no such pattern', async () => {
    await expect(patterns.update(system, '999999', { name: 'Nobody' })).rejects.toBeInstanceOf(
      WorkPatternNotFound,
    );
    await expect(patterns.byId(system, '999999')).rejects.toBeInstanceOf(WorkPatternNotFound);
  });
});

describe('exactly one pattern is the default', () => {
  it('moves the default from one pattern to another', async () => {
    const before = await partTime();

    const promoted = await patterns.makeDefault(system, before.id);

    expect(promoted.isDefault).toBe(true);
    expect((await patterns.standard(system)).id).toBe(before.id);
    // And the week that was the default no longer is. Both halves are one
    // transaction, because neither order works as two statements.
    expect((await patterns.byName(system, STANDARD_PATTERN_NAME))?.isDefault).toBe(false);
  });

  it('is unbothered by being told twice', async () => {
    const standard = await patterns.standard(system);

    expect((await patterns.makeDefault(system, standard.id)).isDefault).toBe(true);
  });

  it('refuses a second default at the database', async () => {
    const before = await partTime();

    // The immediate unique index, which is what makes the answer right when two
    // HR admins are choosing at the same moment rather than one after the other.
    await expect(
      admin.query('UPDATE work_pattern SET is_default = true WHERE id = $1', [before.id]),
    ).rejects.toThrow(/work_pattern_one_default/);
  });

  it('refuses leaving the table with no default at all', async () => {
    /* Deferred, so this arrives at COMMIT. A database with no default is one
       where no employee can be created, and it is discovered by the HR officer
       adding a joiner rather than by whoever caused it. */
    await expect(inTransaction('UPDATE work_pattern SET is_default = false')).rejects.toMatchObject(
      { code: '23514', constraint: 'work_pattern_always_has_a_default' },
    );

    expect((await patterns.standard(system)).name).toBe(STANDARD_PATTERN_NAME);
  });

  it('permits no default for the length of one statement inside a transaction', async () => {
    // The other side of the same trigger, and the reason it is deferred: the
    // ordinary way of moving the default passes through zero of them.
    const before = await partTime();

    await inTransaction(
      'UPDATE work_pattern SET is_default = false WHERE is_default',
      `UPDATE work_pattern SET is_default = true WHERE id = ${before.id}`,
    );

    expect((await patterns.standard(system)).id).toBe(before.id);
  });
});

describe('deleting a working pattern', () => {
  it('removes one nobody works, and its seven days with it', async () => {
    const created = await patterns.create(system, { name: 'Typo on a Tuesday', workingDays: [2] });

    await patterns.remove(system, created.id);

    await expect(patterns.byId(system, created.id)).rejects.toBeInstanceOf(WorkPatternNotFound);
    const { rows } = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM work_pattern_day WHERE work_pattern_id = $1',
      [created.id],
    );
    expect(rows[0].count).toBe(0);
  });

  it('refuses the default, whether or not anybody is on it', async () => {
    const standard = await patterns.standard(system);

    await expect(patterns.remove(system, standard.id)).rejects.toBeInstanceOf(
      DefaultWorkPatternRequired,
    );
  });

  it('refuses one somebody is still working, and says how many', async () => {
    const pattern = await partTime();
    const headcount = await patterns.headcount(system, pattern.id);

    let thrown: unknown;
    try {
      await patterns.remove(system, pattern.id);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkPatternInUse);
    expect((thrown as WorkPatternInUse).headcount).toBe(headcount);
    expect(headcount).toBeGreaterThan(0);
  });

  it('counts a leaver as somebody still on it', async () => {
    /* Deliberately unlike a department's headcount, which leaves them out. FR 37a
       settles a leaver's final figure by counting days against the week they
       worked, so their pattern is still load bearing after they have gone. */
    const created = await patterns.create(system, { name: 'Left on it', workingDays: [1, 2, 3] });
    await employees.update(system, people.leaver, { workPatternId: created.id });

    expect(await patterns.headcount(system, created.id)).toBe(1);
    await expect(patterns.remove(system, created.id)).rejects.toBeInstanceOf(WorkPatternInUse);
  });

  it('is refused by the foreign key on the owner connection too', async () => {
    const pattern = await partTime();

    await expect(
      admin.query('DELETE FROM work_pattern WHERE id = $1', [pattern.id]),
    ).rejects.toThrow(/employee_work_pattern_id_fkey/);
  });

  it('refuses deleting the default on the owner connection too', async () => {
    const standard = await patterns.standard(system);

    /* Nobody is on it in this test — the seed puts everybody on it, so it has to
       be emptied first to prove that the refusal is about the default rather
       than about the headcount. The employees are moved to the part timer's
       pattern rather than deleted, because employees are never deleted. */
    const elsewhere = await partTime();
    await admin.query('UPDATE employee SET work_pattern_id = $1 WHERE work_pattern_id = $2', [
      elsewhere.id,
      standard.id,
    ]);

    await expect(
      inTransaction(`DELETE FROM work_pattern WHERE id = ${standard.id}`),
    ).rejects.toMatchObject({ constraint: 'work_pattern_always_has_a_default' });
  });

  it('says so plainly when there is no such pattern', async () => {
    await expect(patterns.remove(system, '999999')).rejects.toBeInstanceOf(WorkPatternNotFound);
  });
});

describe('listing them', () => {
  it('puts the default first, then the rest by name', async () => {
    await patterns.create(system, { name: 'Alphabetically first', workingDays: [1] });

    const all = await patterns.list(system);

    expect(all[0].name).toBe(STANDARD_PATTERN_NAME);
    expect(all[0].isDefault).toBe(true);
    expect(all.map((pattern) => pattern.name)).toContain('Alphabetically first');
    // Every one of them comes back with its week, in one round trip rather than
    // one per pattern.
    expect(all.every((pattern) => pattern.workingDays.length > 0)).toBe(true);
  });
});

describe('the application role', () => {
  it('may create, edit and delete patterns', async () => {
    /* Deliberately unlike department, where the DELETE was taken back because
       deactivation is the ending a department has. A pattern has no other
       ending: the one reachable here is the pattern nobody works, because the
       foreign key holds the rest and the trigger holds the default. */
    const { rows } = await admin.query<{ del: boolean; upd: boolean; ins: boolean }>(
      `SELECT has_table_privilege('lms_app', 'work_pattern', 'DELETE') AS del,
              has_table_privilege('lms_app', 'work_pattern', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'work_pattern', 'INSERT') AS ins`,
    );

    expect(rows[0]).toEqual({ del: true, upd: true, ins: true });
  });
});
