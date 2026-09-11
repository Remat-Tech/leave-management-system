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
import { DailyApproverReminders } from '../../src/features/notification/reminder.job.js';
import { recordingDenials } from '../support/recording-denials.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { recordingNotices } from '../support/recording-notices.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';
import { calendarDateIn, dayAfter } from '../../src/shared/time.js';

/**
 * The approver is chased every day until they decide. FR 50, FR 60, §7.1. LMS 330.
 *
 * ../unit/reminder.test.ts proves what a reminder says. What needs a server is everything
 * the story's three criteria are actually about:
 *
 *   **Every pending item, every day, until it is actioned.** Which means the desk is
 *   resolved the way the decide door resolves it — the requester is never chased about their
 *   own leave, both people at a shared desk are, a delegate covering for an approver is, and
 *   a request that has been decided is chased nobody about.
 *
 *   **Once a day and not twice.** The job is safe to run again after a half-finished morning,
 *   and the only thing that makes it so is the notices it has already written.
 *
 *   **Reminders never approve anything.** The status, the desk, the decisions and the balance
 *   are all read back after a run and none of them has moved.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('reminder integration fixtures');
const nightly = theSystem('the daily approver reminder');

const denials = recordingDenials();
const guard = new Guard(denials);
const undelivered = recordingNotices();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let notifications: NotificationService;
let notices: NotificationRepository;
let reminders: DailyApproverReminders;
let mailer: RecordingMailer;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six that the other suites use. */
const FROM = '2026-03-02';
const TO = '2026-03-10';

/**
 * Two mornings, so "again tomorrow" is a day the job is told about rather than a wait.
 *
 * Real days rather than fixture ones: a notice is stamped `now()` by the table, so the day
 * a run is *for* has to be the day its reminders are actually written on for "already
 * reminded today" to mean anything.
 */
const TODAY = calendarDateIn(new Date(), 'UTC');
const TOMORROW = dayAfter(TODAY);

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
    new AttachmentRepository(db),
    new RoleRepository(db),
    /** FR 49, LMS 327. */
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    notifications,
  );

  reminders = new DailyApproverReminders(requests, notifications);
});

beforeEach(async () => {
  /* FR 18, LMS 308. The fixture week is months behind today, as in every leave suite here. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'approval_delegation, attachment_access, attachment_download_link, leave_request_attachment, leave_request_decision, ' +
      'leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request',
  );

  denials.clear();
  undelivered.clear();
  mailer.clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;

  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  /* Annual leave's chain as the migration wrote it: the manager, then HR. */
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
    /** FR 17, LMS 307. */
    acknowledgesShortNotice: true,
    ...overrides,
  };
}

async function submit(): Promise<string> {
  const submitted = await requests.submit(asThemselves(), aRequest());
  return submitted.request.id;
}

/** The reminders one person has been sent, oldest first. */
async function remindersFor(employeeId: string) {
  return (await notices.forEmployee(employeeId))
    .filter((notice) => notice.event === 'STILL_WAITING')
    .reverse();
}

/* -------------------------------------------------- every pending item, every day */

describe('a request waiting at a desk chases the person it is waiting on', () => {
  it('reminds the manager, on both channels', async () => {
    const id = await submit();
    mailer.clear();

    const run = await reminders.run(nightly, TODAY);

    expect(run.requestsWaiting).toBe(1);
    expect(run.reminded).toHaveLength(1);
    expect(run.reminded[0]).toMatchObject({
      leaveRequestId: id,
      employeeId: people.teamLead,
      emailed: true,
    });

    const [reminder] = await remindersFor(people.teamLead);

    expect(reminder.leaveRequestId).toBe(id);
    expect(reminder.readAt).toBeNull();
    expect(reminder.emailedAt).toBeInstanceOf(Date);
    expect(reminder.emailFailure).toBeNull();
    expect(reminder.subject).toContain('is still waiting on you');

    /* One composition, two channels — the same rule every other notice is held to. */
    expect(mailer.last().to).toBe('kofi.boateng@rematholdings.com');
    expect(mailer.last().subject).toBe(reminder.subject);
    expect(mailer.last().text).toBe(reminder.body);
  });

  /* The story is written from the requester's side and the reminder is not sent to them:
     being told nothing has happened to your own request is not news. */
  it('and never the person who asked for the leave', async () => {
    await submit();

    await reminders.run(nightly, TODAY);

    expect(await remindersFor(people.officer)).toHaveLength(0);
  });

  /* FR 38a, FR 48d. Two people staff the HR desk, and a request sitting there is waiting on
     both of them — chasing one and calling it done is how a fortnight passes. */
  it('and everybody at a shared desk, once the stage before it has signed', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);

    const run = await reminders.run(nightly, TODAY);

    expect(run.reminded.map((one) => one.employeeId).sort()).toEqual(
      [people.headOfHr, people.hrOfficer].sort(),
    );

    /* And the manager who has already signed is not chased about it again. */
    expect(await remindersFor(people.teamLead)).toHaveLength(0);
  });

  /* FR 49, LMS 327. A delegate is at the desk for as long as the nomination runs, so the
     chase follows the cover rather than the name on the reporting line. */
  it('and a colleague covering for an approver, as well as the approver', async () => {
    const id = await submit();

    await delegationService(db, guard).nominate(asTheirManager(), {
      approverId: people.teamLead,
      delegateId: people.opsManager,
      from: TODAY,
      to: TOMORROW,
      because: 'Annual leave',
    });

    const run = await reminders.run(nightly, TODAY);

    expect(run.reminded.map((one) => one.employeeId).sort()).toEqual(
      [people.opsManager, people.teamLead].sort(),
    );

    expect((await remindersFor(people.opsManager))[0].leaveRequestId).toBe(id);
  });

  /* "Until actioned", read the only way that can be checked: a decided request is waiting
     on nobody, so a run finds nothing to chase. */
  it('and stops the moment every desk has decided', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);
    await requests.approve(asOfficer(), id);

    const run = await reminders.run(nightly, TODAY);

    expect(run.requestsWaiting).toBe(0);
    expect(run.reminded).toEqual([]);
  });

  /* A draft is not a pending approval: nobody has been asked for anything. */
  it('and a request nobody has submitted is not waiting on anybody', async () => {
    const run = await reminders.run(nightly, TODAY);

    expect(run.requestsWaiting).toBe(0);
    expect(mailer.sent).toEqual([]);
  });
});

