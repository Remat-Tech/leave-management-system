import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  describePlan,
  ImportChangedSinceDryRun,
  ImportWouldRejectRows,
  InvalidColumnMapping,
  summarise,
} from '../../src/domain/staff-import.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { Transactions } from '../../src/repositories/transaction.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { DepartmentService } from '../../src/services/department-service.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { StaffImportService } from '../../src/services/staff-import-service.js';
import { seed } from '../../seeds/seed.mjs';
import type { Kysely } from 'kysely';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * Loading staff from a spreadsheet, against a real database. FR 08, LMS 107.
 *
 * The unit suite covers what a file says. What needs a database is everything
 * the import exists for: that a dry run over a real organisation writes
 * absolutely nothing, that confirming it writes all of it or none of it, that a
 * row is matched to the person it names and reported as a change rather than a
 * duplicate, that a manager who is four lines further down the same file is
 * written first, and that a loop is found and named before anything is written
 * rather than surfacing as a rolled back transaction at COMMIT.
 *
 * The go live case has its own section, because it is the one the story is
 * actually about: an empty table, one file, and the whole company in it
 * including the one person who reports to nobody.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

// The suite supplies its own rather than reading ALLOWED_EMAIL_DOMAINS, which is
// set in .env but not in CI.
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
const system = theSystem('staff import integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let imports: StaffImportService;
let employees: EmployeeService;
let departments: DepartmentService;

const HEADINGS =
  'Employee Number,First Name,Last Name,Email,Department,Line Manager,Start Date,Job Title';

/** A joiner in Operations under Kofi Boateng, the shape most of these files are. */
const JOINER =
  'RH-0100,Esi,Nyarko,esi.nyarko@rematholdings.com,Operations,RH-0010,2026-09-01,' +
  'Operations Officer';

/** Adwoa Frimpong exactly as the seed already has her. */
const ADWOA_UNCHANGED =
  'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Operations,RH-0010,2023-08-14,' +
  'Operations Officer';

function fileOf(...rows: string[]): string {
  return `${HEADINGS}\n${rows.join('\n')}\n`;
}

async function headcount(): Promise<number> {
  const { rows } = await admin.query('SELECT count(*)::int AS total FROM employee');
  return rows[0].total as number;
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  // The owner connection, for seeding and for the statements that deliberately
  // go round the service.
  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  imports = new StaffImportService(new Transactions(db), guard, { domains: DOMAINS });

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
  // The organisation, so each test starts from the same thirteen people.
  await seed(admin);
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

describe('the dry run', () => {
  it('says what would be created, changed and left alone, and writes nothing', async () => {
    const before = await headcount();

    const plan = await imports.dryRun(
      system,
      fileOf(
        JOINER,
        ADWOA_UNCHANGED,
        // Kofi has been promoted and moved to Finance.
        'RH-0010,Kofi,Boateng,kofi.boateng@rematholdings.com,Finance,RH-0006,2022-04-25,' +
          'Finance Team Lead',
      ),
    );

    expect(summarise(plan)).toEqual({
      toCreate: 1,
      toChange: 1,
      unchanged: 1,
      rejected: 0,
      rows: 3,
    });

    expect(plan.creates[0].employeeNumber).toBe('RH-0100');
    expect(plan.changes[0].differences).toEqual([
      { field: 'jobTitle', from: 'Operations Team Lead', to: 'Finance Team Lead' },
      { field: 'department', from: 'Operations', to: 'Finance' },
      { field: 'manager', from: 'RH-0007', to: 'RH-0006' },
    ]);

    // The whole point of the story.
    expect(await headcount()).toBe(before);
  });

  it('matches a row to the person it names however the number is capitalised', async () => {
    const plan = await imports.dryRun(
      system,
      fileOf(ADWOA_UNCHANGED.replace('RH-0011', 'rh-0011')),
    );

    // Matched, and not reported as a change: the unique index folds case, so the
    // file is naming the same person and saying nothing different about them.
    expect(summarise(plan).unchanged).toBe(1);
    expect(summarise(plan).toCreate).toBe(0);
  });

  it('leaves a field alone when the file has no column for it', async () => {
    /* The rule the story turns on. A spreadsheet of new starters with no Job
       Title column must not wipe the job title of everybody it touches. */
    const plan = await imports.dryRun(
      system,
      'Employee Number,First Name,Last Name,Email,Department,Line Manager,Start Date\n' +
        'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Operations,RH-0010,2023-08-14\n',
    );

    expect(summarise(plan).unchanged).toBe(1);
  });

  it('leaves a field alone when the column is there and the cell is blank', async () => {
    const plan = await imports.dryRun(
      system,
      fileOf(ADWOA_UNCHANGED.replace(',Operations Officer', ',')),
    );

    expect(summarise(plan).unchanged).toBe(1);
  });

  it('reads a file whatever its headings and whatever separates the cells', async () => {
    /* Semicolons because the machine is set to a European locale, a byte order
       mark because Excel saved it as UTF-8, and headings in HR's own words. */
    const plan = await imports.dryRun(
      system,
      '\uFEFFStaff No;Forename;Surname;E-mail Address;Dept;Reports To;Commencement Date\n' +
        'RH-0100;Esi;Nyarko;esi.nyarko@rematholdings.com;Operations;RH-0010;2026-09-01\n',
    );

    expect(summarise(plan).toCreate).toBe(1);
    expect(plan.mapping.employeeNumber).toBe('Staff No');
    expect(plan.mapping.startDate).toBe('Commencement Date');
  });

  it('takes the caller’s mapping over its own guess', async () => {
    const plan = await imports.dryRun(
      system,
      `${HEADINGS},Personal Email\n${JOINER},esi@gmail.com\n`,
      {
        mapping: { workEmail: 'Email' },
      },
    );

    expect(summarise(plan).rejected).toBe(0);
    expect(plan.creates[0].record.workEmail).toBe('esi.nyarko@rematholdings.com');
  });

  it('refuses a file whose columns cannot be matched at all', async () => {
    await expect(imports.dryRun(system, 'One,Two,Three\n1,2,3\n')).rejects.toThrow(
      InvalidColumnMapping,
    );
  });

  it('names the departments that exist when a row names one that does not', async () => {
    const plan = await imports.dryRun(
      system,
      fileOf(JOINER.replace(',Operations,', ',Operatoins,')),
    );

    expect(plan.rejected[0].field).toBe('department');
    expect(plan.rejected[0].reason).toContain('Operations');
    expect(plan.rejected[0].line).toBe(2);
  });

  it('reports the record rules in the dry run rather than at the write', async () => {
    /* A personal address is refused by the same validator a single joiner goes
       through. Finding that out row by row in a report beats finding it out as
       one rolled back transaction. */
    const plan = await imports.dryRun(
      system,
      fileOf(JOINER.replace('esi.nyarko@rematholdings.com', 'esi.nyarko@gmail.com')),
    );

    expect(plan.rejected[0].field).toBe('workEmail');
    expect(plan.rejected[0].reason).toContain('not a company address');
    // One bad cell costs one line of the report, not the other four hundred rows.
    expect(summarise(plan).rejected).toBe(1);
  });

  it('refuses both rows when two of them claim the same employee number', async () => {
    /* Which one is right is not knowable from the file, and importing whichever
       came first is a coin toss with somebody's record. */
    const plan = await imports.dryRun(
      system,
      fileOf(JOINER, JOINER.replace(',Esi,Nyarko,esi.nyarko@', ',Esi,Nyarko-Mensah,esi.n@')),
    );

    expect(summarise(plan).rejected).toBe(2);
    expect(plan.rejected[0].reason).toContain('line 3');
    expect(plan.rejected[1].reason).toContain('line 2');
  });

  it('refuses a row whose work address already belongs to somebody else', async () => {
    const plan = await imports.dryRun(
      system,
      fileOf(JOINER.replace('esi.nyarko@rematholdings.com', 'adwoa.frimpong@rematholdings.com')),
    );

    expect(plan.rejected[0].field).toBe('workEmail');
  });

  it('refuses a row whose line manager is nobody', async () => {
    const plan = await imports.dryRun(system, fileOf(JOINER.replace(',RH-0010,', ',RH-9999,')));

    expect(plan.rejected[0].field).toBe('manager');
    expect(plan.rejected[0].reason).toContain('RH-9999');
  });

  it('refuses a row whose line manager has left', async () => {
    // Kojo Antwi left in July. A request routed to him has nowhere to go.
    const plan = await imports.dryRun(system, fileOf(JOINER.replace(',RH-0010,', ',RH-0013,')));

    expect(plan.rejected[0].field).toBe('manager');
    expect(plan.rejected[0].reason).toContain('2026-07-31');
  });

  it('refuses a second employee with no line manager, and names the one there is', async () => {
    const plan = await imports.dryRun(system, fileOf(JOINER.replace(',RH-0010,', ',,')));

    expect(plan.rejected[0].field).toBe('manager');
    expect(plan.rejected[0].reason).toContain('RH-0001');
  });

  it('puts the line number in front of everything in the report', async () => {
    const report = describePlan(
      await imports.dryRun(system, fileOf(JOINER, JOINER.replace('2026-09-01', '01/09/2026'))),
    );

    expect(report).toContain('Nothing has been written');
    expect(report).toContain('line 2');
    expect(report).toContain('line 3');
    expect(report).toContain('YYYY-MM-DD');
  });
});

describe('cycle detection during the import', () => {
  it('finds a loop the file closes among its own rows, and names it', async () => {
    /* Three joiners who report to each other in a ring. Nothing in the database
       is involved, so no per record check would ever see it, and the deferred
       trigger would only be able to say that the file contains a loop. */
    const plan = await imports.dryRun(
      system,
      fileOf(
        'RH-0101,A,One,a.one@rematholdings.com,Operations,RH-0102,2026-09-01,Officer',
        'RH-0102,B,Two,b.two@rematholdings.com,Operations,RH-0103,2026-09-01,Officer',
        'RH-0103,C,Three,c.three@rematholdings.com,Operations,RH-0101,2026-09-01,Officer',
      ),
    );

    expect(summarise(plan).rejected).toBe(3);
    for (const row of plan.rejected) {
      expect(row.field).toBe('manager');
      expect(row.reason).toContain('loop');
    }
    // The loop is named in order, so an HR officer can see which of the three
    // lines is the one that is wrong.
    expect(plan.rejected[0].reason).toContain('RH-0101 reports to RH-0102');
  });

  it('finds a loop one row closes through records the file never mentions', async () => {
    /* Yaw Boateng is the Operations Director, three levels above Kofi Boateng.
       Making Kofi his manager closes a loop through two people the file does not
       touch, which is the case a per row check cannot see. */
    const plan = await imports.dryRun(
      system,
      fileOf(
        'RH-0003,Yaw,Boateng,yaw.boateng@rematholdings.com,Operations,RH-0010,2017-01-09,' +
          'Director of Operations',
      ),
    );

    expect(summarise(plan).rejected).toBe(1);
    expect(plan.rejected[0].reason).toContain('RH-0003 reports to RH-0010');
    expect(plan.rejected[0].reason).toContain('RH-0007');
  });

  it('refuses somebody recorded as their own line manager', async () => {
    const plan = await imports.dryRun(system, fileOf(JOINER.replace(',RH-0010,', ',RH-0100,')));

    expect(plan.rejected[0].reason).toContain('their own line manager');
  });

  it('allows and writes a restructure whose final state is a good tree', async () => {
    /* Kofi and Akosua swap over: she reports to him instead of the other way
       round. The final state is a perfectly good tree, and getting there needs
       the rows written in the right order — Kofi up first, then Akosua under
       him. Written the other way round, EmployeeService walks up from Kofi,
       finds Akosua still above him, and refuses it as a loop. */
    const source = fileOf(
      'RH-0007,Akosua,Darko,akosua.darko@rematholdings.com,Operations,RH-0010,2019-03-18,' +
        'Operations Manager',
      'RH-0010,Kofi,Boateng,kofi.boateng@rematholdings.com,Operations,RH-0003,2022-04-25,' +
        'Operations Team Lead',
    );

    const plan = await imports.dryRun(system, source);
    expect(summarise(plan).rejected).toBe(0);
    expect(summarise(plan).toChange).toBe(2);

    await imports.confirm(system, source, plan.fingerprint);

    const akosua = await employees.byNumber(system, 'RH-0007');
    const kofi = await employees.byNumber(system, 'RH-0010');
    const yaw = await employees.byNumber(system, 'RH-0003');

    expect(akosua?.managerId).toBe(kofi?.id);
    expect(kofi?.managerId).toBe(yaw?.id);
    expect(await employees.reportingLineWarnings(system)).toEqual([]);
  });
});

describe('confirming the dry run', () => {
  it('writes exactly what the plan said', async () => {
    const source = fileOf(JOINER, ADWOA_UNCHANGED);
    const plan = await imports.dryRun(system, source);

    const outcome = await imports.confirm(system, source, plan.fingerprint);

    expect(outcome.created).toHaveLength(1);
    expect(outcome.changed).toHaveLength(0);
    expect(outcome.unchanged).toBe(1);

    const created = await employees.byNumber(system, 'RH-0100');
    expect(created).toMatchObject({
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      jobTitle: 'Operations Officer',
      startDate: '2026-09-01',
      employmentStatus: 'ACTIVE',
    });
  });

  it('gives a joiner the standard week when the file names no pattern', async () => {
    // FR 23. There is a right answer to "which week do they work" and nobody
    // should have to look its id up to say it.
    const source = fileOf(JOINER);
    await imports.confirm(system, source, (await imports.dryRun(system, source)).fingerprint);

    const created = await employees.byNumber(system, 'RH-0100');
    const standard = await new WorkPatternRepository(db).findDefault();

    expect(created?.workPatternId).toBe(standard?.id);
  });

  it('puts somebody on the week the file names', async () => {
    // The pattern's name has a comma in it, which is also a quoting test.
    const source = `${HEADINGS},Work Pattern\n${JOINER},"Part time, Wednesdays off"\n`;

    await imports.confirm(system, source, (await imports.dryRun(system, source)).fingerprint);

    const created = await employees.byNumber(system, 'RH-0100');
    const partTime = await new WorkPatternRepository(db).findByName('Part time, Wednesdays off');

    expect(created?.workPatternId).toBe(partTime?.id);
  });

  it('writes a manager who is further down the same file before their report', async () => {
    /* The go live case in miniature. manager_id is an ordinary foreign key, so
       the joiner on line 2 cannot be written before the manager on line 3. */
    const source = fileOf(
      'RH-0102,B,Two,b.two@rematholdings.com,Operations,RH-0101,2026-09-01,Officer',
      'RH-0101,A,One,a.one@rematholdings.com,Operations,RH-0010,2026-09-01,Team Lead',
    );

    const outcome = await imports.confirm(
      system,
      source,
      (await imports.dryRun(system, source)).fingerprint,
    );

    expect(outcome.created).toHaveLength(2);

    const report = await employees.byNumber(system, 'RH-0102');
    const manager = await employees.byNumber(system, 'RH-0101');
    expect(report?.managerId).toBe(manager?.id);
  });

  it('refuses a plan that has rejected rows in it, and writes none of the good ones', async () => {
    /* An import that quietly skips the rows it could not read is how a company
       goes live believing everybody is in the system. */
    const source = fileOf(JOINER, JOINER.replace('2026-09-01', '01/09/2026'));
    const plan = await imports.dryRun(system, source);

    await expect(imports.confirm(system, source, plan.fingerprint)).rejects.toThrow(
      ImportWouldRejectRows,
    );

    expect(await employees.byNumber(system, 'RH-0100')).toBeUndefined();
  });

  it('imports the rest when asked for in so many words', async () => {
    const source = fileOf(
      JOINER,
      'RH-0101,A,One,a.one@rematholdings.com,Operations,RH-0010,01/09/2026,Officer',
    );
    const plan = await imports.dryRun(system, source);

    const outcome = await imports.confirm(system, source, plan.fingerprint, {
      withoutTheRejectedRows: true,
    });

    expect(outcome.created).toHaveLength(1);
    expect(outcome.skipped).toHaveLength(1);
    expect(await employees.byNumber(system, 'RH-0100')).toBeDefined();
    expect(await employees.byNumber(system, 'RH-0101')).toBeUndefined();
  });

  it('does not import somebody whose line manager was on a row that was rejected', async () => {
    /* The cascade. A joiner reporting to a joiner further up the file is the
       ordinary case at go live; if that row is refused, the manager this one
       names is never going to exist, and importing the rest anyway would get
       halfway and roll back with a foreign key violation. */
    const source = fileOf(
      // Refused: a personal address.
      'RH-0101,A,One,a.one@gmail.com,Operations,RH-0010,2026-09-01,Team Lead',
      'RH-0102,B,Two,b.two@rematholdings.com,Operations,RH-0101,2026-09-01,Officer',
      // And this one hangs off that one in turn.
      'RH-0103,C,Three,c.three@rematholdings.com,Operations,RH-0102,2026-09-01,Officer',
    );

    const plan = await imports.dryRun(system, source);

    expect(summarise(plan).rejected).toBe(3);
    expect(plan.rejected[1].reason).toContain('RH-0101 is the line manager');
    expect(plan.rejected[2].reason).toContain('RH-0102 is the line manager');

    const outcome = await imports.confirm(system, source, plan.fingerprint, {
      withoutTheRejectedRows: true,
    });

    expect(outcome.created).toHaveLength(0);
  });

  it('refuses a confirmation of a plan the records have moved underneath', async () => {
    /* There is a person reading a report in the middle of this window, so it is
       minutes rather than milliseconds and far more likely than the races the
       repositories guard against, not less. */
    const source = fileOf(JOINER);
    const plan = await imports.dryRun(system, source);

    // A colleague creates the same joiner while the report is being read, so the
    // import that was approved is not the import that would now happen.
    await employees.create(system, {
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      departmentId: (await departments.byName(system, 'Operations'))!.id,
      managerId: (await employees.byNumber(system, 'RH-0010'))!.id,
      startDate: '2026-09-01',
    });

    await expect(imports.confirm(system, source, plan.fingerprint)).rejects.toThrow(
      ImportChangedSinceDryRun,
    );
  });

  it('writes all of it or none of it', async () => {
    /* Four hundred rows written one autocommitted statement at a time would
       leave the two hundred and thirtieth failure with two hundred and
       twenty-nine people already in the table and no way back. */
    const before = await headcount();

    const source = fileOf(
      'RH-0101,A,One,a.one@rematholdings.com,Operations,RH-0010,2026-09-01,Officer',
      'RH-0102,B,Two,b.two@rematholdings.com,Operations,RH-0010,2026-09-01,Officer',
      // Unreadable, so the confirmation is refused after the first two would
      // otherwise have been written.
      'RH-0103,C,Three,c.three@rematholdings.com,Operations,RH-0010,not a date,Officer',
    );
    const plan = await imports.dryRun(system, source);

    await expect(imports.confirm(system, source, plan.fingerprint)).rejects.toThrow(
      ImportWouldRejectRows,
    );

    expect(await headcount()).toBe(before);
  });

  it('changes an existing record without touching the fields the file is silent about', async () => {
    const source =
      'Employee Number,First Name,Last Name,Email,Department,Line Manager,Start Date\n' +
      'RH-0011,Adwoa,Frimpong-Mensah,adwoa.frimpong@rematholdings.com,Finance,RH-0006,2023-08-14\n';

    const outcome = await imports.confirm(
      system,
      source,
      (await imports.dryRun(system, source)).fingerprint,
    );

    expect(outcome.changed).toHaveLength(1);

    const changed = await employees.byNumber(system, 'RH-0011');
    expect(changed).toMatchObject({
      lastName: 'Frimpong-Mensah',
      // Untouched: the file has no column for either.
      jobTitle: 'Operations Officer',
      gender: 'FEMALE',
    });
  });
});

describe('departments that have been closed', () => {
  beforeEach(async () => {
    const spare = await departments.create(system, { name: 'Legacy Systems' });
    await departments.deactivate(system, spare.id);
  });

  it('refuses to import somebody who still works here into a closed team', async () => {
    const plan = await imports.dryRun(
      system,
      fileOf(JOINER.replace(',Operations,', ',Legacy Systems,')),
    );

    expect(plan.rejected[0].field).toBe('department');
    expect(plan.rejected[0].reason).toContain('Legacy Systems');
  });

  it('lets a leaver be imported into one, which is what makes history importable', async () => {
    /* The same latitude EmployeeService.create() allows: a leaver being loaded
       from an old system may belong to a team that has since closed, and a
       stricter rule would make the history unimportable. */
    const source =
      `${HEADINGS},Employment Status,Exit Date\n` +
      `${JOINER.replace(',Operations,', ',Legacy Systems,').replace(
        '2026-09-01',
        '2019-04-01',
      )},TERMINATED,2026-06-30\n`;

    const plan = await imports.dryRun(system, source);
    expect(summarise(plan).rejected).toBe(0);

    await imports.confirm(system, source, plan.fingerprint);
    expect(await employees.byNumber(system, 'RH-0100')).toMatchObject({
      employmentStatus: 'TERMINATED',
      exitDate: '2026-06-30',
    });
  });
});

describe('going live from an empty table', () => {
  beforeEach(async () => {
    /* No employees at all, which is the state this story exists for. app_user
       references employee, so it goes too; the owner connection is used because
       lms_app deliberately holds neither TRUNCATE nor DELETE on employee. */
    await admin.query('TRUNCATE user_role, app_user, employee RESTART IDENTITY CASCADE');
  });

  it('loads a whole organisation from one file, in whatever order it is written', async () => {
    /* The file is deliberately upside down — the officer first, the chief
       executive last — because that is how a spreadsheet sorted by employee name
       arrives, and nobody should have to sort it by hand. */
    const source = fileOf(
      'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Operations,RH-0010,2023-08-14,' +
        'Operations Officer',
      'RH-0010,Kofi,Boateng,kofi.boateng@rematholdings.com,Operations,RH-0003,2022-04-25,' +
        'Operations Team Lead',
      'RH-0003,Yaw,Boateng,yaw.boateng@rematholdings.com,Operations,RH-0001,2017-01-09,' +
        'Director of Operations',
      // The one person with no line manager. FR 04.
      'RH-0001,Kwame,Asante,kwame.asante@rematholdings.com,Executive,,2014-02-03,' +
        'Chief Executive Officer',
    );

    const plan = await imports.dryRun(system, source);

    expect(summarise(plan)).toEqual({
      toCreate: 4,
      toChange: 0,
      unchanged: 0,
      rejected: 0,
      rows: 4,
    });

    // The report says out loud which row reports to nobody, so a human confirms
    // it rather than a parser inferring it from an empty cell.
    expect(describePlan(plan)).toContain('the head of the organisation');

    const outcome = await imports.confirm(system, source, plan.fingerprint);
    expect(outcome.created).toHaveLength(4);

    const head = await employees.head(system);
    expect(head?.employeeNumber).toBe('RH-0001');

    const officer = await employees.byNumber(system, 'RH-0011');
    const lead = await employees.byNumber(system, 'RH-0010');
    expect(officer?.managerId).toBe(lead?.id);
  });

  it('refuses a file with no head of the organisation in it at all', async () => {
    /* Every row has a manager and none of them is the root, so somewhere the
       lines loop: no upward walk terminates and no request can be routed. */
    const plan = await imports.dryRun(
      system,
      fileOf(
        'RH-0001,A,One,a.one@rematholdings.com,Executive,RH-0002,2014-02-03,CEO',
        'RH-0002,B,Two,b.two@rematholdings.com,Executive,RH-0001,2016-06-13,Head of HR',
      ),
    );

    expect(summarise(plan).rejected).toBe(2);
    expect(plan.rejected[0].reason).toContain('loop');
  });

  it('runs the same file twice without making a second copy of anybody', async () => {
    /* There is always a second run, because the first one found eleven bad rows.
       The second has to be safe and has to be legible: everything already
       correct is reported as such rather than buried in a list of changes to
       nothing. */
    const source = fileOf(
      'RH-0001,Kwame,Asante,kwame.asante@rematholdings.com,Executive,,2014-02-03,CEO',
      'RH-0003,Yaw,Boateng,yaw.boateng@rematholdings.com,Operations,RH-0001,2017-01-09,Director',
    );

    await imports.confirm(system, source, (await imports.dryRun(system, source)).fingerprint);

    const second = await imports.dryRun(system, source);
    expect(summarise(second)).toEqual({
      toCreate: 0,
      toChange: 0,
      unchanged: 2,
      rejected: 0,
      rows: 2,
    });

    const outcome = await imports.confirm(system, source, second.fingerprint);
    expect(outcome.created).toHaveLength(0);
    expect(await headcount()).toBe(2);
  });

  it('refuses to succeed the head of the organisation, and says what to do instead', async () => {
    /* FR 03 and FR 04 between them leave no order that works one record at a
       time: promoting first leaves two employees with no line manager, which
       employee_one_root refuses immediately, and demoting first points the
       outgoing head at somebody still below them, which EmployeeService refuses
       as a loop. The README says the same about succeedHead(), which is wanted
       and not written. The value here is that it is refused before anything is
       written, with the reason. */
    const setup = fileOf(
      'RH-0001,Kwame,Asante,kwame.asante@rematholdings.com,Executive,,2014-02-03,CEO',
      'RH-0002,Ama,Mensah,ama.mensah@rematholdings.com,Executive,RH-0001,2016-06-13,Head of HR',
    );
    await imports.confirm(system, setup, (await imports.dryRun(system, setup)).fingerprint);

    const succession = fileOf(
      // Kwame steps down and reports to the incoming chief executive.
      'RH-0001,Kwame,Asante,kwame.asante@rematholdings.com,Executive,RH-0002,2014-02-03,' +
        'Executive Chair',
      'RH-0002,Ama,Mensah,ama.mensah@rematholdings.com,Executive,,2016-06-13,' +
        'Chief Executive Officer',
    );

    const plan = await imports.dryRun(system, succession);

    // Both lines, because either on its own is refused by something else and the
    // HR officer needs sending to the pair rather than to one of them.
    expect(summarise(plan).rejected).toBe(2);
    expect(plan.rejected[0].reason).toContain('head of the organisation from RH-0001 to RH-0002');

    // And the head of the organisation has not moved.
    expect((await employees.head(system))?.employeeNumber).toBe('RH-0001');
  });
});
