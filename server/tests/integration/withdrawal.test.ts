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
import { WITHDRAWAL_ACTIONS } from '../../src/features/leave-request/withdrawal.js';
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
import { RequestHistoryService } from '../../src/features/leave-request/request-history.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Withdrawing leave every desk has agreed to. FR 47, §8.2. LMS 324.
 *
 * ../unit/withdrawal.test.ts proves what is pure: which grant the calendar chooses, what is
 * left of a period, and what each act is owed in writing. What needs a server is everything
 * that one cannot claim:
 *
 *   **The days actually come back out of `taken`.** The movement is a `RECALCULATION`, which
 *   nothing wrote until this story, and what makes it right is the figure in the balance
 *   afterwards rather than the entry type on the row.
 *
 *   **The schema will not let it happen any other way.** `APPROVED` may reach `WITHDRAWN`
 *   and nothing else; an ending from there gives its days back as a correction rather than
 *   as a release; and agreed leave cannot come off the books with nobody's ask behind it.
 *
 *   **Both halves of the conversation are on the record**, append only, with the people who
 *   wrote them.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('withdrawal integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let history: RequestHistoryService;
let balances: BalanceService;
let withdrawals: WithdrawalRepository;
let notices: NotificationRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);
  const routing = new LeaveRoutingRepository(db);

  withdrawals = new WithdrawalRepository(db);
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
    decisions,
    routing,
    withdrawals,
    new RoleRepository(db),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(notices, recordingMailer(), guard),
  );

  history = new RequestHistoryService(
    requestRepository,
    decisions,
    guard,
    employees,
    types,
    yearRepository,
    routing,
    withdrawals,
  );
});

beforeEach(async () => {
  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  /* Annual leave's chain as the migration wrote it, restored the way every suite that moves
     it restores it — these files share one template. */
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
      'leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

/** A calendar date this many days either side of today, in UTC. NFR DAT 03. */
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

/** Whose balance every test here moves. */
function theBalance() {
  return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id };
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/**
 * One approved request, agreed by every desk of annual leave's chain.
 *
 * Through the real doors rather than written to the table, so what is withdrawn below is a
 * request the system actually approved and a `DEDUCTION` that actually moved.
 */
async function anApprovedRequest(from: string, to: string): Promise<string> {
  const { request } = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from,
    to,
    reason: 'My sister is getting married',
    /** FR 17, LMS 307. Every period here is inside annual leave's fourteen day window. */
    acknowledgesShortNotice: true,
  });

  await requests.approve(asTheirManager(), request.id);
  await requests.approve(asAnHrOfficer(), request.id);

  return request.id;
}

/** A fortnight starting a week from today: agreed, and not begun. FR 47's second criterion. */
function nextFortnight(): [string, string] {
  return [daysFromToday(7), daysFromToday(20)];
}

/** A fortnight that started a week ago and has a week to run. FR 47's third criterion. */
function theFortnightUnderway(): [string, string] {
  return [daysFromToday(-7), daysFromToday(6)];
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await admin.query<{ status: string }>(
    'SELECT status FROM leave_request WHERE id = $1',
    [id],
  );

  return rows[0].status;
}

async function entriesFor(id: string) {
  const { rows } = await admin.query<{ entry_type: string; days: string; reason: string }>(
    'SELECT entry_type, days, reason FROM leave_ledger_entry WHERE leave_request_id = $1 ORDER BY id',
    [id],
  );

  return rows;
}

/* ---------------------------------------------------- the ask, FR 47's first criterion */

