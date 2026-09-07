import { Client } from 'pg';
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
import { NotAuthorised } from '../../src/auth/policy.js';
import {
  AlreadyDelegated,
  DelegateIsTheApprover,
  DelegationAlreadyEnded,
  InvalidDelegation,
} from '../../src/features/leave-request/delegation.js';
import { ApprovalDelegationRepository } from '../../src/features/leave-request/delegation.db.js';
import { ApprovalDelegationService } from '../../src/features/leave-request/delegation.service.js';
import { ApproverQueueService } from '../../src/features/leave-request/approver-queue.service.js';
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

/**
 * An approver hands their approvals to a colleague while away. FR 49, §8.6a. LMS 327.
 *
 * ../unit/delegation.test.ts proves what a nomination is, which days it covers and which
 * desks it reaches — all pure. What needs a server:
 *
 *   **The requests appear in the delegate's queue.** `LeaveRequestRepository.awaiting`
 *   narrows the `MANAGER` desk by reporting line, so "it is in my queue now" is a claim
 *   about a `WHERE` built from somebody else's reports.
 *
 *   **The delegate can actually decide them**, through the same door and the same locks.
 *
 *   **The decision records both.** `decided_by_employee_id` is stamped by a trigger and
 *   `delegated_for_employee_id` is written beside it, in one row.
 *
 *   **A delegation carries no say over the delegator's own leave**, refused by the service
 *   and again by `leave_request_never_decided_for_the_requester` on every connection.
 *
 *   **One delegate at a time**, which is an exclusion constraint rather than a check.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('delegation integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let delegations: ApprovalDelegationService;
let queue: ApproverQueueService;
let balances: BalanceService;
let decisions: LeaveDecisionRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

/** The same nine days costing six the rest of the suite uses. */
const FROM = '2026-03-02';
const TO = '2026-03-10';

/* The days the team lead is away. Relative to today rather than fixed, because a delegation
   is in force on the day somebody opens their queue rather than on the days of the leave. */
const AWAY_FROM = dayFromToday(-1);
const AWAY_TO = dayFromToday(30);

/** And a nomination that has not started, for the window's other edge. */
const LATER_FROM = dayFromToday(60);
const LATER_TO = dayFromToday(90);

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const balanceRepository = new BalanceRepository(db);
  const organisation = new OrganisationRepository(db);
  const roles = new RoleRepository(db);

  decisions = new LeaveDecisionRepository(db);
  balances = new BalanceService(balanceRepository, guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  delegations = new ApprovalDelegationService(
    new ApprovalDelegationRepository(db),
    guard,
    employees,
    roles,
  );

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    requestRepository,
    decisions,
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new AttachmentRepository(db),
    roles,
    delegations,
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  queue = new ApproverQueueService(
    requestRepository,
    decisions,
    guard,
    employees,
    organisation,
    balanceRepository,
    types,
    yearRepository,
    delegations,
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
      'attachment_access, attachment_download_link, leave_request_attachment, leave_request_decision, leave_request_reassignment, ' +
      'leave_request_routing, leave_request_withdrawal, leave_request',
  );
  await admin.query('TRUNCATE approval_delegation');
}

/* ------------------------------------------------------- an approver nominates one */

