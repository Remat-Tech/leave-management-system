import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  AlreadyTerminated,
  DuplicateEmployeeNumber,
  DuplicateWorkEmail,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  EmployeeNotFound,
  GENDERS,
  InvalidEmployee,
} from '../../src/domain/employee.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { seed } from '../../seeds/seed.mjs';
import type { Kysely } from 'kysely';

/**
 * The employee record against a real database. FR 01 and FR 05, LMS 101.
 *
 * The unit suite covers the rules. What needs a database is everything the
 * database itself decides: that the two identifiers really are unique and really
 * are compared without regard to case, that a value outside a permitted list
 * cannot be stored whatever wrote it, and that a record cannot be deleted by the
 * role the application connects as.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

// The suite supplies its own rather than reading ALLOWED_EMAIL_DOMAINS, which is
// set in .env but not in CI.
const DOMAINS = ['rematholdings.com'];

let db: Kysely<Database>;
let admin: Client;
let employees: EmployeeService;

const JOINER = {
  employeeNumber: 'RH-0100',
  firstName: 'Esi',
  lastName: 'Nyarko',
  workEmail: 'esi.nyarko@rematholdings.com',
  jobTitle: 'Operations Officer',
  startDate: '2026-09-01',
};

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  // The owner connection, for seeding and for the statements that deliberately
  // go round the service to prove a constraint rather than a rule.
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  employees = new EmployeeService(new EmployeeRepository(db), { domains: DOMAINS });
});

beforeEach(async () => {
  // The organisation, so that each test starts from the same thirteen people
  // and a test that adds somebody cannot affect the next one.
  await seed(admin);
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

describe('creating an employee record', () => {
  it('stores every field FR 01 asks for and reads them back unchanged', async () => {
    const created = await employees.create({
      ...JOINER,
      employmentType: 'PART_TIME',
      gender: 'FEMALE',
    });

    const readBack = await employees.byId(created.id);

    expect(readBack).toMatchObject({
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      jobTitle: 'Operations Officer',
      startDate: '2026-09-01',
      exitDate: null,
      employmentType: 'PART_TIME',
      employmentStatus: 'ACTIVE',
      gender: 'FEMALE',
    });
  });

  it('gives a joiner the default working pattern when none is chosen', async () => {
    // The column is NOT NULL, so creating an employee has to resolve one. FR 23.
    const created = await employees.create(JOINER);

    const { rows } = await admin.query<{ name: string }>(
      'SELECT name FROM work_pattern WHERE id = $1',
      [created.workPatternId],
    );

    expect(rows[0].name).toBe('Standard Mon-Fri');
  });

  it('hands back a start date as a calendar date, not an instant', async () => {
    // A `date` parsed into a JavaScript Date is midnight UTC, and is then read
    // in whatever timezone the process runs in. That is the off by one day this
    // system cannot afford on a leaver's exit date.
    const created = await employees.create(JOINER);

    expect(created.startDate).toBe('2026-09-01');
    expect(typeof created.startDate).toBe('string');
  });
});

describe('the two identifiers are unique', () => {
  it('refuses a second employee with the same number', async () => {
    await employees.create(JOINER);

    await expect(
      employees.create({ ...JOINER, workEmail: 'someone.else@rematholdings.com' }),
    ).rejects.toBeInstanceOf(DuplicateEmployeeNumber);
  });

  it('refuses a second employee with the same work address', async () => {
    await employees.create(JOINER);

    await expect(employees.create({ ...JOINER, employeeNumber: 'RH-0101' })).rejects.toBeInstanceOf(
      DuplicateWorkEmail,
    );
  });

  it('treats a number differing only in case as the same number', async () => {
    await employees.create(JOINER);

    // Nobody was ever issued a second staff number that differs from their first
    // only in capitals.
    await expect(
      employees.create({
        ...JOINER,
        employeeNumber: 'rh-0100',
        workEmail: 'someone.else@rematholdings.com',
      }),
    ).rejects.toBeInstanceOf(DuplicateEmployeeNumber);
  });

  it('treats an address differing only in case as the same address', async () => {
    await employees.create(JOINER);

    await expect(
      employees.create({
        ...JOINER,
        employeeNumber: 'RH-0101',
        workEmail: 'Esi.Nyarko@RematHoldings.com',
      }),
    ).rejects.toBeInstanceOf(DuplicateWorkEmail);
  });

  it('keeps the number in the shape it was typed', async () => {
    // Compared folded, stored as written, so a staff number still looks like the
    // one on HR's paperwork.
    const created = await employees.create({ ...JOINER, employeeNumber: 'RH-0100' });

    expect(created.employeeNumber).toBe('RH-0100');
  });

  it('refuses the duplicate at the database, not merely in the code', async () => {
    await employees.create(JOINER);

    // Straight past the service, as the seed or a data fixing migration would
    // go. The unique index is what makes this a fact rather than a convention,
    // and it is also what makes the service's check safe under concurrency.
    await expect(
      admin.query(
        `INSERT INTO employee (
           employee_number, first_name, last_name, work_email,
           work_pattern_id, start_date
         )
         SELECT 'rh-0100', 'Someone', 'Else', 'someone.else@rematholdings.com',
                id, DATE '2026-09-01'
           FROM work_pattern WHERE is_default`,
      ),
    ).rejects.toThrow(/employee_number_unique/);
  });

  it('finds an employee by either identifier, whatever case it is asked in', async () => {
    const created = await employees.create(JOINER);

    expect(await employees.byNumber('rh-0100')).toMatchObject({ id: created.id });
    expect(await employees.byWorkEmail('ESI.NYARKO@rematholdings.com')).toMatchObject({
      id: created.id,
    });
  });
});

describe('the values a record may hold', () => {
  /** The list a CHECK constraint permits, read back out of the database. */
  async function permittedBy(constraint: string): Promise<string[]> {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'employee'::regclass AND conname = $1`,
      [constraint],
    );

    expect(rows).toHaveLength(1);
    return [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort();
  }

  it.each([
    ['employee_employment_type_known', EMPLOYMENT_TYPES],
    ['employee_employment_status_known', EMPLOYMENT_STATUSES],
    ['employee_gender_known', GENDERS],
  ])('%s permits exactly the values the code knows about', async (constraint, known) => {
    // The same list is written twice, in the migration and in
    // src/domain/employee.ts. This is what stops the two drifting: add a value
    // to one and forget the other and the suite fails rather than production.
    expect(await permittedBy(constraint as string)).toEqual(
      [...(known as readonly string[])].sort(),
    );
  });

  it('refuses an unknown employment status at the database', async () => {
    await expect(
      admin.query(
        `INSERT INTO employee (
           employee_number, first_name, last_name, work_email,
           work_pattern_id, start_date, employment_status
         )
         SELECT 'RH-0200', 'Wrong', 'Status', 'wrong.status@rematholdings.com',
                id, DATE '2026-09-01', 'Active'
           FROM work_pattern WHERE is_default`,
      ),
    ).rejects.toThrow(/employee_employment_status_known/);
  });

  it('refuses a name that is present but blank', async () => {
    // NOT NULL says a value arrived. It does not say the value means anything,
    // and '' has a name according to every IS NOT NULL and shows nothing on
    // every screen.
    await expect(
      admin.query(
        `INSERT INTO employee (
           employee_number, first_name, last_name, work_email,
           work_pattern_id, start_date
         )
         SELECT 'RH-0201', '  ', 'Blank', 'blank.name@rematholdings.com',
                id, DATE '2026-09-01'
           FROM work_pattern WHERE is_default`,
      ),
    ).rejects.toThrow(/employee_first_name_not_blank/);
  });

  it('refuses a terminated record with no exit date at the database', async () => {
    await expect(
      admin.query(
        `UPDATE employee SET employment_status = 'TERMINATED'
          WHERE work_email = 'yram.kudjo@rematholdings.com'`,
      ),
    ).rejects.toThrow(/employee_terminated_has_exit_date/);
  });

  it('has kept the fixture organisation valid under all of it', async () => {
    // The constraints arrived after the seed was written. If the fixture set
    // could not be loaded under them, every other test here would be passing
    // against data that production would refuse.
    const { rows } = await admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM employee',
    );

    expect(rows[0].count).toBe(13);
  });
});

describe('maintaining a record', () => {
  it('changes the field it was given and leaves the others alone', async () => {
    const created = await employees.create(JOINER);

    const updated = await employees.update(created.id, { jobTitle: 'Operations Manager' });

    expect(updated.jobTitle).toBe('Operations Manager');
    expect(updated.firstName).toBe('Esi');
    expect(updated.employeeNumber).toBe('RH-0100');
  });

  it('moves updated_at, so a record says when it last changed', async () => {
    const created = await employees.create(JOINER);

    const updated = await employees.update(created.id, { jobTitle: 'Operations Manager' });

    // The trigger does this, not the application, so the seed and a data fixing
    // migration get the same treatment.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it('refuses to move a number onto one that already belongs to somebody', async () => {
    const created = await employees.create(JOINER);

    await expect(
      employees.update(created.id, { employeeNumber: 'rh-0001' }),
    ).rejects.toBeInstanceOf(DuplicateEmployeeNumber);
  });

  it('says so plainly when there is no such employee', async () => {
    await expect(employees.update('999999', { jobTitle: 'Nobody' })).rejects.toBeInstanceOf(
      EmployeeNotFound,
    );
  });
});

describe('a record is deactivated, never deleted, FR 06', () => {
  /** Kojo Antwi, who left in July and is still on the books. */
  const LEAVER = 'kojo.antwi@rematholdings.com';

  async function leaverId(): Promise<string> {
    const employee = await employees.byWorkEmail(LEAVER);
    expect(employee).toBeDefined();
    return employee!.id;
  }

  describe('terminating', () => {
    it('sets the status and the exit date together', async () => {
      const created = await employees.create(JOINER);

      const left = await employees.terminate(created.id, { exitDate: '2026-12-31' });

      expect(left.employmentStatus).toBe('TERMINATED');
      expect(left.exitDate).toBe('2026-12-31');
    });

    it('changes nothing else about the record', async () => {
      // This is the assertion the story is actually about. The row that every
      // leave request, ledger entry and approval of theirs points at is the same
      // row, with the same id, and everything on it that was true yesterday is
      // still true.
      const created = await employees.create({
        ...JOINER,
        gender: 'FEMALE',
        employmentType: 'PART_TIME',
      });

      const left = await employees.terminate(created.id, { exitDate: '2026-12-31' });

      expect(left).toEqual({
        ...created,
        employmentStatus: 'TERMINATED',
        exitDate: '2026-12-31',
        updatedAt: left.updatedAt,
      });
      expect(left.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it('refuses to overwrite the exit date of somebody who has already left', async () => {
      // Kojo's final figure was settled from the date on his record. Silently
      // moving it months later is the defect this refusal exists to prevent.
      await expect(
        employees.terminate(await leaverId(), { exitDate: '2026-12-31' }),
      ).rejects.toBeInstanceOf(AlreadyTerminated);

      expect((await employees.byWorkEmail(LEAVER))?.exitDate).toBe('2026-07-31');
    });

    it('refuses an exit date before the day they started', async () => {
      const created = await employees.create(JOINER);

      await expect(
        employees.terminate(created.id, { exitDate: '2026-08-01' }),
      ).rejects.toBeInstanceOf(InvalidEmployee);
    });

    it('says so plainly when there is no such employee', async () => {
      await expect(
        employees.terminate('999999', { exitDate: '2026-12-31' }),
      ).rejects.toBeInstanceOf(EmployeeNotFound);
    });

    it('can be corrected, because the record is still there to correct', async () => {
      const created = await employees.create(JOINER);
      await employees.terminate(created.id, { exitDate: '2026-12-31' });

      const back = await employees.update(created.id, {
        employmentStatus: 'ACTIVE',
        exitDate: null,
      });

      expect(back.employmentStatus).toBe('ACTIVE');
      expect(back.exitDate).toBeNull();
      // Same person, same id. Nothing of theirs was ever orphaned.
      expect(back.id).toBe(created.id);
      expect(back.createdAt.getTime()).toBe(created.createdAt.getTime());
    });
  });

  describe('deleting', () => {
    it('gives the application role no way to delete one', async () => {
      // There is no delete method on the service, but a missing method is a
      // convention. This is the part that is not: the role the application
      // connects as does not hold the privilege, so a DELETE reaching the
      // database at all fails there.
      const { rows } = await admin.query<{ del: boolean; upd: boolean; trunc: boolean }>(
        `SELECT has_table_privilege('lms_app', 'employee', 'DELETE')   AS del,
                has_table_privilege('lms_app', 'employee', 'UPDATE')   AS upd,
                has_table_privilege('lms_app', 'employee', 'TRUNCATE') AS trunc`,
      );

      expect(rows[0]).toEqual({ del: false, upd: true, trunc: false });
    });

    it('refuses a delete on the owner connection too', async () => {
      // The privilege covers the application. This covers migrations, the seed
      // and a person in psql, which is where the accident actually happens.
      await expect(
        admin.query('DELETE FROM employee WHERE work_email = $1', [LEAVER]),
      ).rejects.toThrow(/never deleted/);

      expect(await employees.byWorkEmail(LEAVER)).toBeDefined();
    });

    it('refuses a delete that would take the whole table with it', async () => {
      // An unqualified DELETE is the shape of the four in the afternoon
      // accident. A statement level trigger would let this through; the trigger
      // is per row for exactly that reason.
      await expect(admin.query('DELETE FROM employee')).rejects.toThrow(/never deleted/);

      const { rows } = await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM employee',
      );
      expect(rows[0].count).toBe(13);
    });

    it('reports the refusal as an integrity violation, not a crash', async () => {
      // restrict_violation, so a caller can tell this apart from a genuine fault
      // by SQLSTATE rather than by reading the message text.
      await expect(admin.query('DELETE FROM employee')).rejects.toMatchObject({ code: '23001' });
    });

    it('still lets the seed truncate and reload the fixture organisation', async () => {
      // A row level trigger does not fire on TRUNCATE, which is deliberate.
      // Emptying the table on purpose is the seed's job; losing one person's
      // history by accident is what FR 06 is about. beforeEach depends on this,
      // so it is asserted rather than left to be discovered.
      await expect(seed(admin)).resolves.toBeDefined();

      expect(await employees.byWorkEmail(LEAVER)).toBeDefined();
    });
  });

  describe('the history that survives', () => {
    it('keeps a leaver in the list, and can leave them out when asked', async () => {
      const all = await employees.list();
      const active = await employees.list({ activeOnly: true });

      // FR 06 keeps the record, and FR 37a needs exactly this shape of it.
      expect(all.map((employee) => employee.workEmail)).toContain(LEAVER);
      expect(active.map((employee) => employee.workEmail)).not.toContain(LEAVER);
      expect(all.length).toBe(active.length + 1);
    });

    it('still answers every question about a leaver by either identifier', async () => {
      // "Any dispute about it can still be settled" starts with being able to
      // find the person. A leaver is looked up exactly as anybody else is.
      const byEmail = await employees.byWorkEmail(LEAVER);
      const byNumber = await employees.byNumber(byEmail!.employeeNumber);

      expect(byNumber).toEqual(byEmail);
      expect(byEmail).toMatchObject({
        employmentStatus: 'TERMINATED',
        exitDate: '2026-07-31',
        firstName: 'Kojo',
        lastName: 'Antwi',
      });
      // Still has the start date their entitlement was pro rated from, and the
      // working pattern their days were counted against.
      expect(byEmail!.startDate).toBeTruthy();
      expect(byEmail!.workPatternId).toBeTruthy();
    });

    it('keeps their identifiers reserved, so nobody inherits their history', async () => {
      // The other half of not deleting. Were the row gone, the next joiner could
      // be issued RH-0007 and quietly acquire everything that pointed at it.
      const leaver = await employees.byWorkEmail(LEAVER);

      await expect(
        employees.create({
          ...JOINER,
          employeeNumber: leaver!.employeeNumber,
          workEmail: 'someone.else@rematholdings.com',
        }),
      ).rejects.toBeInstanceOf(DuplicateEmployeeNumber);

      await expect(
        employees.create({ ...JOINER, employeeNumber: 'RH-0300', workEmail: LEAVER }),
      ).rejects.toBeInstanceOf(DuplicateWorkEmail);
    });
  });
});