describe('asking for agreed leave to be taken off the books', () => {
  it('records the ask and moves nothing at all', async () => {
    const id = await anApprovedRequest(...nextFortnight());
    const spent = (await balances.forOne(system, theBalance())).available;

    const asked = await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    expect(asked.withdrawal.action).toBe('ASK_TO_WITHDRAW');
    expect(asked.withdrawal.reason).toBe('The wedding is off');
    expect(asked.withdrawal.answersId).toBeNull();

    /* The leave is still agreed and the days are still spent until HR answers. */
    expect(await statusOf(id)).toBe('APPROVED');
    expect((await balances.forOne(system, theBalance())).available).toBe(spent);
    expect((await entriesFor(id)).map((entry) => entry.entry_type)).toEqual([
      'RESERVATION',
      'DEDUCTION',
    ]);
  });

  /* FR 47's first criterion, as a refusal: HR does not take agreed leave off somebody's
     calendar on their own. */
  it('and HR cannot answer one nobody has made', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await expect(requests.grantWithdrawal(asAnHrOfficer(), id)).rejects.toMatchObject({
      code: 'NOTHING_TO_ANSWER',
    });

    expect(await statusOf(id)).toBe('APPROVED');
  });

  /* The one place a withdrawal is narrower than `withdraw()`, which HR may do on somebody's
     behalf: HR asking and then agreeing would put one desk on both sides. */
  it('and it is the employee’s own, not HR’s and not their manager’s', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    for (const actor of [asAnHrOfficer(), asTheirManager()]) {
      await expect(requests.askToWithdraw(actor, id, 'They do not need it')).rejects.toThrow(
        NotAuthorised,
      );
    }
  });

  it('and a reason is not optional', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await expect(requests.askToWithdraw(asTheEmployee(), id, '   ')).rejects.toMatchObject({
      code: 'WITHDRAWAL_NEEDS_A_REASON',
      field: 'reason',
    });
  });

  /* Two sentences and one decision. `leave_request_is_asked_to_withdraw_once_at_a_time` is
     what makes it true when two tabs press together. */
  it('and only one ask is open at a time', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    await expect(
      requests.askToWithdraw(asTheEmployee(), id, 'Really, it is off'),
    ).rejects.toMatchObject({ code: 'ALREADY_ASKED_TO_WITHDRAW' });
  });

  /* And asking again after an answer is a new ask, which is the other half of that rule. */
  it('and asking again after HR has answered is allowed', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');
    await requests.refuseWithdrawal(asAnHrOfficer(), id, 'Cover is already arranged');

    const again = await requests.askToWithdraw(asTheEmployee(), id, 'It really is off now');

    expect(again.withdrawal.action).toBe('ASK_TO_WITHDRAW');
    expect((await withdrawals.forRequest(id)).length).toBe(3);
  });

  /* FR 59. HR is told, because HR is who answers it. */
  it('and HR is told, with the employee’s own words in it', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    const told = (await notices.forRequest(id)).filter(
      (notice) => notice.event === 'WITHDRAWAL_ASKED',
    );

    expect(told.length).toBeGreaterThan(0);
    expect(told.every((notice) => notice.employeeId !== people.officer)).toBe(true);
    expect(told[0].body).toContain('The wedding is off');
  });
});

/* ------------------------------- HR agrees, and the leave has not started. FR 47 */

