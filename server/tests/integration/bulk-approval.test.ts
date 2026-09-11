import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { type Actor, signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  NotABulkAction,
  TooManyToDecideAtOnce,
} from '../../src/features/leave-request/bulk-decision.js';
import { RefusalNeedsAComment } from '../../src/features/leave-request/leave-decision.js';
import { type LeaveRequest, versionOf } from '../../src/features/leave-request/leave-request.js';
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
 * Clearing a queue in one press. FR 51. LMS 328.
 *
 * A manager back from a week away has a queue rather than a request, and this is the door that
 * answers all of it at once. What this suite holds:
 *
 *   **Every row is decided as the single door would have decided it.** The desk, the chain,
 *   the comment and the days are the same, because a batch calls the same method.
 *
 *   **The self-approval check applies to every item**, which is the story's second criterion.
 *   One of the manager's own among ten does not go through, and does not stop the other nine.
 *
 *   **One row that cannot be decided leaves the rest alone.** A request somebody answered
 *   while the queue was open is reported and skipped rather than taking the press down.
 *
 * ../unit/bulk-decision.test.ts proves the door's own checks against invented rows.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('bulk approval integration fixtures');
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

/** Three weeks nobody's leave overlaps in. */
const FIRST = { from: '2026-03-02', to: '2026-03-06' };
const SECOND = { from: '2026-03-16', to: '2026-03-20' };
const THIRD = { from: '2026-04-06', to: '2026-04-10' };

/** FR 39. One reason, on every refusal in the batch. */
const WHY_NOT = 'Two of the team are already away that week, and the rota cannot take a third.';

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

  for (const employeeId of [people.officer, people.partTimer, people.teamLead]) {
    await balances.grantTheYear(system, {
      employeeId,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'Annual entitlement for 2026',
    });
  }
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
      'attachment_access, attachment_download_link, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, ' +
      'leave_request_routing, leave_request_withdrawal, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

/** One request, asked for by the person taking the leave. Returns the row as it was written. */
async function aRequestFrom(
  employeeId: string,
  period: { from: string; to: string },
): Promise<LeaveRequest> {
  const { request } = await requests.submit(asThemselves(employeeId), {
    employeeId,
    leaveTypeId: annualId,
    from: period.from,
    to: period.to,
    reason: 'My sister is getting married',
    /** FR 17, LMS 307. The fixture weeks are behind today. */
    acknowledgesShortNotice: true,
  });

  return request;
}

/** Three of Kofi's team's requests, all waiting on his desk. */
async function aQueueOfThree(): Promise<LeaveRequest[]> {
  return [
    await aRequestFrom(people.officer, FIRST),
    await aRequestFrom(people.partTimer, FIRST),
    await aRequestFrom(people.officer, SECOND),
  ];
}

/** The rows as a queue screen would hand them back. NFR DAT 02, LMS 326. */
function asSelected(...found: LeaveRequest[]): { requestId: string; version: string }[] {
  return found.map((one) => ({ requestId: one.id, version: versionOf(one) }));
}

async function statusOf(requestId: string): Promise<LeaveRequest> {
  return (await requests.byId(system, requestId))!;
}

async function balanceOf(employeeId: string): Promise<{ taken: number; pending: number }> {
  const balance = await balances.forOne(system, {
    employeeId,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
  });

  return { taken: balance.taken, pending: balance.pending };
}

/** Whoever is asking for their own leave. */
function asThemselves(employeeId: string): Actor {
  return signedInAs(employeeId, {
    roles: ['EMPLOYEE'],
    isManager: employeeId === people.teamLead,
  });
}

