import { Client } from 'pg';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { ApproverRole } from '../../src/features/leave-type/approval-chain.js';
import type { NewLeaveRequest } from '../../src/features/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EmployeeService } from '../../src/features/employee/employee.service.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveReassignmentRepository } from '../../src/features/leave-request/reassignment.db.js';
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
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * Pending leave follows the reporting line. FR 07, §8.4. LMS 325.
 *
 * ../unit/reassignment.test.ts proves which requests a moved line carries, which is pure.
 * What needs a server:
 *
 *   **Whose queue the request is in.** The `MANAGER` desk resolves through
 *   `employee.manager_id`, so "it followed me" is a claim about which of two people the same
 *   unchanged column now means.
 *
 *   **The handover is on the record**, stamped with who and when by the trigger.
 *
 *   **A move nobody decided is still a move the schema permits.**
 *   `leave_request_records_its_decision` refuses a request that changed desks with nothing to
 *   explain it, and a reassignment is the second thing that explains one.
 *
 *   **Approvals already given stand**, asserted against the decision rows.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('reassignment integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let employees: EmployeeService;
let balances: BalanceService;
let reassignments: LeaveReassignmentRepository;
let routing: LeaveRoutingRepository;
let decisions: LeaveDecisionRepository;
let notices: NotificationRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six the rest of the suite uses. */
const FROM = '2026-03-02';
const TO = '2026-03-10';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employeeRepository = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  routing = new LeaveRoutingRepository(db);
  reassignments = new LeaveReassignmentRepository(db);
  decisions = new LeaveDecisionRepository(db);
  notices = new NotificationRepository(db);
  balances = new BalanceService(
    new BalanceRepository(db),
    guard,
    employeeRepository,
    new Transactions(db),
  );
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employeeRepository,
    types,
    yearRepository,
    new LeaveRequestRepository(db),
    decisions,
    routing,
    new WithdrawalRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    /** FR 49, LMS 327. */
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(notices, recordingMailer(), guard),
  );

  /** The wiring the story is about: the employee door, holding the leave door. FR 07. */
  employees = new EmployeeService(
    employeeRepository,
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    requests,
    { domains: ['rematholdings.com'] },
  );
});

