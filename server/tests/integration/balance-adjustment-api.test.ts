import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { theSystem } from '../../src/auth/actor.js';
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
import { EmailWordingRepository } from '../../src/features/notification/wording.db.js';
import { AuditRepository } from '../../src/features/audit/audit.db.js';
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
 * The balance adjustment screen, over HTTP. FR 37, FR 27. LMS 506.
 *
 * ./adjustment.test.ts proves the movement itself — both signs, the mandatory reason, the
 * mistyped id, and the rule that only an HR Administrator may post one — and ./ledger.test.ts
 * proves the entry can never afterwards be edited. None of that is repeated here.
 *
 * What is only checkable here is what the *screen* claims:
 *
 *   **The figures and the movements behind them arrive on one answer**, so that the person
 *   typing a correction can see what they are correcting without opening a second screen.
 *
 *   **An adjustment is in that ledger the moment it is posted**, with its sign, its reason
 *   and the administrator who wrote it. That is the story's second criterion and it is a
 *   property of these two routes together rather than of either alone.
 *
 *   **Every refusal arrives as a sentence.** A blank reason, a movement of no days and an HR
 *   Officer reaching for the button all reached a browser as "something went wrong at our
 *   end" before there was a route.
 *
 * `buildApp` is the same function ../../src/main.ts calls. There is no second assembly.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Long enough for `sessionSecretFrom`, and nowhere near any real one. */
const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const guard = new Guard();
const system = theSystem('balance adjustment api fixtures');

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let movements: BalanceService;
let people: Record<string, string>;

let y2026: string;
let annualId: string;

interface JsonEntry {
  id: string;
  leaveTypeId: string;
  entryType: string;
  inWords: string;
  days: number;
  reason: string;
  correctsId: string | null;
  leaveRequestId: string | null;
  createdBy: string;
  createdByEmployeeId: string | null;
  createdAt: string;
}

/** The same, read as one of a run. */
interface JsonMovement extends JsonEntry {
  typeName: string;
  after: number;
}

interface JsonLine {
  leaveTypeId: string;
  code: string;
  name: string;
  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  owed: number;
  available: number;
  hasMoved: boolean;
}

interface JsonView {
  employee: {
    id: string;
    name: string;
    employeeNumber: string;
    jobTitle: string | null;
    hasLeft: boolean;
  };
  year: { id: string; label: string; isClosed: boolean };
  years: { id: string; label: string }[];
  lines: JsonLine[];
  ledger: JsonMovement[];
}

