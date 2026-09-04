import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { AUDITED_ENTITIES } from '../../src/features/audit/audit.js';
import { calendarDateIn } from '../../src/shared/time.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  ACCEPTED_CONTENT_TYPES,
  AttachmentIsInfected,
  AttachmentNotFound,
  AttachmentNotScanned,
  AttachmentTypeNotAccepted,
  AttachmentsAreClosed,
  TooManyAttachments,
} from '../../src/features/leave-request/attachment.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentService } from '../../src/features/leave-request/attachment.service.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
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
import { UnavailableScanner } from '../../src/scanning/unavailable-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Evidence attached to a request. FR 12, NFR SEC 04, NFR SEC 07. LMS 310.
 *
 * ../unit/attachment.test.ts proves what is pure: what the bytes are, what a name may be,
 * and what satisfies a documentation rule. What needs a database and a store —
 *
 *   **Five is held by the schema.** The seat is unique per request, so the sixth is
 *   refused by an index rather than by a count somebody remembered to take.
 *
 *   **The row and the bytes stay together.** Nothing is stored that no row names, and
 *   removing a file removes both.
 *
 *   **Nothing unscanned is handed over.** An infected upload never lands at all, and a
 *   file the scanner could not answer for cannot be downloaded and counts as no evidence.
 *
 *   **It is the requester's and the approvers', and nobody else's.**
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('attachment integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let attachments: AttachmentService;
/** The same service with a scanner that answers nothing. NFR SEC 07. */
let unscanned: AttachmentService;
let storage: InMemoryStorage;
let requests: LeaveRequestService;
let balances: BalanceService;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;
let sickId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const organisation = new OrganisationRepository(db);
  const attachmentRepository = new AttachmentRepository(db);

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
    /** FR 13, LMS 311. */
    new AttachmentRepository(db),
    new RoleRepository(db),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  storage = new InMemoryStorage();

  attachments = new AttachmentService(
    guard,
    attachmentRepository,
    requestRepository,
    employees,
    types,
    organisation,
    storage,
    new SignatureScanner(),
  );

  unscanned = new AttachmentService(
    guard,
    attachmentRepository,
    requestRepository,
    employees,
    types,
    organisation,
    storage,
    new UnavailableScanner(),
  );
});

beforeEach(async () => {
  await clear();
  storage.reset();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await twentyDaysFor(people.officer);
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

async function twentyDaysFor(employeeId: string): Promise<void> {
  await balances.grantTheYear(system, {
    employeeId,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAStranger() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/** A submitted request of the employee's, sitting with their line manager. */
async function aRequest(leaveTypeId = annualId, evidence: string[] = []) {
  const submitted = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId,
    from: daysFromToday(21),
    to: daysFromToday(25),
    reason: 'My sister is getting married',
    acknowledgesShortNotice: true,
    /** FR 13, FR 32a, LMS 311. Five days of sick leave is past the allowance. */
    evidence,
  });

  return submitted.request;
}

/**
 * A sick request, which since LMS 311 cannot be made without a certificate on it.
 *
 * Five working days against a three day allowance is FR 32a's threshold, so the file is
 * uploaded first and named at submission — which is the whole of the new path.
 */
async function aSickRequest() {
  const certificate = await attachments.hold(asTheEmployee(), people.officer, aFile());

  return aRequest(sickId, [certificate.id]);
}

const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('a certificate')]);
const A_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a photograph of one'),
]);

/** The standard test file every real scanner flags too. */
const EICAR = Buffer.from(
  '%PDF-1.7\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);

function aFile(content = A_PDF, filename = 'certificate.pdf') {
  return { filename, content, claimedContentType: 'application/octet-stream' };
}

async function attachmentCount(): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    'SELECT count(*) FROM leave_request_attachment',
  );

  return Number(rows[0].count);
}

/* ------------------------------------------------------------- attaching, FR 12 */

