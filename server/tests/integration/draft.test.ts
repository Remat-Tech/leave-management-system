import { Client } from 'pg';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised, NOT_AUTHORISED_MESSAGE } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { AUDITED_ENTITIES } from '../../src/features/audit/audit.js';
import { calendarDateIn } from '../../src/shared/time.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  DraftIsNotFinished,
  InvalidLeaveRequestDraft,
  LeaveRequestDraftNotFound,
} from '../../src/features/leave-request/draft.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
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
import { ApproverQueueService } from '../../src/features/leave-request/approver-queue.service.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestDraftService } from '../../src/features/leave-request/draft.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Saving a request and finishing it later. FR 19, §6. LMS 302.
 *
 * ../unit/draft.test.ts proves what is pure: what a draft may hold and what it is still
 * missing. What needs a server is everything a draft is defined by *not* doing —
 *
 *   **Nothing enters the workflow.** No request row, no ledger movement, no notice, nothing
 *   in an approver's queue, and no hold on the days or the dates. The first criterion is a
 *   list of absences, so it is asserted as one.
 *
 *   **Everything is editable, and only while it is a draft.** The row moves table at
 *   submission, so there is nothing left to edit afterwards.
 *
 *   **It is nobody else's.** Not the line manager's and not HR's, which is narrower than
 *   every other rule in `policy.ts`.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('draft integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let drafts: LeaveRequestDraftService;
let requests: LeaveRequestService;
let queue: ApproverQueueService;
let balances: BalanceService;
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
  const organisation = new OrganisationRepository(db);
  const balanceRepository = new BalanceRepository(db);

  balances = new BalanceService(balanceRepository, guard, employees, new Transactions(db));
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
    new WithdrawalRepository(db),
    /** FR 13, LMS 311. */
    new AttachmentRepository(db),
    new RoleRepository(db),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  drafts = new LeaveRequestDraftService(
    guard,
    new LeaveRequestDraftRepository(db),
    employees,
    requests,
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
      'leave_request_attachment, leave_request_decision, leave_request_routing, leave_request_withdrawal, ' +
      'leave_request_draft, leave_request',
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

function theBalance() {
  return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id };
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asTheHeadOfHr() {
  return signedInAs(people.headOfHr, {
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN'],
    isManager: true,
  });
}

/** A working week starting a week from today. */
function nextWeek(): { from: string; to: string } {
  return { from: daysFromToday(7), to: daysFromToday(11) };
}

/** A draft with everything filled in, saved through the door. */
async function aFinishedDraft(period = nextWeek()) {
  return drafts.save(asTheEmployee(), people.officer, {
    leaveTypeId: annualId,
    ...period,
    reason: 'My sister is getting married',
  });
}

async function requestCount(): Promise<number> {
  const { rows } = await admin.query<{ count: string }>('SELECT count(*) FROM leave_request');

  return Number(rows[0].count);
}

async function draftCount(): Promise<number> {
  const { rows } = await admin.query<{ count: string }>('SELECT count(*) FROM leave_request_draft');

  return Number(rows[0].count);
}

/* ------------------------------------------- saved without entering the workflow, FR 19 */

describe('saving a draft', () => {
  it('writes a draft and nothing else at all', async () => {
    const before = (await balances.forOne(system, theBalance())).available;

    const draft = await aFinishedDraft();

    expect(draft.employeeId).toBe(people.officer);
    expect(draft.leaveTypeId).toBe(annualId);

    /* The whole of the first criterion: no request, no movement, no notice. */
    expect(await requestCount()).toBe(0);
    expect((await balances.forOne(system, theBalance())).available).toBe(before);
    expect(
      Number(
        (
          await admin.query('SELECT count(*) FROM leave_ledger_entry WHERE reason LIKE $1', [
            '%requested%',
          ])
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(Number((await admin.query('SELECT count(*) FROM notification')).rows[0].count)).toBe(0);
  });

  /* Nobody is asked to decide it, which is what "without entering the workflow" means to
     the person who would otherwise have it in their queue. */
  it('puts nothing in an approver’s queue', async () => {
    await aFinishedDraft();

    expect((await queue.forApprover(asTheirManager())).items).toEqual([]);
    expect((await queue.forApprover(asAnHrOfficer())).items).toEqual([]);
  });

  /* A draft is planning, not a booking. Two tentative weeks over the same days is the
     ordinary case, and neither of them takes the dates from a real request. */
  it('blocks no calendar: two drafts may cover the same days, and so may a request', async () => {
    const period = nextWeek();

    await aFinishedDraft(period);
    await aFinishedDraft(period);

    const { request } = await requests.submit(asTheEmployee(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      ...period,
      reason: 'The same week, asked for properly',
      /** FR 17, LMS 307. {@link nextWeek} is seven days out and annual leave wants fourteen. */
      acknowledgesShortNotice: true,
    });

    expect(request.status).toBe('SUBMITTED');
    expect(await draftCount()).toBe(2);
  });

  /* FR 14, FR 16, FR 16a. Every rule about the leave belongs to submission, which is the
     moment the days are actually asked for. A draft for more days than the balance holds
     is somebody planning, and it is refused when they ask. */
  it('is not priced, not counted and not checked against the balance', async () => {
    const draft = await drafts.save(asTheEmployee(), people.officer, {
      leaveTypeId: annualId,
      from: '2026-01-03',
      to: '2026-01-04',
      reason: 'A weekend, which costs nothing at all',
    });

    expect(draft.from).toBe('2026-01-03');

    const wholeYear = await drafts.save(asTheEmployee(), people.officer, {
      leaveTypeId: annualId,
      from: daysFromToday(7),
      to: daysFromToday(120),
      reason: 'More days than I have',
    });

    expect(wholeYear.to).toBe(daysFromToday(120));
  });

  it('saves one with only the kind of leave chosen', async () => {
    const draft = await drafts.save(asTheEmployee(), people.officer, { leaveTypeId: annualId });

    expect(draft.from).toBeNull();
    expect(draft.to).toBeNull();
    expect(draft.reason).toBeNull();
  });

  it('refuses a kind of leave that does not exist', async () => {
    await expect(
      drafts.save(asTheEmployee(), people.officer, { leaveTypeId: '99999999' }),
    ).rejects.toBeInstanceOf(InvalidLeaveRequestDraft);
  });

  it('lists a person’s drafts, the one they last worked on first', async () => {
    const first = await drafts.save(asTheEmployee(), people.officer, { reason: 'One' });
    const second = await drafts.save(asTheEmployee(), people.officer, { reason: 'Two' });

    await drafts.replace(asTheEmployee(), first.id, { reason: 'One, revisited' });

    expect(
      (await drafts.forEmployee(asTheEmployee(), people.officer)).map((one) => one.id),
    ).toEqual([first.id, second.id]);
  });
});

/* ------------------------------------------------ editable while in draft only, FR 19 */

describe('editing a draft', () => {
  it('lets every field change, including the ones a request freezes', async () => {
    const draft = await aFinishedDraft();

    const edited = await drafts.replace(asTheEmployee(), draft.id, {
      leaveTypeId: annualId,
      from: daysFromToday(30),
      to: daysFromToday(34),
      reason: 'The wedding moved',
    });

    expect(edited.id).toBe(draft.id);
    expect(edited.from).toBe(daysFromToday(30));
    expect(edited.reason).toBe('The wedding moved');
  });

  /* A whole replacement, so a field somebody cleared on the form is cleared here. */
  it('clears a field the form sent empty', async () => {
    const draft = await aFinishedDraft();

    const edited = await drafts.replace(asTheEmployee(), draft.id, { leaveTypeId: annualId });

    expect(edited.from).toBeNull();
    expect(edited.reason).toBeNull();
  });

  it('throws one away', async () => {
    const draft = await aFinishedDraft();

    await drafts.discard(asTheEmployee(), draft.id);

    expect(await draftCount()).toBe(0);
    await expect(drafts.byId(asTheEmployee(), draft.id)).rejects.toBeInstanceOf(
      LeaveRequestDraftNotFound,
    );
  });

  it('and tells the second of two tabs that discarded it what happened', async () => {
    const draft = await aFinishedDraft();

    await drafts.discard(asTheEmployee(), draft.id);

    await expect(drafts.discard(asTheEmployee(), draft.id)).rejects.toBeInstanceOf(
      LeaveRequestDraftNotFound,
    );
  });

  /* The second criterion's other half, and it is structural rather than checked: the row
     moves table at submission, so there is no draft left to edit. */
  it('and once it has been submitted there is nothing left to edit', async () => {
    const draft = await aFinishedDraft();

    await drafts.submit(asTheEmployee(), draft.id, true);

    await expect(
      drafts.replace(asTheEmployee(), draft.id, { reason: 'Second thoughts' }),
    ).rejects.toBeInstanceOf(LeaveRequestDraftNotFound);
  });

  /* `leave_request_draft_stays_with_whose_it_is`, on every connection including the owner's:
     a draft that changed hands would be somebody's private planning on another person's
     page, with no policy asked. */
  it('and the database refuses to move one to somebody else', async () => {
    const draft = await aFinishedDraft();

    await expect(
      admin.query('UPDATE leave_request_draft SET employee_id = $1 WHERE id = $2', [
        people.teamLead,
        draft.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_request_draft_stays_with_whose_it_is' });
  });
});

/* --------------------------------------------------------- finishing it later, FR 19 */

describe('submitting a draft', () => {
  it('asks for the leave, holds the days, and the draft goes away', async () => {
    const before = (await balances.forOne(system, theBalance())).available;
    const draft = await aFinishedDraft();

    const submitted = await drafts.submit(asTheEmployee(), draft.id, true);

    expect(submitted.request.status).toBe('SUBMITTED');
    /** FR 38a. It starts at the first desk of annual leave's chain, like anything else. */
    expect(submitted.request.awaitingApprovalFrom).toBe('MANAGER');
    expect(submitted.request.reason).toBe('My sister is getting married');

    /* The days are held now, and were not a moment ago. What the period costs is counted
       by the door rather than by the draft, so the figure is read off the request. */
    expect(submitted.request.days).toBeGreaterThan(0);
    expect((await balances.forOne(system, theBalance())).available).toBe(
      before - submitted.request.days,
    );

    expect(await draftCount()).toBe(0);
  });

  it('and the request it made is one an approver sees', async () => {
    const draft = await aFinishedDraft();

    await drafts.submit(asTheEmployee(), draft.id, true);

    expect((await queue.forApprover(asTheirManager())).items).toHaveLength(1);
  });

  /**
   * FR 17, LMS 307. The acknowledgement is asked for when the draft is finished.
   *
   * It is not one of the draft's four fields and deliberately cannot be: how short the notice
   * is depends on the day it is submitted, so a tick saved a fortnight ago would answer a
   * question this afternoon asks differently. A finished draft is otherwise perfectly good,
   * so the refusal leaves it exactly where it was and asking again with the tick works.
   */
  it('asks for the short notice acknowledgement at the finishing, not at the saving', async () => {
    const draft = await aFinishedDraft();

    await expect(drafts.submit(asTheEmployee(), draft.id)).rejects.toMatchObject({
      code: 'SHORT_NOTICE_NOT_ACKNOWLEDGED',
    });

    expect(await draftCount()).toBe(1);
    expect(await requestCount()).toBe(0);

    const submitted = await drafts.submit(asTheEmployee(), draft.id, true);

    expect(submitted.request.status).toBe('SUBMITTED');
    expect(await draftCount()).toBe(0);
  });

  /* Nothing here defaults a missing field, so a draft cannot become leave nobody asked
     for — and the draft is left exactly where it was. */
  it('refuses an unfinished one and keeps it', async () => {
    const draft = await drafts.save(asTheEmployee(), people.officer, {
      leaveTypeId: annualId,
      from: daysFromToday(7),
    });

    await expect(drafts.submit(asTheEmployee(), draft.id, true)).rejects.toBeInstanceOf(
      DraftIsNotFinished,
    );

    expect(await draftCount()).toBe(1);
    expect(await requestCount()).toBe(0);
  });

  it('names what is left on that refusal', async () => {
    const draft = await drafts.save(asTheEmployee(), people.officer, { leaveTypeId: annualId });

    /* FR 10. The reason is not among them: whether one is needed is the leave type's rule,
       and a draft is checked for its fields. */
    await expect(drafts.submit(asTheEmployee(), draft.id, true)).rejects.toMatchObject({
      code: 'DRAFT_NOT_FINISHED',
      missing: ['from', 'to'],
    });
  });

  /* Every refusal a typed-in request can meet, a finished draft can meet — and meeting one
     costs the person their draft nothing, which is the point of having one. */
  it('keeps the draft when a rule refuses the leave', async () => {
    const draft = await drafts.save(asTheEmployee(), people.officer, {
      leaveTypeId: annualId,
      from: '2026-12-28',
      to: '2027-01-05',
      reason: 'Over the new year',
    });

    await expect(drafts.submit(asTheEmployee(), draft.id, true)).rejects.toMatchObject({
      code: 'CROSS_LEAVE_YEAR',
    });

    expect(await draftCount()).toBe(1);
    expect(await requestCount()).toBe(0);
  });

  it('and refuses one over leave already booked, keeping it', async () => {
    const period = nextWeek();

    await requests.submit(asTheEmployee(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      ...period,
      reason: 'Already asked for',
      /** FR 17, LMS 307. */
      acknowledgesShortNotice: true,
    });

    const draft = await aFinishedDraft(period);

    await expect(drafts.submit(asTheEmployee(), draft.id, true)).rejects.toMatchObject({
      code: 'OVERLAPPING_REQUEST',
    });

    expect(await draftCount()).toBe(1);
  });
});

/* --------------------------------------------------------- a draft is nobody else's */

describe('who may see a draft', () => {
  /* The narrowest rule in `policy.ts`, and deliberately narrower than `read`, which admits
     both of these: there is no request for a manager to be the manager of. */
  it('is refused to the line manager, to HR, and refused silently', async () => {
    const draft = await aFinishedDraft();

    for (const actor of [asTheirManager(), asAnHrOfficer(), asTheHeadOfHr()]) {
      await expect(drafts.byId(actor, draft.id)).rejects.toThrow(NotAuthorised);
      await expect(drafts.byId(actor, draft.id)).rejects.toThrow(NOT_AUTHORISED_MESSAGE);
    }
  });

  it('and neither of them may edit, discard or submit it', async () => {
    const draft = await aFinishedDraft();

    for (const actor of [asTheirManager(), asTheHeadOfHr()]) {
      await expect(drafts.replace(actor, draft.id, { reason: 'Mine now' })).rejects.toThrow(
        NotAuthorised,
      );
      await expect(drafts.discard(actor, draft.id)).rejects.toThrow(NotAuthorised);
      await expect(drafts.submit(actor, draft.id, true)).rejects.toThrow(NotAuthorised);
    }

    expect(await draftCount()).toBe(1);
    expect(await requestCount()).toBe(0);
  });

  /* HR may submit leave on somebody's behalf — FR 18 — and may not draft on their behalf.
     A draft HR left on somebody's record would be planning that person never did. */
  it('and HR may not start one for somebody else', async () => {
    await expect(
      drafts.save(asTheHeadOfHr(), people.officer, { reason: 'On their behalf' }),
    ).rejects.toThrow(NotAuthorised);
  });

  it('and a person’s own list holds only their own', async () => {
    await aFinishedDraft();

    await expect(drafts.forEmployee(asTheirManager(), people.officer)).rejects.toThrow(
      NotAuthorised,
    );
  });
});

/* ------------------------------------------------------------------ and it is not a record */

describe('a draft is a working document rather than a record', () => {
  /* The opposite of `leave_request_decision`'s reason for being unaudited. A draft is
     rewritten and thrown away, and an audited one would be a log of the contents of
     everything anybody discarded. */
  it('is not audited, and `AUDITED_ENTITIES` says so', async () => {
    expect(AUDITED_ENTITIES as readonly string[]).not.toContain('leave_request_draft');

    const draft = await aFinishedDraft();
    await drafts.replace(asTheEmployee(), draft.id, { reason: 'Changed my mind' });
    await drafts.discard(asTheEmployee(), draft.id);

    const { rows } = await admin.query(
      "SELECT 1 FROM audit_log WHERE entity = 'leave_request_draft'",
    );

    expect(rows).toHaveLength(0);
  });

  /* `TRANSITIONS` is untouched by this story: the move it brings is into `SUBMITTED` from
     outside the table, so `leave_request.status` never holds a draft. */
  it('never appears as a status on a leave request', async () => {
    const { rows } = await admin.query<{ status: string }>(
      'SELECT DISTINCT status FROM leave_request',
    );

    expect(rows.map((row) => row.status)).not.toContain('DRAFT');
  });
});
