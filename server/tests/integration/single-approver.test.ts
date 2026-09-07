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
 * A request decided by one person says so. FR 48d, §8.6a. LMS 322.
 *
 * ../unit/routing.test.ts proves the walk. What needs a server is who the desks resolve to:
 * the head of HR is a line manager *and* an HR officer, so two stages of one chain come back
 * to one human, and only real rows can say that.
 *
 *   **Two stages, two officers.** The second stage goes to somebody who has not decided, and
 *   the officer who signed the first is refused there.
 *
 *   **Where there is nobody else, the request is stamped**, and the stamp is held against the
 *   decisions themselves by `leave_request_says_when_one_person_decided_it`.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('single approver integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let routing: LeaveRoutingRepository;
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

  routing = new LeaveRoutingRepository(db);
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
    routing,
    new WithdrawalRepository(db),
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
      'attachment_access, attachment_download_link, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

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
    /** FR 17, LMS 307. */
    acknowledgesShortNotice: true,
  };
}

/** Ama: the head of HR, who is a line manager and an HR desk of one. */
function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

/** Efua: the other HR officer, and the second person FR 48d looks for. */
function asTheOtherOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asTheChiefExecutive() {
  return signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true });
}

function asAdwoa() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Puts Adwoa under the head of HR, so her two stages are one person's twice over. */
async function adwoaReportsToTheHeadOfHr(): Promise<void> {
  await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
    people.headOfHr,
    people.officer,
  ]);
}

/* ---------------------------------------- two stages, and two different officers */

/**
 * The story's first criterion. FR 48d.
 *
 * Adwoa reports to Ama, who also holds an HR role, so annual leave's manager stage and its HR
 * stage both resolve to Ama. The request still goes to the HR desk — Efua is there — and it
 * is Efua's to answer.
 */
describe('a chain whose two stages resolve to the same person', () => {
  beforeEach(async () => {
    await adwoaReportsToTheHeadOfHr();
    await twentyDaysFor(people.officer);
  });

  it('refuses the officer who signed the first stage, and takes the second from a colleague', async () => {
    const { request } = await requests.submit(asAdwoa(), aRequest(people.officer));

    const atHr = await requests.approve(asTheHeadOfHr(), request.id);

    /* The HR desk has two officers, so nothing is skipped: it is asked as usual. */
    expect(atHr.request.awaitingApprovalFrom).toBe('HR');
    expect(await routing.forRequest(request.id)).toEqual([]);

    /** FR 48d. And the hand that signed the manager stage is not the HR desk's answer. */
    await expect(requests.approve(asTheHeadOfHr(), request.id)).rejects.toThrow(NotAuthorised);

    const agreed = await requests.approve(asTheOtherOfficer(), request.id);

    expect(agreed.request.status).toBe('APPROVED');
    /* Two people decided it, so there is no exception to record. */
    expect(agreed.request.decidedBySingleApprover).toBe(false);
    expect(await decisions.forRequest(request.id)).toHaveLength(2);
  });

  /* And where the desk is that one person alone, the stage goes to the stand-in rather than
     back to them: Efua's own leave leaves HR staffed by Ama, who has just signed. */
  it('and sends the stage to the stand-in where the desk is that person alone', async () => {
    await twentyDaysFor(people.hrOfficer);

    const { request } = await requests.submit(asTheOtherOfficer(), aRequest(people.hrOfficer));

    const routed = await requests.approve(asTheHeadOfHr(), request.id);

    /** FR 48b's ladder, walked for FR 48d's reason. */
    expect(routed.request.awaitingApprovalFrom).toBe('CEO');
    expect(await routing.forRequest(request.id)).toMatchObject([{ stage: 'HR', routedTo: 'CEO' }]);

    const agreed = await requests.approve(asTheChiefExecutive(), request.id);

    expect(agreed.request.status).toBe('APPROVED');
    expect(agreed.request.decidedBySingleApprover).toBe(false);
  });
});

