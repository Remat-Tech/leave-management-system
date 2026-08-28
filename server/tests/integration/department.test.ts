import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  DepartmentNotFound,
  DepartmentStillStaffed,
  DuplicateDepartmentName,
  InvalidDepartment,
} from '../../src/domain/department.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { DepartmentService } from '../../src/services/department-service.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * Departments against a real database. LMS 105.
 *
 * The unit suite covers the rules. What needs a database is everything the
 * database itself decides: that the name really is unique and really is compared
 * without regard to case, that updated_at moves on an edit, that the application
 * role can no longer delete one, and that the foreign key holds a department
 * anybody is in.
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
const system = theSystem('department integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let departments: DepartmentService;
let employees: EmployeeService;
let people: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  departments = new DepartmentService(new DepartmentRepository(db), guard);
  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    { domains: DOMAINS },
  );
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/** Operations, which most of the fixture organisation is in. */
async function operations() {
  const found = await departments.byName(system, 'Operations');
  expect(found).toBeDefined();
  return found!;
}

describe('creating a department', () => {
  it('stores the name and reads it back, open and empty', async () => {
    const created = await departments.create(system, { name: 'Internal Audit' });

    const readBack = await departments.byId(system, created.id);

    expect(readBack).toMatchObject({ name: 'Internal Audit', isActive: true, parentId: null });
    expect(await departments.headcount(system, created.id)).toBe(0);
  });

  it('refuses a second department with the same name', async () => {
    await expect(departments.create(system, { name: 'Operations' })).rejects.toBeInstanceOf(
      DuplicateDepartmentName,
    );
  });

  it('treats a name differing only in case as the same department', async () => {
    // Two rows of Operations is two sets of figures for one team, found when
    // they disagree.
    await expect(departments.create(system, { name: 'operations' })).rejects.toBeInstanceOf(
      DuplicateDepartmentName,
    );
  });

  it('keeps the name in the shape it was typed', async () => {
    const created = await departments.create(system, { name: 'Internal  Audit' });

    expect(created.name).toBe('Internal  Audit');
  });

  it('refuses the duplicate at the database, not merely in the code', async () => {
    // Straight past the service, as the seed or a data fixing migration would
    // go. The unique index is what makes this a fact rather than a convention.
    await expect(
      admin.query("INSERT INTO department (name) VALUES ('OPERATIONS')"),
    ).rejects.toThrow(/department_name_unique/);
  });

  it('refuses a name that is present but blank, at the database', async () => {
    await expect(admin.query("INSERT INTO department (name) VALUES ('   ')")).rejects.toThrow(
      /department_name_not_blank/,
    );
  });

  it('refuses a blank name before the write, and says which field', async () => {
    await expect(departments.create(system, { name: '  ' })).rejects.toBeInstanceOf(
      InvalidDepartment,
    );
  });

  it('finds one by name whatever case it is asked in', async () => {
    const found = await departments.byName(system, 'OPERATIONS');

    expect(found?.name).toBe('Operations');
  });
});

