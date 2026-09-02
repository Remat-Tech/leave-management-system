/**
 * Loads a realistic organisation, with the awkward cases already in it.
 *
 * The happy path in this system is easy and mostly works. The defects live at
 * the edges: the person with no manager, the manager who is also somebody's
 * report, the part timer whose week is not Monday to Friday, the leaver whose
 * balance still has to be settled, the lone HR officer with nobody to approve
 * their own leave. Those edges are in the fixture set permanently, so whoever
 * is building trips over them early rather than in production.
 *
 * Technical Design Document section 12.
 *
 * Plain JavaScript rather than TypeScript so it runs under `node` with no build
 * step and no loader, the same choice as scripts/mailpit.mjs.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

export const SCENARIOS = ['base', 'lone-hr'];

/**
 * Tables the seed owns.
 *
 * `role` is reference data and belongs to the migration. So, since LMS 106, is
 * the standard Monday to Friday working pattern: a production database is
 * migrated and never seeded, and no employee can be created without a default
 * pattern to stand in when nobody names one. work_pattern is therefore not
 * truncated here — doing so would delete reference data every time somebody
 * reloaded the fixtures — and the extra patterns this file does own are cleared
 * by name in insertWorkPatterns().
 *
 * `audit_log` is here since LMS 113, and it is the one entry in this list that
 * deserves an argument rather than a mention.
 *
 * Nothing may update or delete a row in it, on any connection — that is NFR AUD
 * 02 and the point of the whole table. TRUNCATE is not either of those and no row
 * trigger sees it, which is the same latitude `employee` has and for the same
 * reason: emptying a table on purpose, on the owner connection, is not the
 * failure an audit trail exists to prevent. Losing one entry quietly is.
 *
 * It has to be here, because the fixtures being reloaded are the fixtures being
 * reloaded: an account of how the organisation got here is meaningless when the
 * organisation was replaced wholesale a second ago, and leaving the entries
 * behind would leave every integration run reading the previous run's history.
 * A production database is migrated and never seeded, so nothing here can reach
 * a real audit log.
 *
 * `leave_entitlement_rule` is here since LMS 203 and is not owned by this file at
 * all, which is why it is named rather than left to happen.
 *
 * A rule may name an employee, so the table has a foreign key to `employee` — and
 * TRUNCATE ... CASCADE empties every referencing table wholesale rather than the
 * rows that actually point at what was cleared. The statutory figures would
 * therefore disappear on every fixture reload whether or not this list mentioned
 * them; naming it here makes that deliberate, and restoreReferenceData() below
 * puts the figures back by calling the function the migration owns them with.
 * Nothing in this file knows what annual leave is worth, and nothing here should.
 */
const SEEDED_TABLES = [
  'audit_log',
  'user_role',
  'app_user',
  'employee',
  'department',
  'leave_entitlement_rule',
];

/**
 * Loads the fixture set. Clears what it owns first, so running it twice gives
 * the same organisation rather than a second copy of it.
 *
 * @param {import('pg').Client} db
 * @param {{ scenario?: 'base' | 'lone-hr' }} [options]
 */
