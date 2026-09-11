import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { NewLeaveRequest } from '../../src/features/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { UndeliveredNotices } from '../../src/features/notification/delivery.job.js';
import { ATTEMPTS_ALLOWED, backoffAfter } from '../../src/features/notification/delivery.js';
import { recordingDenials } from '../support/recording-denials.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { recordingNotices } from '../support/recording-notices.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * A failed notification is retried rather than dropped. FR 59, §7.1. LMS 331.
 *
 * ../unit/delivery.test.ts proves the arithmetic of the backoff. What needs a server is the
 * story's two criteria:
 *
 *   **Failed sends are retried with backoff.** Which means the notice is left due rather
 *   than finished, that a run picks it up, that each failure pushes the next attempt further
 *   out, and that the retrying eventually stops rather than writing to a dead mailbox for
 *   ever. Every one of those is a column the table holds and a trigger defends.
 *
 *   **A mail failure never rolls back a business transaction.** The leave stays approved and
 *   the days stay moved through six consecutive failures, and the retry job cannot reach a
 *   balance, a ledger or a transition to undo any of it.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('delivery integration fixtures');
const draining = theSystem('undelivered notices');

const denials = recordingDenials();
const guard = new Guard(denials);
const undelivered = recordingNotices();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let notifications: NotificationService;
let notices: NotificationRepository;
let retries: UndeliveredNotices;
let mailer: RecordingMailer;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six that the other suites use. */
const FROM = '2026-03-02';
const TO = '2026-03-10';

const REFUSED_BY_SMTP = 'connect ECONNREFUSED 127.0.0.1:1025';

/** The moment a run pretends to be at, so a backoff is asserted rather than waited out. */
const NOW = new Date('2026-03-01T09:00:00Z');

const secondsAfter = (later: Date, earlier: Date): number =>
  Math.round((later.getTime() - earlier.getTime()) / 1000);

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  notices = new NotificationRepository(db);
  mailer = recordingMailer();
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);
  notifications = new NotificationService(notices, mailer, guard, undelivered);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    new LeaveRequestRepository(db),
    new LeaveDecisionRepository(db),
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    /** FR 32c, LMS 507. */
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    notifications,
  );

  retries = new UndeliveredNotices(notifications);
});

beforeEach(async () => {
  /* FR 18, LMS 308. The fixture week is months behind today, as in every leave suite here. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'approval_delegation, attachment_access, attachment_download_link, leave_request_reclassification, leave_request_attachment, leave_request_decision, ' +
      'leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
  );

  denials.clear();
  undelivered.clear();
  mailer.clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;

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
  /* Closes, and nothing else. `databaseForThisFile` drops this file's database next, so
     tidying its rows here is work that cannot matter — and a statement that throws leaves a
     connection open for that drop's FORCE to terminate, which surfaces as an unhandled 57P01. */
  await db?.destroy();
  await admin?.end();
});

function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function aRequest(overrides: Partial<NewLeaveRequest> = {}): NewLeaveRequest {
  return {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: FROM,
    to: TO,
    reason: 'My sister is getting married',
    acknowledgesShortNotice: true,
    ...overrides,
  };
}

async function submit(): Promise<string> {
  return (await requests.submit(asThemselves(), aRequest())).request.id;
}

/** Approves at both desks, with the mail server refusing the final message. FR 59. */
async function approveWithTheMailServerDown(): Promise<string> {
  const id = await submit();
  await requests.approve(asTheirManager(), id);

  mailer.failNext(new Error(REFUSED_BY_SMTP));
  await requests.approve(asOfficer(), id);
  mailer.clear();

  return id;
}

/** The notice about the approval, read back off the table. */
async function theApproval() {
  const theirs = await notices.forEmployee(people.officer);
  const notice = theirs.find((one) => one.event === 'APPROVED');

  expect(notice).toBeDefined();
  return notice!;
}

/** Moves everything that is due back in time, so the next run finds it due. */
async function makeItDue(): Promise<void> {
  await admin.query(
    'UPDATE notification SET email_next_attempt_at = $1 WHERE email_next_attempt_at IS NOT NULL',
    [NOW],
  );
}

/* --------------------------------------------- a failed send is left due, not finished */

