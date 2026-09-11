import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { LedgerRepository } from '../../src/features/balance/ledger.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { SignInAccountRepository } from '../../src/features/sign-in/sign-in-account.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { buildApp } from '../../src/http/app.js';
import { mintSession, SESSION_COOKIE } from '../../src/features/sign-in/session-cookie.routes.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { signedInAs } from '../../src/auth/actor.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * The holiday calendar screen, over HTTP. FR 22, LMS 504.
 *
 * ./holiday.test.ts proves the table, the one-per-day index and the settled-year trigger
 * against a real database, and ../unit/holiday.test.ts proves what a holiday is. What is
 * only checkable here is the claim the *screen* makes:
 *
 *   **A holiday declared this morning can be entered this morning.** Add, edit and remove
 *   all reach the calendar over HTTP, without a deployment and without a psql prompt.
 *
 *   **Every refusal arrives as a sentence somebody can act on.** A day already taken names
 *   the holiday that is on it; a day in a closed year names the earliest day still open.
 *   Both were reaching a browser as "something went wrong at our end" until this story,
 *   because neither had a status in `REFUSED_BY_A_RULE`.
 *
 *   **Reading is everybody's and writing is HR's**, decided by `holidayPolicy` rather than
 *   by where the router is mounted, and both answered in the server's own words.
 *
 * `buildApp` is the same function ../../src/main.ts calls. There is no second assembly.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Long enough for `sessionSecretFrom`, and nowhere near any real one. */
const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let years: LeaveYearService;
let yearRepository: LeaveYearRepository;
let people: Record<string, string>;

/** The calendar and the years as the migration left them, before anything touched either. */
let seededHolidays: Record<string, unknown>[];
let seededYears: Record<string, unknown>[];

/** One day in the first seeded year, well clear of the fourteen gazetted ones. */
const MID_YEAR = '2026-07-14';

/** What the screen shows for a day that has one, so a JSON assertion can name it. */
interface JsonHoliday {
  id: string;
  name: string;
  date: string;
  inWords: string;
  weekday: string;
  leaveYearId: string | null;
  leaveYearLabel: string | null;
  mayBeChanged: boolean;
  fixedReason: string | null;
}

interface JsonCalendar {
  holidays: JsonHoliday[];
  years: { id: string; label: string; isClosed: boolean }[];
  yearsAwaitingACalendar: { label: string }[];
  today: string;
  earliestOpenDay: string | null;
  closedYearsInWords: string;
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  yearRepository = new LeaveYearRepository(db);
  years = new LeaveYearService(yearRepository, guard);

  const balances = new BalanceService(
    new BalanceRepository(db),
    guard,
    employees,
    new Transactions(db),
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    /** FR 27, FR 37, LMS 506. The ledger the adjustment screen reads, and the door it writes through. */
    ledger: new LedgerRepository(db),
    adjustments: balances,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years: yearRepository,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: requestRepository,
    leaveRequests: new LeaveRequestService(
      balances,
      guard,
      employees,
      types,
      yearRepository,
      requestRepository,
      decisions,
      new LeaveRoutingRepository(db),
      new WithdrawalRepository(db),
      /** FR 32c, LMS 507. */
      new ReclassificationRepository(db),
      new AttachmentRepository(db),
      new RoleRepository(db),
      delegationService(db, guard),
      new OrganisationRepository(db),
      new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
      new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
    ),
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
    storage: new InMemoryStorage(),
    scanner: new SignatureScanner(),
    accounts,
    roles,
    delegations: delegationService(db, guard),
    organisation: new OrganisationRepository(db),
    secret: SECRET,
  });

  /* Port 0, so the operating system picks one nothing else is on. */
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  seededHolidays = (await admin.query('SELECT * FROM holiday ORDER BY holiday_date')).rows;
  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

/**
 * Both tables back as the migration left them, years first.
 *
 * The same restore ./holiday.test.ts uses and for the same reason: half these tests close a
 * leave year, and neither a closed year nor a holiday inside one can be deleted by anybody.
 */
