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
 * The policy settings screen, over HTTP. FR 44, FR 48c, NFR SEC 06. LMS 505.
 *
 * ./organisation.test.ts proves the one-row table and its two triggers, and
 * ../unit/organisation.test.ts proves what a setting is. What is only checkable here is the
 * claim the *screen* makes:
 *
 *   **All of it on one answer.** The override rule, the Chief Executive, the notice and
 *   back-dating windows and the retention window, without opening four screens to see them.
 *
 *   **Reading is everybody's and writing is an HR Administrator's**, decided by
 *   `organisationPolicy` rather than by where the router is mounted — and an HR Officer,
 *   who may keep the holiday calendar, may not touch these.
 *
 *   **Every refusal arrives as a sentence.** Naming a leaver, emptying the seat and a
 *   retention window that is not a whole number of months were all reaching a browser as
 *   "something went wrong at our end" before this story.
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

interface JsonSettings {
  chiefExecutiveId: string | null;
  chiefExecutiveName: string | null;
  chiefExecutiveJobTitle: string | null;
  isReadyForGoLive: boolean;
  overridesAreAllowed: boolean;
  overrideRuleInWords: string;
  attachmentRetentionMonths: number | null;
  retentionInWords: string;
  updatedAt: string;
}

interface JsonWindow {
  id: string;
  code: string;
  name: string;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
}

interface JsonPage {
  settings: JsonSettings;
  windows: JsonWindow[];
  employees: { id: string; name: string; jobTitle: string | null; hasLeft: boolean }[];
  longestRetentionMonths: number;
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
  const yearRepository = new LeaveYearRepository(db);

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
  people = (await seed(admin)) as Record<string, string>;

