import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { type Actor, signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
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
 * My request history over HTTP. FR 54. LMS 402.
 *
 * ../unit/request-history.test.ts proves the arrangement — which steps, in which order, with
 * which sentence — without a database, because all of it is pure. This suite is for the four
 * claims that arrangement cannot make on its own:
 *
 *   **The rows are the ones a real approval produced.** Every fixture below goes through
 *   `LeaveRequestService`, so the statuses, the desks and the decisions are what the state
 *   machine and the approval chain actually wrote rather than what a test made up. A trail
 *   assembled correctly from invented rows would prove nothing about the screen.
 *
 *   **A comment survives the round trip verbatim.** FR 39, and it is the story's second
 *   criterion: the sentence a manager types is the only account of that decision anybody will
 *   have next year, and it passes through a column, a domain type, a JSON body and a socket.
 *
 *   **`/me` means me.** There is no way to name anybody else, so FR 55 and FR 56 are not
 *   reachable through this route by construction rather than by a guard being asked.
 *
 *   **The mounting order.** A route added behind `identify` cannot be reached without a
 *   session, and that is asserted rather than read off `http/app.ts`.
 *
 * `buildApp` is the same function ../../src/main.ts calls, given this suite's disposable
 * database. There is no second assembly.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Long enough for `sessionSecretFrom`, and nowhere near any real one. */
const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('requests api integration fixtures');
const guard = new Guard();

/**
 * What a manager says when they turn leave down. FR 39.
 *
 * Two lines, with an apostrophe and a newline in them, because the assertion below is that
 * this arrives *unchanged*. A one word comment would satisfy the constraint and prove nothing
 * about what the person who was turned down is left holding.
 */
const WHY_NOT =
  'Two of the team are already away that week and the desk can’t be empty.\nAsk again for April.';

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let balances: BalanceService;
let requests: LeaveRequestService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: string;
let y2027: string;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));

  /* The fixtures go through the real write door, not through `admin`. A request inserted by
     hand would have no RESERVATION, and the deferred trigger would refuse it at COMMIT — which
     is the schema saying, correctly, that this suite would otherwise be asserting things about
     rows the application cannot produce. */
  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    years,
    requestRepository,
    decisions,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    employees,
    types,
    years,
    requests: requestRepository,
    decisions,
    accounts,
    roles,
    secret: SECRET,
  });

  /* Port 0, so the operating system picks one nothing else is on. */
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await emptyTheLeaveTables();
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  y2027 = await yearIdOf('2027');
  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;

  /* Enough annual leave for everything below to be affordable. Granted the way the annual
     run grants it, which is through the one door. */
  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await emptyTheLeaveTables();
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------- nothing without a session */