export async function seed(db, { scenario = 'base' } = {}) {
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`Unknown scenario "${scenario}". Try one of: ${SCENARIOS.join(', ')}.`);
  }

  await db.query('BEGIN');
  try {
    await db.query(`TRUNCATE ${SEEDED_TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    await restoreReferenceData(db);

    const departments = await insertDepartments(db);
    const patterns = await insertWorkPatterns(db);
    const people = await insertEmployees(db, { departments, patterns, scenario });
    await grantLogins(db, people, scenario);

    await db.query('COMMIT');
    return people;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

/**
 * Puts back the reference data the truncate above took with it. LMS 203, LMS 401.
 *
 * Two calls, and deliberately not a list of figures. The seven leave types and the
 * figures they carry belong to the migrations — LMS 202, LMS 203 and LMS 401 — and
 * a copy of "annual leave is twenty days" in this file would be a second source for
 * a number that has to have exactly one. Both functions insert what is missing and
 * leave alone anything HR has since set, so calling them on a database where
 * nothing was lost does nothing at all.
 *
 * `ensure_unpaid_entitlement_rules()` is the second because the first is merged and
 * is never edited. It carries the two figures that migration deliberately left out —
 * unpaid leave and the unpaid maternity extension — and it has to be called here for
 * the same reason its sibling does: this file truncates `leave_entitlement_rule`, so
 * a figure only a migration ever wrote would vanish on the next reload and never
 * come back.
 *
 * The leave types themselves survive the truncate — nothing this file clears is
 * referenced by them — so they need no equivalent call. If that ever changes,
 * `ensure_statutory_leave_types()` is the one to add beside these.
 *
 * This is an owner connection, which the functions require: EXECUTE on all of them
 * is revoked from PUBLIC, because restoring reference data is an operator's job and
 * not something the application should be able to do by being connected.
 *
 * @param {import('pg').Client} db
 */
async function restoreReferenceData(db) {
  await db.query('SELECT ensure_statutory_entitlement_rules()');
  await db.query('SELECT ensure_unpaid_entitlement_rules()');
}

async function insertDepartments(db) {
  // Product has no settled home yet. It sits with Engineering for the moment
  // and may become its own department later, which is a row in this table and
  // a change of department_id rather than anything structural.
  const names = [
    'Executive',
    'Commercial',
    'Product & Engineering',
    'Human Resources and Administration',
    'Operations',
    'Finance',
  ];

  const { rows } = await db.query(
    'INSERT INTO department (name) SELECT unnest($1::text[]) RETURNING id, name',
    [names],
  );

  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
}

/**
 * The patterns the fixture organisation works.
 *
 * The standard week is not created here and is not deleted here. It is reference
 * data, inserted by the working-pattern-rules migration next to `role`, and a
 * database that has been migrated already has it — including the one an HR
 * officer will use in production, which nothing ever seeds. FR 23.
 *
 * What the seed owns is the second pattern, which exists to make the counting
 * tests honest rather than to make the system work. It is cleared by "everything
 * that is not the default" rather than truncated, so that reloading the fixtures
 * twice gives the same two patterns instead of a second copy of one of them.
 */
async function insertWorkPatterns(db) {
  const { rows } = await db.query('SELECT id FROM work_pattern WHERE is_default');

  if (rows.length !== 1) {
    throw new Error(
      `Expected exactly one default working pattern and found ${rows.length}. The ` +
        'standard Monday to Friday week is inserted by the working-pattern-rules ' +
        'migration; run `npm run migrate up` before seeding. FR 23.',
    );
  }

  // Everything the seed added last time. The default is left where it is, and
  // the employee rows that pointed at either are already gone with the truncate.
  await db.query('DELETE FROM work_pattern WHERE NOT is_default');

  // Wednesdays off. The counting tests in Technical Design Document section 7.3
  // need a pattern that is not simply "weekends off", or a bug that assumes
  // Saturday and Sunday are the only non working days passes every test.
  const partTime = await insertPattern(db, 'Part time, Wednesdays off', [1, 2, 4, 5]);

  return { standard: rows[0].id, partTime };
}

/**
 * One pattern and its whole week.
 *
 * Never the default: exactly one pattern is, it is the standard week the
 * migration inserted, and moving that is a decision rather than fixture data.
 */
async function insertPattern(db, name, workingDays) {
  const { rows } = await db.query('INSERT INTO work_pattern (name) VALUES ($1) RETURNING id', [
    name,
  ]);
  const id = rows[0].id;

  /* All seven days in one statement. The database is usually a Neon branch at
     the end of a network, where a round trip costs far more than the work — and
     seven rows rather than four is what work_pattern_week_complete requires: a
     day that is not worked is a row saying so, not a missing row. */
  await db.query(
    `INSERT INTO work_pattern_day (work_pattern_id, day_of_week, is_working_day)
     SELECT $1, day, day = ANY($2::int[]) FROM generate_series(1, 7) AS day`,
    [id, workingDays],
  );

  return id;
}

async function insertEmployees(db, { departments, patterns, scenario }) {
  const people = {};

  const add = async (key, person) => {
    const { rows } = await db.query(
      `INSERT INTO employee (
         employee_number, first_name, last_name, work_email, job_title,
         department_id, manager_id, work_pattern_id, start_date, exit_date,
         employment_type, employment_status, gender
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        person.number,
        person.firstName,
        person.lastName,
        person.email,
        person.jobTitle,
        person.department ?? null,
        person.manager ?? null,
        person.pattern ?? patterns.standard,
        person.startDate,
        person.exitDate ?? null,
        person.employmentType ?? 'FULL_TIME',
        person.status ?? 'ACTIVE',
        person.gender ?? null,
      ],
    );
    people[key] = rows[0].id;
    return rows[0].id;
  };

  // ---------------------------------------------------------------- level 1
  // The root of the tree, and the only employee permitted no manager, FR 04.
  // Every routing decision that walks upward has to stop here.
  const ceo = await add('ceo', {
    number: 'RH-0001',
    firstName: 'Kwame',
    lastName: 'Asante',
    email: 'kwame.asante@rematholdings.com',
    jobTitle: 'Chief Executive Officer',
    department: departments.Executive,
    manager: null,
    startDate: '2014-02-03',
    gender: 'MALE',
  });

  // ---------------------------------------------------------------- level 2
  const headOfHr = await add('headOfHr', {
    number: 'RH-0002',
    firstName: 'Ama',
    lastName: 'Mensah',
    email: 'ama.mensah@rematholdings.com',
    jobTitle: 'Head of Human Resources and Administration',
    department: departments['Human Resources and Administration'],
    manager: ceo,
    startDate: '2016-06-13',
    gender: 'FEMALE',
  });

  const opsDirector = await add('opsDirector', {
    number: 'RH-0003',
    firstName: 'Yaw',
    lastName: 'Boateng',
    email: 'yaw.boateng@rematholdings.com',
    jobTitle: 'Director of Operations',
    department: departments.Operations,
    manager: ceo,
    startDate: '2017-01-09',
    gender: 'MALE',
  });

  await add('commercialDirector', {
    number: 'RH-0004',
    firstName: 'Nana',
    lastName: 'Owusu-Ansah',
    email: 'nana.owusu-ansah@rematholdings.com',
    jobTitle: 'Commercial Director',
    department: departments.Commercial,
    manager: ceo,
    startDate: '2018-05-21',
    gender: 'MALE',
  });

  const headOfEngineering = await add('headOfEngineering', {
    number: 'RH-0005',
    firstName: 'Selorm',
    lastName: 'Adjei',
    email: 'selorm.adjei@rematholdings.com',
    jobTitle: 'Head of Product & Engineering',
    department: departments['Product & Engineering'],
    manager: ceo,
    startDate: '2020-02-17',
    gender: 'FEMALE',
  });

  await add('financeManager', {
    number: 'RH-0006',
    firstName: 'Efe',
    lastName: 'Danquah',
    email: 'efe.danquah@rematholdings.com',
    jobTitle: 'Finance Manager',
    department: departments.Finance,
    manager: ceo,
    startDate: '2019-10-07',
    gender: 'FEMALE',
  });

  // ---------------------------------------------------------------- level 3
  // Approves her reports' leave and has her own approved by Yaw, which is the
  // case that breaks any code assuming approvers and employees are two
  // disjoint sets of people.
  const opsManager = await add('opsManager', {
    number: 'RH-0007',
    firstName: 'Akosua',
    lastName: 'Darko',
    email: 'akosua.darko@rematholdings.com',
    jobTitle: 'Operations Manager',
    department: departments.Operations,
    manager: opsDirector,
    startDate: '2019-03-18',
    gender: 'FEMALE',
  });

  await add('engineer', {
    number: 'RH-0008',
    firstName: 'Yram',
    lastName: 'Kudjo',
    email: 'yram.kudjo@rematholdings.com',
    jobTitle: 'Senior Software Engineer',
    department: departments['Product & Engineering'],
    manager: headOfEngineering,
    startDate: '2023-02-06',
    gender: 'FEMALE',
  });

  // Present only in the base scenario. See the note on grantLogins.
  if (scenario === 'base') {
    await add('hrOfficer', {
      number: 'RH-0009',
      firstName: 'Efua',
      lastName: 'Owusu',
      email: 'efua.owusu@rematholdings.com',
      jobTitle: 'HR Officer',
      department: departments['Human Resources and Administration'],
      manager: headOfHr,
      startDate: '2021-09-06',
      gender: 'FEMALE',
    });
  }

  // ---------------------------------------------------------------- level 4
  // Also both a manager and a report, one level further down, so the hierarchy
  // is genuinely five deep rather than four with a flourish.
  const teamLead = await add('teamLead', {
    number: 'RH-0010',
    firstName: 'Kofi',
    lastName: 'Boateng',
    email: 'kofi.boateng@rematholdings.com',
    jobTitle: 'Operations Team Lead',
    department: departments.Operations,
    manager: opsManager,
    startDate: '2022-04-25',
    gender: 'MALE',
  });

  // ---------------------------------------------------------------- level 5
  await add('officer', {
    number: 'RH-0011',
    firstName: 'Adwoa',
    lastName: 'Frimpong',
    email: 'adwoa.frimpong@rematholdings.com',
    jobTitle: 'Operations Officer',
    department: departments.Operations,
    manager: teamLead,
    startDate: '2023-08-14',
    gender: 'FEMALE',
  });

  // Works Monday, Tuesday, Thursday, Friday. A week of leave costs her four
  // days rather than five, and a Wednesday public holiday costs her nothing.
  await add('partTimer', {
    number: 'RH-0012',
    firstName: 'Abena',
    lastName: 'Sarpong',
    email: 'abena.sarpong@rematholdings.com',
    jobTitle: 'Operations Officer',
    department: departments.Operations,
    manager: teamLead,
    pattern: patterns.partTime,
    startDate: '2024-01-15',
    employmentType: 'PART_TIME',
    gender: 'FEMALE',
  });

  // Left in July. Still here because leave history has to survive the person
  // leaving, FR 06, and because the leaver figure of FR 37a is calculated from
  // exactly this shape of record.
  await add('leaver', {
    number: 'RH-0013',
    firstName: 'Kojo',
    lastName: 'Antwi',
    email: 'kojo.antwi@rematholdings.com',
    jobTitle: 'Operations Officer',
    department: departments.Operations,
    manager: teamLead,
    startDate: '2022-11-07',
    exitDate: '2026-07-31',
    status: 'TERMINATED',
    gender: 'MALE',
  });

  return people;
}

