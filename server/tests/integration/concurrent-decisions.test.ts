import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  LeaveAlreadyDecided,
  validateDecision,
} from '../../src/features/leave-request/leave-decision.js';
import {
  type LeaveRequest,
  type NewLeaveRequest,
  versionOf,
} from '../../src/features/leave-request/leave-request.js';
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
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * Two approvers deciding one request at once. NFR DAT 02, §8.1. LMS 326.
 *
 * The HR desk has two officers on it, so two people can be looking at the same request and
 * both be entitled to answer it. What this suite holds is that one of them does:
 *
 *   **The row is held still.** The decision transaction takes the request itself as well as
 *   the balance, so a second writer waits rather than reading a row that is about to move.
 *
 *   **The loser is told what happened**, by name, rather than being told they are not the
 *   desk this request is waiting at — which is what the desk policy would have said.
 *
 *   **The days move once.** One DEDUCTION, one decision at each desk, and a balance that
 *   says six taken rather than twelve.
 *
 * ../unit/leave-request.test.ts proves the rule itself against invented rows. Only real
 * transactions can show two of them arriving together.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('concurrent decisions integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let decisions: LeaveDecisionRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six the other request suites use. */
const FROM = '2026-03-02';
const TO = '2026-03-10';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  decisions = new LeaveDecisionRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    new LeaveRequestRepository(db),
    decisions,
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    /** FR 32c, LMS 507. */
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    /** FR 49, LMS 327. */
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );
});

beforeEach(async () => {
  /** FR 18, LMS 308. The fixture days are months behind today. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

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
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, ' +
      'leave_request_routing, leave_request_withdrawal, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

function aRequest(): NewLeaveRequest {
  return {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: FROM,
    to: TO,
    reason: 'My sister is getting married',
    /** FR 17, LMS 307. */
    acknowledgesShortNotice: true,
  };
}

/** Adwoa's request, walked as far as the HR desk — where two officers can both answer it. */
async function waitingOnHr(): Promise<LeaveRequest> {
  const { request } = await requests.submit(asAdwoa(), aRequest());

  const atHr = await requests.approve(asTheirManager(), request.id);

  expect(atHr.request.awaitingApprovalFrom).toBe('HR');

  return atHr.request;
}

async function balanceNow(): Promise<{ taken: number; pending: number }> {
  const balance = await balances.forOne(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
  });

  return { taken: balance.taken, pending: balance.pending };
}

async function deductions(): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'DEDUCTION'",
  );

  return Number(rows[0].count);
}

/** Adwoa Frimpong, whose leave this is. */
function asAdwoa() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Kofi Boateng, her team lead — the `MANAGER` desk. */
function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** Ama, the head of HR. */
function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

/** Efua, the other officer at the same desk. */
function asTheOtherOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/* ------------------------------------------------- both buttons, at the same instant */

