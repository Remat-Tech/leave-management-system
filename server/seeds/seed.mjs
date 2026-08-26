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

/** Tables the seed owns. `role` is reference data and belongs to the migration. */
const SEEDED_TABLES = [
  'user_role',
  'app_user',
  'employee',
  'work_pattern_day',
  'work_pattern',
  'department',
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

async function insertWorkPatterns(db) {
  const standard = await insertPattern(db, 'Standard Mon-Fri', true, [1, 2, 3, 4, 5]);

  // Wednesdays off. The counting tests in Technical Design Document section 7.3
  // need a pattern that is not simply "weekends off", or a bug that assumes
  // Saturday and Sunday are the only non working days passes every test.
  const partTime = await insertPattern(db, 'Part time, Wednesdays off', false, [1, 2, 4, 5]);

  return { standard, partTime };
}

async function insertPattern(db, name, isDefault, workingDays) {
  const { rows } = await db.query(
    'INSERT INTO work_pattern (name, is_default) VALUES ($1, $2) RETURNING id',
    [name, isDefault],
  );
  const id = rows[0].id;

  // All seven days in one statement. The database is usually a Neon branch at
  // the end of a network, where a round trip costs far more than the work.
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
  // One login per employee, and EMPLOYEE for all of them, in two statements
  // rather than two per person.
  await db.query(
    'INSERT INTO app_user (employee_id, company_email) SELECT id, work_email FROM employee',
  );

  await db.query(
    `INSERT INTO user_role (user_id, role_id)
     SELECT u.id, r.id FROM app_user u CROSS JOIN role r WHERE r.code = 'EMPLOYEE'`,
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
