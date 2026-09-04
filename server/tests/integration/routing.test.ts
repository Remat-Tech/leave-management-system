import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { ApproverRole } from '../../src/features/leave-type/approval-chain.js';
import {
  type NewLeaveRequest,
  StillNobodyToDecideIt,
} from '../../src/features/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
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

/**
 * A request goes to somebody who can actually decide it. FR 48b, §8.6a. LMS 320.
 *
 * ../unit/routing.test.ts proves the walk, which is pure. What needs a server is everything
 * the walk cannot claim on its own:
 *
 *   **Who each desk resolves to comes off real rows.** The line manager is a reporting line,
 *   HR is two granted roles, and the Chief Executive is a setting — FR 48c, LMS 321 — so the
 *   whole point of the story is which *people* those three are today, and that is a database
 *   question.
 *
 *   **A skipped stage still lets the leave be approved.**
 *   `leave_request_is_approved_by_every_stage` refuses an approval with a stage unasked, and
 *   the one request FR 48b exists to move has exactly that shape. The trigger reads the skip.
 *
 *   **Nothing is auto approved.** Asserted against the rows: no decision, no `DEDUCTION`, and
 *   a status the schema will not let become `APPROVED`.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('routing integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let routing: LeaveRoutingRepository;
let decisions: LeaveDecisionRepository;
let notices: NotificationRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six that ../integration/leave-request.test.ts uses. */
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
  notices = new NotificationRepository(db);
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
    /** FR 47, LMS 324. */
    new WithdrawalRepository(db),
    new RoleRepository(db),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(notices, recordingMailer(), guard),
  );
});

beforeEach(async () => {
  /* FR 18, LMS 308. The fixture days are months behind today, so annual leave's seven day
     backdating window would refuse almost every request in this file. Widened rather than
     dated forward: the window is a column HR sets, and the rule it states is
     ./leave-request.test.ts's to prove. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  /* Annual leave's chain as the migration wrote it, restored the way every suite that moves
     it restores it — these files share one database. */
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
      'leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request',
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

/** Takes every HR role away, which is what leaves the HR desk with nobody at it. */
async function nobodyIsInHr(): Promise<void> {
  await admin.query(
    `DELETE FROM user_role
      WHERE role_id IN (SELECT id FROM role WHERE code IN ('HR_OFFICER', 'HR_ADMIN'))`,
  );
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
    /** FR 17, LMS 307. The fixture week is behind today, so annual leave is short of notice. */
    acknowledgesShortNotice: true,
  };
}

/** Whoever `organisation_setting` names, who in the fixtures also has no line manager. FR 48c. */
function asTheChiefExecutive() {
  return signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true });
}

function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

function asAnOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/** Somebody with no roles and no reports, asking for their own leave. */
function asAnOfficerAsking() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Every notice about one request, oldest first. */
async function noticesAbout(leaveRequestId: string) {
  return notices.forRequest(leaveRequestId);
}

/* ------------------------------------------- the manager stage, skipped to HR. FR 48b */

/**
 * The Chief Executive's own annual leave. FR 04, FR 48b's first criterion.
 *
 * The story's own sentence: *my own requests routed to someone who can actually decide them,
 * so that they are not left sitting because the usual approver is me.* Kwame has no line
 * manager — FR 04 leaves exactly one employee without one — so the first stage of the
 * ordinary chain has nobody at it.
 */
