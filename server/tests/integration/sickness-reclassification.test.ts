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
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { AttachmentService } from '../../src/features/leave-request/attachment.service.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
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
import { delegationService } from '../support/delegations.js';

/**
 * Sickness during annual leave, moved to sick leave. FR 32c, §8.6c. LMS 507.
 *
 * ../unit/reclassification.test.ts proves what is pure: which days are being moved, which
 * certificate can stand, and what the one sentence says. What needs a server:
 *
 *   **Two balances move, and the arithmetic is right in both.** The annual days come back
 *   out of `taken` and the same days go into sick leave's, which is a `RECLASSIFICATION`
 *   either way — a kind of entry nothing wrote until this story.
 *
 *   **The pair is a pair.** One correlation id, one reason, and a schema that refuses half
 *   of it however it is written.
 *
 *   **The request is untouched.** Its dates, its price and its status are exactly what they
 *   were, which is §8.6c's remaining days keeping the dates they were booked for.
 *
 *   **Sick leave goes negative and that is correct.** §8.6b.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('reclassification integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let attachments: AttachmentService;
let unscanned: AttachmentService;
let notices: NotificationRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;
let sickId: string;
let compassionateId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const attachmentRepository = new AttachmentRepository(db);
  const organisation = new OrganisationRepository(db);
  const storage = new InMemoryStorage();

  notices = new NotificationRepository(db);
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
    /** FR 32c, LMS 507. */
    new ReclassificationRepository(db),
    attachmentRepository,
    new RoleRepository(db),
    delegationService(db, guard),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(notices, recordingMailer(), guard),
  );

  const attachmentServiceWith = (scanner: SignatureScanner | UnavailableScanner) =>
    new AttachmentService(
      guard,
      attachmentRepository,
      new AttachmentLinkRepository(db),
      requestRepository,
      employees,
      types,
      organisation,
      delegationService(db, guard),
      storage,
      scanner,
    );

  attachments = attachmentServiceWith(new SignatureScanner());
  unscanned = attachmentServiceWith(new UnavailableScanner());
});

beforeEach(async () => {
  /* FR 18, LMS 308. Every fixture here is leave that has already been taken, which is
     further back than annual leave's seven day window. Widened rather than dated forward,
     as ./withdrawal.test.ts widens it. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0].id;
  compassionateId = (await admin.query("SELECT id FROM leave_type WHERE code = 'COMPASSIONATE'"))
    .rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await grant(annualId, 20);
  /** FR 32a. Three days, which is the allowance the SRS gives sick leave. */
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
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, ' +
      'leave_request_attachment, leave_request_decision, leave_request_reassignment, ' +
      'leave_request_routing, leave_request_withdrawal, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

async function grant(leaveTypeId: string, days: number): Promise<void> {
  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId,
    leaveYearId: y2026.id,
    days,
    reason: 'Entitlement for 2026',
  });
}

/** The nth working day before today. A calendar offset lands fixtures on a Saturday. */
function workingDaysAgo(offset: number): string {
  const day = new Date();

  for (let counted = 0; counted < offset;) {
    day.setUTCDate(day.getUTCDate() - 1);

    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      counted += 1;
    }
  }

  return calendarDateIn(day, 'UTC');
}

/** Five working days, a fortnight back: leave that has been taken. */
function theFortnightTaken(): [string, string] {
  return [workingDaysAgo(14), workingDaysAgo(10)];
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('a medical certificate')]);

function aFile(filename = 'certificate.pdf') {
  return { filename, content: A_PDF, claimedContentType: 'application/octet-stream' };
}

/** A scanned, clean medical certificate waiting under the employee's name. */
async function aCertificate(employeeId = people.officer): Promise<string> {
  const held = await attachments.hold(
    signedInAs(employeeId, { roles: ['EMPLOYEE'], isManager: false }),
    employeeId,
    aFile(),
  );

  return held.id;
}

/** One approved request, through the real doors, so its `DEDUCTION` actually moved. */
async function anApprovedRequest(from: string, to: string): Promise<string> {
  const { request } = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'A fortnight by the sea',
    acknowledgesShortNotice: true,
  });

  await requests.approve(asTheirManager(), request.id);
  await requests.approve(asAnHrOfficer(), request.id);

  return request.id;
}

function annualBalance() {
  return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id };
}

function sickBalance() {
  return { employeeId: people.officer, leaveTypeId: sickId, leaveYearId: y2026.id };
}

async function availableIn(key: ReturnType<typeof annualBalance>): Promise<number> {
  return (await balances.forOne(system, key)).available;
}

async function theRequest(id: string) {
  const { rows } = await admin.query<{
    status: string;
    start_date: string;
    end_date: string;
    days: number;
  }>('SELECT status, start_date, end_date, days FROM leave_request WHERE id = $1', [id]);

  return rows[0];
}