describe('an approver nominating a delegate', () => {
  it('hands their approvals over for a date range', async () => {
    const nominated = await delegations.nominate(asTheTeamLead(), {
      approverId: people.teamLead,
      delegateId: people.partTimer,
      from: AWAY_FROM,
      to: AWAY_TO,
      because: 'On leave myself',
    });

    expect(nominated.approverId).toBe(people.teamLead);
    expect(nominated.delegateId).toBe(people.partTimer);
    expect(nominated.revokedAt).toBeNull();
    /** Stamped by the trigger, never supplied. */
    expect(nominated.nominatedBy).toContain(people.teamLead);
    expect(nominated.nominatedAt).toBeInstanceOf(Date);
  });

  /** The approver's own act. Handing out somebody else's authority is nobody's. */
  it('and is refused to everybody but the approver, HR included', async () => {
    await expect(
      delegations.nominate(asTheHeadOfHr(), {
        approverId: people.teamLead,
        delegateId: people.partTimer,
        from: AWAY_FROM,
        to: AWAY_TO,
      }),
    ).rejects.toThrow(NotAuthorised);
  });

  it('and refuses one made to themselves', async () => {
    await expect(
      delegations.nominate(asTheTeamLead(), {
        approverId: people.teamLead,
        delegateId: people.teamLead,
        from: AWAY_FROM,
        to: AWAY_TO,
      }),
    ).rejects.toThrow(DelegateIsTheApprover);
  });

  /** FR 06. A leaver cannot sign in, so a desk handed to one is a desk nothing reaches. */
  it('and refuses a delegate who has left', async () => {
    await expect(
      delegations.nominate(asTheTeamLead(), {
        approverId: people.teamLead,
        delegateId: people.leaver,
        from: AWAY_FROM,
        to: AWAY_TO,
      }),
    ).rejects.toThrow(InvalidDelegation);
  });

  /**
   * And one delegate at a time, held by an exclusion constraint.
   *
   * Two people holding one person's approvals over the same day is a decision recorded
   * under whichever of them pressed first, which is exactly the ambiguity the column
   * `delegated_for_employee_id` exists to remove.
   */
  it('and refuses a second delegate over days a first already covers', async () => {
    await delegations.nominate(asTheTeamLead(), {
      approverId: people.teamLead,
      delegateId: people.partTimer,
      from: '2026-03-01',
      to: '2026-03-31',
    });

    await expect(
      delegations.nominate(asTheTeamLead(), {
        approverId: people.teamLead,
        delegateId: people.officer,
        from: '2026-03-15',
        to: '2026-04-15',
      }),
    ).rejects.toThrow(AlreadyDelegated);

    /** And admits one that starts the day after the first ends. */
    await expect(
      delegations.nominate(asTheTeamLead(), {
        approverId: people.teamLead,
        delegateId: people.officer,
        from: '2026-04-01',
        to: '2026-04-15',
      }),
    ).resolves.toBeDefined();
  });

  /** The constraint holds on the owner connection too, which is where a repair script sits. */
  it('and refuses the overlap whoever is writing', async () => {
    await delegations.nominate(asTheTeamLead(), {
      approverId: people.teamLead,
      delegateId: people.partTimer,
      from: '2026-03-01',
      to: '2026-03-31',
    });

    await expect(
      admin.query(
        'INSERT INTO approval_delegation (approver_employee_id, delegate_employee_id, ' +
          'starts_on, ends_on, nominated_by, nominated_at) VALUES ($1, $2, $3, $4, $5, now())',
        [people.teamLead, people.officer, '2026-03-10', '2026-03-20', 'a repair script'],
      ),
    ).rejects.toThrow(/approval_delegation_one_delegate_at_a_time/);
  });
});

/* --------------------------------------------------------------------- ending one */

