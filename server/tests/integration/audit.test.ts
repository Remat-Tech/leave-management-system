import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { type Actor, theSystem } from '../../src/auth/actor.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../../src/auth/policy.js';
import { AUDITED_ENTITIES, changedFields, REDACTED, UNATTRIBUTED } from '../../src/domain/audit.js';
import { AuditRepository } from '../../src/repositories/audit-repository.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { RoleRepository } from '../../src/repositories/role-repository.js';
import { SignInAccountRepository } from '../../src/repositories/sign-in-account-repository.js';
import { Transactions } from '../../src/repositories/transaction.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { AuditService } from '../../src/services/audit-service.js';
import { DepartmentService } from '../../src/services/department-service.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { RoleService } from '../../src/services/role-service.js';
import { SignInService } from '../../src/services/sign-in-service.js';
import { StaffImportService } from '../../src/services/staff-import-service.js';
import { WorkPatternService } from '../../src/services/work-pattern-service.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The audit log, against a real database. NFR AUD 01 and NFR AUD 02. LMS 113.
 *
 * Almost the whole of this story is in the database: the entries are written by
 * triggers, the refusals are enforced by triggers, and the privileges are what
 * make the refusals worth anything. None of that can be tested without one, so
 * this suite carries the story rather than supplementing it.
 *
 * Six properties, and each is one somebody could believe was true while it was
 * not:
 *
 *   Every create, update and configuration change writes an entry — including
 *   the ones the application did not make.
 *
 *   Every entry names who, when, which record, and both states of it.
 *
 *   The entry and the change are one transaction. Roll back the change and the
 *   entry goes with it; there is no window in which one exists without the
 *   other.
 *
 *   Nothing may update or delete an entry, on any connection, and the refusal is
 *   loud.
 *
 *   No credential is ever in an entry.
 *
 *   Signing in is not a decision about anybody's leave, and does not fill the
 *   log with one row per morning.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

const DOMAINS = ['rematholdings.com'];
const PASSWORD = 'a passphrase nobody guesses';

const OFFICER_EMAIL = 'adwoa.frimpong@rematholdings.com';
const HR_OFFICER_EMAIL = 'efua.owusu@rematholdings.com';

/** The fixtures are built by nobody: see theSystem(). */
const system = theSystem('audit integration fixtures');

let db: Kysely<Database>;
let admin: Client;
let guard: Guard;
let mailer: RecordingMailer;
let entries: AuditRepository;
let audit: AuditService;
let employees: EmployeeService;
let departments: DepartmentService;
let patterns: WorkPatternService;
let roles: RoleService;
let logins: SignInService;
let imports: StaffImportService;
let people: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  guard = new Guard();
  mailer = recordingMailer();

  const accounts = new SignInAccountRepository(db);
  const employeeRepository = new EmployeeRepository(db);
  const roleRepository = new RoleRepository(db);

  entries = new AuditRepository(db);
  audit = new AuditService(entries, employeeRepository, accounts, guard);
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
  imports = new StaffImportService(new Transactions(db), guard, { domains: DOMAINS });
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
  mailer.clear();
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/** The history of one employee record, read past the policy. */
async function historyOf(employeeId: string) {
  return entries.forSubjects([{ entity: 'employee', entityId: employeeId }]);
}

/**
 * Signs somebody in and hands back the actor, which is the only way to get one.
 *
 * Answers the one time code where one is asked for. The HR roles are exactly the
 * roles LMS 110 makes a code mandatory for, and they are exactly the roles that
 * do the interesting writing here.
 */
