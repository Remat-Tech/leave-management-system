import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { AUDITED_ENTITIES } from '../../src/features/audit/audit.js';
import {
  type NewLeaveRequest,
  NotEnoughDays,
} from '../../src/features/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { NOTICE_EVENTS, NoticeNotFound } from '../../src/features/notification/notification.js';
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
import {
  noticeEmail,
  NotificationService,
} from '../../src/features/notification/notification.service.js';
import { recordingDenials } from '../support/recording-denials.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { recordingNotices } from '../support/recording-notices.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Being told what happened to your leave. FR 59, §7.1. LMS 329.
 *
 * ../unit/notification.test.ts proves what a message says. What needs a server is everything
 * else the story is about:
 *
 *   **Every verb tells somebody.** Submission, both kinds of approval, a refusal, a
 *   withdrawal and a cancellation, each walked through the real service against a real
 *   chain, and each producing exactly one notice with the right event on it.
 *
 *   **After the transaction commits, and this suite can prove it.** The mailer here reads
 *   the leave request back **on a second connection** at the moment it is asked to send.
 *   A message composed inside the transaction would find the row still saying SUBMITTED, or
 *   would block on it; a message composed after the commit finds APPROVED. That assertion is
 *   the story's third criterion, and no pure function and no source-reading test can make it.
 *
 *   **Nothing about notifying can break the thing it describes.** A mail server that refuses
 *   the message must leave the approval standing, the notice written, and the failure
 *   recorded — which is three facts about one transaction boundary.
 *
 *   **A notice is somebody's post.** The policy is the narrowest in `/auth` and the only way
 *   to show that is to try it as the line manager and as HR, both of whom may read the
 *   request itself.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('notification integration fixtures');

const denials = recordingDenials();
const guard = new Guard(denials);
const undelivered = recordingNotices();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let notifications: NotificationService;
let notices: NotificationRepository;
let mailer: RecordingMailer;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six that ./leave-request.test.ts uses. */
const FROM = '2026-03-02';
const TO = '2026-03-10';

const WHY_NOT = 'Two of the team are already away that week and the desk cannot be empty';

/** FR 44. What HR writes when policy prevails over a local decision. LMS 318. */
const BECAUSE_POLICY = 'Her carry-over expires this month and cover is HR’s to arrange';

/**
 * What the request looked like from another connection at the moment the email was sent.
 *
 * This is the whole of the "after the transaction commits" proof and it is worth being
 * plain about why it works. `admin` is a second session. Inside `BalanceService`'s
 * transaction the new status is invisible to it — that is what a transaction is — so a
 * notification composed and sent from inside one would read `SUBMITTED`, or nothing at all
 * for a request that had not been inserted yet. Read after the commit, it reads what
 * committed.
 */
const statusesSeenWhileSending: (string | null)[] = [];

/** The request the test is currently acting on, for the watching mailer to look up. */
let lastRequestId: string | null = null;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  notices = new NotificationRepository(db);
  mailer = watchingMailer();
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
    /** FR 48b, LMS 320. */
    new LeaveRoutingRepository(db),
    /** FR 47, LMS 324. */
    new WithdrawalRepository(db),
    new RoleRepository(db),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    notifications,
  );
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request',
  );

  denials.clear();
  undelivered.clear();
  mailer.clear();
  statusesSeenWhileSending.length = 0;

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;

  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  /* Annual leave's chain as the migration wrote it: the line manager, then HR. Restored the
     way ./leave-request.test.ts restores it, because these files share one database. */
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
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request',
  );

  await db?.destroy();
  await admin?.end();
});

/**
 * A recording mailer that asks the database what it can see, from another session, at the
 * instant it is handed a message. See {@link statusesSeenWhileSending}.
 *
 * The read goes through `admin`, which is a second connection and therefore outside
 * whatever transaction the application may be in. That is the whole mechanism: a message
 * composed inside `BalanceService`'s transaction would find the row unchanged here, or
 * would find nothing at all for a request that had not been committed yet.
 */
function watchingMailer(): RecordingMailer {
  const inner = recordingMailer();

  return {
    ...inner,
    async send(mail) {
      const { rows } = await admin.query<{ status: string }>(
        'SELECT status FROM leave_request WHERE id = $1',
        [lastRequestId],
      );

      statusesSeenWhileSending.push(rows[0]?.status ?? null);

      return inner.send(mail);
    },
  };
}