describe('HR agreeing before the leave has started', () => {
  it('takes it off the books and puts every day back', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    const owed = (await balances.forOne(system, theBalance())).available;
    const { days } = (
      await admin.query<{ days: number }>('SELECT days FROM leave_request WHERE id = $1', [id])
    ).rows[0];

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    const answered = await requests.grantWithdrawal(asAnHrOfficer(), id);

    expect(answered.withdrawal.action).toBe('WITHDRAW_APPROVED');
    expect(await statusOf(id)).toBe('WITHDRAWN');

    /* A RECALCULATION, not a RELEASE: the hold was spent by the DEDUCTION. */
    expect((await entriesFor(id)).map((entry) => entry.entry_type)).toEqual([
      'RESERVATION',
      'DEDUCTION',
      'RECALCULATION',
    ]);

    expect((await balances.forOne(system, theBalance())).available).toBe(owed + Number(days));
    expect((await balances.forOne(system, theBalance())).taken).toBe(0);
  });

  /* And the dates come free with it, because `leave_request_never_overlaps` covers the live
     statuses and `WITHDRAWN` is not one. */
  it('and the same dates can be asked for again straight away', async () => {
    const [from, to] = nextFortnight();
    const id = await anApprovedRequest(from, to);

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');
    await requests.grantWithdrawal(asAnHrOfficer(), id);

    const again = await requests.submit(asTheEmployee(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from,
      to,
      reason: 'It is back on',
      acknowledgesShortNotice: true,
    });

    expect(again.request.status).toBe('SUBMITTED');
  });

  /* FR 39's asymmetry, from the other end of a request's life: nobody loses anything by
     this, and the ask it answers already says why. */
  it('and needs no reason of its own', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    expect((await requests.grantWithdrawal(asAnHrOfficer(), id)).withdrawal.reason).toBeNull();
  });

  /** FR 59. */
  it('and the person is told the days are back', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');
    await requests.grantWithdrawal(asAnHrOfficer(), id);

    const told = (await notices.forRequest(id)).filter(
      (notice) => notice.employeeId === people.officer,
    );

    expect(told.map((notice) => notice.event)).toContain('WITHDRAWAL_GRANTED');
  });

  /* FR 48, LMS 319 from the other end. An HR officer's own agreed leave is answered by
     another HR desk, whatever they hold — the ask is theirs and the answer is not. */
  it('and nobody answers their own ask, whatever they hold', async () => {
    await balances.grantTheYear(system, {
      employeeId: people.hrOfficer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'Annual entitlement for 2026',
    });

    const { request } = await requests.submit(asAnHrOfficer(), {
      employeeId: people.hrOfficer,
      leaveTypeId: annualId,
      from: daysFromToday(7),
      to: daysFromToday(20),
      reason: 'A holiday',
      acknowledgesShortNotice: true,
    });

    await requests.approve(asTheHeadOfHr(), request.id);
    await requests.approve(asTheHeadOfHr(), request.id);

    await requests.askToWithdraw(asAnHrOfficer(), request.id, 'Not needed after all');

    await expect(requests.grantWithdrawal(asAnHrOfficer(), request.id)).rejects.toThrow(
      NotAuthorised,
    );

    /* And a colleague at the same desk answers it, as they always could. */
    expect((await requests.grantWithdrawal(asTheHeadOfHr(), request.id)).withdrawal.action).toBe(
      'WITHDRAW_APPROVED',
    );
  });
});

/* ------------------------ HR agrees, and the leave has started. FR 47's third criterion */

describe('HR agreeing once the leave has started', () => {
  it('amends it to the days actually taken and gives back only what was left', async () => {
    const id = await anApprovedRequest(...theFortnightUnderway());

    const spent = (await balances.forOne(system, theBalance())).available;
    const { days } = (
      await admin.query<{ days: number }>('SELECT days FROM leave_request WHERE id = $1', [id])
    ).rows[0];

    await requests.askToWithdraw(asTheEmployee(), id, 'I came back early');

    const answered = await requests.grantWithdrawal(
      asAnHrOfficer(),
      id,
      'Back at work from tomorrow; the rest of the fortnight is not taken',
    );

    expect(answered.withdrawal.action).toBe('AMEND');

    /* The leave happened, in part, so the request stands and its dates are untouched. */
    expect(await statusOf(id)).toBe('APPROVED');

    const back = Number(answered.entry?.days ?? 0);

    expect(back).toBeGreaterThan(0);
    expect(back).toBeLessThan(Number(days));
    expect((await balances.forOne(system, theBalance())).available).toBe(spent + back);
    expect((await balances.forOne(system, theBalance())).taken).toBe(Number(days) - back);
  });

  it('and refuses to do it with nothing said', async () => {
    const id = await anApprovedRequest(...theFortnightUnderway());

    await requests.askToWithdraw(asTheEmployee(), id, 'I came back early');

    await expect(requests.grantWithdrawal(asAnHrOfficer(), id)).rejects.toMatchObject({
      code: 'WITHDRAWAL_NEEDS_A_REASON',
      field: 'reason',
    });
  });

  /* Leave that is over has nothing left. A movement of nought days is not a movement. */
  it('and refuses leave that is already finished', async () => {
    const id = await anApprovedRequest(daysFromToday(-20), daysFromToday(-7));

    await requests.askToWithdraw(asTheEmployee(), id, 'I did not take it');

    await expect(
      requests.grantWithdrawal(asAnHrOfficer(), id, 'They were at work throughout'),
    ).rejects.toMatchObject({ code: 'NOTHING_LEFT_TO_GIVE_BACK' });

    expect((await entriesFor(id)).map((entry) => entry.entry_type)).toEqual([
      'RESERVATION',
      'DEDUCTION',
    ]);
  });

  /** FR 59. The message says the half nobody expects: some of the days are spent. */
  it('and the person is told what is spent and what came back', async () => {
    const id = await anApprovedRequest(...theFortnightUnderway());

    await requests.askToWithdraw(asTheEmployee(), id, 'I came back early');
    await requests.grantWithdrawal(asAnHrOfficer(), id, 'Back at work from tomorrow');

    const told = (await notices.forRequest(id)).filter(
      (notice) => notice.event === 'LEAVE_AMENDED',
    );

    expect(told.length).toBe(1);
    expect(told[0].body).toContain('Back at work from tomorrow');
    expect(told[0].body).toContain('had not been taken');
  });
});