/** Kofi Boateng, the team lead — the `MANAGER` desk for the three above. */
function asTheirManager(): Actor {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

/** Ama Mensah, the head of HR — the desk they go to next. */
function asTheHeadOfHr(): Actor {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

/* ------------------------------------------------------------ several at one press */

describe('a queue cleared in one press', () => {
  /** The story's first criterion. */
  it('decides every request in the selection', async () => {
    const queue = await aQueueOfThree();

    const answered = await requests.decideMany(asTheirManager(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(...queue),
    });

    expect(answered.decided).toHaveLength(3);
    expect(answered.undecided).toEqual([]);
    expect(answered.inWords).toBe('3 requests approved.');

    /* Each is where a single approval would have left it: past the manager's desk, waiting
       on HR, with its days still held. FR 38a. */
    for (const request of queue) {
      const now = await statusOf(request.id);

      expect(now.status).toBe('SUBMITTED');
      expect(now.awaitingApprovalFrom).toBe('HR');

      const said = await decisions.forRequest(request.id);

      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ action: 'APPROVE', onBehalfOf: 'MANAGER' });
      expect(said[0].decidedByEmployeeId).toBe(people.teamLead);
    }
  });

  /** And the last desk's yes moves the days, once each. */
  it('and the days move once per request when the last desk clears them', async () => {
    const queue = await aQueueOfThree();

    await requests.decideMany(asTheirManager(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(...queue),
    });

    const atHr = await Promise.all(queue.map((one) => statusOf(one.id)));

    const answered = await requests.decideMany(asTheHeadOfHr(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(...atHr),
    });

    expect(answered.decided).toHaveLength(3);

    for (const request of queue) {
      expect((await statusOf(request.id)).status).toBe('APPROVED');
    }

    /* Adwoa asked twice and Abena once, and every day is taken rather than held. */
    const adwoa = await balanceOf(people.officer);
    const abena = await balanceOf(people.partTimer);

    expect(adwoa.pending).toBe(0);
    expect(adwoa.taken).toBe(queue[0].days + queue[2].days);
    expect(abena.pending).toBe(0);
    expect(abena.taken).toBe(queue[1].days);

    const { rows } = await admin.query<{ count: string }>(
      "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'DEDUCTION'",
    );

    expect(Number(rows[0].count)).toBe(3);
  });

  /** FR 39. One reason typed once, on every refusal the press wrote. */
  it('and turns several down with one reason on each', async () => {
    const queue = await aQueueOfThree();

    const answered = await requests.decideMany(asTheirManager(), {
      action: 'REFUSE',
      comment: WHY_NOT,
      requests: asSelected(...queue),
    });

    expect(answered.undecided).toEqual([]);
    expect(answered.inWords).toBe('3 requests turned down.');

    for (const request of queue) {
      const said = await decisions.forRequest(request.id);

      expect(said[0]).toMatchObject({ action: 'REFUSE', onBehalfOf: 'MANAGER', comment: WHY_NOT });

      /* FR 44, LMS 318. A rejection at a stage that is not the last sends it on, with the
         days still held — which a batch does not change. */
      expect((await statusOf(request.id)).awaitingApprovalFrom).toBe('HR');
    }
  });
});

/* ------------------------------------------------- the checks the single door makes */

describe('the self-approval check', () => {
  /**
   * The story's second criterion. FR 48, §8.6a, LMS 319.
   *
   * Kofi is an approver and an employee, so his own request is a row an id list can name.
   * It is refused on its own and the two beside it go through — the check is asked of every
   * item rather than of the batch.
   */
  it('applies to every item, and refuses only that one', async () => {
    const [adwoa, abena] = await aQueueOfThree();
    const hisOwn = await aRequestFrom(people.teamLead, THIRD);

    const answered = await requests.decideMany(asTheirManager(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(adwoa, hisOwn, abena),
    });

    expect(answered.decided).toHaveLength(2);
    expect(answered.undecided).toHaveLength(1);
    expect(answered.inWords).toBe(
      '2 of 3 approved. 1 request left where it was, and each says why.',
    );

    const [left] = answered.undecided;

    expect(left.requestId).toBe(hisOwn.id);
    expect(left.because).toBeInstanceOf(NotAuthorised);
    expect((left.because as Error).message).toContain(
      'Leave is decided by somebody other than the person taking it',
    );

    /* Nothing was written against it, and it is still waiting on the desk above him. */
    expect(await decisions.forRequest(hisOwn.id)).toEqual([]);
    expect((await statusOf(hisOwn.id)).awaitingApprovalFrom).toBe('MANAGER');

    /* And the other two are decided, which is the half a batch that stopped would have lost. */
    for (const request of [adwoa, abena]) {
      expect((await statusOf(request.id)).awaitingApprovalFrom).toBe('HR');
    }
  });

  /** Even where it is the only row: a batch of one is not a way round it. */
  it('and refuses a batch of nothing but their own', async () => {
    const hisOwn = await aRequestFrom(people.teamLead, THIRD);

    const answered = await requests.decideMany(asTheirManager(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(hisOwn),
    });

    expect(answered.decided).toEqual([]);
    expect(answered.undecided).toHaveLength(1);
    expect(answered.inWords).toBe(
      'Nothing was approved. 1 request left where it was, and each says why.',
    );
  });
});