function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asAColleague() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

function aRequest(overrides: Partial<NewLeaveRequest> = {}): NewLeaveRequest {
  return {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: FROM,
    to: TO,
    reason: 'My sister is getting married',
    ...overrides,
  };
}

/** Submits, and remembers the id so the watching mailer can look the row up. */
async function submit(): Promise<string> {
  const submitted = await requests.submit(asThemselves(), aRequest());
  lastRequestId = submitted.request.id;
  return submitted.request.id;
}

/** Every notice this person has been sent, oldest first. */
async function noticesFor(employeeId = people.officer) {
  return (await notices.forEmployee(employeeId)).reverse();
}

/* --------------------------------------------------- every verb tells the requester */

describe('what happens to a request reaches the person who asked', () => {
  it('a submission is confirmed, on both channels', async () => {
    const id = await submit();

    const [notice] = await noticesFor();

    expect(notice.event).toBe('SUBMITTED');
    expect(notice.employeeId).toBe(people.officer);
    expect(notice.leaveRequestId).toBe(id);
    expect(notice.readAt).toBeNull();
    expect(notice.emailedAt).toBeInstanceOf(Date);
    expect(notice.emailFailure).toBeNull();

    /* The in-app message and the emailed one are one composition. */
    expect(mailer.last().subject).toBe(notice.subject);
    expect(mailer.last().text).toBe(notice.body);
    expect(mailer.last().to).toBe('adwoa.frimpong@rematholdings.com');
  });

  /* The story's "each decision", and the half that matters: a stage is not an approval. */
  it('an approval at the first of two desks says the leave is not agreed yet', async () => {
    const id = await submit();
    mailer.clear();

    await requests.approve(asTheirManager(), id);

    const notice = (await noticesFor())[1];

    expect(notice.event).toBe('STAGE_APPROVED');
    expect(notice.subject).toContain('Your line manager approved');
    expect(notice.subject).toContain('it still needs HR');
    expect(notice.body).toContain('do not book anything on it');
    expect(mailer.sent).toHaveLength(1);
  });

  it('and the last desk saying yes says it is agreed and yours to take', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);
    mailer.clear();

    await requests.approve(asOfficer(), id);

    const notice = (await noticesFor())[2];

    expect(notice.event).toBe('APPROVED');
    expect(notice.body).toContain('is agreed and is yours to take');
    expect(notice.body).toContain('The 6 days have come off your balance.');
    expect(notice.body).toContain('You have 14 days to book.');
  });

  /* FR 39. The reason reaches the person, in the words the approver wrote, which is the
     whole of what LMS 315 recorded and this delivers. */
  it('a refusal carries the reason and says the days are back', async () => {
    const id = await submit();
    mailer.clear();

    await requests.refuse(asTheirManager(), id, WHY_NOT);
    await requests.refuse(asOfficer(), id, WHY_NOT);

    const notice = (await noticesFor())[2];

    expect(notice.event).toBe('REFUSED');
    expect(notice.body).toContain(WHY_NOT);
    expect(notice.body).toContain('The 6 days are back in your balance.');
    expect(notice.body).toContain('You have 20 days to book.');
    expect(mailer.last().text).toContain(WHY_NOT);
  });

  /**
   * And a rejection that is not the end of it says so. FR 44, §7.2. LMS 318.
   *
   * The counterpart of a stage approval, and it exists for the same reason: "turned down,
   * your days are back" would be wrong in both halves while HR still has to decide, and it
   * is the sentence somebody stops reading after.
   */
  it('and a rejection partway along says the days are still held and HR has it', async () => {
    const id = await submit();
    mailer.clear();

    await requests.refuse(asTheirManager(), id, WHY_NOT);

    const notice = (await noticesFor())[1];

    expect(notice.event).toBe('STAGE_REFUSED');
    expect(notice.subject).toContain('it has gone to HR');
    expect(notice.body).toContain(WHY_NOT);
    expect(notice.body).toContain('That is not the end of it.');
    expect(notice.body).toContain('Your balance has not moved');
  });

  /**
   * And the line manager is told when HR overturns them. FR 44's fifth criterion. LMS 318.
   *
   * The one notice in this system addressed to somebody other than the person taking the
   * leave, and it quotes HR's justification whole — which is the whole of what the manager
   * is owed for a decision that was reversed over their head.
   */
  it('and the line manager is told when HR overturns their rejection', async () => {
    const id = await submit();
    mailer.clear();

    await requests.refuse(asTheirManager(), id, WHY_NOT);
    await requests.override(asOfficer(), id, 'OVERTURN_REJECTION', BECAUSE_POLICY);

    const [theirs] = await noticesFor(people.teamLead);

    expect(theirs.event).toBe('DECISION_OVERTURNED');
    expect(theirs.employeeId).toBe(people.teamLead);
    expect(theirs.subject).toContain('overturned your decision');
    expect(theirs.body).toContain(BECAUSE_POLICY);

    /* And the person who asked is told too, and told the leave is theirs to take. */
    const hers = (await noticesFor())[2];

    expect(hers.event).toBe('APPROVED');
    expect(hers.employeeId).toBe(people.officer);
  });

  it('a withdrawal reaches the person who made it', async () => {
    const id = await submit();

    await requests.withdraw(asThemselves(), id);

    const notice = (await noticesFor())[1];

    expect(notice.event).toBe('WITHDRAWN');
    expect(notice.body).toContain('The 6 days are back in your balance.');
  });

  /* FR 46 and LMS 323: a withdrawal works at every desk, and so does the notice about it. */
  it('including one taken back after an approver has already signed', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);

    await requests.withdraw(asThemselves(), id);

    const events = (await noticesFor()).map((notice) => notice.event);

    expect(events).toEqual(['SUBMITTED', 'STAGE_APPROVED', 'WITHDRAWN']);
  });

  it('a cancellation says plainly that nobody turned anything down', async () => {
    const id = await submit();

    await requests.cancel(asOfficer(), id);

    const notice = (await noticesFor())[1];

    expect(notice.event).toBe('CANCELLED');
    expect(notice.body).toContain('nobody has turned anything down');
  });

  /* One notice per thing that happened, and no notice for anything that did not. */
  it('and a whole life produces one notice per event, in order', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);
    await requests.approve(asOfficer(), id);

    const sent = await noticesFor();

    expect(sent.map((notice) => notice.event)).toEqual(['SUBMITTED', 'STAGE_APPROVED', 'APPROVED']);
    expect(sent.every((notice) => notice.leaveRequestId === id)).toBe(true);
    expect(mailer.sent).toHaveLength(3);
  });
});