/* ------------------------------------------------------------------ HR says no. FR 47 */

describe('HR turning the ask down', () => {
  it('leaves the leave standing and moves nothing', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    const spent = (await balances.forOne(system, theBalance())).available;

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    const answered = await requests.refuseWithdrawal(
      asAnHrOfficer(),
      id,
      'Cover is already arranged for that fortnight',
    );

    expect(answered.withdrawal.action).toBe('REFUSE_WITHDRAWAL');
    expect(answered.entry).toBeNull();
    expect(await statusOf(id)).toBe('APPROVED');
    expect((await balances.forOne(system, theBalance())).available).toBe(spent);
  });

  it('and needs a reason, as any refusal does', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    await expect(requests.refuseWithdrawal(asAnHrOfficer(), id, '  ')).rejects.toMatchObject({
      code: 'WITHDRAWAL_NEEDS_A_REASON',
    });
  });

  /* Answering the same ask twice would be HR deciding twice about one sentence. */
  it('and an ask is answered once', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');
    await requests.refuseWithdrawal(asAnHrOfficer(), id, 'Cover is already arranged');

    await expect(requests.grantWithdrawal(asAnHrOfficer(), id)).rejects.toMatchObject({
      code: 'NOTHING_TO_ANSWER',
    });
  });

  /* HR's, and never the line manager's: what is being unwound is an approval the whole
     chain gave, and the days have already left the balance. */
  it('and is HR’s to answer, not the line manager’s', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    await expect(requests.refuseWithdrawal(asTheirManager(), id, 'I do not agree')).rejects.toThrow(
      NotAuthorised,
    );
  });
});

/* ------------------------------------------------------ what the schema will not allow */