describe('ending a delegation', () => {
  it('is the approver’s, and HR’s', async () => {
    const mine = await aDelegationToThePartTimer();
    const ended = await delegations.revoke(asTheTeamLead(), mine.id);

    expect(ended.revokedAt).toBeInstanceOf(Date);

    const hrs = await aDelegationToThePartTimer(LATER_FROM, LATER_TO);

    await expect(delegations.revoke(asTheHeadOfHr(), hrs.id)).resolves.toBeDefined();
  });

  /* Being the delegate is not standing to end it: taking approvals back is the approver's
     decision, and HR's where they cannot be reached. */
  it('and is not the delegate’s', async () => {
    const mine = await aDelegationToThePartTimer();

    await expect(delegations.revoke(asThePartTimer(), mine.id)).rejects.toThrow(NotAuthorised);
  });

  it('and happens once', async () => {
    const mine = await aDelegationToThePartTimer();

    await delegations.revoke(asTheTeamLead(), mine.id);

    await expect(delegations.revoke(asTheTeamLead(), mine.id)).rejects.toThrow(
      DelegationAlreadyEnded,
    );
  });

  /** A delegation is nominated once and ended once — never edited into a different one. */
  it('and nothing else about it may be rewritten, on any connection', async () => {
    const mine = await aDelegationToThePartTimer();

    await expect(
      admin.query('UPDATE approval_delegation SET delegate_employee_id = $1 WHERE id = $2', [
        people.officer,
        mine.id,
      ]),
    ).rejects.toThrow(/may only be ended, not edited/);

    await expect(
      admin.query('DELETE FROM approval_delegation WHERE id = $1', [mine.id]),
    ).rejects.toThrow();
  });

  /** NFR AUD 02. Handing approvals over is a grant of authority, so it is on the log. */
  it('and both the nomination and the ending are audited', async () => {
    const mine = await aDelegationToThePartTimer();

    await delegations.revoke(asTheTeamLead(), mine.id);

    const { rows } = await admin.query(
      "SELECT action FROM audit_log WHERE entity = 'approval_delegation' " +
        'AND entity_id = $1 ORDER BY id',
      [mine.id],
    );

    expect(rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
  });
});

/* ------------------------------------------- the story's second criterion: the queue */

describe('a request while its approver is away', () => {
  it('appears in the delegate’s queue', async () => {
    await twentyDaysFor(people.officer);
    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    /* Before the nomination it is in nobody else's queue — the part timer manages nobody
       and holds no role, so she staffs no desk at all. */
    await expect(queue.forApprover(asThePartTimer())).rejects.toThrow(NotAuthorised);

    await aDelegationToThePartTimer();

    const waiting = await queue.forApprover(asThePartTimer());

    expect(waiting.items.map((item) => item.requestId)).toEqual([asked.request.id]);
    /** FR 38a. The desk is her delegator's, and the queue says so rather than implying it. */
    expect(waiting.desks).toEqual(['MANAGER']);
    expect(waiting.items[0].answeringFor?.employeeId).toBe(people.teamLead);
    expect(waiting.items[0].actionable).toBe(true);
  });

  /** And it is still the manager's own: a delegation adds a reader rather than moving one. */
  it('and stays in their approver’s queue too', async () => {
    await twentyDaysFor(people.officer);
    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await aDelegationToThePartTimer();

    const his = await queue.forApprover(asTheTeamLead());

    expect(his.items.map((item) => item.requestId)).toEqual([asked.request.id]);
    /** His own desk, so nothing is being answered for anybody. */
    expect(his.items[0].answeringFor).toBeNull();
  });

  /* The window is the whole of it: a delegation that has not started and one that has been
     ended both reach nothing, and the queue is refused rather than answered empty. */
  it('and only while the delegation is in force', async () => {
    await twentyDaysFor(people.officer);
    await requests.submit(asTheOfficer(), aRequest(people.officer));

    await aDelegationToThePartTimer(LATER_FROM, LATER_TO);

    await expect(queue.forApprover(asThePartTimer())).rejects.toThrow(NotAuthorised);

    const now = await aDelegationToThePartTimer();

    expect((await queue.forApprover(asThePartTimer())).items).toHaveLength(1);

    await delegations.revoke(asTheTeamLead(), now.id);

    await expect(queue.forApprover(asThePartTimer())).rejects.toThrow(NotAuthorised);
  });

  /**
   * And a delegate of one manager sees that manager's reports and nobody else's.
   *
   * The `MANAGER` desk is a relationship, so this is the assertion that a delegation does
   * not quietly widen into every team in the company.
   */
  it('and never the reports of a manager nobody handed over', async () => {
    await twentyDaysFor(people.officer);
    await twentyDaysFor(people.hrOfficer);

    await requests.submit(asTheOfficer(), aRequest(people.officer));
    await requests.submit(asTheHrOfficer(), aRequest(people.hrOfficer));

    await aDelegationToThePartTimer();

    const waiting = await queue.forApprover(asThePartTimer());

    expect(waiting.items).toHaveLength(1);
    expect(waiting.items[0].asker.employeeId).toBe(people.officer);
  });
});

/* ------------------------------ the story's third criterion: what the decision records */

describe('a decision a delegate made', () => {
  it('records both the delegate and the person delegated for', async () => {
    await twentyDaysFor(people.officer);
    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await aDelegationToThePartTimer();

    const decided = await requests.approve(asThePartTimer(), asked.request.id);

    /** FR 52. The desk is the chain's; the two ids are the hand and the absence it covered. */
    expect(decided.decision.onBehalfOf).toBe('MANAGER');
    expect(decided.decision.decidedByEmployeeId).toBe(people.partTimer);
    expect(decided.decision.delegatedFor).toBe(people.teamLead);

    /* And the request moved on exactly as it would have under its own manager: the first
       stage of manager-then-HR, so no days have been taken. */
    expect(decided.request.status).toBe('SUBMITTED');
    expect(decided.request.awaitingApprovalFrom).toBe('HR');
    expect(decided.entry).toBeNull();
  });

  it('and records nobody where the decider is the desk in their own right', async () => {
    await twentyDaysFor(people.officer);
    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await aDelegationToThePartTimer();

    const decided = await requests.approve(asTheTeamLead(), asked.request.id);

    expect(decided.decision.decidedByEmployeeId).toBe(people.teamLead);
    expect(decided.decision.delegatedFor).toBeNull();
  });

  /** FR 39. And a refusal made as a delegate still says why, and still gives the days back. */
  it('and a refusal by a delegate ends it and releases the hold', async () => {
    await annualLeaveGoesTo('MANAGER');
    await twentyDaysFor(people.officer);

    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await aDelegationToThePartTimer();

    const refused = await requests.refuse(
      asThePartTimer(),
      asked.request.id,
      'We are short that fortnight',
    );

    expect(refused.request.status).toBe('REFUSED');
    expect(refused.decision.delegatedFor).toBe(people.teamLead);
    expect(refused.balance.available).toBe(20);
  });

  /**
   * And one hand is one hand, whichever standing it used. FR 48d.
   *
   * A delegate answering the manager's stage and then their own HR stage would be two
   * approvals from one person, which `eachStageADifferentPerson` refuses and this shows is
   * not reachable by putting a delegation in front of it.
   */
  it('and cannot answer a second stage under a different hat', async () => {
    await annualLeaveGoesTo('MANAGER', 'HR');
    await twentyDaysFor(people.officer);

    /* The head of HR covers for the team lead, so the manager's stage and the HR stage both
       resolve to her. LMS 322 sends the second one to the desk she signed at. */
    await delegations.nominate(asTheTeamLead(), {
      approverId: people.teamLead,
      delegateId: people.headOfHr,
      from: AWAY_FROM,
      to: AWAY_TO,
    });

    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    /** The manager's stage, answered as the team lead's delegate. */
    const decided = await requests.approve(asTheHeadOfHr(), asked.request.id);

    expect(decided.decision.delegatedFor).toBe(people.teamLead);
    expect(decided.request.awaitingApprovalFrom).toBe('HR');

    /* And the HR stage is a colleague's, whichever hat she would wear at it. The company has
       a second officer, so the request is answerable and she is the one person refused. */
    await expect(requests.approve(asTheHeadOfHr(), asked.request.id)).rejects.toThrow(
      NotAuthorised,
    );

    await expect(requests.approve(asTheHrOfficer(), asked.request.id)).resolves.toBeDefined();
    expect(await decisionsOn(asked.request.id)).toHaveLength(2);
  });
});

/* ------------------------------------------------- and never over the delegator's own leave */

/**
 * FR 48, LMS 319, reaching the one path that could have gone round it.
 *
 * The lone HR officer's own unpaid leave stands at the desk she staffs. Handing her
 * approvals to a colleague must not turn that into a request her nominee can grant.
 */
describe('a delegation over the delegator’s own leave', () => {
  it('carries no say over it, and the request goes to the stand-in instead', async () => {
    await annualLeaveGoesTo('MANAGER');
    await twentyDaysFor(people.teamLead);

    await aDelegationToThePartTimer();

    /* The team lead asks for leave. His own request goes to *his* manager rather than to his
       desk, so his delegate has nothing to answer here. */
    const asked = await requests.submit(asTheTeamLead(), aRequest(people.teamLead));

    expect((await queue.forApprover(asThePartTimer())).items).toHaveLength(0);

    await expect(requests.approve(asThePartTimer(), asked.request.id)).rejects.toThrow(
      NotAuthorised,
    );
  });

  /**
   * And the queue says the same thing the door does.
   *
   * The row is genuinely at a desk the delegate covers, so it is on their queue — the shape
   * LMS 404 rules out is a queue that hides what nobody can move. It is marked instead.
   */
  it('and the delegate’s queue marks it rather than hiding it', async () => {
    await annualLeaveGoesTo('HR');
    await twentyDaysFor(people.hrOfficer);

    /* The HR officer hands her approvals to somebody with no HR role of their own, and then
       asks for leave that goes to the desk she staffs. */
    await delegations.nominate(asTheHrOfficer(), {
      approverId: people.hrOfficer,
      delegateId: people.partTimer,
      from: AWAY_FROM,
      to: AWAY_TO,
    });

    await requests.submit(asTheHrOfficer(), aRequest(people.hrOfficer));

    const [row] = (await queue.forApprover(asThePartTimer())).items;

    expect(row.asker.employeeId).toBe(people.hrOfficer);
    expect(row.actionable).toBe(false);
    expect(row.notActionableBecause).toContain('FR 38a');
  });

  /** And the schema says it too, where no service can reach. */
  it('and the row is refused on every connection', async () => {
    await annualLeaveGoesTo('MANAGER');
    await twentyDaysFor(people.teamLead);

    const asked = await requests.submit(asTheTeamLead(), aRequest(people.teamLead));

    await expect(
      /** The requester, named as the person being answered for. */
      decisionWrittenByHand(asked.request.id, people.partTimer, people.teamLead),
    ).rejects.toThrow(/nobody answers it on their behalf/);
  });

  /** And you do not stand in for yourself, which is a CHECK rather than a trigger. */
  it('and nobody is recorded as covering for themselves', async () => {
    await twentyDaysFor(people.officer);
    const asked = await requests.submit(asTheOfficer(), aRequest(people.officer));

    await expect(
      decisionWrittenByHand(asked.request.id, people.teamLead, people.teamLead),
    ).rejects.toThrow(/leave_request_decision_delegate_is_somebody_else/);
  });
});

/* --------------------------------------------------------------------- the fixtures */

/** A day either side of today, written the way every date in this system is. NFR DAT 03. */
function dayFromToday(days: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + days);

  return day.toISOString().slice(0, 10);
}

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

