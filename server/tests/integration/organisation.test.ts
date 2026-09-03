import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  ChiefExecutiveHasLeft,
  ChiefExecutiveNotFound,
  NoChiefExecutiveNamed,
} from '../../src/features/organisation/organisation.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { OrganisationService } from '../../src/features/organisation/organisation.service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Who the Chief Executive is, against a real database. FR 48c, FR 04, §4.3.1. LMS 321.
 *
 * ../unit/organisation.test.ts covers what the rules mean. What needs a database is the half
 * the database itself decides:
 *
 *   **The setting is a foreign key to a person**, so an id that is nobody's is refused by the
 *   schema rather than only by the service. That is the whole difference between this and the
 *   job title the story was written against.
 *
 *   **There is one row of it**, on every connection, and it cannot be emptied.
 *
 *   **Changing it is one audit entry naming the administrator who made it**, which is what a
 *   request that went to an unexpected desk is settled against.
 *
 * That routing actually reads it is ./routing.test.ts, where the desks are.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('organisation integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let organisation: OrganisationRepository;
let settings: OrganisationService;
let people: Record<string, string>;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  organisation = new OrganisationRepository(db);
  settings = new OrganisationService(organisation, guard, new EmployeeRepository(db));
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------- the setting itself */

describe('the setting', () => {
  it('names the Chief Executive by their employee record', async () => {
    expect(await organisation.chiefExecutiveId()).toBe(people.ceo);
  });

  /* The story's first criterion, as the schema holds it. There is no column anywhere that
     holds the words "Chief Executive Officer", and retitling the post moves nothing. */
  it('and survives the job title being edited', async () => {
    await admin.query('UPDATE employee SET job_title = $1 WHERE id = $2', [
      'Group Chief Executive',
      people.ceo,
    ]);

    expect(await organisation.chiefExecutiveId()).toBe(people.ceo);
  });

  /**
   * The failure this story replaces, and it needs the whole of a succession to show.
   *
   * Before FR 48c the desk was FR 04's root, so a chairman arriving above the Chief Executive
   * moved every unpaid request to them — silently, from a screen about reporting lines. The
   * root really does move here; the setting does not.
   *
   * The swap is the order the line-manager rules migration sets out: the outgoing head is
   * given a manager first, which takes the table to zero rootless rows, and only then is the
   * incoming one's cleared. `employee_one_root` is immediate, so the two cannot be done the
   * other way round.
   *
   * The chairman is hired in a transaction of their own because the cycle check is deferred
   * and walks live rows: an insert naming the Chief Executive as manager is re-checked at
   * commit, by which point the Chief Executive would report to the chairman.
   */
  it('and survives a new head of the organisation arriving above them', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO employee (employee_number, first_name, last_name, work_email, job_title,
                             department_id, manager_id, work_pattern_id, start_date)
       SELECT 'RH-9001', 'Efua', 'Danso', 'efua.danso@rematholdings.com', 'Chairman',
              department_id, id, work_pattern_id, '2026-09-01'
         FROM employee WHERE id = $1
       RETURNING id`,
      [people.ceo],
    );
    const chairman = rows[0].id;

    await admin.query('BEGIN');
    await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [chairman, people.ceo]);
    await admin.query('UPDATE employee SET manager_id = NULL WHERE id = $1', [chairman]);
    await admin.query('COMMIT');

    const root = await admin.query<{ id: string }>(
      'SELECT id FROM employee WHERE manager_id IS NULL',
    );

    expect(root.rows[0].id).toBe(chairman);
    expect(await organisation.chiefExecutiveId()).toBe(people.ceo);
  });

  it('is changed by naming a successor', async () => {
    await settings.nameTheChiefExecutive(asAnAdministrator(), people.opsDirector);

    expect(await organisation.chiefExecutiveId()).toBe(people.opsDirector);
  });
});

/* ------------------------------------------------------ what the schema refuses */

describe('the database', () => {
  /* The whole reason this is a foreign key rather than a setting holding text. */
  it('refuses an id that is nobody’s, on every connection', async () => {
    await expect(
      admin.query('UPDATE organisation_setting SET ceo_employee_id = 999999'),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses somebody who has left', async () => {
    await expect(
      admin.query('UPDATE organisation_setting SET ceo_employee_id = $1', [people.leaver]),
    ).rejects.toMatchObject({ constraint: 'organisation_setting_names_somebody_who_is_here' });
  });

  /* The setting is changed, never cleared: an empty seat is a stage no request can be sent
     to, and a Chief Executive who has left is already routed round by FR 48b. */
  it('refuses the seat being emptied once somebody is in it', async () => {
    await expect(
      admin.query('UPDATE organisation_setting SET ceo_employee_id = NULL'),
    ).rejects.toMatchObject({ constraint: 'organisation_setting_keeps_a_chief_executive' });
  });

  it('refuses the row being deleted', async () => {
    await expect(admin.query('DELETE FROM organisation_setting')).rejects.toThrow();
  });

  it('and holds exactly one row', async () => {
    await expect(
      admin.query('INSERT INTO organisation_setting (ceo_employee_id) VALUES ($1)', [people.ceo]),
    ).rejects.toMatchObject({ constraint: 'organisation_setting_is_one_row' });
  });

  /* The application may edit the row and may never remove it, which is the half of "never
     cleared" that holds against a writer who has found a way past the trigger. */
  it('and lets the application update it but never delete it', async () => {
    const { rows } = await admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'lms_app' AND table_name = 'organisation_setting'
        ORDER BY privilege_type`,
    );

    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});

/* --------------------------------------------------------------- through the door */

describe('naming somebody through the service', () => {
  it('refuses an id that is nobody’s, by name', async () => {
    await expect(settings.nameTheChiefExecutive(asAnAdministrator(), '999999')).rejects.toThrow(
      ChiefExecutiveNotFound,
    );
  });

  it('refuses somebody who has left, and says who', async () => {
    await expect(
      settings.nameTheChiefExecutive(asAnAdministrator(), people.leaver),
    ).rejects.toThrow(ChiefExecutiveHasLeft);
  });

  /* Refused before anything is read, so somebody who may not do this is never told whether
     the id they sent was anybody's. */
  it('refuses anybody but an HR Administrator', async () => {
    await expect(settings.nameTheChiefExecutive(asAnOfficer(), people.opsDirector)).rejects.toThrow(
      NotAuthorised,
    );

    expect(await organisation.chiefExecutiveId()).toBe(people.ceo);
  });

  it('and is readable by anybody signed in', async () => {
    const seen = await settings.settings(asAnEmployee());

    expect(seen.chiefExecutiveId).toBe(people.ceo);
  });
});

/* ---------------------------------------------------------------- before go live */

describe('a database nobody has configured', () => {
  beforeEach(async () => {
    /* TRUNCATE rather than a DELETE, which the trigger refuses. It is the state a fresh
       installation is migrated into: a row with nobody named, or no row at all. */
    await admin.query('TRUNCATE organisation_setting');
  });

  it('is not ready to go live', async () => {
    expect(await settings.isReadyForGoLive(system)).toBe(false);
  });

  it('and says so when somebody asks who the Chief Executive is', async () => {
    await expect(settings.chiefExecutive(system)).rejects.toThrow(NoChiefExecutiveNamed);
  });

  /* And configuring it is one write, which is what "must be set before go live" asks of an
     operator. The row is put back rather than needing a migration re-run. */
  it('and is made ready by an administrator naming somebody', async () => {
    await settings.nameTheChiefExecutive(asAnAdministrator(), people.ceo);

    expect(await settings.isReadyForGoLive(system)).toBe(true);
    expect((await settings.chiefExecutive(system)).id).toBe(people.ceo);
  });
});

/* --------------------------------------------------------------------- the record */

describe('the audit log', () => {
  it('records who moved the Chief Executive, and what they moved it from', async () => {
    await settings.nameTheChiefExecutive(asAnAdministrator(), people.opsDirector);

    const { rows } = await admin.query<{
      action: string;
      actor_employee_id: string;
      before: { ceo_employee_id: string };
      after: { ceo_employee_id: string };
    }>(
      `SELECT action, actor_employee_id, before, after
         FROM audit_log
        WHERE entity = 'organisation_setting'
        ORDER BY id DESC
        LIMIT 1`,
    );

    expect(rows[0].action).toBe('UPDATE');
    expect(rows[0].actor_employee_id).toBe(people.headOfHr);
    expect(rows[0].before.ceo_employee_id).toBe(Number(people.ceo));
    expect(rows[0].after.ceo_employee_id).toBe(Number(people.opsDirector));
  });
});

/* --------------------------------------------------------------------- the people */

function asAnAdministrator() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

function asAnOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asAnEmployee() {
  return signedInAs(people.opsDirector, { roles: ['EMPLOYEE'], isManager: true });
}
