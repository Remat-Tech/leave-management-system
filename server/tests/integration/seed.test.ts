import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The fixture set is only useful while the awkward cases are still in it. Each
 * of these asserts one of them, so that somebody tidying the seed data has to
 * decide deliberately to remove an edge rather than lose it by accident.
 *
 * Technical Design Document section 12.
 */
const testDatabaseUrl = await databaseForThisFile();

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: testDatabaseUrl });
  await db.connect();
  await seed(db);
});

afterAll(async () => {
  await db?.end();
});

async function depth(): Promise<number> {
  const { rows } = await db.query<{ deepest: number }>(
    `WITH RECURSIVE tree AS (
       SELECT id, 1 AS level FROM employee WHERE manager_id IS NULL
       UNION ALL
       SELECT e.id, t.level + 1 FROM employee e JOIN tree t ON e.manager_id = t.id
     )
     SELECT max(level)::int AS deepest FROM tree`,
  );
  return rows[0].deepest;
}

describe('the shape of the organisation', () => {
  it('is five levels deep', async () => {
    expect(await depth()).toBe(5);
  });

  it('has exactly one person with no manager, and it is the CEO', async () => {
    const { rows } = await db.query<{ job_title: string }>(
      'SELECT job_title FROM employee WHERE manager_id IS NULL',
    );

    // FR 04 permits exactly one. A second would mean a broken record rather
    // than a second chief executive.
    expect(rows).toHaveLength(1);
    expect(rows[0].job_title).toBe('Chief Executive Officer');
  });

  it('has people who are a manager and a report at the same time', async () => {
    const { rows } = await db.query(
      `SELECT m.id FROM employee m
        WHERE m.manager_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM employee r WHERE r.manager_id = m.id)`,
    );

    // Anything treating approvers and requesters as disjoint sets breaks here.
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('reaches every employee from the root, so nobody is orphaned', async () => {
    const { rows } = await db.query<{ unreachable: number }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM employee WHERE manager_id IS NULL
         UNION ALL
         SELECT e.id FROM employee e JOIN tree t ON e.manager_id = t.id
       )
       SELECT (SELECT count(*) FROM employee) - (SELECT count(*) FROM tree) AS unreachable`,
    );

    expect(Number(rows[0].unreachable)).toBe(0);
  });
});

describe('the awkward individuals', () => {
  it('includes a part timer whose week is not simply "weekends off"', async () => {
    const { rows } = await db.query<{ non_working: number }>(
      `SELECT count(*)::int AS non_working
         FROM employee e
         JOIN work_pattern_day d ON d.work_pattern_id = e.work_pattern_id
        WHERE e.employment_type = 'PART_TIME'
          AND d.is_working_day = false
          AND d.day_of_week NOT IN (6, 7)`,
    );

    // A pattern that only excludes Saturday and Sunday would let a calculator
    // that hard codes the weekend pass every test.
    expect(rows[0].non_working).toBeGreaterThan(0);
  });

  it('includes a leaver with an exit date, still on the books', async () => {
    const { rows } = await db.query<{ employment_status: string; exit_date: Date }>(
      'SELECT employment_status, exit_date FROM employee WHERE exit_date IS NOT NULL',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].employment_status).toBe('TERMINATED');
    // FR 06: deactivated, never deleted, so the leave history survives them.
    expect(rows[0].exit_date).toBeTruthy();
  });

  it('never gives anyone an exit date before they started', async () => {
    const { rows } = await db.query(
      'SELECT id FROM employee WHERE exit_date IS NOT NULL AND exit_date < start_date',
    );

    expect(rows).toHaveLength(0);
  });
});

describe('the HR function', () => {
  async function hrPeople(): Promise<string[]> {
    const { rows } = await db.query<{ email: string }>(
      `SELECT e.work_email AS email
         FROM employee e
         JOIN app_user u ON u.employee_id = e.id
         JOIN user_role ur ON ur.user_id = u.id
         JOIN role r ON r.id = ur.role_id
        WHERE r.code IN ('HR_OFFICER', 'HR_ADMIN')
          AND e.employment_status = 'ACTIVE'`,
    );
    return rows.map((row) => row.email);
  }

  it('has an HR Officer with a colleague, in the base fixture', async () => {
    await seed(db);

    const hr = await hrPeople();

    expect(hr).toContain('efua.owusu@rematholdings.com');
    // Two, so an HR person's own request can be decided by the other one.
    expect(hr.length).toBeGreaterThanOrEqual(2);
  });

  it('has a scenario where one person is the whole HR function', async () => {
    await seed(db, { scenario: 'lone-hr' });

    const hr = await hrPeople();

    expect(hr).toEqual(['ama.mensah@rematholdings.com']);

    // The point of the scenario: her own leave has nobody in HR left to decide
    // it, so routing has to fall to the CEO rather than to herself. FR 48b and
    // Technical Design Document 8.6a.
    const colleagues = hr.filter((email) => email !== 'ama.mensah@rematholdings.com');
    expect(colleagues).toEqual([]);
  });

  /**
   * And the guard is for callers TypeScript never sees.
   *
   * `npm run seed -- --scenario x` reads the value out of `process.argv`, so the check in
   * `seed` stands between an arbitrary string and a TRUNCATE. Testing it means stepping
   * outside the parameter type on purpose, which is what the cast is: without it this
   * reads as a type error to be silenced rather than the point of the test.
   */
  it('refuses a scenario it does not have', async () => {
    const unknown = { scenario: 'no-such-scenario' } as unknown as { scenario: 'base' };

    await expect(seed(db, unknown)).rejects.toThrow(/Unknown scenario/);
  });

  it('leaves the base organisation in place when run again', async () => {
    await seed(db);
    await seed(db);

    const { rows } = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM employee',
    );

    // Re-running loads the same organisation, not a second copy of it.
    expect(rows[0].count).toBe(13);
  });
});
