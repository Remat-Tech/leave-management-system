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
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
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
import { delegationService } from '../support/delegations.js';

/**
 * A manager's view of their direct reports, over HTTP. FR 55, FR 56, LMS 405.
 *
 * Four claims:
 *
 *   **Direct reports only.** Kofi's team is the three people who report to him. Akosua
 *   manages Kofi and sees Kofi — not the three below him. That is FR 55 rather than an
 *   oversight, and it is the one thing this screen could most easily get wrong.
 *
 *   **`/me` names the manager.** There is no id to supply, so the team cannot be pointed
 *   at anybody else's.
 *
 *   **Somebody with no reports is refused, and told what the screen is.** An empty team
 *   and no team are different news.
 *
 *   **Every figure is on the wire, and a calendar date stays ten characters.** NFR DAT 03.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('team api integration fixtures');

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
    employees,
    types,
    years,
    requests: leaveRequests,
    leaveRequests: requests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
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
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
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
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
  );
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

describe('who is on the screen, FR 55', () => {
  it('needs a session like everything else behind the line', async () => {
    expect((await fetch(`${origin}/api/me/team`)).status).toBe(401);
  });

  it('is the people who report to the reader, surname first', async () => {
    const team = await teamFor(people.teamLead);

    expect(team.managerId).toBe(people.teamLead);
    expect(team.size).toBe(3);
    expect(team.members.map((one) => one.name)).toEqual([
      'Kojo Antwi',
      'Adwoa Frimpong',
      'Abena Sarpong',
    ]);
  });

  /**
   * The claim the story is about. Akosua manages Kofi, who manages the other three.
   *
   * Her team is Kofi and nobody below him — "not the wider structure beneath them" — and the
   * same three names appearing here would be the defect this test exists to catch.
   */
  it('and never the wider structure beneath them', async () => {
    const team = await teamFor(people.opsManager);

    expect(team.members.map((one) => one.employeeId)).toEqual([people.teamLead]);
    expect(team.members.map((one) => one.employeeId)).not.toContain(people.officer);
  });

  /* FR 06. Kojo left in July and still reports to Kofi until HR moves the line. */
  it('and keeps a leaver on the line, marked', async () => {
    const kojo = memberOf(await teamFor(people.teamLead), people.leaver);

    expect(kojo.employmentStatus).toBe('TERMINATED');
    expect(kojo.inWords).toContain('They have left');
  });

  /* An empty team and no team are different news, so this is refused rather than answered. */
  it('and refuses somebody who manages nobody, saying what the screen is', async () => {
    const response = await get('/api/me/team', { cookie: mintSession(people.officer, SECRET) });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain(
      'nobody reports to you',
    );
  });

  /**
   * `/me` names the manager, and there is no id to read.
   *
   * Asked as Akosua with Kofi's id in the query. Her own team is Kofi alone; his is three
   * people — so a route that read the parameter would answer visibly differently.
   */
  it('and a query parameter naming somebody else changes nothing', async () => {
    const response = await get(`/api/me/team?employeeId=${people.teamLead}`, {
      cookie: mintSession(people.opsManager, SECRET),
    });

    expect(((await response.json()) as JsonTeam).members).toHaveLength(1);
  });
});

describe('what each of them has left, FR 55', () => {
  it('is on the wire, figure for figure', async () => {
    await grant(people.officer, annualId, 20);
    await requests.submit(asAdwoa(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: '2026-11-02',
      to: '2026-11-06',
      reason: 'A week away',
      acknowledgesShortNotice: true,
    });

    const annual = balanceOf(memberOf(await teamFor(people.teamLead), people.officer), 'ANNUAL');

    expect(annual.entitled).toBe(20);
    expect(annual.pending).toBe(5);
    expect(annual.taken).toBe(0);
    expect(annual.owed).toBe(20);
    expect(annual.available).toBe(15);
  });

  /* Nothing a browser could subtract itself. The same field list `/api/me/balances` sends. */
  it('with every field the balance screen carries', async () => {
    await grant(people.officer, annualId, 20);

    expect(
      Object.keys(balanceOf(memberOf(await teamFor(people.teamLead), people.officer), 'ANNUAL')),
    ).toEqual([
      'leaveTypeId',
      'code',
      'name',
      'countingBasis',
      'countingBasisLabel',
      'entitlementBasis',
      'allowanceInWords',
      'unit',
      'isPaid',
      'stillOffered',
      'entitled',
      'carriedOver',
      'adjustment',
      'taken',
      'pending',
      'owed',
      'available',
      'hasMoved',
      'updatedAt',
    ]);
  });

  /* FR 05, and the rule is the person's own statement's rather than this screen's. */
  it('and leaves maternity leave off a man', async () => {
    const kojo = memberOf(await teamFor(people.teamLead), people.leaver);

    expect(kojo.balances.map((line) => line.code)).not.toContain('MATERNITY');
  });
});

