import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  ASSIGNABLE_ROLES,
  LastSystemAdministrator,
  ROLE_CODES,
  RoleCannotBeRevoked,
  RoleNotHeld,
  UnknownRole,
} from '../../src/auth/roles.js';
import { MANDATORY_ROLES } from '../../src/auth/mfa.js';
import { SignInAccountNotFound } from '../../src/auth/sign-in.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { RoleRepository } from '../../src/repositories/role-repository.js';
import { SignInAccountRepository } from '../../src/repositories/sign-in-account-repository.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { RoleService } from '../../src/services/role-service.js';
import { SignInService } from '../../src/services/sign-in-service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * Roles and role assignment, against a real database. §5.3, LMS 111.
 *
 * The unit suite covers the rules. What needs a database is everything the
 * database itself decides, and it decides most of this story:
 *
 *   That the four roles really are the four, held closed by a CHECK rather than
 *   by everybody remembering, and that MANAGER cannot be inserted by anything.
 *
 *   That every login is an employee from the moment it exists — including in a
 *   production database, which is migrated and never seeded — and that nothing
 *   can take that away.
 *
 *   That the last System Administrator cannot be removed, including by two
 *   people removing the other one at the same moment.
 *
 *   That being a manager is derived from the reporting lines every time it is
 *   asked, and that moving a line moves the answer with it.
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
const system = theSystem('role integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let roles: RoleService;
let logins: SignInService;
let employees: EmployeeService;
let people: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const accounts = new SignInAccountRepository(db);
  const roleRepository = new RoleRepository(db);
  const employeeRepository = new EmployeeRepository(db);

  roles = new RoleService(roleRepository, accounts, employeeRepository, guard);
  logins = new SignInService(
    accounts,
    employeeRepository,
    roleRepository,
    recordingMailer(),
    guard,
    {
      domains: DOMAINS,
    },
  );
  employees = new EmployeeService(
    employeeRepository,
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

/** Runs statements in one transaction on the owner connection. */
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

/** Whatever a call threw, having asserted that it threw. */
async function rejection(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    return error as Error;
  }

  throw new Error('Expected the call to be refused, and it was not.');
}

describe('the roles that exist', () => {
  it('is the four the story names, seeded and nothing else', async () => {
    // The story's first criterion.
    const seeded = await roles.list(system);

    expect(seeded.map((role) => role.code)).toEqual([
      'EMPLOYEE',
      'HR_ADMIN',
      'HR_OFFICER',
      'SYS_ADMIN',
    ]);
    expect(seeded.map((role) => role.name)).toContain('HR Administrator');
    expect(seeded.map((role) => role.name)).toContain('System Administrator');
  });

  it('holds the same set the code does', async () => {
    /* Three lists have to agree: ROLE_CODES, the role_code_known constraint, and
       the rows the organisation migration seeded. Adding a role in one place and
       forgetting the others fails here rather than in production. */
    const seeded = (await roles.list(system)).map((role) => role.code).sort();

    expect(seeded).toEqual([...ROLE_CODES].sort());
  });

  it('refuses a fifth role, whatever is writing', async () => {
    // A role the authorisation layer has never heard of grants nothing, and a row
    // that silently grants nothing is worse than a refusal.
    await expect(
      admin.query(`INSERT INTO role (code, name) VALUES ('PAYROLL_ADMIN', 'Payroll')`),
    ).rejects.toThrow(/role_code_known/);
  });

  it('refuses MANAGER outright', async () => {
    /* The story's third criterion, held by the database rather than by the
       comment the organisation migration left. Nothing can insert it now,
       including a migration written by somebody who has not read the comment. */
    await expect(
      admin.query(`INSERT INTO role (code, name) VALUES ('MANAGER', 'Manager')`),
    ).rejects.toThrow(/role_code_known/);
  });

  it('is read only to the application', async () => {
    // Reference data. The CHECK stops an unknown code; withholding the privilege
    // is what stops a fifth row saying HR_ADMIN twice.
    const { rows } = await admin.query<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }>(
      `SELECT has_table_privilege('lms_app', 'role', 'INSERT') AS ins,
              has_table_privilege('lms_app', 'role', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'role', 'DELETE') AS del,
              has_table_privilege('lms_app', 'role', 'SELECT') AS sel`,
    );

    expect(rows[0].sel).toBe(true);
    expect(rows[0].ins).toBe(false);
    expect(rows[0].upd).toBe(false);
    expect(rows[0].del).toBe(false);
  });

  it('lets the application grant and take away a role', async () => {
    const { rows } = await admin.query<{ ins: boolean; del: boolean }>(
      `SELECT has_table_privilege('lms_app', 'user_role', 'INSERT') AS ins,
              has_table_privilege('lms_app', 'user_role', 'DELETE') AS del`,
    );

    expect(rows[0].ins).toBe(true);
    expect(rows[0].del).toBe(true);
  });
});