async function entriesFor(id: string) {
  const { rows } = await admin.query<{
    entry_type: string;
    days: string;
    reason: string;
    leave_type_id: string;
    correlation_id: string | null;
    certified_days: number;
  }>(
    'SELECT entry_type, days, reason, leave_type_id, correlation_id, certified_days ' +
      'FROM leave_ledger_entry WHERE leave_request_id = $1 ORDER BY id',
    [id],
  );

  return rows;
}

/* ------------------------------------------- the whole request, FR 32c's first criterion */

describe('a holiday spent unwell, converted whole', () => {
  it('credits the annual days back and charges the same days to sick leave', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;

    expect(await availableIn(annualBalance())).toBe(20 - cost);

    const moved = await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      certificateId: await aCertificate(),
    });

    expect(moved.reclassification.days).toBe(cost);
    expect(await availableIn(annualBalance())).toBe(20);
    expect(await availableIn(sickBalance())).toBe(3 - cost);
  });

  /* §8.6c's fourth criterion, and the one that is an absence of a write: the leave still
     happened on the days it happened on, and nothing offers to move it to later ones. */
  it('and the leave itself is exactly as it was booked', async () => {
    const [from, to] = theFortnightTaken();
    const id = await anApprovedRequest(from, to);
    const before = await theRequest(id);

    await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      certificateId: await aCertificate(),
    });

    expect(await theRequest(id)).toEqual(before);
    expect(before.status).toBe('APPROVED');
    expect(before.start_date).toBe(from);
    expect(before.end_date).toBe(to);
  });

  /* The story's third criterion. Two entries, and everything that makes them one act. */
  it('and writes two entries under one reason and one correlation id', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      certificateId: await aCertificate(),
    });

    const moved = (await entriesFor(id)).filter((entry) => entry.entry_type === 'RECLASSIFICATION');

    expect(moved).toHaveLength(2);
    expect(new Set(moved.map((entry) => entry.correlation_id)).size).toBe(1);
    expect(new Set(moved.map((entry) => entry.reason)).size).toBe(1);
    expect(moved[0].reason).toContain('moved to Sick Leave');

    /* Credit on the balance they came out of, charge on the one they went into, and
       nought days between them. */
    expect(moved.map((entry) => entry.leave_type_id).sort()).toEqual([annualId, sickId].sort());
    expect(moved.reduce((total, entry) => total + Number(entry.days), 0)).toBe(0);
  });

  /** §8.6b. The balance goes below nought, and there is no clamp anywhere. */
  it('and sick leave is permitted to go negative', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;

    const moved = await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      certificateId: await aCertificate(),
    });

    expect(cost).toBeGreaterThan(3);
    expect(moved.into.available).toBe(3 - cost);
    expect(moved.into.available).toBeLessThan(0);

    /* FR 32a, LMS 312. The days past the allowance are the ones the certificate carried. */
    const charged = (await entriesFor(id)).find(
      (entry) => entry.entry_type === 'RECLASSIFICATION' && entry.leave_type_id === sickId,
    );

    expect(charged?.certified_days).toBe(cost - 3);
  });

  /** FR 59. The person hears, and what they hear is that the days are back. */
  it('and the person is told, in words that say the rest of the leave stands', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      certificateId: await aCertificate(),
    });

    const told = await notices.forEmployee(people.officer);
    const said = told.find((notice) => notice.event === 'LEAVE_RECLASSIFIED');

    expect(said).toBeDefined();
    expect(said?.body).toContain('Sick Leave');
    expect(said?.body).toContain('Nothing has been moved to later dates');
  });
});

/* ------------------------------------------- whole days inside it, FR 32c's first criterion */

describe('some days of a holiday, converted', () => {
  it('moves only the days named, and leaves the rest annual leave', async () => {
    const [from, to] = theFortnightTaken();
    const id = await anApprovedRequest(from, to);
    const cost = (await theRequest(id)).days;

    const moved = await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      from: workingDaysAgo(12),
      to: workingDaysAgo(12),
      certificateId: await aCertificate(),
    });

    expect(moved.reclassification.days).toBe(1);
    expect(await availableIn(annualBalance())).toBe(20 - cost + 1);
    expect(await availableIn(sickBalance())).toBe(2);
  });

  /* A day moved twice would credit annual leave twice and charge sick leave twice, and
     both balances would still reconcile. */
  it('and a day that has moved once does not move again', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const day = workingDaysAgo(12);

    await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      from: day,
      to: day,
      certificateId: await aCertificate(),
    });

    await expect(
      requests.reclassify(asAnHrOfficer(), id, {
        toLeaveTypeId: sickId,
        from: day,
        to: day,
        certificateId: await aCertificate(),
      }),
    ).rejects.toMatchObject({ code: 'DAYS_ALREADY_MOVED' });

    /* And the days either side of it still can. */
    const second = await requests.reclassify(asAnHrOfficer(), id, {
      toLeaveTypeId: sickId,
      from: workingDaysAgo(14),
      to: workingDaysAgo(13),
      certificateId: await aCertificate(),
    });

    expect(second.reclassification.days).toBe(2);
  });

  it('and days outside the leave are refused', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await expect(
      requests.reclassify(asAnHrOfficer(), id, {
        toLeaveTypeId: sickId,
        from: workingDaysAgo(20),
        to: workingDaysAgo(12),
        certificateId: await aCertificate(),
      }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_THE_LEAVE' });
  });
});

