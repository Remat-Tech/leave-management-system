import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { calendarDateIn } from '../../src/shared/time.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  DocumentationNotAttached,
  NotEnoughDays,
} from '../../src/features/leave-request/leave-request.js';
import { BalanceOverdrawn } from '../../src/features/balance/balance.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { AttachmentService } from '../../src/features/leave-request/attachment.service.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { LedgerRepository } from '../../src/features/balance/ledger.db.js';
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
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * Certified sickness beyond the three days. FR 32a, FR 32b, FR 33, §8.6b. LMS 312.
 *
 * ../unit/leave-request.test.ts proves the arithmetic of which days are past the allowance;
 * ../integration/required-documentation.test.ts proves the certificate has to arrive with the
 * request. What needs a database here is what the ledger ends up saying —
 *
 *   **The excess is tagged where the days moved**, on the RESERVATION and on the DEDUCTION
 *   that follows it, so "how much certified sickness was there" is a question the account
 *   answers rather than one recomputed from a balance that has since moved.
 *
 *   **The sick balance goes below nought and stays there.** No clamp anywhere.
 *
 *   **And nothing lands in the annual balance.** FR 33, which is the failure this story is
 *   written against: genuine illness quietly eating somebody's holiday.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('certified sick leave fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let attachments: AttachmentService;
let storage: InMemoryStorage;
let requests: LeaveRequestService;
let balances: BalanceService;
let ledger: LedgerRepository;
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
  const linkRepository = new AttachmentLinkRepository(db);

  ledger = new LedgerRepository(db);
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
    /** FR 49, LMS 327. */
    delegationService(db, guard),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  storage = new InMemoryStorage();

  attachments = new AttachmentService(
    guard,
    attachmentRepository,
    linkRepository,
    requestRepository,
    employees,
    types,
    organisation,
    delegationService(db, guard),
    storage,
    new SignatureScanner(),
  );
});

