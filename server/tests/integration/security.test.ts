import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
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
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { buildApp } from '../../src/http/app.js';
import { mintSession, SESSION_COOKIE } from '../../src/features/sign-in/session-cookie.routes.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { RoleService } from '../../src/features/role/role.service.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingDenials } from '../support/recording-denials.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { delegationService } from '../support/delegations.js';

/** Security suite. §12. LMS 602. */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('security integration fixtures');
const denials = recordingDenials();
const guard = new Guard(denials);
const storage = new InMemoryStorage();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let balances: BalanceService;
let requests: LeaveRequestService;
let years: LeaveYearService;
let roles: RoleService;
let people: Record<string, string>;
let y2026: LeaveYear;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roleRepository = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const organisation = new OrganisationRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);
  roles = new RoleService(roleRepository, accounts, employees, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    requestRepository,
    decisions,
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    roleRepository,
    delegationService(db, guard),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roleRepository, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    ledger: new LedgerRepository(db),
    adjustments: balances,
    employees,
    departments: new DepartmentRepository(db),
    types,
    years: yearRepository,
    entitlementRules: new EntitlementRuleRepository(db),
    requests: requestRepository,
    leaveRequests: requests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    attachments: new AttachmentRepository(db),
    attachmentLinks: new AttachmentLinkRepository(db),
    holidays: new HolidayRepository(db),
    holidayRecalculations: holidayRecalculationService(db, guard, balances),
    storage,
    scanner: new SignatureScanner(),
    accounts,
    roles: roleRepository,
    delegations: delegationService(db, guard),
    organisation,
    emailWording: new EmailWordingRepository(db),
    audit: new AuditRepository(db),
    secret: SECRET,
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(async () => {
  /** FR 18. Fixture days are behind today. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  for (const who of [people.officer, people.hrOfficer, people.headOfHr]) {
    await balances.grantTheYear(system, {
      employeeId: who,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'Annual entitlement for 2026',
    });
  }

  denials.clear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  storage.reset();

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request_draft, leave_request',
  );
}

/* --------------------------------------------------------------------- fixtures */

const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('a certificate')]);

const A_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('an image'),
]);

function asEmployee(employeeId: string, isManager = false) {
  return signedInAs(employeeId, { roles: ['EMPLOYEE'], isManager });
}

function asHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

async function submitFor(employeeId: string, day: string): Promise<string> {
  const { request } = await requests.submit(asEmployee(employeeId), {
    employeeId,
    leaveTypeId: annualId,
    from: day,
    to: day,
    reason: 'Family matters',
    acknowledgesShortNotice: true,
  });

  return request.id;
}

function cookieFor(employeeId: string): string {
  return `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}`;
}

function send(
  method: string,
  path: string,
  employeeId: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};

  if (employeeId !== null) headers.cookie = cookieFor(employeeId);
  if (body !== undefined) headers['content-type'] = 'application/json';

  return fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function upload(
  path: string,
  employeeId: string,
  content: Buffer,
  filename: string,
  claimed = 'application/octet-stream',
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': claimed,
      'x-filename': encodeURIComponent(filename),
      cookie: cookieFor(employeeId),
    },
    body: new Uint8Array(content),
  });
}

async function attach(requestId: string, employeeId: string): Promise<string> {
  const response = await upload(
    `/api/requests/${requestId}/attachments`,
    employeeId,
    A_PDF,
    'sick note.pdf',
  );

  expect(response.status).toBe(201);

  return ((await response.json()) as { attachmentId: string }).attachmentId;
}

async function linkFor(requestId: string, attachmentId: string, employeeId: string) {
  const response = await send(
    'POST',
    `/api/requests/${requestId}/attachments/${attachmentId}/link`,
    employeeId,
  );

  expect(response.status).toBe(201);

  return ((await response.json()) as { url: string }).url;
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(sql, values);

  return Number(rows[0].count);
}

async function statusOf(requestId: string) {
  return requests.byId(system, requestId);
}

/* ------------------------------------------ another employee's request by URL */