describe('attaching a file to a request', () => {
  it('stores the bytes and writes the row that names them', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    expect(attached.filename).toBe('certificate.pdf');
    expect(attached.sizeBytes).toBe(A_PDF.byteLength);
    expect(attached.slot).toBe(1);
    expect(storage.has(attached.storageKey)).toBe(true);
    expect(await attachmentCount()).toBe(1);
  });

  /* NFR SEC 07, and the story's third criterion said as plainly as it can be. */
  it('records what the bytes are, not what the file was called', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(
      asTheEmployee(),
      request.id,
      aFile(A_PNG, 'certificate.pdf'),
    );

    expect(attached.contentType).toBe('image/png');
    expect(attached.filename).toBe('certificate.pdf');
  });

  it('refuses a file that is none of the four, whatever it is named', async () => {
    const request = await aRequest();

    await expect(
      attachments.attach(
        asTheEmployee(),
        request.id,
        aFile(Buffer.from('#!/bin/sh\necho hello\n'), 'certificate.pdf'),
      ),
    ).rejects.toThrow(AttachmentTypeNotAccepted);

    expect(await attachmentCount()).toBe(0);
    expect(storage.size).toBe(0);
  });

  it('gives each file its own seat, and refuses the sixth', async () => {
    const request = await aRequest();

    for (let file = 1; file <= 5; file += 1) {
      const attached = await attachments.attach(
        asTheEmployee(),
        request.id,
        aFile(A_PDF, `certificate-${file}.pdf`),
      );

      expect(attached.slot).toBe(file);
    }

    await expect(
      attachments.attach(asTheEmployee(), request.id, aFile(A_PDF, 'one-more.pdf')),
    ).rejects.toThrow(TooManyAttachments);

    expect(await attachmentCount()).toBe(5);
    expect(storage.size).toBe(5);
  });

  /* The index rather than the count is what holds it, which is the migration's argument. */
  it('and the sixth seat is refused by the database as well', async () => {
    const request = await aRequest();

    await attachments.attach(asTheEmployee(), request.id, aFile());

    await expect(
      admin.query(
        `INSERT INTO leave_request_attachment
           (leave_request_id, held_for_employee_id, slot, filename, content_type, size_bytes,
            checksum_sha256, storage_key, scan_status)
         VALUES ($1, $4, 1, 'another.pdf', 'application/pdf', 10, $2, $3, 'PENDING')`,
        [request.id, 'c'.repeat(64), 'd'.repeat(64), request.employeeId],
      ),
    ).rejects.toThrow(/leave_request_attachment_five_per_request/);
  });

  it('takes the seat a removed file left, rather than the next number up', async () => {
    const request = await aRequest();

    const first = await attachments.attach(asTheEmployee(), request.id, aFile(A_PDF, 'one.pdf'));
    await attachments.attach(asTheEmployee(), request.id, aFile(A_PDF, 'two.pdf'));

    await attachments.remove(asTheEmployee(), request.id, first.id);

    const third = await attachments.attach(asTheEmployee(), request.id, aFile(A_PDF, 'three.pdf'));

    expect(third.slot).toBe(1);
  });

  it('names who attached it, off the session rather than off the body', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    expect(attached.uploadedByEmployeeId).toBe(people.officer);
    expect(attached.uploadedBy).toContain(people.officer);
  });

  it('goes on nothing that has ended', async () => {
    const request = await aRequest();

    await requests.withdraw(asTheEmployee(), request.id);

    await expect(attachments.attach(asTheEmployee(), request.id, aFile())).rejects.toThrow(
      AttachmentsAreClosed,
    );
  });
});

/* --------------------------------------------------------- virus scanning, NFR SEC 07 */

