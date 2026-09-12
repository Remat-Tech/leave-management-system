import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { calendarDateIn, dayBefore } from '../../src/shared/time.js';
import {
  AttachmentFileDeleted,
  fileDeletedOn,
} from '../../src/features/leave-request/attachment.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { AttachmentPurge } from '../../src/features/leave-request/attachment-purge.job.js';
import { AttachmentService } from '../../src/features/leave-request/attachment.service.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/** Stored certificates deleted after retention, rows kept. NFR SEC 06, LMS 514. */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('attachment purge fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let attachments: AttachmentService;
let attachmentRows: AttachmentRepository;
let purge: AttachmentPurge;
let storage: InMemoryStorage;
let requests: LeaveRequestService;
let balances: BalanceService;
let years: LeaveYearService;
let people: Record<string, string>;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const organisation = new OrganisationRepository(db);

  attachmentRows = new AttachmentRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    requestRepository,
    new LeaveDecisionRepository(db),
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    attachmentRows,
    new RoleRepository(db),
    delegationService(db, guard),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  storage = new InMemoryStorage();

  attachments = new AttachmentService(
    guard,
    attachmentRows,
    new AttachmentLinkRepository(db),
    requestRepository,
    employees,
    types,
    organisation,
    delegationService(db, guard),
    storage,
    new SignatureScanner(),
  );

  purge = new AttachmentPurge(attachmentRows, organisation, storage);
});

beforeEach(async () => {
  await clear();
  storage.reset();

  people = (await seed(admin)) as Record<string, string>;

  const y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await admin.query('UPDATE organisation_setting SET attachment_retention_months = 24');

  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
});

afterAll(async () => {
  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request_draft, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

const LEAVE_ENDS_ON = daysFromToday(25);

function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return calendarDateIn(day, 'UTC');
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** A request with a certificate on it, still waiting for a decision. */
async function aRequestWithAFile() {
  const { request } = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: daysFromToday(21),
    to: LEAVE_ENDS_ON,
    reason: 'My sister is getting married',
    acknowledgesShortNotice: true,
    evidence: [],
  });

  const file = await attachments.attach(asTheEmployee(), request.id, {
    filename: 'certificate.pdf',
    content: Buffer.from('%PDF-1.7\na certificate'),
    claimedContentType: 'application/pdf',
  });

  return { request, file };
}

/** The same, with the leave ended by withdrawing it. */
async function endedLeaveWithAFile() {
  const made = await aRequestWithAFile();

  await requests.withdraw(asTheEmployee(), made.request.id);

  return made;
}

/* ------------------------------------------------------------------------ the story */

describe('deleting a certificate after retention', () => {
  it('deletes the stored file 24 months after the leave ends', async () => {
    const { file } = await endedLeaveWithAFile();
    const dueOn = fileDeletedOn(LEAVE_ENDS_ON, 24);

    const run = await purge.run(dueOn);

    expect(run.deleted.map((one) => one.attachmentId)).toEqual([file.id]);
    expect(storage.has(file.storageKey)).toBe(false);
  });

  it('and not a day before', async () => {
    const { file } = await endedLeaveWithAFile();

    const run = await purge.run(dayBefore(fileDeletedOn(LEAVE_ENDS_ON, 24)));

    expect(run.deleted).toEqual([]);
    expect(storage.has(file.storageKey)).toBe(true);
  });

  it('keeps the row, so history still says what was attached', async () => {
    const { request, file } = await endedLeaveWithAFile();

    await purge.run(fileDeletedOn(LEAVE_ENDS_ON, 24));

    const [kept] = await attachmentRows.forRequest(request.id);

    expect(kept.filename).toBe('certificate.pdf');
    expect(kept.sizeBytes).toBe(file.sizeBytes);
    expect(kept.uploadedByEmployeeId).toBe(people.officer);
    expect(kept.fileDeletedAt).not.toBeNull();
  });

  it('refuses a download of a deleted file', async () => {
    const { request, file } = await endedLeaveWithAFile();

    await purge.run(fileDeletedOn(LEAVE_ENDS_ON, 24));

    await expect(attachments.linkTo(asTheEmployee(), request.id, file.id)).rejects.toThrow(
      AttachmentFileDeleted,
    );
  });

  it('leaves a request still being decided alone', async () => {
    const { file } = await aRequestWithAFile();

    const run = await purge.run(fileDeletedOn(LEAVE_ENDS_ON, 24));

    expect(run.deleted).toEqual([]);
    expect(storage.has(file.storageKey)).toBe(true);
  });

  it('deletes nothing more when run again', async () => {
    await endedLeaveWithAFile();
    const dueOn = fileDeletedOn(LEAVE_ENDS_ON, 24);

    await purge.run(dueOn);

    expect((await purge.run(dueOn)).deleted).toEqual([]);
  });

  it('never brings a deleted file back', async () => {
    const { file } = await endedLeaveWithAFile();

    await purge.run(fileDeletedOn(LEAVE_ENDS_ON, 24));

    await expect(
      admin.query('UPDATE leave_request_attachment SET file_deleted_at = NULL WHERE id = $1', [
        file.id,
      ]),
    ).rejects.toThrow(/already deleted/);
  });
});

describe('the retention period', () => {
  it('is the one HR set', async () => {
    await admin.query('UPDATE organisation_setting SET attachment_retention_months = 6');
    const { file } = await endedLeaveWithAFile();

    const run = await purge.run(fileDeletedOn(LEAVE_ENDS_ON, 6));

    expect(run.retentionMonths).toBe(6);
    expect(run.deleted.map((one) => one.attachmentId)).toEqual([file.id]);
  });

  it('deletes nothing where HR keeps files indefinitely', async () => {
    await admin.query('UPDATE organisation_setting SET attachment_retention_months = NULL');
    const { file } = await endedLeaveWithAFile();

    const run = await purge.run(fileDeletedOn(LEAVE_ENDS_ON, 120));

    expect(run.deleted).toEqual([]);
    expect(storage.has(file.storageKey)).toBe(true);
  });
});
