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

/**
 * The approver queue over HTTP. FR 20, FR 40, FR 48, LMS 404.
 *
 * ../unit/approver-queue.test.ts proves the arrangement without a database. This suite is for
 * the four claims it cannot make: that the rows are the ones the desk column actually holds,
 * that a decision takes a request out of the queue, that the desks resolve against a real
 * organisation, and that somebody who approves nothing is refused rather than shown an empty
 * screen.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

/** FR 39. What a line manager writes when they turn leave down. */
const WHY_NOT = 'Two of the team are already away that week and the desk cannot be empty';

const system = theSystem('approver queue integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let balances: BalanceService;
let requests: LeaveRequestService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: string;
let annualId: string;
let unpaidId: string;

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

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    years,
    requestRepository,
    decisions,
    /** FR 48b, LMS 320. */
    new LeaveRoutingRepository(db),
    /** FR 47, LMS 324. */
    new WithdrawalRepository(db),
    new RoleRepository(db),
    new OrganisationRepository(db),
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
    leaveRequests: requests,
    decisions,
    /** FR 48b, LMS 320. */
    routing: new LeaveRoutingRepository(db),
    /** FR 47, LMS 324. */
    withdrawals: new WithdrawalRepository(db),
    /** FR 19, LMS 302. */
    drafts: new LeaveRequestDraftRepository(db),
    accounts,
    roles,
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
  await emptyTheLeaveTables();
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  annualId = await typeIdOf('ANNUAL');
  unpaidId = await typeIdOf('UNPAID');

  /* Granted the way the annual run grants it, through the one door, for everybody who asks
     for anything below. */
  for (const employeeId of [people.officer, people.partTimer, people.hrOfficer, people.engineer]) {
    await balances.grantTheYear(system, {
      employeeId,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 20,
      reason: 'Annual entitlement for 2026',
    });

    await balances.grantTheYear(system, {
      employeeId,
      leaveTypeId: unpaidId,
      leaveYearId: y2026,
      days: 10,
      reason: 'Unpaid allowance for 2026',
    });
  }
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

describe('the line everything is mounted behind', () => {
  it('answers 401 with no cookie at all', async () => {
    const response = await fetch(`${origin}/api/me/approvals`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'NotSignedIn' });
  });
});

describe('who has a queue at all', () => {
  /* Abena manages nobody, holds no role and is not the root. FR 40. */
  it('refuses somebody who staffs no desk, and says what makes an approver', async () => {
    const response = await get('/api/me/approvals', people.partTimer);

    expect(response.status).toBe(403);

    const problem = (await response.json()) as { error: string; message: string };

    expect(problem.error).toBe('NotAuthorised');
    expect(problem.message).toContain('waiting on you');
  });

  /* And the tab is offered to everybody, so the refusal is the screen. There is deliberately
     no flag on `/api/me` to hide it in advance — ./balances-api.test.ts pins that route's
     fields for exactly that reason. */
  it('says which desks the queue was drawn from', async () => {
    expect((await queueFor(people.teamLead)).desks).toEqual(['MANAGER']);
    expect((await queueFor(people.hrOfficer)).desks).toEqual(['HR']);
  });
});

