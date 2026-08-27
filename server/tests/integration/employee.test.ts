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
  ManagerCycle,
  ManagerHasLeft,
  ManagerNotFound,
  type NewEmployee,
  SecondRootEmployee,
} from '../../src/domain/employee.js';
import {
  type Department,
  DepartmentDeactivated,
  DepartmentNotFound,
} from '../../src/domain/department.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { DepartmentService } from '../../src/services/department-service.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { seed } from '../../seeds/seed.mjs';
import type { Kysely } from 'kysely';

/**
 * The employee record against a real database. FR 01 to FR 06, LMS 101 to
 * LMS 105.
 *
 * The unit suite covers the rules. What needs a database is everything the
 * database itself decides: that the two identifiers really are unique and really
 * are compared without regard to case, that a value outside a permitted list
 * cannot be stored whatever wrote it, that a record cannot be deleted by the
 * role the application connects as, that exactly one employee can be recorded
 * without a line manager, that no reporting line loops — including when the
 * change arrives as a bulk import that no service ever saw — and that everybody
 * is in a department.
 *
 * Departments themselves are ../integration/department.test.ts. What is here is
 * the employee's end of them.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

// The suite supplies its own rather than reading ALLOWED_EMAIL_DOMAINS, which is
// set in .env but not in CI.
const DOMAINS = ['rematholdings.com'];

let db: Kysely<Database>;
let admin: Client;
let employees: EmployeeService;
let departments: DepartmentService;

/** Reached directly only for chainFrom(), which nothing above it exposes. */
let repository: EmployeeRepository;

/** The ids the seed created, keyed by the names it uses for them. */
let people: Record<string, string>;

/** Operations, which most of the fixture organisation is in. */
let operations: Department;

const JOINER_FIELDS = {
  employeeNumber: 'RH-0100',
  firstName: 'Esi',
  lastName: 'Nyarko',
  workEmail: 'esi.nyarko@rematholdings.com',
  jobTitle: 'Operations Officer',
  startDate: '2026-09-01',
};

/**
 * A joiner in Operations, reporting to Kofi Boateng.
 *
 * Rebuilt each test rather than declared once, because a line manager and a
 * department are both part of what a record is now and both ids have to belong
 * to rows the seed actually created. The seed truncates with RESTART IDENTITY,
 * so they are read back rather than written down as numbers that would be
 * correct only until somebody adds a row above them in the fixture.
 */
let JOINER: NewEmployee;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  // The owner connection, for seeding and for the statements that deliberately
  // go round the service to prove a constraint rather than a rule.
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  repository = new EmployeeRepository(db);
  departments = new DepartmentService(new DepartmentRepository(db));
  employees = new EmployeeService(repository, new DepartmentRepository(db), { domains: DOMAINS });
});