describe("another employee's request by direct URL", () => {
  const RANDOM_ID = '987654321';

  /** Adwoa's request, attacked by Abena on the same team. */
  const attacks: [string, string, (id: string, attachmentId: string) => string, unknown?][] = [
    ['reads the attachments', 'GET', (id) => `/api/requests/${id}/attachments`],
    ['mints a download link', 'POST', (id, a) => `/api/requests/${id}/attachments/${a}/link`],
    ['removes an attachment', 'DELETE', (id, a) => `/api/requests/${id}/attachments/${a}`],
    ['rescans an attachment', 'POST', (id, a) => `/api/requests/${id}/attachments/${a}/scan`],
    ['approves it', 'POST', (id) => `/api/requests/${id}/approve`, {}],
    ['refuses it', 'POST', (id) => `/api/requests/${id}/refuse`, { comment: 'No' }],
    ['withdraws it', 'POST', (id) => `/api/requests/${id}/withdrawal`, { reason: 'Mine now' }],
  ];

  it.each(attacks)(
    'refuses a colleague who %s, as if it did not exist',
    async (_, method, path, body) => {
      const requestId = await submitFor(people.officer, '2026-06-02');
      const attachmentId = await attach(requestId, people.officer);

      const refused = await send(method, path(requestId, attachmentId), people.engineer, body);
      const invented = await send(method, path(RANDOM_ID, RANDOM_ID), people.engineer, body);

      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: 'NotFound', message: NOT_AUTHORISED_MESSAGE });
      expect(invented.status).toBe(404);
      expect(await invented.json()).toEqual({ error: 'NotFound', message: NOT_AUTHORISED_MESSAGE });

      expect(denials.entries.some((one) => one.employeeId === people.engineer)).toBe(true);
    },
  );

  it('leaves the request exactly as it was', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');
    const attachmentId = await attach(requestId, people.officer);

    for (const [, method, path, body] of attacks) {
      await send(method, path(requestId, attachmentId), people.engineer, body);
    }

    expect((await statusOf(requestId)).status).toBe('SUBMITTED');
    expect(await count('SELECT count(*) FROM leave_request_decision')).toBe(0);
    expect(await count('SELECT count(*) FROM leave_request_attachment')).toBe(1);
    expect(await count('SELECT count(*) FROM attachment_download_link')).toBe(0);
    expect(storage.size).toBe(1);
  });

  it('refuses a colleague putting evidence on the record for somebody else', async () => {
    const response = await upload(
      `/api/employees/${people.officer}/evidence`,
      people.engineer,
      A_PDF,
      'certificate.pdf',
    );

    expect(response.status).toBe(404);
    expect(storage.size).toBe(0);
  });

  it('refuses a colleague submitting leave in somebody else’s name', async () => {
    const response = await send('POST', '/api/requests', people.engineer, {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: '2026-06-02',
      to: '2026-06-02',
      reason: 'On your behalf',
      acknowledgesShortNotice: true,
    });

    expect(response.status).toBe(404);
    expect(await count('SELECT count(*) FROM leave_request')).toBe(0);
  });
});

/* -------------------------------------------- attachment access without authorisation */

describe('attachment access without authorisation', () => {
  it('answers 401 to every attachment route with no session', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');
    const attachmentId = await attach(requestId, people.officer);
    const url = await linkFor(requestId, attachmentId, people.officer);

    const answers = await Promise.all([
      send('GET', `/api/requests/${requestId}/attachments`, null),
      send('POST', `/api/requests/${requestId}/attachments/${attachmentId}/link`, null),
      send('GET', url, null),
    ]);

    expect(answers.map((one) => one.status)).toEqual([401, 401, 401]);
  });

  it('never hands a link to the bytes to somebody else', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');
    const attachmentId = await attach(requestId, people.officer);
    const url = await linkFor(requestId, attachmentId, people.officer);

    const response = await send('GET', url, people.engineer);

    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).not.toBe('application/octet-stream');
  });

  it('spends a link on its first fetch', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');
    const attachmentId = await attach(requestId, people.officer);
    const url = await linkFor(requestId, attachmentId, people.officer);

    expect((await send('GET', url, people.officer)).status).toBe(200);
    expect((await send('GET', url, people.officer)).status).toBe(410);
  });

  it('refuses a guessed token', async () => {
    const response = await send(
      'GET',
      `/api/attachments/downloads/${'a'.repeat(64)}`,
      people.officer,
    );

    expect(response.status).toBe(410);
  });

  it('never lets the manager attach a file on a report’s behalf', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');

    const response = await upload(
      `/api/requests/${requestId}/attachments`,
      people.teamLead,
      A_PDF,
      'certificate.pdf',
    );

    expect([403, 404]).toContain(response.status);
    expect(storage.size).toBe(0);
  });

  /** NFR SEC 04. Standing is asked again when the link is followed. */
  it('refuses a link whose holder lost standing after it was minted', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');
    const attachmentId = await attach(requestId, people.officer);
    const url = await linkFor(requestId, attachmentId, people.teamLead);

    await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
      people.opsManager,
      people.officer,
    ]);

    const response = await send('GET', url, people.teamLead);

    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------ role escalation */

