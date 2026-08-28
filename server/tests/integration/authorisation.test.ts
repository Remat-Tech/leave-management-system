import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { type Actor, theSystem } from '../../src/auth/actor.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../../src/auth/policy.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { RoleRepository } from '../../src/repositories/role-repository.js';
import { SignInAccountRepository } from '../../src/repositories/sign-in-account-repository.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { DepartmentService } from '../../src/services/department-service.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { RoleService } from '../../src/services/role-service.js';
import { type SignedIn, SignInService } from '../../src/services/sign-in-service.js';
import { WorkPatternService } from '../../src/services/work-pattern-service.js';
import { recordingDenials, type RecordingDenialLog } from '../support/recording-denials.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Records protected on the server. NFR SEC 02 and NFR SEC 03. §10. LMS 112.
 *
 * The unit suite covers the rules — server/tests/unit/policy.test.ts enumerates
 * every role against every action, which is possible because a policy is a pure
 * function. What needs a database is everything that suite cannot see:
 *
 *   That the services actually ask. A perfect policy nothing consults protects
 *   nothing, and the failure is silent — which is exactly the failure this
 *   story exists to prevent, one layer up.
 *
 *   That an actor is what signing in produces, with the roles and the reporting
 *   lines the database actually holds, rather than one a test wrote by hand.
 *
 *   That a record which is not there and a record you may not see give the same
 *   answer. That property spans a repository, a service and a policy, and no
 *   one of them can be asked about it alone.
 *
 *   That the refusals reach the log with the reason, and that no field of the
 *   record goes with them.
 *
 * The fixture organisation is what makes this readable. Adwoa reports to Kofi,
 * who reports to Akosua; Ama is the HR Administrator and Efua the HR Officer;
 * nobody in the seed holds SYS_ADMIN, which is itself worth knowing when
 * reading the role assignment cases below.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

const DOMAINS = ['rematholdings.com'];
const PASSWORD = 'a passphrase nobody guesses';

/** Adwoa Frimpong, Operations Officer. EMPLOYEE and nothing else. */
const OFFICER_EMAIL = 'adwoa.frimpong@rematholdings.com';
/** Kofi Boateng, Operations Team Lead. Adwoa reports to him; he holds no role. */
const TEAM_LEAD_EMAIL = 'kofi.boateng@rematholdings.com';
/** Efua Owusu, HR_OFFICER. */
const HR_OFFICER_EMAIL = 'efua.owusu@rematholdings.com';
/** Ama Mensah, HR_ADMIN. */
const HR_ADMIN_EMAIL = 'ama.mensah@rematholdings.com';

/**
 * The actor the fixtures are built by. See theSystem(): work nobody asked for.
 *
 * Everything this suite is actually about is done by an actor that came out of
 * signing in, which is the only way a person gets one.
 */
const system = theSystem('authorisation integration fixtures');

let db: Kysely<Database>;
let admin: Client;
let denials: RecordingDenialLog;
let guard: Guard;
let mailer: RecordingMailer;
let employees: EmployeeService;
let departments: DepartmentService;
let patterns: WorkPatternService;
let roles: RoleService;
let logins: SignInService;
let people: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  denials = recordingDenials();
  guard = new Guard(denials);
  mailer = recordingMailer();

  const accounts = new SignInAccountRepository(db);
  const employeeRepository = new EmployeeRepository(db);
  const roleRepository = new RoleRepository(db);

  employees = new EmployeeService(
    employeeRepository,
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    { domains: DOMAINS },
  );
  departments = new DepartmentService(new DepartmentRepository(db), guard);
  patterns = new WorkPatternService(new WorkPatternRepository(db), guard);
  roles = new RoleService(roleRepository, accounts, employeeRepository, guard);
  logins = new SignInService(accounts, employeeRepository, roleRepository, mailer, guard, {
    domains: DOMAINS,
  });
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
  denials.clear();
  mailer.clear();
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/**
 * Signs somebody in and hands back the actor the sign in produced.
 *
 * The whole point of the suite is that this is the only way an actor for a
 * person is made, so every case below goes through the door rather than
 * building an actor to suit itself. A test that could construct its own actor
 * would be testing a policy, not a system.
 *
 * It answers the one time code where one is asked for, which is how the HR
 * roles get in: LMS 110 makes a code mandatory for exactly the roles this story
 * gives the interesting powers to.
 */
