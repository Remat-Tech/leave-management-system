import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { calendarDateIn } from '../../src/shared/time.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  DocumentationCannotBeRemoved,
  TooManyAttachments,
} from '../../src/features/leave-request/attachment.js';
import { DocumentationNotAttached } from '../../src/features/leave-request/leave-request.js';
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
 * Documentation that has to arrive with the request. FR 13, FR 32a, §8.6b. LMS 311.
 *
 * ../unit/leave-request.test.ts proves which of the two thresholds bites and what the refusal
 * says; ../unit/attachment.test.ts proves what may be taken back off. What needs a database —
 *
 *   **Evidence exists before the request does.** FR 13 is answered at submission, so the
 *   file is uploaded, scanned and stored first and waits under its owner's name. Only a real
 *   store, a real scanner and a nullable foreign key show that.
 *
 *   **The certificate and the leave are one commit.** The request row, its RESERVATION and
 *   the attachment land together or none of them does, and a deferred constraint trigger
 *   refuses the transaction that would leave a required request with nothing on it.
 *
 *   **Sick leave's three days are a threshold rather than a cap.** FR 32a over the row the
 *   migration actually ships, so the rule is read off `exceedable_with_document` and not off
 *   a type code — and the balance goes below nought, which is correct.
 *
 *   **And nothing can take the evidence off afterwards.** Which is what makes "arrives with
 *   the request" different from "arrived once".
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('required documentation fixtures');
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
    attachmentRepository,
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

  await grant(annualId, 20);
  await grant(sickId, 3);
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

/** FR 32a. Three days of sick leave, which is the allowance the SRS gives it. */
async function grant(leaveTypeId: string, days: number): Promise<void> {
  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId,
    leaveYearId: y2026.id,
    days,
    reason: 'Entitlement for 2026',
  });
}

function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return calendarDateIn(day, 'UTC');
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asAStranger() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('a medical certificate')]);

function aFile(filename = 'certificate.pdf') {
  return { filename, content: A_PDF, claimedContentType: 'application/octet-stream' };
}

/** FR 32a. Five working days of sick leave against an allowance of three. */
function pastTheAllowance(evidence: string[] = []) {
  return {
    employeeId: people.officer,
    leaveTypeId: sickId,
    from: daysFromToday(21),
    to: daysFromToday(25),
    reason: 'Off sick',
    evidence,
  };
}

/** The same dates as annual leave, where no rule asks for anything. */
function askingNothing() {
  return { ...pastTheAllowance(), leaveTypeId: annualId, reason: 'My sister is getting married' };
}

async function requestCount(): Promise<number> {
  const { rows } = await admin.query<{ count: string }>('SELECT count(*) FROM leave_request');

  return Number(rows[0].count);
}

/* ---------------------------------------------- evidence before the request, FR 13 */