beforeEach(async () => {
  /* FR 18, LMS 308. The fixture days are months behind today, as every suite here widens
     the window for. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');
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
      'leave_request_attachment, leave_request_decision, leave_request_reassignment, ' +
      'leave_request_routing, leave_request_withdrawal, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

/** The chain annual leave is rewritten to, so nothing here reads a type code. FR 31. */
async function annualLeaveGoesTo(...chain: ApproverRole[]): Promise<void> {
  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);

  for (const [index, desk] of chain.entries()) {
    await admin.query(
      'INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role) ' +
        'VALUES ($1, $2, $3)',
      [annualId, index + 1, desk],
    );
  }

  await admin.query('COMMIT');
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

function aRequest(employeeId: string): NewLeaveRequest {
  return {
    employeeId,
    leaveTypeId: annualId,
    from: FROM,
    to: TO,
    reason: 'My sister is getting married',
    /** FR 17, LMS 307. The fixture week is behind today. */
    acknowledgesShortNotice: true,
  };
}

/** Adwoa, five levels down, whose line manager is Kofi in the fixtures. */
function asTheOfficer() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

function asTheTeamLead() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** Moves somebody's line, which is the one act every test here performs. FR 07. */
async function reportsTo(employeeId: string, managerId: string) {
  return employees.update(asTheHeadOfHr(), employeeId, { managerId });
}

/** What is waiting on one line manager, which is the queue the story is about. FR 40. */
async function waitingOn(managerId: string): Promise<string[]> {
  const rows = await new LeaveRequestRepository(db).awaiting({
    desks: ['MANAGER'],
    own: ['MANAGER'],
    managerIds: [managerId],
    delegated: [],
  });

  return rows.map((row) => row.id);
}

/* --------------------------------------------------- the request follows. FR 07 */

describe('a request waiting on a line manager who is replaced', () => {
  beforeEach(async () => {
    await twentyDaysFor(people.officer);
  });

  /**
   * The story's own sentence, read off the two queues.
   *
   * Nothing about the request changes — the desk is `MANAGER` before and after — and that is
   * the point: the desk resolves through the reporting line, so the same unchanged column
   * means a different person the moment the line moves.
   */
  it('leaves the old manager’s queue and arrives in the new one', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    expect(await waitingOn(people.teamLead)).toEqual([request.id]);
    expect(await waitingOn(people.opsManager)).toEqual([]);

    await reportsTo(people.officer, people.opsManager);

    expect(await waitingOn(people.teamLead)).toEqual([]);
    expect(await waitingOn(people.opsManager)).toEqual([request.id]);
  });

  it('and is still waiting on the same desk, undecided, holding its days', async () => {
    const { request, balance } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await reportsTo(people.officer, people.opsManager);

    const after = await requests.byId(asTheHeadOfHr(), request.id);

    expect(after.status).toBe('SUBMITTED');
    expect(after.awaitingApprovalFrom).toBe('MANAGER');
    expect(await decisions.forRequest(request.id)).toEqual([]);

    /* No days moved. Re-routing decides nothing, and the RESERVATION written at submission
       has held them throughout. */
    const now = await balances.forOne(system, {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
    });

    expect(now.available).toBe(balance.available);
    expect(now.pending).toBe(balance.pending);
  });

  /* The third criterion's first half, read back off the table it is written to. */
  it('and the handover is on the record, with who moved it and when', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await reportsTo(people.officer, people.opsManager);

    const [handover, ...rest] = await reassignments.forRequest(request.id);

    expect(rest).toEqual([]);
    expect(handover).toMatchObject({
      from: people.teamLead,
      to: people.opsManager,
      movedFrom: 'MANAGER',
      movedTo: 'MANAGER',
    });
    expect(handover.because).toContain('line manager changed');
    /* Stamped by the trigger from the transaction's actor, never by the writer. */
    expect(handover.recordedBy).not.toBe('not named by the writer');
    expect(handover.recordedAt).toBeInstanceOf(Date);
  });

  /* And the third criterion's second half. FR 59. */
  it('and the new manager is told it is now theirs to decide', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await reportsTo(people.officer, people.opsManager);

    const told = (await notices.forRequest(request.id)).filter(
      (notice) => notice.event === 'REASSIGNED',
    );

    expect(told).toHaveLength(1);
    expect(told[0].employeeId).toBe(people.opsManager);
    expect(told[0].subject).toContain('yours to decide');
    expect(told[0].body).toContain('Adwoa Frimpong');
  });

  /* Nobody else's leave is touched, which a re-route over the wrong set of rows would. */
  it('and nothing happens to leave belonging to somebody whose line did not move', async () => {
    await twentyDaysFor(people.partTimer);

    const mine = await requests.submit(asTheOfficer(), aRequest(people.officer));
    const theirs = await requests.submit(
      signedInAs(people.partTimer, { roles: ['EMPLOYEE'], isManager: false }),
      { ...aRequest(people.partTimer), from: '2026-04-06', to: '2026-04-10' },
    );

    await reportsTo(people.officer, people.opsManager);

    expect(await reassignments.forRequest(theirs.request.id)).toEqual([]);
    expect(await waitingOn(people.teamLead)).toEqual([theirs.request.id]);
    expect(await waitingOn(people.opsManager)).toEqual([mine.request.id]);
  });
});

/* ------------------------- approvals already given stand. FR 44, the second criterion */

describe('a request a stage has already decided', () => {
  beforeEach(async () => {
    await twentyDaysFor(people.officer);
  });

  /**
   * The second criterion, and the reason only stages waiting at the manager's desk move.
   *
   * Kofi approved and the request went on to HR. Adwoa's line moving afterwards changes who
   * would decide a manager's stage, and there is no manager's stage left to decide: his
   * approval is on the record, in his name, and the request is somebody else's to answer.
   */
  it('keeps the approval, in the name of whoever gave it, and does not move', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await requests.approve(asTheTeamLead(), request.id, 'Cover is arranged');

    await reportsTo(people.officer, people.opsManager);

    const after = await requests.byId(asTheHeadOfHr(), request.id);
    const [decision, ...rest] = await decisions.forRequest(request.id);

    expect(after.awaitingApprovalFrom).toBe('HR');
    expect(rest).toEqual([]);
    expect(decision).toMatchObject({ action: 'APPROVE', onBehalfOf: 'MANAGER' });
    expect(decision.decidedByEmployeeId).toBe(people.teamLead);
    expect(decision.comment).toBe('Cover is arranged');

    /* And nothing was recorded against it, because nothing about it moved. */
    expect(await reassignments.forRequest(request.id)).toEqual([]);
  });
});