describe('role escalation', () => {
  function cookieParts(employeeId: string): [string, string, string] {
    return mintSession(employeeId, SECRET).split('.') as [string, string, string];
  }

  it('refuses a cookie whose employee was swapped for an administrator', async () => {
    const [, issuedAt, signature] = cookieParts(people.officer);

    const response = await fetch(`${origin}/api/audit`, {
      headers: { cookie: `${SESSION_COOKIE}=${people.headOfHr}.${issuedAt}.${signature}` },
    });

    expect(response.status).toBe(401);
  });

  it('refuses a cookie minted with another secret', async () => {
    const forged = mintSession(people.headOfHr, 'somebody-elses-secret-of-at-least-32-chars');

    const response = await fetch(`${origin}/api/audit`, {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });

    expect(response.status).toBe(401);
  });

  it('refuses a cookie with roles smuggled into it', async () => {
    const [employeeId, issuedAt, signature] = cookieParts(people.officer);

    const response = await fetch(`${origin}/api/audit`, {
      headers: {
        cookie: `${SESSION_COOKIE}=${employeeId}.${issuedAt}.HR_ADMIN.${signature}`,
      },
    });

    expect(response.status).toBe(401);
  });

  it('ignores roles claimed in a header or query string', async () => {
    const response = await fetch(`${origin}/api/audit?roles=HR_ADMIN&role=SYS_ADMIN`, {
      headers: { cookie: cookieFor(people.officer), 'x-roles': 'HR_ADMIN,SYS_ADMIN' },
    });

    expect([403, 404]).toContain(response.status);
  });

  it('keeps an HR Officer out of an administrator’s screen', async () => {
    const response = await send('GET', '/api/audit', people.hrOfficer);

    expect([403, 404]).toContain(response.status);
  });

  it('drops a revoked role on the very next request, same cookie', async () => {
    expect((await send('GET', '/api/audit', people.headOfHr)).status).toBe(200);

    await roles.revoke(system, people.headOfHr, 'HR_ADMIN');

    expect([403, 404]).toContain((await send('GET', '/api/audit', people.headOfHr)).status);
  });

  const escalations: [string, () => ReturnType<typeof signedInAs>, () => string, string][] = [
    [
      'an employee to HR Administrator, themselves',
      () => asEmployee(people.officer),
      () => people.officer,
      'HR_ADMIN',
    ],
    [
      'an employee to HR Officer, a colleague',
      () => asEmployee(people.officer),
      () => people.engineer,
      'HR_OFFICER',
    ],
    [
      'an HR Officer to HR Administrator, themselves',
      asHrOfficer,
      () => people.hrOfficer,
      'HR_ADMIN',
    ],
    [
      'an HR Officer to HR Administrator, a colleague',
      asHrOfficer,
      () => people.officer,
      'HR_ADMIN',
    ],
    [
      'an HR Administrator to System Administrator, themselves',
      asHeadOfHr,
      () => people.headOfHr,
      'SYS_ADMIN',
    ],
    [
      'an HR Administrator to System Administrator, somebody else',
      asHeadOfHr,
      () => people.hrOfficer,
      'SYS_ADMIN',
    ],
  ];

  it.each(escalations)('refuses %s', async (_, actor, target, code) => {
    const before = await count('SELECT count(*) FROM user_role');

    await expect(roles.grant(actor(), target(), code)).rejects.toBeInstanceOf(NotAuthorised);

    expect(await count('SELECT count(*) FROM user_role')).toBe(before);
    expect(denials.last()).toMatchObject({ resource: 'role', action: 'grant' });
  });
});

/* --------------------------------------------------------- spoofed content type */

