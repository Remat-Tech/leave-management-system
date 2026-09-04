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
import { calendarDateIn } from '../../src/shared/time.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
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
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Attachments over HTTP. FR 12, NFR SEC 04, NFR SEC 07. LMS 310.
 *
 * ./attachment.test.ts proves the rules against a real database and store. This is for the
 * four things only a socket can show: that the body of an upload is the bytes, that the
 * name travels in a header rather than a query string, that a refusal arrives as the
 * sentence rather than a five hundred, and that none of it is reachable without a session.
 */

const testDatabaseUrl = await databaseForThisFile();

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('attachments api integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let balances: BalanceService;
let requests: LeaveRequestService;
let years: LeaveYearService;
let people: Record<string, string>;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const organisation = new OrganisationRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

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
    /** FR 13, LMS 311. */
    new AttachmentRepository(db),
    roles,
    organisation,
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
    years: yearRepository,
    requests: requestRepository,
    leaveRequests: requests,
    decisions,
    routing: new LeaveRoutingRepository(db),
    withdrawals: new WithdrawalRepository(db),
    drafts: new LeaveRequestDraftRepository(db),
    /** FR 12, LMS 310. */
    attachments: new AttachmentRepository(db),
    storage: new InMemoryStorage(),
    scanner: new SignatureScanner(),
    accounts,
    roles,
    organisation,
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
  await clear();

  people = (await seed(admin)) as Record<string, string>;

  const y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
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

  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'leave_request_attachment, leave_request_decision, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request_draft, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return calendarDateIn(day, 'UTC');
}

async function aRequest(): Promise<string> {
  const submitted = await requests.submit(
    { employeeId: people.officer, roles: ['EMPLOYEE'], isManager: false, description: 'fixture' },
    {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: daysFromToday(21),
      to: daysFromToday(25),
      reason: 'My sister is getting married',
      acknowledgesShortNotice: true,
    },
  );

  return submitted.request.id;
}

const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('a certificate')]);

function cookieFor(employeeId: string): string {
  return `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}`;
}

/** One file, as a form actually sends it: bytes in the body, name in a header. */
function upload(
  requestId: string,
  employeeId: string,
  content: Buffer,
  filename: string,
): Promise<Response> {
  return fetch(`${origin}/api/requests/${requestId}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(filename),
      cookie: cookieFor(employeeId),
    },
    body: new Uint8Array(content),
  });
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: { cookie: cookieFor(employeeId) } });
}

/* ------------------------------------------------------------------------ the routes */

describe('the line everything is mounted behind', () => {
  it('answers 401 with no cookie at all', async () => {
    const requestId = await aRequest();

    const response = await fetch(`${origin}/api/requests/${requestId}/attachments`);

    expect(response.status).toBe(401);
  });
});

describe('attaching a file over HTTP', () => {
  it('takes the bytes as the body and the name from the header', async () => {
    const requestId = await aRequest();

    const response = await upload(requestId, people.officer, A_PDF, 'sick note.pdf');

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      filename: 'sick note.pdf',
      contentType: 'application/pdf',
      sizeBytes: A_PDF.byteLength,
      scanStatus: 'CLEAN',
      downloadable: true,
      slot: 1,
    });
  });

  /* NFR SEC 04. The handle is storage's, and a client that never sees one cannot ask for
     a file by guessing at where it lives. */
  it('and never tells the client where the bytes are', async () => {
    const requestId = await aRequest();

    const response = await upload(requestId, people.officer, A_PDF, 'certificate.pdf');

    expect(await response.json()).not.toHaveProperty('storageKey');
  });

  /* NFR SEC 07. The header says PDF; the bytes are a shell script. */
  it('refuses a file for what it is, with the sentence rather than a five hundred', async () => {
    const requestId = await aRequest();

    const response = await upload(
      requestId,
      people.officer,
      Buffer.from('#!/bin/sh\necho hello\n'),
      'certificate.pdf',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'AttachmentTypeNotAccepted',
      message: expect.stringContaining('PDF, JPG, PNG and DOCX') as unknown as string,
    });
  });

  it('refuses an upload with no name on it, and says which header carries one', async () => {
    const requestId = await aRequest();

    const response = await fetch(`${origin}/api/requests/${requestId}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: cookieFor(people.officer) },
      body: new Uint8Array(A_PDF),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'InvalidAttachment',
      field: 'filename',
      message: expect.stringContaining('X-Filename') as unknown as string,
    });
  });

  /* A name with an apostrophe and an accent in it, through a Latin-1 header. */
  it('carries a name that is not ASCII through the header unchanged', async () => {
    const requestId = await aRequest();

    const response = await upload(requestId, people.officer, A_PDF, 'Kofi’s résumé.pdf');

    expect(await response.json()).toMatchObject({ filename: 'Kofi’s résumé.pdf' });
  });
});

describe('reading it back over HTTP', () => {
  it('lists what is attached and whether it evidences anything', async () => {
    const requestId = await aRequest();

    await upload(requestId, people.officer, A_PDF, 'certificate.pdf');

    const response = await get(`/api/requests/${requestId}/attachments`, people.officer);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      leaveRequestId: requestId,
      evidence: { required: false, satisfied: true, attached: 1, usable: 1 },
    });
  });

  it('sends the bytes back as an attachment nothing renders inline', async () => {
    const requestId = await aRequest();

    const attached = (await (
      await upload(requestId, people.officer, A_PDF, 'sick note.pdf')
    ).json()) as { attachmentId: string };

    const response = await get(
      `/api/requests/${requestId}/attachments/${attached.attachmentId}`,
      people.officer,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(A_PDF);
  });

  it('and refuses somebody with no standing over the request', async () => {
    const requestId = await aRequest();

    await upload(requestId, people.officer, A_PDF, 'certificate.pdf');

    const response = await get(`/api/requests/${requestId}/attachments`, people.engineer);

    expect(response.status).toBe(404);
  });

  it('removes one and answers 204', async () => {
    const requestId = await aRequest();

    const attached = (await (
      await upload(requestId, people.officer, A_PDF, 'certificate.pdf')
    ).json()) as { attachmentId: string };

    const response = await fetch(
      `${origin}/api/requests/${requestId}/attachments/${attached.attachmentId}`,
      { method: 'DELETE', headers: { cookie: cookieFor(people.officer) } },
    );

    expect(response.status).toBe(204);

    const left = (await (
      await get(`/api/requests/${requestId}/attachments`, people.officer)
    ).json()) as { attachments: unknown[] };

    expect(left.attachments).toHaveLength(0);
  });
});