/* ------------------------- a new manager who has already decided it. FR 48b, FR 48d */

describe('a request whose new line manager has already decided it', () => {
  beforeEach(async () => {
    /* HR first, then the manager, so that the desk the line moves is the second stage. */
    await annualLeaveGoesTo('HR', 'MANAGER');
    await twentyDaysFor(people.officer);
  });

  /**
   * A line moving decides nothing, which is the boundary this case is here to hold.
   *
   * Ama decided at the HR stage and is then made Adwoa's line manager, so every stage of the
   * chain has now been answered by one hand — the state LMS 322 calls a single approver, and
   * the state the walk reaches by *deciding* rather than by a record being edited. Reaching
   * it this way must not approve the leave: nobody said yes to the second stage.
   *
   * So the request stays exactly where it is, with its approval intact, and it is HR's to
   * settle. FR 48d, LMS 322.
   */
  it('is left where it is, because running out of people to ask never approves anything', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    expect(request.awaitingApprovalFrom).toBe('HR');

    await requests.approve(asTheHeadOfHr(), request.id, 'Her balance covers it');

    await reportsTo(people.officer, people.headOfHr);

    const after = await requests.byId(asTheHeadOfHr(), request.id);

    expect(after.status).toBe('SUBMITTED');
    expect(after.awaitingApprovalFrom).toBe('MANAGER');
    expect(await reassignments.forRequest(request.id)).toEqual([]);

    /* The approval already given is untouched, and still hers. FR 44. */
    const [decision, ...rest] = await decisions.forRequest(request.id);

    expect(rest).toEqual([]);
    expect(decision.decidedByEmployeeId).toBe(people.headOfHr);
  });
});

/* --------------------- a request the empty desk stranded. FR 48b, §8.6a, LMS 320 */

describe('a request that stopped because nobody could decide it', () => {
  beforeEach(async () => {
    /* The manager's desk and nothing else, so the stand-in is HR — and HR is emptied, which
       is what leaves the request with nowhere to go at all. */
    await annualLeaveGoesTo('MANAGER');
    await admin.query(
      `DELETE FROM user_role
        WHERE role_id IN (SELECT id FROM role WHERE code IN ('HR_OFFICER', 'HR_ADMIN'))`,
    );
    await twentyDaysFor(people.officer);

    /* Adwoa's line manager has left, so the desk her request starts at is unstaffed. */
    await admin.query(
      "UPDATE employee SET employment_status = 'TERMINATED', exit_date = '2026-01-31' " +
        'WHERE id = $1',
      [people.teamLead],
    );
  });

  /**
   * The line moving is what unsticks it, and nobody had to ask. FR 48b.
   *
   * LMS 320 gave HR a verb for this and left the request sitting until somebody remembered
   * to use it. A manager leaving and their reports being moved is the ordinary way the desk
   * fills again, and this is that happening by itself.
   */
  it('goes back into its chain the moment the person has a manager again', async () => {
    const { request } = await requests.submit(asTheOfficer(), aRequest(people.officer));

    expect(request.status).toBe('UNROUTABLE');
    expect(request.awaitingApprovalFrom).toBeNull();

    await reportsTo(people.officer, people.opsManager);

    const after = await requests.byId(system, request.id);

    expect(after.status).toBe('SUBMITTED');
    expect(after.awaitingApprovalFrom).toBe('MANAGER');
    expect(await waitingOn(people.opsManager)).toEqual([request.id]);

    const [handover] = await reassignments.forRequest(request.id);

    expect(handover).toMatchObject({ movedFrom: null, movedTo: 'MANAGER' });

    /* Nothing decided it on the way, which is what re-routing has to mean. */
    expect(await decisions.forRequest(request.id)).toEqual([]);
  });
});