/* -------------------------------------------- after the transaction, never inside it */

describe('a notice goes out after the transaction commits', () => {
  /**
   * The story's third criterion, proved from a second connection.
   *
   * Every one of these statuses is what `admin` — a different session — could see at the
   * moment the mailer was handed the message. Inside `BalanceService`'s transaction they
   * would read SUBMITTED throughout, because that is what a transaction means.
   */
  it('so a second connection can already see what the message describes', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);
    await requests.approve(asOfficer(), id);

    expect(statusesSeenWhileSending).toEqual(['SUBMITTED', 'SUBMITTED', 'APPROVED']);
  });

  it('and an ending is committed before its notice is sent too', async () => {
    const id = await submit();
    statusesSeenWhileSending.length = 0;

    /* FR 44, LMS 318. Two rejections, because the manager's carries the request on to HR —
       so the pair also shows the intermediate one being read as `SUBMITTED`, which is what
       committed at that moment. */
    await requests.refuse(asTheirManager(), id, WHY_NOT);
    await requests.refuse(asOfficer(), id, WHY_NOT);

    expect(statusesSeenWhileSending).toEqual(['SUBMITTED', 'REFUSED']);
  });

  /* And the mirror: nothing that did not happen is announced. A submission the balance
     cannot take never reaches the door, so there is nothing to tell anybody about. */
  it('and a request that was refused before it was written tells nobody', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-04-01', to: '2026-06-30' })),
    ).rejects.toThrow(NotEnoughDays);

    expect(await noticesFor()).toEqual([]);
    expect(mailer.sent).toEqual([]);
    expect(undelivered.failures).toEqual([]);
  });
});

/* --------------------------------- and it cannot break the thing it is describing */

