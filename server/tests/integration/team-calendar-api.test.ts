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
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { delegationService } from '../support/delegations.js';

/**
 * The team calendar, over HTTP. FR 57, LMS 406, LMS 409.
 *
 * Five claims:
 *
 *   **The calendar is the reader's department.** LMS 409 made the department the scope, so a
 *   colleague two reporting lines away is on it and somebody in Finance is not.
 *
 *   **Looking past your own department is HR's.** Everybody else is refused, and refused
 *   rather than quietly narrowed to their own.
 *
 *   **Leave type and reason never leave the server.** The claim the story turns on, asserted
 *   on the wire rather than in the domain, because the wire is what a colleague can read.
 *
 *   **`/me` names the reader.** There is no id to supply.
 *
 *   **A calendar date stays ten characters.** NFR DAT 03.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('team calendar api integration fixtures');

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

  const guard = new Guard();
  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const cached = new BalanceRepository(db);

  balances = new BalanceService(cached, guard, employees, new Transactions(db));

  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const leaveRequests = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    years,
    leaveRequests,
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
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: cached,
    /** FR 27, FR 37, LMS 506. The ledger the adjustment screen reads, and the door it writes through. */
    ledger: new LedgerRepository(db),
    adjustments: balances,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: leaveRequests,
    leaveRequests: requests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
    /** FR 25, §8.8, LMS 508. */
    holidayRecalculations: holidayRecalculationService(db, guard, balances),
    storage: new InMemoryStorage(),
    scanner: new SignatureScanner(),
    accounts,
    roles,
    delegations: delegationService(db, guard),
    organisation: new OrganisationRepository(db),
    secret: SECRET,
  });

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
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
  );
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  y2027 = await yearIdOf('2027');
  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
});

afterAll(async () => {
  /* Closes, and nothing else. `databaseForThisFile` drops this file's database next, so
     tidying its rows here is work that cannot matter — and a statement that throws leaves a
     connection open for that drop's FORCE to terminate, which surfaces as an unhandled 57P01. */
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await db?.destroy();
  await admin?.end();
});

