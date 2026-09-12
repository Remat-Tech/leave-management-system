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
import { EmployeeService } from '../../src/features/employee/employee.service.js';
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
 * The leaver figure, end to end. FR 37a, §8.6d, §8.7. LMS 509.
 *
 * ../unit/leaver-statement.test.ts proves the arithmetic and the working, which are pure.
 * What is only checkable against a server:
 *
 *   **The figures are the ones a real ledger produced.** A grant, an approved absence and a
 *   correction, then the settlement read back off the cache those three moved.
 *
 *   **Recording an exit cancels what nobody had decided**, and leaves approved leave exactly
 *   where it is. That is the story's fourth criterion and it is a claim about two rows and a
 *   `RELEASE`, made through the same door HR records a leaving with.
 *
 *   **The refusals arrive as sentences.** Somebody still here, and an exit date in no leave
 *   year, both reached a browser as "something went wrong at our end" before this route.
 *
 * `buildApp` is the same function ../../src/main.ts calls. There is no second assembly.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Long enough for `sessionSecretFrom`, and nowhere near any real one. */
const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const guard = new Guard();
const system = theSystem('leaver figure fixtures');

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let movements: BalanceService;
let leaveRequests: LeaveRequestService;
let employees: EmployeeService;
let requestRows: LeaveRequestRepository;
let people: Record<string, string>;

let y2026: string;
let annualId: string;
let sickId: string;

/** Yram's exit, which is 212 of 2026's 365 days: 20 × 212/365 = 11.62. */
const EXIT = '2026-07-31';

/** Nine days in March costing six, the figure the rest of the suite uses. */
const TAKEN_FROM = '2026-03-02';
const TAKEN_TO = '2026-03-10';

/** A week in November nobody will have decided, which is what the exit cancels. */
const ASKED_FROM = '2026-11-02';
const ASKED_TO = '2026-11-06';

interface JsonStep {
  label: string;
  days: number;
  part: 'ADDS' | 'TAKES' | 'EXPLAINS';
  says: string;
}

interface JsonLine {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasisLabel: string;
  fullYearDays: number;
  accrued: number;
  granted: number;
  grantedAhead: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  owed: number;
  availableOnTheBalance: number;
  working: JsonStep[];
}

interface JsonSettlement {
  employeeId: string;
  employeeNumber: string;
  name: string;
  jobTitle: string | null;
  startDate: string;
  exitDate: string;
  year: { id: string; label: string; isClosed: boolean };
  portion: { from: string; to: string };
  proRataRule: { name: string; says: string };
  lines: JsonLine[];
}