describe('assigning a role', () => {
  it('gives somebody a role and gives back what they now hold', async () => {
    // The story's second criterion.
    const held = await roles.grant(system, people.officer, 'HR_OFFICER');

    expect(held).toEqual(['EMPLOYEE', 'HR_OFFICER']);
  });

  it('records when it was granted', async () => {
    const before = new Date();
    await roles.grant(system, people.officer, 'HR_OFFICER');

    const grants = await roles.forEmployee(system, people.officer);
    const officer = grants.find((grant) => grant.code === 'HR_OFFICER');

    // "Who has HR powers and since when" is the review this story exists for.
    expect(officer?.grantedAt).toBeInstanceOf(Date);
    expect(officer!.grantedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('orders what somebody holds from least to most power', async () => {
    await roles.grant(system, people.officer, 'SYS_ADMIN');
    const held = await roles.grant(system, people.officer, 'HR_OFFICER');

    // Alphabetically SYS_ADMIN would come last anyway; HR_ADMIN before
    // HR_OFFICER is where an alphabetical order goes wrong.
    await roles.grant(system, people.officer, 'HR_ADMIN');

    expect(held).toEqual(['EMPLOYEE', 'HR_OFFICER', 'SYS_ADMIN']);
    expect(await roles.grant(system, people.officer, 'HR_ADMIN')).toEqual([
      'EMPLOYEE',
      'HR_OFFICER',
      'HR_ADMIN',
      'SYS_ADMIN',
    ]);
  });

  it('is not upset by granting the same role twice', async () => {
    /* Two HR officers doing the same sensible thing, or one clicking twice. The
       state afterwards is the state that was wanted either way. */
    await roles.grant(system, people.officer, 'HR_OFFICER');
    const held = await roles.grant(system, people.officer, 'HR_OFFICER');

    expect(held).toEqual(['EMPLOYEE', 'HR_OFFICER']);
  });

  it('survives two people granting the same role at the same moment', async () => {
    const results = await Promise.all([
      roles.grant(system, people.officer, 'HR_OFFICER'),
      roles.grant(system, people.officer, 'HR_OFFICER'),
      roles.grant(system, people.officer, 'HR_OFFICER'),
    ]);

    for (const held of results) {
      expect(held).toContain('HR_OFFICER');
    }
  });

  it('refuses a role that is not one', async () => {
    await expect(roles.grant(system, people.officer, 'PAYROLL_ADMIN')).rejects.toThrow(UnknownRole);
  });

  it('refuses MANAGER, and says where being a manager actually comes from', async () => {
    const error = await rejection(() => roles.grant(system, people.teamLead, 'MANAGER'));

    expect(error).toBeInstanceOf(UnknownRole);
    expect(error.message).toMatch(/who reports to whom/i);
  });

  it('refuses to grant the baseline, which everybody already has', async () => {
    await expect(roles.grant(system, people.officer, 'EMPLOYEE')).rejects.toThrow(
      RoleCannotBeRevoked,
    );
  });

  it('refuses an employee who is nobody', async () => {
    await expect(roles.grant(system, '999999', 'HR_OFFICER')).rejects.toThrow(EmployeeNotFound);
  });

  it('says plainly when somebody has no login to give a role to', async () => {
    /* "She has no roles" and "she has no login" are different problems and want
       different answers: one needs a role granting, the other needs the account
       provisioning first. */
    const officer = await employees.byId(system, people.officer);
    const joiner = await employees.create(system, {
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      departmentId: officer.departmentId,
      managerId: officer.managerId,
      startDate: '2026-09-01',
    });

    const error = await rejection(() => roles.grant(system, joiner.id, 'HR_OFFICER'));

    expect(error).toBeInstanceOf(SignInAccountNotFound);
    expect(error.message).toContain('Esi Nyarko');
    expect(error.message).toMatch(/no login yet/i);
  });
});

describe('taking a role away', () => {
  it('removes it and gives back what is left', async () => {
    await roles.grant(system, people.officer, 'HR_OFFICER');

    expect(await roles.revoke(system, people.officer, 'HR_OFFICER')).toEqual(['EMPLOYEE']);
  });

  it('refuses when they never held it', async () => {
    /* The opposite of what granting twice does, and deliberately. Granting twice
       leaves the same person with the same power; revoking something they never
       had means the person doing it has somebody else in mind. */
    await expect(roles.revoke(system, people.officer, 'HR_ADMIN')).rejects.toThrow(RoleNotHeld);
  });

  it('never takes away the baseline', async () => {
    const error = await rejection(() => roles.revoke(system, people.officer, 'EMPLOYEE'));

    expect(error).toBeInstanceOf(RoleCannotBeRevoked);
    expect(error.message).toMatch(/close their account/i);
  });

  it('refuses the baseline whatever is writing', async () => {
    // The service refuses it before any statement runs. This is the other half:
    // a direct DELETE is refused too.
    await expect(
      admin.query(
        `DELETE FROM user_role ur USING app_user u, role r
          WHERE ur.user_id = u.id AND ur.role_id = r.id
            AND u.employee_id = ${people.officer} AND r.code = 'EMPLOYEE'`,
      ),
    ).rejects.toThrow(/cannot be taken away/i);
  });
});

describe('the last System Administrator', () => {
  it('cannot be removed', async () => {
    await roles.grant(system, people.headOfHr, 'SYS_ADMIN');

    const error = await rejection(() => roles.revoke(system, people.headOfHr, 'SYS_ADMIN'));

    expect(error).toBeInstanceOf(LastSystemAdministrator);
    expect(error.message).toMatch(/give somebody else the role first/i);
  });

  it('can be removed once somebody else holds it', async () => {
    await roles.grant(system, people.headOfHr, 'SYS_ADMIN');
    await roles.grant(system, people.ceo, 'SYS_ADMIN');

    expect(await roles.revoke(system, people.headOfHr, 'SYS_ADMIN')).not.toContain('SYS_ADMIN');
  });

  it('is refused by the database as well, which is what settles a race', async () => {
    /* Between the service's count and its delete, another transaction can remove
       the other administrator. The trigger is what makes the answer right when two
       people are clicking at once. */
    await roles.grant(system, people.headOfHr, 'SYS_ADMIN');

    await expect(
      inTransaction(
        `DELETE FROM user_role ur USING role r
          WHERE ur.role_id = r.id AND r.code = 'SYS_ADMIN'`,
      ),
    ).rejects.toThrow(/leave nobody holding SYS_ADMIN/i);
  });

  it('names itself, so the repository can tell it from any other refusal', async () => {
    /* The constraint name travels in the error's own field rather than in the
       message, which is what lets the repository translate it into
       LastSystemAdministrator without matching on prose. */
    await roles.grant(system, people.headOfHr, 'SYS_ADMIN');

    const error = (await rejection(() =>
      inTransaction(
        `DELETE FROM user_role ur USING role r
          WHERE ur.role_id = r.id AND r.code = 'SYS_ADMIN'`,
      ),
    )) as Error & { constraint?: string };

    expect(error.constraint).toBe('user_role_keeps_a_system_administrator');
  });

  it('lets the role be handed on in one transaction, in either order', async () => {
    /* Deferred, so a revoke followed by a grant passes through nobody holding it
       and is judged only on the state that will actually be stored. Checked per
       statement, this would refuse the very operation it exists to protect. */
    await roles.grant(system, people.headOfHr, 'SYS_ADMIN');

    await expect(
      inTransaction(
        `DELETE FROM user_role ur USING role r, app_user u
          WHERE ur.role_id = r.id AND ur.user_id = u.id
            AND r.code = 'SYS_ADMIN' AND u.employee_id = ${people.headOfHr}`,
        `INSERT INTO user_role (user_id, role_id)
         SELECT u.id, r.id FROM app_user u, role r
          WHERE u.employee_id = ${people.ceo} AND r.code = 'SYS_ADMIN'`,
      ),
    ).resolves.toBeUndefined();

    expect(await roles.forEmployee(system, people.ceo)).toContainEqual(
      expect.objectContaining({ code: 'SYS_ADMIN' }),
    );
  });

  it('does not stop a database that has none from getting its first', async () => {
    /* The rule is "do not go from some to none", not "always have one", and those
       differ exactly at the beginning. A freshly migrated production database has
       no logins at all. */
    expect(await roles.holdersOf(system, 'SYS_ADMIN')).toEqual([]);

    await roles.grant(system, people.ceo, 'SYS_ADMIN');

    expect((await roles.holdersOf(system, 'SYS_ADMIN')).map((employee) => employee.id)).toEqual([
      people.ceo,
    ]);
  });
});

describe('every login is an employee', () => {
  it('grants the baseline as the login is created, not as the fixtures are loaded', async () => {
    /* The gap this closed: production is migrated and never seeded, so before
       LMS 111 the first login SignInService provisioned held no roles at all. */
    const officer = await employees.byId(system, people.officer);
    const joiner = await employees.create(system, {
      employeeNumber: 'RH-0101',
      firstName: 'Yaw',
      lastName: 'Boakye',
      workEmail: 'yaw.boakye@rematholdings.com',
      departmentId: officer.departmentId,
      managerId: officer.managerId,
      startDate: '2026-09-01',
    });

    await logins.provision(system, joiner.id);

    expect(await roles.forEmployee(system, joiner.id)).toEqual([
      expect.objectContaining({ code: 'EMPLOYEE' }),
    ]);
  });

  it('grants it to a login created by anything at all', async () => {
    // Whatever creates a login creates an employee, service or not.
    const officer = await employees.byId(system, people.officer);
    const joiner = await employees.create(system, {
      employeeNumber: 'RH-0102',
      firstName: 'Yaa',
      lastName: 'Asantewaa',
      workEmail: 'yaa.asantewaa@rematholdings.com',
      departmentId: officer.departmentId,
      managerId: officer.managerId,
      startDate: '2026-09-01',
    });

    await admin.query('INSERT INTO app_user (employee_id, company_email) VALUES ($1, $2)', [
      joiner.id,
      'yaa.asantewaa@rematholdings.com',
    ]);

    expect(await roles.forEmployee(system, joiner.id)).toEqual([
      expect.objectContaining({ code: 'EMPLOYEE' }),
    ]);
  });

  it('gives everybody in the fixture set exactly one baseline row', async () => {
    // The seed no longer grants EMPLOYEE itself. If both it and the trigger did,
    // this is where the duplicate would show.
    const { rows } = await admin.query<{ logins: string; baselines: string }>(
      `SELECT (SELECT count(*) FROM app_user) AS logins,
              (SELECT count(*) FROM user_role ur JOIN role r ON r.id = ur.role_id
                WHERE r.code = 'EMPLOYEE') AS baselines`,
    );

    expect(rows[0].baselines).toBe(rows[0].logins);
  });
});

describe('being a manager is not a role', () => {
  it('is true of somebody who has reports', async () => {
    // The story's third criterion, from the other side: derived, every time.
    expect(await roles.isManager(system, people.teamLead)).toBe(true);
  });

  it('is false of somebody who has none', async () => {
    expect(await roles.isManager(system, people.officer)).toBe(false);
  });

  it('never appears among the roles they hold', async () => {
    const authority = await roles.authorityFor(system, people.teamLead);

    expect(authority.isManager).toBe(true);
    expect(authority.roles).not.toContain('MANAGER');
    expect(authority.roles).toEqual(['EMPLOYEE']);
  });

  it('follows the reporting line the moment it moves', async () => {
    /* Nobody grants it and nobody revokes it. Moving a line moves the answer,
       which is exactly what a stored role could not do without something
       remembering to update it. */
    expect(await roles.isManager(system, people.officer)).toBe(false);

    await employees.update(system, people.partTimer, { managerId: people.officer });

    expect(await roles.isManager(system, people.officer)).toBe(true);
  });

  it('stops being true when the last report moves away', async () => {
    await employees.update(system, people.partTimer, { managerId: people.officer });
    expect(await roles.isManager(system, people.officer)).toBe(true);

    await employees.update(system, people.partTimer, { managerId: people.teamLead });

    expect(await roles.isManager(system, people.officer)).toBe(false);
  });

  it('refuses an employee who is nobody', async () => {
    await expect(roles.isManager(system, '999999')).rejects.toThrow(EmployeeNotFound);
  });
});

describe('reviewing who holds what', () => {
  it('lists everybody holding a role, in employee number order', async () => {
    const holders = await roles.holdersOf(system, 'HR_ADMIN');

    expect(holders.map((employee) => employee.id)).toEqual([people.headOfHr]);
  });

  it('gives an empty list for a role nobody holds', async () => {
    expect(await roles.holdersOf(system, 'SYS_ADMIN')).toEqual([]);
  });

  it('refuses to look up a role that is not one', async () => {
    await expect(roles.holdersOf(system, 'MANAGER')).rejects.toThrow(UnknownRole);
  });

  it('offers the three that are a choice', () => {
    expect(roles.assignable()).toEqual([...ASSIGNABLE_ROLES]);
  });
});

describe('what the roles are for', () => {
  it('makes the one time code mandatory the moment an HR role is granted', async () => {
    /* LMS 110 reads roles at sign in rather than copying them, and this is the
       other end of that: granting through this service is enough, with nothing
       else to update. */
    expect(await logins.codePolicyFor(system, people.officer)).toEqual({
      required: false,
      mandatory: false,
    });

    await roles.grant(system, people.officer, 'HR_OFFICER');

    expect(await logins.codePolicyFor(system, people.officer)).toEqual({
      required: true,
      mandatory: true,
    });
  });

  it('stops requiring it when the role goes', async () => {
    await roles.grant(system, people.officer, 'HR_OFFICER');
    await roles.revoke(system, people.officer, 'HR_OFFICER');

    expect(await logins.codePolicyFor(system, people.officer)).toEqual({
      required: false,
      mandatory: false,
    });
  });

  it('makes it mandatory for exactly the three roles that see everybody', async () => {
    /* The CEO holds SYS_ADMIN throughout, so that taking it off the officer below
       is not the last administrator being removed — which is a different rule and
       would refuse before this one could be tested. */
    await roles.grant(system, people.ceo, 'SYS_ADMIN');

    for (const code of MANDATORY_ROLES) {
      await roles.grant(system, people.officer, code);
      expect((await logins.codePolicyFor(system, people.officer)).mandatory).toBe(true);
      await roles.revoke(system, people.officer, code);
    }

    // And the baseline, which everybody has, makes it mandatory for nobody.
    expect((await logins.codePolicyFor(system, people.officer)).mandatory).toBe(false);
  });
});