describe('who is on the calendar, FR 57, LMS 409', () => {
  it('needs a session like everything else behind the line', async () => {
    expect((await fetch(`${origin}/api/me/calendar`)).status).toBe(401);
  });

  /**
   * Operations, whole. Yaw, Akosua, Kofi, Adwoa, Abena and Kojo, across four reporting
   * levels — which is the point of LMS 409: cover is arranged inside a department rather
   * than inside a reporting line, so the calendar is drawn the way cover is arranged.
   */
  it('is everybody in the reader’s department, the reader included', async () => {
    const calendar = await calendarFor(people.officer);

    expect(calendar.employeeId).toBe(people.officer);
    expect(calendar.department?.name).toBe('Operations');
    expect(calendar.size).toBe(6);
    expect(calendar.colleagues.map((one) => one.name).sort()).toEqual([
      'Abena Sarpong',
      'Adwoa Frimpong',
      'Akosua Darko',
      'Kofi Boateng',
      'Kojo Antwi',
      'Yaw Boateng',
    ]);
    expect(colleagueOf(calendar, people.officer).isMe).toBe(true);
    expect(colleagueOf(calendar, people.teamLead).isTheManager).toBe(true);
  });

  /* The claim the scope turns on. Efe is the finance manager and Adwoa is in Operations. */
  it('and never somebody in another department', async () => {
    const calendar = await calendarFor(people.officer);

    expect(calendar.colleagues.map((one) => one.employeeId)).not.toContain(people.financeManager);
  });

  /* FR 04's one seat is no longer a refusal: Kwame is in Executive like anybody else. */
  it('and draws the employee who reports to nobody their own department', async () => {
    const calendar = await calendarFor(people.ceo);

    expect(calendar.department?.name).toBe('Executive');
    expect(calendar.colleagues.map((one) => one.employeeId)).toEqual([people.ceo]);
  });

  /* FR 06. Kojo left in July and is still on the line until HR moves it. */
  it('and keeps a leaver on it, marked', async () => {
    const kojo = colleagueOf(await calendarFor(people.officer), people.leaver);

    expect(kojo.employmentStatus).toBe('TERMINATED');
    expect(kojo.inWords).toContain('They have left');
  });

  /* `/me` names the reader. Kwame's calendar is one person and Adwoa's is six, so a route
     that read the parameter would answer visibly differently. */
  it('and a query parameter naming somebody else changes nothing', async () => {
    const response = await get(`/api/me/calendar?employeeId=${people.ceo}`, {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(((await response.json()) as JsonCalendar).colleagues).toHaveLength(6);
  });
});

describe('which department, LMS 409', () => {
  /* Everybody else gets their own department and is told it is the only one they may name. */
  it('offers a colleague their own department and no choice about it', async () => {
    const calendar = await calendarFor(people.officer);

    expect(calendar.canChooseDepartment).toBe(false);
    expect(calendar.departments.map((one) => one.name)).toEqual(['Operations']);
  });

  it('and refuses them another department, saying whose that is', async () => {
    const response = await get(`/api/me/calendar?departmentId=${await departmentIdOf('Finance')}`, {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain(
      'Looking across departments is for HR',
    );
  });

  /* Asking for the one they are already in is the ordinary screen, not an attempt at another. */
  it('and lets them name their own department without refusing them', async () => {
    const calendar = await calendarFor(
      people.officer,
      `?departmentId=${await departmentIdOf('Operations')}`,
    );

    expect(calendar.department?.name).toBe('Operations');
  });

  /* HR reads every record, so HR reads every department and may pick one. */
  it('lets HR pick any department', async () => {
    const calendar = await calendarFor(
      people.hrOfficer,
      `?departmentId=${await departmentIdOf('Finance')}`,
    );

    expect(calendar.canChooseDepartment).toBe(true);
    expect(calendar.department?.name).toBe('Finance');
    expect(calendar.colleagues.map((one) => one.employeeId)).toEqual([people.financeManager]);
    expect(calendar.departments.map((one) => one.name)).toContain('Operations');
  });

  /* The empty string is HR asking for all of them at once. */
  it('and lets HR ask for every department at once', async () => {
    const calendar = await calendarFor(people.hrOfficer, '?departmentId=');

    expect(calendar.department).toBeNull();
    expect(calendar.inWords).toContain('in every department');
    expect(calendar.colleagues.map((one) => one.employeeId)).toContain(people.financeManager);
    expect(calendar.colleagues.map((one) => one.employeeId)).toContain(people.officer);
  });

  /* Which department a colleague is in, so the rows have a heading to sit under. */
  it('and names the department each colleague is in', async () => {
    const calendar = await calendarFor(people.hrOfficer, '?departmentId=');

    expect(colleagueOf(calendar, people.financeManager).department?.name).toBe('Finance');
    expect(colleagueOf(calendar, people.officer).department?.name).toBe('Operations');
  });

  it('and a department id nobody has is a 404', async () => {
    const response = await get('/api/me/calendar?departmentId=999999', {
      cookie: mintSession(people.hrOfficer, SECRET),
    });

    expect(response.status).toBe(404);
  });
});

describe('what a colleague may read of an absence, FR 57', () => {
  it('is the dates, how long, and whether it stands', async () => {
    await grant(people.partTimer, annualId, 16);
    await aWeekFor(people.partTimer, asAbena(), '2026-11-02', '2026-11-06');

    const abena = colleagueOf(await calendarFor(people.officer), people.partTimer);

    expect(abena.absences).toHaveLength(1);
    expect(abena.absences[0].from).toBe('2026-11-02');
    expect(abena.absences[0].to).toBe('2026-11-06');
    expect(abena.absences[0].calendarDays).toBe(5);
    expect(abena.absences[0].agreed).toBe(false);
  });

  /**
   * The story's second criterion, asserted on the wire.
   *
   * Abena asked for compassionate leave with a reason on it. Adwoa, reading the calendar,
   * gets five dates and no answer to what kind of leave it was or why.
   */
  it('and never the leave type, the reason, or a handle on the request', async () => {
    await grant(people.partTimer, annualId, 16);

    await requests.submit(asAbena(), {
      employeeId: people.partTimer,
      leaveTypeId: annualId,
      from: '2026-11-02',
      to: '2026-11-06',
      reason: 'My grandmother’s funeral in Kumasi',
      acknowledgesShortNotice: true,
    });

    const calendar = await calendarFor(people.officer);
    const abena = colleagueOf(calendar, people.partTimer);

    expect(Object.keys(abena.absences[0])).toEqual([
      'from',
      'to',
      'calendarDays',
      'agreed',
      'inWords',
    ]);

    const wire = JSON.stringify(calendar);

    expect(wire).not.toContain('funeral');
    expect(wire).not.toContain('Annual');
    expect(wire).not.toContain('leaveTypeId');
    expect(wire).not.toContain('requestId');
    expect(wire).not.toContain('reason');
  });

  /* The same absence on the manager's own screen does name the type, which is the whole
     difference between the two screens rather than an inconsistency between them. */
  it('while the manager’s own screen still names it, FR 56', async () => {
    await grant(people.partTimer, annualId, 16);
    await aWeekFor(people.partTimer, asAbena(), '2026-11-02', '2026-11-06');

    const team = (await (
      await get('/api/me/team', { cookie: mintSession(people.teamLead, SECRET) })
    ).json()) as { members: { employeeId: string; booked: { typeName: string }[] }[] };

    const abena = team.members.find((one) => one.employeeId === people.partTimer);

    expect(abena?.booked[0].typeName).toBe('Annual Leave');
  });

  /* FR 24. Days off the calendar, never the days it cost her — that figure is her balance. */
  it('and counts calendar days rather than what the leave was charged', async () => {
    await grant(people.partTimer, annualId, 16);

    /* Abena works four days a week, so a Monday to Friday costs her four and not five. */
    await aWeekFor(people.partTimer, asAbena(), '2026-11-02', '2026-11-06');

    const abena = colleagueOf(await calendarFor(people.officer), people.partTimer);

    expect(abena.absences[0].calendarDays).toBe(5);
    expect(JSON.stringify(abena.absences[0])).not.toContain('"days"');
  });

  /* Live leave only. A refused request is not an absence to plan around. */
  it('and leaves refused leave off it altogether', async () => {
    await grant(people.partTimer, annualId, 16);

    const requestId = await aWeekFor(people.partTimer, asAbena(), '2026-11-02', '2026-11-06');

    await turnDown(requestId);

    expect(colleagueOf(await calendarFor(people.officer), people.partTimer).absences).toEqual([]);
  });
});

describe('who is away on which day, FR 57', () => {
  it('lists the days somebody is off and no others', async () => {
    await grant(people.partTimer, annualId, 16);
    await aWeekFor(people.partTimer, asAbena(), '2026-11-02', '2026-11-04');

    const { days } = await calendarFor(people.officer);

    expect(days.map((day) => day.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(days[0].away.map((one) => one.name)).toEqual(['Abena Sarpong']);
  });

  it('and counts the most away on any one day', async () => {
    await grant(people.officer, annualId, 20);
    await grant(people.partTimer, annualId, 16);

    await aWeekFor(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');
    await aWeekFor(people.partTimer, asAbena(), '2026-11-05', '2026-11-11');

    const calendar = await calendarFor(people.officer);

    expect(calendar.busiest).toBe(2);
    expect(calendar.days.filter((day) => day.away.length > 1).map((day) => day.date)).toEqual([
      '2026-11-05',
      '2026-11-06',
    ]);
  });

  /* The reader's own leave is on their own calendar, marked, so it reads as a whole team. */
  it('and marks the reader’s own leave as theirs', async () => {
    await grant(people.officer, annualId, 20);
    await aWeekFor(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');

    const calendar = await calendarFor(people.officer);

    expect(calendar.days[0].away[0].isMe).toBe(true);
    expect(colleagueOf(calendar, people.officer).inWords).toContain('You have 1 absence');
  });

  it('and lists no day nobody is away', async () => {
    expect((await calendarFor(people.officer)).days).toEqual([]);
  });

  /* NFR DAT 03. From the column to the JSON, untouched. */
  it('and every date it sends is ten characters', async () => {
    await grant(people.partTimer, annualId, 16);
    await aWeekFor(people.partTimer, asAbena(), '2026-11-02', '2026-11-06');

    const calendar = await calendarFor(people.officer);

    for (const day of [
      calendar.year.startDate,
      calendar.year.endDate,
      calendar.from,
      calendar.to,
      ...calendar.days.map((one) => one.date),
      ...calendar.colleagues.flatMap((one) =>
        one.absences.flatMap((absence) => [absence.from, absence.to]),
      ),
    ]) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('which leave year', () => {
  it('opens on the one covering today and offers the rest', async () => {
    const calendar = await calendarFor(people.officer);

    expect(calendar.year.id).toBe(y2026);
    expect(calendar.years.map((one) => one.id)).toContain(y2027);
  });

  it('shows another when one is asked for', async () => {
    expect((await calendarFor(people.officer, `?leaveYearId=${y2027}`)).year.id).toBe(y2027);
  });

  it('and a leave year that is nobody’s is a 404', async () => {
    const response = await get('/api/me/calendar?leaveYearId=999999', {
      cookie: mintSession(people.officer, SECRET),
    });

    expect(response.status).toBe(404);
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonAbsence {
  from: string;
  to: string;
  calendarDays: number;
  agreed: boolean;
  inWords: string;
}

interface JsonDepartment {
  id: string;
  name: string;
}

interface JsonColleague {
  employeeId: string;
  name: string;
  jobTitle: string | null;
  department: JsonDepartment | null;
  employmentStatus: string;
  isMe: boolean;
  isTheManager: boolean;
  awayToday: boolean;
  inWords: string;
  absences: JsonAbsence[];
}

interface JsonCalendar {
  employeeId: string;
  year: { id: string; label: string; startDate: string; endDate: string };
  years: { id: string; label: string }[];
  department: JsonDepartment | null;
  departments: JsonDepartment[];
  canChooseDepartment: boolean;
  from: string;
  to: string;
  size: number;
  busiest: number;
  inWords: string;
  awayToday: { employeeId: string; name: string }[];
  colleagues: JsonColleague[];
  days: { date: string; isEverybody: boolean; away: { name: string; isMe: boolean }[] }[];
}

function get(path: string, { cookie }: { cookie: string }): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
}

async function calendarFor(employeeId: string, query = ''): Promise<JsonCalendar> {
  const response = await get(`/api/me/calendar${query}`, {
    cookie: mintSession(employeeId, SECRET),
  });

  expect(response.status).toBe(200);

  return (await response.json()) as JsonCalendar;
}

function colleagueOf(calendar: JsonCalendar, employeeId: string): JsonColleague {
  const colleague = calendar.colleagues.find((one) => one.employeeId === employeeId);

  if (colleague === undefined) {
    throw new Error(
      `${employeeId} is not on this calendar. It held ${calendar.colleagues
        .map((one) => one.name)
        .join(', ')}.`,
    );
  }

  return colleague;
}

/** Somebody asking for their own week, through the real door. Returns the id. */
async function aWeekFor(
  employeeId: string,
  actor: Actor,
  from: string,
  to: string,
): Promise<string> {
  const { request } = await requests.submit(actor, {
    employeeId,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'A week away',
    acknowledgesShortNotice: true,
  });

  return request.id;
}

/** Adwoa Frimpong, the operations officer, and the reader on most of these. */
function asAdwoa(): Actor {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Abena Sarpong, the part timer on the same team. */
function asAbena(): Actor {
  return signedInAs(people.partTimer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Kofi Boateng, who decides for all three of them. */
function asKofi(): Actor {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** Turned down for good: annual leave sits at the manager's desk, then at HR's. */
async function turnDown(requestId: string): Promise<void> {
  const first = await requests.refuse(asKofi(), requestId, 'We need cover that week.');

  if (first.request.status !== 'REFUSED') {
    await requests.refuse(
      signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false }),
      requestId,
      'We need cover that week.',
    );
  }
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

/** LMS 409. The department the seed gave that name. */
async function departmentIdOf(name: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM department WHERE name = $1', [
    name,
  ]);

  return rows[0].id;
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