  /* The seed leaves the settings row as the migration wrote it, and the two columns this
     story added default. Reset anyway: a test that switched overrides off must not decide
     the next one's requests. */
  await admin.query(
    'UPDATE organisation_setting SET overrides_are_allowed = true, ' +
      'attachment_retention_months = NULL',
  );
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
  it('answers 401 for reading the settings and for changing them', async () => {
    expect((await fetch(`${origin}/api/policy-settings`)).status).toBe(401);

    const changed = await fetch(`${origin}/api/policy-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overridesAreAllowed: false }),
    });

    expect(changed.status).toBe(401);
  });
});

/* ------------------------------------------------------------- what is on the screen */

describe('the screen', () => {
  it('puts every policy setting on one answer', async () => {
    const page = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;

    expect(page.settings.chiefExecutiveId).toBe(people.ceo);
    expect(page.settings.chiefExecutiveName).toBe('Kwame Asante');
    expect(page.settings.isReadyForGoLive).toBe(true);
    expect(page.settings.overridesAreAllowed).toBe(true);
    expect(page.settings.attachmentRetentionMonths).toBeNull();
    expect(page.longestRetentionMonths).toBeGreaterThan(0);
  });

  /* FR 17, FR 18. Read across the types rather than one form at a time, which is the whole
     "without guesswork": annual is the only type that asks for notice. */
  it('and the notice and back-dating windows of every type in use', async () => {
    const page = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;

    const annual = page.windows.find((one) => one.code === 'ANNUAL');
    const sick = page.windows.find((one) => one.code === 'SICK');

    expect(annual?.minNoticeCalendarDays).toBe(14);
    expect(sick?.minNoticeCalendarDays).toBe(0);
    expect(annual?.maxBackdateCalendarDays).toBe(7);
    expect(page.windows.length).toBeGreaterThanOrEqual(7);
  });

  /* FR 06. A leaver is in the list and marked, so the picker can say why it refuses them
     rather than leaving somebody looking for a name that is not there. */
  it('and everybody who could be named, with the leavers marked', async () => {
    await admin.query(
      "UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-08-31' WHERE id = $1",
      [people.opsDirector],
    );

    const page = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;
    const gone = page.employees.find((one) => one.id === people.opsDirector);

    expect(gone?.hasLeft).toBe(true);
    expect(page.employees.find((one) => one.id === people.ceo)?.hasLeft).toBe(false);
  });

  /* The sentences are the server's, so the screen never writes a second version of them. */
  it('and says what each setting means, in the server’s words', async () => {
    const page = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;

    expect(page.settings.overrideRuleInWords).toContain('overturn');
    expect(page.settings.retentionInWords).toContain('for ever');
  });

  it('is readable by anybody signed in', async () => {
    expect((await get('/api/policy-settings', people.engineer)).status).toBe(200);
  });

  /**
   * And the staff directory behind the picker is not readable by anybody signed in.
   *
   * Reading the settings is everybody's — the request form already says where unpaid leave
   * goes — and a route that fetched every employee for everybody would be a way round
   * `employeePolicy.list`. The Chief Executive's own name stays: that is the setting.
   */
  it('but the picker behind it is empty for somebody who cannot use it', async () => {
    const theirs = (await (await get('/api/policy-settings', people.engineer)).json()) as JsonPage;

    expect(theirs.employees).toEqual([]);
    expect(theirs.settings.chiefExecutiveName).toBe('Kwame Asante');

    const officers = (await (
      await get('/api/policy-settings', people.hrOfficer)
    ).json()) as JsonPage;

    expect(officers.employees).toEqual([]);

    const admins = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;

    expect(admins.employees.length).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------- who may change it */

describe('changing the settings', () => {
  it('is an HR Administrator’s', async () => {
    const changed = await send('PATCH', '/api/policy-settings', people.headOfHr, {
      overridesAreAllowed: false,
      attachmentRetentionMonths: 24,
    });

    expect(changed.status).toBe(200);

    const settings = (await changed.json()) as JsonSettings;

    expect(settings.overridesAreAllowed).toBe(false);
    expect(settings.attachmentRetentionMonths).toBe(24);
    expect(settings.retentionInWords).toContain('2 years');
  });

  /* Narrower than the holiday calendar deliberately: an HR Officer keeps the gazette, and
     this decides how every request in the company is decided. */
  it('and never an HR Officer’s, who is told who to ask', async () => {
    const refused = await send('PATCH', '/api/policy-settings', people.hrOfficer, {
      overridesAreAllowed: false,
    });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toContain('HR Administrator');
  });

  it('and a PATCH changes only what it names', async () => {
    await send('PATCH', '/api/policy-settings', people.headOfHr, {
      attachmentRetentionMonths: 36,
    });

    const settings = (await (
      await send('PATCH', '/api/policy-settings', people.headOfHr, { overridesAreAllowed: false })
    ).json()) as JsonSettings;

    expect(settings.attachmentRetentionMonths).toBe(36);
    expect(settings.overridesAreAllowed).toBe(false);
  });

  /* Null is a setting rather than an unanswered question, so it has to survive a round trip
     as one — clearing the box is "keep them indefinitely". */
  it('and a retention window can be cleared back to indefinite', async () => {
    await send('PATCH', '/api/policy-settings', people.headOfHr, {
      attachmentRetentionMonths: 24,
    });

    const settings = (await (
      await send('PATCH', '/api/policy-settings', people.headOfHr, {
        attachmentRetentionMonths: null,
      })
    ).json()) as JsonSettings;

    expect(settings.attachmentRetentionMonths).toBeNull();
  });

  it('and a window that is not a whole number of months is refused with a sentence', async () => {
    const refused = await send('PATCH', '/api/policy-settings', people.headOfHr, {
      attachmentRetentionMonths: 1.5,
    });

    expect(refused.status).toBe(400);

    const problem = (await refused.json()) as { message: string; field?: string };

    expect(problem.field).toBe('attachmentRetentionMonths');
    expect(problem.message).toContain('months');
  });

  /* NFR AUD 01. Who moved the override rule, and when. */
  it('and the change is one audit entry naming the administrator', async () => {
    await send('PATCH', '/api/policy-settings', people.headOfHr, { overridesAreAllowed: false });

    const { rows } = await admin.query(
      `SELECT actor_employee_id FROM audit_log
        WHERE entity = 'organisation_setting' ORDER BY id DESC LIMIT 1`,
    );

    expect(String(rows[0].actor_employee_id)).toBe(String(people.headOfHr));
  });
});

/* ------------------------------------------------------------- naming the Chief Executive */

describe('the Chief Executive', () => {
  it('is named by their record, and the name comes back', async () => {
    const named = await send('PUT', '/api/policy-settings/chief-executive', people.headOfHr, {
      employeeId: people.opsDirector,
    });

    expect(named.status).toBe(200);
    expect(((await named.json()) as JsonSettings).chiefExecutiveName).toBe('Yaw Boateng');
  });

  /* FR 48c, FR 06. Both were a five hundred until this route existed. */
  it('and naming somebody who has left is refused with a sentence', async () => {
    await admin.query(
      "UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-08-31' WHERE id = $1",
      [people.opsDirector],
    );

    const refused = await send('PUT', '/api/policy-settings/chief-executive', people.headOfHr, {
      employeeId: people.opsDirector,
    });

    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toContain('left the company');
  });

  it('and the seat cannot be emptied', async () => {
    const refused = await send('PUT', '/api/policy-settings/chief-executive', people.headOfHr, {
      employeeId: '',
    });

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toContain('successor');
  });

  it('and it is an HR Administrator’s too', async () => {
    const refused = await send('PUT', '/api/policy-settings/chief-executive', people.hrOfficer, {
      employeeId: people.opsDirector,
    });

    expect(refused.status).toBe(403);
  });
});

/* --------------------------------------------------------------- the windows, from here */

describe('the notice and back-dating windows', () => {
  /* The screen writes them through the leave type door rather than a second one, so a
     window changed here is the same write the leave types screen makes. */
  it('are changed through the leave type they belong to', async () => {
    const before = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;
    const annual = before.windows.find((one) => one.code === 'ANNUAL');

    const changed = await send('PATCH', `/api/leave-types/${annual?.id ?? ''}`, people.headOfHr, {
      minNoticeCalendarDays: 21,
    });

    expect(changed.status).toBe(200);

    const after = (await (await get('/api/policy-settings', people.headOfHr)).json()) as JsonPage;

    expect(after.windows.find((one) => one.code === 'ANNUAL')?.minNoticeCalendarDays).toBe(21);
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