beforeEach(async () => {
  await restore('leave_year', seededYears);
  await restore('holiday', seededHolidays);

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await restore('leave_year', seededYears);
  await restore('holiday', seededHolidays);

  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------- nothing without a session */

describe('the line everything is mounted behind', () => {
  it('answers 401 for reading the calendar and for adding a day', async () => {
    expect((await fetch(`${origin}/api/holidays`)).status).toBe(401);

    const added = await fetch(`${origin}/api/holidays`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Day of national mourning', date: MID_YEAR }),
    });

    expect(added.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ who may do what */

describe('who keeps the calendar', () => {
  /**
   * Unlike the entitlement rules of LMS 502, the whole calendar is everybody's to read: it
   * is what a leave quote is priced against, and the person who most needs to know the
   * office is shut on the sixth of March is the one about to book it as leave.
   */
  it('answers anybody signed in with the calendar and the vocabulary a form needs', async () => {
    const calendar = await calendarFor(people.officer);

    expect(calendar.holidays.length).toBe(14);
    expect(calendar.years.length).toBeGreaterThan(0);
    expect(calendar.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calendar.closedYearsInWords).toContain('No leave year has been closed');

    /* The date, the day of the week and the year it is filed under, all decided by the
       server — a browser that computed a weekday from ten characters would be parsing a
       calendar date, which is the off-by-one NFR DAT 03 exists to prevent. */
    expect(calendar.holidays.find((one) => one.date === '2026-03-06')).toMatchObject({
      name: 'Independence Day',
      inWords: '6 March 2026',
      weekday: 'Friday',
      leaveYearLabel: '2026',
      mayBeChanged: true,
      fixedReason: null,
    });
  });

  it('refuses an ordinary employee the writes, and says who to ask', async () => {
    const refused = await send('POST', '/api/holidays', people.officer, {
      name: 'Day of national mourning',
      date: MID_YEAR,
    });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain('HR Officer');

    /* And nothing was written. A refusal that half applied would be worse than one that
       said nothing at all. */
    expect(await daysInTheTable(MID_YEAR)).toEqual([]);
  });

  /** FR 22 names the HR Officer, so the officer is the one the story is written for. */
  it('lets an HR Officer add a day', async () => {
    const added = await send('POST', '/api/holidays', people.hrOfficer, {
      name: 'Day of national mourning',
      date: MID_YEAR,
    });

    expect(added.status).toBe(201);
    expect(await daysInTheTable(MID_YEAR)).toEqual(['Day of national mourning']);
  });
});

/* ------------------------------------------ a day declared after the year began. FR 22 */

describe('entering a holiday the day it is announced', () => {
  /* The case the story exists for. A day of national mourning, an election day, or the
     Monday the Minister declares because Boxing Day falls on a Saturday. None of them are
     known when the year starts, and none of them may wait for a release. */
  it('adds it, and the whole calendar carries it at once', async () => {
    const added = await add({ name: 'Day of national mourning', date: MID_YEAR });

    expect(added).toMatchObject({
      name: 'Day of national mourning',
      date: MID_YEAR,
      inWords: '14 July 2026',
      leaveYearLabel: '2026',
      mayBeChanged: true,
    });

    const calendar = await calendarFor(people.headOfHr);

    expect(calendar.holidays.length).toBe(15);
    /* In the order the days fall, which is the order every calendar shows them. */
    expect(calendar.holidays.map((one) => one.date)).toEqual(
      [...calendar.holidays.map((one) => one.date)].sort(),
    );
  });

  /**
   * The refusal the class was written for, and what makes it actionable: the answer is
   * almost always to rename the row that is there, which needs the row that is there named.
   */
  it('refuses a second day on a day that is taken, and names the one that is on it', async () => {
    const refused = await send('POST', '/api/holidays', people.hrOfficer, {
      name: 'Founders Day again',
      date: '2026-08-04',
    });

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('DuplicateHoliday');
    expect(problem.message).toContain("Founders' Day");
    expect(problem.message).toContain('Rename the one that is there');
  });

  /** NFR USA 03. The field a form puts the sentence beside. */
  it('refuses a blank name against the name box', async () => {
    const refused = await send('POST', '/api/holidays', people.hrOfficer, {
      name: '   ',
      date: MID_YEAR,
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'InvalidHoliday', field: 'name' });
  });

  it('refuses a date that is not written as one, against the date box', async () => {
    const refused = await send('POST', '/api/holidays', people.hrOfficer, {
      name: 'Independence Day',
      date: '06/03/2027',
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'InvalidHoliday', field: 'date' });
  });
});

/* --------------------------------------------------- editing, which the moon requires */

describe('correcting a day', () => {
  /* Why "edit" is an acceptance criterion rather than a courtesy: Eid al-Fitr and Eid
     al-Adha are fixed by the Minister after the moon is sighted, and whatever the calendar
     was seeded with is a projection until then. */
  it('moves a projected feast to the day the gazette fixed', async () => {
    const eid = await holidayNamed('Eid al-Fitr');

    const moved = await send('PATCH', `/api/holidays/${eid.id}`, people.hrOfficer, {
      date: '2026-03-21',
    });

    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      name: 'Eid al-Fitr',
      date: '2026-03-21',
      weekday: 'Saturday',
    });
  });

  /** Only what is sent changes: a rename must not drag the date along with it. */
  it('renames a day without moving it', async () => {
    const eid = await holidayNamed('Eid al-Adha');

    const renamed = await send('PATCH', `/api/holidays/${eid.id}`, people.hrOfficer, {
      name: 'Eid ul-Adha',
    });

    expect(await renamed.json()).toMatchObject({ name: 'Eid ul-Adha', date: eid.date });
  });

  it('answers 404 for a day that is nobody', async () => {
    const missing = await send('PATCH', '/api/holidays/999999', people.hrOfficer, {
      name: 'Nothing',
    });

    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('HolidayNotFound');
  });
});

/* ------------------------------------------------------------------------- removing */

describe('taking a day off the calendar', () => {
  /* A holiday declared and then withdrawn, or one entered against the wrong date. Without
     this the first mistake would be permanent. */
  it('removes it, and the day is a working day again', async () => {
    const eid = await holidayNamed('Eid al-Fitr');

    const removed = await send('DELETE', `/api/holidays/${eid.id}`, people.hrOfficer);

    expect(removed.status).toBe(204);
    expect(await daysInTheTable(eid.date)).toEqual([]);
  });

  /** The refusal names the act, which is what makes it different from the one above. */
  it('refuses an ordinary employee, and says what removing one would do', async () => {
    const eid = await holidayNamed('Eid al-Fitr');

    const refused = await send('DELETE', `/api/holidays/${eid.id}`, people.officer);

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain(
      'makes it a working day again',
    );

    expect(await daysInTheTable(eid.date)).toEqual(['Eid al-Fitr']);
  });
});

/* --------------------------------------------- last year is not rewritten by a form */

describe('a leave year that has been settled', () => {
  /**
   * Every request over a day in a closed year was counted against the calendar as it stood,
   * and a closed year is never recalculated. So all three verbs are refused for it — and
   * over HTTP, with a status and a sentence rather than as a five hundred.
   */
  it('carries the boundary on the list, so a date picker can stop somebody first', async () => {
    await aSettledYear();

    const calendar = await calendarFor(people.headOfHr);

    expect(calendar.earliestOpenDay).toBe('2026-01-01');
    expect(calendar.closedYearsInWords).toContain('closed up to 1 January 2026');
  });

  it('refuses a day added to it, and names the earliest day still open', async () => {
    await aSettledYear();

    const refused = await send('POST', '/api/holidays', people.hrOfficer, {
      name: 'Something in 2025',
      date: '2025-06-01',
    });

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('HolidayInASettledYear');
    expect(problem.message).toContain('2026-01-01');

    expect(await daysInTheTable('2025-06-01')).toEqual([]);
  });

  /**
   * A day inside a closed year, on the list, marked so the screen greys its buttons on the
   * server's answer rather than on its own arithmetic.
   */
  it('marks a day inside it as fixed, with the sentence saying why', async () => {
    /* Written before the year is closed, and on the owner connection. Afterwards every door
       the application has is shut for it, which is the point — this test is about how the
       *list* reports a day nothing can touch any more. */
    await admin.query(
      `INSERT INTO holiday (name, holiday_date) VALUES ('Christmas Day 2025', DATE '2025-12-25')`,
    );
    await aSettledYear();

    const christmas = await holidayNamed('Christmas Day 2025');

    expect(christmas.mayBeChanged).toBe(false);
    expect(christmas.fixedReason).toContain('has been closed');
    expect(christmas.fixedReason).toContain('1 January 2026');
    expect(christmas.leaveYearLabel).toBe('2025');
  });
});

/* -------------------------------------------- a year nobody has transcribed the gazette for */

describe('a leave year with no calendar at all', () => {
  /**
   * The one thing on this screen that could hurt somebody quietly. Two of Ghana's fourteen
   * holidays cannot be known for a future year, so only 2026 is seeded — and a year with no
   * holidays in it is not a year with no holidays. Everybody in it is charged a day for
   * Christmas until somebody enters one, and HR should see that before December.
   */
  it('names the years awaiting one, and stops the moment a day is entered', async () => {
    const before = await calendarFor(people.headOfHr);

    expect(before.yearsAwaitingACalendar.map((one) => one.label)).toContain('2027');

    await add({ name: 'Christmas Day', date: '2027-12-25' });

    const after = await calendarFor(people.headOfHr);

    expect(after.yearsAwaitingACalendar.map((one) => one.label)).not.toContain('2027');
  });
});

/* ------------------------------------------------------------------------- fixtures */

/** 2025, closed, so the settled-year rules have something to hold. */
async function aSettledYear(): Promise<void> {
  await admin.query(
    `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
  );

  const y2025 = await years.byLabel(asAdministrator(), '2025');

  expect(y2025, 'no leave year called 2025').toBeDefined();

  await years.close(asAdministrator(), y2025!.id);
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: false });
}

/** A day by the one door that writes one. */
async function add(fields: Record<string, unknown>): Promise<JsonHoliday> {
  const response = await send('POST', '/api/holidays', people.hrOfficer, fields);

  expect(response.status).toBe(201);

  return (await response.json()) as JsonHoliday;
}

/** One day off the list, which is the only place the screen's fields are assembled. */
async function holidayNamed(name: string, on?: string): Promise<JsonHoliday> {
  const found = (await calendarFor(people.headOfHr)).holidays.find(
    (one) => one.name === name && (on === undefined || one.date === on),
  );

  expect(found, `no holiday called ${name}`).toBeDefined();

  return found!;
}

async function calendarFor(employeeId: string): Promise<JsonCalendar> {
  const response = await get('/api/holidays', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonCalendar;
}

async function daysInTheTable(date: string): Promise<string[]> {
  const { rows } = await admin.query<{ name: string }>(
    'SELECT name FROM holiday WHERE holiday_date = $1',
    [date],
  );

  return rows.map((row) => row.name);
}

/**
 * A table as the migration left it.
 *
 * TRUNCATE rather than DELETE, and for the reason ./holiday.test.ts gives: a closed year
 * refuses to be deleted by anybody, as does a holiday inside one, and a row trigger does not
 * fire on TRUNCATE. The years go back first, because a holiday inside a closed one cannot be
 * written while that year is still there.
 */
async function restore(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const columns = Object.keys(rows[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await admin.query(`TRUNCATE ${table} CASCADE`);

  for (const row of rows) {
    await admin.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('${table}_id_seq', (SELECT max(id) FROM ${table}))`);
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

function send(
  method: string,
  path: string,
  employeeId: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