describe('a request whose manager stage has nobody at it', () => {
  beforeEach(async () => {
    await twentyDaysFor(people.ceo);
  });

  it('starts at HR instead, rather than waiting at a desk nobody can fill', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    expect(request.status).toBe('SUBMITTED');
    expect(request.awaitingApprovalFrom).toBe('HR');
  });

  /* The story's "records the skip", read back off the table it is written to. */
  it('and the skip is recorded, with the desk it went to and why', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    const [skip, ...rest] = await routing.forRequest(request.id);

    expect(rest).toEqual([]);
    expect(skip).toMatchObject({ stage: 'MANAGER', routedTo: 'HR' });
    expect(skip.because).toContain('no line manager');
    /* Stamped by the trigger from the transaction's actor, never by the writer. */
    expect(skip.recordedBy).not.toBe('not named by the writer');
    expect(skip.recordedAt).toBeInstanceOf(Date);
  });

  /**
   * And HR's yes agrees the leave, with the manager stage skipped rather than unasked.
   *
   * The assertion that needs a database: `leave_request_is_approved_by_every_stage` refuses
   * at COMMIT an approval with a stage that never decided, and a skipped stage never will.
   * Without the trigger reading the skip, the one request FR 48b exists to move would be the
   * one that could never be approved.
   */
  it('and HR alone agrees it, because the skipped stage counts as answered', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    const decided = await requests.approve(asTheHeadOfHr(), request.id);

    expect(decided.request.status).toBe('APPROVED');
    expect(decided.request.awaitingApprovalFrom).toBeNull();
    expect(decided.entry).not.toBeNull();

    /* One decision, at the desk that actually answered — not two, and not one at MANAGER. */
    expect((await decisions.forRequest(request.id)).map((one) => one.onBehalfOf)).toEqual(['HR']);
  });

  /* And the requester is still refused at the desk their request was sent to. FR 48. */
  it('and the Chief Executive still cannot decide it at HR', async () => {
    await nobodyIsInHr();
    await admin.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT u.id, r.id FROM app_user u, role r
        WHERE u.employee_id = $1 AND r.code = 'HR_ADMIN'`,
      [people.ceo],
    );

    const chief = signedInAs(people.ceo, {
      roles: ['EMPLOYEE', 'HR_ADMIN'],
      isManager: true,
    });

    const { request } = await requests.submit(chief, aRequest(people.ceo));

    /* Nobody else is in HR, so the HR stage is theirs too and there is nowhere left. */
    expect(request.status).toBe('UNROUTABLE');
    await expect(requests.approve(chief, request.id)).rejects.toThrow(NotAuthorised);
  });
});

/* ------------------------------- the HR stage, falling to the Chief Executive. FR 48b */

/**
 * The lone HR officer's own leave. FR 48b's second criterion, and `lone-hr`.
 *
 * `docs/development.md` names this the scenario worth remembering: Ama is the whole HR
 * function, so her own leave has nobody in HR left to approve it and must fall to the Chief
 * Executive.
 */
describe('a request whose HR stage only the requester staffs', () => {
  beforeEach(async () => {
    people = (await seed(admin, { scenario: 'lone-hr' })) as Record<string, string>;
    await twentyDaysFor(people.headOfHr);
  });

  /**
   * And the two stages stay two questions even where one person answers both.
   *
   * Ama reports to the Chief Executive, so the manager desk and the HR desk's stand-in are
   * the same human. They are still different stages, and the routing deduplicates by *desk*
   * rather than by person — a chain is a list of offices, and which people fill them today
   * is not something a walk over a list of desks can or should know.
   */
  it('falls to the Chief Executive once the manager has signed', async () => {
    const { request } = await requests.submit(asTheHeadOfHr(), aRequest(people.headOfHr));

    /* Her own line manager is the Chief Executive, so the first stage is ordinary. */
    expect(request.awaitingApprovalFrom).toBe('MANAGER');

    const atTheHrStage = await requests.approve(asTheChiefExecutive(), request.id);

    expect(atTheHrStage.request.status).toBe('SUBMITTED');
    expect(atTheHrStage.request.awaitingApprovalFrom).toBe('CEO');
    expect(await routing.forRequest(request.id)).toMatchObject([{ stage: 'HR', routedTo: 'CEO' }]);

    expect((await requests.approve(asTheChiefExecutive(), request.id)).request.status).toBe(
      'APPROVED',
    );
  });

  /* And with HR as the only stage, it goes straight to the Chief Executive. */
  it('and an HR-only chain goes to the Chief Executive, with the skip recorded', async () => {
    await annualLeaveGoesTo('HR');

    const { request } = await requests.submit(asTheHeadOfHr(), aRequest(people.headOfHr));

    expect(request.awaitingApprovalFrom).toBe('CEO');
    expect(await routing.forRequest(request.id)).toMatchObject([{ stage: 'HR', routedTo: 'CEO' }]);

    const decided = await requests.approve(asTheChiefExecutive(), request.id);

    expect(decided.request.status).toBe('APPROVED');
  });

  /* And she is refused at the desk that is hers, whichever way the chain is written. */
  it('and she cannot decide it herself', async () => {
    await annualLeaveGoesTo('HR');

    const { request } = await requests.submit(asTheHeadOfHr(), aRequest(people.headOfHr));

    await expect(requests.approve(asTheHeadOfHr(), request.id)).rejects.toThrow(NotAuthorised);
  });

  /* And a second officer answers the HR desk rather than the Chief Executive: "another HR
     officer" is not a fallback at all, because the desk is staffed by a role. */
  it('and a colleague in HR answers it where there is one', async () => {
    people = (await seed(admin)) as Record<string, string>;
    await twentyDaysFor(people.headOfHr);
    await annualLeaveGoesTo('HR');

    const { request } = await requests.submit(asTheHeadOfHr(), aRequest(people.headOfHr));

    expect(request.awaitingApprovalFrom).toBe('HR');
    expect(await routing.forRequest(request.id)).toEqual([]);

    expect((await requests.approve(asAnOfficer(), request.id)).request.status).toBe('APPROVED');
  });
});

/* --------------------------- the CEO stage, falling back to an HR officer. FR 48b */

/**
 * The Chief Executive's own unpaid leave. FR 48b's third criterion.
 *
 * The one rung that points downwards: there is nothing above FR 04's root, so the honest
 * second best is the function that holds the policy the root would have applied.
 */
describe('a request whose CEO stage the requester holds', () => {
  beforeEach(async () => {
    await twentyDaysFor(people.ceo);
    await annualLeaveGoesTo('CEO');
  });

  it('falls back to HR, and an officer decides it', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    expect(request.awaitingApprovalFrom).toBe('HR');
    expect(await routing.forRequest(request.id)).toMatchObject([{ stage: 'CEO', routedTo: 'HR' }]);

    expect((await requests.approve(asAnOfficer(), request.id)).request.status).toBe('APPROVED');
  });

  /* And the CEO desk still resolves to Kwame for everybody else's request. */
  it('and everybody else’s request still goes to the Chief Executive', async () => {
    await twentyDaysFor(people.officer);

    const officer = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
    const { request } = await requests.submit(officer, aRequest(people.officer));

    expect(request.awaitingApprovalFrom).toBe('CEO');
    expect(await routing.forRequest(request.id)).toEqual([]);
  });
});

/* ------------------------------------------- whose seat it is. FR 48c, LMS 321 */

/**
 * The `CEO` desk resolves to the setting, not to FR 04's root. FR 48c, LMS 321.
 *
 * ./organisation.test.ts proves the setting holds and is refused what it should be. This is
 * the half that matters: the desk moves when somebody names a different person, and it does
 * not move when the reporting lines or a job title do.
 */
describe('who the CEO desk resolves to', () => {
  beforeEach(async () => {
    await twentyDaysFor(people.officer);
    await annualLeaveGoesTo('CEO');
  });

  it('is whoever the organisation names, not whoever has no line manager', async () => {
    await admin.query('UPDATE organisation_setting SET ceo_employee_id = $1', [people.opsDirector]);

    const { request } = await requests.submit(asAnOfficerAsking(), aRequest(people.officer));

    expect(request.awaitingApprovalFrom).toBe('CEO');

    /* Kwame still has no line manager and still says Chief Executive Officer on his record,
       and the desk is no longer his. */
    await expect(requests.approve(asTheChiefExecutive(), request.id)).rejects.toThrow(
      NotAuthorised,
    );

    const director = signedInAs(people.opsDirector, { roles: ['EMPLOYEE'], isManager: true });

    expect((await requests.approve(director, request.id)).request.status).toBe('APPROVED');
  });

  /* Nobody named is a desk nobody staffs, which FR 48b routes round rather than stopping on.
     A company part way through its setup still gets its leave decided. */
  it('and falls to HR where nobody is named at all', async () => {
    await admin.query('TRUNCATE organisation_setting');

    const { request } = await requests.submit(asAnOfficerAsking(), aRequest(people.officer));

    expect(request.awaitingApprovalFrom).toBe('HR');
    expect(await routing.forRequest(request.id)).toMatchObject([{ stage: 'CEO', routedTo: 'HR' }]);
  });

  /* And the sentence the person is given names the setting, so whoever has to fix it knows
     which screen to open. NFR USA 03. */
  it('and says so in words that name the setting', async () => {
    await admin.query('TRUNCATE organisation_setting');
    await nobodyIsInHr();

    const { request } = await requests.submit(asAnOfficerAsking(), aRequest(people.officer));

    expect(request.status).toBe('UNROUTABLE');

    const [alert] = await notices.forEmployee(people.officer);

    expect(alert.body).toContain('Chief Executive');
    expect(alert.body).toContain('settings');
  });
});

/* ------------------------------------------------- neither available. FR 48b's last */

/**
 * A request nobody at all can decide. FR 48b's last two criteria.
 *
 * The Chief Executive asking for leave whose chain names only their own seat, in a company
 * with nobody in HR: the desk is theirs and its stand-in is empty. The request stops.
 */
describe('a request neither desk can answer', () => {
  beforeEach(async () => {
    await twentyDaysFor(people.ceo);
    await annualLeaveGoesTo('CEO');
    await nobodyIsInHr();
  });

  it('is left unroutable rather than approved or turned down', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    expect(request.status).toBe('UNROUTABLE');
    expect(request.awaitingApprovalFrom).toBeNull();
  });

  /* The criterion said as the rows: nothing decided it, and no days were taken. */
  it('and nothing was decided and no days were taken', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    expect(await decisions.forRequest(request.id)).toEqual([]);

    const { rows } = await admin.query<{ entry_type: string }>(
      'SELECT entry_type FROM leave_ledger_entry WHERE leave_request_id = $1',
      [request.id],
    );

    /* The RESERVATION and nothing else: the days are held, not taken and not given back. */
    expect(rows.map((row) => row.entry_type)).toEqual(['RESERVATION']);
  });

  /* And the days are still held, which is what makes it stuck rather than settled. */
  it('and the days are still held against the balance', async () => {
    const { balance } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    expect(balance.pending).toBe(6);
    expect(balance.taken).toBe(0);
    expect(balance.available).toBe(14);
  });

  /* And the schema refuses to let it become agreed, wherever the write came from. */
  it('and the database refuses to approve it, on the owner connection', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    await expect(
      admin.query('UPDATE leave_request SET status = $1 WHERE id = $2', ['APPROVED', request.id]),
    ).rejects.toThrow(/nobody who can decide it/);
  });

  /**
   * And the alert goes out. FR 48b's last criterion, FR 59.
   *
   * To the person whose leave stopped, so they do not sit waiting for an answer, and to
   * whoever can change the organisation so that it has not — which here is the Chief
   * Executive themselves, because nobody is in HR at all.
   */
  it('and an alert is written to the person and to whoever could unstick it', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    const sent = await noticesAbout(request.id);

    /* One notice rather than two: the ordinary "it is now with your line manager" would be
       false, so the alert replaces it rather than following it. */
    expect(sent.map((notice) => notice.event)).toEqual(['UNROUTABLE']);

    const alert = sent[0];

    expect(alert.employeeId).toBe(people.ceo);
    expect(alert.subject).toContain('nobody who can decide it');
    expect(alert.body).toContain('granting somebody an HR role');
  });

  /* And it is not a refusal: the person is told plainly that nobody judged the leave. */
  it('and the alert says nobody approved or turned it down', async () => {
    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    const alert = (await noticesAbout(request.id))[0];

    expect(alert.body).toContain('nobody has approved or turned it down');
    expect(alert.body).toContain('still held');
  });
});

/* ---------------------------------------- putting a stuck request back. FR 48b, LMS 320 */

describe('sending a stuck request back into its chain', () => {
  let stuck: string;

  beforeEach(async () => {
    await twentyDaysFor(people.ceo);
    await annualLeaveGoesTo('CEO');
    await nobodyIsInHr();

    stuck = (await requests.submit(asTheChiefExecutive(), aRequest(people.ceo))).request.id;
  });

  it('is refused while nothing about the organisation has changed', async () => {
    await expect(requests.route(asTheHeadOfHr(), stuck)).rejects.toThrow(StillNobodyToDecideIt);
  });

  /* And once somebody is at the desk, the request goes back to being decided. */
  it('and puts it back to the desk that can now be asked', async () => {
    await admin.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT u.id, r.id FROM app_user u, role r
        WHERE u.employee_id = $1 AND r.code = 'HR_OFFICER'`,
      [people.hrOfficer],
    );

    const rerouted = await requests.route(asTheHeadOfHr(), stuck);

    expect(rerouted.request.status).toBe('SUBMITTED');
    expect(rerouted.request.awaitingApprovalFrom).toBe('HR');

    /* And nothing was decided on the way: the officer still has to say yes. */
    expect(await decisions.forRequest(stuck)).toEqual([]);
    expect((await requests.approve(asAnOfficer(), stuck)).request.status).toBe('APPROVED');
  });

  /* It is HR's, and not the requester's — the alert asks for a change to the organisation. */
  it('and is not the requester’s to do', async () => {
    await expect(requests.route(asTheChiefExecutive(), stuck)).rejects.toThrow(NotAuthorised);
  });

  /* And the person may always take it back instead, which is what stops it being a trap. */
  it('and the person can withdraw it instead, getting the days back', async () => {
    const released = await requests.withdraw(asTheChiefExecutive(), stuck);

    expect(released.request.status).toBe('WITHDRAWN');
    expect(released.balance.available).toBe(20);
  });

  /* And HR may unwind it, which is the other ending an unroutable request has. */
  it('and HR can cancel it', async () => {
    expect((await requests.cancel(asTheHeadOfHr(), stuck)).request.status).toBe('CANCELLED');
  });
});