describe('two approvers deciding one request at once', () => {
  /**
   * The story, and the failure it exists to prevent. NFR DAT 02.
   *
   * Both officers hold the same queue row and both press approve. Without the lock and the
   * question asked inside it, both read a request nobody had decided, both walked the chain
   * to its end, and both posted a DEDUCTION — six days off the balance twice for one week
   * of leave.
   */
  it('lets exactly one of them through', async () => {
    const request = await waitingOnHr();

    const outcomes = await Promise.allSettled([
      requests.approve(asTheHeadOfHr(), request.id),
      requests.approve(asTheOtherOfficer(), request.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    const refused = outcomes.find((outcome) => outcome.status === 'rejected');

    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(LeaveAlreadyDecided);

    /** The story's fourth criterion, from the three directions it can be asked from. */
    expect(await deductions()).toBe(1);
    expect(await balanceNow()).toEqual({ taken: 6, pending: 0 });
    expect(await decisions.forRequest(request.id)).toHaveLength(2);
  });

  /**
   * And the loser is told who answered it, not that they are not the desk.
   *
   * The losing transaction, deterministically: the request as it stood before the other
   * officer decided, which is exactly the row a screen drawn a second earlier is holding.
   */
  it('and the one that lost is told who got there first, and by what', async () => {
    const request = await waitingOnHr();

    await requests.approve(asTheOtherOfficer(), request.id);

    const refusal: unknown = await requests
      .approve(asTheHeadOfHr(), request.id, undefined, versionOf(request))
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(LeaveAlreadyDecided);

    const told = refusal as LeaveAlreadyDecided;

    expect(told.code).toBe('ALREADY_DECIDED');
    expect(told.decided?.onBehalfOf).toBe('HR');
    expect(told.message).toContain('approved it');
    expect(told.message).toContain('has not been recorded');

    /** And nothing of theirs is on the record. */
    expect(await decisions.forRequest(request.id)).toHaveLength(2);
    expect(await deductions()).toBe(1);
  });

  /* And a rejection racing an approval is the same race. The days come back once and the
     desk that lost writes nothing. */
  it('and an approval and a rejection arriving together settle it once', async () => {
    const request = await waitingOnHr();

    const outcomes = await Promise.allSettled([
      requests.approve(asTheHeadOfHr(), request.id),
      requests.refuse(asTheOtherOfficer(), request.id, 'The desk cannot be empty that week.'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const settled = await requests.byId(system, request.id);
    const balance = await balanceNow();

    expect(['APPROVED', 'REFUSED']).toContain(settled.status);
    expect(balance.pending).toBe(0);
    expect(balance.taken).toBe(settled.status === 'APPROVED' ? 6 : 0);
  });
});

/* ------------------------------------------------------- the row, held still. §8.1 */

describe('the request a decision is being taken on', () => {
  /**
   * Is held still for the length of the transaction. NFR DAT 02, §8.1.
   *
   * Asserted by holding it from another connection: the decision waits at
   * `LeaveRequestRepository.holdStill` and finishes only once that transaction lets go. Read
   * without `FOR UPDATE` it would go straight past, which is what this fails on.
   */
  it('is locked at the start of the decision transaction', async () => {
    const request = await waitingOnHr();

    const holder = new Client({ connectionString: testDatabaseUrl });
    await holder.connect();

    const finished: number[] = [];

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM leave_request WHERE id = $1 FOR UPDATE', [request.id]);

      const deciding = requests.approve(asTheOtherOfficer(), request.id).then((decided) => {
        finished.push(Date.now());

        return decided;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      /** Still waiting, three hundred milliseconds in. */
      expect(finished).toEqual([]);

      const released = Date.now();
      await holder.query('COMMIT');

      const decided = await deciding;

      expect(decided.request.status).toBe('APPROVED');
      expect(finished[0]).toBeGreaterThanOrEqual(released);
    } finally {
      await holder.end();
    }
  });
});

/* ------------------------------------------- the version a screen holds. NFR DAT 02 */

describe('the version a decision is sent with', () => {
  /* Optimistic locking, from the outside: the row's own `updated_at`, handed out with the
     queue and handed back with the decision. */
  it('lets a decision through where the request still stands as it was seen', async () => {
    const request = await waitingOnHr();

    const decided = await requests.approve(
      asTheOtherOfficer(),
      request.id,
      undefined,
      versionOf(request),
    );

    expect(decided.request.status).toBe('APPROVED');
    /** And the row moved, so the version it was decided at is spent. */
    expect(versionOf(decided.request)).not.toBe(versionOf(request));
  });

  /* And a version from before the manager decided is refused, even though this officer is
     the desk the request is now sitting on. What they were looking at was the earlier row. */
  it('and refuses one sent from a screen the request has moved on from', async () => {
    const { request } = await requests.submit(asAdwoa(), aRequest());

    await requests.approve(asTheirManager(), request.id);

    await expect(
      requests.approve(asTheOtherOfficer(), request.id, undefined, versionOf(request)),
    ).rejects.toBeInstanceOf(LeaveAlreadyDecided);

    /** Refused before anything was written: the desk is still waiting for an answer. */
    const waiting = await requests.byId(system, request.id);

    expect(waiting.awaitingApprovalFrom).toBe('HR');
    expect(await decisions.forRequest(request.id)).toHaveLength(1);
  });

  /* And no version at all is not a stale one. A caller with no screen behind it — a script,
     a test, the walkthrough — is answered by the lock and by the desk's own decision. */
  it('and lets a decision with no version through', async () => {
    const request = await waitingOnHr();

    await expect(requests.approve(asTheOtherOfficer(), request.id)).resolves.toMatchObject({
      request: { status: 'APPROVED' },
    });
  });
});

/* ------------------------------------------------- and the schema says it too. §8.1 */

/**
 * One decision to a desk, on every connection. NFR DAT 02, LMS 326.
 *
 * `leave_request_decision_once_per_desk` has held this since every-stage-must-approve. What
 * this story added is the sentence it comes back as, so a second decision that got past the
 * lock is refused in the words the loser of a race is refused in rather than as an index.
 */
describe('a second decision at a desk that has answered', () => {
  it('is refused by the database, in the words a person reads', async () => {
    const request = await waitingOnHr();

    await requests.approve(asTheOtherOfficer(), request.id);

    await expect(
      decisions.record(
        asTheHeadOfHr(),
        validateDecision({
          leaveRequestId: request.id,
          action: 'APPROVE',
          onBehalfOf: 'HR',
          comment: null,
        }),
      ),
    ).rejects.toBeInstanceOf(LeaveAlreadyDecided);

    expect(await decisions.forRequest(request.id)).toHaveLength(2);
  });
});