async function signIn(email: string): Promise<Actor> {
  const outcome = await logins.signIn(email, PASSWORD);

  if (outcome.status === 'SIGNED_IN') {
    return outcome.actor;
  }

  const digits = /\b(\d{6})\b/.exec(mailer.last().text);
  expect(digits).not.toBeNull();

  return (await logins.submitCode(email, digits![1])).actor;
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

/** Everything the migration actually attached a trigger to. */
async function auditedTables(): Promise<string[]> {
  const { rows } = await admin.query<{ table: string }>(
    `SELECT DISTINCT c.relname AS table
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE p.proname = 'record_in_audit_log' AND NOT t.tgisinternal
      ORDER BY 1`,
  );

  return rows.map((row) => row.table);
}

describe('what is audited', () => {
  it('is every table the application can change, and nothing else', async () => {
    /* The list in ../../src/domain/audit.ts and the triggers the migration
       created, asserted against each other. A table given a trigger and not named
       there is a table whose history nothing can read; a name there with no
       trigger is a promise of history that was never recorded. */
    expect(await auditedTables()).toEqual([...AUDITED_ENTITIES].sort());
  });

  it('does not include the role table, which only a migration writes', async () => {
    expect(await auditedTables()).not.toContain('role');
  });

  it('does not include the audit log itself', async () => {
    expect(await auditedTables()).not.toContain('audit_log');
  });
});

describe('every change writes an entry', () => {
  it('records a record being created, with the whole of it', async () => {
    const operations = (await departments.list(system)).find((d) => d.name === 'Operations')!;

    const joiner = await employees.create(system, {
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      departmentId: operations.id,
      managerId: people.teamLead,
      startDate: '2026-09-01',
    });

    const [created] = await historyOf(joiner.id);

    expect(created.action).toBe('CREATE');
    expect(created.entity).toBe('employee');
    expect(created.before).toBeNull();
    expect(created.after).toMatchObject({
      employee_number: 'RH-0100',
      first_name: 'Esi',
      work_email: 'esi.nyarko@rematholdings.com',
    });
  });

  it('records a change with the record either side of it', async () => {
    /* Both states rather than a list of what moved. "Her start date says 2023" is
       settled by a snapshot and is not settled by knowing that somebody changed
       some fields in March. */
    await employees.update(system, people.officer, { jobTitle: 'Senior Operations Officer' });

    const changed = (await historyOf(people.officer)).at(-1)!;

    expect(changed.action).toBe('UPDATE');
    expect(changed.before).toMatchObject({ job_title: 'Operations Officer' });
    expect(changed.after).toMatchObject({ job_title: 'Senior Operations Officer' });
    expect(changedFields(changed).map((field) => field.field)).toContain('job_title');
  });

  it('records a termination, which is the change a leaver disputes', async () => {
    await employees.terminate(system, people.officer, { exitDate: '2026-09-30' });

    const ended = (await historyOf(people.officer)).at(-1)!;

    expect(ended.before).toMatchObject({ employment_status: 'ACTIVE', exit_date: null });
    expect(ended.after).toMatchObject({ employment_status: 'TERMINATED', exit_date: '2026-09-30' });
  });

  it('records a configuration change: a team created, renamed and closed', async () => {
    const legal = await departments.create(system, { name: 'Legal' });
    await departments.update(system, legal.id, { name: 'Legal and Compliance' });
    await departments.deactivate(system, legal.id);

    const history = await entries.forSubjects([{ entity: 'department', entityId: legal.id }]);

    expect(history.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(history[1].after).toMatchObject({ name: 'Legal and Compliance' });
    expect(history[2].after).toMatchObject({ is_active: false });
  });

  it('records a working week changing, day by day, filed under the week', async () => {
    /* Seven deletes and seven inserts inside one transaction, all fourteen filed
       under the pattern — which is what makes them legible together, and what
       makes a disputed day count answerable. FR 23. */
    const fourDays = await patterns.create(system, {
      name: 'Four days, Fridays off',
      workingDays: [1, 2, 3, 4],
    });

    await patterns.update(system, fourDays.id, { workingDays: [1, 2, 4, 5] });

    const history = await entries.forSubjects([
      { entity: 'work_pattern', entityId: fourDays.id },
      { entity: 'work_pattern_day', entityId: fourDays.id },
    ]);

    const days = history.filter((entry) => entry.entity === 'work_pattern_day');

    expect(days.filter((entry) => entry.action === 'CREATE')).toHaveLength(14);
    expect(days.filter((entry) => entry.action === 'DELETE')).toHaveLength(7);
  });

  it('records a role being granted, which is what LMS 111 left for this story', async () => {
    /* user_role.granted_by was deliberately never added: the date was on the row
       and the name waited for an authenticated actor and a place to put it. */
    const ama = await signIn('ama.mensah@rematholdings.com').catch(() => null);
    void ama;

    await roles.grant(system, people.officer, 'HR_OFFICER');

    const account = await logins.forEmployee(system, people.officer);
    const history = await entries.forSubjects([{ entity: 'user_role', entityId: account!.id }]);

    expect(history.at(-1)!.action).toBe('CREATE');
    expect(history.at(-1)!.entity).toBe('user_role');
  });

  it('writes nothing for a change that changed nothing', async () => {
    /* Two HR officers saving the same form. An audit log that records the second
       one is an audit log with a false entry in it. */
    const before = (await historyOf(people.officer)).length;

    await employees.update(system, people.officer, { jobTitle: 'Operations Officer' });

    expect(await historyOf(people.officer)).toHaveLength(before);
  });
});

describe('who did it', () => {
  beforeEach(async () => {
    await logins.setPassword(system, people.hrOfficer, PASSWORD);
  });

  it('is the person who signed in, by id and in words', async () => {
    const efua = await signIn(HR_OFFICER_EMAIL);

    await employees.update(efua, people.officer, { jobTitle: 'Senior Operations Officer' });

    const changed = (await historyOf(people.officer)).at(-1)!;

    expect(changed.actorEmployeeId).toBe(people.hrOfficer);
    expect(changed.actor).toContain(people.hrOfficer);
  });

  it('says plainly when nobody said, rather than leaving a null', async () => {
    /* The seed writes on the owner connection and names nobody, which is the
       truth about a fixture load and about a migration correcting data. */
    const seeded = (await historyOf(people.officer))[0];

    expect(seeded.action).toBe('CREATE');
    expect(seeded.actor).toBe(UNATTRIBUTED);
    expect(seeded.actorEmployeeId).toBeNull();
  });

  it('does not leak from one connection to the next', async () => {
    /* SET LOCAL rather than SET. A session level setting would still be on the
       connection when the pool handed it to the next request, and every
       unattributed write after that would be recorded as whoever last used it. */
    const efua = await signIn(HR_OFFICER_EMAIL);

    await employees.update(efua, people.officer, { jobTitle: 'Senior Operations Officer' });
    await admin.query(`UPDATE employee SET job_title = 'Something else' WHERE id = $1`, [
      people.officer,
    ]);

    const [named, unnamed] = (await historyOf(people.officer)).slice(-2);

    expect(named.actorEmployeeId).toBe(people.hrOfficer);
    expect(unnamed.actor).toBe(UNATTRIBUTED);
  });

  it('names the officer on every row of a bulk import, not just the first', async () => {
    /* The import opens one transaction round four hundred rows and writes each
       through EmployeeService. recording() finds it is already inside one and
       sets the name there rather than opening a second connection. */
    const operations = (await departments.list(system)).find((d) => d.name === 'Operations')!;
    void operations;

    const efua = await signIn(HR_OFFICER_EMAIL);

    const file = [
      'employee_number,first_name,last_name,work_email,department,manager,start_date',
      'RH-0200,Esi,Nyarko,esi.nyarko@rematholdings.com,Operations,RH-0010,2026-09-01',
      'RH-0201,Yaw,Mensah,yaw.mensah@rematholdings.com,Operations,RH-0010,2026-09-01',
      'RH-0202,Kwesi,Boadu,kwesi.boadu@rematholdings.com,Operations,RH-0010,2026-09-01',
    ].join('\n');

    const plan = await imports.dryRun(efua, file);
    const outcome = await imports.confirm(efua, file, plan.fingerprint);

    expect(outcome.created).toHaveLength(3);

    for (const created of outcome.created) {
      const [entry] = await historyOf(created.id);

      expect(entry.action).toBe('CREATE');
      expect(entry.actorEmployeeId).toBe(people.hrOfficer);
    }
  });
});

describe('the entry and the change are one transaction', () => {
  it('loses the entry when the change rolls back', async () => {
    /* An audit log with a window in it is wrong exactly when somebody is
       investigating a crash. The import is the readable way to provoke a
       rollback: the last row is refused and takes the first two back with it. */
    const efua = theSystem('a rolled back import');

    const file = [
      'employee_number,first_name,last_name,work_email,department,manager,start_date',
      'RH-0300,Esi,Nyarko,esi.nyarko@rematholdings.com,Operations,RH-0010,2026-09-01',
      'RH-0301,Yaw,Mensah,yaw.mensah@rematholdings.com,Nowhere At All,RH-0010,2026-09-01',
    ].join('\n');

    const plan = await imports.dryRun(efua, file);

    await rejection(() => imports.confirm(efua, file, plan.fingerprint));

    const written = await entries.recent({ entity: 'employee', limit: 50 });

    expect(written.some((entry) => entry.after?.employee_number === 'RH-0300')).toBe(false);
  });

  it('writes the entry with the same statement, so there is no gap to read in', async () => {
    /* Asserted through the owner connection so the transaction can be held open:
       inside it, the change and its entry are both visible; before COMMIT,
       neither is visible to anybody else. */
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('lms.audit.actor', 'a held transaction', true)`);
    await admin.query(`UPDATE employee SET job_title = 'Held' WHERE id = $1`, [people.officer]);

    const inside = await admin.query(
      `SELECT count(*)::int AS entries FROM audit_log
        WHERE entity = 'employee' AND entity_id = $1 AND after ->> 'job_title' = 'Held'`,
      [people.officer],
    );

    const outside = await entries.forSubjects([{ entity: 'employee', entityId: people.officer }]);

    expect(inside.rows[0].entries).toBe(1);
    expect(outside.some((entry) => entry.after?.job_title === 'Held')).toBe(false);

    await admin.query('ROLLBACK');

    expect(
      (await historyOf(people.officer)).some((entry) => entry.after?.job_title === 'Held'),
    ).toBe(false);
  });
});

describe('nothing may be changed once written, NFR AUD 02', () => {
  it('refuses an update on every connection, including the owner', async () => {
    await employees.update(system, people.officer, { jobTitle: 'Senior Operations Officer' });

    await expect(admin.query(`UPDATE audit_log SET actor = 'somebody else'`)).rejects.toMatchObject(
      { code: '23001' },
    );
  });

  it('refuses a delete the same way', async () => {
    await expect(admin.query('DELETE FROM audit_log')).rejects.toMatchObject({ code: '23001' });
  });

  it('refuses loudly rather than quietly doing nothing', async () => {
    /* The reason this is a trigger and not a DO INSTEAD NOTHING rule. A silent
       success is the worst possible answer to somebody rewriting history: they
       believe they have, and nobody finds out either way. */
    const refusal = await rejection(() => admin.query('DELETE FROM audit_log'));

    expect(refusal.message).toMatch(/never deleted/i);
  });

  it('gives the application no way to reach either', async () => {
    /* The layer that actually matters, and the one nobody had to write: the
       default privileges grant SELECT and INSERT on a new table and nothing else.
       INSERT is needed because the trigger runs as whoever issued the statement. */
    const { rows } = await admin.query<Record<string, boolean>>(
      `SELECT has_table_privilege('lms_app', 'audit_log', 'SELECT')   AS sel,
              has_table_privilege('lms_app', 'audit_log', 'INSERT')   AS ins,
              has_table_privilege('lms_app', 'audit_log', 'UPDATE')   AS upd,
              has_table_privilege('lms_app', 'audit_log', 'DELETE')   AS del,
              has_table_privilege('lms_app', 'audit_log', 'TRUNCATE') AS trunc`,
    );

    expect(rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false });
  });

  it('will not let a writer date an entry', async () => {
    // occurred_at is defaulted and nothing supplies it.
    const before = new Date();

    await employees.update(system, people.officer, { jobTitle: 'Senior Operations Officer' });

    const changed = (await historyOf(people.officer)).at(-1)!;

    expect(changed.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});

describe('credentials never reach the log', () => {
  it('records that a password was set, and never what it was', async () => {
    await logins.setPassword(system, people.officer, PASSWORD);

    const account = await logins.forEmployee(system, people.officer);
    const history = await entries.forSubjects([{ entity: 'app_user', entityId: account!.id }]);
    const set = history.at(-1)!;

    expect(set.after!.password_hash).toBe(REDACTED);
    expect(JSON.stringify(set)).not.toContain('scrypt');
    expect(JSON.stringify(set)).not.toContain(PASSWORD);
  });

  it('records a reset as a change, even though both sides read the same', async () => {
    /* The comparison happens on the real values and the storage does not. A reset
       from one hash to another is a real change and is recorded; what it changed
       to is not, and that is the whole truth an audit trail should tell about a
       secret. */
    await logins.setPassword(system, people.officer, PASSWORD);
    await logins.setPassword(system, people.officer, 'a different passphrase entirely');

    const account = await logins.forEmployee(system, people.officer);
    const history = await entries.forSubjects([{ entity: 'app_user', entityId: account!.id }]);
    const reset = history.at(-1)!;

    expect(reset.action).toBe('UPDATE');
    expect(reset.before!.password_hash).toBe(REDACTED);
    expect(reset.after!.password_hash).toBe(REDACTED);
  });

  it('never carries a one time code', async () => {
    await logins.setPassword(system, people.headOfHr, PASSWORD);
    await logins.signIn('ama.mensah@rematholdings.com', PASSWORD);

    const { rows } = await admin.query<{ found: number }>(
      `SELECT count(*)::int AS found FROM audit_log
        WHERE before ? 'mfa_code_hash' OR after ? 'mfa_code_hash'`,
    );

    expect(rows[0].found).toBe(0);
  });
});

describe('signing in is not a decision about anybody', () => {
  it('writes no entry for a sign in', async () => {
    /* An audit log with one row per morning per member of staff is an audit log
       nobody scrolls to the bottom of. Who signed in and when is an access log,
       which this is not and which does not exist. */
    await logins.setPassword(system, people.officer, PASSWORD);

    const account = await logins.forEmployee(system, people.officer);
    const before = await entries.forSubjects([{ entity: 'app_user', entityId: account!.id }]);

    await signIn(OFFICER_EMAIL);
    await signIn(OFFICER_EMAIL);

    const after = await entries.forSubjects([{ entity: 'app_user', entityId: account!.id }]);

    expect(after).toHaveLength(before.length);
  });

  it('still records closing an account, which is a decision about somebody', async () => {
    await logins.close(system, people.officer);

    const account = await logins.forEmployee(system, people.officer);
    const history = await entries.forSubjects([{ entity: 'app_user', entityId: account!.id }]);

    expect(history.at(-1)!.after).toMatchObject({ is_active: false });
  });
});

describe('reading the account of what happened', () => {
  beforeEach(async () => {
    await logins.setPassword(system, people.officer, PASSWORD);
    await logins.setPassword(system, people.hrOfficer, PASSWORD);
  });

  it('gives somebody the history of their own record, which is the story', async () => {
    await employees.update(system, people.officer, { jobTitle: 'Senior Operations Officer' });

    const adwoa = await signIn(OFFICER_EMAIL);
    const history = await audit.forEmployee(adwoa, people.officer);

    expect(history.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE']);
    expect(history[1].after).toMatchObject({ job_title: 'Senior Operations Officer' });
  });

  it('reads oldest first, because that is the direction the question runs', async () => {
    await employees.update(system, people.officer, { jobTitle: 'One' });
    await employees.update(system, people.officer, { jobTitle: 'Two' });

    const adwoa = await signIn(OFFICER_EMAIL);
    const history = await audit.forEmployee(adwoa, people.officer);

    expect(history.map((entry) => entry.after?.job_title)).toEqual([
      'Operations Officer',
      'One',
      'Two',
    ]);
  });

  it('refuses a colleague the history, exactly as it refuses them the record', async () => {
    /* Without this the whole of LMS 112 comes undone: somebody refused a record
       could ask for its history and be handed several copies of it. */
    const adwoa = await signIn(OFFICER_EMAIL);

    const refusal = await rejection(() => audit.forEmployee(adwoa, people.partTimer));

    expect(refusal).toBeInstanceOf(NotAuthorised);
    expect(refusal.message).toBe(NOT_AUTHORISED_MESSAGE);
  });

  it('cannot be used to find out whether an id is anybody', async () => {
    const adwoa = await signIn(OFFICER_EMAIL);

    const real = await rejection(() => audit.forEmployee(adwoa, people.partTimer));
    const invented = await rejection(() => audit.forEmployee(adwoa, '9999999999'));

    expect(invented.message).toBe(real.message);
  });

  it('keeps the access history narrower than the record history', async () => {
    /* A line manager may read a report's record and its history. When that
       report's password was reset is not their business. */
    const kofi = await (async () => {
      await logins.setPassword(system, people.teamLead, PASSWORD);
      return signIn('kofi.boateng@rematholdings.com');
    })();

    expect(await audit.forEmployee(kofi, people.officer)).not.toHaveLength(0);
    await expect(audit.forAccess(kofi, people.officer)).rejects.toThrow(NotAuthorised);
  });

  it('gives HR the whole log, newest first', async () => {
    const efua = await signIn(HR_OFFICER_EMAIL);

    await employees.update(efua, people.officer, { jobTitle: 'Senior Operations Officer' });

    const recent = await audit.recent(efua, { limit: 5 });

    expect(recent[0].entity).toBe('employee');
    expect(recent[0].actorEmployeeId).toBe(people.hrOfficer);
  });

  it('refuses the whole log to somebody who may not read every record', async () => {
    const adwoa = await signIn(OFFICER_EMAIL);

    await expect(audit.recent(adwoa)).rejects.toThrow(NotAuthorised);
  });

  it('answers what one person has done, which is what follows a denial', async () => {
    /* The denial log says what somebody was refused; this says what they were
       not. The two together are the account an investigation needs. */
    const efua = await signIn(HR_OFFICER_EMAIL);

    await employees.update(efua, people.officer, { jobTitle: 'Senior Operations Officer' });
    await employees.update(efua, people.partTimer, { jobTitle: 'Senior Operations Officer' });

    const theirs = await audit.recent(efua, { actorEmployeeId: people.hrOfficer });

    expect(theirs).toHaveLength(2);
    expect(theirs.every((entry) => entry.actorEmployeeId === people.hrOfficer)).toBe(true);
  });

  it('has no way to write an entry, and none to correct one', () => {
    /* The property that makes the rest of this suite worth anything. An entry the
       application can compose is an entry the application can be made to
       compose. */
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(audit)),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(entries)),
    ];

    expect(surface).not.toContain('record');
    expect(surface).not.toContain('write');
    expect(surface).not.toContain('create');
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('remove');
  });
});
