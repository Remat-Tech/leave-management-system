import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { theSystem } from '../../src/auth/actor.js';
import { hashPassword } from '../../src/features/sign-in/password.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../../src/auth/policy.js';
import { problemFor } from '../../src/http/problems.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
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
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The balance screen over HTTP. FR 53. LMS 401.
 *
 * The first test of a route layer in this repository, and it drives the real application
 * over a real socket rather than calling handlers with a fabricated request. That is
 * deliberate and it is the only way two of the claims below can be made at all: a cookie
 * is a header, `SameSite` and `HttpOnly` are attributes of a response, and a middleware
 * mounted in the wrong order is a bug that no unit test of a handler can see.
 *
 * `buildApp` is the same function ../../src/main.ts calls, given this suite's disposable
 * database instead of the pool. There is no second assembly, which is the property that
 * makes this suite evidence about what actually runs.
 *
 * Five claims:
 *
 *   **Nothing is reachable without a session.** The mounting order in `http/app.ts` is
 *   the whole authorisation model of the route layer, and it is asserted rather than read.
 *
 *   **The actor is derived, never accepted.** A request that asks to be somebody is
 *   ignored; a cookie signed with the wrong secret is refused; roles come from the
 *   database on every request rather than from anything the client holds.
 *
 *   **`/me` means me.** There is no way to name anybody else, so FR 55 and FR 56 are not
 *   reachable through this route by construction rather than by a guard being asked.
 *
 *   **Every figure the screen shows is on the wire.** A browser that had to compute one
 *   would be a second implementation of a projection nothing here could check.
 *
 *   **A calendar date stays ten characters.** NFR DAT 03, from the column to the JSON.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Long enough for `sessionSecretFrom`, and nowhere near any real one. */
const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('balances api integration fixtures');

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let balances: BalanceService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: string;
let y2027: string;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const guard = new Guard();
  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const cached = new BalanceRepository(db);

  balances = new BalanceService(cached, guard, employees, new Transactions(db));

  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const requests = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: cached,
    employees,
    types,
    years,
    requests,
    /* Nothing in this suite asks for leave, and the write door is built anyway, because
       `buildApp` is the whole application and a suite that assembled a smaller one would
       stop proving that the balance routes are reachable in the application that ships.
       LMS 403. */
    leaveRequests: new LeaveRequestService(
      balances,
      guard,
      employees,
      types,
      years,
      requests,
      decisions,
      /** FR 48b, LMS 320. */
      new LeaveRoutingRepository(db),
      new RoleRepository(db),
      new OrganisationRepository(db),
      new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
      new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
    ),
    decisions,
    /** FR 48b, LMS 320. */
    routing: new LeaveRoutingRepository(db),
    accounts,
    roles,
    organisation: new OrganisationRepository(db),
    secret: SECRET,
  });

  /* Port 0, so the operating system picks one nothing else is on. A suite that hard coded
     3000 would fail on the machine of anybody who happened to have the application
     running, which is every machine this feature is being worked on. */
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_decision, leave_request_routing, leave_request',
  );
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  y2027 = await yearIdOf('2027');
  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_decision, leave_request_routing, leave_request',
  );
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------- nothing without a session */