describe('the line everything is mounted behind', () => {
  it('answers 401 with no cookie at all', async () => {
    const response = await fetch(`${origin}/api/me/requests`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'NotSignedIn' });
  });

  it('and 401 for a cookie signed with the wrong secret', async () => {
    const response = await get('/api/me/requests', {
      cookie: mintSession(people.officer, 'a-different-secret-of-at-least-32-characters'),
    });

    expect(response.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ /me means me */

describe('whose history it is', () => {
  /**
   * Asked as Ama, who holds `HR_ADMIN` and may read everybody — so a route that took an id
   * off the request would actually hand back somebody else's leave here rather than being
   * refused by a policy on the way past.
   */
  it('is the employee in the cookie, whatever the query string names', async () => {
    await aRequest();

    const history = await historyFor(people.headOfHr, `?employeeId=${people.officer}`);

    expect(history.employeeId).toBe(people.headOfHr);
    expect(history.entries).toEqual([]);
  });
});

/* --------------------------------------------------------- every request, with its status */

describe('every request I have made', () => {
  /**
   * The story's first criterion, against the four endings the state machine can reach.
   *
   * Each one is produced by the verb that produces it rather than by an UPDATE, so what is
   * being asserted is that the screen shows what the system did.
   */
  it('shows the ones that were agreed, turned down and taken back alike', async () => {
    const agreed = await aRequest({ from: '2026-03-02', to: '2026-03-06' });
    await requests.approve(asTheirManager(), agreed);
    await requests.approve(asOfficer(), agreed);

    const refused = await aRequest({ from: '2026-04-06', to: '2026-04-10' });
    await requests.refuse(asTheirManager(), refused, WHY_NOT);

    const takenBack = await aRequest({ from: '2026-05-04', to: '2026-05-08' });
    await requests.withdraw(asThemselves(), takenBack);

    const waiting = await aRequest({ from: '2026-06-01', to: '2026-06-05' });

    const history = await historyFor(people.officer);

    expect(statusesOf(history)).toEqual(
      expect.arrayContaining(['APPROVED', 'REFUSED', 'WITHDRAWN', 'SUBMITTED']),
    );

    expect(entryOf(history, waiting).statusInWords).toBe('waiting to be decided');
    expect(entryOf(history, agreed).agreed).toBe(true);
    expect(entryOf(history, refused).agreed).toBe(false);
  });

  /* Newest asked for first, which is the reverse of the calendar order the repository hands
     back — and the three periods below are deliberately not in the order they were booked. */
  it('puts the most recently asked for at the top', async () => {
    const first = await aRequest({ from: '2026-09-07', to: '2026-09-11' });
    const second = await aRequest({ from: '2026-03-02', to: '2026-03-06' });
    const third = await aRequest({ from: '2026-06-01', to: '2026-06-05' });

    expect(idsOf(await historyFor(people.officer))).toEqual([third, second, first]);
  });

  /* FR 11, FR 24. The figures come off the request as it was priced, and the period runs
     over Independence Day and a weekend — so a client recomputing either would get a
     different answer and this is the one place that would show. */
  it('carries what each cost when it was asked for', async () => {
    const id = await aRequest({ from: '2026-03-02', to: '2026-03-10' });

    const entry = entryOf(await historyFor(people.officer), id);

    expect(entry.days).toBe(6);
    expect(entry.calendarDays).toBe(9);
    expect(entry.countingBasis).toBe('WORKING_DAYS');
    expect(entry.countingBasisLabel).toBe('Working days');
    expect(entry.typeName).toBe('Annual Leave');
  });

  /**
   * NFR DAT 03. Ten characters in the column, ten on the wire.
   *
   * A leave period runs to a day rather than to an instant, and the whole failure this
   * guards against is a `Date` appearing anywhere on the way out — which would turn the last
   * day of somebody's holiday into the day before for anybody west of Greenwich.
   */
  it('and sends the dates as calendar dates rather than instants', async () => {
    const id = await aRequest({ from: '2026-03-02', to: '2026-03-10' });

    const entry = entryOf(await historyFor(people.officer), id);

    expect(entry.from).toBe('2026-03-02');
    expect(entry.to).toBe('2026-03-10');
    expect(new Date(entry.submittedAt).toISOString()).toBe(entry.submittedAt);
  });

  /**
   * The exact field list, for the reason ./balances-api.test.ts asserts one: a field that
   * went missing would be a sentence or a status the client had to compose for itself, and
   * the first sign of it would be a screen wording something differently from an email.
   */
  it('and puts everything the screen shows on the wire', async () => {
    const id = await aRequest();

    expect(Object.keys(entryOf(await historyFor(people.officer), id)).sort()).toEqual([
      'agreed',
      'approvedBy',
      'awaiting',
      'calendarDays',
      'chain',
      'countingBasis',
      'countingBasisLabel',
      'days',
      'from',
      'leaveTypeId',
      'leaveYearId',
      'progressInWords',
      'reason',
      'requestId',
      'stagesMissing',
      'status',
      'statusInWords',
      'stillToApprove',
      'submittedAt',
      'to',
      'trail',
      'typeName',
    ]);
  });
});

/* ------------------------------------------------------------------ the approval trail */

describe('how each was decided', () => {
  /**
   * The story's second criterion, end to end.
   *
   * Annual leave goes manager then HR, so this is a request that collected two approvals at
   * two desks — and the trail has to say both, in order, with who signed each.
   */
  it('names every desk that answered, in the order they answered', async () => {
    const id = await aRequest();

    await requests.approve(asTheirManager(), id, 'Cover is arranged.');
    await requests.approve(asOfficer(), id);

    const entry = entryOf(await historyFor(people.officer), id);

    expect(entry.trail.map((step) => step.kind)).toEqual(['ASKED', 'DECIDED', 'DECIDED']);
    expect(entry.trail.map((step) => step.desk)).toEqual([null, 'MANAGER', 'HR']);
    expect(entry.trail[1].by).toBe('Kofi Boateng');
    expect(entry.trail[1].comment).toBe('Cover is arranged.');
    expect(entry.agreed).toBe(true);
  });

  /**
   * FR 39. The sentence, verbatim.
   *
   * Newline, apostrophe and all. A screen that showed a truncated or re-encoded version of
   * this would be showing the person something other than what their manager wrote, on the
   * one record they have of why they were turned down.
   */
  it('carries a refusal’s reason through unchanged', async () => {
    const id = await aRequest();

    await requests.refuse(asTheirManager(), id, WHY_NOT);

    const entry = entryOf(await historyFor(people.officer), id);
    const refusal = entry.trail.find((step) => step.comment !== null);

    expect(refusal?.comment).toBe(WHY_NOT);
    expect(refusal?.by).toBe('Kofi Boateng');
    expect(refusal?.at).not.toBeNull();
    expect(entry.statusInWords).toBe('refused');
  });

  /**
   * FR 41. The half of the trail that is not a list of events.
   *
   * A request the manager has approved is not agreed leave, and a screen that stopped at the
   * newest decision would say it was. The step for HR is on the trail with no time on it,
   * and `progressInWords` says the same thing in a sentence.
   */
  it('says who has still to be asked, so a first approval never reads as agreement', async () => {
    const id = await aRequest();

    await requests.approve(asTheirManager(), id);

    const entry = entryOf(await historyFor(people.officer), id);

    expect(entry.agreed).toBe(false);
    expect(entry.awaiting).toBe('HR');
    expect(entry.stillToApprove).toEqual(['HR']);

    const pending = entry.trail[entry.trail.length - 1];

    expect(pending.kind).toBe('STILL_TO_ASK');
    expect(pending.at).toBeNull();
    expect(entry.progressInWords).toMatch(/not agreed yet/);
  });

  /* Withdrawing is not a decision — nothing records who did it or when — and the trail says
     so rather than borrowing `updated_at`, which a reworded reason would move. */
  it('reports a withdrawal without inventing who ended it', async () => {
    const id = await aRequest();

    await requests.withdraw(asThemselves(), id);

    const ending = entryOf(await historyFor(people.officer), id).trail.at(-1);

    expect(ending?.kind).toBe('ENDED');
    expect(ending?.by).toBeNull();
    expect(ending?.at).toBeNull();
  });

  /* One query brings back the decisions for the whole page, so this is the assertion that
     the grouping is right: a comment under the wrong request is the defect that shape has. */
  it('files each comment under the request it was written about', async () => {
    const refused = await aRequest({ from: '2026-03-02', to: '2026-03-06' });
    const untouched = await aRequest({ from: '2026-04-06', to: '2026-04-10' });

    await requests.refuse(asTheirManager(), refused, WHY_NOT);

    const history = await historyFor(people.officer);

    expect(commentsOf(entryOf(history, refused))).toEqual([WHY_NOT]);
    expect(commentsOf(entryOf(history, untouched))).toEqual([]);
  });
});

/* ------------------------------------------------------------------- the year filter */

describe('narrowing to one leave year', () => {
  it('offers the years this person has actually asked for leave in', async () => {
    await aRequest();

    const history = await historyFor(people.officer);

    expect(history.year).toBeNull();
    expect(history.years.map((one) => one.label)).toEqual(['2026']);
  });

  it('and shows only that year when one is named', async () => {
    const id = await aRequest();

    const history = await historyFor(people.officer, `?leaveYearId=${y2026}`);

    expect(history.year?.label).toBe('2026');
    expect(idsOf(history)).toEqual([id]);
  });

  /**
   * A real year with nothing in it is an answer rather than a refusal, which is the one place
   * this route behaves differently from `/api/me/balances`.
   *
   * A statement of noughts reads as "you have no leave" to somebody who was not employed yet,
   * so that route refuses. An empty history reads as "you asked for no leave then", which is
   * exactly what it means.
   */
  it('and answers a year with no requests in it with an empty list', async () => {
    await aRequest();

    const response = await get(`/api/me/requests?leaveYearId=${y2027}`, {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as JsonHistory).entries).toEqual([]);
  });

  /* An id that names nothing is a broken link or a stale bookmark, and that is a 404. */
  it('but refuses a leave year that is nobody’s', async () => {
    const response = await get('/api/me/requests?leaveYearId=999999', {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'LeaveYearNotFound' });
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonStep {
  kind: string;
  desk: string | null;
  comment: string | null;
  by: string | null;
  at: string | null;
  inWords: string;
}

interface JsonEntry {
  requestId: string;
  typeName: string;
  from: string;
  to: string;
  days: number;
  calendarDays: number;
  countingBasis: string;
  countingBasisLabel: string;
  status: string;
  statusInWords: string;
  submittedAt: string;
  agreed: boolean;
  awaiting: string | null;
  stillToApprove: string[];
  progressInWords: string;
  trail: JsonStep[];
}

interface JsonHistory {
  employeeId: string;
  year: { id: string; label: string } | null;
  years: { id: string; label: string }[];
  entries: JsonEntry[];
}

function get(path: string, { cookie }: { cookie: string }): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
}

async function historyFor(employeeId: string, query = ''): Promise<JsonHistory> {
  const response = await get(`/api/me/requests${query}`, {
    cookie: mintSession(employeeId, SECRET),
  });

  expect(response.status).toBe(200);

  return (await response.json()) as JsonHistory;
}

/** Adwoa Frimpong asking for her own leave, through the real door. Returns the id. */
async function aRequest(period: { from?: string; to?: string } = {}): Promise<string> {
  const { request } = await requests.submit(asThemselves(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: period.from ?? '2026-03-02',
    to: period.to ?? '2026-03-06',
    reason: 'My sister is getting married',
  });

  return request.id;
}

/** Adwoa Frimpong, the operations officer. */
function asThemselves(): Actor {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Kofi Boateng, her team lead — the `MANAGER` desk for her requests. */
function asTheirManager(): Actor {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** An HR Officer, who staffs the `HR` desk. */
function asOfficer(): Actor {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function entryOf(history: JsonHistory, requestId: string): JsonEntry {
  const entry = history.entries.find((one) => one.requestId === requestId);

  if (entry === undefined) {
    throw new Error(`No entry for request ${requestId}. The history had ${idsOf(history).join()}.`);
  }

  return entry;
}

function idsOf(history: JsonHistory): string[] {
  return history.entries.map((entry) => entry.requestId);
}

function statusesOf(history: JsonHistory): string[] {
  return history.entries.map((entry) => entry.status);
}

function commentsOf(entry: JsonEntry): string[] {
  return entry.trail
    .map((step) => step.comment)
    .filter((comment): comment is string => comment !== null);
}

async function yearIdOf(label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_year WHERE label = $1', [
    label,
  ]);

  return rows[0].id;
}

function emptyTheLeaveTables(): Promise<unknown> {
  return admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'leave_request_decision, leave_request, leave_balance',
  );
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