describe('a mail server that is not answering', () => {
  it('does not stop the leave being approved', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);

    mailer.failNext(new Error('connect ECONNREFUSED 127.0.0.1:1025'));

    const approved = await requests.approve(asOfficer(), id);

    expect(approved.request.status).toBe('APPROVED');
    expect(approved.entry).not.toBeNull();
  });

  it('and the person still has the notice waiting when they next look', async () => {
    const id = await submit();
    await requests.refuse(asTheirManager(), id, WHY_NOT);

    mailer.failNext(new Error('connect ECONNREFUSED 127.0.0.1:1025'));

    await requests.refuse(asOfficer(), id, WHY_NOT);

    const notice = (await noticesFor())[2];

    expect(notice.event).toBe('REFUSED');
    expect(notice.body).toContain(WHY_NOT);
    expect(notice.emailedAt).toBeNull();
    expect(notice.emailFailure).toBe('connect ECONNREFUSED 127.0.0.1:1025');
  });

  /* Caught, and carried rather than swallowed — the same arrangement the reconciliation
     job's alert makes, and for the sharper reason: this is the only record that somebody
     was not told. */
  it('and the failure is recorded where an operator will find it', async () => {
    const id = await submit();
    mailer.failNext(new Error('Mailbox unavailable'));

    await requests.withdraw(asThemselves(), id);

    expect(undelivered.last()).toMatchObject({
      employeeId: people.officer,
      leaveRequestId: id,
      event: 'WITHDRAWN',
      stage: 'email',
      because: 'Mailbox unavailable',
    });
  });
});

/* ------------------------------------------------------- a notice is somebody's post */

describe('who may read a notification', () => {
  it('the person it was sent to', async () => {
    await submit();

    const theirs = await notifications.forEmployee(asThemselves(), people.officer);

    expect(theirs).toHaveLength(1);
    expect(theirs[0].event).toBe('SUBMITTED');
  });

  /* The line manager may read the request, the decisions and the balance. Not the post. */
  it('and not their line manager, who may read everything else about the request', async () => {
    await submit();

    await expect(notifications.forEmployee(asTheirManager(), people.officer)).rejects.toThrow(
      NotAuthorised,
    );
  });

  /* Nor a role that reads every record, which is on every other reading decision in /auth. */
  it('and not HR either', async () => {
    await submit();

    await expect(notifications.forEmployee(asOfficer(), people.officer)).rejects.toThrow(
      NotAuthorised,
    );
  });

  it('and certainly not a colleague', async () => {
    await submit();

    await expect(notifications.forEmployee(asAColleague(), people.officer)).rejects.toThrow(
      NotAuthorised,
    );
  });

  /* Silently, so a guessed id does not confirm that somebody has post. */
  it('and the refusal says nothing about whose it was', async () => {
    await submit();

    await expect(notifications.forEmployee(asOfficer(), people.officer)).rejects.toThrow(
      NOT_AUTHORISED_MESSAGE,
    );

    expect(denials.last()).toMatchObject({ resource: 'notification', action: 'read' });
  });

  /* theSystem holds every role and is nobody, so it fails `isSelf` like anybody else.
     Nothing unattended has business reading a person's messages. */
  it('and not the system, which holds every role', async () => {
    await submit();

    await expect(notifications.forEmployee(system, people.officer)).rejects.toThrow(NotAuthorised);
  });

  it('and one notice by id is the same rule', async () => {
    await submit();

    const [notice] = await noticesFor();

    expect((await notifications.byId(asThemselves(), notice.id)).id).toBe(notice.id);
    await expect(notifications.byId(asOfficer(), notice.id)).rejects.toThrow(NotAuthorised);
  });

  it('and a notice nobody has is not found', async () => {
    await expect(notifications.byId(asThemselves(), '999999')).rejects.toThrow(NoticeNotFound);
  });
});

/* ------------------------------------------------------------------- the bell itself */

describe('reading and unreading', () => {
  it('counts what has not been seen', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);

    expect(await notifications.unreadCountFor(asThemselves(), people.officer)).toBe(2);
  });

  it('and marking one read takes it off the count', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);

    const [first] = await noticesFor();
    const read = await notifications.markRead(asThemselves(), first.id);

    expect(read.readAt).toBeInstanceOf(Date);
    expect(await notifications.unreadCountFor(asThemselves(), people.officer)).toBe(1);

    const unread = await notifications.forEmployee(asThemselves(), people.officer, {
      unreadOnly: true,
    });

    expect(unread.map((notice) => notice.id)).not.toContain(first.id);
  });

  /* An ordinary thing to want, and the reason the trigger lets this column move both ways. */
  it('and it can be put back to unread', async () => {
    await submit();

    const [first] = await noticesFor();

    await notifications.markRead(asThemselves(), first.id);
    const back = await notifications.markRead(asThemselves(), first.id, null);

    expect(back.readAt).toBeNull();
    expect(await notifications.unreadCountFor(asThemselves(), people.officer)).toBe(1);
  });

  it('and only the person it was sent to can have read it', async () => {
    await submit();

    const [first] = await noticesFor();

    await expect(notifications.markRead(asOfficer(), first.id)).rejects.toThrow(NotAuthorised);
    expect(denials.last()).toMatchObject({ resource: 'notification', action: 'markRead' });
  });
});