describe('the scan', () => {
  it('records a clean verdict on the row, with who gave it', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    expect(attached.scanStatus).toBe('CLEAN');
    expect(attached.scannedBy).not.toBeNull();
    expect(attached.scannedAt).not.toBeNull();
  });

  /* Nothing is stored and no row is written: an infected file never lands at all. */
  it('refuses an infected file outright, storing nothing', async () => {
    const request = await aRequest();

    await expect(
      attachments.attach(asTheEmployee(), request.id, aFile(EICAR, 'certificate.pdf')),
    ).rejects.toThrow(AttachmentIsInfected);

    expect(await attachmentCount()).toBe(0);
    expect(storage.size).toBe(0);
  });

  /* NFR SEC 07: a scanner that cannot be reached is not a scanner that said yes. */
  it('keeps a file it could not scan, and calls it unscanned', async () => {
    const request = await aRequest();

    const attached = await unscanned.attach(asTheEmployee(), request.id, aFile());

    expect(attached.scanStatus).toBe('PENDING');
    expect(attached.scannedAt).toBeNull();
    expect(storage.has(attached.storageKey)).toBe(true);
  });

  it('and will not hand an unscanned file over', async () => {
    const request = await aRequest();

    const attached = await unscanned.attach(asTheEmployee(), request.id, aFile());

    await expect(attachments.download(asTheEmployee(), request.id, attached.id)).rejects.toThrow(
      AttachmentNotScanned,
    );
  });

  it('settles a pending file when the scanner comes back', async () => {
    const request = await aRequest();

    const attached = await unscanned.attach(asTheEmployee(), request.id, aFile());

    const scanned = await attachments.rescan(asTheEmployee(), request.id, attached.id);

    expect(scanned.scanStatus).toBe('CLEAN');
    expect((await attachments.download(asTheEmployee(), request.id, attached.id)).content).toEqual(
      A_PDF,
    );
  });

  /* The bytes go, the row stays: the record says a file was attached and what became of it. */
  it('and takes the bytes away when a later scan finds something', async () => {
    const request = await aRequest();

    const attached = await unscanned.attach(
      asTheEmployee(),
      request.id,
      aFile(EICAR, 'certificate.pdf'),
    );

    const scanned = await attachments.rescan(asTheEmployee(), request.id, attached.id);

    expect(scanned.scanStatus).toBe('INFECTED');
    expect(scanned.scanSignature).toBe('EICAR-Test-File');
    expect(storage.has(attached.storageKey)).toBe(false);
    expect(await attachmentCount()).toBe(1);
  });

  it('and a verdict is given once, whatever writes to the row', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    await expect(
      admin.query('UPDATE leave_request_attachment SET scan_status = $1 WHERE id = $2', [
        'INFECTED',
        attached.id,
      ]),
    ).rejects.toThrow(/already scanned/);
  });

  it('and the file itself is never rewritten', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    await expect(
      admin.query('UPDATE leave_request_attachment SET filename = $1 WHERE id = $2', [
        'something-else.pdf',
        attached.id,
      ]),
    ).rejects.toThrow(/cannot be made into another/);
  });
});

/* -------------------------------------------- what it satisfies, FR 13 and NFR SEC 07 */

describe('whether a request has the documentation it needs', () => {
  it('says a clean file satisfies the rule', async () => {
    const request = await aSickRequest();

    const held = await attachments.forRequest(asTheEmployee(), request.id);

    expect(held.evidence.required).toBe(true);
    expect(held.evidence.usable).toBe(1);
    expect(held.evidence.satisfied).toBe(true);
  });

  /* The story's fourth criterion, straight through: attached, and counting for nothing. */
  it('and that an unscanned one does not', async () => {
    const request = await aSickRequest();

    await unscanned.attach(asTheEmployee(), request.id, aFile(A_PDF, 'a-second-note.pdf'));

    const held = await attachments.forRequest(asTheEmployee(), request.id);

    expect(held.evidence.attached).toBe(2);
    expect(held.evidence.usable).toBe(1);
    expect(held.attachments[1].scanStatus).toBe('PENDING');
    expect(held.evidence.inWords).toContain('still being checked');
  });
});

/* ---------------------------------------------------- reading and removing, FR 12 */