describe('spoofed content type upload', () => {
  const spoofs: [string, Buffer, string, string][] = [
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'certificate.pdf', 'application/pdf'],
    [
      'an HTML page',
      Buffer.from('<html><script>alert(1)</script></html>'),
      'scan.png',
      'image/png',
    ],
    ['an SVG with a script', Buffer.from('<svg onload="alert(1)"/>'), 'scan.jpg', 'image/jpeg'],
    [
      'a Windows program',
      Buffer.from('MZ\x90\x00\x03\x00\x00\x00program'),
      'note.jpg',
      'image/jpeg',
    ],
    [
      'a zip that is not a Word document',
      Buffer.from('PK\x03\x04\x14\x00\x00\x00payload'),
      'letter.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  ];

  it.each(spoofs)(
    'refuses %s dressed as an accepted type',
    async (_, content, filename, claimed) => {
      const requestId = await submitFor(people.officer, '2026-06-02');

      const onRequest = await upload(
        `/api/requests/${requestId}/attachments`,
        people.officer,
        content,
        filename,
        claimed,
      );
      const held = await upload('/api/me/evidence', people.officer, content, filename, claimed);

      for (const response of [onRequest, held]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'AttachmentTypeNotAccepted' });
      }

      expect(storage.size).toBe(0);
      expect(await count('SELECT count(*) FROM leave_request_attachment')).toBe(0);
    },
  );

  it('records what the bytes are, not what the header claimed', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');

    const response = await upload(
      `/api/requests/${requestId}/attachments`,
      people.officer,
      A_PNG,
      'certificate.pdf',
      'application/pdf',
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ contentType: 'image/png' });
  });

  /** Accepted as PDF; must never render inline. */
  it('serves a polyglot back as a download, never as a page', async () => {
    const requestId = await submitFor(people.officer, '2026-06-02');
    const polyglot = Buffer.from('%PDF-1.7\n<html><script>alert(1)</script></html>');

    const attached = await upload(
      `/api/requests/${requestId}/attachments`,
      people.officer,
      polyglot,
      'note.html',
      'text/html',
    );
    const { attachmentId } = (await attached.json()) as { attachmentId: string };

    const response = await send(
      'GET',
      await linkFor(requestId, attachmentId, people.officer),
      people.officer,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

/* -------------------------------------------- an HR Officer approving their own request */

describe('an HR Officer approving their own request', () => {
  /** A second officer, so HR stays staffed. FR 48b. */
  beforeEach(async () => {
    await roles.grant(system, people.financeManager, 'HR_OFFICER');
  });

  /** Efua's request, past Ama as her manager, now at HR where Efua sits. */
  async function ownRequestAtHr(): Promise<string> {
    const requestId = await submitFor(people.hrOfficer, '2026-06-02');
    const atHr = await requests.approve(asHeadOfHr(), requestId);

    expect(atHr.request.awaitingApprovalFrom).toBe('HR');
    denials.clear();

    return requestId;
  }

  async function assertUndecided(requestId: string): Promise<void> {
    const request = await statusOf(requestId);

    expect(request.status).toBe('SUBMITTED');
    expect(request.awaitingApprovalFrom).toBe('HR');
    expect(
      await count('SELECT count(*) FROM leave_request_decision WHERE leave_request_id = $1', [
        requestId,
      ]),
    ).toBe(1);
    expect(
      await count("SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'DEDUCTION'"),
    ).toBe(0);
  }

  it('shows it in the queue, but never as actionable', async () => {
    const requestId = await ownRequestAtHr();

    const response = await send('GET', '/api/me/approvals', people.hrOfficer);
    const queue = (await response.json()) as {
      items: { requestId: string; actionable: boolean; notActionableBecause: string | null }[];
    };
    const own = queue.items.find((item) => item.requestId === requestId);

    expect(response.status).toBe(200);
    expect(own).toBeDefined();
    expect(own!.actionable).toBe(false);
    expect(own!.notActionableBecause).toEqual(expect.any(String));
  });

  it('decides nothing when the queue’s bulk action is sent anyway', async () => {
    const requestId = await ownRequestAtHr();
    const { version } = (
      (await (await send('GET', '/api/me/approvals', people.hrOfficer)).json()) as {
        items: { requestId: string; version: unknown }[];
      }
    ).items.find((item) => item.requestId === requestId)!;

    const response = await send('POST', '/api/me/approvals/decisions', people.hrOfficer, {
      action: 'APPROVE',
      comment: null,
      requests: [{ requestId, version }],
    });
    const answered = (await response.json()) as { decided: unknown[]; undecided: unknown[] };

    expect(response.status).toBe(200);
    expect(answered.decided).toEqual([]);
    expect(answered.undecided).toEqual([
      expect.objectContaining({ requestId, error: 'NotAuthorised' }),
    ]);

    await assertUndecided(requestId);
  });

  it.each([
    ['approve', {}],
    ['refuse', { comment: 'Not me' }],
  ])('refuses a direct call to %s it', async (verb, body) => {
    const requestId = await ownRequestAtHr();

    const response = await send(
      'POST',
      `/api/requests/${requestId}/${verb}`,
      people.hrOfficer,
      body,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'NotAuthorised' });
    expect(denials.last()).toMatchObject({ employeeId: people.hrOfficer, action: verb });

    await assertUndecided(requestId);
  });

  it('refuses an HR Administrator the same, holding every HR role', async () => {
    const requestId = await submitFor(people.headOfHr, '2026-06-02');

    await requests.approve(asEmployee(people.ceo, true), requestId);

    const response = await send('POST', `/api/requests/${requestId}/approve`, people.headOfHr, {});

    expect(response.status).toBe(403);
    expect((await statusOf(requestId)).status).toBe('SUBMITTED');
  });

  it('refuses it at the database, whatever the application does', async () => {
    const requestId = await ownRequestAtHr();

    await admin.query('BEGIN');

    try {
      await admin.query("SELECT set_config('lms.audit.actor_employee_id', $1, true)", [
        people.hrOfficer,
      ]);

      await expect(
        admin
          .query(
            "INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of) VALUES ($1, 'APPROVE', 'HR')",
            [requestId],
          )
          .then(() => admin.query('SET CONSTRAINTS ALL IMMEDIATE')),
      ).rejects.toThrow(/cannot approve it/);
    } finally {
      await admin.query('ROLLBACK');
    }

    await assertUndecided(requestId);
  });
});