describe('evidence uploaded before there is a request to hang it on', () => {
  /**
   * The half LMS 310 had no place for, and the reason this story needed a migration.
   *
   * A file goes into storage, is scanned, and gets a row with no `leave_request_id` on it —
   * because FR 13 is answered while the form is still open, which is before the request that
   * would name it exists.
   */
  it('is stored, scanned and waiting under its owner’s name', async () => {
    const held = await attachments.hold(asTheEmployee(), people.officer, aFile());

    expect(held.leaveRequestId).toBeNull();
    expect(held.heldForEmployeeId).toBe(people.officer);
    expect(held.scanStatus).toBe('CLEAN');
    expect(storage.has(held.storageKey)).toBe(true);
  });

  it('and is reported with what could actually stand as documentation', async () => {
    await attachments.hold(asTheEmployee(), people.officer, aFile('one.pdf'));
    await unscanned.hold(asTheEmployee(), people.officer, aFile('two.pdf'));

    const waiting = await attachments.waitingFor(asTheEmployee(), people.officer);

    expect(waiting.attachments).toHaveLength(2);
    expect(waiting.usable).toBe(1);
    expect(waiting.inWords).toContain('still being checked');
  });

  /* FR 12. The five seats hold in the pile too, by the index rather than by a count. */
  it('and five is five before a request exists, as it is after one does', async () => {
    for (let file = 1; file <= 5; file += 1) {
      await attachments.hold(asTheEmployee(), people.officer, aFile(`${file}.pdf`));
    }

    await expect(
      attachments.hold(asTheEmployee(), people.officer, aFile('six.pdf')),
    ).rejects.toThrow(TooManyAttachments);
  });

  /* NFR SEC 04. Somebody else's certificate is not theirs to see, list or throw away. */
  it('and belongs to the person it was uploaded for and to HR, and to nobody else', async () => {
    const held = await attachments.hold(asTheEmployee(), people.officer, aFile());

    await expect(attachments.waitingFor(asAStranger(), people.officer)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(attachments.discard(asAStranger(), held.id)).rejects.toBeInstanceOf(NotAuthorised);

    expect((await attachments.waitingFor(asAnHrOfficer(), people.officer)).usable).toBe(1);
  });

  it('and is thrown away with its bytes when it is not wanted', async () => {
    const held = await attachments.hold(asTheEmployee(), people.officer, aFile());

    await attachments.discard(asTheEmployee(), held.id);

    expect(storage.has(held.storageKey)).toBe(false);
    expect((await attachments.waitingFor(asTheEmployee(), people.officer)).attachments).toEqual([]);
  });

  /**
   * NFR SEC 07, and it matters more here than anywhere.
   *
   * A `PENDING` file satisfies nothing, so somebody whose scanner was down when they uploaded
   * has evidence that cannot get their leave through until a rescan settles it — and without
   * this they would have no way to ask.
   */
  it('and a file nothing answered for can be asked about again', async () => {
    const held = await unscanned.hold(asTheEmployee(), people.officer, aFile());

    expect(held.scanStatus).toBe('PENDING');

    const scanned = await attachments.rescanWaiting(asTheEmployee(), held.id);

    expect(scanned.scanStatus).toBe('CLEAN');
  });
});

/* ------------------------------------------- the rule at submission, FR 13, FR 32a */

describe('leave that policy asks for documentation on', () => {
  /**
   * The story's first criterion, and its second: sick leave's three days are the point at
   * which a certificate is demanded, and demanding it means refusing the request that arrives
   * without one rather than letting it through and chasing the paperwork afterwards.
   *
   * Nothing is written — not the request, not the RESERVATION — which is what makes this a
   * block on submission rather than a flag on a row.
   */
  it('is refused, and nothing at all is written', async () => {
    await expect(requests.submit(asTheEmployee(), pastTheAllowance())).rejects.toBeInstanceOf(
      DocumentationNotAttached,
    );

    expect(await requestCount()).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RESERVATION'",
        )
      ).rows[0].count,
    ).toBe('0');
  });

  /* And the same days go through with the certificate named. §8.6b: below nought is right. */
  it('and goes through with the certificate on it, past the allowance and below nought', async () => {
    const certificate = await attachments.hold(asTheEmployee(), people.officer, aFile());

    const { request, balance } = await requests.submit(
      asTheEmployee(),
      pastTheAllowance([certificate.id]),
    );

    expect(request.status).toBe('SUBMITTED');
    expect(request.evidenceRequired).toBe(true);
    expect(balance.available).toBeLessThan(0);

    const held = await attachments.forRequest(asTheEmployee(), request.id);

    expect(held.attachments).toHaveLength(1);
    expect(held.attachments[0].id).toBe(certificate.id);
    expect(held.evidence.satisfied).toBe(true);
  });

  /* NFR SEC 07. Unscanned is a state, and it satisfies nothing — including this. */
  it('and is refused where all that is waiting is a file nothing has cleared', async () => {
    const pending = await unscanned.hold(asTheEmployee(), people.officer, aFile());

    await expect(
      requests.submit(asTheEmployee(), pastTheAllowance([pending.id])),
    ).rejects.toBeInstanceOf(DocumentationNotAttached);

    expect(await requestCount()).toBe(0);
  });

  /**
   * FR 32a's threshold read from the balance rather than from the length. §8.6b.
   *
   * Three days is the allowance, so three days is askable with nothing attached and the
   * fourth is not — which is "beyond 3 days in a leave year" said as a comparison rather than
   * as a number written down anywhere.
   */
  it('and the allowance is the threshold: what is left needs nothing', async () => {
    const { request } = await requests.submit(asTheEmployee(), {
      ...pastTheAllowance(),
      from: daysFromToday(21),
      to: daysFromToday(23),
    });

    expect(request.days).toBe(3);
    expect(request.evidenceRequired).toBe(false);
  });

  /* FR 32a counts the leave year rather than the request: the fourth day needs one. */
  it('and the day after the allowance runs out needs one, however short the request', async () => {
    await requests.submit(asTheEmployee(), {
      ...pastTheAllowance(),
      from: daysFromToday(21),
      to: daysFromToday(23),
    });

    await expect(
      requests.submit(asTheEmployee(), {
        ...pastTheAllowance(),
        from: daysFromToday(28),
        to: daysFromToday(28),
      }),
    ).rejects.toBeInstanceOf(DocumentationNotAttached);
  });

  /* FR 13, and the other threshold, over a type HR configured rather than a code. */
  it('and the length of the request is the other threshold, read off the type', async () => {
    await admin.query(
      `UPDATE leave_type
          SET documentation = 'AFTER_DAYS', documentation_after_days = 2
        WHERE id = $1`,
      [annualId],
    );

    await expect(requests.submit(asTheEmployee(), askingNothing())).rejects.toBeInstanceOf(
      DocumentationNotAttached,
    );

    const certificate = await attachments.hold(asTheEmployee(), people.officer, aFile());
    const { request } = await requests.submit(asTheEmployee(), {
      ...askingNothing(),
      evidence: [certificate.id],
    });

    expect(request.evidenceRequired).toBe(true);
  });

  it('and asks nothing of leave no rule applies to', async () => {
    const { request } = await requests.submit(asTheEmployee(), askingNothing());

    expect(request.evidenceRequired).toBe(false);
  });

  /**
   * NFR SEC 04. Naming a file that is not yours reaches nothing rather than being refused.
   *
   * The same silence `leaveRequestPolicy.attach` keeps: a refusal naming the id would let a
   * submission be used to discover that a colleague uploaded a medical certificate this
   * morning. What the person meets is FR 13's own sentence about their leave.
   */
  it('and somebody else’s certificate is not evidence and does not say so', async () => {
    const theirs = await attachments.hold(asAStranger(), people.engineer, aFile());

    await expect(
      requests.submit(asTheEmployee(), pastTheAllowance([theirs.id])),
    ).rejects.toBeInstanceOf(DocumentationNotAttached);

    /* And it is still theirs, still waiting, untouched. */
    expect((await attachments.waitingFor(asAStranger(), people.engineer)).attachments).toHaveLength(
      1,
    );
  });

  /* FR 18. HR entering the record for somebody who was away holds the file for them. */
  it('and HR uploads on somebody’s behalf, as they submit on it', async () => {
    const certificate = await attachments.hold(asAnHrOfficer(), people.officer, aFile());

    expect(certificate.heldForEmployeeId).toBe(people.officer);

    const { request } = await requests.submit(asAnHrOfficer(), pastTheAllowance([certificate.id]));

    expect(request.evidenceRequired).toBe(true);
    expect(request.employeeId).toBe(people.officer);
  });
});