/**
 * Gives everybody a login and hands out the HR roles.
 *
 * MANAGER is not among them. Being a manager is a relationship, not a role: you
 * are one if somebody has your id as their manager_id.
 *
 * The scenarios differ only in the size of the HR function:
 *
 *   base     Ama and Efua both hold HR roles, so an HR person's own request
 *            always has a colleague who can decide it.
 *   lone-hr  Ama is the entire HR function. Her own leave has nobody in HR to
 *            approve it and must fall to the CEO instead, which is the
 *            reciprocal routing of FR 48b and Technical Design Document 8.6a.
 *            Get it wrong and an HR officer approves their own leave.
 */
async function grantLogins(db, people, scenario) {
  // One login per employee, in one statement rather than one per person.
  //
  // EMPLOYEE is not granted here and no longer needs to be. Since LMS 111 the
  // app_user_holds_the_baseline_role trigger gives it to every login as it is
  // created, which is what makes it true of a production database as well —
  // production is migrated and never seeded, so a grant that lived only in this
  // file was a rule that held nowhere it mattered.
  await db.query(
    'INSERT INTO app_user (employee_id, company_email) SELECT id, work_email FROM employee',
  );

  const grantRole = (employeeId, code) =>
    db.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT u.id, r.id FROM app_user u, role r
        WHERE u.employee_id = $1 AND r.code = $2`,
      [employeeId, code],
    );

  await grantRole(people.headOfHr, 'HR_ADMIN');

  if (scenario === 'base') {
    await grantRole(people.hrOfficer, 'HR_OFFICER');
  }
}

/** Entry point for `npm run seed`. */
async function main() {
  loadEnv();

  const flag = process.argv.indexOf('--scenario');
  const scenario = flag === -1 ? 'base' : (process.argv[flag + 1] ?? 'base');

  // The owner connection, not the application one. Seeding truncates, and
  // lms_app deliberately holds neither TRUNCATE nor DELETE on employee.
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    throw new Error('DATABASE_MIGRATION_URL is not set. See .env.example.');
  }

  const db = new Client({ connectionString });
  await db.connect();

  try {
    await seed(db, { scenario });

    const { rows } = await db.query(
      `SELECT count(*)::int AS people,
              count(*) FILTER (WHERE manager_id IS NULL)::int AS rootless,
              count(*) FILTER (WHERE employment_status = 'TERMINATED')::int AS leavers,
              count(*) FILTER (WHERE employment_type = 'PART_TIME')::int AS part_time
         FROM employee`,
    );
    const s = rows[0];

    process.stdout.write(
      `Seeded the "${scenario}" organisation: ${s.people} people, ` +
        `${s.rootless} without a manager, ${s.part_time} part time, ${s.leavers} leaver.\n`,
    );
  } finally {
    await db.end();
  }
}

// Only when run directly, so that tests can import seed() without it connecting.
if (process.argv[1]?.endsWith('seed.mjs')) {
  await main();
}