interface JsonMoved {
  entry: JsonEntry;
  balance: { adjustment: number; available: number };
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const requests = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  movements = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    /** FR 27, FR 37, LMS 506. The ledger this screen reads, and the door it writes through. */
    ledger: new LedgerRepository(db),
    adjustments: movements,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years,
    entitlementRules: new EntitlementRuleRepository(db),
    requests,
    leaveRequests: new LeaveRequestService(
      movements,
      guard,
      employees,
      types,
      years,
      requests,
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
    /** FR 25, §8.8, LMS 508. */
    holidayRecalculations: holidayRecalculationService(db, guard, movements),
    storage: new InMemoryStorage(),
    scanner: new SignatureScanner(),
    accounts,
    roles,
    delegations: delegationService(db, guard),
    organisation: new OrganisationRepository(db),
    emailWording: new EmailWordingRepository(db),
    audit: new AuditRepository(db),
    secret: SECRET,
  });

  /* Port 0, so the operating system picks one nothing else is on. */
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(async () => {
  /* The cache first and the ledger second, which is the order they depend in, and both by
     TRUNCATE because each table refuses a DELETE on every connection. */
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE leave_request_recalculation, leave_entitlement_event, leave_ledger_entry',
  );

  /* CASCADE, because a year is the heading a run of ledger entries is filed under. Put back
     rather than left, so the test that closes one cannot decide the next one. */
  await admin.query('TRUNCATE leave_year CASCADE');
  await admin.query('SELECT ensure_the_first_leave_years()');

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------- nothing without a session */

describe('the line everything is mounted behind', () => {
  it('answers 401 for the picker, for one person’s ledger and for posting one', async () => {
    expect((await fetch(`${origin}/api/balance-adjustments`)).status).toBe(401);
    expect((await fetch(`${origin}/api/balance-adjustments/${people.engineer}`)).status).toBe(401);

    const posted = await fetch(`${origin}/api/balance-adjustments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employeeId: people.engineer, days: 1, reason: 'no' }),
    });

    expect(posted.status).toBe(401);
  });
});

/* --------------------------------------------------------------------------- the picker */

describe('who can be adjusted', () => {
  it('is everybody, with the leavers marked', async () => {
    const { employees } = (await (
      await get('/api/balance-adjustments', people.headOfHr)
    ).json()) as { employees: JsonView['employee'][] };

    expect(employees.length).toBeGreaterThan(10);

    const gone = employees.find((one) => one.id === people.leaver);

    /* FR 06. In the list and marked rather than hidden: a leaver's final figure is exactly
       the kind of thing FR 37a leaves HR to correct by hand. */
    expect(gone?.hasLeft).toBe(true);
    expect(gone?.name).toBe('Kojo Antwi');
    expect(employees.find((one) => one.id === people.engineer)?.hasLeft).toBe(false);
  });

  /* The picker *is* the screen, so somebody who cannot read the directory is refused rather
     than shown an empty one. Silently, because an employee list is not theirs to know about. */
  it('and is refused for somebody who does not read every record', async () => {
    expect((await get('/api/balance-adjustments', people.engineer)).status).toBe(404);
    expect((await get('/api/balance-adjustments', people.hrOfficer)).status).toBe(200);
  });
});

/* -------------------------------------------------------------- what is on the screen */

describe('one person’s balances, and the movements behind them', () => {
  it('arrive on one answer', async () => {
    await grant(people.engineer, annualId, y2026, 20);

    const view = (await (
      await get(`/api/balance-adjustments/${people.engineer}?leaveYearId=${y2026}`, people.headOfHr)
    ).json()) as JsonView;

    expect(view.employee.name).toBe('Yram Kudjo');
    expect(view.employee.employeeNumber).toBe('RH-0008');
    expect(view.year.label).toBe('2026');
    expect(view.years.length).toBeGreaterThan(0);

    const annual = view.lines.find((line) => line.code === 'ANNUAL');

    expect(annual?.entitled).toBe(20);
    expect(annual?.available).toBe(20);

    /* FR 27. The grant is a movement like any other, with the figure it left behind it. */
    expect(view.ledger).toHaveLength(1);
    expect(view.ledger[0].entryType).toBe('GRANT');
    expect(view.ledger[0].typeName).toBe('Annual Leave');
    expect(view.ledger[0].inWords).toBe('granted for the year');
    expect(view.ledger[0].after).toBe(20);
  });

  /* The two halves of the screen are about one year, always. A ledger showing last year's
     movements beside this year's figures is how a correction lands in the wrong year. */
  it('and are always about the same leave year', async () => {
    const y2027 = await yearIdOf('2027');

    await grant(people.engineer, annualId, y2026, 20);
    await grant(people.engineer, annualId, y2027, 25);

    const view = (await (
      await get(`/api/balance-adjustments/${people.engineer}?leaveYearId=${y2027}`, people.headOfHr)
    ).json()) as JsonView;

    expect(view.year.label).toBe('2027');
    expect(view.ledger).toHaveLength(1);
    expect(view.ledger[0].after).toBe(25);
  });

  /* FR 55. The screen is HR's, and the ledger behind it is not HR's alone: the person whose
     balance it is and their line manager read the same movements. */
  it('and are readable by the person themselves and by their manager', async () => {
    await grant(people.engineer, annualId, y2026, 20);

    expect((await get(`/api/balance-adjustments/${people.engineer}`, people.engineer)).status).toBe(
      200,
    );
    expect(
      (await get(`/api/balance-adjustments/${people.engineer}`, people.headOfEngineering)).status,
    ).toBe(200);
    expect((await get(`/api/balance-adjustments/${people.engineer}`, people.officer)).status).toBe(
      404,
    );
  });
});

/* ------------------------------------------------------------ the story's two criteria */

describe('adjusting a balance', () => {
  it('gives days, and says what the balance became', async () => {
    await grant(people.engineer, annualId, y2026, 20);

    const posted = await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 3,
      reason: 'Three days owed from the 2025 handover that were never carried over.',
    });

    expect(posted.status).toBe(201);

    const moved = (await posted.json()) as JsonMoved;

    expect(moved.entry.days).toBe(3);
    expect(moved.entry.entryType).toBe('ADJUSTMENT');
    expect(moved.balance.adjustment).toBe(3);
    expect(moved.balance.available).toBe(23);

    /* And the answer carries no running total, because one movement read on its own has
       none. What the screen says afterwards is the balance above, not a subtotal. */
    expect(moved.entry).not.toHaveProperty('after');
    expect(moved.entry).not.toHaveProperty('typeName');
  });

  /* FR 37's "positive or negative", and the same call for both. An adjustment is the one
     entry type free in its sign, so the direction is the caller's to state. */
  it('and takes them, with the same call and the opposite sign', async () => {
    await grant(people.engineer, annualId, y2026, 20);

    const moved = (await (
      await send('POST', '/api/balance-adjustments', people.headOfHr, {
        employeeId: people.engineer,
        leaveTypeId: annualId,
        leaveYearId: y2026,
        days: -2,
        reason: 'Two days granted twice in error.',
      })
    ).json()) as JsonMoved;

    expect(moved.entry.days).toBe(-2);
    expect(moved.balance.available).toBe(18);
  });

  /**
   * The story's second criterion, end to end.
   *
   * The reason is what somebody reads when they ask why they have twenty three days rather
   * than twenty, so it is asserted on the row a person would actually be looking at rather
   * than on the column.
   */
  it('and the adjustment is in the employee’s ledger afterwards, with its reason', async () => {
    await grant(people.engineer, annualId, y2026, 20);

    await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 3,
      reason: '  Three days owed from the 2025 handover.  ',
    });

    const view = (await (
      await get(`/api/balance-adjustments/${people.engineer}?leaveYearId=${y2026}`, people.engineer)
    ).json()) as JsonView;

    const adjustment = view.ledger.find((one) => one.entryType === 'ADJUSTMENT');

    expect(view.ledger).toHaveLength(2);
    expect(adjustment?.days).toBe(3);
    expect(adjustment?.after).toBe(23);
    expect(adjustment?.inWords).toBe('adjusted by hand');
    expect(adjustment?.reason).toBe('Three days owed from the 2025 handover.');
    /** NFR AUD 01. Permanently explained includes permanently attributed. */
    expect(adjustment?.createdByEmployeeId).toBe(people.headOfHr);

    expect(view.lines.find((line) => line.code === 'ANNUAL')?.available).toBe(23);
  });

  /* §8.9. The one kind of entry a settled year accepts, and the only way to put a closed
     figure right. A screen that refused it would leave last year wrong for ever. */
  it('and a closed leave year still takes one', async () => {
    /* A year that has ended, so closing it is a legal thing to do at all. */
    await admin.query(
      "INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')",
    );

    const y2025 = await yearIdOf('2025');

    await grant(people.engineer, annualId, y2025, 20);
    await admin.query('UPDATE leave_year SET is_closed = TRUE WHERE id = $1', [y2025]);

    const posted = await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2025,
      days: 1,
      reason: 'A day taken in December that was recorded against the wrong year.',
    });

    expect(posted.status).toBe(201);

    /* And it is on the screen for that year, which is the only place it could be read. */
    const view = (await (
      await get(`/api/balance-adjustments/${people.engineer}?leaveYearId=${y2025}`, people.headOfHr)
    ).json()) as JsonView;

    expect(view.year.isClosed).toBe(true);
    expect(view.ledger.find((one) => one.entryType === 'ADJUSTMENT')?.after).toBe(21);
  });
});

/* -------------------------------------------------------------------------- refusals */

describe('what is refused, and what it says', () => {
  it('a blank reason, against the field that was left empty', async () => {
    const refused = await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 3,
      reason: '   ',
    });

    expect(refused.status).toBe(400);

    const problem = (await refused.json()) as { field?: string; message: string };

    expect(problem.field).toBe('reason');
    expect(problem.message).toContain('reason');

    const { rows } = await admin.query('SELECT id FROM leave_ledger_entry');

    expect(rows).toHaveLength(0);
  });

  it('and a movement of no days, which explains nothing', async () => {
    const refused = await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 0,
      reason: 'Nothing to say.',
    });

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { field?: string }).field).toBe('days');
  });

  /**
   * §10's matrix, over HTTP, and the refusal is spoken rather than silent.
   *
   * The story says HR Officer and the matrix has an ✗ against that column; the code follows
   * the matrix, for the reason ../../src/features/balance/policy.ts gives. An Officer can
   * reach this screen and read the ledger on it, so the one thing they must not meet is a
   * button that fails without saying which desk can press it.
   */
  it('and an HR Officer, who is told which desk posts one', async () => {
    const refused = await send('POST', '/api/balance-adjustments', people.hrOfficer, {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 3,
      reason: 'Three days owed.',
    });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain('HR Administrator');
  });

  it('and a manager, and the person whose balance it is', async () => {
    const body = {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 3,
      reason: 'Three days owed.',
    };

    expect(
      (await send('POST', '/api/balance-adjustments', people.headOfEngineering, body)).status,
    ).toBe(403);
    expect((await send('POST', '/api/balance-adjustments', people.engineer, body)).status).toBe(
      403,
    );
  });

  /* An id that is nobody's is a sentence naming the field rather than a foreign key, which
     is the whole of why `adjust` checks the three ids nothing else checks. */
  it('and a leave type that is nothing', async () => {
    const refused = await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: people.engineer,
      leaveTypeId: '987654321',
      leaveYearId: y2026,
      days: 3,
      reason: 'Three days owed.',
    });

    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: string }).error).toBe('LeaveTypeNotFound');
  });

  /* NFR SEC 03. An employee id that is nobody's is answered exactly as one that is somebody
     else's, so the pair is not a way of asking whether a number belongs to anybody. */
  it('and an employee who is nobody, without saying so', async () => {
    const refused = await send('POST', '/api/balance-adjustments', people.headOfHr, {
      employeeId: '987654321',
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 3,
      reason: 'Three days owed.',
    });

    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: string }).error).toBe('NotFound');
  });
});

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

/** A year of entitlement, so there is a figure for an adjustment to be a correction of. */
async function grant(
  employeeId: string,
  leaveTypeId: string,
  leaveYearId: string,
  days: number,
): Promise<unknown> {
  return movements.grantTheYear(system, {
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