/* ------------------------------------------ and where there is only one, it says so */

/**
 * The story's second criterion. FR 48d.
 *
 * Ama is the whole HR function, and her line manager is the Chief Executive — who is also
 * HR's stand-in. There is nobody else, so he decides once and the request carries the fact.
 */
describe('a request there was only one person to decide', () => {
  beforeEach(async () => {
    people = (await seed(admin, { scenario: 'lone-hr' })) as Record<string, string>;
    await twentyDaysFor(people.headOfHr);
  });

  it('is stamped as decided by a single approver, and says so to the person', async () => {
    const { request } = await requests.submit(asTheHeadOfHr(), aRequest(people.headOfHr));

    const agreed = await requests.approve(asTheChiefExecutive(), request.id);

    expect(agreed.request.status).toBe('APPROVED');
    expect(agreed.request.decidedBySingleApprover).toBe(true);

    /* One signature, and the stage it also answered recorded against the desk it was made
       at rather than left looking unasked. */
    expect(await decisions.forRequest(request.id)).toHaveLength(1);
    expect(await routing.forRequest(request.id)).toMatchObject([
      { stage: 'HR', routedTo: 'MANAGER' },
    ]);

    const progress = await requests.progressFor(asTheHeadOfHr(), request.id);

    expect(progress.singleApprover).toBe(true);
    expect(progress.inWords).toContain('One approver decided every stage');
  });

  /* And the stamp is the database's rule rather than the service's promise. */
  it('and the row cannot say otherwise', async () => {
    const { request } = await requests.submit(asTheHeadOfHr(), aRequest(people.headOfHr));

    await requests.approve(asTheChiefExecutive(), request.id);

    await expect(
      admin.query('UPDATE leave_request SET decided_by_a_single_approver = FALSE WHERE id = $1', [
        request.id,
      ]),
    ).rejects.toThrow(/single approver/);
  });

  /* Nor can a request two people decided claim the exception. */
  it('and a request two people decided cannot claim it', async () => {
    await twentyDaysFor(people.officer);

    const { request } = await requests.submit(asAdwoa(), aRequest(people.officer));

    await requests.approve(asTheTeamLead(), request.id);
    await requests.approve(asTheHeadOfHr(), request.id);

    await expect(
      admin.query('UPDATE leave_request SET decided_by_a_single_approver = TRUE WHERE id = $1', [
        request.id,
      ]),
    ).rejects.toThrow(/single approver/);
  });
});

/* ------------------------------------------------- one person, one decision, per request */

/**
 * And the schema holds it on every connection. FR 48d.
 *
 * `leave_request_decision_once_per_person`, which is the sibling of the once-per-desk index:
 * a second decision by one hand on one request is what the story exists to stop.
 */
describe('the record itself', () => {
  it('refuses a second decision by the same person on one request', async () => {
    await twentyDaysFor(people.officer);

    const { request } = await requests.submit(asAdwoa(), aRequest(people.officer));

    await requests.approve(asTheTeamLead(), request.id);

    /* The same hand again, at the other desk. The actor is set the way `recording` sets it,
       because the trigger takes the writer from the connection rather than from the row. */
    await expect(secondDecisionBy(people.teamLead, request.id)).rejects.toThrow(
      /leave_request_decision_once_per_person|duplicate key/,
    );
  });
});

/** A decision written straight at the database, under somebody's name. NFR AUD 02. */
async function secondDecisionBy(employeeId: string, leaveRequestId: string): Promise<void> {
  try {
    await admin.query('BEGIN');
    await admin.query('SELECT set_config($1, $2, true)', ['lms.audit.actor', 'a test']);
    await admin.query('SELECT set_config($1, $2, true)', [
      'lms.audit.actor_employee_id',
      employeeId,
    ]);
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of, comment)
       VALUES ($1, 'APPROVE', 'HR', NULL)`,
      [leaveRequestId],
    );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

/** Adwoa's own line manager in the base fixtures. */
function asTheTeamLead() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}
