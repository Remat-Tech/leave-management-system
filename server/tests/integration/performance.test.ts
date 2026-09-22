import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
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
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { delegationService } from '../support/delegations.js';

/** Performance check. NFR PRF 01. */

const testDatabaseUrl = await databaseForThisFile();

/** Assumed expected concurrency. */
const CONCURRENCY = 25;
const ROUNDS = 8;
const API_P95_MS = 500;
const PAGE_P95_MS = 2000;

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';
const DIST = fileURLToPath(new URL('../../../client/dist', import.meta.url));

const system = theSystem('performance integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let people: Record<string, string>;
let cookies: string[];
let annualId: string;

beforeAll(async () => {
  if (!existsSync(`${DIST}/index.html`)) {
    throw new Error('client/dist is missing. Run `npm run web:build` first.');
  }

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

  const balances = new BalanceService(
    new BalanceRepository(db),
    guard,
    employees,
    new Transactions(db),
  );

  const requests = new LeaveRequestService(
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

  const api = buildApp({
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
    storage: new InMemoryStorage(),
    scanner: new SignatureScanner(),
    accounts,
    roles: roleRepository,
    delegations: delegationService(db, guard),
    organisation,
    emailWording: new EmailWordingRepository(db),
    audit: new AuditRepository(db),
    secret: SECRET,
  });

  /** Built client in front of the API, one origin, as deployed. */
  const app = express();
  app.use(express.static(DIST));
  app.use(api);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  /* ------------------------------------------------------------------ fixtures */

  /** FR 18. Fixture days are behind today. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  people = (await seed(admin)) as Record<string, string>;

  const y2026 = (await new LeaveYearService(yearRepository, guard).byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  const signedIn = Object.entries(people).filter(([key]) => key !== 'leaver');

  for (const [, employeeId] of signedIn) {
    await balances.grantTheYear(system, {
      employeeId,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'Annual entitlement for 2026',
    });
  }

  /** Something in every history, queue and calendar. */
  for (const [, employeeId] of signedIn) {
    for (const day of ['2026-06-02', '2026-06-09', '2026-06-16']) {
      await requests
        .submit(signedInAs(employeeId, { roles: ['EMPLOYEE'], isManager: false }), {
          employeeId,
          leaveTypeId: annualId,
          from: day,
          to: day,
          reason: 'Family matters',
          acknowledgesShortNotice: true,
        })
        .catch(() => undefined);
    }
  }

  cookies = signedIn.map(([, id]) => `${SESSION_COOKIE}=${mintSession(id, SECRET)}`);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server?.close(() => {
      resolve();
    });
  });

  await db?.destroy();
  await admin?.end();
});

/* ---------------------------------------------------------------------- helpers */

/** Nearest rank. */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Fetched in full, refused on anything but 2xx. */
async function get(path: string, cookie?: string): Promise<string> {
  const response = await fetch(`${origin}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${path} answered ${String(response.status)}: ${body.slice(0, 200)}`);
  }

  return body;
}

async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();

  return performance.now() - started;
}

/** One warm-up round, then ROUNDS of CONCURRENCY at once. */
async function underLoad(
  one: (cookie: string) => Promise<unknown>,
  pool = cookies,
): Promise<number[]> {
  const round = () =>
    Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => timed(() => one(pool[i % pool.length]))),
    );

  await round();

  const samples: number[] = [];

  for (let r = 0; r < ROUNDS; r++) {
    samples.push(...(await round()));
  }

  return samples;
}

/** Logged in the test, not afterAll: vitest drops that output when all pass. */
function record(what: string, samples: number[], target: number): number {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);

  console.info(
    `NFR PRF 01 ${what}: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, target ${String(target)} ms`,
  );

  return p95;
}

/* ------------------------------------------------------ API responses. NFR PRF 01 */

describe(`API responses at ${String(CONCURRENCY)} users at once`, () => {
  const ENDPOINTS = [
    '/api/me',
    '/api/me/balances',
    '/api/me/requests',
    '/api/me/request-form',
    '/api/me/calendar',
    '/api/leave-types',
    '/api/holidays',
  ];

  it.each(ENDPOINTS)(`answers %s under ${String(API_P95_MS)} ms at p95`, async (path) => {
    const samples = await underLoad((cookie) => get(path, cookie));

    expect(record(path, samples, API_P95_MS)).toBeLessThan(API_P95_MS);
  });

  /** Approvers only; everybody else is refused. */
  it(`answers the approver queue under ${String(API_P95_MS)} ms at p95`, async () => {
    const approvers = ['ceo', 'headOfHr', 'hrOfficer', 'teamLead', 'opsManager'].map(
      (key) => `${SESSION_COOKIE}=${mintSession(people[key], SECRET)}`,
    );

    const samples = await underLoad((cookie) => get('/api/me/approvals', cookie), approvers);

    expect(record('/api/me/approvals', samples, API_P95_MS)).toBeLessThan(API_P95_MS);
  });

  it(`answers a quote under ${String(API_P95_MS)} ms at p95`, async () => {
    const path = `/api/me/requests/quote?leaveTypeId=${annualId}&from=2026-07-06&to=2026-07-10`;

    const samples = await underLoad((cookie) => get(path, cookie));

    expect(record('/api/me/requests/quote', samples, API_P95_MS)).toBeLessThan(API_P95_MS);
  });
});

/* --------------------------------------------------------- page load. NFR PRF 01 */

describe(`page load at ${String(CONCURRENCY)} users at once`, () => {
  /** Browser waterfall: document, then assets, then fonts and the landing screen's calls. */
  async function loadThePage(cookie: string): Promise<void> {
    const html = await get('/');

    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const bodies = await Promise.all(assets.map((asset) => get(asset)));

    const fonts = bodies.flatMap((body) =>
      [...body.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]),
    );

    await Promise.all([
      ...[...new Set(fonts)].map((font) => get(font)),
      get('/api/me', cookie),
      get('/api/me/balances', cookie),
    ]);
  }

  it(`loads the landing page under ${String(PAGE_P95_MS)} ms at p95`, async () => {
    const samples = await underLoad(loadThePage);

    expect(record('page load', samples, PAGE_P95_MS)).toBeLessThan(PAGE_P95_MS);
  });
});
