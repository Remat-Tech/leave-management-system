import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
 * The entitlement rule screen, over HTTP. FR 31. LMS 502.
 *
 * ../unit/entitlement-rule.test.ts proves precedence, and ./entitlement-rule.test.ts proves
 * the table, the trigger and the closed-year boundary against a real database. What is only
 * checkable here is the claim the *screen* makes:
 *
 *   **A change of figure is a new rule, not an edit.** A rule dated ahead is a draft an
 *   administrator may still correct or withdraw; a rule that has taken effect is history,
 *   and the route says so with the sentence that names what to do instead.
 *
 *   **Last year is not rewritten by a form.** A date inside a closed leave year is refused
 *   over HTTP with a 409 rather than arriving as "something went wrong at our end", and the
 *   list carries the boundary so a date picker can stop somebody before they type it.
 *
 *   **Reading the list is HR's, because it holds personal arrangements**, and writing is an
 *   HR Administrator's. Both refusals arrive as the server's own sentence.
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

/** Dates read off the clock, so nothing here expires when the year turns. */
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = Number(TODAY.slice(0, 4));
const AHEAD = `${String(THIS_YEAR + 1)}-03-01`;
const FURTHER_AHEAD = `${String(THIS_YEAR + 1)}-09-01`;
const BEHIND = `${String(THIS_YEAR - 1)}-06-01`;

/**
 * The first leave year `ensure_the_first_leave_years()` writes, and the one before it.
 *
 * Hard coded rather than read off the clock, as ./entitlement-rule.test.ts hard codes them
 * and for the same reason: the years leave no gaps, so a year inserted before the first one
 * has to be the year immediately before it.
 */
const FIRST_YEAR = '2026';
const YEAR_BEFORE_IT = '2025';

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

/**
 * The seed truncates `leave_entitlement_rule` and puts the statutory figures back, so
 * every test starts from the seven company-wide rules of the FR 32 table and nothing else.
 */