describe('reading what is attached', () => {
  it('gives the bytes back exactly as they went in', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    const { content } = await attachments.download(asTheEmployee(), request.id, attached.id);

    expect(content).toEqual(A_PDF);
  });

  it('is read by the approver who has to decide on it', async () => {
    const request = await aRequest();

    await attachments.attach(asTheEmployee(), request.id, aFile());

    expect((await attachments.forRequest(asTheirManager(), request.id)).attachments).toHaveLength(
      1,
    );
    expect((await attachments.forRequest(asAnHrOfficer(), request.id)).attachments).toHaveLength(1);
  });

  it('and by nobody else', async () => {
    const request = await aRequest();

    await attachments.attach(asTheEmployee(), request.id, aFile());

    await expect(attachments.forRequest(asAStranger(), request.id)).rejects.toThrow(NotAuthorised);
  });

  /* An approver asks for a certificate; they do not supply one. FR 12. */
  it('and is attached to by nobody but the person whose leave it is, or HR', async () => {
    const request = await aRequest();

    await expect(attachments.attach(asTheirManager(), request.id, aFile())).rejects.toThrow(
      NotAuthorised,
    );

    await expect(attachments.attach(asAnHrOfficer(), request.id, aFile())).resolves.toBeDefined();
  });

  it('refuses an attachment id that belongs to another request', async () => {
    const first = await aRequest();
    const second = await requests.submit(asTheEmployee(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: daysFromToday(40),
      to: daysFromToday(41),
      reason: 'Another week',
      acknowledgesShortNotice: true,
    });

    const attached = await attachments.attach(asTheEmployee(), first.id, aFile());

    await expect(
      attachments.download(asTheEmployee(), second.request.id, attached.id),
    ).rejects.toThrow(AttachmentNotFound);
  });
});

describe('removing a file', () => {
  it('takes the row and the bytes together', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    await attachments.remove(asTheEmployee(), request.id, attached.id);

    expect(await attachmentCount()).toBe(0);
    expect(storage.has(attached.storageKey)).toBe(false);
  });

  /* A file a desk could already have read is part of why the leave was decided. */
  it('but not once a desk has decided on it', async () => {
    const request = await aRequest();

    const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

    await requests.approve(asTheirManager(), request.id);
    await requests.approve(asAnHrOfficer(), request.id);

    await expect(attachments.remove(asTheEmployee(), request.id, attached.id)).rejects.toThrow(
      AttachmentsAreClosed,
    );

    expect(await attachmentCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------ the schema */

describe('the table itself', () => {
  it('accepts exactly the four types the domain names', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'leave_request_attachment_content_type_accepted'`,
    );

    for (const type of ACCEPTED_CONTENT_TYPES) {
      expect(rows[0].definition).toContain(type);
    }
  });

  it('refuses a filename that is a path', async () => {
    const request = await aRequest();

    await expect(
      admin.query(
        `INSERT INTO leave_request_attachment
           (leave_request_id, held_for_employee_id, slot, filename, content_type, size_bytes,
            checksum_sha256, storage_key, scan_status)
         VALUES ($1, $4, 1, '../../etc/passwd', 'application/pdf', 10, $2, $3, 'PENDING')`,
        [request.id, 'c'.repeat(64), 'd'.repeat(64), request.employeeId],
      ),
    ).rejects.toThrow(/filename_is_a_name/);
  });

  it('refuses a file past the cap', async () => {
    const request = await aRequest();

    await expect(
      admin.query(
        `INSERT INTO leave_request_attachment
           (leave_request_id, held_for_employee_id, slot, filename, content_type, size_bytes,
            checksum_sha256, storage_key, scan_status)
         VALUES ($1, $5, 1, 'huge.pdf', 'application/pdf', $2, $3, $4, 'PENDING')`,
        [request.id, 10 * 1024 * 1024 + 1, 'c'.repeat(64), 'd'.repeat(64), request.employeeId],
      ),
    ).rejects.toThrow(/size_within_the_cap/);
  });

  it('refuses a verdict with nobody and no time on it', async () => {
    const request = await aRequest();

    await expect(
      admin.query(
        `INSERT INTO leave_request_attachment
           (leave_request_id, held_for_employee_id, slot, filename, content_type, size_bytes,
            checksum_sha256, storage_key, scan_status)
         VALUES ($1, $4, 1, 'note.pdf', 'application/pdf', 10, $2, $3, 'CLEAN')`,
        [request.id, 'c'.repeat(64), 'd'.repeat(64), request.employeeId],
      ),
    ).rejects.toThrow(/verdict_is_stamped/);
  });

  /* NFR AUD 01. A frozen row is its own history, and a snapshot would copy every
     certificate's filename into a table HR reads. */
  it('is not audited, and `AUDITED_ENTITIES` says so', () => {
    expect(AUDITED_ENTITIES as readonly string[]).not.toContain('leave_request_attachment');
  });
});