describe('what each of them has booked, and when, FR 56', () => {
  it('lists the live leave with the days it costs', async () => {
    await grant(people.officer, annualId, 20);

    const requestId = await aWeekFor(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');

    const adwoa = memberOf(await teamFor(people.teamLead), people.officer);

    expect(adwoa.booked).toHaveLength(1);
    expect(adwoa.booked[0].requestId).toBe(requestId);
    expect(adwoa.booked[0].from).toBe('2026-11-02');
    expect(adwoa.booked[0].to).toBe('2026-11-06');
    expect(adwoa.booked[0].agreed).toBe(false);
    expect(adwoa.booked[0].awaiting).toBe('MANAGER');
    expect(adwoa.daysBooked).toBe(5);
  });

  /**
   * The day the manager is looking for: two of the three off at once.
   *
   * The whole "so that" of the story — deciding a request knowing who else is already away —
   * turns on this figure, so it is asserted rather than left to the sentence.
   */
  it('and flags the days more than one of them is away', async () => {
    await grant(people.officer, annualId, 20);
    await grant(people.partTimer, annualId, 16);

    await aWeekFor(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');
    await aWeekFor(people.partTimer, asAbena(), '2026-11-05', '2026-11-11');

    const { calendar } = await teamFor(people.teamLead);

    expect(calendar.busiest).toBe(2);
    expect(calendar.clashes).toBe(2);
    expect(calendar.days.filter((day) => day.isClash).map((day) => day.date)).toEqual([
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(calendar.days.some((day) => day.isEverybody)).toBe(false);
  });

  it('and lists no day nobody is away', async () => {
    expect((await teamFor(people.teamLead)).calendar.days).toEqual([]);
  });

  /* NFR DAT 03. From the column to the JSON, untouched. */
  it('and every date it sends is ten characters', async () => {
    await grant(people.officer, annualId, 20);
    await aWeekFor(people.officer, asAdwoa(), '2026-11-02', '2026-11-06');

    const team = await teamFor(people.teamLead);

    for (const day of [
      team.year.startDate,
      team.year.endDate,
      team.calendar.from,
      team.calendar.to,
      ...team.calendar.days.map((one) => one.date),
      ...team.members.flatMap((one) => one.booked.flatMap((booked) => [booked.from, booked.to])),
    ]) {
      expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('which leave year', () => {
  it('opens on the one covering today and offers the rest', async () => {
    const team = await teamFor(people.teamLead);

    expect(team.year.id).toBe(y2026);
    expect(team.years.map((one) => one.id)).toContain(y2027);
  });

  it('shows another when one is asked for', async () => {
    expect((await teamFor(people.teamLead, `?leaveYearId=${y2027}`)).year.id).toBe(y2027);
  });

  it('and a leave year that is nobody’s is a 404', async () => {
    const response = await get('/api/me/team?leaveYearId=999999', {
      cookie: mintSession(people.teamLead, SECRET),
    });

    expect(response.status).toBe(404);
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonLine {
  code: string;
  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  owed: number;
  available: number;
}

interface JsonBooking {
  requestId: string;
  from: string;
  to: string;
  days: number;
  agreed: boolean;
  awaiting: string | null;
}

interface JsonMember {
  employeeId: string;
  name: string;
  employmentStatus: string;
  daysBooked: number;
  awayToday: boolean;
  inWords: string;
  balances: JsonLine[];
  booked: JsonBooking[];
}

interface JsonTeam {
  managerId: string;
  year: { id: string; label: string; startDate: string; endDate: string };
  years: { id: string; label: string }[];
  size: number;
  inWords: string;
  members: JsonMember[];
  calendar: {
    from: string;
    to: string;
    busiest: number;
    clashes: number;
    inWords: string;
    days: { date: string; isClash: boolean; isEverybody: boolean; away: unknown[] }[];
  };
}

function get(path: string, { cookie }: { cookie: string }): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
}

async function teamFor(employeeId: string, query = ''): Promise<JsonTeam> {
  const response = await get(`/api/me/team${query}`, { cookie: mintSession(employeeId, SECRET) });

  expect(response.status).toBe(200);

  return (await response.json()) as JsonTeam;
}

function memberOf(team: JsonTeam, employeeId: string): JsonMember {
  const member = team.members.find((one) => one.employeeId === employeeId);

  if (member === undefined) {
    throw new Error(
      `${employeeId} is not on this team. It held ${team.members
        .map((one) => one.name)
        .join(', ')}.`,
    );
  }

  return member;
}

function balanceOf(member: JsonMember, code: string): JsonLine {
  const line = member.balances.find((one) => one.code === code);

  if (line === undefined) {
    throw new Error(`No ${code} line for ${member.name}.`);
  }

  return line;
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

/** Adwoa Frimpong, the operations officer. */
function asAdwoa(): Actor {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Abena Sarpong, the part timer on the same team. */
function asAbena(): Actor {
  return signedInAs(people.partTimer, { roles: ['EMPLOYEE'], isManager: false });
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