beforeEach(async () => {
  await clear();
  storage.reset();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0].id;

  await admin.query('SELECT ensure_statutory_approval_chains()');

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
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request_draft, leave_request',
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

/** The nth working day from today. FR 21 — a calendar offset lands fixtures on a Saturday. */
function workingDaysAhead(offset: number): string {
  const day = new Date();

  for (let counted = 0; counted < offset;) {
    day.setUTCDate(day.getUTCDate() + 1);

    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      counted += 1;
    }
  }

  return calendarDateIn(day, 'UTC');
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

/** Five working days of sick leave against an allowance of three. FR 32a. */
function fiveSickDays(evidence: string[] = []) {
  return {
    employeeId: people.officer,
    leaveTypeId: sickId,
    from: workingDaysAhead(15),
    to: workingDaysAhead(19),
    reason: 'Off sick',
    evidence,
  };
}

/** The same five days, certificate and all. Two of them are past the allowance. */
async function fiveDaysWithACertificate() {
  const certificate = await attachments.hold(asTheEmployee(), people.officer, aFile());

  return requests.submit(asTheEmployee(), fiveSickDays([certificate.id]));
}

/** Sick leave's chain is manager then HR. FR 38a. */
async function approve(requestId: string): Promise<void> {
  await requests.approve(asTheirManager(), requestId);
  await requests.approve(asAnHrOfficer(), requestId);
}

async function entriesFor(leaveTypeId: string) {
  return ledger.entriesFor({ employeeId: people.officer, leaveTypeId, leaveYearId: y2026.id });
}

/** Certified days actually spent: what the DEDUCTIONs took, less what came back. FR 32a. */
async function certifiedSicknessTaken(): Promise<number> {
  return (await entriesFor(sickId)).reduce((total, one) => {
    if (one.entryType === 'DEDUCTION') {
      return total + one.certifiedDays;
    }

    return one.entryType === 'RECALCULATION' ? total - one.certifiedDays : total;
  }, 0);
}

async function availableIn(leaveTypeId: string): Promise<number> {
  return (
    await balances.forOne(system, {
      employeeId: people.officer,
      leaveTypeId,
      leaveYearId: y2026.id,
    })
  ).available;
}

/* -------------------------------------------- past the allowance, FR 32a, §8.6b */

describe('sick leave past the three days', () => {
  /**
   * The story's first criterion. The allowance is a documentation threshold and not a cap,
   * so five days against three left is allowed — with the certificate on it.
   */
  it('goes through with a clean certificate on it', async () => {
    const { request, balance } = await fiveDaysWithACertificate();

    expect(request.status).toBe('SUBMITTED');
    expect(request.days).toBe(5);
    expect(balance.available).toBe(-2);
  });

  /**
   * The second, and the distinction the story exists to draw. Somebody four days into a
   * three day allowance is not short of days — the days are not the question — they are
   * short of a certificate, and the two refusals send them to different places.
   */
  it('and without one is a documentation refusal rather than a balance one', async () => {
    const refusal = await requests.submit(asTheEmployee(), fiveSickDays()).catch((error) => error);

    expect(refusal).toBeInstanceOf(DocumentationNotAttached);
    expect(refusal).not.toBeInstanceOf(NotEnoughDays);
    expect(refusal).not.toBeInstanceOf(BalanceOverdrawn);
    expect(refusal.code).toBe('DOCUMENTATION_REQUIRED');
    expect(refusal.grounds).toContain('PAST_THE_ALLOWANCE');
  });

  /* §8.6b: "sick balances go negative, and that is correct". There is no clamp anywhere. */
  it('and the balance goes below nought and stays there', async () => {
    const { request } = await fiveDaysWithACertificate();

    expect(await availableIn(sickId)).toBe(-2);

    await approve(request.id);

    expect(await availableIn(sickId)).toBe(-2);
  });

  /* And going further only takes it further, which is what makes it a threshold. */
  it('and the next absence is asked for against a balance already spent', async () => {
    const first = await attachments.hold(asTheEmployee(), people.officer, aFile('one.pdf'));
    await requests.submit(asTheEmployee(), fiveSickDays([first.id]));

    const second = await attachments.hold(asTheEmployee(), people.officer, aFile('two.pdf'));
    const { request } = await requests.submit(asTheEmployee(), {
      ...fiveSickDays([second.id]),
      from: workingDaysAhead(22),
      to: workingDaysAhead(23),
    });

    /* Nothing was left, so both of these days are past the allowance. */
    expect(request.certifiedDays).toBe(2);
    expect(await availableIn(sickId)).toBe(-4);
  });
});

/* ------------------------------------------- the tag in the ledger, FR 32a. LMS 312 */

describe('the days past the allowance, in the account', () => {
  /**
   * The story's third criterion. Two of the five days stood on the certificate, and the
   * entry that held them says so — which is what makes certified sickness a thing the
   * ledger can be asked about rather than a figure inferred from a balance that has moved.
   */
  it('are counted on the entry that held them', async () => {
    const { request, entry } = await fiveDaysWithACertificate();

    expect(request.certifiedDays).toBe(2);
    expect(entry.entryType).toBe('RESERVATION');
    expect(entry.days).toBe(-5);
    expect(entry.certifiedDays).toBe(2);
  });

  /* And on the entry that spends them, which is the one that says the leave was taken. */
  it('and on the deduction that turns them into days taken', async () => {
    const { request } = await fiveDaysWithACertificate();

    await approve(request.id);

    const deduction = (await entriesFor(sickId)).find((one) => one.entryType === 'DEDUCTION');

    expect(deduction).toMatchObject({ days: -5, certifiedDays: 2 });
  });

  /* Days inside the allowance are ordinary sick leave and are tagged as nothing. */
  it('and three days by somebody who has taken none are certified as nothing', async () => {
    const { request, entry } = await requests.submit(asTheEmployee(), {
      ...fiveSickDays(),
      to: workingDaysAhead(17),
    });

    expect(request.days).toBe(3);
    expect(request.evidenceRequired).toBe(false);
    expect(request.certifiedDays).toBe(0);
    expect(entry.certifiedDays).toBe(0);
  });

  /**
   * FR 47, LMS 324. What was given back was certified too, so what the year says was
   * certified goes back to nothing.
   *
   * Read off the DEDUCTION less the RECALCULATION rather than off every row, for the reason
   * the ledger's own note gives about `days`: a RESERVATION and the DEDUCTION that follows
   * it are not ten days, and they are not four certified ones either.
   */
  it('and come back with the days when the leave is taken off the books', async () => {
    const { request } = await fiveDaysWithACertificate();

    await approve(request.id);
    await requests.askToWithdraw(asTheEmployee(), request.id, 'I was not ill after all');
    await requests.grantWithdrawal(asAnHrOfficer(), request.id, 'Recorded in error');

    expect(await certifiedSicknessTaken()).toBe(0);
    expect(await availableIn(sickId)).toBe(3);
  });

  /* The days are given back before the request is decided, and so is the tag on them. */
  it('and come back on the release when the request is withdrawn undecided', async () => {
    const { request } = await fiveDaysWithACertificate();

    const { entry } = await requests.withdraw(asTheEmployee(), request.id);

    expect(entry).toMatchObject({ entryType: 'RELEASE', days: 5, certifiedDays: 2 });
  });
});

/* --------------------------------------------------------- never annual leave, FR 33 */

describe('certified sickness and the annual balance', () => {
  /**
   * The story's last criterion, and the failure it is written against: genuine illness
   * quietly coming out of somebody's holiday. Five days of sick leave over the allowance
   * moves the sick balance to −2 and leaves twenty days of annual leave exactly where
   * they were.
   */
  it('never takes a day of it', async () => {
    const { request } = await fiveDaysWithACertificate();

    await approve(request.id);

    expect(await availableIn(sickId)).toBe(-2);
    expect(await availableIn(annualId)).toBe(20);

    const annual = await entriesFor(annualId);

    expect(annual.map((one) => one.entryType)).toEqual(['GRANT']);
  });

  /* FR 33, held by the column since the leave-type-rules migration rather than by a rule
     anybody has to remember. */
  it('because no leave type may be configured to', async () => {
    await expect(
      admin.query('UPDATE leave_type SET deducts_from_annual = TRUE WHERE code = $1', ['SICK']),
    ).rejects.toMatchObject({ constraint: 'leave_type_never_deducts_from_annual' });
  });
});

/* ------------------------------------------------------------------------ the schema */

describe('what the tables hold', () => {
  /* Frozen with the rest of the price, as `days` and `evidence_required` are. */
  it('refuses to reprice how many of a request’s days were certified', async () => {
    const { request } = await fiveDaysWithACertificate();

    await expect(
      admin.query('UPDATE leave_request SET certified_days = 0 WHERE id = $1', [request.id]),
    ).rejects.toMatchObject({ constraint: 'leave_request_says_what_it_said' });
  });

  /* FR 32a is `exceedable_with_document` and nothing else. Design principle 5. */
  it('refuses certified days on a type whose allowance is a cap', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, certified_days, reason,
            leave_request_id)
         VALUES ($1, $2, $3, 'RESERVATION', '-5.00', 2, 'past nothing', NULL)`,
        [people.officer, annualId, y2026.id],
      ),
    ).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_certified_days_need_an_exceedable_allowance',
    });
  });

  /* What somebody is owed is not certified by anything. */
  it('refuses certified days on a movement no request caused', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, certified_days, reason)
         VALUES ($1, $2, $3, 'GRANT', '5.00', 1, 'a certified grant')`,
        [people.officer, sickId, y2026.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_only_a_request_certifies' });
  });

  /* Part of the movement rather than beside it. */
  it('refuses more certified days than the movement moved', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, certified_days, reason)
         VALUES ($1, $2, $3, 'ADJUSTMENT', '5.00', 6, 'more than all of it')`,
        [people.officer, sickId, y2026.id],
      ),
    ).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_certified_days_are_part_of_it',
    });
  });

  /* And days past an allowance are days a certificate was asked for. FR 13, FR 32a. */
  it('refuses a request with certified days that nothing was asked of', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_request
           (employee_id, leave_type_id, leave_year_id, start_date, end_date, reason,
            evidence_required, certified_days, counting_basis, days, calendar_days, status,
            awaiting_approval_from)
         VALUES ($1, $2, $3, $4, $4, 'Off sick', FALSE, 1, 'WORKING_DAYS', 1, 1, 'SUBMITTED',
                 'MANAGER')`,
        [people.officer, sickId, y2026.id, workingDaysAhead(30)],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_certified_days_stand_on_evidence' });
  });
});