describe('the line everything is mounted behind', () => {
  it('answers 401 with no cookie at all', async () => {
    const response = await fetch(`${origin}/api/me/balances`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'NotSignedIn' });
  });

  /* The signature is what makes the id in the cookie a fact rather than a suggestion. A
     secret somebody guessed at is the whole of what this is protecting. */
  it('and 401 for a cookie signed with the wrong secret', async () => {
    const response = await get('/api/me/balances', {
      cookie: mintSession(people.officer, 'a-different-secret-of-at-least-32-characters'),
    });

    expect(response.status).toBe(401);
  });

  it('and 401 for a cookie whose employee id has been edited', async () => {
    const forged = mintSession(people.officer, SECRET).replace(people.officer, people.headOfHr);

    expect((await get('/api/me/balances', { cookie: forged })).status).toBe(401);
  });

  /* Eight hours, and the timestamp is inside the signed payload — so this is not a value
     anybody can push back by editing the cookie. */
  it('and 401 for a session that has run out', async () => {
    const yesterday = new Date(Date.now() - 9 * 60 * 60 * 1000);

    const response = await get('/api/me/balances', {
      cookie: mintSession(people.officer, SECRET, yesterday),
    });

    expect(response.status).toBe(401);
  });

  /**
   * The check that makes a stateless cookie safe enough to ship.
   *
   * There is no session table and nothing to revoke, so the answer to "this person left
   * an hour ago" has to be a read on every request. `whyNotSignIn` is asked with the
   * record, which is the same function the sign in door asks — one rule, so the two
   * cannot drift about who may be in.
   */
  it('and 401 once the employment has ended, whatever the cookie says', async () => {
    const cookie = mintSession(people.officer, SECRET);

    expect((await get('/api/me/balances', { cookie })).status).toBe(200);

    /* Both columns, because `employee_terminated_has_exit_date` refuses a leaver with no
       last day — the record cannot describe somebody who has gone without saying when. */
    await admin.query(
      "UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-08-31' WHERE id = $1",
      [people.officer],
    );

    expect((await get('/api/me/balances', { cookie })).status).toBe(401);
  });

  it('and 401 once the login has been closed', async () => {
    const cookie = mintSession(people.officer, SECRET);

    await admin.query('UPDATE app_user SET is_active = FALSE WHERE employee_id = $1', [
      people.officer,
    ]);

    expect((await get('/api/me/balances', { cookie })).status).toBe(401);
  });

  /* Health is in front of the line on purpose, so that a load balancer does not need a
     session to find out whether the process is up. */
  it('but the health check needs none', async () => {
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  });

  it('and an unknown address under /api is JSON rather than an HTML stack', async () => {
    const response = await get('/api/nothing-here', {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });
});

/* ------------------------------------------------------------ the actor is derived */

describe('who the server thinks you are', () => {
  it('is the employee in the cookie and nothing in the request', async () => {
    const response = await get('/api/me', { cookie: mintSession(people.officer, SECRET) });

    expect(await response.json()).toEqual({
      employeeId: people.officer,
      firstName: 'Adwoa',
      lastName: 'Frimpong',
    });
  });

  /**
   * `/me` cannot be pointed at anybody, and this is the assertion that says so.
   *
   * Both of these would be answered by the balance service — Ama holds `HR_ADMIN` and may
   * read everybody — so a route that read an id from the request would hand back Adwoa's
   * statement here. It does not, because there is no id to read.
   */
  it('and a query parameter naming somebody else changes nothing', async () => {
    const response = await get(`/api/me/balances?employeeId=${people.headOfHr}`, {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(((await response.json()) as { employeeId: string }).employeeId).toBe(people.officer);
  });

  /**
   * The client is told who it is and deliberately not what it holds.
   *
   * A screen that knew its own roles would start deciding what to draw from them, and the
   * day the two disagree the server is right and the page has been lying. Asked of Ama,
   * who holds `HR_ADMIN` — so a leak would actually have something to leak.
   *
   * The exact key list rather than a check for `roles` alone, because the field somebody
   * adds will not necessarily be called that: `isManager`, `permissions` and `canApprove`
   * are all the same mistake wearing a different name.
   */
  it('and is never told which roles it holds', async () => {
    const body = await (
      await get('/api/me', { cookie: mintSession(people.headOfHr, SECRET) })
    ).json();

    expect(Object.keys(body as object).sort()).toEqual(['employeeId', 'firstName', 'lastName']);
  });
});

/* ---------------------------------------------------------------- the statement */

describe('my balances', () => {
  it('answers every leave type with its figures and its counting basis', async () => {
    await grant(people.officer, annualId, 20);

    const statement = await statementFor(people.officer);
    const annual = lineOf(statement, 'ANNUAL');

    expect(statement.employeeId).toBe(people.officer);
    expect(statement.year.label).toBe('2026');
    expect(statement.lines.length).toBeGreaterThan(1);

    expect(annual.entitled).toBe(20);
    expect(annual.carriedOver).toBe(0);
    expect(annual.adjustment).toBe(0);
    expect(annual.taken).toBe(0);
    expect(annual.pending).toBe(0);
    expect(annual.owed).toBe(20);
    expect(annual.available).toBe(20);
    expect(annual.countingBasisLabel).toBe('Working days');
  });

  /**
   * The instruction the whole route exists to honour: nothing is recalculated in a
   * browser. Every number the screen prints has to be on the wire, so this asserts the
   * fields rather than any one value — a field that went missing would be a subtraction
   * the client had to perform.
   */
  it('and puts every figure a screen shows on the wire, so nothing is recomputed', async () => {
    const statement = await statementFor(people.officer);

    for (const line of statement.lines) {
      expect(Object.keys(line).sort()).toEqual(
        [
          'adjustment',
          'allowanceInWords',
          'available',
          'carriedOver',
          'code',
          'countingBasis',
          'countingBasisLabel',
          'entitled',
          'entitlementBasis',
          'hasMoved',
          'isPaid',
          'leaveTypeId',
          'name',
          'owed',
          'pending',
          'stillOffered',
          'taken',
          'unit',
          'updatedAt',
        ].sort(),
      );
    }
  });

  it('offers the years to choose from, and shows the one asked for', async () => {
    await grant(people.officer, annualId, 20);
    await grant(people.officer, annualId, 25, y2027);

    const thisYear = await statementFor(people.officer);
    const nextYear = await statementFor(people.officer, `?leaveYearId=${y2027}`);

    expect(thisYear.years.map((year) => year.label)).toEqual(['2026', '2027']);
    expect(lineOf(thisYear, 'ANNUAL').entitled).toBe(20);
    expect(nextYear.year.label).toBe('2027');
    expect(lineOf(nextYear, 'ANNUAL').entitled).toBe(25);
  });

  /**
   * NFR DAT 03, from the column to the JSON.
   *
   * A leave year runs to a day rather than to an instant, and the driver is configured to
   * hand `date` back as the ten characters it holds. This asserts the route does not undo
   * that — the failure it guards against is somebody adding `new Date(...)` to the
   * serialiser, after which the last day of 2026 reads as the thirtieth of December for
   * anybody west of Greenwich.
   */
  it('and a leave year’s dates stay ten characters with no zone on them', async () => {
    const statement = await statementFor(people.officer);

    expect(statement.year.startDate).toBe('2026-01-01');
    expect(statement.year.endDate).toBe('2026-12-31');

    for (const year of statement.years) {
      expect(year.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(year.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  /* An instant genuinely is an instant, and is the one thing the route converts. */
  it('and an updated timestamp is an instant in UTC', async () => {
    await grant(people.officer, annualId, 20);

    const annual = lineOf(await statementFor(people.officer), 'ANNUAL');

    expect(annual.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(lineOf(await statementFor(people.officer), 'SICK').updatedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------- the refusals */

describe('what a refusal looks like', () => {
  it('answers 404 for a leave year id that is nobody’s', async () => {
    const response = await get('/api/me/balances?leaveYearId=999999', {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('LeaveYearNotFound');
  });

  /**
   * A real year that was never this person's, named through the route.
   *
   * The subject is somebody who starts next year rather than the seed's leaver, and the
   * reason is worth recording: a leaver is `TERMINATED`, `whyNotSignIn` refuses them a
   * session, and `identify` answers 401 before any of this is reached. Which is correct —
   * somebody who has left has no screen at all — and it means the only person who can
   * *reach* this refusal is one who is employed and was not employed then. That is a
   * joiner, so the fixture is one.
   *
   * The sentence names the years that are theirs, which is what a picker offering too much
   * has to tell somebody. NFR USA 03.
   */
  it('and 404 naming the years that are theirs for one that is not', async () => {
    await admin.query("UPDATE employee SET start_date = '2027-02-01' WHERE id = $1", [
      people.officer,
    ]);

    const response = await get(`/api/me/balances?leaveYearId=${y2026}`, {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string; message: string };

    expect(body.error).toBe('NotOneOfTheirLeaveYears');
    expect(body.message).toMatch(/2027/);
  });

  /* And the same joiner's statement opens on the only year they have, rather than on the
     year covering today — which is the fallback `theYearToOpenOn` exists for. */
  it('and opens a joiner on the only year that is theirs', async () => {
    await admin.query("UPDATE employee SET start_date = '2027-02-01' WHERE id = $1", [
      people.officer,
    ]);

    const statement = await statementFor(people.officer);

    expect(statement.years.map((year) => year.label)).toEqual(['2027']);
    expect(statement.year.label).toBe('2027');
  });

  /**
   * The silent refusal, and the status that has to be as vague as its words are.
   *
   * `NOT_AUTHORISED_MESSAGE` is written to be word for word identical to what a record
   * that is not there produces — "two messages that differ are a way of asking the server
   * whether a record exists" — and 403 would undo the whole arrangement in one line,
   * because 403 means "it is there and you may not", which is the fact the sentence
   * declines to state.
   *
   * Asked of `problemFor` directly rather than through a socket, because reaching a silent
   * refusal on this route is impossible by construction: `/me/balances` cannot name
   * anybody else. That is the route being right, and it is why the rule has to be
   * asserted where the next route will inherit it from.
   */
  it('answers a refusal that says nothing with 404 and those exact words', () => {
    const silent = problemFor(
      new NotAuthorised(
        {
          at: new Date(),
          actor: 'employee 7',
          employeeId: '7',
          roles: ['EMPLOYEE'],
          resource: 'ledger',
          action: 'read',
          subject: '11',
          because: 'not their balance',
        },
        null,
      ),
    );

    expect(silent.status).toBe(404);
    expect(silent.body.message).toBe(NOT_AUTHORISED_MESSAGE);
    expect(silent.body.error).toBe('NotFound');
  });

  /* And a refusal that says why has already decided that saying so discloses nothing, so
     it keeps its own sentence and gets the status that admits the record is there. */
  it('and one that says why with 403 and the sentence it was written with', () => {
    const open = problemFor(
      new NotAuthorised(
        {
          at: new Date(),
          actor: 'employee 7',
          employeeId: '7',
          roles: ['EMPLOYEE'],
          resource: 'ledger',
          action: 'adjust',
          subject: '11',
          because: 'holds no role that adjusts balances',
        },
        'A balance adjustment is an HR Administrator’s to post. FR 37.',
      ),
    );

    expect(open.status).toBe(403);
    expect(open.body.message).toMatch(/HR Administrator/);
  });

  /* A repeated parameter is somebody asking two questions, and the answer is the ordinary
     default rather than an error page about a query string. */
  it('and ignores a leave year asked for twice', async () => {
    const response = await get(`/api/me/balances?leaveYearId=${y2026}&leaveYearId=${y2027}`, {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { year: { label: string } }).year.label).toBe('2026');
  });
});

/* -------------------------------------------------------------------- the cookie */

describe('the session cookie', () => {
  it('is set on a successful sign in, HttpOnly and SameSite=Strict', async () => {
    await admin.query('UPDATE app_user SET password_hash = $1 WHERE employee_id = $2', [
      await hashPassword('correct horse battery staple'),
      people.officer,
    ]);

    const response = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'adwoa.frimpong@rematholdings.com',
        password: 'correct horse battery staple',
      }),
    });

    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie') ?? '';

    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
  });

  /* One answer for a wrong password, an address nobody has, and a closed account. The
     sign in form is not a directory of who works here. */
  it('and is not set for a wrong password', async () => {
    const response = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'adwoa.frimpong@rematholdings.com',
        password: 'not the password',
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('and signing out clears it', async () => {
    const response = await fetch(`${origin}/api/session`, {
      method: 'DELETE',
      headers: { cookie: `${SESSION_COOKIE}=${mintSession(people.officer, SECRET)}` },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  });
});

/* ------------------------------------------------------------------------ fixtures */

/** The line format the route publishes. Written out so a change to it is a failing test. */
interface JsonLine {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasis: string;
  countingBasisLabel: string;
  entitlementBasis: string;
  allowanceInWords: string;
  unit: string;
  isPaid: boolean;
  stillOffered: boolean;
  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  owed: number;
  available: number;
  hasMoved: boolean;
  updatedAt: string | null;
}

interface JsonYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  isClosed: boolean;
}

interface JsonStatement {
  employeeId: string;
  year: JsonYear;
  years: JsonYear[];
  lines: JsonLine[];
}

function get(path: string, { cookie }: { cookie: string }): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
}

async function statementFor(employeeId: string, query = ''): Promise<JsonStatement> {
  const response = await get(`/api/me/balances${query}`, {
    cookie: mintSession(employeeId, SECRET),
  });

  expect(response.status).toBe(200);

  return (await response.json()) as JsonStatement;
}

function lineOf(statement: JsonStatement, code: string): JsonLine {
  const line = statement.lines.find((one) => one.code === code);

  if (line === undefined) {
    throw new Error(
      `No line for ${code}. The statement had ${statement.lines
        .map((one) => one.code)
        .join(', ')}.`,
    );
  }

  return line;
}

function grant(employeeId: string, leaveTypeId: string, days: number, leaveYearId = y2026) {
  return balances.grantTheYear(system, {
    employeeId,
    leaveTypeId,
    leaveYearId,
    days,
    reason: 'Entitlement for the year',
  });
}

async function yearIdOf(label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_year WHERE label = $1', [
    label,
  ]);

  return rows[0].id;
}

async function restoreYears(): Promise<void> {
  const columns = Object.keys(seededYears[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${String(index + 1)}`).join(', ');

  await admin.query('TRUNCATE leave_year CASCADE');

  for (const row of seededYears) {
    await admin.query(
      `INSERT INTO leave_year (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('leave_year_id_seq', (SELECT max(id) FROM leave_year))`);
}