/* ----------------------------------------------- the certificate, FR 13 and NFR SEC 07 */

describe('the certificate it stands on', () => {
  it('has to be one the scanner has cleared', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const waiting = await unscanned.hold(asTheEmployee(), people.officer, aFile());

    expect(waiting.scanStatus).toBe('PENDING');

    await expect(
      requests.reclassify(asAnHrOfficer(), id, {
        toLeaveTypeId: sickId,
        certificateId: waiting.id,
      }),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_USABLE' });
  });

  it('and has to be the certificate of the person whose leave it is', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await expect(
      requests.reclassify(asAnHrOfficer(), id, {
        toLeaveTypeId: sickId,
        certificateId: await aCertificate(people.engineer),
      }),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_USABLE' });
  });

  /* And nothing moved on the way to either refusal. */
  it('and neither balance moves when it is refused', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const spent = await availableIn(annualBalance());

    await expect(
      requests.reclassify(asAnHrOfficer(), id, { toLeaveTypeId: sickId, certificateId: '0' }),
    ).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_USABLE' });

    expect(await availableIn(annualBalance())).toBe(spent);
    expect(await availableIn(sickBalance())).toBe(3);
  });
});

/* ------------------------------------------------------- where the days may go, §8.6b */

describe('the type the days move into', () => {
  it('cannot be the type the leave already is', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await expect(
      requests.reclassify(asAnHrOfficer(), id, {
        toLeaveTypeId: annualId,
        certificateId: await aCertificate(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_TYPE_TO_MOVE_INTO' });
  });

  /* The days arrive whether or not the balance can afford them, so the type has to be one
     that may go past its allowance on a document. FR 32a. */
  it('and has to be one whose allowance may be exceeded', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await expect(
      requests.reclassify(asAnHrOfficer(), id, {
        toLeaveTypeId: compassionateId,
        certificateId: await aCertificate(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_TYPE_TO_MOVE_INTO' });
  });
});

/* ------------------------------------------------------------- who, and from what state */

describe('who moves the days, and out of what', () => {
  it('is HR, and neither the person nor their manager', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    for (const actor of [asTheEmployee(), asTheirManager()]) {
      await expect(
        requests.reclassify(actor, id, {
          toLeaveTypeId: sickId,
          certificateId: await aCertificate(),
        }),
      ).rejects.toThrow(NotAuthorised);
    }
  });

  /* Leave still being decided has taken no days, so there is nothing to move: it is
     withdrawn and asked for again as sick leave. */
  it('and leave that is not agreed cannot be moved at all', async () => {
    const { request } = await requests.submit(asTheEmployee(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: workingDaysAgo(5),
      to: workingDaysAgo(4),
      reason: 'Two days off',
      acknowledgesShortNotice: true,
    });

    await expect(
      requests.reclassify(asAnHrOfficer(), request.id, {
        toLeaveTypeId: sickId,
        certificateId: await aCertificate(),
      }),
    ).rejects.toMatchObject({ name: 'LeaveCannotBeMoved' });
  });
});

/* --------------------------------------------------------- and the schema holds it too */

describe('the pair, against a writer that never came through the service', () => {
  it('refuses one side of a move on its own', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
             (employee_id, leave_type_id, leave_year_id, entry_type, days, reason,
              leave_request_id, correlation_id)
         VALUES ($1, $2, $3, 'RECLASSIFICATION', 1, 'one side only', $4, gen_random_uuid())`,
        [people.officer, annualId, y2026.id, id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_correlates_a_pair' });
  });

  it('and refuses a pair that does not sum to nought', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, reason,
            leave_request_id, correlation_id)
       SELECT $1, leave_type, $3, 'RECLASSIFICATION', days, 'lopsided', $4,
              '0b5f1d3e-0000-4000-8000-00000000abcd'::uuid
         FROM (VALUES ($2::bigint, 2::numeric), ($5::bigint, -1::numeric))
                  AS moved (leave_type, days)`,
      [people.officer, annualId, y2026.id, id, sickId],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_correlates_a_pair',
    });

    await admin.query('ROLLBACK');
  });

  /** And nothing anywhere may write a `RECLASSIFICATION` without a correlation at all. */
  it('and refuses a movement between types that names no other side', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
             (employee_id, leave_type_id, leave_year_id, entry_type, days, reason,
              leave_request_id)
         VALUES ($1, $2, $3, 'RECLASSIFICATION', 1, 'no other side', $4)`,
        [people.officer, annualId, y2026.id, id],
      ),
    ).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_only_a_reclassification_correlates',
    });
  });
});