/* -------------------------------------------- and it stays on, FR 13, NFR SEC 07 */

describe('the file a request was allowed through on', () => {
  async function aSickRequestWithACertificate() {
    const certificate = await attachments.hold(asTheEmployee(), people.officer, aFile());
    const { request } = await requests.submit(asTheEmployee(), pastTheAllowance([certificate.id]));

    return { request, certificate };
  }

  /**
   * "The evidence arrives with the request rather than being chased afterwards" is only true
   * if it also stays. Otherwise the certificate is a formality at submission and the request
   * sits on the books in a state submission would have refused.
   */
  it('cannot be taken back off while it is the only one', async () => {
    const { request, certificate } = await aSickRequestWithACertificate();

    await expect(
      attachments.remove(asTheEmployee(), request.id, certificate.id),
    ).rejects.toBeInstanceOf(DocumentationCannotBeRemoved);

    expect((await attachments.forRequest(asTheEmployee(), request.id)).attachments).toHaveLength(1);
    expect(storage.has(certificate.storageKey)).toBe(true);
  });

  /* Replacing it is allowed, which is what the refusal's message tells somebody to do. */
  it('and comes off once a replacement is standing behind it', async () => {
    const { request, certificate } = await aSickRequestWithACertificate();

    await attachments.attach(asTheEmployee(), request.id, aFile('a-better-scan.pdf'));
    await attachments.remove(asTheEmployee(), request.id, certificate.id);

    const held = await attachments.forRequest(asTheEmployee(), request.id);

    expect(held.attachments).toHaveLength(1);
    expect(held.evidence.satisfied).toBe(true);
    expect(storage.has(certificate.storageKey)).toBe(false);
  });

  /**
   * And the owner connection cannot do it either, which is the half that matters.
   *
   * `leave_request_attachment_is_what_it_was_allowed_on` is a deferred constraint trigger, so
   * the rule holds for a psql prompt and a migration as well as for the service — the same
   * arrangement `leave_request_never_overlaps` makes about days.
   */
  it('and the database refuses it too, on every connection', async () => {
    const { request, certificate } = await aSickRequestWithACertificate();

    await expect(
      admin.query('DELETE FROM leave_request_attachment WHERE id = $1', [certificate.id]),
    ).rejects.toThrow(/leave_request_attachment_is_what_it_was_allowed_on/);

    expect((await attachments.forRequest(asTheEmployee(), request.id)).attachments).toHaveLength(1);
  });

  /* And a request nothing was asked of keeps LMS 310's rule unchanged. FR 12. */
  it('and evidence nobody demanded still comes off freely', async () => {
    const { request } = await requests.submit(asTheEmployee(), askingNothing());

    const extra = await attachments.attach(asTheEmployee(), request.id, aFile());

    await attachments.remove(asTheEmployee(), request.id, extra.id);

    expect((await attachments.forRequest(asTheEmployee(), request.id)).attachments).toEqual([]);
  });
});

