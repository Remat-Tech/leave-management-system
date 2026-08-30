import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { isCalendarDate } from '../../src/domain/time.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Timestamps in UTC, leave dates without a time. NFR DAT 03. LMS 114.
 *
 * The story is an employee whose leave never appears to shift by a day, and
 * almost all of it is in the database and the connection to it: which type a
 * column is, what the session does to a value on the way past, and what the
 * driver hands back. None of that can be proved without a real server, so this
 * suite carries the story the way integration/audit.test.ts carries LMS 113.
 * ../unit/time.test.ts covers the rules that are pure functions.
 *
 * Five properties, and each one is somebody believing a date while it is wrong:
 *
 *   A moment is a `timestamptz` and a day is a `date`, in every table there is
 *   and in every table there will be.
 *
 *   Every connection the application opens is in UTC and reads dates as ISO,
 *   whatever the host is set to and whether or not the migration has run.
 *
 *   A `date` arrives as the ten characters it was written as, from a process set
 *   fourteen hours away.
 *
 *   A `timestamptz` that is stored in an audit snapshot is rendered as UTC, so
 *   the same change made from two places is the same row.
 *
 *   The zone people read in is a setting, and moves nothing that is stored.
 */

const testDatabaseUrl = inject('testDatabaseUrl');
const testDatabaseName = inject('testDatabaseName');

const ORIGINAL_TIMEZONE = process.env.TZ;

let db: Kysely<Database>;
let admin: Client;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();
});

beforeEach(async () => {
  await seed(admin);
});