describe('what a manager sees', () => {
  it('shows their own reports’ pending requests and nobody else’s', async () => {
    const mine = await aRequest({ employeeId: people.officer });
    await aRequest({ employeeId: people.engineer, from: '2026-04-06', to: '2026-04-10' });

    const queue = await queueFor(people.teamLead);

    expect(queue.desks).toEqual(['MANAGER']);
    expect(idsOf(queue)).toEqual([mine]);
    expect(itemOf(queue, mine).asker.name).toBe('Adwoa Frimpong');
    expect(itemOf(queue, mine).desk).toBe('MANAGER');
  });

  /* `leave_request_waits_at_a_desk` makes leaving the queue the same statement as the
     decision, so a queue cannot be built that shows a settled request. */
  it('drops a request the moment it is decided or taken back', async () => {
    const approved = await aRequest({ employeeId: people.officer });
    const withdrawn = await aRequest({
      employeeId: people.officer,
      from: '2026-04-06',
      to: '2026-04-10',
    });

    expect(idsOf(await queueFor(people.teamLead)).sort()).toEqual([approved, withdrawn].sort());

    await requests.approve(asTheirManager(), approved);
    await requests.withdraw(asOfficer(), withdrawn);

    expect(idsOf(await queueFor(people.teamLead))).toEqual([]);
  });

  /**
   * And it turns up in the HR queue when the manager turns it down, too. FR 44, §7.2. LMS 318.
   *
   * The story's first criterion, and the reason it needs no query of its own: a rejection is
   * a decision at a stage rather than an ending, so a manager-rejected request arrives at
   * HR's desk exactly as an approved one does — with the balance and the team beside it, and
   * with what the manager said and why.
   */
  it('and it turns up in the HR queue when the manager turns it down', async () => {
    const id = await aRequest({ employeeId: people.officer });

    await requests.refuse(asTheirManager(), id, WHY_NOT);

    expect(idsOf(await queueFor(people.teamLead))).toEqual([]);

    const item = itemOf(await queueFor(people.hrOfficer), id);

    expect(item.desk).toBe('HR');
    expect(item.approvedBy).toEqual([]);
    expect(item.managersDecision).toMatchObject({ said: 'REFUSE', comment: WHY_NOT });
    expect(item.managersDecision?.inWords).toContain('turned this down');

    /* And which of the two buttons would be overruling them, so the screen can ask for the
       justification before the press rather than after the refusal. */
    expect(item.approvingIs).toBe('OVERTURN_REJECTION');
    expect(item.refusingIs).toBeNull();
  });

  /**
   * And the dedicated view is that queue narrowed. FR 44's first criterion.
   *
   * A second screen assembled from its own query would be a second answer to what is waiting
   * on somebody. What makes this its own view is the decision on it: not *should this leave
   * happen* but *should this manager's answer stand*.
   */
  it('and the rejections view holds those and nothing else', async () => {
    const turnedDown = await aRequest({
      employeeId: people.officer,
      from: '2026-09-07',
      to: '2026-09-11',
    });
    const approved = await aRequest({ employeeId: people.officer });

    await requests.refuse(asTheirManager(), turnedDown, WHY_NOT);
    await requests.approve(asTheirManager(), approved);

    /* Both are at the HR desk, and only one of them is a manager's rejection. */
    expect(idsOf(await queueFor(people.hrOfficer)).sort()).toEqual([approved, turnedDown].sort());
    expect(idsOf(await rejectionsFor(people.hrOfficer))).toEqual([turnedDown]);
  });

  /* And a manager, who staffs no desk a rejection reaches, has an empty one that says so. */
  it('and a manager’s rejections view is empty, and says what it is for', async () => {
    const id = await aRequest({ employeeId: people.officer });

    await requests.refuse(asTheirManager(), id, WHY_NOT);

    const view = await rejectionsFor(people.teamLead);

    expect(view.items).toEqual([]);
    expect(view.inWords).toContain('No line manager has turned anything down');
  });

  /* FR 38a. Approved at the manager stage, the same request is now HR's. */
  it('and it turns up in the HR queue once the manager has signed', async () => {
    const id = await aRequest({ employeeId: people.officer });

    await requests.approve(asTheirManager(), id);

    expect(idsOf(await queueFor(people.teamLead))).toEqual([]);

    const queue = await queueFor(people.hrOfficer);

    expect(idsOf(queue)).toEqual([id]);
    expect(itemOf(queue, id).desk).toBe('HR');
    expect(itemOf(queue, id).approvedBy).toEqual(['MANAGER']);
    expect(itemOf(queue, id).stageInWords).toContain('Adwoa Frimpong’s line manager');
  });

  it('puts the leave that starts soonest first', async () => {
    const later = await aRequest({
      employeeId: people.officer,
      from: '2026-09-07',
      to: '2026-09-11',
    });
    const sooner = await aRequest({
      employeeId: people.officer,
      from: '2026-03-02',
      to: '2026-03-06',
    });

    expect(idsOf(await queueFor(people.teamLead))).toEqual([sooner, later]);
  });
});