/* --------------------------------------------------------- what the schema holds still */

describe('the table itself', () => {
  /* The domain list and the CHECK cannot be extended alone. */
  it('holds the same six events the domain does', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'notification_event_known'`,
    );

    expect(rows).toHaveLength(1);

    for (const event of NOTICE_EVENTS) {
      expect(rows[0].definition).toContain(`'${event}'`);
    }

    /* And nothing the domain does not know about. The definition names one literal per
       permitted value, so counting them is counting the list. */
    expect(rows[0].definition.match(/'[A-Z_]+'/g)).toHaveLength(NOTICE_EVENTS.length);
  });

  /* What somebody was told is not edited afterwards. They have already read it. */
  it('refuses to reword a notice, on the owner connection', async () => {
    await submit();

    const [notice] = await noticesFor();

    await expect(
      admin.query('UPDATE notification SET body = $1 WHERE id = $2', ['Never mind', notice.id]),
    ).rejects.toThrow(/record of what somebody was told/);
  });

  it('and refuses to delete one', async () => {
    await submit();

    const [notice] = await noticesFor();

    await expect(
      admin.query('DELETE FROM notification WHERE id = $1', [notice.id]),
    ).rejects.toThrow(/never deleted/);
  });

  /* A message is sent once, so what somebody received and when stays answerable. */
  it('and refuses to record what became of the email twice', async () => {
    await submit();

    const [notice] = await noticesFor();

    expect(notice.emailedAt).toBeInstanceOf(Date);

    await expect(
      admin.query('UPDATE notification SET emailed_at = now() WHERE id = $1', [notice.id]),
    ).rejects.toThrow(/already recorded what became of its email/);
  });

  /* The application may move three columns and no others, which is the grant rather than
     the trigger — two layers, as the migration says. */
  it('and lets the application move only the three columns it is granted', async () => {
    const { rows } = await admin.query<Record<string, boolean>>(
      `SELECT has_column_privilege('lms_app', 'notification', 'read_at', 'UPDATE')  AS read_at,
              has_column_privilege('lms_app', 'notification', 'emailed_at', 'UPDATE') AS emailed,
              has_column_privilege('lms_app', 'notification', 'body', 'UPDATE')     AS body,
              has_column_privilege('lms_app', 'notification', 'event', 'UPDATE')    AS event,
              has_table_privilege('lms_app', 'notification', 'DELETE')              AS del`,
    );

    expect(rows[0]).toEqual({
      read_at: true,
      emailed: true,
      body: false,
      event: false,
      del: false,
    });
  });

  /* Declined deliberately; the migration argues why. A log of every glance at a bell is a
     log nobody reads. */
  it('and is not audited', async () => {
    expect(AUDITED_ENTITIES).not.toContain('notification');

    const { rows } = await admin.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'notification'::regclass
          AND NOT tgisinternal
          AND tgname LIKE '%audit%'`,
    );

    expect(rows).toEqual([]);
  });
});

/* ----------------------------------------------------------------- the envelope */

describe('the email', () => {
  it('is the notice and nothing added to it', async () => {
    await submit();

    const [notice] = await noticesFor();
    const mail = noticeEmail('adwoa.frimpong@rematholdings.com', notice);

    expect(mail).toEqual({
      to: 'adwoa.frimpong@rematholdings.com',
      subject: notice.subject,
      text: notice.body,
    });
    expect(mail).not.toHaveProperty('html');
  });

  /* No link, for the reason codeEmail carries none: an email about leave that trains staff
     to click through is the template every phishing attempt against them will use. */
  it('and carries no link', async () => {
    const id = await submit();
    await requests.approve(asTheirManager(), id);
    await requests.approve(asOfficer(), id);

    for (const mail of mailer.sent) {
      expect(mail.text).not.toMatch(/https?:\/\//);
    }
  });
});