describe('the rules the database keeps, whatever wrote', () => {
  /* FR 47. `APPROVED` may reach `WITHDRAWN` and nothing else — not CANCELLED, which is HR's
     adjustment, and not REFUSED, which happens before a request reaches here. */
  it.each(['CANCELLED', 'REFUSED', 'SUBMITTED', 'UNROUTABLE'])(
    'refuses an approved request becoming %s',
    async (status) => {
      const id = await anApprovedRequest(...nextFortnight());

      await expect(
        admin.query('UPDATE leave_request SET status = $1 WHERE id = $2', [status, id]),
      ).rejects.toMatchObject({ constraint: 'leave_request_moves_as_the_table_says' });
    },
  );

  /* The story's first criterion, held where no service can forget it. */
  it('and refuses agreed leave coming off the books with nobody’s ask behind it', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await admin.query('BEGIN');
    await admin.query(
      "UPDATE leave_request SET status = 'WITHDRAWN', awaiting_approval_from = NULL WHERE id = $1",
      [id],
    );
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       SELECT employee_id, leave_type_id, leave_year_id, 'RECALCULATION', days, 'by hand', id
         FROM leave_request WHERE id = $1`,
      [id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_withdrawn_from_approved_was_asked_for',
    });
  });

  /* And an ending from `APPROVED` is explained by a correction rather than by a release —
     there is no hold left to release, so a RELEASE would be days invented. */
  it('and refuses one that tries to give its days back as a release', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_withdrawal (leave_request_id, action, answers_id)
       SELECT leave_request_id, 'WITHDRAW_APPROVED', id FROM leave_request_withdrawal
        WHERE leave_request_id = $1 AND action = 'ASK_TO_WITHDRAW'`,
      [id],
    );
    await admin.query(
      "UPDATE leave_request SET status = 'WITHDRAWN', awaiting_approval_from = NULL WHERE id = $1",
      [id],
    );
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       SELECT employee_id, leave_type_id, leave_year_id, 'RELEASE', days, 'by hand', id
         FROM leave_request WHERE id = $1`,
      [id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_gives_its_days_back',
    });
  });

  /* And nothing gives back more than it ever spent, which is what an amendment run twice
     would otherwise do. */
  it('and refuses a request credited more days than it took', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       SELECT employee_id, leave_type_id, leave_year_id, 'RECALCULATION', days + 1, 'too much', id
         FROM leave_request WHERE id = $1`,
      [id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_gives_back_no_more_than_it_took',
    });
  });

  /* Neither half of the conversation is ever rewritten, exactly as a decision is not. */
  it('and neither an ask nor an answer can be edited or removed', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    await expect(
      admin.query("UPDATE leave_request_withdrawal SET reason = 'something else'"),
    ).rejects.toThrow();

    await expect(admin.query('DELETE FROM leave_request_withdrawal')).rejects.toThrow();
  });

  /* The domain's list and the column's CHECK, read back out of the catalogue so that
     neither can be extended alone. */
  it('and the four acts the column accepts are the four the domain knows', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'leave_request_withdrawal_action_known'`,
    );

    expect(rows.length).toBe(1);

    for (const action of WITHDRAWAL_ACTIONS) {
      expect(rows[0].definition).toContain(action);
    }
  });

  /* Append only and carrying its own writer, so an audit trigger would be a second copy of
     a row that cannot move — the same declining `leave_request_decision` made. */
  it('and it is not in the audit log, because it is already its own history', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');

    const { rows } = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_log WHERE entity = 'leave_request_withdrawal'",
    );

    expect(rows[0].count).toBe('0');
  });
});

/* ------------------------------------------------------- what the person reads, FR 54 */

describe('the account on somebody’s own history', () => {
  /**
   * The trail said "taken back before it was decided" of every `WITHDRAWN` request until
   * this story, and that is false of exactly the ones LMS 324 makes.
   */
  it('says agreed leave came off the books rather than that nobody had decided', async () => {
    const id = await anApprovedRequest(...nextFortnight());

    await requests.askToWithdraw(asTheEmployee(), id, 'The wedding is off');
    await requests.grantWithdrawal(asAnHrOfficer(), id);

    const shown = await history.forEmployee(asTheEmployee(), people.officer);
    const entry = shown.entries.find((one) => one.requestId === id)!;

    expect(entry.status).toBe('WITHDRAWN');

    const trail = entry.trail.map((step) => step.inWords).join(' ');

    expect(trail).not.toContain('before it was decided');
    expect(trail).toContain('You asked for this leave to be taken off the books.');
    expect(trail).toContain('HR agreed.');
  });

  /* And the employee's own words and HR's are both on it, with the people who wrote them. */
  it('and carries both sentences, with who wrote each', async () => {
    const id = await anApprovedRequest(...theFortnightUnderway());

    await requests.askToWithdraw(asTheEmployee(), id, 'I came back early');
    await requests.grantWithdrawal(asAnHrOfficer(), id, 'Back at work from tomorrow');

    const shown = await history.forEmployee(asTheEmployee(), people.officer);
    const steps = shown.entries
      .find((one) => one.requestId === id)!
      .trail.filter((step) => step.kind === 'WITHDRAWAL');

    expect(steps.map((step) => step.comment)).toEqual([
      'I came back early',
      'Back at work from tomorrow',
    ]);
    expect(steps.every((step) => step.by !== null && step.at !== null)).toBe(true);
  });
});