/** The team lead handing his approvals to the part timer, which is most of this suite. */
async function aDelegationToThePartTimer(from = AWAY_FROM, to = AWAY_TO) {
  return delegations.nominate(asTheTeamLead(), {
    approverId: people.teamLead,
    delegateId: people.partTimer,
    from,
    to,
  });
}

/** A decision written straight to the table, which is what a repair script is. */
async function decisionWrittenByHand(
  leaveRequestId: string,
  decidedBy: string,
  delegatedFor: string,
): Promise<unknown> {
  /* One transaction, because the settings the stamping trigger reads are transaction-local
     and a decider it cannot see is a decider the checks below compare against nothing. */
  await admin.query('BEGIN');

  try {
    await admin.query(
      "SELECT set_config('lms.audit.actor', $1, true), " +
        "set_config('lms.audit.actor_employee_id', $2, true)",
      [`employee ${decidedBy}`, decidedBy],
    );

    const written = await admin.query(
      'INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of, ' +
        'delegated_for_employee_id, decided_by, decided_at) ' +
        "VALUES ($1, 'APPROVE', 'MANAGER', $2, 'a repair script', now())",
      [leaveRequestId, delegatedFor],
    );

    await admin.query('COMMIT');

    return written;
  } catch (refusal) {
    await admin.query('ROLLBACK');

    throw refusal;
  }
}

async function decisionsOn(leaveRequestId: string) {
  return decisions.forRequest(leaveRequestId);
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

/** Abena, on Kofi's team, who manages nobody and holds no role. */
function asThePartTimer() {
  return signedInAs(people.partTimer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheTeamLead() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asTheHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}