interface JsonLeaver {
  id: string;
  name: string;
  employeeNumber: string;
  jobTitle: string | null;
  exitDate: string | null;
}

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employeeRepository = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  requestRows = new LeaveRequestRepository(db);

  movements = new BalanceService(
    new BalanceRepository(db),
    guard,
    employeeRepository,
    new Transactions(db),
  );

  leaveRequests = new LeaveRequestService(
    movements,
    guard,
    employeeRepository,
    types,
    years,
    requestRows,
    decisions,
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    roles,
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  /** FR 46, §8.7. The wiring the fourth criterion is: the employee door holding the leave door. */
  employees = new EmployeeService(
    employeeRepository,
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    leaveRequests,
    { domains: ['rematholdings.com'] },
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employeeRepository, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    ledger: new LedgerRepository(db),
    adjustments: movements,
    employees: employeeRepository,
    departments: new DepartmentRepository(db),
    types,
    years,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: requestRows,
    leaveRequests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
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
  /* FR 18, LMS 308. The fixture days are months behind today, as every suite here widens for. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await admin.query<{ id: string }>("SELECT id FROM leave_year WHERE label = '2026'"))
    .rows[0].id;
  annualId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'ANNUAL'"))
    .rows[0].id;
  sickId = (await admin.query<{ id: string }>("SELECT id FROM leave_type WHERE code = 'SICK'"))
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

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, ' +
      'leave_request_reclassification, leave_request_attachment, leave_request_decision, ' +
      'leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
  );
}

/* ------------------------------------------------------- nothing without a session */

describe('the line everything is mounted behind', () => {
  it('answers 401 for the picker and for one leaver’s figure', async () => {
    expect((await fetch(`${origin}/api/leavers`)).status).toBe(401);
    expect((await fetch(`${origin}/api/leavers/${people.leaver}`)).status).toBe(401);
  });
});

/* --------------------------------------------------------------------- the picker */

describe('who has left', () => {
  it('is the terminated records and nobody else', async () => {
    const { leavers } = (await (await get('/api/leavers', people.headOfHr)).json()) as {
      leavers: JsonLeaver[];
    };

    expect(leavers.map((one) => one.name)).toEqual(['Kojo Antwi']);
    expect(leavers[0].exitDate).toBe('2026-07-31');
    expect(leavers[0].employeeNumber).toBe('RH-0013');
  });

  /* The picker is the directory, so somebody who cannot read one is refused rather than
     shown an empty list. Silently: who has left is not everybody's to know. */
  it('and is refused for somebody who does not read every record', async () => {
    expect((await get('/api/leavers', people.engineer)).status).toBe(404);
    expect((await get('/api/leavers', people.hrOfficer)).status).toBe(200);
  });

  /** FR 06. Somebody terminated during the session is on it, which is the record changing. */
  it('and grows the moment a leaving is recorded', async () => {
    await recordTheLeaving();

    const { leavers } = (await (await get('/api/leavers', people.headOfHr)).json()) as {
      leavers: JsonLeaver[];
    };

    expect(leavers.map((one) => one.name)).toContain('Yram Kudjo');
  });
});

/* ----------------------------------------------------------- the figure, end to end */

describe('a leaver’s figure', () => {
  /**
   * The story's first criterion, against a ledger rather than against a fixture.
   *
   * Twenty days granted, six taken as approved leave, one added by hand, and the exit in
   * July: 11.62 accrued + 1 adjusted − 6 taken = 6.62 owed. The balance screen says 15,
   * because that figure is drawn against a whole year's grant.
   */
  it('is the accrual to the exit date, less what a real ledger says was taken', async () => {
    await twentyDaysFor(people.engineer);
    await approvedLeaveFor(people.engineer);

    await movements.adjust(asTheHeadOfHr(), {
      employeeId: people.engineer,
      leaveTypeId: annualId,
      leaveYearId: y2026,
      days: 1,
      reason: 'A day owed from the 2025 handover that was never carried over.',
    });

    await recordTheLeaving();

    const line = annualLineOf(await settlementFor(people.engineer));

    expect(line.fullYearDays).toBe(20);
    expect(line.accrued).toBe(11.62);
    expect(line.granted).toBe(20);
    expect(line.grantedAhead).toBe(8.38);
    expect(line.adjustment).toBe(1);
    expect(line.taken).toBe(6);
    expect(line.pending).toBe(0);
    expect(line.owed).toBe(6.62);
    expect(line.availableOnTheBalance).toBe(15);
  });

  /** The story's second criterion: every step of the sum, in the order it is performed. */
  it('and arrives with the working that reaches it', async () => {
    await twentyDaysFor(people.engineer);
    await approvedLeaveFor(people.engineer);
    await recordTheLeaving();

    const line = annualLineOf(await settlementFor(people.engineer));

    expect(line.working.map((step) => step.label)).toEqual([
      'A whole year of Annual Leave',
      'Accrued to 2026-07-31',
      'Granted in 2026',
      'Carried over from the year before',
      'Taken',
      'Owed on exit',
    ]);

    /* The steps that enter the sum reach the answer, which is what "showing its working"
       has to mean if a payment is going to be checked against it. */
    const entering = line.working.filter((step) => step.part !== 'EXPLAINS');

    expect(round(entering.reduce((running, step) => running + step.days, 0))).toBe(line.owed);
  });

  /**
   * The story's third criterion, and it is a column rather than a code.
   *
   * Sick leave is granted and taken in the same year and is not on the settlement: three
   * days is an allowance for being here rather than something accrued, which is what
   * `prorate_on_join` says about it.
   */
  it('and covers only the leave that accrues over the year', async () => {
    await twentyDaysFor(people.engineer);

    await movements.grantTheYear(system, {
      employeeId: people.engineer,
      leaveTypeId: sickId,
      leaveYearId: y2026,
      days: 3,
      reason: 'Sick leave entitlement for 2026',
    });

    await recordTheLeaving();

    const settlement = await settlementFor(people.engineer);

    expect(settlement.lines.map((line) => line.code)).toEqual(['ANNUAL']);
  });

  it('and says who it is about, when they went, and which year it settles', async () => {
    await twentyDaysFor(people.engineer);
    await recordTheLeaving();

    const settlement = await settlementFor(people.engineer);

    expect(settlement.name).toBe('Yram Kudjo');
    expect(settlement.exitDate).toBe(EXIT);
    expect(settlement.year.label).toBe('2026');
    expect(settlement.portion).toEqual({ from: '2026-01-01', to: EXIT });
    /** LMS 013. The figure says which rule produced it, as the grant's reason does. */
    expect(settlement.proRataRule.name).toBe('calendar-days');
  });

  /* FR 53's read rule, and this is the same balance settled rather than a new record: the
     person's own, their manager's, and a role that reads everybody. */
  it('and is read by their manager and by HR, and by nobody else', async () => {
    await recordTheLeaving();

    expect((await get(`/api/leavers/${people.engineer}`, people.headOfEngineering)).status).toBe(
      200,
    );
    expect((await get(`/api/leavers/${people.engineer}`, people.headOfHr)).status).toBe(200);
    expect((await get(`/api/leavers/${people.engineer}`, people.officer)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------ the refusals */

describe('a figure that cannot be given', () => {
  /* Not a 404 and not a five hundred: the person is real and the request is well formed,
     and what refuses it is a record with no ending on it. */
  it('is refused for somebody who has not left, with the fix in the sentence', async () => {
    const refused = await get(`/api/leavers/${people.engineer}`, people.headOfHr);

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('StillEmployed');
    expect(problem.message).toContain('has not left');
  });

  /** §5.4. An exit in a year nobody has defined, which is a gap only HR can close. */
  it('and where no leave year covers the exit date', async () => {
    await admin.query('UPDATE employee SET exit_date = $1 WHERE id = $2', [
      '2029-04-01',
      people.leaver,
    ]);

    const refused = await get(`/api/leavers/${people.leaver}`, people.headOfHr);

    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'NoLeaveYearCoversTheExitDate',
    );
  });

  /* NFR SEC 03. An id that is nobody's is answered exactly as one that is somebody else's. */
  it('and for an employee who is nobody, without saying so', async () => {
    const refused = await get('/api/leavers/987654321', people.headOfHr);

    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: string }).error).toBe('NotFound');
  });
});

/* ------------------------------------------------- the fourth criterion. FR 46, §8.7 */

describe('recording that somebody has left', () => {
  it('cancels the leave nobody had decided, and gives the days back', async () => {
    await twentyDaysFor(people.engineer);

    const asked = await askForLeave(people.engineer, ASKED_FROM, ASKED_TO);

    expect((await requestRows.findById(asked))!.status).toBe('SUBMITTED');

    await recordTheLeaving();

    const after = (await requestRows.findById(asked))!;

    expect(after.status).toBe('CANCELLED');
    /* `leave_request_waits_at_a_desk`: leave that has ended is waiting on nobody, so it
       cannot be left sitting in a manager's queue for ever. */
    expect(after.awaitingApprovalFrom).toBeNull();

    const line = annualLineOf(await settlementFor(people.engineer));

    expect(line.pending).toBe(0);
    expect(line.taken).toBe(0);
  });

  /** FR 27. The `RELEASE` says why, because nobody pressed a button to cause it. */
  it('and the movement that gives them back says the employment ended', async () => {
    await twentyDaysFor(people.engineer);
    await askForLeave(people.engineer, ASKED_FROM, ASKED_TO);
    await recordTheLeaving();

    const { rows } = await admin.query<{ reason: string }>(
      "SELECT reason FROM leave_ledger_entry WHERE entry_type = 'RELEASE' AND employee_id = $1",
      [people.engineer],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain('Yram Kudjo left on 2026-07-31');
  });

  /**
   * And leave already approved stands.
   *
   * Those days are `taken` rather than `pending`, so giving them back is a movement against
   * the `DEDUCTION` and HR's judgement — FR 47's door with a reason on it — rather than a
   * consequence of a date. The figure counts them as taken, which is what makes it right.
   */
  it('and leaves leave that was already approved exactly where it is', async () => {
    await twentyDaysFor(people.engineer);

    const approved = await approvedLeaveFor(people.engineer);
    const asked = await askForLeave(people.engineer, ASKED_FROM, ASKED_TO);

    await recordTheLeaving();

    expect((await requestRows.findById(approved))!.status).toBe('APPROVED');
    expect((await requestRows.findById(asked))!.status).toBe('CANCELLED');

    expect(annualLineOf(await settlementFor(people.engineer)).taken).toBe(6);
  });

  /* Nothing to cancel is not a failure, and it is the ordinary case: most people who leave
     have no request outstanding. */
  it('and records a leaving with nothing outstanding without complaint', async () => {
    const gone = await recordTheLeaving();

    expect(gone.employmentStatus).toBe('TERMINATED');
    expect(gone.exitDate).toBe(EXIT);
  });
});

/* -------------------------------------------------------------------------- fixtures */

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

async function settlementFor(employeeId: string): Promise<JsonSettlement> {
  const answer = await get(`/api/leavers/${employeeId}`, people.headOfHr);

  expect(answer.status).toBe(200);

  return (await answer.json()) as JsonSettlement;
}

function annualLineOf(settlement: JsonSettlement): JsonLine {
  const line = settlement.lines.find((one) => one.leaveTypeId === annualId);

  if (line === undefined) {
    throw new Error(
      `Nothing was settled for annual leave. The settlement had ` +
        `${settlement.lines.map((one) => one.code).join(', ') || 'no lines'}.`,
    );
  }

  return line;
}

/** The act every test here turns on. FR 06. */
async function recordTheLeaving() {
  return employees.terminate(asTheHeadOfHr(), people.engineer, { exitDate: EXIT });
}

async function twentyDaysFor(employeeId: string): Promise<void> {
  await movements.grantTheYear(system, {
    employeeId,
    leaveTypeId: annualId,
    leaveYearId: y2026,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
}

/** A request in the state the exit is supposed to end. */
async function askForLeave(employeeId: string, from: string, to: string): Promise<string> {
  const { request } = await leaveRequests.submit(asTheEngineer(), {
    employeeId,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'My sister is getting married',
    /** FR 17, LMS 307. */
    acknowledgesShortNotice: true,
  });

  return request.id;
}

/** Six days through the whole chain, so the settlement has real taken days in it. */
async function approvedLeaveFor(employeeId: string): Promise<string> {
  const id = await askForLeave(employeeId, TAKEN_FROM, TAKEN_TO);

  await leaveRequests.approve(asTheHeadOfEngineering(), id);
  await leaveRequests.approve(asTheHeadOfHr(), id);

  return id;
}

function asTheEngineer(): Actor {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheHeadOfEngineering(): Actor {
  return signedInAs(people.headOfEngineering, { roles: ['EMPLOYEE'], isManager: true });
}

function asTheHeadOfHr(): Actor {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

function round(days: number): number {
  return Math.round(days * 100) / 100;
}