describe('a row that cannot be decided', () => {
  /** NFR DAT 02, §8.1, LMS 326. Somebody answered it while the queue was open. */
  it('is reported and skipped, and the rest of the press goes through', async () => {
    const [adwoa, abena, second] = await aQueueOfThree();

    /* Answered singly first, so the version the selection holds has moved on. */
    await requests.approve(asTheirManager(), adwoa.id);

    const answered = await requests.decideMany(asTheirManager(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(adwoa, abena, second),
    });

    expect(answered.decided).toHaveLength(2);
    expect(answered.undecided).toHaveLength(1);

    const [left] = answered.undecided;

    expect(left.requestId).toBe(adwoa.id);
    expect((left.because as Error).name).toBe('LeaveAlreadyDecided');

    /* One decision at that desk, rather than a second one filed by the batch. */
    expect(await decisions.forRequest(adwoa.id)).toHaveLength(1);
  });

  /** FR 44, LMS 318. A plain approval of what the manager turned down is still refused. */
  it('and an item needing an override is refused on its own, naming the verb', async () => {
    const [adwoa, abena] = await aQueueOfThree();

    await requests.refuse(asTheirManager(), adwoa.id, WHY_NOT);
    await requests.approve(asTheirManager(), abena.id);

    const atHr = [await statusOf(adwoa.id), await statusOf(abena.id)];

    const answered = await requests.decideMany(asTheHeadOfHr(), {
      action: 'APPROVE',
      comment: null,
      requests: asSelected(...atHr),
    });

    expect(answered.decided).toHaveLength(1);
    expect((answered.undecided[0].because as Error).name).toBe('OverrulingNeedsAnOverride');

    /* The one that needed no override is approved, and the days moved for it alone. */
    expect((await statusOf(abena.id)).status).toBe('APPROVED');
    expect((await statusOf(adwoa.id)).status).toBe('SUBMITTED');
  });
});

/* ------------------------------------------------- what the door refuses outright */

describe('a batch refused before anything is decided', () => {
  /** FR 39. The comment is owed by the press, and nothing is written without it. */
  it('a refusal with nothing said decides none of them', async () => {
    const queue = await aQueueOfThree();

    await expect(
      requests.decideMany(asTheirManager(), {
        action: 'REFUSE',
        comment: '  ',
        requests: asSelected(...queue),
      }),
    ).rejects.toBeInstanceOf(RefusalNeedsAComment);

    for (const request of queue) {
      expect(await decisions.forRequest(request.id)).toEqual([]);
    }
  });

  /** FR 44. An override is reasoned about one request at a time. */
  it('and an override has no batch', async () => {
    const queue = await aQueueOfThree();

    await expect(
      requests.decideMany(asTheHeadOfHr(), {
        action: 'OVERTURN_REJECTION',
        comment: 'Policy says otherwise',
        requests: asSelected(...queue),
      }),
    ).rejects.toBeInstanceOf(NotABulkAction);
  });

  /** More rows than one press decides, refused before the first of them is read. */
  it('and a selection longer than the cap decides nothing', async () => {
    const queue = await aQueueOfThree();

    const tooMany = [
      ...asSelected(...queue),
      ...Array.from({ length: 60 }, (_, index) => ({
        requestId: `made-up-${String(index)}`,
        version: 'x',
      })),
    ];

    await expect(
      requests.decideMany(asTheirManager(), {
        action: 'APPROVE',
        comment: null,
        requests: tooMany,
      }),
    ).rejects.toBeInstanceOf(TooManyToDecideAtOnce);

    for (const request of queue) {
      expect(await decisions.forRequest(request.id)).toEqual([]);
    }
  });
});