beforeEach(async () => {
  await admin.query('TRUNCATE leave_ledger_entry, leave_entitlement_event, leave_balance');

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
  it('answers 401 for reading the rules and for adding one', async () => {
    expect((await fetch(`${origin}/api/entitlement-rules`)).status).toBe(401);

    const added = await fetch(`${origin}/api/entitlement-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entitlementDays: 25, effectiveFrom: AHEAD }),
    });

    expect(added.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ who may do what */

describe('who sets the figures', () => {
  it('answers an HR Administrator with every rule and the vocabulary a form needs', async () => {
    const settings = await settingsFor(people.headOfHr);

    expect(settings.rules.length).toBeGreaterThan(0);
    expect(settings.leaveTypes.length).toBeGreaterThan(0);
    expect(settings.departments.length).toBeGreaterThan(0);
    expect(settings.employees.length).toBeGreaterThan(0);
    expect(settings.scopes.map((one) => one.value)).toEqual([
      'EVERYBODY',
      'DEPARTMENT',
      'EMPLOYEE',
    ]);
    /* The day the "has it taken effect yet" question is judged against, so a screen never
       has to ask a browser's clock. */
    expect(settings.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * Unlike the leave types of LMS 501, the whole list *is* HR's — because a rule may name
   * one person, and the list of exceptions is the list of arrangements.
   */
  it('refuses the list to somebody who does not read every record, and says why', async () => {
    const refused = await get('/api/entitlement-rules', people.officer);

    expect(refused.status).toBe(403);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('NotAuthorised');
    expect(problem.message).toContain('personal arrangements');
  });

  /** An HR Officer reads every record, and does not set the figures anybody is owed. */
  it('lets an HR Officer read the rules and refuses their write', async () => {
    expect((await get('/api/entitlement-rules', people.hrOfficer)).status).toBe(200);

    const refused = await send('POST', '/api/entitlement-rules', people.hrOfficer, {
      leaveTypeId: await annual(),
      entitlementDays: 25,
      effectiveFrom: AHEAD,
    });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain('HR Administrator');

    /* And nothing was written. A refusal that half applied would be worse than one that
       said nothing at all. */
    expect(await daysInTheTable(AHEAD)).toEqual([]);
  });
});

/* ------------------------------------- a change of figure, without touching the old one */

describe('changing what a leave type is worth', () => {
  /**
   * The story's first criterion, and the whole of its "so that": this year's change is a
   * second row, and the figure that applied last year is exactly where it was.
   */
  it('adds a rule from a later date and leaves the one it supersedes alone', async () => {
    const leaveTypeId = await annual();
    const before = await ruleFor(people.headOfHr, leaveTypeId);

    const added = await send('POST', '/api/entitlement-rules', people.headOfHr, {
      leaveTypeId,
      entitlementDays: 25,
      carriesOver: true,
      carryoverMaxDays: 5,
      carryoverExpiryMonth: 3,
      effectiveFrom: AHEAD,
      note: 'Board minute 14/3.',
    });

    expect(added.status).toBe(201);

    const rule = (await added.json()) as JsonRule;

    expect(rule.entitlementDays).toBe(25);
    expect(rule.effectiveFrom).toBe(AHEAD);
    expect(rule.who).toBe('Everybody');
    /* Both sentences the server writes, because a browser composing either would be a
       second answer to what carrying over means. */
    expect(rule.carryoverInWords).toBe(
      'Unused days carry over, up to 5 days, and expire at the end of March.',
    );
    expect(rule.inWords).toContain('25 days');

    /* Still a draft, so it still carries the two buttons. */
    expect(rule.mayBeChanged).toBe(true);
    expect(rule.fixedBecause).toBeNull();
    expect(rule.inForce).toBe(false);

    /* The superseded rule by its own id, not by its scope: the new one shares that scope,
       which is the whole point of it. */
    const after = await ruleById(before.id);

    expect(after.entitlementDays).toBe(before.entitlementDays);
    expect(after.effectiveFrom).toBe(before.effectiveFrom);
    expect(after.id).not.toBe(rule.id);
  });

  /** Only what is sent changes, so two administrators with the form open do not collide. */
  it('corrects a rule that has not started yet, and only the fields named', async () => {
    const id = await addRule({ entitlementDays: 25, effectiveFrom: AHEAD, note: 'Draft.' });

    const corrected = await send('PATCH', `/api/entitlement-rules/${id}`, people.headOfHr, {
      entitlementDays: 26,
    });

    expect(corrected.status).toBe(200);

    const rule = (await corrected.json()) as JsonRule;

    expect(rule.entitlementDays).toBe(26);
    expect(rule.effectiveFrom).toBe(AHEAD);
    expect(rule.note).toBe('Draft.');
  });

  it('withdraws one that never applied to anybody', async () => {
    const id = await addRule({ entitlementDays: 25, effectiveFrom: AHEAD });

    expect((await send('DELETE', `/api/entitlement-rules/${id}`, people.headOfHr)).status).toBe(
      204,
    );

    const settings = await settingsFor(people.headOfHr);

    expect(settings.rules.map((one) => one.id)).not.toContain(id);
  });

  /** A rule may name one person, and that rule beats the company's for them. */
  it('takes a rule for one person, named in the answer', async () => {
    const added = await send('POST', '/api/entitlement-rules', people.headOfHr, {
      leaveTypeId: await annual(),
      employeeId: people.officer,
      entitlementDays: 30,
      effectiveFrom: AHEAD,
    });

    expect(added.status).toBe(201);

    const rule = (await added.json()) as JsonRule;

    expect(rule.scope).toBe('EMPLOYEE');
    expect(rule.scopeLabel).toBe('One person');
    expect(rule.employeeId).toBe(people.officer);
    /* The name rather than the id, because the id is not what an administrator is
       checking the rule against. */
    expect(rule.who).not.toBe(people.officer);
    expect(rule.who.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------- what has already applied is not rewritten */

describe('a rule that has taken effect', () => {
  /**
   * The story's second criterion. Both doors, and both sentences say the same thing: add a
   * rule from a later date. Without the entry in `REFUSED_BY_A_RULE` these arrived as a 500.
   */
  it('refuses a correction with a 409 that names what to do instead', async () => {
    const id = await addRule({ entitlementDays: 22, effectiveFrom: BEHIND });

    const refused = await send('PATCH', `/api/entitlement-rules/${id}`, people.headOfHr, {
      entitlementDays: 23,
    });

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('EntitlementRuleAlreadyApplies');
    expect(problem.message).toContain('effective from a later date');

    /* And the figure is untouched. */
    expect((await ruleById(id)).entitlementDays).toBe(22);
  });

  it('refuses a withdrawal the same way', async () => {
    const id = await addRule({ entitlementDays: 22, effectiveFrom: BEHIND });

    const refused = await send('DELETE', `/api/entitlement-rules/${id}`, people.headOfHr);

    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe(
      'EntitlementRuleAlreadyApplies',
    );
  });

  /* What the screen greys the buttons on, and the sentence it shows instead of them. */
  it('says on the list that it may not be changed, and why', async () => {
    const id = await addRule({ entitlementDays: 22, effectiveFrom: BEHIND });
    const rule = await ruleById(id);

    expect(rule.mayBeChanged).toBe(false);
    expect(rule.inForce).toBe(true);
    expect(rule.fixedBecause).toContain('already passed');
  });
});

/* --------------------------------------------------------- and a closed year even less */

describe('a leave year somebody has closed', () => {
  /** A year that has ended, so that closing it is a legal thing to do. */
  async function closeTheYearBefore(): Promise<void> {
    await admin.query('INSERT INTO leave_year (label, start_date, end_date) VALUES ($1, $2, $3)', [
      YEAR_BEFORE_IT,
      `${YEAR_BEFORE_IT}-01-01`,
      `${YEAR_BEFORE_IT}-12-31`,
    ]);
    await admin.query('UPDATE leave_year SET is_closed = TRUE WHERE label = $1', [YEAR_BEFORE_IT]);
  }

  /* Closing is irreversible by design, so the years are put back rather than reopened. */
  afterEach(async () => {
    await admin.query('TRUNCATE leave_year CASCADE');
    await admin.query('SELECT ensure_the_first_leave_years()');
  });

  it('refuses a rule dated into it, with the earliest day it could start named', async () => {
    await closeTheYearBefore();

    const refused = await send('POST', '/api/entitlement-rules', people.headOfHr, {
      leaveTypeId: await annual(),
      entitlementDays: 25,
      effectiveFrom: `${YEAR_BEFORE_IT}-06-01`,
    });

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('ReachesIntoAClosedYear');
    expect(problem.message).toContain(`${FIRST_YEAR}-01-01`);
  });

  /** The boundary on the list, so a date picker refuses it before anybody types it. */
  it('is carried on the list as the earliest day a rule may start', async () => {
    expect((await settingsFor(people.headOfHr)).earliestOpenDay).toBeNull();

    await closeTheYearBefore();

    const settings = await settingsFor(people.headOfHr);

    expect(settings.earliestOpenDay).toBe(`${FIRST_YEAR}-01-01`);
    expect(settings.closedYearsInWords).toContain('closed up to');
  });
});

/* ------------------------------------------------------------- refusals name the field */

describe('a rule that does not hang together', () => {
  it('refuses a negative figure with a 400 naming the box', async () => {
    const refused = await send('POST', '/api/entitlement-rules', people.headOfHr, {
      leaveTypeId: await annual(),
      entitlementDays: -1,
      effectiveFrom: AHEAD,
    });

    expect(refused.status).toBe(400);

    const problem = (await refused.json()) as { error: string; field?: string };

    expect(problem.error).toBe('InvalidEntitlementRule');
    expect(problem.field).toBe('entitlementDays');
  });

  /** Somebody is already in exactly one department, so a rule naming both says nothing. */
  it('refuses a rule aimed at a person and a department at once', async () => {
    const settings = await settingsFor(people.headOfHr);

    const refused = await send('POST', '/api/entitlement-rules', people.headOfHr, {
      leaveTypeId: await annual(),
      employeeId: people.officer,
      departmentId: settings.departments[0].id,
      entitlementDays: 25,
      effectiveFrom: AHEAD,
    });

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { field?: string }).field).toBe('departmentId');
  });

  /** Two figures for one day have no order between them, so the second is refused. */
  it('refuses a second rule for the same scope on the same day', async () => {
    const leaveTypeId = await annual();

    await addRule({ leaveTypeId, entitlementDays: 25, effectiveFrom: AHEAD });

    const refused = await send('POST', '/api/entitlement-rules', people.headOfHr, {
      leaveTypeId,
      entitlementDays: 26,
      effectiveFrom: AHEAD,
    });

    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('DuplicateEntitlementRule');
  });

  /** A rule may still be moved to another day while it is a draft. */
  it('lets a draft move to a day nothing else occupies', async () => {
    const id = await addRule({ entitlementDays: 25, effectiveFrom: AHEAD });

    const moved = await send('PATCH', `/api/entitlement-rules/${id}`, people.headOfHr, {
      effectiveFrom: FURTHER_AHEAD,
    });

    expect(moved.status).toBe(200);
    expect(((await moved.json()) as JsonRule).effectiveFrom).toBe(FURTHER_AHEAD);
  });
});

/* ------------------------------------------------------------------------- fixtures */

interface JsonRule {
  id: string;
  leaveTypeId: string;
  leaveTypeName: string;
  scope: string;
  scopeLabel: string;
  employeeId: string | null;
  departmentId: string | null;
  who: string;
  entitlementDays: number;
  prorateOnJoin: boolean;
  carriesOver: boolean;
  carryoverMaxDays: number | null;
  carryoverExpiryMonth: number | null;
  carryoverInWords: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  periodInWords: string;
  note: string | null;
  mayBeChanged: boolean;
  fixedBecause: string | null;
  inForce: boolean;
  inWords: string;
}

interface JsonSettings {
  rules: JsonRule[];
  leaveTypes: { id: string; code: string; name: string; isActive: boolean }[];
  departments: { id: string; name: string }[];
  employees: { id: string; name: string; departmentId: string }[];
  scopes: { value: string; label: string }[];
  today: string;
  earliestOpenDay: string | null;
  closedYearsInWords: string;
}

async function settingsFor(employeeId: string): Promise<JsonSettings> {
  const response = await get('/api/entitlement-rules', employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonSettings;
}

/** The id of annual leave, which is the type every figure in this file is about. */
async function annual(): Promise<string> {
  const settings = await settingsFor(people.headOfHr);
  const type = settings.leaveTypes.find((one) => one.code === 'ANNUAL');

  expect(type, 'no leave type with the code ANNUAL').toBeDefined();

  return type!.id;
}

/** A rule by the one door that writes one, with its id. */
async function addRule(fields: Record<string, unknown>): Promise<string> {
  const response = await send('POST', '/api/entitlement-rules', people.headOfHr, {
    leaveTypeId: await annual(),
    ...fields,
  });

  expect(response.status).toBe(201);

  return ((await response.json()) as JsonRule).id;
}

async function ruleById(id: string): Promise<JsonRule> {
  const found = (await settingsFor(people.headOfHr)).rules.find((one) => one.id === id);

  expect(found, `no rule with the id ${id}`).toBeDefined();

  return found!;
}

/** The one company-wide rule the migration wrote for a type. */
async function ruleFor(employeeId: string, leaveTypeId: string): Promise<JsonRule> {
  const found = (await settingsFor(employeeId)).rules.find(
    (one) => one.leaveTypeId === leaveTypeId && one.scope === 'EVERYBODY',
  );

  expect(found, 'no company wide rule for that leave type').toBeDefined();

  return found!;
}

async function daysInTheTable(effectiveFrom: string): Promise<number[]> {
  const { rows } = await admin.query<{ days: number }>(
    'SELECT entitlement_days AS days FROM leave_entitlement_rule WHERE effective_from = $1',
    [effectiveFrom],
  );

  return rows.map((row) => row.days);
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
