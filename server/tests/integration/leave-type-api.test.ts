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
import { delegationService } from '../support/delegations.js';

/**
 * Setting leave types up, over HTTP. FR 31, FR 32. LMS 501.
 *
 * ../unit/leave-type.test.ts proves the rules against types it configures itself, and
 * ./leave-type.test.ts proves the table and the repository. Neither can say anything about
 * the claim this story actually makes, which is about a *deployment*:
 *
 *   **A policy change is a form, not a release.** A type created through the API is on the
 *   request form of the next person who opens it, with its rules, in the same process. That
 *   is the story's "so that", and it is only checkable end to end.
 *
 *   **Counting basis and documentation rule are the two the story names**, and both are
 *   editable afterwards: a type created counting working days is switched to calendar days
 *   and the day count a quote gives moves with it.
 *
 *   **Reading is anybody's, writing is an HR Administrator's.** The temptation was to make
 *   the whole resource theirs; the person who most needs to read a notice window is the one
 *   about to miss it. So the list answers for everybody and every write refuses with the
 *   server's own sentence.
 *
 *   **A refusal arrives as a sentence naming the field.** A duplicate code and a
 *   documentation rule that disagrees with its threshold are the two mistakes this form
 *   makes, and both reached the browser as "something went wrong at our end" before the
 *   route existed.
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
let people: Record<string, string>;

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
    years,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: requestRepository,
    leaveRequests: new LeaveRequestService(
      balances,
      guard,
      employees,
      types,
      years,
      requestRepository,
      decisions,
      new LeaveRoutingRepository(db),
      new WithdrawalRepository(db),
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
});

beforeEach(async () => {
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_attachment, ' +
      'leave_request_decision, leave_request_reassignment, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request, leave_balance',
  );

  /* Every test that adds a type adds it under its own code, so the seven shipped rows are
     left where they are and nothing here has to put them back. */
  await admin.query("DELETE FROM leave_type WHERE code LIKE 'TEST_%'");

  people = (await seed(admin)) as Record<string, string>;
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
  it('answers 401 for reading types and for every way of writing one', async () => {
    expect((await fetch(`${origin}/api/leave-types`)).status).toBe(401);

    const created = await fetch(`${origin}/api/leave-types`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'TEST_X', name: 'X', countingBasis: 'WORKING_DAYS' }),
    });

    expect(created.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ who may do what */

describe('who sets leave types up', () => {
  /**
   * §10, and the decision the leave type policy is emphatic about: the whole resource was
   * not made HR's, because the person who most needs to read a notice window is the one
   * about to miss it.
   */
  it('lets anybody signed in read them', async () => {
    const response = await get('/api/leave-types', people.officer);

    expect(response.status).toBe(200);
    expect(codesIn(await response.json()).length).toBeGreaterThan(0);
  });

  /** NFR SEC 02, NFR USA 03. Refused openly, and the sentence says who to ask. */
  it('refuses a write by anybody who is not an HR Administrator, and says why', async () => {
    const refused = await send('POST', '/api/leave-types', people.officer, {
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'CALENDAR_DAYS',
      entitlementBasis: 'EVENT',
    });

    expect(refused.status).toBe(403);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('NotAuthorised');
    expect(problem.message).toContain('HR Administrator');

    /* And nothing was written. A refusal that half applied would be worse than one that
       said nothing at all. */
    expect(await codesInTheTable()).not.toContain('TEST_SABBATICAL');
  });

  /** An HR Officer sets up staff records and the calendar, and not the leave rules. */
  it('refuses an HR Officer too', async () => {
    const refused = await send('POST', '/api/leave-types', people.hrOfficer, {
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'CALENDAR_DAYS',
      entitlementBasis: 'EVENT',
    });

    expect(refused.status).toBe(403);
  });
});

/* ------------------------------------------------------ a policy change, without a release */

describe('creating a kind of leave', () => {
  /**
   * The story's first criterion, and its "so that": no code change and no deployment.
   *
   * The proof is that the type reaches a *request form* in the same process — a row an
   * administrator wrote a second ago, offered with its own rules, to somebody who is not
   * the person who wrote it.
   */
  it('puts it on the request form the moment it is created, rules and all', async () => {
    const created = await send('POST', '/api/leave-types', people.headOfHr, {
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      description: 'A term away, for staff of ten years or more.',
      countingBasis: 'CALENDAR_DAYS',
      entitlementBasis: 'EVENT',
      documentation: 'ALWAYS',
      minNoticeCalendarDays: 90,
      approvalChain: ['HR', 'CEO'],
    });

    expect(created.status).toBe(201);

    const type = (await created.json()) as JsonLeaveType;

    /* The counting basis and the chain as the server says them, which is what the screen
       shows: neither is a word this system lets a browser choose. */
    expect(type.countingBasisLabel).toBe('Calendar days');
    expect(type.approvedBy).toBe('HR then the Chief Executive');
    expect(type.isActive).toBe(true);

    const form = await formFor(people.officer);
    const offered = form.types.find((one) => one.code === 'TEST_SABBATICAL');

    expect(offered).toBeDefined();
    expect(offered?.name).toBe('Sabbatical');
    expect(offered?.documentation).toBe('ALWAYS');
    expect(offered?.minNoticeCalendarDays).toBe(90);
    expect(offered?.approvedBy).toBe('HR then the Chief Executive');
  });

  /** FR 32. Everything the caller did not mention is the domain's default, not a null. */
  it('applies the defaults it publishes, rather than leaving the record half written', async () => {
    const settings = (await (await get('/api/leave-types', people.headOfHr)).json()) as JsonList;

    const created = await send('POST', '/api/leave-types', people.headOfHr, {
      code: 'TEST_PLAIN',
      name: 'Plain leave',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    const type = (await created.json()) as JsonLeaveType;

    expect(type.maxBackdateCalendarDays).toBe(settings.defaults.maxBackdateCalendarDays);
    expect(type.reasonRequired).toBe(settings.defaults.reasonRequired);
    expect(type.unit).toBe(settings.defaults.unit);
    expect(type.approvalChain).toEqual(settings.defaults.approvalChain);
  });

  /**
   * NFR USA 03. Both halves: the status says it is a clash rather than a fault, and the
   * body names the box. Without the entry in `REFUSED_BY_A_RULE` this arrived as a 500.
   */
  it('answers a code another type already has with a sentence naming the field', async () => {
    const refused = await send('POST', '/api/leave-types', people.headOfHr, {
      code: 'ANNUAL',
      name: 'Something else entirely',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string; field?: string };

    expect(problem.error).toBe('DuplicateLeaveTypeCode');
    expect(problem.field).toBe('code');
    expect(problem.message).toContain('already a leave type with the code');
  });

  /**
   * The one pair of fields that may not disagree, arriving as a 400 with the field on it.
   * `documentation` and `documentationAfterDays` are one rule between them.
   */
  it('refuses a documentation rule that disagrees with its threshold, and says which box', async () => {
    const refused = await send('POST', '/api/leave-types', people.headOfHr, {
      code: 'TEST_BAD',
      name: 'Half a rule',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      documentation: 'AFTER_DAYS',
    });

    expect(refused.status).toBe(400);

    const problem = (await refused.json()) as { error: string; message: string; field?: string };

    expect(problem.error).toBe('InvalidLeaveType');
    expect(problem.field).toBe('documentationAfterDays');
  });
});

/* --------------------------------------------------------------------- editing one */

describe('editing a kind of leave', () => {
  /**
   * The story's second criterion, on the two rules it names. The day count is the proof
   * rather than the column: a quote over a period containing a weekend answers differently
   * once the basis has been edited, in the same process, with nothing redeployed.
   */
  it('changes the counting basis, and the day count moves with it', async () => {
    const id = await create({
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    /* Two to six March 2026 is a Monday to a Friday, and the seventh and eighth are the
       weekend. Nine calendar days, five of them working. */
    const asWorkingDays = await quote(people.officer, id, '2026-03-02', '2026-03-10');

    expect(asWorkingDays.days).toBe(6);
    expect(asWorkingDays.calendarDays).toBe(9);

    const edited = await send('PATCH', `/api/leave-types/${id}`, people.headOfHr, {
      countingBasis: 'CALENDAR_DAYS',
    });

    expect(edited.status).toBe(200);
    expect(((await edited.json()) as JsonLeaveType).countingBasisLabel).toBe('Calendar days');

    const asCalendarDays = await quote(people.officer, id, '2026-03-02', '2026-03-10');

    expect(asCalendarDays.days).toBe(9);
  });

  /** FR 13, the other rule the story names, reaching the form it is asked on. */
  it('changes the documentation rule, and the request form says so', async () => {
    const id = await create({
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    expect(await documentationOnTheForm('TEST_SABBATICAL')).toBe('NOT_REQUIRED');

    await send('PATCH', `/api/leave-types/${id}`, people.headOfHr, {
      documentation: 'AFTER_DAYS',
      documentationAfterDays: 3,
    });

    expect(await documentationOnTheForm('TEST_SABBATICAL')).toBe('AFTER_DAYS');
  });

  /**
   * A PATCH changes what it names and nothing else.
   *
   * The failure this rules out is the one two administrators with the same form open would
   * hit: a save carrying every field reverts whatever the other one had just changed.
   */
  it('leaves every field the change did not name exactly where it was', async () => {
    const id = await create({
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      minNoticeCalendarDays: 90,
      reasonRequired: false,
    });

    const renamed = (await (
      await send('PATCH', `/api/leave-types/${id}`, people.headOfHr, { name: 'Study break' })
    ).json()) as JsonLeaveType;

    expect(renamed.name).toBe('Study break');
    expect(renamed.code).toBe('TEST_SABBATICAL');
    expect(renamed.minNoticeCalendarDays).toBe(90);
    expect(renamed.reasonRequired).toBe(false);
  });

  /** FR 38a. Its own door, because it is its own table and its own refusals. */
  it('says who approves it, in order', async () => {
    const id = await create({
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    const set = await send('PUT', `/api/leave-types/${id}/approval-chain`, people.headOfHr, {
      approvalChain: ['CEO', 'MANAGER'],
    });

    expect(set.status).toBe(200);

    const type = (await set.json()) as JsonLeaveType;

    expect(type.approvalChain).toEqual(['CEO', 'MANAGER']);
    expect(type.approvedBy).toBe('the Chief Executive then your manager');
  });

  /** One desk is asked once. A second stage naming it waits on somebody who has answered. */
  it('refuses a chain that names the same desk twice', async () => {
    const id = await create({
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    const refused = await send('PUT', `/api/leave-types/${id}/approval-chain`, people.headOfHr, {
      approvalChain: ['HR', 'HR'],
    });

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { field?: string }).field).toBe('approvalChain');
  });
});

/* ------------------------------------------------------------ taking one out of use */

describe('retiring a kind of leave', () => {
  /**
   * A type is retired, never deleted: it heads every request and every report ever filed
   * under it. What retiring does is stop it being offered, and it is reversible.
   */
  it('stops it being offered, keeps it readable, and puts it back', async () => {
    const id = await create({
      code: 'TEST_SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
    });

    expect(await codesOnTheForm()).toContain('TEST_SABBATICAL');

    const retired = await send('POST', `/api/leave-types/${id}/retire`, people.headOfHr);

    expect(retired.status).toBe(200);
    expect(((await retired.json()) as JsonLeaveType).isActive).toBe(false);

    /* Off the form, and still on the configuration screen — which is where it is put back
       from, so a list that dropped it would be a one way door. */
    expect(await codesOnTheForm()).not.toContain('TEST_SABBATICAL');
    expect(codesIn(await (await get('/api/leave-types', people.headOfHr)).json())).toContain(
      'TEST_SABBATICAL',
    );

    const back = await send('POST', `/api/leave-types/${id}/reinstate`, people.headOfHr);

    expect(((await back.json()) as JsonLeaveType).isActive).toBe(true);
    expect(await codesOnTheForm()).toContain('TEST_SABBATICAL');
  });
});

/* ---------------------------------------------- the words a form draws its controls with */

describe('the vocabulary the form is drawn from', () => {
  /**
   * Every closed set, with both halves: the token a control is bound to and the words
   * beside it. A browser mapping `WORKING_DAYS` to "Working days" for itself would be a
   * second answer to what a basis is called, and the day the two disagree the page lies.
   */
  it('sends every choice, with the server naming each one', async () => {
    const settings = (await (await get('/api/leave-types', people.officer)).json()) as JsonList;

    expect(settings.choices.countingBases.map((one) => one.value)).toEqual([
      'WORKING_DAYS',
      'CALENDAR_DAYS',
    ]);
    expect(settings.choices.countingBases[0].label).toBe('Working days');
    /** FR 22. The explanation, for the help text under the control. */
    expect(settings.choices.countingBases[0].inWords).toContain('cost nothing');

    expect(settings.choices.documentationRules.map((one) => one.value)).toEqual([
      'NOT_REQUIRED',
      'ALWAYS',
      'AFTER_DAYS',
    ]);

    /** FR 05. Null is a choice, because "anybody" is what most types are. */
    expect(settings.choices.genderRestrictions[0].value).toBeNull();

    /** FR 38a. */
    expect(settings.choices.approvers.map((one) => one.label)).toEqual([
      'Manager',
      'HR',
      'Chief Executive',
    ]);
  });
});

/* ------------------------------------------------------------------------- fixtures */

interface JsonLeaveType {
  id: string;
  code: string;
  name: string;
  countingBasis: string;
  countingBasisLabel: string;
  unit: string;
  documentation: string;
  documentationAfterDays: number | null;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  reasonRequired: boolean;
  approvalChain: string[];
  approvedBy: string;
  isActive: boolean;
}

interface JsonChoice {
  value: string | null;
  label: string;
  inWords?: string;
}

interface JsonList {
  types: JsonLeaveType[];
  choices: Record<string, JsonChoice[]>;
  defaults: {
    unit: string;
    maxBackdateCalendarDays: number;
    reasonRequired: boolean;
    approvalChain: string[];
  };
}

interface JsonForm {
  types: {
    code: string;
    name: string;
    documentation: string;
    minNoticeCalendarDays: number;
    approvedBy: string;
  }[];
}

/** A new type by the one door that writes one, with its id. */
async function create(fields: Record<string, unknown>): Promise<string> {
  const response = await send('POST', '/api/leave-types', people.headOfHr, fields);

  expect(response.status).toBe(201);

  return ((await response.json()) as JsonLeaveType).id;
}

async function quote(
  employeeId: string,
  leaveTypeId: string,
  from: string,
  to: string,
): Promise<{ days: number; calendarDays: number }> {
  const query = new URLSearchParams({ leaveTypeId, from, to });
  const response = await get(`/api/me/requests/quote?${query.toString()}`, employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as { days: number; calendarDays: number };
}

async function formFor(employeeId: string): Promise<JsonForm> {
  const response = await get('/api/me/request-form', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonForm;
}

async function codesOnTheForm(): Promise<string[]> {
  return (await formFor(people.officer)).types.map((one) => one.code);
}

async function documentationOnTheForm(code: string): Promise<string | undefined> {
  return (await formFor(people.officer)).types.find((one) => one.code === code)?.documentation;
}

function codesIn(payload: unknown): string[] {
  return (payload as JsonList).types.map((one) => one.code);
}

async function codesInTheTable(): Promise<string[]> {
  const { rows } = await admin.query<{ code: string }>('SELECT code FROM leave_type');

  return rows.map((row) => row.code);
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
  body: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}`,
    },
    body: JSON.stringify(body),
  });
}