/* ------------------------------------------------------ what the table holds still */

describe('the skips table', () => {
  it('records a skip once, however many writers reach the same conclusion', async () => {
    await twentyDaysFor(people.ceo);

    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));

    await expect(
      admin.query(
        'INSERT INTO leave_request_routing (leave_request_id, stage, routed_to, because) ' +
          "VALUES ($1, 'MANAGER', 'HR', 'a second opinion')",
        [request.id],
      ),
    ).rejects.toThrow(/leave_request_routing_once_per_stage/);
  });

  it('and refuses to be edited or removed, on the owner connection', async () => {
    await twentyDaysFor(people.ceo);

    const { request } = await requests.submit(asTheChiefExecutive(), aRequest(people.ceo));
    const [skip] = await routing.forRequest(request.id);

    await expect(
      admin.query('UPDATE leave_request_routing SET because = $1 WHERE id = $2', ['no', skip.id]),
    ).rejects.toThrow(/never changed/);

    await expect(
      admin.query('DELETE FROM leave_request_routing WHERE id = $1', [skip.id]),
    ).rejects.toThrow(/never deleted/);
  });

  /* A stage that answered itself is not a skip, and the schema says so. */
  it('and refuses a stage that went to itself', async () => {
    await twentyDaysFor(people.officer);

    const officer = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
    const { request } = await requests.submit(officer, aRequest(people.officer));

    await expect(
      admin.query(
        'INSERT INTO leave_request_routing (leave_request_id, stage, routed_to, because) ' +
          "VALUES ($1, 'HR', 'HR', 'went nowhere')",
        [request.id],
      ),
    ).rejects.toThrow(/leave_request_routing_goes_somewhere_else/);
  });

  /* And `lms_app` may write one and may never change one. */
  it('and the application may add a skip and never move one', async () => {
    const { rows } = await admin.query<Record<string, boolean>>(
      `SELECT has_table_privilege('lms_app', 'leave_request_routing', 'INSERT') AS ins,
              has_table_privilege('lms_app', 'leave_request_routing', 'SELECT') AS sel,
              has_table_privilege('lms_app', 'leave_request_routing', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'leave_request_routing', 'DELETE') AS del`,
    );

    expect(rows[0]).toEqual({ ins: true, sel: true, upd: false, del: false });
  });
});