describe('a notification the mail server refused', () => {
  it('is written down, with the failure and the next attempt on it', async () => {
    await approveWithTheMailServerDown();

    const notice = await theApproval();

    expect(notice.emailedAt).toBeNull();
    expect(notice.emailFailure).toBe(REFUSED_BY_SMTP);
    expect(notice.emailAttempts).toBe(1);
    expect(notice.emailNextAttemptAt).toBeInstanceOf(Date);
    expect(notice.emailGaveUpAt).toBeNull();
  });

  /* A minute after the failure, which is the first wait in the schedule. */
  it('and the attempt is due one backoff after the one that failed', async () => {
    await approveWithTheMailServerDown();

    const notice = await theApproval();

    expect(secondsAfter(notice.emailNextAttemptAt!, notice.createdAt)).toBeGreaterThanOrEqual(
      backoffAfter(1) - 5,
    );
    expect(secondsAfter(notice.emailNextAttemptAt!, notice.createdAt)).toBeLessThanOrEqual(
      backoffAfter(1) + 5,
    );
  });

  /* The one place an operator sees it before the retry succeeds. */
  it('and the failure says which attempt it was and when the next is', async () => {
    await approveWithTheMailServerDown();

    expect(undelivered.last()).toMatchObject({
      event: 'APPROVED',
      stage: 'email',
      because: REFUSED_BY_SMTP,
      attempt: 1,
    });
    expect(undelivered.last()?.tryingAgainAt).toBeInstanceOf(Date);
  });

  /* A notice that went first time is finished, and a run must never pick it up again. */
  it('while one that went is finished and is never due again', async () => {
    await submit();

    const [notice] = await notices.forEmployee(people.officer);

    expect(notice.emailedAt).toBeInstanceOf(Date);
    expect(notice.emailAttempts).toBe(1);
    expect(notice.emailNextAttemptAt).toBeNull();

    expect((await retries.run(draining)).attempted).toEqual([]);
  });
});

/* ------------------------------------------------------------------ and it is retried */

describe('draining what did not send', () => {
  it('sends it again, and the person finally gets their email', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    const run = await retries.run(draining, NOW);

    expect(run.attempted).toHaveLength(1);
    expect(run.attempted[0]).toMatchObject({ attempt: 2, emailed: true, gaveUp: false });

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.last().to).toBe('adwoa.frimpong@rematholdings.com');
  });

  /* The same words, because a notice is a record of what somebody was told and the retry
     re-sends it rather than composing it again. */
  it('and it is the message that was written, not a new one', async () => {
    await approveWithTheMailServerDown();
    const notice = await theApproval();

    await makeItDue();
    await retries.run(draining, NOW);

    expect(mailer.last().subject).toBe(notice.subject);
    expect(mailer.last().text).toBe(notice.body);
  });

  it('and the row records the delivery it eventually got', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();
    await retries.run(draining, NOW);

    const notice = await theApproval();

    expect(notice.emailedAt).toBeInstanceOf(Date);
    expect(notice.emailAttempts).toBe(2);
    expect(notice.emailNextAttemptAt).toBeNull();
    expect(notice.emailGaveUpAt).toBeNull();

    /* The failure stays beside the delivery. Two attempts is the answer to "why was it
       late", and clearing it would throw that away. */
    expect(notice.emailFailure).toBe(REFUSED_BY_SMTP);
  });

  it('and nothing is left due afterwards', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    await retries.run(draining, NOW);

    expect((await retries.run(draining, NOW)).attempted).toEqual([]);
  });

  /* Nothing is sent early. A backoff that a run ignored would be no backoff at all. */
  it('and one that is not due yet is left alone', async () => {
    await approveWithTheMailServerDown();

    const run = await retries.run(draining, NOW);

    expect(run.due).toBe(0);
    expect(run.attempted).toEqual([]);
    expect(mailer.sent).toEqual([]);
  });
});

/* --------------------------------------------------------------- each failure waits longer */

describe('a mail server that stays down', () => {
  it('pushes the next attempt further out every time', async () => {
    await approveWithTheMailServerDown();

    const waits: number[] = [];

    for (let attempt = 2; attempt < ATTEMPTS_ALLOWED; attempt += 1) {
      await makeItDue();
      mailer.failNext(new Error(REFUSED_BY_SMTP));

      const run = await retries.run(draining, NOW);

      expect(run.attempted[0]).toMatchObject({ attempt, emailed: false, gaveUp: false });
      waits.push(secondsAfter(run.attempted[0].tryingAgainAt!, NOW));
    }

    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[0]).toBe(backoffAfter(2));
    expect(waits.at(-1)).toBe(backoffAfter(ATTEMPTS_ALLOWED - 1));
  });

  /* And then it stops, rather than writing to a dead mailbox for ever. */
  it('and gives up after the attempts it is allowed', async () => {
    await approveWithTheMailServerDown();

    for (let attempt = 2; attempt <= ATTEMPTS_ALLOWED; attempt += 1) {
      await makeItDue();
      mailer.failNext(new Error(REFUSED_BY_SMTP));
      await retries.run(draining, NOW);
    }

    const notice = await theApproval();

    expect(notice.emailAttempts).toBe(ATTEMPTS_ALLOWED);
    expect(notice.emailedAt).toBeNull();
    expect(notice.emailNextAttemptAt).toBeNull();
    expect(notice.emailGaveUpAt).toBeInstanceOf(Date);
  });

  it('and one it has given up on is never picked up again', async () => {
    await approveWithTheMailServerDown();

    for (let attempt = 2; attempt <= ATTEMPTS_ALLOWED; attempt += 1) {
      await makeItDue();
      mailer.failNext(new Error(REFUSED_BY_SMTP));
      await retries.run(draining, NOW);
    }

    await makeItDue();
    mailer.clear();

    expect((await retries.run(draining, NOW)).attempted).toEqual([]);
    expect(mailer.sent).toEqual([]);
  });

  /* The in-app half was never at risk. The bell has said so since the notice was written,
     which is why losing the email is a courtesy rather than the news. */
  it('while the notice itself has been readable the whole time', async () => {
    await approveWithTheMailServerDown();

    const notice = await theApproval();

    expect(notice.readAt).toBeNull();
    expect(notice.body).toContain('approved');
    expect(await notifications.unreadCountFor(asThemselves(), people.officer)).toBeGreaterThan(0);
  });
});