async function signIn(email: string): Promise<Actor> {
  const outcome = await logins.signIn(email, PASSWORD);

  if (outcome.status === 'SIGNED_IN') {
    return outcome.actor;
  }

  const digits = /\b(\d{6})\b/.exec(mailer.last().text);
  expect(digits).not.toBeNull();

  const answered: SignedIn = await logins.submitCode(email, digits![1]);
  return answered.actor;
}

/** The seed gives everybody a login and nobody a password. */
async function withPasswords(...employeeIds: string[]): Promise<void> {
  for (const employeeId of employeeIds) {
    await logins.setPassword(system, employeeId, PASSWORD);
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

describe('the actor signing in produces', () => {
  it('carries the roles the database holds, read at the moment they sign in', async () => {
    await withPasswords(people.officer, people.hrOfficer);

    expect((await signIn(OFFICER_EMAIL)).roles).toEqual(['EMPLOYEE']);
    expect((await signIn(HR_OFFICER_EMAIL)).roles).toEqual(['EMPLOYEE', 'HR_OFFICER']);
  });

  it('carries a role granted a moment ago, because nothing is copied onto the account', async () => {
    /* The same property LMS 110 relies on for the mandatory code. Grant the role
       this morning and the next sign in has it, with nothing else to update. */
    await withPasswords(people.officer);
    expect((await signIn(OFFICER_EMAIL)).roles).toEqual(['EMPLOYEE']);

    await roles.grant(system, people.officer, 'HR_OFFICER');

    expect((await signIn(OFFICER_EMAIL)).roles).toContain('HR_OFFICER');
  });

  it('says who is a manager from the reporting lines, and never as a role', async () => {
    await withPasswords(people.officer, people.teamLead);

    const adwoa = await signIn(OFFICER_EMAIL);
    const kofi = await signIn(TEAM_LEAD_EMAIL);

    expect(adwoa.isManager).toBe(false);
    expect(kofi.isManager).toBe(true);
    expect(kofi.roles).toEqual(['EMPLOYEE']);
    expect(kofi.roles as string[]).not.toContain('MANAGER');
  });

  it('follows a reporting line that moves, with nothing to keep in step', async () => {
    await withPasswords(people.engineer);

    expect((await signIn('yram.kudjo@rematholdings.com')).isManager).toBe(false);

    await employees.update(system, people.officer, { managerId: people.engineer });

    expect((await signIn('yram.kudjo@rematholdings.com')).isManager).toBe(true);
  });
});

describe('a colleague guessing at records', () => {
  beforeEach(async () => {
    await withPasswords(people.officer);
  });

  it('cannot read somebody else, whatever id they have', async () => {
    // The story, in one assertion.
    const adwoa = await signIn(OFFICER_EMAIL);

    const refusal = await rejection(() => employees.byId(adwoa, people.partTimer));

    expect(refusal).toBeInstanceOf(NotAuthorised);
    expect(refusal.message).toBe(NOT_AUTHORISED_MESSAGE);
  });

  it('cannot tell a real id from an invented one', async () => {
    /* The existence oracle, closed. Two ids — one somebody, one nobody — and one
       indistinguishable sentence, so that working through a list of guesses
       learns nothing about which of them are people.

       That matters more here than it would elsewhere, because employee.id is a
       bigint from a sequence rather than something random: the ids next to
       Adwoa's are the ids of her colleagues, and a list of guesses is `for (let
       id = 1; ...)`. Random ids would make the guessing expensive; this makes it
       pointless, which is the property the story actually asked for. */
    const adwoa = await signIn(OFFICER_EMAIL);

    const real = await rejection(() => employees.byId(adwoa, people.partTimer));
    const invented = await rejection(() => employees.byId(adwoa, '9999999999'));

    expect(invented).toBeInstanceOf(NotAuthorised);
    expect(invented.message).toBe(real.message);
  });

  it('learns nothing by walking the ids either side of their own', async () => {
    // The attack in its literal form, the sequence being what it is.
    const adwoa = await signIn(OFFICER_EMAIL);
    const mine = Number(people.officer);

    for (const id of [mine - 2, mine - 1, mine + 1, mine + 2]) {
      const refusal = await rejection(() => employees.byId(adwoa, String(id)));

      expect(refusal.message).toBe(NOT_AUTHORISED_MESSAGE);
    }
  });

  it('cannot look anybody up by number or by work address', async () => {
    // A directory search is a staff list, which is the disclosure the sign in
    // box is deliberately vague to avoid.
    const adwoa = await signIn(OFFICER_EMAIL);

    await expect(employees.byNumber(adwoa, 'RH-0012')).rejects.toThrow(NotAuthorised);
    await expect(employees.byWorkEmail(adwoa, 'abena.sarpong@rematholdings.com')).rejects.toThrow(
      NotAuthorised,
    );
    await expect(employees.list(adwoa)).rejects.toThrow(NotAuthorised);
  });

  it('can read their own record', async () => {
    const adwoa = await signIn(OFFICER_EMAIL);

    expect((await employees.byId(adwoa, people.officer)).employeeNumber).toBe('RH-0011');
  });

  it('cannot change their own record, however much of it is about them', async () => {
    /* Reading yours is the point of the system; writing yours is what HR is for.
       Said openly, because they can obviously see the record. */
    const adwoa = await signIn(OFFICER_EMAIL);

    const refusal = await rejection(() =>
      employees.update(adwoa, people.officer, { jobTitle: 'Chief Executive' }),
    );

    expect(refusal).toBeInstanceOf(NotAuthorised);
    expect(refusal.message).toMatch(/HR/);
    expect(refusal.message).not.toBe(NOT_AUTHORISED_MESSAGE);
  });
});

describe('a line manager', () => {
  beforeEach(async () => {
    await withPasswords(people.teamLead);
  });

  it('reads the records of the people who report to them, holding no role at all', async () => {
    const kofi = await signIn(TEAM_LEAD_EMAIL);

    expect((await employees.byId(kofi, people.officer)).firstName).toBe('Adwoa');
    expect((await employees.byId(kofi, people.partTimer)).firstName).toBe('Abena');
  });

  it('does not read anybody else, including the person they report to', async () => {
    const kofi = await signIn(TEAM_LEAD_EMAIL);

    await expect(employees.byId(kofi, people.opsManager)).rejects.toThrow(NotAuthorised);
    await expect(employees.byId(kofi, people.engineer)).rejects.toThrow(NotAuthorised);
  });

  it('loses the read the moment the reporting line moves', async () => {
    /* Derived from the record every time it is asked, which is the whole reason
       MANAGER is not a role. Nothing is revoked here and nothing needs to be. */
    const kofi = await signIn(TEAM_LEAD_EMAIL);
    expect(await employees.byId(kofi, people.officer)).toBeDefined();

    await employees.update(system, people.officer, { managerId: people.engineer });

    await expect(employees.byId(kofi, people.officer)).rejects.toThrow(NotAuthorised);
  });

  it('cannot change a report, and is told which rule stopped them', async () => {
    const kofi = await signIn(TEAM_LEAD_EMAIL);

    const refusal = await rejection(() =>
      employees.terminate(kofi, people.officer, { exitDate: '2026-09-30' }),
    );

    expect(refusal.message).toMatch(/HR/);
  });
});

describe('HR', () => {
  beforeEach(async () => {
    await withPasswords(people.hrOfficer, people.headOfHr);
  });

  it('reads everybody, and is told plainly when an id is nobody', async () => {
    /* The other half of the disclosure rule. Somebody who may search gets the
       useful answer, which is what makes a mistyped id a five second problem
       rather than a mystery. */
    const efua = await signIn(HR_OFFICER_EMAIL);

    expect((await employees.byId(efua, people.partTimer)).firstName).toBe('Abena');

    const missing = await rejection(() => employees.byId(efua, '9999999999'));

    expect(missing).toBeInstanceOf(EmployeeNotFound);
  });

  it('maintains records, as an officer, without being an administrator', async () => {
    const efua = await signIn(HR_OFFICER_EMAIL);

    const updated = await employees.update(efua, people.officer, { jobTitle: 'Senior Officer' });

    expect(updated.jobTitle).toBe('Senior Officer');
  });

  it('creates a joiner and gives them a login in the same five minutes', async () => {
    /* The boundary that was argued about, in the place it actually matters. An
       officer who has to wait for an administrator to add the login is an
       officer who ends up knowing the administrator password. */
    const efua = await signIn(HR_OFFICER_EMAIL);
    const operations = (await departments.list(efua)).find((d) => d.name === 'Operations')!;

    const joiner = await employees.create(efua, {
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      departmentId: operations.id,
      managerId: people.teamLead,
      startDate: '2026-09-01',
    });

    const account = await logins.provision(efua, joiner.id, { password: PASSWORD });

    expect(account.companyEmail).toBe('esi.nyarko@rematholdings.com');
    expect((await logins.signIn(account.companyEmail, PASSWORD)).status).toBe('SIGNED_IN');
  });

  it('does not close an account, which is a rank above setting one up', async () => {
    const efua = await signIn(HR_OFFICER_EMAIL);
    const ama = await signIn(HR_ADMIN_EMAIL);

    await expect(logins.close(efua, people.officer)).rejects.toThrow(NotAuthorised);
    await expect(logins.close(ama, people.officer)).resolves.toBeDefined();
  });

  it('does not set up teams or working patterns as an officer, and does as an administrator', async () => {
    const efua = await signIn(HR_OFFICER_EMAIL);
    const ama = await signIn(HR_ADMIN_EMAIL);

    await expect(departments.create(efua, { name: 'Legal' })).rejects.toThrow(NotAuthorised);
    await expect(departments.create(ama, { name: 'Legal' })).resolves.toBeDefined();

    // And reading them is open to everybody, because every screen shows them.
    expect((await departments.list(efua)).length).toBeGreaterThan(0);
    expect((await patterns.list(efua)).length).toBeGreaterThan(0);
  });

  it('keeps a headcount back from somebody who may not read the people in it', async () => {
    await withPasswords(people.officer);
    const adwoa = await signIn(OFFICER_EMAIL);
    const efua = await signIn(HR_OFFICER_EMAIL);

    const operations = (await departments.list(adwoa)).find((d) => d.name === 'Operations')!;

    await expect(departments.headcount(adwoa, operations.id)).rejects.toThrow(NotAuthorised);
    expect(await departments.headcount(efua, operations.id)).toBeGreaterThan(0);
  });
});

describe('assigning roles', () => {
  beforeEach(async () => {
    await withPasswords(people.headOfHr, people.hrOfficer, people.officer);
  });

  it('is an administrator, which is the sentence LMS 111 left for this story', async () => {
    const ama = await signIn(HR_ADMIN_EMAIL);
    const efua = await signIn(HR_OFFICER_EMAIL);

    await expect(roles.grant(efua, people.officer, 'HR_OFFICER')).rejects.toThrow(NotAuthorised);
    expect(await roles.grant(ama, people.officer, 'HR_OFFICER')).toContain('HR_OFFICER');
  });

  it('refuses an administrator their own roles, in either direction', async () => {
    /* Powers are held because somebody granted them. A stolen HR Administrator
       session cannot quietly become a System Administrator session. */
    const ama = await signIn(HR_ADMIN_EMAIL);

    await expect(roles.grant(ama, people.headOfHr, 'HR_OFFICER')).rejects.toThrow(NotAuthorised);
    await expect(roles.revoke(ama, people.headOfHr, 'HR_ADMIN')).rejects.toThrow(NotAuthorised);
  });

  it('refuses an HR Administrator the master key, for anybody', async () => {
    /* Nobody in the fixture holds SYS_ADMIN, so this is also the honest picture
       of a company that has not appointed one: the role cannot be conjured by
       the next most senior person. */
    const ama = await signIn(HR_ADMIN_EMAIL);

    const refusal = await rejection(() => roles.grant(ama, people.officer, 'SYS_ADMIN'));

    expect(refusal.message).toMatch(/System Administrator/);
  });

  it('lets somebody read their own roles and nobody else theirs', async () => {
    const adwoa = await signIn(OFFICER_EMAIL);

    expect((await roles.forEmployee(adwoa, people.officer)).map((g) => g.code)).toEqual([
      'EMPLOYEE',
    ]);
    await expect(roles.forEmployee(adwoa, people.headOfHr)).rejects.toThrow(NotAuthorised);
    await expect(roles.holdersOf(adwoa, 'HR_ADMIN')).rejects.toThrow(NotAuthorised);
  });
});

describe('the sign in door', () => {
  it('takes no actor, because nobody is anybody until they are through it', async () => {
    /* The one exemption in the layer, asserted rather than left as the absence of
       two arguments — "the sign in path has no authorisation check" is exactly the
       sentence somebody will read as a bug and fix. */
    await withPasswords(people.officer);

    const outcome = await logins.signIn(OFFICER_EMAIL, PASSWORD);

    expect(outcome.status).toBe('SIGNED_IN');
    expect(denials.entries).toHaveLength(0);
  });

  it('refuses a wrong password without an authorisation refusal', async () => {
    // A refused sign in is SignInRefused, not NotAuthorised, and it does not
    // belong in the denial log — that log is about records.
    await withPasswords(people.officer);

    await expect(logins.signIn(OFFICER_EMAIL, 'not the password')).rejects.not.toBeInstanceOf(
      NotAuthorised,
    );
    expect(denials.entries).toHaveLength(0);
  });
});

describe('what the log has to say afterwards', () => {
  beforeEach(async () => {
    await withPasswords(people.officer);
  });

  it('records every refused attempt, with who, what, which record and why', async () => {
    // NFR SEC 03, the story's third criterion.
    const adwoa = await signIn(OFFICER_EMAIL);

    await rejection(() => employees.byId(adwoa, people.partTimer));

    const attempt = denials.last()!;

    expect(attempt.employeeId).toBe(people.officer);
    expect(attempt.roles).toEqual(['EMPLOYEE']);
    expect(attempt.resource).toBe('employee');
    expect(attempt.action).toBe('read');
    expect(attempt.subject).toBe(people.partTimer);
    expect(attempt.because).toMatch(/not their record/);
  });

  it('records the colleague working through a list, which is the point of having it', async () => {
    /* The attack the story describes. Refusing silently protects the records and
       tells nobody that somebody went looking. */
    const adwoa = await signIn(OFFICER_EMAIL);

    for (const id of [people.partTimer, people.teamLead, people.headOfHr, people.ceo]) {
      await rejection(() => employees.byId(adwoa, id));
    }

    expect(denials.entries).toHaveLength(4);
    expect(denials.entries.every((entry) => entry.employeeId === people.officer)).toBe(true);
  });

  it('carries nothing from the record it refused', async () => {
    /* A refused read is a read that did not happen, and a log that quotes the
       record has performed the disclosure the refusal existed to prevent — into
       a file that is usually less protected than the database. */
    const adwoa = await signIn(OFFICER_EMAIL);
    const abena = await employees.byId(system, people.partTimer);

    await rejection(() => employees.byId(adwoa, people.partTimer));

    const written = JSON.stringify(denials.last());

    expect(written).not.toContain(abena.firstName);
    expect(written).not.toContain(abena.lastName);
    expect(written).not.toContain(abena.workEmail);
    expect(written).not.toContain(abena.employeeNumber);
  });

  it('says nothing when nothing was refused', async () => {
    const adwoa = await signIn(OFFICER_EMAIL);

    await employees.byId(adwoa, people.officer);

    expect(denials.entries).toHaveLength(0);
  });

  it('writes one line per refusal, not one per check the service happened to make', async () => {
    /* Otherwise a reader counting attempts counts wrongly, which is the whole
       value of the log. */
    const adwoa = await signIn(OFFICER_EMAIL);

    await rejection(() => roles.forEmployee(adwoa, people.headOfHr));

    expect(denials.entries).toHaveLength(1);
  });
});