describe('editing a department', () => {
  it('renames one without moving the id anybody points at', async () => {
    const before = await operations();

    const renamed = await departments.update(system, before.id, { name: 'Operations & Logistics' });

    expect(renamed.name).toBe('Operations & Logistics');
    // The point of renaming rather than replacing: every employee record still
    // points at the same row, so nobody's team changed underneath them.
    expect(renamed.id).toBe(before.id);
    expect(await departments.headcount(system, before.id)).toBeGreaterThan(0);
  });

  it('moves updated_at, so a record says when it last changed', async () => {
    const before = await operations();

    const renamed = await departments.update(system, before.id, { name: 'Operations & Logistics' });

    // The department_set_updated_at trigger does this, attached to the same
    // set_updated_at() the employee table uses.
    expect(renamed.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(renamed.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it('refuses renaming one onto a name that already belongs to another', async () => {
    const before = await operations();

    await expect(departments.update(system, before.id, { name: 'finance' })).rejects.toBeInstanceOf(
      DuplicateDepartmentName,
    );
  });

  it('says so plainly when there is no such department', async () => {
    await expect(departments.update(system, '999999', { name: 'Nobody' })).rejects.toBeInstanceOf(
      DepartmentNotFound,
    );
  });
});

describe('deactivating a department', () => {
  it('refuses while people are still in it, and says how many', async () => {
    const ops = await operations();
    const headcount = await departments.headcount(system, ops.id);

    let thrown: unknown;
    try {
      await departments.deactivate(system, ops.id);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DepartmentStillStaffed);
    expect((thrown as DepartmentStillStaffed).headcount).toBe(headcount);
    expect((await departments.byId(system, ops.id)).isActive).toBe(true);
  });

  it('allows it once everybody has been moved out', async () => {
    const audit = await departments.create(system, { name: 'Internal Audit' });
    const moved = await employees.update(system, people.engineer, { departmentId: audit.id });
    expect(moved.departmentId).toBe(audit.id);

    // Still staffed, by exactly the one person just moved in.
    await expect(departments.deactivate(system, audit.id)).rejects.toBeInstanceOf(
      DepartmentStillStaffed,
    );

    await employees.update(system, people.engineer, { departmentId: (await operations()).id });

    expect((await departments.deactivate(system, audit.id)).isActive).toBe(false);
  });

  it('does not count a leaver as somebody still in it', async () => {
    /* A leaver stays in the department they left from, because FR 06 keeps every
       other field of their record too. They are no bar to closing it: they are
       not going to raise a request that has to appear under a team heading. */
    const audit = await departments.create(system, { name: 'Internal Audit' });
    await employees.update(system, people.leaver, { departmentId: audit.id });

    expect(await departments.headcount(system, audit.id)).toBe(0);
    expect((await departments.deactivate(system, audit.id)).isActive).toBe(false);
  });

  it('is not a delete: the row, the name and everybody in it stay', async () => {
    const audit = await departments.create(system, { name: 'Internal Audit' });
    await departments.deactivate(system, audit.id);

    const closed = await departments.byId(system, audit.id);

    expect(closed.name).toBe('Internal Audit');
    expect(closed.isActive).toBe(false);
    // The name stays reserved, so reopening is what happens rather than a second
    // row of the same team appearing beside it.
    await expect(departments.create(system, { name: 'Internal Audit' })).rejects.toBeInstanceOf(
      DuplicateDepartmentName,
    );
  });

  it('leaves it out of the list an HR officer picks from, and in the full one', async () => {
    const audit = await departments.create(system, { name: 'Internal Audit' });
    await departments.deactivate(system, audit.id);

    const all = await departments.list(system);
    const open = await departments.list(system, { openOnly: true });

    expect(all.map((one) => one.name)).toContain('Internal Audit');
    expect(open.map((one) => one.name)).not.toContain('Internal Audit');
    expect(all.length).toBe(open.length + 1);
  });

  it('can be undone, because the record is still there to undo', async () => {
    const audit = await departments.create(system, { name: 'Internal Audit' });
    await departments.deactivate(system, audit.id);

    const reopened = await departments.reactivate(system, audit.id);

    expect(reopened.isActive).toBe(true);
    // Same team, same id. Nothing that pointed at it was ever orphaned.
    expect(reopened.id).toBe(audit.id);
    expect(reopened.createdAt.getTime()).toBe(audit.createdAt.getTime());
  });

  it('says so plainly when there is no such department', async () => {
    await expect(departments.deactivate(system, '999999')).rejects.toBeInstanceOf(
      DepartmentNotFound,
    );
    await expect(departments.reactivate(system, '999999')).rejects.toBeInstanceOf(
      DepartmentNotFound,
    );
  });
});

describe('a department is deactivated rather than deleted', () => {
  it('gives the application role no way to delete one', async () => {
    // The organisation migration granted DELETE before anything used the table.
    // The department-rules migration took it back, because the story names
    // deactivation as the ending a department has.
    const { rows } = await admin.query<{ del: boolean; upd: boolean; ins: boolean }>(
      `SELECT has_table_privilege('lms_app', 'department', 'DELETE') AS del,
              has_table_privilege('lms_app', 'department', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'department', 'INSERT') AS ins`,
    );

    expect(rows[0]).toEqual({ del: false, upd: true, ins: true });
  });

  it('refuses to delete one that anybody is in, on the owner connection too', async () => {
    /* Deliberately weaker than employee, which refuses every delete outright.
       Here the foreign key is what protects the case that matters, and it
       protects it from everybody: a department nobody has ever been in is a typo
       worth being able to remove from the owner connection. */
    const ops = await operations();

    await expect(admin.query('DELETE FROM department WHERE id = $1', [ops.id])).rejects.toThrow(
      /employee_department_id_fkey/,
    );
  });
});