/* --------------------------------------- and none of it touches the thing it describes */

describe('a mail failure rolls nothing back', () => {
  it('the leave stays approved through every failed attempt', async () => {
    const id = await approveWithTheMailServerDown();

    for (let attempt = 2; attempt <= ATTEMPTS_ALLOWED; attempt += 1) {
      await makeItDue();
      mailer.failNext(new Error(REFUSED_BY_SMTP));
      await retries.run(draining, NOW);
    }

    const { rows } = await admin.query<{ status: string; desk: string | null }>(
      'SELECT status, awaiting_approval_from AS desk FROM leave_request WHERE id = $1',
      [id],
    );

    expect(rows[0]).toEqual({ status: 'APPROVED', desk: null });
  });

  it('and so do the days it moved', async () => {
    await approveWithTheMailServerDown();

    const before = await balances.forEmployee(asThemselves(), people.officer, y2026.id);

    await makeItDue();
    mailer.failNext(new Error(REFUSED_BY_SMTP));
    await retries.run(draining, NOW);

    expect(await balances.forEmployee(asThemselves(), people.officer, y2026.id)).toEqual(before);
  });

  /* And the ledger, which is the record the balance is checked against. */
  it('and the retry writes no ledger entry at all', async () => {
    await approveWithTheMailServerDown();

    const entriesBefore = await admin.query('SELECT count(*) FROM leave_ledger_entry');

    await makeItDue();
    await retries.run(draining, NOW);

    expect((await admin.query('SELECT count(*) FROM leave_ledger_entry')).rows).toEqual(
      entriesBefore.rows,
    );
  });

  /* A run that fails every send still returns, so a scheduler is never left holding one. */
  it('and a run against a dead mail server does not throw', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();
    mailer.failNext(new Error(REFUSED_BY_SMTP));

    await expect(retries.run(draining, NOW)).resolves.toMatchObject({ claimedElsewhere: 0 });
  });
});

/* ------------------------------------------------------- and two runs do not double send */

describe('two runs at once', () => {
  it('send the message once between them', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    const [first, second] = await Promise.all([
      retries.run(draining, NOW),
      retries.run(draining, NOW),
    ]);

    expect([...first.attempted, ...second.attempted]).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  /* The claim is the mechanism, asserted on its own because which of the two runs above
     loses the race is a matter of timing: the second may find nothing due yet, or may find
     the notice and lose the claim. Only one of them can ever take it. */
  it('because the attempt count is taken before the send, and taken once', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    const notice = await theApproval();

    expect(await notices.claimForAnotherTry(notice.id, notice.emailAttempts, NOW)).toBeDefined();
    expect(await notices.claimForAnotherTry(notice.id, notice.emailAttempts, NOW)).toBeUndefined();
  });

  /* A run that dies between claiming and sending leaves the notice due again rather than
     one nobody will ever look at, which is what claiming forward rather than clearing buys. */
  it('and a claim that is never sent comes back round', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    const notice = await theApproval();
    await notices.claimForAnotherTry(notice.id, notice.emailAttempts, NOW);

    await makeItDue();

    expect((await retries.run(draining, NOW)).attempted).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });
});

/* --------------------------------------------------------- and it is the company's post */

describe('who may drain it', () => {
  it('HR, who is who asks when the mail server comes back', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    expect((await retries.run(asOfficer(), NOW)).attempted).toHaveLength(1);
  });

  /* Not the person whose post it is. Reading their own notices is `read` and is untouched. */
  it('and not the person it was written to', async () => {
    await approveWithTheMailServerDown();
    await makeItDue();

    await expect(retries.run(asThemselves(), NOW)).rejects.toThrow(NotAuthorised);

    expect(await notifications.forEmployee(asThemselves(), people.officer)).not.toEqual([]);
  });

  it('and the refusal is recorded', async () => {
    await expect(retries.run(asThemselves(), NOW)).rejects.toThrow(NotAuthorised);

    expect(denials.last()).toMatchObject({ resource: 'notification', action: 'resend' });
  });
});