/* ------------------------------------------------------------------- the schema */

describe('the table itself', () => {
  /**
   * The guarantee the whole story rests on, held where no writer can get around it.
   *
   * A request that says it needed documentation and has no `CLEAN` file under it cannot
   * commit — deferred, because the row is written before the files are put on it and both
   * happen inside one transaction.
   */
  it('refuses to commit a request that needed evidence with none on it', async () => {
    await admin.query('BEGIN');

    await expect(
      admin
        .query(
          `INSERT INTO leave_request
           (employee_id, leave_type_id, leave_year_id, start_date, end_date, reason,
            evidence_required, counting_basis, days, calendar_days, status,
            awaiting_approval_from)
         VALUES ($1, $2, $3, $4, $5, 'Off sick', TRUE, 'WORKING_DAYS', 5, 5, 'SUBMITTED',
                 'MANAGER')`,
          [people.officer, sickId, y2026.id, daysFromToday(21), daysFromToday(25)],
        )
        .then(() => admin.query('COMMIT')),
    ).rejects.toThrow(/leave_request_that_needed_evidence_has_it/);

    await admin.query('ROLLBACK');

    expect(await requestCount()).toBe(0);
  });

  /* And evidence that changed hands would put a certificate on a stranger's request. */
  it('refuses a file held for one person on another person’s request', async () => {
    const { request } = await requests.submit(asTheEmployee(), askingNothing());

    await expect(
      admin.query(
        `INSERT INTO leave_request_attachment
           (leave_request_id, held_for_employee_id, slot, filename, content_type, size_bytes,
            checksum_sha256, storage_key, scan_status)
         VALUES ($1, $2, 1, 'theirs.pdf', 'application/pdf', 10, $3, $4, 'PENDING')`,
        [request.id, people.engineer, 'c'.repeat(64), 'd'.repeat(64)],
      ),
    ).rejects.toThrow(/leave_request_attachment_stays_with_whose_it_is/);
  });

  /* And a file goes onto a request once. `slot` moves with it and nothing else does. */
  it('refuses moving a file from the request it is on to another', async () => {
    const certificate = await attachments.hold(asTheEmployee(), people.officer, aFile());
    const { request } = await requests.submit(asTheEmployee(), pastTheAllowance([certificate.id]));

    await expect(
      admin.query('UPDATE leave_request_attachment SET leave_request_id = NULL WHERE id = $1', [
        certificate.id,
      ]),
    ).rejects.toThrow(/leave_request_attachment_is_the_file_it_was/);

    expect((await attachments.forRequest(asTheEmployee(), request.id)).attachments).toHaveLength(1);
  });
});