beforeEach(async () => {
  // The organisation, so that each test starts from the same thirteen people
  // and a test that adds somebody cannot affect the next one.
  people = (await seed(admin)) as Record<string, string>;

  const found = await departments.byName('Operations');
  expect(found).toBeDefined();
  operations = found!;

  JOINER = { ...JOINER_FIELDS, managerId: people.teamLead, departmentId: operations.id };
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
      managerId: people.teamLead,
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
           department_id, manager_id, work_pattern_id, start_date
         )
         SELECT 'rh-0100', 'Someone', 'Else', 'someone.else@rematholdings.com',
                $1, $2, id, DATE '2026-09-01'
           FROM work_pattern WHERE is_default`,
        [operations.id, people.teamLead],
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
           department_id, manager_id, work_pattern_id, start_date, employment_status
         )
         SELECT 'RH-0200', 'Wrong', 'Status', 'wrong.status@rematholdings.com',
                $1, $2, id, DATE '2026-09-01', 'Active'
           FROM work_pattern WHERE is_default`,
        [operations.id, people.teamLead],
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
           department_id, manager_id, work_pattern_id, start_date
         )
         SELECT 'RH-0201', '  ', 'Blank', 'blank.name@rematholdings.com',
                $1, $2, id, DATE '2026-09-01'
           FROM work_pattern WHERE is_default`,
        [operations.id, people.teamLead],
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

describe('each employee has exactly one line manager, FR 02 and FR 04', () => {
  describe('recording the line', () => {
    it('stores who somebody reports to and reads it back', async () => {
      const created = await employees.create(JOINER);

      expect((await employees.byId(created.id)).managerId).toBe(people.teamLead);
    });

    it('refuses a manager who is nobody', async () => {
      // The foreign key would refuse this too, with a message about
      // employee_manager_id_fkey. This is the refusal an HR officer can read.
      await expect(employees.create({ ...JOINER, managerId: '999999' })).rejects.toBeInstanceOf(
        ManagerNotFound,
      );
    });

    it('refuses a manager who is nobody at the database as well', async () => {
      await expect(
        admin.query("UPDATE employee SET manager_id = 999999 WHERE employee_number = 'RH-0011'"),
      ).rejects.toThrow(/employee_manager_id_fkey/);
    });

    it('refuses a manager who has left', async () => {
      // Kojo left in July. Routing a request to him is the same black hole as
      // routing it nowhere, which is the whole of what FR 02 is for.
      await expect(
        employees.create({ ...JOINER, managerId: people.leaver }),
      ).rejects.toBeInstanceOf(ManagerHasLeft);
    });

    it('moves a reporting line onto somebody else', async () => {
      const created = await employees.create(JOINER);

      const moved = await employees.update(created.id, { managerId: people.opsManager });

      expect(moved.managerId).toBe(people.opsManager);
      // The move is the only thing that moved.
      expect(moved.employeeNumber).toBe('RH-0100');
      expect(moved.departmentId).toBe(created.departmentId);
    });

    it('refuses an employee as their own line manager', async () => {
      const created = await employees.create(JOINER);

      await expect(employees.update(created.id, { managerId: created.id })).rejects.toBeInstanceOf(
        InvalidEmployee,
      );
    });

    it('leaves a line alone when the change does not mention it', async () => {
      const created = await employees.create(JOINER);

      const updated = await employees.update(created.id, { jobTitle: 'Operations Manager' });

      expect(updated.managerId).toBe(people.teamLead);
    });
  });

  describe('exactly one employee with none, FR 04', () => {
    it('is the head of the organisation, and there is one of them', async () => {
      const head = await employees.head();

      expect(head?.id).toBe(people.ceo);
      expect(head?.jobTitle).toBe('Chief Executive Officer');
    });

    it('refuses a second, and names the one who already has none', async () => {
      // The warning HR is shown. "Somebody has no manager" is not something an
      // HR officer can act on; "Kwame Asante (RH-0001) does" is.
      let thrown: unknown;
      try {
        await employees.create({ ...JOINER, managerId: null });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SecondRootEmployee);
      expect((thrown as SecondRootEmployee).existingRootId).toBe(people.ceo);
      expect((thrown as Error).message).toContain('RH-0001');
    });

    it('refuses cutting an existing line for the same reason', async () => {
      await expect(employees.update(people.officer, { managerId: null })).rejects.toBeInstanceOf(
        SecondRootEmployee,
      );

      expect((await employees.byId(people.officer)).managerId).toBe(people.teamLead);
    });

    it('lets the head of the organisation go on being it', async () => {
      // Saying null about the record that is already the root is not a second
      // root, and an edit to that record must not be refused because of a rule
      // it already satisfies.
      const updated = await employees.update(people.ceo, {
        managerId: null,
        jobTitle: 'Group Chief Executive',
      });

      expect(updated.managerId).toBeNull();
      expect(updated.jobTitle).toBe('Group Chief Executive');
    });

    it('refuses the second at the database, not merely in the code', async () => {
      // Straight past the service, as the seed or a data fixing migration would
      // go. The index is what makes this a fact rather than a convention, and it
      // is also what makes the service's check safe under concurrency.
      await expect(
        admin.query(
          `INSERT INTO employee (
             employee_number, first_name, last_name, work_email,
             department_id, work_pattern_id, start_date, manager_id
           )
           SELECT 'RH-0400', 'Second', 'Root', 'second.root@rematholdings.com',
                  $1, id, DATE '2026-09-01', NULL
             FROM work_pattern WHERE is_default`,
          [operations.id],
        ),
      ).rejects.toThrow(/employee_one_root/);
    });

    it('refuses either half of a succession taken on its own', async () => {
      /* Succession used to be an ordered pair of ordinary updates: give the
         outgoing head a manager first, then clear the incoming one's. FR 03
         closed that off, and the two rules now leave no order that works one
         statement at a time.

         Clearing the incoming head's line first makes two rootless records.
         Giving the outgoing head theirs first makes the two of them point at
         each other, which is a loop. There is no third move: any manager for the
         outgoing head is somebody below them, and below them is where the loop
         comes from. */
      const incoming = await employees.create({
        ...JOINER,
        jobTitle: 'Chief Executive Officer',
        managerId: people.ceo,
      });

      await expect(employees.update(incoming.id, { managerId: null })).rejects.toBeInstanceOf(
        SecondRootEmployee,
      );

      await expect(employees.update(people.ceo, { managerId: incoming.id })).rejects.toBeInstanceOf(
        ManagerCycle,
      );
    });

    it('lets one head succeed another when both changes commit together', async () => {
      // So succession is one transaction, and this is the shape of it. The loop
      // stands for exactly one statement, which the deferred cycle trigger
      // permits and a per row one would not; the number of rootless records
      // never reaches two, which the index would not permit at any point.
      const incoming = await employees.create({
        ...JOINER,
        jobTitle: 'Chief Executive Officer',
        managerId: people.ceo,
      });

      await admin.query('BEGIN');
      await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
        incoming.id,
        people.ceo,
      ]);
      await admin.query('UPDATE employee SET manager_id = NULL WHERE id = $1', [incoming.id]);
      await expect(admin.query('COMMIT')).resolves.toBeDefined();

      expect((await employees.head())?.id).toBe(incoming.id);
      // The outgoing head keeps a line rather than becoming a second rootless
      // record, so a walk upward from anybody still terminates in one place.
      expect((await employees.byId(people.ceo)).managerId).toBe(incoming.id);
    });
  });

  describe('the warning HR is shown about the lines as they stand', () => {
    it('says nothing about the fixture organisation', async () => {
      // The useful shape of a passing check: an empty list, not a page of
      // reassurances to read past.
      expect(await employees.reportingLineWarnings()).toEqual([]);
    });

    it('warns about the reports of a manager who has since left', async () => {
      // The case no write-time check can see. Nobody edited Adwoa's or Abena's
      // record when Kofi left, so nothing was there to refuse.
      await employees.terminate(people.teamLead, { exitDate: '2026-08-31' });

      const warnings = await employees.reportingLineWarnings();

      expect(warnings.map((warning) => warning.code)).toEqual([
        'MANAGER_HAS_LEFT',
        'MANAGER_HAS_LEFT',
      ]);
      expect(warnings.every((warning) => warning.employeeIds.includes(people.teamLead))).toBe(true);
    });

    it('leaves a leaver reporting to a leaver out of it', async () => {
      // Kojo also reported to Kofi, and is warned about by neither: the warning
      // is that requests have nowhere to go, and Kojo is not raising any.
      await employees.terminate(people.teamLead, { exitDate: '2026-08-31' });

      const warnings = await employees.reportingLineWarnings();

      expect(warnings.some((warning) => warning.employeeIds.includes(people.leaver))).toBe(false);
    });

    it('goes quiet again once the reports are moved', async () => {
      await employees.terminate(people.teamLead, { exitDate: '2026-08-31' });

      for (const id of [people.officer, people.partTimer]) {
        await employees.update(id, { managerId: people.opsManager });
      }

      expect(await employees.reportingLineWarnings()).toEqual([]);
    });
  });
});

describe('every employee is in one department, LMS 105', () => {
  /** A department with nobody in it, for the cases that need one. */
  async function emptyDepartment(name = 'Internal Audit'): Promise<Department> {
    return departments.create({ name });
  }

  it('stores the team and reads it back', async () => {
    const created = await employees.create(JOINER);

    expect((await employees.byId(created.id)).departmentId).toBe(operations.id);
  });

  it('refuses a team that is nobody', async () => {
    // The foreign key would refuse this too, with a message about
    // employee_department_id_fkey. This is the refusal an HR officer can read.
    await expect(employees.create({ ...JOINER, departmentId: '999999' })).rejects.toBeInstanceOf(
      DepartmentNotFound,
    );
  });

  it('refuses a record with no team at the database as well', async () => {
    await expect(
      admin.query(
        `INSERT INTO employee (
           employee_number, first_name, last_name, work_email,
           work_pattern_id, start_date, manager_id
         )
         SELECT 'RH-0500', 'No', 'Team', 'no.team@rematholdings.com',
                id, DATE '2026-09-01', $1
           FROM work_pattern WHERE is_default`,
        [people.teamLead],
      ),
    ).rejects.toThrow(/department_id/);
  });

  it('moves somebody between teams as an ordinary edit', async () => {
    const audit = await emptyDepartment();
    const created = await employees.create(JOINER);

    const moved = await employees.update(created.id, { departmentId: audit.id });

    expect(moved.departmentId).toBe(audit.id);
    // The move is the only thing that moved. Their line manager is unchanged,
    // because reporting to somebody and sitting in a team are different facts.
    expect(moved.managerId).toBe(people.teamLead);
  });

  it('gives every one of the fixture organisation a team', async () => {
    // The assertion the story is about: a headcount by department adds up to the
    // whole company, with nobody quietly missing from every team's figures.
    const all = await employees.list();
    const byTeam = await Promise.all(
      (await departments.list()).map(async (team) => ({
        team: team.name,
        headcount: await departments.headcount(team.id),
      })),
    );

    const counted = byTeam.reduce((total, team) => total + team.headcount, 0);
    const stillEmployed = all.filter((one) => one.employmentStatus !== 'TERMINATED').length;

    expect(counted).toBe(stillEmployed);
    expect(all.every((one) => one.departmentId !== null)).toBe(true);
  });

  describe('a team that has been closed', () => {
    it('takes nobody new', async () => {
      const audit = await emptyDepartment();
      await departments.deactivate(audit.id);

      await expect(employees.create({ ...JOINER, departmentId: audit.id })).rejects.toBeInstanceOf(
        DepartmentDeactivated,
      );
    });

    it('takes nobody by transfer either', async () => {
      const audit = await emptyDepartment();
      await departments.deactivate(audit.id);
      const created = await employees.create(JOINER);

      await expect(employees.update(created.id, { departmentId: audit.id })).rejects.toBeInstanceOf(
        DepartmentDeactivated,
      );

      expect((await employees.byId(created.id)).departmentId).toBe(operations.id);
    });

    it('still takes a leaver, so history can be imported', async () => {
      // Somebody who left in 2024, in a team that was wound up in 2025. Refusing
      // this would make the history unimportable, and a leaver raises nothing
      // that has to appear under a team heading.
      const audit = await emptyDepartment();
      await departments.deactivate(audit.id);

      const imported = await employees.create({
        ...JOINER,
        departmentId: audit.id,
        employmentStatus: 'TERMINATED',
        startDate: '2024-01-08',
        exitDate: '2025-06-30',
      });

      expect(imported.departmentId).toBe(audit.id);
    });

    it('refuses to take that leaver back if they are reinstated', async () => {
      /* The one path into an employed person sitting in a closed team, and the
         only one nothing else covers: nobody edits their department when the
         team closes, so no write-time check ever runs on their record. */
      const audit = await emptyDepartment();
      const created = await employees.create({ ...JOINER, departmentId: audit.id });
      await employees.terminate(created.id, { exitDate: '2026-12-31' });
      await departments.deactivate(audit.id);

      await expect(
        employees.update(created.id, { employmentStatus: 'ACTIVE', exitDate: null }),
      ).rejects.toBeInstanceOf(DepartmentDeactivated);
    });

    it('lets that reinstatement through once they are given an open team', async () => {
      // Both halves in one edit, which is what an HR officer would actually do.
      const audit = await emptyDepartment();
      const created = await employees.create({ ...JOINER, departmentId: audit.id });
      await employees.terminate(created.id, { exitDate: '2026-12-31' });
      await departments.deactivate(audit.id);

      const back = await employees.update(created.id, {
        employmentStatus: 'ACTIVE',
        exitDate: null,
        departmentId: operations.id,
      });

      expect(back.employmentStatus).toBe('ACTIVE');
      expect(back.departmentId).toBe(operations.id);
    });
  });
});

describe('a reporting line never loops, FR 03', () => {
  /**
   * The seeded branch, top to bottom, which every case here bends into a loop:
   *
   *   Kwame -> Yaw -> Akosua -> Kofi -> Adwoa, and Kofi -> Abena as well.
   *
   * The unit suite covers the judgement. What needs a database is the walk, and
   * the deferred trigger that catches what the walk never sees: a bulk import, a
   * migration correcting data, a person in psql.
   */

  /** Whatever the loop is, the branch it was bent out of is unchanged afterwards. */
  async function managerOf(id: string): Promise<string | null> {
    return (await employees.byId(id)).managerId;
  }

  describe('the walk, from the proposed manager upward', () => {
    it('refuses a loop between two people', async () => {
      // Kofi given Adwoa, who already reports to him.
      await expect(
        employees.update(people.teamLead, { managerId: people.officer }),
      ).rejects.toBeInstanceOf(ManagerCycle);

      expect(await managerOf(people.teamLead)).toBe(people.opsManager);
    });

    it('refuses a three level loop, and names the person in the middle', async () => {
      // Akosua -> Kofi -> Adwoa -> Akosua. Neither end of it is directly related
      // to the other, so nothing short of the walk finds this.
      let thrown: unknown;
      try {
        await employees.update(people.opsManager, { managerId: people.officer });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ManagerCycle);
      expect((thrown as ManagerCycle).loop.map((one) => one.employeeNumber)).toEqual([
        'RH-0011',
        'RH-0010',
        'RH-0007',
      ]);
      // Kofi is the person HR has to look at, and he is in neither of the two
      // records being edited.
      expect((thrown as Error).message).toContain('Kofi Boateng (RH-0010)');
    });

    it('refuses inverting the organisation onto the head of it', async () => {
      await expect(
        employees.update(people.ceo, { managerId: people.officer }),
      ).rejects.toBeInstanceOf(ManagerCycle);

      expect(await managerOf(people.ceo)).toBeNull();
    });

    it('still allows a move that only looks like one, across branches', async () => {
      // Abena under Adwoa. Both are Kofi's reports, so the line gets one level
      // longer and still terminates at Kwame.
      const moved = await employees.update(people.partTimer, { managerId: people.officer });

      expect(moved.managerId).toBe(people.officer);
    });

    it('still allows a move up the line the employee is already on', async () => {
      // Adwoa from Kofi to Akosua, who is above Kofi. Walking up from Akosua
      // never reaches Adwoa, because Adwoa is below the branch, not on it.
      const moved = await employees.update(people.officer, { managerId: people.opsManager });

      expect(moved.managerId).toBe(people.opsManager);
    });

    it('walks a line that already loops without going round it for ever', async () => {
      // A table restored from a dump taken before the trigger existed. Without
      // the CYCLE clause this is the query that never returns, and the check for
      // cycles is the thing that hangs on one.
      await admin.query('ALTER TABLE employee DISABLE TRIGGER employee_no_manager_cycle');
      try {
        await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
          people.officer,
          people.teamLead,
        ]);
      } finally {
        // Restored here rather than after the assertion, so a failing
        // expectation cannot leave the trigger off for every test below.
        await admin.query('ALTER TABLE employee ENABLE TRIGGER employee_no_manager_cycle');
      }

      const chain = await repository.chainFrom(people.officer);

      // Adwoa, Kofi, and then it stops rather than starting round again.
      expect(chain.map((one) => one.employeeNumber)).toEqual(['RH-0011', 'RH-0010']);
    });
  });

  describe('the database, for the changes that never reach the walk', () => {
    it('blocks self reference, as a rule about the row itself', async () => {
      // A CHECK from the organisation migration, so it is evaluated as part of
      // writing the row rather than at commit, and it names itself. The cycle
      // trigger would find this too; the one that gets there first and says more
      // is the one that should.
      await expect(
        admin.query("UPDATE employee SET manager_id = id WHERE employee_number = 'RH-0011'"),
      ).rejects.toThrow(/employee_not_own_manager/);
    });

    it('refuses a three level loop written straight past the service', async () => {
      await expect(
        admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
          people.officer,
          people.opsManager,
        ]),
      ).rejects.toMatchObject({ constraint: 'employee_no_manager_cycle' });

      expect(await managerOf(people.opsManager)).toBe(people.opsDirector);
    });

    it('reports the refusal as an integrity violation, not a crash', async () => {
      // check_violation, so a caller can tell a refused line from a genuine
      // fault by SQLSTATE rather than by reading the message text.
      await expect(
        admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
          people.officer,
          people.opsManager,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'employee_no_manager_cycle' });
    });

    it('refuses two people inserted into a loop by a single statement', async () => {
      // The reason INSERT is covered as well as UPDATE. A foreign key is itself
      // an AFTER ROW trigger that fires at the end of the statement, so these
      // two satisfy it by naming each other, and only the cycle trigger stops
      // them.
      await expect(
        admin.query(
          `INSERT INTO employee (
             id, employee_number, first_name, last_name, work_email,
             department_id, work_pattern_id, start_date, manager_id
           ) VALUES
             (900001, 'RH-0900', 'Loop', 'One', 'loop.one@rematholdings.com',
              $1, (SELECT id FROM work_pattern WHERE is_default), DATE '2026-09-01', 900002),
             (900002, 'RH-0901', 'Loop', 'Two', 'loop.two@rematholdings.com',
              $1, (SELECT id FROM work_pattern WHERE is_default), DATE '2026-09-01', 900001)`,
          [operations.id],
        ),
      ).rejects.toMatchObject({ constraint: 'employee_no_manager_cycle' });
    });
  });

  describe('a bulk import, which goes through no service at all', () => {
    it('is refused when it ends in a loop, at the point it commits', async () => {
      // Two reparents, each unremarkable on its own, that between them close a
      // loop. This is the shape the acceptance criteria means by bulk import,
      // and the point of the test is *where* it fails.
      await admin.query('BEGIN');

      await expect(
        admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
          people.partTimer,
          people.officer,
        ]),
      ).resolves.toBeDefined();

      await expect(
        admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
          people.officer,
          people.partTimer,
        ]),
      ).resolves.toBeDefined();

      // Neither statement failed. The trigger is deferred, so the refusal
      // arrives here, against the state that would actually have been stored.
      await expect(admin.query('COMMIT')).rejects.toMatchObject({
        constraint: 'employee_no_manager_cycle',
      });

      expect(await managerOf(people.officer)).toBe(people.teamLead);
      expect(await managerOf(people.partTimer)).toBe(people.teamLead);
    });

    it('is allowed when it only passes through a loop on the way', async () => {
      // Akosua and Kofi swapping places. Whichever row is written first leaves a
      // loop standing until the other one is written, so a per row trigger would
      // refuse a restructure whose final state is a perfectly good tree. This is
      // what the deferral buys, and it is why it is a CONSTRAINT TRIGGER.
      await admin.query('BEGIN');
      await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
        people.teamLead,
        people.opsManager,
      ]);
      await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
        people.opsDirector,
        people.teamLead,
      ]);
      await expect(admin.query('COMMIT')).resolves.toBeDefined();

      expect(await managerOf(people.teamLead)).toBe(people.opsDirector);
      expect(await managerOf(people.opsManager)).toBe(people.teamLead);
    });

    it('leaves the fixture organisation loop free, which the seed itself proves', async () => {
      // The seed loads thirteen people in one transaction, so every one of those
      // rows is walked at its commit. That it loads at all is the assertion.
      await expect(seed(admin)).resolves.toBeDefined();

      expect(await employees.reportingLineWarnings()).toEqual([]);
    });
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