/* ------------------------------------------------------------ once a day, and again tomorrow */

describe('the daily cadence', () => {
  it('chases nobody twice in one day, however often the job runs', async () => {
    const id = await submit();

    await reminders.run(nightly, TODAY);
    const second = await reminders.run(nightly, TODAY);

    expect(second.reminded).toEqual([]);
    expect(second.notReminded).toEqual([
      { leaveRequestId: id, employeeId: people.teamLead, because: 'ALREADY_REMINDED_TODAY' },
    ]);

    expect(await remindersFor(people.teamLead)).toHaveLength(1);
  });

  /* The story's first criterion. Nothing decided it overnight, so it is chased again. */
  it('and chases again the next morning', async () => {
    await submit();

    await reminders.run(nightly, TODAY);
    const tomorrow = await reminders.run(nightly, TOMORROW);

    expect(tomorrow.reminded).toHaveLength(1);
    expect(await remindersFor(people.teamLead)).toHaveLength(2);
  });

  /* Each day's is composed afresh and says how long it has been, which is the sentence the
     story's "so that" is about. Two identical messages would be one message sent twice. */
  it('and each one says how long the person has been waiting', async () => {
    await submit();

    await reminders.run(nightly, TODAY);
    await reminders.run(nightly, TOMORROW);

    const [first, second] = await remindersFor(people.teamLead);

    expect(first.body).toContain('today, and it is waiting on you.');
    expect(second.body).toContain('1 day ago');
    expect(second.body).toContain('still waiting on you');
  });

  /* A mail server that will not take it must not stop the run, and must leave a record: the
     notice is written either way, which is what makes the failure answerable. */
  it('and a refused email leaves the notice written and the failure recorded', async () => {
    await submit();
    mailer.failNext();

    const run = await reminders.run(nightly, TODAY);

    expect(run.reminded[0].emailed).toBe(false);

    const [reminder] = await remindersFor(people.teamLead);

    expect(reminder.emailedAt).toBeNull();
    expect(reminder.emailFailure).toContain('SMTP');
    expect(undelivered.last()?.event).toBe('STILL_WAITING');
  });
});

/* --------------------------------------------------------- and it decides nothing */

describe('a reminder approves nothing', () => {
  it('leaves the request exactly where it was', async () => {
    const id = await submit();

    const before = await requests.byId(asThemselves(), id);

    await reminders.run(nightly, TODAY);
    await reminders.run(nightly, TOMORROW);

    const after = await requests.byId(asThemselves(), id);

    expect(after.status).toBe('SUBMITTED');
    expect(after.awaitingApprovalFrom).toBe('MANAGER');
    expect(after.updatedAt).toEqual(before.updatedAt);

    /* Nobody decided, so there is no decision — the record a reminder would be forging. */
    expect(await requests.decisionsFor(asThemselves(), id)).toEqual([]);
  });

  it('and moves no day of anybody’s balance', async () => {
    await submit();

    const held = await new BalanceRepository(db).forKeys([
      { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id },
    ]);

    await reminders.run(nightly, TODAY);

    expect(
      await new BalanceRepository(db).forKeys([
        { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id },
      ]),
    ).toEqual(held);
  });

  /* No ledger entry, which is the other half of "moved no day" and the one a cached balance
     could hide. §7.4. */
  it('and writes nothing to the ledger', async () => {
    await submit();

    const { rows: before } = await admin.query('SELECT count(*) FROM leave_ledger_entry');

    await reminders.run(nightly, TODAY);

    const { rows: after } = await admin.query('SELECT count(*) FROM leave_ledger_entry');

    expect(after[0].count).toBe(before[0].count);
  });
});

/* ------------------------------------------------------------------- who may run it */

describe('who may chase the company', () => {
  it('is nobody with an ordinary login, however many people report to them', async () => {
    await submit();
    mailer.clear();

    await expect(reminders.run(asTheirManager(), TODAY)).rejects.toThrow(NotAuthorised);

    expect(denials.last()?.action).toBe('chaseTheCompany');
    expect(mailer.sent).toEqual([]);
  });

  /* HR is asked about this the moment somebody says nobody has answered them. */
  it('and is HR, as well as the job itself', async () => {
    await submit();

    const run = await reminders.run(asOfficer(), TODAY);

    expect(run.reminded).toHaveLength(1);
  });

  /* A notice is one person's post, and a reminder is a notice: reading whose chases have
     gone out is not something a colleague may do. */
  it('and reading which chases have gone is the same standing', async () => {
    await expect(
      notifications.remindersSince(asTheirManager(), new Date('2026-02-14T00:00:00Z')),
    ).rejects.toThrow(NotAuthorised);
  });
});