describe('the context beside each request', () => {
  /* The story's first criterion. 20 granted, 6 held by this request, so 14 are left — and
     approving changes that by nothing, which is what the sentence says. */
  it('carries the balance the request was priced against', async () => {
    const id = await aRequest({
      employeeId: people.officer,
      from: '2026-03-02',
      to: '2026-03-10',
    });

    const item = itemOf(await queueFor(people.teamLead), id);

    expect(item.days).toBe(6);
    expect(item.balance.owed).toBe(20);
    expect(item.balance.pending).toBe(6);
    expect(item.balance.available).toBe(14);
    expect(item.balance.inWords).toContain('approving this leaves 14 days');
  });

  /* FR 20. Kofi's team is Adwoa, Abena and Kojo, so two others besides the asker. */
  it('names who else on the team is away over the same days', async () => {
    const clashing = await aRequest({
      employeeId: people.partTimer,
      from: '2026-03-03',
      to: '2026-03-05',
    });
    await requests.approve(asTheirManager(), clashing);

    const id = await aRequest({
      employeeId: people.officer,
      from: '2026-03-02',
      to: '2026-03-06',
    });

    const item = itemOf(await queueFor(people.teamLead), id);

    expect(item.team.size).toBe(3);
    expect(item.team.away.map((one) => one.name)).toEqual(['Abena Sarpong']);
    expect(item.team.inWords).toContain('1 of the 2 others on this team is away');
  });

  it('and says so plainly where nobody else is', async () => {
    const id = await aRequest({ employeeId: people.officer });

    expect(itemOf(await queueFor(people.teamLead), id).team.away).toEqual([]);
  });
});

describe('what is flagged', () => {
  /* FR 18. Leave already running when it was asked for, which the backdating window allows. */
  it('flags a backdated request', async () => {
    const id = await aBackdatedRequest();

    const item = itemOf(await queueFor(people.teamLead), id);

    expect(item.backdatedBy).toBeGreaterThan(0);
    expect(item.warnings.map((one) => one.code)).toContain('BACKDATED');
  });

  /* FR 17. Annual leave expects seven days and this gives one. */
  it('flags short notice, and does not refuse it', async () => {
    const id = await aRequestStartingTomorrow();

    const item = itemOf(await queueFor(people.teamLead), id);

    expect(item.shortNoticeBy).toBeGreaterThan(0);
    expect(item.warnings.map((one) => one.code)).toContain('SHORT_NOTICE');
  });
});

describe('an approver’s own request', () => {
  /* §8.6a. Unpaid leave goes to HR first, so Efua's own lands at the desk she staffs. */
  it('is on her queue and cannot be decided by her', async () => {
    const hers = await aRequest({ employeeId: people.hrOfficer, leaveTypeId: unpaidId });

    const queue = await queueFor(people.hrOfficer);

    expect(idsOf(queue)).toEqual([hers]);

    const item = itemOf(queue, hers);

    expect(item.desk).toBe('HR');
    expect(item.actionable).toBe(false);
    expect(item.notActionableBecause).toContain('withdraw it');
    expect(queue.inWords).toContain('your own');
  });

  /* The queue's answer and the door's are the same policy, so they cannot disagree. */
  it('and the approve door refuses it too', async () => {
    const hers = await aRequest({ employeeId: people.hrOfficer, leaveTypeId: unpaidId });

    await expect(requests.approve(asHrOfficer(), hers)).rejects.toMatchObject({
      name: 'NotAuthorised',
    });
  });

  /* A colleague's request at the same desk stays decidable. */
  it('while somebody else’s at the same desk stays actionable', async () => {
    const theirs = await aRequest({ employeeId: people.officer, leaveTypeId: unpaidId });

    expect(itemOf(await queueFor(people.hrOfficer), theirs).actionable).toBe(true);
  });
});