afterEach(() => {
  process.env.TZ = ORIGINAL_TIMEZONE;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/**
 * Every column in the schema that carries a date or a time, from the catalogue.
 *
 * `information_schema` rather than the migration text, because this is the
 * question asked of what was actually built. ../unit/migrations.test.ts asks the
 * same thing of the SQL and answers in a second without a database; this is the
 * answer that is true.
 *
 * `pgmigrations` is left out, and it is the one exclusion. It is node-pg-migrate's
 * own bookkeeping — which migrations have run — its `run_on` is a `timestamp`
 * without a zone, and its shape is the tool's rather than ours. Nothing in this
 * system reads it and no migration may edit it. Every other table in `public` is
 * ours and is judged.
 */
async function temporalColumns() {
  const { rows } = await admin.query<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name <> 'pgmigrations'
        AND data_type IN (
              'date',
              'time without time zone', 'time with time zone',
              'timestamp without time zone', 'timestamp with time zone')
      ORDER BY table_name, column_name`,
  );

  return rows;
}

const describes = (column: { table_name: string; column_name: string; data_type: string }) =>
  `${column.table_name}.${column.column_name} is ${column.data_type}`;

describe('the columns', () => {
  it('there are some, so an empty answer is not passing by accident', async () => {
    expect((await temporalColumns()).length).toBeGreaterThan(0);
  });

  /* A `timestamp` without a zone stores the characters it was handed. The same
     instant written by a host in Accra and a host in London is then two different
     rows, and nothing in either of them says which was which. */
  it('a moment is always stored with its zone', async () => {
    const columns = await temporalColumns();
    const naked = columns.filter(
      (column) => column.data_type !== 'date' && column.data_type !== 'timestamp with time zone',
    );

    expect(naked.map(describes)).toEqual([]);
  });

  /* And the other direction, which is the story's own: a day with a time on it is
     a day that moves. There are two such columns today and by Phase 3 there will
     be the start and end of every leave request. */
  it('a column named for a day is a date', async () => {
    const columns = await temporalColumns();
    const wrong = columns.filter(
      (column) => column.column_name.endsWith('_date') && column.data_type !== 'date',
    );

    expect(wrong.map(describes)).toEqual([]);
  });

  it('a column named for a moment is not a date', async () => {
    const columns = await temporalColumns();
    const wrong = columns.filter(
      (column) =>
        column.column_name.endsWith('_at') && column.data_type !== 'timestamp with time zone',
    );

    expect(wrong.map(describes)).toEqual([]);
  });

  /* A list rather than a rule, and it is meant to be edited. Every column here is
     a day somebody's leave is counted from, so a new one is a decision worth
     making on purpose — the same reason AUDITED_ENTITIES is a list. Phase 3 will
     add the start and end of a leave request; adding them here is the moment to
     check each is a `date`.

     The two from LMS 203 are also the two that the naming rule above would not
     have caught: `effective_from` and `effective_to` are days without saying so in
     their names, and this list is what stands behind them. They are days rather
     than moments because an entitlement changes on a date — "twenty two days from
     1 January" — and a `timestamptz` would carry a zone that moved it to the
     second of January for anybody who set it from London.

     The two from LMS 205 are the ends of a leave year, and they are the pair with
     the most riding on being days. A year that began at an instant would begin on
     the thirty first of December for anybody reading it from London, and the day
     a balance is drawn from is decided by which side of that line a request falls
     on. `closed_at` is deliberately not among them: when somebody closed a year is
     a moment, and it is a `timestamptz` a few lines above.

     The one from LMS 206 is a public holiday, and it is the column where the off
     by one day bug would be most visible to the most people: a Christmas Day held
     as an instant is a Christmas Day that reads as the twenty fourth of December
     from anywhere west of Accra, and everybody in the company is charged a day of
     leave for it. */
  it('the seven dates there are today are the ones expected', async () => {
    const dates = (await temporalColumns())
      .filter((column) => column.data_type === 'date')
      .map((column) => `${column.table_name}.${column.column_name}`);

    expect(dates).toEqual([
      'employee.exit_date',
      'employee.start_date',
      'holiday.holiday_date',
      'leave_entitlement_rule.effective_from',
      'leave_entitlement_rule.effective_to',
      'leave_year.end_date',
      'leave_year.start_date',
    ]);
  });
});

describe('the session', () => {
  async function setting(name: string): Promise<string> {
    const { rows } = await sql<{ value: string }>`SELECT current_setting(${sql.lit(
      name,
    )}) AS value`.execute(db);

    return rows[0].value;
  }

  it('an application connection is in UTC', async () => {
    expect(await setting('TimeZone')).toBe('UTC');
  });

  it('and reads dates as ISO, year first', async () => {
    expect(await setting('DateStyle')).toBe('ISO, YMD');
  });

  /* The migration's half, read from the catalogue rather than from a connection,
     because only one layer can be observed at a time on any given session. This
     is the layer that covers psql, the seed and a migration correcting data —
     everything that never goes near the pool. */
  it('the migration set both on the database itself', async () => {
    const { rows } = await admin.query<{ setconfig: string[] | null }>(
      `SELECT setconfig
         FROM pg_db_role_setting
         JOIN pg_database ON pg_database.oid = pg_db_role_setting.setdatabase
        WHERE pg_database.datname = $1
          AND setrole = 0`,
      [testDatabaseName],
    );

    expect(rows[0]?.setconfig ?? []).toEqual(
      expect.arrayContaining(['TimeZone=UTC', 'DateStyle=ISO, YMD']),
    );
  });

  it('and both on the application role, for a connection that is not the pool', async () => {
    const { rows } = await admin.query<{ setconfig: string[] | null }>(
      `SELECT setconfig
         FROM pg_db_role_setting
         JOIN pg_database ON pg_database.oid = pg_db_role_setting.setdatabase
         JOIN pg_roles ON pg_roles.oid = pg_db_role_setting.setrole
        WHERE pg_database.datname = $1
          AND pg_roles.rolname = 'lms_app'`,
      [testDatabaseName],
    );

    expect(rows[0]?.setconfig ?? []).toEqual(
      expect.arrayContaining(['TimeZone=UTC', 'DateStyle=ISO, YMD']),
    );
  });

  /**
   * The pool's half, on its own.
   *
   * The database setting is taken away for the length of this test, so that the
   * only thing left putting the connection into UTC is ../../src/db/index.ts.
   * That is the layer that has to hold on a database somebody has restored from a
   * backup, or brought up before this migration, or on a host that would not
   * permit the ALTER DATABASE — which is exactly when nobody is looking.
   *
   * A fresh pool, because the settings are applied when a physical connection is
   * made and the existing one already has them. Put back in a `finally`, since
   * every other file in this suite shares the database.
   */
  it('holds even where the database says nothing', async () => {
    await admin.query(`ALTER DATABASE "${testDatabaseName}" RESET TimeZone`);
    await admin.query(`ALTER DATABASE "${testDatabaseName}" RESET DateStyle`);

    const fresh = databaseFor(testDatabaseUrl);

    try {
      const { rows } = await sql<{
        zone: string;
        style: string;
      }>`SELECT current_setting('TimeZone') AS zone, current_setting('DateStyle') AS style`.execute(
        fresh,
      );

      expect(rows[0].zone).toBe('UTC');
      expect(rows[0].style).toBe('ISO, YMD');
    } finally {
      await fresh.destroy();
      await admin.query(`ALTER DATABASE "${testDatabaseName}" SET TimeZone = 'UTC'`);
      await admin.query(`ALTER DATABASE "${testDatabaseName}" SET DateStyle = 'ISO, YMD'`);
    }
  });
});

describe('a leave date', () => {
  /** Kojo Antwi left in July and is in the fixtures precisely for this shape. */
  async function theLeaver() {
    const row = await db
      .selectFrom('employee')
      .select(['first_name', 'start_date', 'exit_date'])
      .where('exit_date', 'is not', null)
      .executeTakeFirstOrThrow();

    return row;
  }

  it('comes back as the ten characters it was written as, not as an instant', async () => {
    const leaver = await theLeaver();

    expect(typeof leaver.exit_date).toBe('string');
    expect(isCalendarDate(leaver.exit_date)).toBe(true);
    expect(leaver.exit_date).toMatch(/^\d{4}-07-\d{2}$/);
  });

  /* The whole story in one assertion. Fourteen hours ahead of UTC and eleven
     behind it are the two ends of the inhabited world, and an exit date that is
     the same characters in both is an exit date that cannot shift by a day. A
     `date` parsed into a Date at UTC midnight would read as the day before in
     Niue and the day after in Kiritimati, which is the bug this story is named
     for. */
  it.each(['Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Tokyo', 'America/New_York', 'UTC'])(
    'is the same day with the process set to %s',
    async (zone) => {
      process.env.TZ = 'UTC';
      const asUtc = await theLeaver();

      process.env.TZ = zone;
      const elsewhere = await theLeaver();

      expect(elsewhere.exit_date).toBe(asUtc.exit_date);
      expect(elsewhere.start_date).toBe(asUtc.start_date);
    },
  );

  it('is not something the display timezone can move', async () => {
    const before = await theLeaver();

    process.env.DISPLAY_TIMEZONE = 'Asia/Tokyo';
    try {
      expect((await theLeaver()).exit_date).toBe(before.exit_date);
    } finally {
      delete process.env.DISPLAY_TIMEZONE;
    }
  });
});

describe('a moment in an audit snapshot', () => {
  /**
   * The reason the session is pinned rather than left alone.
   *
   * `record_in_audit_log()` snapshots a changed row with `to_jsonb()`, which
   * renders every `timestamptz` in it as text using the session's zone. The
   * instant is the same either way; the characters are not, and the characters
   * are what is stored and what `changedFields()` compares. An entry that reports
   * a change because the seed ran on somebody's laptop is an entry nobody
   * believes.
   *
   * These rows were written by the seed on a raw connection, which is the half
   * the ALTER DATABASE covers and the pool does not.
   */
  it('is written as UTC, whoever made the change', async () => {
    const { rows } = await admin.query<{ created_at: string }>(
      `SELECT after ->> 'created_at' AS created_at
         FROM audit_log
        WHERE entity = 'employee' AND action = 'CREATE'
        ORDER BY id`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.created_at).toMatch(/\+00:00$/);
    }
  });

  /* And the same value seen from a session that is not pinned, so that the
     property above is a fact about the configuration rather than about this
     machine happening to be set to UTC. */
  it('would say something else from a session in another zone', async () => {
    const elsewhere = new Client({ connectionString: testDatabaseUrl });
    await elsewhere.connect();

    try {
      await elsewhere.query(`SET TIME ZONE 'Asia/Tokyo'`);

      const { rows } = await elsewhere.query<{ rendered: string }>(
        `SELECT to_jsonb(created_at) #>> '{}' AS rendered FROM employee ORDER BY id LIMIT 1`,
      );

      expect(rows[0].rendered).toMatch(/\+09:00$/);
    } finally {
      await elsewhere.end();
    }
  });
});