describe('the Chief Executive’s desk', () => {
  /* §4.3.1, FR 32h. Kwame is nobody's line manager and holds no role. */
  it('sees unpaid leave routed to it, with the team counted and unnamed', async () => {
    const id = await aRequest({ employeeId: people.officer, leaveTypeId: unpaidId });

    await requests.approve(asHrOfficer(), id);

    const queue = await queueFor(people.ceo);

    /* He staffs two: five directors report to him, which is the case the seed calls out —
       approvers and employees are not two disjoint sets of people. */
    expect(queue.desks).toEqual(['MANAGER', 'CEO']);
    expect(idsOf(queue)).toEqual([id]);

    const item = itemOf(queue, id);

    expect(item.desk).toBe('CEO');
    expect(item.actionable).toBe(true);
    /* The figure is there even though `ledgerPolicy.read` would refuse them. */
    expect(item.balance.owed).toBe(10);
    expect(item.team.size).toBe(3);
    expect(item.team.away.every((one) => one.name === null)).toBe(true);
  });
});

describe('the wire', () => {
  it('puts everything the screen shows on it', async () => {
    const id = await aRequest({ employeeId: people.officer });

    expect(Object.keys(itemOf(await queueFor(people.teamLead), id)).sort()).toEqual([
      'actionable',
      'approvedBy',
      /* FR 44, LMS 318. Which of the two buttons would be overruling the line manager, so a
         screen asks for the justification before the press rather than after the refusal. */
      'approvingIs',
      'asker',
      'backdatedBy',
      'balance',
      'calendarDays',
      'chain',
      'countingBasis',
      'countingBasisLabel',
      'days',
      'desk',
      'from',
      'leaveTypeId',
      'leaveYearId',
      /** FR 44. What the line manager said, and why, where they have decided. */
      'managersDecision',
      'notActionableBecause',
      'noticeGivenDays',
      'reason',
      'refusingIs',
      'requestId',
      'shortNoticeBy',
      'stageInWords',
      'startsInDays',
      'stillToApprove',
      'submittedAt',
      'team',
      'to',
      'typeName',
      'warnings',
    ]);
  });

  /* NFR DAT 03. Ten characters in the column, ten on the wire. */
  it('sends the dates as calendar dates rather than instants', async () => {
    const id = await aRequest({
      employeeId: people.officer,
      from: '2026-03-02',
      to: '2026-03-10',
    });

    const item = itemOf(await queueFor(people.teamLead), id);

    expect(item.from).toBe('2026-03-02');
    expect(item.to).toBe('2026-03-10');
    expect(new Date(item.submittedAt).toISOString()).toBe(item.submittedAt);
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonAway {
  employeeId: string;
  name: string | null;
  from: string;
  to: string;
  days: number;
  status: string;
  typeName: string;
}

interface JsonItem {
  requestId: string;
  asker: { employeeId: string; name: string; jobTitle: string | null };
  typeName: string;
  from: string;
  to: string;
  days: number;
  calendarDays: number;
  submittedAt: string;
  desk: string;
  approvedBy: string[];
  stillToApprove: string[];
  stageInWords: string;
  noticeGivenDays: number;
  shortNoticeBy: number;
  backdatedBy: number;
  startsInDays: number;
  warnings: { code: string; inWords: string }[];
  balance: { owed: number; taken: number; pending: number; available: number; inWords: string };
  team: { size: number; away: JsonAway[]; inWords: string };
  actionable: boolean;
  notActionableBecause: string | null;
  /** FR 44, §7.2. LMS 318. */
  managersDecision: { said: string; comment: string | null; by: string; inWords: string } | null;
  approvingIs: string | null;
  refusingIs: string | null;
}

interface JsonQueue {
  approverId: string;
  desks: string[];
  inWords: string;
  items: JsonItem[];
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

async function queueFor(employeeId: string): Promise<JsonQueue> {
  const response = await get('/api/me/approvals', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonQueue;
}

/** The same queue, narrowed to what a line manager turned down. FR 44, §7.2. LMS 318. */
async function rejectionsFor(employeeId: string): Promise<JsonQueue> {
  const response = await get('/api/me/approvals/rejections', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonQueue;
}

/** One request through the real door, by the person taking the leave. Returns the id. */
async function aRequest(input: {
  employeeId: string;
  leaveTypeId?: string;
  from?: string;
  to?: string;
}): Promise<string> {
  const { request } = await requests.submit(asThemselves(input.employeeId), {
    employeeId: input.employeeId,
    leaveTypeId: input.leaveTypeId ?? annualId,
    from: input.from ?? '2026-03-02',
    to: input.to ?? '2026-03-06',
    reason: 'My sister is getting married',
    /* FR 17, LMS 307. The fixture days are behind today, so every annual leave request here
       is short of notice — which is the point of the flag tests below, and has to be got past
       for all the others. */
    acknowledgesShortNotice: true,
  });

  return request.id;
}

/**
 * FR 18. Leave that started before it was asked for, inside the backdating window.
 *
 * Dated off the clock rather than written down, because the window is measured against today
 * and a fixed date would stop being backdated the day after it was written.
 */
function aBackdatedRequest(): Promise<string> {
  return aRequest({
    employeeId: people.officer,
    from: daysFromToday(-3),
    to: daysFromToday(-1),
  });
}

/**
 * FR 17. Annual leave expects seven days' notice; this gives one.
 *
 * Five days rather than two, and the width is the fix rather than the point. Annual leave
 * counts working days, so a two day period is a Saturday and a Sunday once a week: run on a
 * Friday, this cost nothing at all and `LeaveCountsNoDays` refused it before the flag under
 * test could be raised. Five consecutive days hold at least three working ones in every
 * alignment, which no run of gazetted holidays can empty.
 *
 * What makes it short notice is the *start*, which is still tomorrow.
 */
function aRequestStartingTomorrow(): Promise<string> {
  return aRequest({
    employeeId: people.officer,
    from: daysFromToday(1),
    to: daysFromToday(5),
  });
}

/** A calendar date this many days either side of today, in UTC. */
function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return day.toISOString().slice(0, 10);
}

function asThemselves(employeeId: string): Actor {
  return signedInAs(employeeId, {
    roles: employeeId === people.hrOfficer ? ['EMPLOYEE', 'HR_OFFICER'] : ['EMPLOYEE'],
    isManager: false,
  });
}

/** Kofi Boateng, the `MANAGER` desk for Adwoa's and Abena's requests. */
function asTheirManager(): Actor {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** Adwoa Frimpong, taking her own leave back. */
function asOfficer(): Actor {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Efua Owusu, who staffs the `HR` desk. */
function asHrOfficer(): Actor {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function itemOf(queue: JsonQueue, requestId: string): JsonItem {
  const item = queue.items.find((one) => one.requestId === requestId);

  if (item === undefined) {
    throw new Error(`No item for request ${requestId}. The queue had ${idsOf(queue).join()}.`);
  }

  return item;
}

function idsOf(queue: JsonQueue): string[] {
  return queue.items.map((item) => item.requestId);
}

async function yearIdOf(label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_year WHERE label = $1', [
    label,
  ]);

  return rows[0].id;
}

async function typeIdOf(code: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_type WHERE code = $1', [
    code,
  ]);

  return rows[0].id;
}

function emptyTheLeaveTables(): Promise<unknown> {
  return admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request, leave_balance',
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
