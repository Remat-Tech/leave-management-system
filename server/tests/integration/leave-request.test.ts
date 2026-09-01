import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { type Actor, signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { APPROVER_ROLES } from '../../src/domain/approval-chain.js';
import { AUDITED_ENTITIES, UNATTRIBUTED } from '../../src/domain/audit.js';
import { BalanceOverdrawn } from '../../src/domain/balance.js';
import { DECIDING_ACTIONS } from '../../src/domain/leave-decision.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import { InvalidLeavePeriod } from '../../src/domain/leave-calculator.js';
import {
  InvalidLeaveRequest,
  LeaveAlreadySettled,
  LeaveCountsNoDays,
  LeaveCrossesAYearEnd,
  LeaveOverlapsAnother,
  LeaveRequestNotFound,
  LIVE_STATUSES,
  type NewLeaveRequest,
  NotEnoughDays,
  RELEASING_STATUSES,
  TRANSITIONS,
  REQUEST_STATUSES,
  validateNewLeaveRequest,
} from '../../src/domain/leave-request.js';
import { LeaveTypeRetired } from '../../src/domain/leave-type.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';
import { BalanceRepository } from '../../src/repositories/balance-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { HolidayRepository } from '../../src/repositories/holiday-repository.js';
import { LeaveDecisionRepository } from '../../src/repositories/leave-decision-repository.js';
import { LeaveRequestRepository } from '../../src/repositories/leave-request-repository.js';
import { LeaveTypeRepository } from '../../src/repositories/leave-type-repository.js';
import { LeaveYearRepository } from '../../src/repositories/leave-year-repository.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { Transactions } from '../../src/repositories/transaction.js';
import { BalanceService } from '../../src/services/balance-service.js';
import { LeaveCalculatorService } from '../../src/services/leave-calculator-service.js';
import {
  LeaveRequestService,
  LeaveYearIsClosed,
} from '../../src/services/leave-request-service.js';
import { LeaveYearService } from '../../src/services/leave-year-service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Asking for leave, against a real database. FR 10, FR 11, §8. LMS 301.
 *
 * ../unit/leave-request.test.ts proves what a quote says and what a request has to
 * carry. What needs a server is everything the story is actually about:
 *
 *   **The quote and the submission agree.** The number a person is shown and the number
 *   that comes off their balance are produced by the same call over the same working
 *   pattern and the same public holiday calendar, and only a real one of each can show
 *   that.
 *
 *   **The counting basis is copied, and the copy survives the type changing.** The
 *   story's third criterion, and it cannot be proved without editing a leave type and
 *   re-reading a request that was made before the edit. That is the test this file
 *   exists for.
 *
 *   **Submitting holds the days.** The request row and its RESERVATION are one act.
 *   That they cannot come apart is a foreign key, a deferred constraint trigger and a
 *   rollback — no pure function has that property.
 *
 *   **Nothing can reprice a request afterwards.** Not the application, and not the
 *   owner connection either, which is the half that matters.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

const system = theSystem('leave request integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let repository: LeaveRequestRepository;
let decisions: LeaveDecisionRepository;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: LeaveYear;
let annualId: string;
let maternityId: string;
/** FR 32a's one exceedable type today, read off the column rather than the code. */
let sickId: string;

/**
 * A Monday to a Tuesday of the week after, in the seeded 2026 year.
 *
 * Nine calendar days costing six, which is the shape every assertion about the counting
 * basis below turns on. The three free days are free for two different reasons — the
 * sixth of March is Independence Day and the two after it are a weekend — so the period
 * exercises both halves of what makes a day cost nothing rather than only the weekend.
 */
const FROM = '2026-03-02';
const TO = '2026-03-10';

/**
 * What a manager says when they turn leave down. FR 39. LMS 315.
 *
 * Written out once and used everywhere a refusal is made, because the story is that this
 * sentence exists and reaches the person: a test that passed `'no'` would satisfy the
 * constraint and prove nothing about what the requester is left holding.
 */
const WHY_NOT = 'Two of the team are already away that week and the desk cannot be empty';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  repository = new LeaveRequestRepository(db);
  decisions = new LeaveDecisionRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    repository,
    decisions,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
  );

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request_decision, leave_request',
  );
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;

  /* One test below retires a type and another changes a counting basis, and
     `leave_type` is the migration's rather than the seed's — every suite reads the
     seven as given. Put back here rather than in those tests, so a failure part way
     through one cannot leave annual leave counting calendar days for every file after. */
  await admin.query(
    "UPDATE leave_type SET is_active = true, counting_basis = 'WORKING_DAYS' WHERE code = 'ANNUAL'",
  );

  /* And the approval chains, for the same reason and since LMS 314: several tests below
     change annual leave's to show that routing reads the rows rather than anything in the
     code, and `leave_type_approval_step` is the migration's rather than the seed's. Put back
     through the owner's repair function, which is what an operator would use — it gives a
     chain to every type that has none and leaves alone every type that has one, so clearing
     first is what makes it a restore.

     **Annual leave's rows only, and inside a transaction**, both of which are about the
     other suites rather than this one. The integration files run against one database at the
     same time, so a restore that emptied `leave_type_approval_step` outright left a window —
     short, and once per test in this file — in which ../integration/approval-chain.test.ts
     and ../integration/leave-type.test.ts could read a type with no approvers and fail on
     something neither of them is about. Narrowing the delete to the one type these tests
     actually rewrite, and committing the pair as one act, closes it: another session sees
     the chains before or after and never in between. */
  const codes = await admin.query(
    "SELECT code, id FROM leave_type WHERE code IN ('ANNUAL','MATERNITY','SICK')",
  );
  const byCode = Object.fromEntries(codes.rows.map((row) => [row.code, row.id as string]));

  annualId = byCode.ANNUAL;
  maternityId = byCode.MATERNITY;
  sickId = byCode.SICK;

  /* The ids are read before the restore below rather than after it, because the restore now
     names the type it is putting back and `annualId` is undefined on the first pass. */
  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  /* Twenty days of annual leave, so there is something to spend. Granted the way the
     annual run grants it, which is through the one door. */
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
    'TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request_decision, leave_request',
  );
  await admin.query(
    "UPDATE leave_type SET is_active = true, counting_basis = 'WORKING_DAYS' WHERE code = 'ANNUAL'",
  );
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/** The leave years as the migration left them. The same shape ./ledger.test.ts uses. */
async function restoreYears(): Promise<void> {
  const columns = Object.keys(seededYears[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await admin.query('TRUNCATE leave_year CASCADE');

  for (const row of seededYears) {
    await admin.query(
      `INSERT INTO leave_year (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('leave_year_id_seq', (SELECT max(id) FROM leave_year))`);
}

/** Adwoa Frimpong, the operations officer, asking for her own leave. */
function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/** Kofi Boateng, her team lead. */
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

/* -------------------------------------------- what it costs, before it costs it */

describe('what a period of leave would cost', () => {
  /* The story's second criterion, against a real working pattern and a real calendar. */
  it('is shown before anything is written', async () => {
    const quote = await requests.quote(asThemselves(), aRequest());

    expect(quote.days).toBe(6);
    expect(quote.calendarDays).toBe(9);
    expect(quote.countingBasis).toBe('WORKING_DAYS');
    expect(quote.countingBasisInWords).toMatch(/working days/);
  });

  it('and names the days it did not charge for, and why each was free', async () => {
    const quote = await requests.quote(asThemselves(), aRequest());

    expect(quote.free).toEqual([
      { date: '2026-03-06', because: 'PUBLIC_HOLIDAY', name: 'Independence Day' },
      { date: '2026-03-07', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-03-08', because: 'NOT_A_WORKING_DAY', name: null },
    ]);
  });

  it('and what the balance holds now and would hold afterwards', async () => {
    const quote = await requests.quote(asThemselves(), aRequest());

    expect(quote.availableNow).toBe(20);
    expect(quote.availableAfter).toBe(14);
  });

  /* Writing nothing is the whole point of a quote: it is safe to call on every
     keystroke that changes a date. */
  it('and writes nothing at all', async () => {
    await requests.quote(asThemselves(), aRequest());

    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('0');
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RESERVATION'",
        )
      ).rows[0].count,
    ).toBe('0');
  });

  /**
   * And the same period of a calendar-day type costs every day of it. FR 21.
   *
   * The pair that proves the basis is doing the work rather than the weekend being
   * hard coded somewhere: same nine days, same person, same calendar, two answers.
   */
  it('and counts every day of a type that counts every day', async () => {
    const quote = await requests.quote(
      asThemselves(),
      aRequest({ leaveTypeId: maternityId, employeeId: people.officer }),
    );

    expect(quote.days).toBe(9);
    expect(quote.free).toEqual([]);
    expect(quote.countingBasisInWords).toMatch(/every day/);
  });

  /* The refusals that mean there is nothing to quote come from the domain unchanged,
     because a service that reworded them would be a second copy of the sentence. */
  it('and refuses a weekend of a working-day type rather than quoting nothing', async () => {
    await expect(
      requests.quote(asThemselves(), aRequest({ from: '2026-03-07', to: '2026-03-08' })),
    ).rejects.toBeInstanceOf(LeaveCountsNoDays);
  });

  it('and refuses two dates that are not a period', async () => {
    await expect(
      requests.quote(asThemselves(), aRequest({ from: '2026-03-10', to: '2026-03-02' })),
    ).rejects.toBeInstanceOf(InvalidLeavePeriod);
  });
});

/* ------------------------------------------------ submitting, and holding the days */

describe('submitting a request', () => {
  it('stores the kind of leave, the dates and the reason', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    expect(request).toMatchObject({
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      from: FROM,
      to: TO,
      reason: 'My sister is getting married',
      status: 'SUBMITTED',
    });
  });

  /* The story's third criterion at the moment it is taken. */
  it('and the day count and the basis it was counted under', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    expect(request.days).toBe(6);
    expect(request.calendarDays).toBe(9);
    expect(request.countingBasis).toBe('WORKING_DAYS');
  });

  it('and says when it was asked for, from the database rather than the caller', async () => {
    const before = new Date();
    const { request } = await requests.submit(asThemselves(), aRequest());

    expect(request.submittedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  /* The quote is not a promise, and it is also not a different answer. Whatever is
     between the two calls is a person reading a screen. */
  it('and costs exactly what the quote said it would', async () => {
    const quote = await requests.quote(asThemselves(), aRequest());
    const { request, balance } = await requests.submit(asThemselves(), aRequest());

    expect(request.days).toBe(quote.days);
    expect(balance.available).toBe(quote.availableAfter);
  });

  /**
   * And the days are held. FR 26, §8.2.
   *
   * The README has said since Phase 1 that submitting writes a RESERVATION immediately,
   * and `BalanceService.reserve` was built for it in LMS 212 and left unused until now.
   * This is the assertion that the sentence became true.
   */
  it('and holds the days it costs, as a RESERVATION naming it', async () => {
    const { request, entry, balance } = await requests.submit(asThemselves(), aRequest());

    expect(entry.entryType).toBe('RESERVATION');
    expect(entry.days).toBe(-6);
    expect(entry.leaveRequestId).toBe(request.id);
    expect(balance.pending).toBe(6);
    expect(balance.available).toBe(14);
  });

  it('and the reservation says what it is for, in words somebody reading a balance can use', async () => {
    const { entry } = await requests.submit(asThemselves(), aRequest());

    expect(entry.reason).toContain('6 days');
    expect(entry.reason).toContain(FROM);
    expect(entry.reason).toContain(TO);
  });

  /* Held days are not days to spend twice. This is what the reservation is for. */
  it('and days already held count against the next request', async () => {
    await requests.submit(asThemselves(), aRequest());
    await requests.submit(asThemselves(), aRequest({ from: '2026-04-06', to: '2026-04-14' }));

    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-05-04', to: '2026-05-29' })),
    ).rejects.toBeInstanceOf(NotEnoughDays);
  });

  /**
   * And a refused submission writes neither row.
   *
   * The pair is one act. A request holding nothing could be submitted three times
   * against a balance with five days in it; a reservation with no request behind it is
   * days missing that nobody can explain.
   *
   * Since LMS 305 this particular refusal is raised before the transaction is opened at
   * all, so what it proves is that nothing is written on the way to it rather than that
   * a rollback works. The rollback itself is proved where it now has to be: at the door,
   * in the last test of this file's balance section and in ./balance.test.ts.
   */
  it('and a refused submission leaves no request and no entry behind', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-05-04', to: '2026-06-30' })),
    ).rejects.toBeInstanceOf(NotEnoughDays);

    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('0');
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RESERVATION'",
        )
      ).rows[0].count,
    ).toBe('0');
  });

  /* And the database refuses the half of the pair nothing above it can produce. The
     deferred trigger is the only thing that can tell a request with no reservation from
     a request whose reservation has not been written yet. */
  it('and a request written without one is refused at commit, by anybody', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_request (
            employee_id, leave_type_id, leave_year_id, start_date, end_date,
            reason, counting_basis, days, calendar_days, status, awaiting_approval_from)
         VALUES ($1, $2, $3, $4, $5, 'straight to the table', 'WORKING_DAYS', 7, 9, 'SUBMITTED', 'MANAGER')`,
        [people.officer, annualId, y2026.id, FROM, TO],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_holds_its_days' });
  });

  /* And a second reservation against one request, which is what a retry would write. */
  it('and one request holds days exactly once', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry (
            employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
         VALUES ($1, $2, $3, 'RESERVATION', '-7.00', 'held twice', $4)`,
        [people.officer, annualId, y2026.id, request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_reserves_once' });
  });
});

/* ------------------------------------------------------ days that are not there */

/**
 * Told at once that the days are not there. FR 14, NFR USA 03. LMS 305.
 *
 * ../unit/leave-request.test.ts proves the sentence, which is most of the story. What
 * needs a server is the half a pure function cannot have:
 *
 *   **The figure is the real one.** A refusal naming a balance is only worth anything if
 *   the balance it names is the one in the table, moving as days are held against it.
 *
 *   **The quote and the refusal agree.** The figure somebody was shown before they
 *   committed and the figure they are refused against are read the same way from the same
 *   row — which is the whole of "no surprises", and needs two calls against one database
 *   to show.
 *
 *   **And the door still refuses it.** The check added here is the sentence, not the
 *   guarantee. `daysToReserve` inside `BalanceService`'s lock is what cannot be beaten,
 *   and the two have to agree about the same request or the earlier one is a lie told
 *   politely.
 */
describe('a request the balance does not hold', () => {
  /** Four weeks and more of working days, against an entitlement of twenty. */
  const TOO_LONG = { from: '2026-05-04', to: '2026-06-30' };

  it('is refused, rather than sent to an approver to be turned down days later', async () => {
    await expect(requests.submit(asThemselves(), aRequest(TOO_LONG))).rejects.toBeInstanceOf(
      NotEnoughDays,
    );
  });

  /* The story's second criterion. The figure is the one in the table, and the sentence
     carries it rather than only the verdict. */
  it('and the message states the figure that is available', async () => {
    const refusal = await refused(aRequest(TOO_LONG));

    expect(refusal.available).toBe(20);
    expect(refusal.message).toContain('you have 20 left');
    expect(refusal.message).toContain('Ask for 20 days or fewer');
  });

  /**
   * And the figure moves with what is already held. FR 26.
   *
   * The half that cannot be faked without a database: six days held against the balance
   * are six days the next refusal has to know about. A refusal quoting the entitlement
   * rather than what is left would be worse than no figure at all — it would send
   * somebody back to the form to ask for days that are already spoken for.
   */
  it('and counts days already held against the figure it names', async () => {
    await requests.submit(asThemselves(), aRequest());

    const refusal = await refused(aRequest(TOO_LONG));

    expect(refusal.available).toBe(14);
    expect(refusal.message).toContain('you have 14 left');
  });

  /**
   * And it is the same figure the quote showed. The whole of "no surprises".
   *
   * Both are read through `BalanceService.forOne` from one place in the service, so a
   * person who priced a request on Monday and submitted it on Monday cannot be refused
   * against a different number than the one on their screen.
   */
  it('and refuses against exactly the figure the quote showed', async () => {
    const quote = await requests.quote(asThemselves(), aRequest(TOO_LONG));
    const refusal = await refused(aRequest(TOO_LONG));

    expect(refusal.available).toBe(quote.availableNow);
    expect(refusal.requested).toBe(quote.days);
    expect(refusal.shortBy).toBe(quote.days - quote.availableNow);
  });

  /**
   * And the quote says so without refusing, under the code the refusal carries.
   *
   * A quote is what somebody reads to decide what to ask for, so it shows the figures
   * and warns; refusing there would be declining to tell a person how far short they
   * are, which is the opposite of the story. The shared code is what lets a form treat
   * the two as one condition seen twice.
   */
  it('and the quote warns about it rather than refusing to price it', async () => {
    const quote = await requests.quote(asThemselves(), aRequest(TOO_LONG));
    const warning = quote.warnings.find((each) => each.code === 'NOT_ENOUGH_DAYS');

    expect(warning?.message).toContain('you have 20 left');
    expect(warning?.message).toContain('cannot be submitted as it stands');
    expect(quote.availableAfter).toBeLessThan(0);
  });

  /**
   * FR 32a, §8.6b. Sick leave is a threshold rather than a cap, and is submitted.
   *
   * Read off `exceedable_with_document` — no leave type code is compared to anything
   * anywhere above the database, design principle 5. The same period that is refused for
   * annual leave is accepted here and takes the balance below nought, which is correct
   * rather than a leak: FR 32a makes going past the allowance a request for a medical
   * certificate, and the leave is granted either way.
   */
  it('and a type that may be exceeded is submitted instead, going below nought', async () => {
    const { request, balance } = await requests.submit(
      asThemselves(),
      aRequest({ ...TOO_LONG, leaveTypeId: sickId }),
    );

    expect(request.status).toBe('SUBMITTED');
    expect(balance.available).toBeLessThan(0);
    expect(balance.pending).toBe(request.days);
  });

  /**
   * And the door refuses the same request, which is what makes the earlier refusal safe
   * to be only a sentence. §8.2.
   *
   * The service reads a balance and judges it; between that read and the write, an
   * approval landing on another connection could spend it. So the check that binds is
   * `daysToReserve` inside the lock, and this goes straight to it with a request the
   * service would have stopped — the shape of the race, without the timing.
   *
   * Both refusals, and they agree on the arithmetic. Two statements of one rule at two
   * altitudes, held together the way `LIVE_STATUSES` and `leave_request_never_overlaps`
   * are: if somebody loosens one, this is what fails.
   */
  it('and the door refuses it too, with the same arithmetic', async () => {
    const quote = await requests.quote(asThemselves(), aRequest(TOO_LONG));
    const refusal = await refused(aRequest(TOO_LONG));

    const atTheDoor = (await balances
      .reserveForRequest(asThemselves(), {
        request: validateNewLeaveRequest({
          employeeId: people.officer,
          leaveTypeId: annualId,
          leaveYearId: y2026.id,
          from: TOO_LONG.from,
          to: TOO_LONG.to,
          reason: 'past the service check',
          countingBasis: quote.countingBasis,
          days: quote.days,
          calendarDays: quote.calendarDays,
          /* FR 38a. Annual leave's chain, which is what the service would have handed over.
             This test goes round the service on purpose and so has to say it. LMS 314. */
          approvalChain: ['MANAGER', 'HR'],
        }),
        reason: 'past the service check',
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as BalanceOverdrawn;

    expect(atTheDoor).toBeInstanceOf(BalanceOverdrawn);
    expect(atTheDoor.available).toBe(refusal.available);
    expect(atTheDoor.requested).toBe(refusal.requested);
    expect(atTheDoor.shortBy).toBe(refusal.shortBy);

    /* And it rolled back, which is the property the service's earlier refusal no longer
       exercises because it never opens a transaction. */
    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('0');
  });

  /** The refusal, caught, for the tests that are about what it says. */
  async function refused(input: NewLeaveRequest): Promise<NotEnoughDays> {
    const error = await requests.submit(asThemselves(), input).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(NotEnoughDays);

    return error as NotEnoughDays;
  }
});

/* --------------------------------------------------- no maximum request length */

/**
 * There is no cap on how long a request may be. FR 20a. LMS 309.
 *
 * The story is an employee taking their whole year's leave in one go, and the
 * requirement behind it is an absence rather than a behaviour — "the system does not
 * impose a limit the company has not set". That makes it two different tests, and only
 * one of them is the obvious one.
 *
 * **That twenty days in one request works** is the story's first criterion, and it needs
 * a real balance and a real calendar: twenty *working* days is twenty-six calendar days,
 * and the figure has to come out of the same count that would price any other request.
 *
 * **That no cap exists** is a claim about code that is not there, which is the shape
 * ../unit/one-writer.test.ts deals with by reading the source. Here it is provable by
 * behaviour, and more convincingly: give somebody an entitlement big enough and ask for
 * an entire leave year at once. Anything in the path holding a maximum — a constant, a
 * CHECK, a column somebody added to `leave_type` — refuses that, whatever its value.
 *
 * ## What does limit a request, and why none of it is this
 *
 * Three rules stop a request being longer, and each is somebody's decision rather than
 * the system's:
 *
 *   **The balance.** FR 26, and the company's own entitlement figure — the limit the
 *   company *did* set. Asking for more than that is [refused with the
 *   figure](#days-that-are-not-there), and it is refused for being unaffordable rather
 *   than for being long.
 *
 *   **The leave year.** FR 16. A request is one period against one balance and a balance
 *   belongs to one year, so the longest request there can be is a year — which is the
 *   bound this file asks for below.
 *
 *   **`LONGEST_PERIOD_DAYS`.** A guard against a mistyped year, at two years, which no
 *   period inside a single leave year can reach. ../unit/leave-calculator.test.ts holds
 *   the gap open.
 */
describe('how long a request may be', () => {
  /**
   * Four working weeks with no public holiday in them, which June 2026 is.
   *
   * Monday the first to Friday the twenty-sixth: twenty working days across twenty-six
   * calendar days, the four weekends inside it costing nothing. The month is chosen
   * because the gazette is empty between Eid al-Adha in May and Founders' Day in August,
   * so the twenty is twenty rather than an accident of which holidays fell where.
   */
  const ALL_TWENTY = { from: '2026-06-01', to: '2026-06-26' };

  /* The story's first criterion, said plainly. */
  it('is twenty days in one request, when twenty days is what somebody has', async () => {
    const { request, balance } = await requests.submit(asThemselves(), aRequest(ALL_TWENTY));

    expect(request.days).toBe(20);
    expect(request.calendarDays).toBe(26);
    expect(request.status).toBe('SUBMITTED');
    expect(balance.pending).toBe(20);
    expect(balance.available).toBe(0);
  });

  /**
   * And the quote said the same before anything was written, without warning about it.
   *
   * A balance taken exactly to nought is not a problem and must not read as one: the
   * `NOT_ENOUGH_DAYS` warning fires on `days > available`, so twenty against twenty is
   * silent. Somebody spending their whole entitlement deliberately should not be told
   * they are short.
   */
  it('and the quote prices it without warning that it is too much', async () => {
    const quote = await requests.quote(asThemselves(), aRequest(ALL_TWENTY));

    expect(quote.days).toBe(20);
    expect(quote.availableNow).toBe(20);
    expect(quote.availableAfter).toBe(0);
    expect(quote.warnings.map((warning) => warning.code)).not.toContain('NOT_ENOUGH_DAYS');
  });

  /* And the twenty-first day is refused by the balance rather than by a length rule —
     the distinction the whole story is about. The message names the figure. */
  it('and the day past it is refused for the balance, not for the length', async () => {
    const refusal = await requests
      .submit(asThemselves(), aRequest({ from: '2026-06-01', to: '2026-06-29' }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(NotEnoughDays);
    expect((refusal as NotEnoughDays).message).toContain('you have 20 left');
  });

  /**
   * And a whole leave year in one request, which is the longest there can be.
   *
   * The second criterion, and the one that proves the absence rather than a value. Any
   * maximum anywhere in the path — a constant compared against the day count, a CHECK on
   * the column, a `max_consecutive_days` on the leave type — refuses two hundred and
   * forty-eight days whatever number it holds. This passes only if there is nothing.
   *
   * The entitlement is put up first, by hand and through the one door, because the point
   * is to remove the *company's* limit and see whether another one is hiding behind it.
   * That is FR 37's adjustment doing exactly what it is for.
   *
   * The count is asserted as a floor rather than as an exact figure. Which days of 2026
   * are working days is the calendar's business and ./leave-calculator.test.ts's; what
   * this file is about is that nothing refused them for being many.
   */
  it('and an entire leave year, once the balance covers it', async () => {
    await balances.adjust(system, {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 300,
      reason: 'Testing that nothing caps a request by its length. FR 20a.',
    });

    const wholeYear = aRequest({ from: '2026-01-01', to: '2026-12-31' });
    const quote = await requests.quote(asThemselves(), wholeYear);

    /* Every working day of the year, less the holidays that fell on one. */
    expect(quote.days).toBeGreaterThan(240);
    expect(quote.calendarDays).toBe(365);

    const { request, balance } = await requests.submit(asThemselves(), wholeYear);

    expect(request.days).toBe(quote.days);
    expect(request.calendarDays).toBe(365);
    expect(balance.pending).toBe(quote.days);
  });

  /**
   * And nothing in the schema bounds the day count from above.
   *
   * The database is where a cap would be most durable and least visible, so the absence
   * is asserted against `pg_constraint` rather than against the migration text — what is
   * actually on the table, including anything a later migration adds.
   *
   * Every bound on `days` today is *relative*: at least one, and no more than the period
   * spans. Both are rules about coherence rather than about length, and neither has a
   * ceiling in it. A `CHECK (days <= 30)` is what this fails on.
   */
  it('and no CHECK on the table bounds the days by a number', async () => {
    const { rows } = await admin.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'leave_request'::regclass AND contype = 'c'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows
        .filter(({ definition }) => /\bdays\s*<=?\s*\d/.test(definition))
        .map(({ conname, definition }) => `${conname}: ${definition}`),
    ).toEqual([]);
  });
});

/* ------------------------------------------------- the copy, and what it protects */

describe('the counting basis is copied onto the request', () => {
  /**
   * The story's third criterion, and the whole reason the column exists.
   *
   * An HR Administrator moving a type from working days to calendar days is one
   * dropdown. Without the copy, every request ever made under the old rule silently
   * restates itself: last March's fortnight begins displaying as fourteen days rather
   * than ten, beside a ledger that still says ten, and nothing says which is right.
   */
  it('so a later change to the leave type does not reprice it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query("UPDATE leave_type SET counting_basis = 'CALENDAR_DAYS' WHERE id = $1", [
      annualId,
    ]);

    const readBack = await requests.byId(asThemselves(), request.id);

    expect(readBack.countingBasis).toBe('WORKING_DAYS');
    expect(readBack.days).toBe(6);
    expect(readBack.calendarDays).toBe(9);
  });

  /* And the ledger agrees with it, which is the half that matters: the days that came
     off the balance are the days the request says it cost. */
  it('and the days held stay the days that were held', async () => {
    await requests.submit(asThemselves(), aRequest());

    await admin.query("UPDATE leave_type SET counting_basis = 'CALENDAR_DAYS' WHERE id = $1", [
      annualId,
    ]);

    const balance = await balances.forOne(asThemselves(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
    });

    expect(balance.pending).toBe(6);
    expect(balance.available).toBe(14);
  });

  /* And the *next* request is priced under the new rule, which is what makes the copy a
     copy rather than a freeze. Configuration describes what happens next. */
  it('and the next request is priced under the new rule', async () => {
    await admin.query("UPDATE leave_type SET counting_basis = 'CALENDAR_DAYS' WHERE id = $1", [
      annualId,
    ]);

    const { request } = await requests.submit(asThemselves(), aRequest());

    expect(request.countingBasis).toBe('CALENDAR_DAYS');
    expect(request.days).toBe(9);
  });

  /* The column is held closed, as the leave type's is, and the two lists are the same
     one — ../unit/leave-request.test.ts asserts the domain's copy. */
  it('and nothing outside the two bases can be stored, by anybody', async () => {
    await requests.submit(asThemselves(), aRequest());

    await expect(
      admin.query("UPDATE leave_request SET counting_basis = 'HALF_DAYS'"),
    ).rejects.toBeDefined();
  });
});

/* ---------------------------------------------- what a request said, it goes on saying */

describe('a request is what was asked for', () => {
  it('and the figures it was priced from cannot be rewritten, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    for (const change of [
      "start_date = '2026-03-03'",
      "end_date = '2026-03-20'",
      'days = 3',
      'calendar_days = 3',
      "counting_basis = 'CALENDAR_DAYS'",
      "submitted_at = now() - interval '30 days'",
    ]) {
      await expect(
        admin.query(`UPDATE leave_request SET ${change} WHERE id = $1`, [request.id]),
      ).rejects.toMatchObject({ constraint: 'leave_request_says_what_it_said' });
    }
  });

  /* The reason explains rather than decides, which is the same line
     `leave_entitlement_event` draws around its note. */
  it('but the reason may still be improved, by the person who wrote it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const reworded = await requests.reword(
      asThemselves(),
      request.id,
      'My sister is getting married in Kumasi',
    );

    expect(reworded.reason).toBe('My sister is getting married in Kumasi');
    expect(reworded.days).toBe(6);
  });

  it('and not by anybody else, however senior', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    for (const who of [asTheirManager(), asOfficer(), asAColleague()]) {
      await expect(requests.reword(who, request.id, 'something else')).rejects.toBeInstanceOf(
        NotAuthorised,
      );
    }
  });

  /* Nothing is removed. A request heads a RESERVATION that is in the ledger forever, so
     deleting it would leave days held with nothing to say who is holding them. */
  it('and nothing is ever deleted, by anybody', async () => {
    await requests.submit(asThemselves(), aRequest());

    await expect(admin.query('DELETE FROM leave_request')).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('and who asked for it is in the audit log', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const { rows } = await admin.query<{ actor: string; action: string }>(
      `SELECT actor, action FROM audit_log WHERE entity = 'leave_request' AND entity_id = $1`,
      [request.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('CREATE');
    expect(rows[0].actor).toContain(people.officer);
  });
});

/* --------------------------------------------------------- what may not be asked for */

describe('what leave may be asked for', () => {
  /* A request is one period against one balance, and a balance belongs to one leave
     year. Refused with both years named rather than split. */
  it('never a period that runs past the end of its leave year', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-12-28', to: '2027-01-05' })),
    ).rejects.toBeInstanceOf(LeaveCrossesAYearEnd);
  });

  /**
   * And the sentence names both years and the two dates to resubmit on. FR 16, LMS 303.
   *
   * The message is asserted whole in ../unit/leave-request.test.ts. What needs a
   * database is that the years in it are the ones on the rows: this reads the seeded
   * 2026 and 2027 through `findCovering`, so a service that had hard-coded either — or
   * looked up the wrong day — would say something else here and nowhere else.
   */
  it('and says which year it crosses into, and the two dates to submit instead', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-12-28', to: '2027-01-05' })),
    ).rejects.toMatchObject({
      code: 'CROSS_LEAVE_YEAR',
      message:
        'This request crosses into the 2027 leave year. Submit one request ending ' +
        '31 December 2026, and another starting 1 January 2027.',
      endsOn: '2026-12-31',
      resumesOn: '2027-01-01',
    });
  });

  /**
   * **The year in that sentence is whatever HR called it.**
   *
   * §5.4 does not say a leave year is a calendar year, and the label is deliberately not
   * derived from the start date — `requireLabel` says so, because a company running
   * April to March calls its year '2026/27'. Renaming the seeded 2027 is the cheapest
   * proof that the message reads the row rather than the date: nothing else about the
   * request moves, and the sentence has to move with it.
   */
  it('and takes that year name from the record rather than from the date', async () => {
    await admin.query("UPDATE leave_year SET label = '2027/28' WHERE label = '2027'");

    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-12-28', to: '2027-01-05' })),
    ).rejects.toMatchObject({
      message:
        'This request crosses into the 2027/28 leave year. Submit one request ending ' +
        '31 December 2026, and another starting 1 January 2027.',
    });
  });

  /* And it is refused before anything is written, which is the whole of "at once":
     nothing to withdraw, no days held, and no approver waiting. */
  it('and nothing is written when a request is refused for its dates', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-12-28', to: '2027-01-05' })),
    ).rejects.toBeInstanceOf(LeaveCrossesAYearEnd);

    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('0');
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RESERVATION'",
        )
      ).rows[0].count,
    ).toBe('0');
  });

  /**
   * The other two obviously wrong shapes, refused by `submit` as well as by `quote`.
   *
   * The quote refuses both above, and both are asserted again here against the
   * submission because the two paths sharing `resolve` and `countFor` is an
   * implementation detail — a person who was quoted nothing and submitted anyway must
   * meet the same refusal, and this is the test that fails if the two ever come apart.
   */
  it('nor two dates the wrong way round', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-03-10', to: '2026-03-02' })),
    ).rejects.toBeInstanceOf(InvalidLeavePeriod);
  });

  /* FR 16a. A weekend of annual leave costs nothing, and the calculator says so with a
     nought — this is the refusal built on that answer, named against the real gazette
     and the real working pattern. */
  it('nor a period that costs nothing at all', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-03-07', to: '2026-03-08' })),
    ).rejects.toBeInstanceOf(LeaveCountsNoDays);
  });

  /**
   * And the same days of a calendar-day type are perfectly askable.
   *
   * The pair that shows the refusal is about the counting rule rather than about the
   * dates: same weekend, same person, one refused and one quoted at two days. Somebody
   * who really did mean to record the whole period has chosen the wrong kind of leave,
   * which is what the message tells them — and this is the test that it is true advice.
   */
  it('but the same weekend of a type that counts every day is quoted, not refused', async () => {
    const quote = await requests.quote(
      asThemselves(),
      aRequest({ leaveTypeId: maternityId, from: '2026-03-07', to: '2026-03-08' }),
    );

    expect(quote.days).toBe(2);
  });

  /* And the database holds the same rule for every other writer, so the two cannot
     drift. */
  it('and the database refuses one filed under the wrong year, by anybody', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_request (
            employee_id, leave_type_id, leave_year_id, start_date, end_date,
            reason, counting_basis, days, calendar_days, status, awaiting_approval_from)
         VALUES ($1, $2, $3, '2025-03-02', '2025-03-10', 'the wrong year',
                 'WORKING_DAYS', 7, 9, 'SUBMITTED', 'MANAGER')`,
        [people.officer, annualId, y2026.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_falls_in_its_leave_year' });
  });

  /* §8.9. A settled year takes no new figures but an adjustment, and the refusal is
     said in front of the form rather than by a trigger about ledger entries. */
  it('nor leave in a year that has been settled', async () => {
    /* A year of its own, because 2026 has not finished and `assertMayBeClosed` refuses
       to freeze figures people are still adding to. */
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date)
       VALUES ('2025', '2025-01-01', '2025-12-31')`,
    );
    const y2025 = (await years.byLabel(system, '2025'))!;

    await years.close(
      signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true }),
      y2025.id,
    );

    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2025-03-03', to: '2025-03-11' })),
    ).rejects.toBeInstanceOf(LeaveYearIsClosed);
  });

  it('nor a kind of leave that is no longer offered', async () => {
    await admin.query('UPDATE leave_type SET is_active = false WHERE id = $1', [annualId]);

    await expect(requests.submit(asThemselves(), aRequest())).rejects.toBeInstanceOf(
      LeaveTypeRetired,
    );
  });

  it('nor against somebody who does not exist', async () => {
    await expect(
      requests.submit(system, aRequest({ employeeId: '987654321' })),
    ).rejects.toBeInstanceOf(EmployeeNotFound);
  });

  it('nor with no reason at all', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ reason: '  ' })),
    ).rejects.toBeInstanceOf(InvalidLeaveRequest);
  });
});

/* ------------------------------------------- leave over leave already booked */

/**
 * FR 15, §5.6. LMS 304.
 *
 * The defect is a balance consumed twice for the same days, and it is worth being
 * precise about why it needs a story: nothing about it looks wrong while it happens.
 * Somebody books the second to the tenth of March, forgets, and books the fifth to the
 * twelfth. Both reserve. Both entries reconcile. Every figure is explainable and the
 * balance is still incorrect — which is the one shape of error design principle 1
 * cannot catch, because the record is faithful and the request was one nobody should
 * have been allowed to make.
 *
 * ../unit/leave-request.test.ts proves the predicate, the list and the sentence. What
 * needs a database is the part that is about *rows*: that the check sees leave of every
 * kind, that the boundary is inclusive against a real `daterange`, and that the
 * exclusion constraint refuses what no application check could have caught.
 */
describe('leave cannot be booked over leave already booked', () => {
  /** The first request, which every case below is asked on top of. */
  async function alreadyBooked(): Promise<void> {
    await requests.submit(asThemselves(), aRequest());
  }

  it('is refused when the same days are asked for twice', async () => {
    await alreadyBooked();

    await expect(requests.submit(asThemselves(), aRequest())).rejects.toBeInstanceOf(
      LeaveOverlapsAnother,
    );
  });

  /**
   * And the refusal names the leave in the way. The story's second criterion.
   *
   * "You cannot book those days" tells somebody nothing they can act on: they are
   * looking at a form they believe in and the clash is with a row they cannot see. So
   * the dates, the day count and the kind are all in the sentence, and the request
   * itself is on the error for a screen to link to.
   */
  it('and the refusal names the request in the way, by its dates and its kind', async () => {
    await alreadyBooked();

    const refusal = await refusalFrom(
      requests.submit(asThemselves(), aRequest({ from: '2026-03-09', to: '2026-03-13' })),
    );

    expect(refusal.code).toBe('OVERLAPPING_REQUEST');
    expect(refusal.message).toBe(
      'You already have leave from 2 March 2026 to 10 March 2026 — 6 days of Annual ' +
        'Leave. The same days cannot be booked twice, or they come off your balance ' +
        'twice. Withdraw that request, or ask for dates outside it.',
    );
    expect(refusal.conflict?.request).toMatchObject({ from: FROM, to: TO, days: 6 });
  });

  /**
   * **A different kind of leave is still the same day off.**
   *
   * The constraint is keyed by employee and dates and deliberately not by leave type: a
   * person is away or they are not. Annual leave from the second to the tenth and sick
   * leave on the fifth are not two absences sharing a day, they are one day with two
   * claims on it, each taking a day off a different balance. FR 32b's conversion of sick
   * leave taken during annual leave is the real answer to that case, and it amends the
   * first request rather than writing a second beside it.
   */
  it('and leave of another kind over the same days is refused too', async () => {
    await alreadyBooked();

    const refusal = await refusalFrom(
      requests.submit(
        asThemselves(),
        aRequest({ leaveTypeId: maternityId, from: '2026-03-05', to: '2026-03-05' }),
      ),
    );

    expect(refusal.conflict?.typeName).toBe('Annual Leave');
  });

  /* The boundary, and it is the case an off-by-one would let through: leave ending on
     the tenth and leave starting on the tenth share the tenth. That is one day booked
     twice, which is the defect itself. */
  it('and a period sharing only one day with it is still refused', async () => {
    await alreadyBooked();

    await expect(
      requests.submit(asThemselves(), aRequest({ from: TO, to: '2026-03-13' })),
    ).rejects.toBeInstanceOf(LeaveOverlapsAnother);
  });

  /* And the other side of that boundary, which is what stops the rule being "no second
     request in March": leave starting the day after is ordinary and common — a
     fortnight, back for a day, then another week. */
  it('but a period starting the day after it ends is accepted', async () => {
    await alreadyBooked();

    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-03-11', to: '2026-03-13' })),
    ).resolves.toMatchObject({ request: { from: '2026-03-11' } });
  });

  /* One person's leave blocks that person's leave and nobody else's, which is the
     `employee_id WITH =` half of the constraint — and the half a `daterange`-only
     constraint would have got wrong by stopping the whole company taking the same
     fortnight. */
  it('and one person’s leave does not block anybody else’s', async () => {
    await alreadyBooked();

    /* Abena Sarpong has no entitlement of her own in this suite; the officer is the only
       person granted any. Granted here rather than in the fixture because this is the
       one test that needs a second person to be able to spend anything. */
    await balances.grantTheYear(system, {
      employeeId: people.partTimer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'Annual entitlement for 2026',
    });

    await expect(
      requests.submit(
        signedInAs(people.partTimer, { roles: ['EMPLOYEE'], isManager: false }),
        aRequest({ employeeId: people.partTimer }),
      ),
    ).resolves.toMatchObject({ request: { employeeId: people.partTimer } });
  });

  /**
   * The quote refuses it too, which is where somebody actually finds out.
   *
   * The story is that the system stops them booking over leave they already have, not
   * that it prices it first and refuses afterwards — the same rule LMS 303 established
   * for the other refusals, held by `quote` and `submit` sharing `resolve()`.
   */
  it('and a quote for those days is refused rather than priced', async () => {
    await alreadyBooked();

    await expect(
      requests.quote(asThemselves(), aRequest({ from: '2026-03-09', to: '2026-03-13' })),
    ).rejects.toBeInstanceOf(LeaveOverlapsAnother);
  });

  /* Refused before anything is written: no second request, and no second hold on the
     balance. The days the first request took are the only days taken. */
  it('and nothing is written by the request that was refused', async () => {
    await alreadyBooked();

    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-03-09', to: '2026-03-13' })),
    ).rejects.toBeInstanceOf(LeaveOverlapsAnother);

    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('1');
    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RESERVATION'",
        )
      ).rows[0].count,
    ).toBe('1');
    const balance = await balances.forOne(asThemselves(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
    });

    expect(balance.pending).toBe(6);
  });

  /**
   * **And the constraint refuses it where no application check could have.**
   *
   * The story's third criterion. `LeaveRequestService` asks first so the refusal can
   * name the leave in the way, but that ask cannot close the window: two tabs submitting
   * the same fortnight at the same moment both read a table with no conflict in it, both
   * pass, and only the database sees the second row land on the first.
   *
   * A direct INSERT on the owner connection is that race made deterministic — it is the
   * one writer no service check is in front of, which is exactly the position the second
   * of two racing submissions is in.
   */
  it('and the database refuses an overlapping row, by anybody', async () => {
    await alreadyBooked();

    await expect(
      admin.query(
        `INSERT INTO leave_request (
            employee_id, leave_type_id, leave_year_id, start_date, end_date,
            reason, counting_basis, days, calendar_days, status, awaiting_approval_from)
         VALUES ($1, $2, $3, '2026-03-09', '2026-03-13', 'straight past the service',
                 'WORKING_DAYS', 4, 5, 'SUBMITTED', 'MANAGER')`,
        [people.officer, annualId, y2026.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_never_overlaps', code: '23P01' });
  });

  /**
   * And the list of statuses that block is written twice — here and in the domain.
   *
   * `LIVE_STATUSES` and the constraint's `WHERE` are the same list, and today both hold
   * the single value `REQUEST_STATUSES` holds. That makes this test look like a
   * formality and it is the opposite: the approval story adds APPROVED to both and
   * WITHDRAWN, CANCELLED and REFUSED to neither, and a story that extends one and
   * forgets the other either blocks leave that was refused in January or lets a person
   * book over leave that was approved. This is what fails instead.
   */
  it('and the constraint blocks exactly the statuses the code calls live', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'leave_request'::regclass AND conname = 'leave_request_never_overlaps'`,
    );

    expect(rows).toHaveLength(1);
    expect(
      [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort(),
    ).toEqual([...LIVE_STATUSES].sort());
  });

  /** The refusal, awaited, so a test can read what it said rather than only its type. */
  async function refusalFrom(work: Promise<unknown>): Promise<LeaveOverlapsAnother> {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(LeaveOverlapsAnother);
      return error as LeaveOverlapsAnother;
    }

    throw new Error('That was accepted, and should not have been.');
  }
});

/* ------------------------------------------------- the days come back, LMS 306 */

/**
 * A request ends, and its days come back. FR 26, §8.2. LMS 306.
 *
 * ../unit/leave-request.test.ts proves which statuses end a request and what the movement
 * says. What needs a server is the whole of what the story actually promises:
 *
 *   **The balance moves.** "The balance I see is what I can actually still book" is a
 *   claim about a figure in a table, and only a real one can be watched going down at
 *   submission and back up at withdrawal.
 *
 *   **The status and the RELEASE are one act.** A foreign key, a deferred constraint
 *   trigger, a unique index and a rollback are not properties any pure function has —
 *   and the failure they prevent is a balance permanently short with nothing to explain
 *   it.
 *
 *   **The days can be booked again.** This is the one that ties the story to LMS 304: the
 *   overlap constraint's `WHERE status IN ('SUBMITTED')` was a tautology until three
 *   statuses arrived that are not in it, and this is the test that shows it stopped being
 *   one.
 */
describe('withdrawing, refusing and cancelling', () => {
  it('gives the days back and says so in the balance', async () => {
    const { request, balance: held } = await requests.submit(asThemselves(), aRequest());
    expect(held.available).toBe(14);

    const { balance } = await requests.withdraw(asThemselves(), request.id);

    expect(balance.pending).toBe(0);
    expect(balance.available).toBe(20);
  });

  it('and the request says which ending it had', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    const withdrawn = await requests.withdraw(asThemselves(), request.id);

    expect(withdrawn.request.status).toBe('WITHDRAWN');
    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      status: 'WITHDRAWN',
    });
  });

  /* The other half of the reservation's sentence. The two read as a pair in a history,
     which is what makes a balance explain itself rather than merely reconcile. */
  it('and the RELEASE names the request, the days and which ending it was', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    const { entry } = await requests.withdraw(asThemselves(), request.id);

    expect(entry.entryType).toBe('RELEASE');
    expect(entry.days).toBe(6);
    expect(entry.leaveRequestId).toBe(request.id);
    expect(entry.reason).toContain('6 days of Annual Leave given back');
    expect(entry.reason).toContain('the request was withdrawn');
  });

  /* Three desks, three endings, one movement. `ledgerPolicy.release` has described this
     since LMS 212 and these are the methods that took it up. */
  it.each([
    ['withdrawn by the person who asked', 'WITHDRAWN', () => asThemselves()],
    ['refused by their line manager', 'REFUSED', () => asTheirManager()],
    ['cancelled by HR', 'CANCELLED', () => asOfficer()],
  ] as const)('and is %s', async (_what, status, who) => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const ended = await ending(status)(who(), request.id);

    expect(ended.request.status).toBe(status);
    expect(ended.balance.available).toBe(20);
    expect(ended.entry.reason).toContain(status.toLowerCase());
  });

  /**
   * And the second ending is refused, with a sentence rather than a figure.
   *
   * The balance cannot be the guard: `pending` is per employee, leave type and leave
   * year, so with other leave waiting there would be days for a second release to take
   * and the ledger would accept it. This is the state machine keeping the integrity
   * `ledgerPolicy.release` says is its to keep.
   */
  it('and a request that has already ended cannot end again', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), request.id);

    await expect(requests.withdraw(asThemselves(), request.id)).rejects.toBeInstanceOf(
      LeaveAlreadySettled,
    );
    await expect(requests.refuse(asTheirManager(), request.id, WHY_NOT)).rejects.toBeInstanceOf(
      LeaveAlreadySettled,
    );
  });

  /* And the days did not come back twice, which is what that refusal is protecting. */
  it('and the days come back exactly once', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), request.id);
    await requests.withdraw(asThemselves(), request.id).catch(() => undefined);

    const balance = await balances.forOne(asThemselves(), theBalance());

    expect(balance.available).toBe(20);
    expect(
      (await admin.query("SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RELEASE'"))
        .rows[0].count,
    ).toBe('1');
  });

  /**
   * And the days are bookable again, which is the story's point and LMS 304's payoff.
   *
   * `leave_request_never_overlaps` carries `WHERE status IN ('SUBMITTED')`, a predicate
   * that excluded nothing until this story added three statuses that are not in it. The
   * same fortnight, asked for twice, refused the second time while the first stands and
   * accepted once it has been withdrawn.
   */
  it('and the same days can be asked for again once the first request has gone', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.submit(asThemselves(), aRequest())).rejects.toBeInstanceOf(
      LeaveOverlapsAnother,
    );

    await requests.withdraw(asThemselves(), request.id);

    const again = await requests.submit(asThemselves(), aRequest());

    expect(again.request.status).toBe('SUBMITTED');
    expect(again.balance.available).toBe(14);
  });

  /* And the reason may still be improved afterwards, which is why the transition trigger
     compares the two statuses rather than refusing every update to a settled row. The
     record of what somebody asked for and why is what an appeal is worked from. */
  it('and the reason can still be improved after a refusal', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.refuse(asTheirManager(), request.id, WHY_NOT);

    await expect(
      requests.reword(asThemselves(), request.id, 'It is my sister, and it is her wedding'),
    ).resolves.toMatchObject({ status: 'REFUSED', reason: expect.stringContaining('sister') });
  });

  /* ------------------------------------------------------------ who may end one */

  /**
   * A manager may refuse leave and may not withdraw it, and the difference is the record.
   *
   * A manager who could withdraw a report's leave could empty their calendar without ever
   * refusing anything and without a decision appearing anywhere. Refusing is the same
   * movement wearing its own name, and `reasonForRelease` writes which one happened.
   */
  it('is refused by a manager, and never withdrawn by one', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.withdraw(asTheirManager(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(requests.refuse(asTheirManager(), request.id, WHY_NOT)).resolves.toMatchObject({
      request: { status: 'REFUSED' },
    });
  });

  /* And somebody does not mark their own leave refused. Taking back your own request is
     withdrawing it, and "refused" against nobody's decision is a record of something that
     did not happen. */
  it('and is not refused or cancelled by the person who asked for it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.refuse(asThemselves(), request.id, WHY_NOT)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(requests.cancel(asThemselves(), request.id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('and is never ended by a colleague, whichever ending they reach for', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    for (const end of RELEASING_STATUSES) {
      await expect(ending(end)(asAColleague(), request.id)).rejects.toBeInstanceOf(NotAuthorised);
    }

    const balance = await balances.forOne(asThemselves(), theBalance());
    expect(balance.available).toBe(14);
  });

  it('and a refusal to end one writes no movement at all', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.withdraw(asAColleague(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    expect(
      (await admin.query("SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RELEASE'"))
        .rows[0].count,
    ).toBe('0');
  });

  it('and an id that is nobody’s is not found rather than refused obscurely', async () => {
    await expect(requests.withdraw(asThemselves(), '987654321')).rejects.toBeInstanceOf(
      LeaveRequestNotFound,
    );
  });

  /* ------------------------------------------- and what the database holds anyway */

  /**
   * The list of statuses is written twice, here and in the domain.
   *
   * The same argument `LIVE_STATUSES` and the overlap constraint's predicate make: a
   * status added to one and not the other is a status the application writes and the
   * database refuses, or a value the CHECK admits that nothing means. The approval story
   * adds APPROVED to both.
   */
  it('the CHECK admits exactly the statuses the code knows', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'leave_request'::regclass AND conname = 'leave_request_status_known'`,
    );

    expect(rows).toHaveLength(1);
    expect(
      [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort(),
    ).toEqual([...REQUEST_STATUSES].sort());
  });

  /**
   * And the trigger permits exactly the endings the table does. §6. LMS 313.
   *
   * The state machine is stated twice — `TRANSITIONS` in the domain and
   * `refuse_an_impossible_transition()` in the schema — for the reason every rule in this
   * system is stated twice: the application half speaks to a person and the database half
   * holds for every connection. What that arrangement costs is the pair drifting, and the
   * drift here is silent in the worst direction. A destination added to the table and not
   * to the trigger is refused at the write with a message about impossible transitions; a
   * destination in the trigger and not the table is a state the database will happily
   * accept and nothing knows how to reach or leave.
   *
   * So the trigger is read back out of `pg_get_functiondef` and held to the table, the
   * same way `leave_request_never_overlaps` is held to `LIVE_STATUSES`.
   */
  it('and the trigger permits exactly the endings the table holds', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_functiondef(oid) AS definition
         FROM pg_proc WHERE proname = 'refuse_an_impossible_transition'`,
    );

    expect(rows).toHaveLength(1);

    const named = [...new Set([...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]))];

    expect(named.sort()).toEqual([...new Set(TRANSITIONS.map(({ to }) => to))].sort());
  });

  /**
   * And a request that ends without giving its days back is refused at COMMIT.
   *
   * The acceptance criterion the story is named for, held where no service can forget it.
   * `leave_request_gives_its_days_back` is the mirror of `leave_request_holds_its_days`,
   * and what it catches is the second writer: a data fix marking a batch REFUSED, a
   * `cancelAll` that loops over statuses. Each looks reasonable and each would leave days
   * held forever.
   */
  it('and a status moved without a RELEASE is refused at commit, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(
      admin.query(
        `UPDATE leave_request SET status = 'REFUSED', awaiting_approval_from = NULL
          WHERE id = $1`,
        [request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_gives_its_days_back' });
  });

  /* And a request that has ended does not move again, refused as it is attempted rather
     than at commit: a row leaving a state it already left is wrong immediately. The
     constraint was called `leave_request_ends_once` until LMS 314 widened it to hold every
     move §6 permits, which is a name somebody reads in an error about approved leave. */
  it('and a request that has ended cannot be moved again, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), request.id);

    await expect(
      admin.query(`UPDATE leave_request SET status = 'REFUSED' WHERE id = $1`, [request.id]),
    ).rejects.toMatchObject({ constraint: 'leave_request_moves_as_the_table_says' });

    await expect(
      admin.query(
        `UPDATE leave_request SET status = 'SUBMITTED', awaiting_approval_from = 'MANAGER'
          WHERE id = $1`,
        [request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_moves_as_the_table_says' });
  });

  /* And a second RELEASE against one request, which is what a retry would write. The
     mirror of `leave_request_reserves_once`. */
  it('and one request gives its days back exactly once, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), request.id);

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry (
            employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
         VALUES ($1, $2, $3, 'RELEASE', '6.00', 'given back twice', $4)`,
        [people.officer, annualId, y2026.id, request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_releases_once' });
  });

  /* ------------------------------------------- and every move is on the record */

  /**
   * Every transition writes an audit entry. §6, NFR AUD 01. LMS 313's third criterion.
   *
   * The story is a request nobody can explain, and this is the half that makes it
   * explicable *afterwards* rather than merely correct at the time: the state a request
   * is in, and the person who put it there, are two different facts and only one of them
   * is on the row.
   *
   * **Nothing in the application writes the entry**, which is the whole design and is
   * argued for in the audit-log migration: an entry a service composes is one it can
   * compose wrongly, or forget, or write outside the transaction that made the change.
   * `leave_request_is_audited` fires on the UPDATE, inside the same transaction as the
   * status and the `RELEASE`, so a rolled-back settlement leaves no entry either.
   *
   * What the application supplies is the one thing the database cannot know — who — and
   * it reaches the trigger through `recording()`. That is why this asserts the actor
   * rather than only the row's existence: an entry recording that *something* withdrew
   * the leave is the entry a dispute cannot use.
   */
  it.each([
    ['WITHDRAWN', () => asThemselves(), () => people.officer],
    ['REFUSED', () => asTheirManager(), () => people.teamLead],
    ['CANCELLED', () => asOfficer(), () => people.hrOfficer],
  ] as const)('%s is on the record, with the person who did it', async (status, who, actor) => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await ending(status)(who(), request.id);

    const { rows } = await admin.query<{
      actor: string;
      action: string;
      after: { status: string };
    }>(
      `SELECT actor, action, after FROM audit_log
        WHERE entity = 'leave_request' AND entity_id = $1 AND action = 'UPDATE'`,
      [request.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toContain(actor());
    expect(rows[0].after.status).toBe(status);
  });

  /**
   * And the entry says what it moved *from*, which is what makes it a transition rather
   * than a state.
   *
   * `before` and `after` are both on the row, so the log answers "who moved this request
   * out of SUBMITTED, and when" without joining anything. A log recording only the new
   * value would tell somebody the request is refused, which they can already see.
   */
  it('and the entry carries the state it moved out of as well as into', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), request.id);

    const { rows } = await admin.query<{
      before: { status: string };
      after: { status: string };
    }>(
      `SELECT before, after FROM audit_log
        WHERE entity = 'leave_request' AND entity_id = $1 AND action = 'UPDATE'`,
      [request.id],
    );

    expect(rows[0].before.status).toBe('SUBMITTED');
    expect(rows[0].after.status).toBe('WITHDRAWN');
  });

  /**
   * And a settlement that was refused leaves no entry, because it left no change.
   *
   * The trigger fires inside the transaction that made the change, so a rolled-back one
   * takes its audit entry with it. An audit log with a window in it — where the row moved
   * and the entry had not landed, or the entry landed and the row did not — is wrong
   * exactly when somebody is investigating.
   */
  it('and a refused settlement is not on the record at all', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.withdraw(asAColleague(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    const { rows } = await admin.query(
      `SELECT 1 FROM audit_log
        WHERE entity = 'leave_request' AND entity_id = $1 AND action = 'UPDATE'`,
      [request.id],
    );

    expect(rows).toHaveLength(0);
  });

  /** The three endings, as the methods that reach them. */
  function ending(status: (typeof RELEASING_STATUSES)[number]) {
    switch (status) {
      case 'WITHDRAWN':
        return (actor: Actor, id: string) => requests.withdraw(actor, id);
      /* FR 39, LMS 315. Refusing says why, so the helper supplies the sentence a manager
         would have typed. The other two are not decisions at a desk and take none, which
         is why this cannot go on being three bound methods with one shape. */
      case 'REFUSED':
        return (actor: Actor, id: string) => requests.refuse(actor, id, WHY_NOT);
      default:
        return (actor: Actor, id: string) => requests.cancel(actor, id);
    }
  }

  /** The balance every test here moves: her annual leave, this year. */
  function theBalance() {
    return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id };
  }
});

/* ------------------------------------------- routing a request through its chain */

/**
 * A request goes to the approvers its leave type names, in order. FR 38, FR 38a, FR 40.
 * LMS 314.
 *
 * ../unit/state-machine.test.ts proves the walk against chains written out by hand, which
 * is where the arithmetic of "next desk, or approved" belongs. What needs a database is
 * everything the story is actually about:
 *
 *   **The chain is the one on the leave type**, read out of `leave_type_approval_step`
 *   rather than out of a constant. Annual leave routes to the manager and unpaid leave
 *   routes to HR because of rows the leave-type-approval-chain migration wrote, and the
 *   only way to show that is to route a request of each against the real ones.
 *
 *   **The desks resolve to people**, and the three do it three different ways — a reporting
 *   line, a pair of granted roles, and the one employee FR 04 leaves without a manager.
 *   Only a real organisation has all three.
 *
 *   **The last approval commits the days**, in the same transaction as the status. A
 *   `DEDUCTION`, a deferred constraint trigger and a balance recomputed by a trigger are
 *   not properties any pure function has.
 */
describe('routing a request to its approvers', () => {
  /** The chain the two unpaid types carry, which is the third criterion's whole point. */
  let unpaidId: string;

  beforeEach(async () => {
    const rows = await admin.query("SELECT id FROM leave_type WHERE code = 'UNPAID'");
    unpaidId = rows.rows[0].id as string;

    /* Unpaid leave is an event type with no annual grant, so there is nothing to book
       against it until somebody puts a figure there. FR 37's adjustment, doing what it is
       for — the balance is not what this suite is about. Both people who ask for unpaid
       leave below get one. */
    for (const employeeId of [people.officer, people.hrOfficer]) {
      await balances.adjust(system, {
        employeeId,
        leaveTypeId: unpaidId,
        leaveYearId: y2026.id,
        days: 20,
        reason: 'So there is unpaid leave to ask for. FR 37.',
      });
    }
  });

  /* Kwame Asante, the one employee with no line manager. FR 04. */
  function asTheChiefExecutive() {
    return signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true });
  }

  /* ------------------------------------------------- the first stage, FR 38a */

  /**
   * The story's first criterion, and the reason it is asserted against two types at once.
   *
   * One type would prove that a request starts *somewhere*. Two, with different chains,
   * prove it starts where its own chain says — and neither the service nor the domain knows
   * which type is which, because both read the same column.
   */
  it('starts a request at the first desk of its type’s chain', async () => {
    const ordinary = await requests.submit(asThemselves(), aRequest());
    const unpaid = await requests.submit(
      asThemselves(),
      aRequest({ leaveTypeId: unpaidId, from: '2026-05-04', to: '2026-05-08' }),
    );

    expect(ordinary.request.awaitingApprovalFrom).toBe('MANAGER');
    expect(unpaid.request.awaitingApprovalFrom).toBe('HR');
  });

  /* And it is read off the rows rather than off anything in the code: changing the chain
     changes where the next request starts, with no deployment. FR 31. */
  it('and takes it from the rows, so changing the chain changes where leave starts', async () => {
    await rewriteTheAnnualChain('CEO');

    const { request } = await requests.submit(asThemselves(), aRequest());

    expect(request.awaitingApprovalFrom).toBe('CEO');
  });

  /* ---------------------------------------- advancing, and the last word */

  /**
   * The story's second criterion, walked end to end against the real chain.
   *
   * The manager's yes is not an approval — it is a stage — and the request comes back
   * `SUBMITTED` and waiting on HR. That is the assertion the whole design turns on: if a
   * single approval decided the request, the second stage of every chain in the company
   * would be decoration.
   */
  it('advances to the next stage on the first approval, and stays submitted', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const advanced = await requests.approve(asTheirManager(), request.id);

    expect(advanced.request.status).toBe('SUBMITTED');
    expect(advanced.request.awaitingApprovalFrom).toBe('HR');
    /* And nothing moved in the ledger, because nothing moved in the balance. */
    expect(advanced.entry).toBeNull();
    expect(advanced.balance.pending).toBe(6);
    expect(advanced.balance.taken).toBe(0);
    expect(advanced.balance.available).toBe(14);
  });

  it('and to approved once the chain has nobody left to ask', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    const approved = await requests.approve(asOfficer(), request.id);

    expect(approved.request.status).toBe('APPROVED');
    expect(approved.request.awaitingApprovalFrom).toBeNull();
  });

  /**
   * And the last approval turns held days into taken days, leaving available where it was.
   *
   * The movement `BalanceService.commit` has been built and unused for since LMS 212. A
   * `DEDUCTION` is the one entry type that moves two buckets — out of `pending`, into
   * `taken` — so a person whose leave is approved sees the same figure they saw when they
   * asked, which is correct: the days were spoken for either way.
   */
  it('and the days become taken rather than held, with available unmoved', async () => {
    const { request, balance: held } = await requests.submit(asThemselves(), aRequest());

    expect([held.pending, held.taken, held.available]).toEqual([6, 0, 14]);

    await requests.approve(asTheirManager(), request.id);
    const { balance, entry } = await requests.approve(asOfficer(), request.id);

    expect(balance.pending).toBe(0);
    expect(balance.taken).toBe(6);
    expect(balance.available).toBe(14);

    expect(entry?.entryType).toBe('DEDUCTION');
    expect(entry?.days).toBe(-6);
    expect(entry?.leaveRequestId).toBe(request.id);
  });

  /* And the DEDUCTION says what it is for, in the words somebody reading a balance can use
     — the third of the trio with the RESERVATION and the RELEASE. */
  it('and the deduction says what it is for, and which desk decided it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    const { entry } = await requests.approve(asOfficer(), request.id);

    expect(entry?.reason).toContain('6 days of Annual Leave taken');
    expect(entry?.reason).toContain('approved by HR');
  });

  /* ------------------------------------ unpaid leave, which has no manager stage */

  /**
   * The story's third criterion. FR 32h, §4.3.1 — "Decided by HR and the Chief Executive".
   *
   * Two things are asserted and the second is the one that matters: unpaid leave reaches HR
   * and then the Chief Executive, **and the line manager is not a stage on it at all**. A
   * chain that merely put HR first would still let a manager sign off unpaid leave, which is
   * an arrangement with the company rather than a team's business.
   */
  it('routes unpaid leave to HR and then the Chief Executive', async () => {
    const unpaid = aRequest({ leaveTypeId: unpaidId, from: '2026-05-04', to: '2026-05-08' });
    const { request } = await requests.submit(asThemselves(), unpaid);

    expect(request.awaitingApprovalFrom).toBe('HR');

    const advanced = await requests.approve(asOfficer(), request.id);

    expect(advanced.request.status).toBe('SUBMITTED');
    expect(advanced.request.awaitingApprovalFrom).toBe('CEO');

    const approved = await requests.approve(asTheChiefExecutive(), request.id);

    expect(approved.request.status).toBe('APPROVED');
    expect(approved.entry?.entryType).toBe('DEDUCTION');
  });

  it('and never lets the line manager approve it, at either stage', async () => {
    const unpaid = aRequest({ leaveTypeId: unpaidId, from: '2026-05-04', to: '2026-05-08' });
    const { request } = await requests.submit(asThemselves(), unpaid);

    await expect(requests.approve(asTheirManager(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    await requests.approve(asOfficer(), request.id);

    await expect(requests.approve(asTheirManager(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  /* And the Chief Executive is not admitted to an ordinary chain either, which is the same
     rule read the other way: the desks are a sequence and each answers for its own stage.
     Being the most senior person in the company is not standing on a chain that does not
     name the position. */
  it('and never lets the Chief Executive approve leave whose chain does not name them', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.approve(asTheChiefExecutive(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  /* ------------------------------------------------- who may, at each stage */

  it('is the line manager while it sits with them, and not HR reaching past', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.approve(asOfficer(), request.id)).rejects.toBeInstanceOf(NotAuthorised);
    await expect(requests.approve(asAColleague(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    await expect(requests.approve(asTheirManager(), request.id)).resolves.toMatchObject({
      request: { awaitingApprovalFrom: 'HR' },
    });
  });

  it('and HR once it has reached them, and not the manager a second time', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.approve(asTheirManager(), request.id);

    await expect(requests.approve(asTheirManager(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    await expect(requests.approve(asOfficer(), request.id)).resolves.toMatchObject({
      request: { status: 'APPROVED' },
    });
  });

  /**
   * And never the person who asked, at a desk they happen to staff.
   *
   * The case is ordinary rather than adversarial: unpaid leave goes to HR first, and an HR
   * Officer asking for unpaid leave holds a code that staffs that desk. Both the request
   * policy and `ledgerPolicy.commit` refuse it, and either would be enough — which is the
   * arrangement `submit` and `ledgerPolicy.reserve` already have.
   */
  it('and never the person who asked for it, even at a desk they staff', async () => {
    const { request } = await requests.submit(
      asOfficer(),
      aRequest({
        employeeId: people.hrOfficer,
        leaveTypeId: unpaidId,
        from: '2026-05-04',
        to: '2026-05-08',
      }),
    );

    expect(request.awaitingApprovalFrom).toBe('HR');

    await expect(requests.approve(asOfficer(), request.id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('and a refused approval writes nothing and moves nothing', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.approve(asAColleague(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      status: 'SUBMITTED',
      awaitingApprovalFrom: 'MANAGER',
    });
    expect(
      (await admin.query("SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'DEDUCTION'"))
        .rows[0].count,
    ).toBe('0');
  });

  /* --------------------------------------- what approval does to the rest */

  /**
   * Approved leave still blocks the calendar, which is the one word LMS 304 wrote its
   * predicate in advance for.
   *
   * `leave_request_never_overlaps` carried `WHERE status IN ('SUBMITTED')` while that was a
   * tautology, saying "the approval story edits this list". Leave that has been agreed is
   * the most live leave there is — the person will be away — and booking over it would take
   * the same days off a balance twice.
   */
  it('and leave that has been approved still blocks the same days', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await requests.approve(asOfficer(), request.id);

    await expect(requests.submit(asThemselves(), aRequest())).rejects.toBeInstanceOf(
      LeaveOverlapsAnother,
    );
  });

  /* And it cannot be withdrawn, refused or cancelled — not yet, and the refusal says which
     rather than pretending the days are back. Taking agreed leave off the books is a
     movement against the DEDUCTION and is a story of its own. */
  it('and cannot be withdrawn, refused or cancelled once it is approved', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await requests.approve(asOfficer(), request.id);

    for (const end of RELEASING_STATUSES) {
      await expect(ending(end)(whoEnds(end), request.id)).rejects.toMatchObject({
        name: 'LeaveCannotBeMoved',
        code: 'MOVE_NOT_AVAILABLE',
      });
    }

    const balance = await balances.forOne(asThemselves(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
    });

    expect(balance.taken).toBe(6);
    expect(balance.available).toBe(14);
  });

  /* And a request that has ended is not approved afterwards either, which is the other half
     of the same rule and the one somebody meets by having two tabs open. */
  it('and a request that has ended cannot then be approved', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), request.id);

    await expect(requests.approve(asTheirManager(), request.id)).rejects.toBeInstanceOf(
      LeaveAlreadySettled,
    );
  });

  /**
   * And a chain changed under a waiting request is refused by name. FR 31, FR 38a.
   *
   * The seam in reading the chain live rather than copying it onto the request, and the
   * reason `ApprovalChainChanged` exists. An HR Administrator may change a chain without a
   * developer — FR 31 insists on it — and a request already standing on a desk the new chain
   * does not have has no honest next stage. Approving it would agree the leave on the
   * strength of a desk the policy no longer includes.
   */
  it('and refuses a request left standing on a desk the chain no longer has', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await rewriteTheAnnualChain('HR');

    await expect(requests.approve(asTheirManager(), request.id)).rejects.toMatchObject({
      name: 'ApprovalChainChanged',
      code: 'CHAIN_CHANGED',
    });

    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      status: 'SUBMITTED',
      awaitingApprovalFrom: 'MANAGER',
    });
  });

  /* ------------------------------------ and what the database holds anyway */

  /**
   * The status and the DEDUCTION are one act, held at COMMIT.
   *
   * The mirror of `leave_request_gives_its_days_back`, and what it catches is the second
   * writer: a data fix marking a batch APPROVED, an import setting a status while correcting
   * something else. Each looks reasonable and each would leave leave that is agreed still
   * counted as pending in somebody's balance for ever.
   */
  it('and a status moved to approved with no DEDUCTION is refused at commit, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    /* The manager's stage goes through the door, so the request is genuinely sitting with
       HR when the second writer reaches it, and the writer records HR's approval as well.

       Both are needed and neither is decoration. The same careless UPDATE now breaks three
       rules at once — a request approved with no DEDUCTION, one approved with nothing to say
       who approved it (LMS 315), and one approved with a stage unasked (LMS 316) — and only
       one of them can be the message. The other two sort ahead of this one among the deferred
       constraints, which is correct and is not what this test is about. */
    await requests.approve(asTheirManager(), request.id);

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of)
       VALUES ($1, 'APPROVE', 'HR')`,
      [request.id],
    );
    await admin.query(
      `UPDATE leave_request SET status = 'APPROVED', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_takes_its_days',
    });
  });

  /* And a second DEDUCTION against one request, which is what a retry would write. The
     mirror of `leave_request_reserves_once` and `leave_request_releases_once`. */
  it('and one request takes its days exactly once, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await requests.approve(asOfficer(), request.id);

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry (
            employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
         VALUES ($1, $2, $3, 'DEDUCTION', '-6.00', 'taken twice', $4)`,
        [people.officer, annualId, y2026.id, request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_commits_once' });
  });

  /**
   * And a request is waiting on exactly one desk while it is being decided, and on none
   * otherwise.
   *
   * The equivalence, from both sides. The half nobody would write is the second: an approved
   * request that still read "awaiting HR" would sit in that desk's queue for ever, and
   * whoever worked through the queue would have no way to tell it from work.
   */
  it('and a request waits at exactly one desk while it is being decided, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(
      admin.query('UPDATE leave_request SET awaiting_approval_from = NULL WHERE id = $1', [
        request.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_request_waits_at_a_desk' });

    await requests.approve(asTheirManager(), request.id);
    await requests.approve(asOfficer(), request.id);

    await expect(
      admin.query("UPDATE leave_request SET awaiting_approval_from = 'HR' WHERE id = $1", [
        request.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_request_waits_at_a_desk' });
  });

  /* And the desk is one of the three FR 38a names, held closed the way the leave type's own
     column is. The two lists are the same list. */
  it('and only the three approver desks can be stored, by anybody', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(
      admin.query("UPDATE leave_request SET awaiting_approval_from = 'DIRECTOR' WHERE id = $1", [
        request.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_request_awaiting_role_known' });
  });

  /**
   * And the overlap constraint's predicate is exactly `LIVE_STATUSES`.
   *
   * The check LMS 304 wrote for the afternoon this story added a status to one list and not
   * the other. It failed nothing while `APPROVED` was absent from both; the moment it went
   * into the domain list and not into the predicate, somebody could have booked a fortnight
   * on top of leave their manager and HR had signed off.
   */
  it('and the exclusion constraint blocks exactly the statuses that hold days', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'leave_request'::regclass AND conname = 'leave_request_never_overlaps'`,
    );

    expect(rows).toHaveLength(1);
    expect(
      [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort(),
    ).toEqual([...LIVE_STATUSES].sort());
  });

  /* And every approval is on the record with the person who made it, exactly as every
     settlement is. The advance is an UPDATE like any other, so the trigger writes it. */
  it('and each stage is in the audit log with the person who approved it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await requests.approve(asOfficer(), request.id);

    const { rows } = await admin.query<{
      actor: string;
      before: { status: string; awaiting_approval_from: string | null };
      after: { status: string; awaiting_approval_from: string | null };
    }>(
      `SELECT actor, before, after FROM audit_log
        WHERE entity = 'leave_request' AND entity_id = $1 AND action = 'UPDATE'
        ORDER BY id`,
      [request.id],
    );

    expect(rows).toHaveLength(2);

    expect(rows[0].actor).toContain(people.teamLead);
    expect(rows[0].before.awaiting_approval_from).toBe('MANAGER');
    expect(rows[0].after.awaiting_approval_from).toBe('HR');
    expect(rows[0].after.status).toBe('SUBMITTED');

    expect(rows[1].actor).toContain(people.hrOfficer);
    expect(rows[1].after.status).toBe('APPROVED');
    expect(rows[1].after.awaiting_approval_from).toBeNull();
  });

  /**
   * Puts a different chain on annual leave, the way an HR Administrator would. FR 31.
   *
   * Two statements rather than one, because a chain is replaced as a whole and the
   * leave-type-approval-chain migration is explicit about why: "Moving 'manager then HR' to
   * 'HR then CEO' by updating rows in place passes through 'HR then HR' or 'manager then
   * CEO' depending on which row is written first, and both of those are real chains that a
   * concurrent reader would find."
   *
   * They land inside one transaction so `leave_type_approval_chain_is_whole`, which is
   * deferred, sees only the state that will be stored. The outer `beforeEach` puts the
   * shipped chains back afterwards.
   */
  async function rewriteTheAnnualChain(...desks: readonly string[]): Promise<void> {
    await admin.query('BEGIN');
    await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);

    for (const [index, desk] of desks.entries()) {
      await admin.query(
        `INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
         VALUES ($1, $2, $3)`,
        [annualId, index + 1, desk],
      );
    }

    await admin.query('COMMIT');
  }

  /** The three endings, and the desk each is reached from. */
  function ending(status: (typeof RELEASING_STATUSES)[number]) {
    switch (status) {
      case 'WITHDRAWN':
        return (actor: Actor, id: string) => requests.withdraw(actor, id);
      /* FR 39, LMS 315. Refusing says why, so the helper supplies the sentence a manager
         would have typed. The other two are not decisions at a desk and take none, which
         is why this cannot go on being three bound methods with one shape. */
      case 'REFUSED':
        return (actor: Actor, id: string) => requests.refuse(actor, id, WHY_NOT);
      default:
        return (actor: Actor, id: string) => requests.cancel(actor, id);
    }
  }

  function whoEnds(status: (typeof RELEASING_STATUSES)[number]) {
    switch (status) {
      case 'WITHDRAWN':
        return asThemselves();
      case 'REFUSED':
        return asTheirManager();
      default:
        return asOfficer();
    }
  }
});

/* --------------------------------------------------------------- who may ask */

describe('who may ask for leave, and who may see it', () => {
  it('is the person taking it', async () => {
    await expect(requests.submit(asThemselves(), aRequest())).resolves.toMatchObject({
      balance: { pending: 6 },
    });
  });

  /* FR 18. Somebody who was away and could not ask is entered by HR afterwards. */
  it('and HR on their behalf', async () => {
    await expect(requests.submit(asOfficer(), aRequest())).resolves.toMatchObject({
      request: { employeeId: people.officer },
    });
  });

  /**
   * And not their line manager, which is the one place their standing does not carry.
   *
   * A manager who could ask for leave on somebody's behalf could reduce what that
   * person may book without ever approving anything. They may read it; approving it is
   * the next story's.
   */
  it('and never their line manager, nor a colleague', async () => {
    for (const who of [asTheirManager(), asAColleague()]) {
      await expect(requests.submit(who, aRequest())).rejects.toBeInstanceOf(NotAuthorised);
    }
  });

  it('and a refused submission wrote nothing to be refused about', async () => {
    await expect(requests.submit(asAColleague(), aRequest())).rejects.toBeInstanceOf(NotAuthorised);

    expect((await admin.query('SELECT count(*) FROM leave_request')).rows[0].count).toBe('0');
  });

  /* Reading follows the balance: a request is why a figure is what it is, and standing
     to see one without the other would be standing to see half an explanation. */
  it('and is read by whoever may read the balance it moves', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    for (const who of [asThemselves(), asTheirManager(), asOfficer()]) {
      await expect(requests.byId(who, request.id)).resolves.toMatchObject({ id: request.id });
    }

    await expect(requests.byId(asAColleague(), request.id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('and a colleague is told nothing that says whether the request exists', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(requests.byId(asAColleague(), request.id)).rejects.toBeInstanceOf(NotAuthorised);
    await expect(requests.byId(asAColleague(), '987654321')).rejects.toBeInstanceOf(
      LeaveRequestNotFound,
    );
  });
});

/* ----------------------------------------------------------------- the reading */

describe("one person's leave", () => {
  it('comes back with the leave that starts first at the top', async () => {
    await requests.submit(asThemselves(), aRequest({ from: '2026-05-04', to: '2026-05-06' }));
    await requests.submit(asThemselves(), aRequest());

    const found = await requests.forEmployee(asThemselves(), people.officer);

    expect(found.map((request) => request.from)).toEqual([FROM, '2026-05-04']);
  });

  it('and narrows to one kind of leave, one year, or a period', async () => {
    await requests.submit(asThemselves(), aRequest());
    await requests.submit(asThemselves(), aRequest({ from: '2026-05-04', to: '2026-05-06' }));

    expect(
      await requests.forEmployee(asThemselves(), people.officer, { leaveTypeId: annualId }),
    ).toHaveLength(2);
    expect(
      await requests.forEmployee(asThemselves(), people.officer, { leaveYearId: y2026.id }),
    ).toHaveLength(2);

    /* Overlap, not containment: a window inside a request finds it. */
    expect(
      await requests.forEmployee(asThemselves(), people.officer, {
        from: '2026-03-05',
        to: '2026-03-06',
      }),
    ).toHaveLength(1);
  });

  it('and is empty for somebody who has asked for nothing', async () => {
    expect(await requests.forEmployee(asOfficer(), people.teamLead)).toEqual([]);
  });
});

/* --------------------------------------- what the approver said, and who said it */

/**
 * Approving or rejecting at a stage, with a comment. FR 39, FR 52. LMS 315.
 *
 * ../unit/leave-decision.test.ts proves the two rules about the comment — a refusal must
 * carry one, an approval need not — and it can prove nothing else, because the rest of the
 * story is written by the database. What needs a server is all three criteria met at once:
 *
 *   **The decision and the move are one act.** A refusal that committed with its reason
 *   lost, or a reason that committed against a request that was never refused, are the two
 *   halves of the same failure. `leave_request_records_its_decision` judges the pair at
 *   COMMIT, and only a real transaction can show it.
 *
 *   **Who, when and on whose behalf are the database's.** All three are stamped from the
 *   setting the repositories put on the transaction, so no writer can record a decision
 *   under somebody else's name or date one before the request it decides. The half that
 *   matters is that it holds against the owner connection too.
 *
 *   **And nothing rewrites one afterwards.** A refusal whose comment can be edited says
 *   whatever the last person to look at it wanted it to say, and the person it was written
 *   for has no way of knowing.
 */
describe('the decision at a stage', () => {
  /* ---------------------------------------------------- refusing, and saying why */

  /**
   * The story in one assertion: the reason the person was given is on the record, with the
   * name of whoever gave it and the stage it was given at.
   */
  it('is recorded with the reason, the desk it was decided at, and who decided it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const refused = await requests.refuse(asTheirManager(), request.id, WHY_NOT);

    expect(refused.request.status).toBe('REFUSED');
    expect(refused.decision).toMatchObject({
      leaveRequestId: request.id,
      action: 'REFUSE',
      onBehalfOf: 'MANAGER',
      comment: WHY_NOT,
      decidedByEmployeeId: people.teamLead,
    });
    expect(refused.decision?.decidedBy).toContain(people.teamLead);
    expect(refused.decision?.decidedAt).toBeInstanceOf(Date);
  });

  /**
   * And a refusal with nothing said is refused before anything at all happens.
   *
   * The story's first criterion, at the altitude a person meets it. The request is still
   * waiting on its manager afterwards, its days are still held, and nothing was written —
   * which is what makes this a refusal rather than a half-finished rejection.
   */
  it('and leave is not turned down without one', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    for (const nothing of ['', '   ']) {
      await expect(requests.refuse(asTheirManager(), request.id, nothing)).rejects.toMatchObject({
        name: 'RefusalNeedsAComment',
        code: 'REFUSAL_NEEDS_A_COMMENT',
        field: 'comment',
      });
    }

    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      status: 'SUBMITTED',
      awaitingApprovalFrom: 'MANAGER',
    });

    expect(
      (await admin.query("SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RELEASE'"))
        .rows[0].count,
    ).toBe('0');
    expect((await admin.query('SELECT count(*) FROM leave_request_decision')).rows[0].count).toBe(
      '0',
    );
  });

  /* ------------------------------------------------- approving, with or without one */

  /**
   * And every approval records one, including the ones that move no days at all.
   *
   * The asymmetry `LeaveApproved` is shaped around, and the reason this table exists rather
   * than three columns: a manager approving stage one writes no ledger entry, because
   * nothing about the balance changed, and it is exactly then that "somebody at a desk said
   * yes" is a fact nothing else in the schema can carry.
   */
  it('is recorded at each stage of the chain, whether or not any days moved', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const advanced = await requests.approve(asTheirManager(), request.id, 'Cover is arranged');
    const approved = await requests.approve(asOfficer(), request.id);

    expect(advanced.entry).toBeNull();
    expect(advanced.decision).toMatchObject({
      action: 'APPROVE',
      onBehalfOf: 'MANAGER',
      comment: 'Cover is arranged',
      decidedByEmployeeId: people.teamLead,
    });

    expect(approved.entry).not.toBeNull();
    expect(approved.decision).toMatchObject({
      action: 'APPROVE',
      onBehalfOf: 'HR',
      comment: null,
      decidedByEmployeeId: people.hrOfficer,
    });
  });

  /* The story's second criterion. An approval says nothing unless the approver wanted to,
     and two spaces are nothing rather than a comment nobody can read. */
  it('and an approval says nothing unless the approver had something to add', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const advanced = await requests.approve(asTheirManager(), request.id, '   ');

    expect(advanced.decision.comment).toBeNull();
  });

  /* ------------------------------------------------------ on whose behalf. FR 52 */

  /**
   * And the desk is recorded apart from the person, because they are not always the same.
   *
   * The one column here worth arguing about. An approval can only come from the person the
   * desk resolves to, so the two agree. A refusal need not: `TRANSITIONS` admits HR to the
   * REFUSE row whichever desk the request is sitting at, and LMS 314 deliberately left it
   * that way.
   *
   * So an HR Officer turning down leave that is still with the line manager is recorded as
   * their act, at the manager's stage — a sentence a manager can read and recognise as a
   * decision that was not theirs. Folding the two into one field would make that
   * unanswerable in exactly the case somebody asks.
   */
  it('names the stage it was decided at, even where that is not the decider’s own desk', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const refused = await requests.refuse(asOfficer(), request.id, WHY_NOT);

    expect(refused.decision).toMatchObject({
      onBehalfOf: 'MANAGER',
      decidedByEmployeeId: people.hrOfficer,
    });
  });

  /* And the endings that are not decisions record none. Withdrawing is somebody taking
     their own request back and cancelling is HR unwinding a row that should not be on the
     books; a comment against either would show the requester a reason for something nobody
     decided. */
  it('and a withdrawal or a cancellation is not a decision, and records none', async () => {
    const withdrawn = await requests.submit(asThemselves(), aRequest());
    await requests.withdraw(asThemselves(), withdrawn.request.id);

    const cancelled = await requests.submit(
      asThemselves(),
      aRequest({ from: '2026-05-04', to: '2026-05-06' }),
    );
    await requests.cancel(asOfficer(), cancelled.request.id);

    expect(await requests.decisionsFor(asThemselves(), withdrawn.request.id)).toEqual([]);
    expect(await requests.decisionsFor(asThemselves(), cancelled.request.id)).toEqual([]);
  });

  /* ------------------------------------------------------------- reading them back */

  /**
   * And the person whose leave it is can read what was said about it.
   *
   * The half that makes the writing worth anything: a refusal recorded and never shown is
   * the corridor conversation with a database behind it. Decided by the same rule that
   * decides who may see the request, because a decision is the explanation of a status and
   * standing to see one without the other is standing to see half an answer.
   */
  it('is read by the person who asked, their manager and HR, and by nobody else', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.approve(asTheirManager(), request.id, 'Cover is arranged');
    await requests.approve(asOfficer(), request.id);

    for (const who of [asThemselves(), asTheirManager(), asOfficer()]) {
      const decisions = await requests.decisionsFor(who, request.id);

      /* Oldest first, so a request that went to a manager and then to HR reads as the
         account of how it got where it is. */
      expect(decisions.map((decision) => decision.onBehalfOf)).toEqual(['MANAGER', 'HR']);
      expect(decisions[0].comment).toBe('Cover is arranged');
    }

    await expect(requests.decisionsFor(asAColleague(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  /* ------------------------------------------- what holds where no service reaches */

  /**
   * The pair is one act, and the deferred trigger is what says so at COMMIT.
   *
   * Asserted against the intermediate move, which is the one nothing else in the schema
   * guards: a request advancing a stage changes no status, writes no ledger entry, and would
   * otherwise be free to happen with nothing recorded. The owner connection is the writer
   * that could — a data fix, an import — and it is refused.
   */
  it('cannot be skipped by a writer that moves a request at a desk', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query("UPDATE leave_request SET awaiting_approval_from = 'HR' WHERE id = $1", [
      request.id,
    ]);

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_records_its_decision',
    });

    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      awaitingApprovalFrom: 'MANAGER',
    });
  });

  /* And a decision filed against the wrong stage does not satisfy it either, which is what
     makes `on_behalf_of` a fact rather than a label. */
  it('and a decision recorded at another desk does not explain the move', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of)
       VALUES ($1, 'APPROVE', 'CEO')`,
      [request.id],
    );
    await admin.query("UPDATE leave_request SET awaiting_approval_from = 'HR' WHERE id = $1", [
      request.id,
    ]);

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_records_its_decision',
    });
  });

  /* And the CHECK carries the story's first criterion where no sentence can reach. */
  it('and no refusal is stored without a reason, on any connection', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await expect(
      admin.query(
        `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of)
         VALUES ($1, 'REFUSE', 'MANAGER')`,
        [request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_refusal_says_why' });

    await expect(
      admin.query(
        `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of, comment)
         VALUES ($1, 'REFUSE', 'MANAGER', '   ')`,
        [request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_decision_comment_not_blank' });
  });

  /**
   * And the writer cannot name themselves, nor date what they wrote. FR 52.
   *
   * The same rule `leave_ledger_entry` holds its own three columns to, and the reason is
   * the same: a fact the writer has an interest in is not a fact the writer supplies. The
   * owner connection tries both and the trigger overwrites both.
   */
  it('and records who and when for itself, whatever the writer says', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const { rows } = await admin.query<{
      decided_by: string;
      decided_by_employee_id: string | null;
      decided_at: Date;
    }>(
      `INSERT INTO leave_request_decision
         (leave_request_id, action, on_behalf_of, decided_by, decided_by_employee_id, decided_at)
       VALUES ($1, 'APPROVE', 'MANAGER', 'somebody else entirely', $2, TIMESTAMPTZ '2020-01-01')
       RETURNING decided_by, decided_by_employee_id, decided_at`,
      [request.id, people.engineer],
    );

    expect(rows[0].decided_by).toBe(UNATTRIBUTED);
    expect(rows[0].decided_by_employee_id).toBeNull();
    expect(rows[0].decided_at.getFullYear()).toBeGreaterThan(2020);
  });

  /* And nothing rewrites or removes one, the owner included. An approver who put it badly
     decides again; the history is the answer. */
  it('and is never changed and never removed', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    const refused = await requests.refuse(asTheirManager(), request.id, WHY_NOT);

    /* Asserted on what the refusal says rather than on a constraint name, because
       `refuse_update()` and `refuse_delete()` are shared functions that raise with a
       message and a hint and name no constraint — the same way ./ledger.test.ts reads
       them. What is being checked is that the trigger is attached at all. */
    await expect(
      admin.query('UPDATE leave_request_decision SET comment = $1 WHERE id = $2', [
        'Actually, fine',
        refused.decision?.id,
      ]),
    ).rejects.toThrow(/never changed once written/);

    await expect(
      admin.query('DELETE FROM leave_request_decision WHERE id = $1', [refused.decision?.id]),
    ).rejects.toThrow(/never deleted/);
  });

  /* ------------------------------------------------- the lists, held in two places */

  /**
   * The verbs the schema admits are the verbs the domain knows.
   *
   * The same pairing `leave_request_status_known` has with `REQUEST_STATUSES`, and it
   * matters here for the reason it matters there: FR 26's cancelling of leave already agreed
   * is the next verb to arrive, and it is not a decision at a desk. Whichever side somebody
   * adds it to, this fails.
   */
  it('admits exactly the two verbs the code calls a decision', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'leave_request_decision'::regclass
          AND conname = 'leave_request_decision_action_known'`,
    );

    expect(rows).toHaveLength(1);
    expect(
      [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort(),
    ).toEqual([...DECIDING_ACTIONS].sort());
  });

  /* And the desks, which are the three of FR 38a and no others. A fourth is a migration and
     a change to whatever resolves a desk to a person, both of which this would fail. */
  it('and exactly the three desks a chain can name', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'leave_request_decision'::regclass
          AND conname = 'leave_request_decision_desk_known'`,
    );

    expect(rows).toHaveLength(1);
    expect(
      [...rows[0].definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort(),
    ).toEqual([...APPROVER_ROLES].sort());
  });

  /**
   * And the table is deliberately not audited.
   *
   * The declining the ledger made for the same reason: a row that can never change is
   * already its own history, and it carries its writer and its instant in its own columns.
   * An audit entry would be a second copy of a row nothing can move.
   *
   * Asserted against the catalogue rather than the migration text, because the failure this
   * guards is somebody adding the trigger later for symmetry — at which point
   * `AUDITED_ENTITIES` and the triggers disagree, and ./audit.test.ts starts failing about a
   * table nobody meant to add.
   */
  it('and is its own history rather than a second row in the audit log', async () => {
    const { rows } = await admin.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'leave_request_decision'::regclass
          AND NOT tgisinternal
          AND tgfoid = 'record_in_audit_log'::regproc`,
    );

    expect(rows).toEqual([]);
    expect(AUDITED_ENTITIES).not.toContain('leave_request_decision');
  });
});

/* ---------------------------------------------- every stage must approve, FR 41 */

/**
 * Leave is approved when every stage has approved it. FR 41, FR 42. LMS 316.
 *
 * ../unit/state-machine.test.ts proves the walk asks the right desk, against chains written
 * out as lists. What needs a server is the thing the story is actually about: the chain
 * changing underneath a request that is already in somebody's queue, which is a thing an HR
 * Administrator does with a form and no developer — FR 31 — and which no pure function can
 * be shown doing.
 *
 * And the half a service cannot promise at all: that a request marked approved with a stage
 * unasked is refused by the database, whatever wrote it.
 */
describe('leave that is agreed only once every stage has agreed', () => {
  /**
   * The story in one test: a stage added in front of a request in flight is still asked.
   *
   * The manager has signed and the request is with HR. The chain becomes CEO, manager, HR.
   * Under LMS 314's walk the desk after HR was nothing, so HR's approval would have agreed
   * the leave outright, with the Chief Executive — the stage the policy now names — never
   * seeing it, and the employee told it was theirs to take.
   */
  it('asks a stage added in front of where the request had got to', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await rewriteTheAnnualChain('CEO', 'MANAGER', 'HR');

    const advanced = await requests.approve(asOfficer(), request.id);

    expect(advanced.request.status).toBe('SUBMITTED');
    expect(advanced.request.awaitingApprovalFrom).toBe('CEO');
    /* And no days were taken, because nothing was agreed. */
    expect(advanced.entry).toBeNull();
    expect(advanced.balance.pending).toBe(6);
    expect(advanced.balance.taken).toBe(0);
  });

  /* And it is agreed once that stage signs too, which is the criterion said forwards. */
  it('and agrees it once that stage has approved as well', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await rewriteTheAnnualChain('CEO', 'MANAGER', 'HR');
    await requests.approve(asOfficer(), request.id);

    const approved = await requests.approve(asTheChiefExecutive(), request.id);

    expect(approved.request.status).toBe('APPROVED');
    expect(approved.request.awaitingApprovalFrom).toBeNull();
    expect(approved.balance.taken).toBe(6);
    expect(approved.balance.pending).toBe(0);
  });

  /* And a desk that has signed is never asked twice, whatever the chain is reordered to.
     LMS 315 wrote its deferred check around the possibility that it could be, and
     `leave_request_decision_once_per_desk` is what retires that. */
  it('and never asks a desk that has already approved', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await rewriteTheAnnualChain('HR', 'MANAGER');

    const advanced = await requests.approve(asOfficer(), request.id);

    /* Manager is first in the new chain and has signed, so the walk skips it and finds
       nobody left rather than sending the request back to a desk it came from. */
    expect(advanced.request.status).toBe('APPROVED');

    const desks = (await requests.decisionsFor(asThemselves(), request.id)).map(
      (decision) => decision.onBehalfOf,
    );
    expect(desks).toEqual(['MANAGER', 'HR']);
  });

  /* -------------------------------------------- what a person is told. FR 41 */

  /**
   * And the person is told it is not agreed, in a sentence that says so first.
   *
   * The story's "so that". A screen showing the newest decision would say "approved by your
   * line manager", which is true and is the exact belief this story is written against.
   */
  it('tells the person it is not theirs to take until every stage has agreed', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());
    await requests.approve(asTheirManager(), request.id);

    const waiting = await requests.progressFor(asThemselves(), request.id);

    expect(waiting.agreed).toBe(false);
    expect(waiting.approvedBy).toEqual(['MANAGER']);
    expect(waiting.stillToApprove).toEqual(['HR']);
    expect(waiting.inWords).toMatch(/not agreed yet/);

    await requests.approve(asOfficer(), request.id);

    const agreed = await requests.progressFor(asThemselves(), request.id);

    expect(agreed.agreed).toBe(true);
    expect(agreed.stillToApprove).toEqual([]);
    expect(agreed.inWords).toMatch(/agreed and is yours to take/);
  });

  /* Read by whoever may read the request, and by nobody else — a decision is the
     explanation of a status, and standing to see one without the other is standing to see
     half an answer. */
  it('and where it stands is read by the same people the request is', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    for (const who of [asThemselves(), asTheirManager(), asOfficer()]) {
      await expect(requests.progressFor(who, request.id)).resolves.toMatchObject({
        agreed: false,
      });
    }

    await expect(requests.progressFor(asAColleague(), request.id)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  /* -------------------------- a rejection at the last stage ends it. FR 42 */

  /**
   * The story's second criterion. Every earlier stage approved, the last one did not, and
   * the request is refused rather than partly agreed.
   *
   * The days come back in full and at once — they were still `pending`, because only the
   * last approval commits — and the manager's approval stays on the record as what it was:
   * a stage that agreed to leave the company did not, in the end, give.
   */
  it('ends the workflow when the last stage refuses, whatever the earlier ones said', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id, 'Cover is arranged');

    const refused = await requests.refuse(asOfficer(), request.id, WHY_NOT);

    expect(refused.request.status).toBe('REFUSED');
    expect(refused.request.awaitingApprovalFrom).toBeNull();
    expect(refused.balance.available).toBe(20);
    expect(refused.balance.pending).toBe(0);
    expect(refused.balance.taken).toBe(0);

    const progress = await requests.progressFor(asThemselves(), request.id);

    expect(progress.agreed).toBe(false);
    expect(progress.inWords).toMatch(/was refused and is not yours to take/);
  });

  /* And both decisions are on the record, in the order they were made. The approval that
     did not carry the day is not deleted by the refusal — it is what an appeal is worked
     from, and "my manager agreed to this" is a true thing to be able to show. */
  it('and keeps the approvals that came before it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id, 'Cover is arranged');
    await requests.refuse(asOfficer(), request.id, WHY_NOT);

    expect(
      (await requests.decisionsFor(asThemselves(), request.id)).map((decision) => [
        decision.onBehalfOf,
        decision.action,
      ]),
    ).toEqual([
      ['MANAGER', 'APPROVE'],
      ['HR', 'REFUSE'],
    ]);
  });

  /* And nothing took any days for it, at any point. A DEDUCTION is written by the last
     approval and by nothing else, so a request refused at the last stage never had one. */
  it('and no days were ever taken for it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await requests.refuse(asOfficer(), request.id, WHY_NOT);

    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'DEDUCTION' AND leave_request_id = $1",
          [request.id],
        )
      ).rows[0].count,
    ).toBe('0');
  });

  /* ------------------------------------- and what the database holds anyway */

  /**
   * A request marked approved with a stage unasked is refused at COMMIT, by anybody.
   *
   * The second writer this guards against is honest: a data fix approving a backlog, an
   * import that sets a status while correcting something else. Each looks reasonable, and
   * each would tell somebody their leave was agreed by a desk that never saw it.
   *
   * The writer here satisfies every rule that already existed — a decision at the desk it
   * was standing on, a DEDUCTION for the days — so what refuses it is the one this story
   * adds.
   */
  it('cannot be approved by a writer that skips a stage', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of)
       VALUES ($1, 'APPROVE', 'MANAGER')`,
      [request.id],
    );
    await admin.query(
      `UPDATE leave_request SET status = 'APPROVED', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       VALUES ($1, $2, $3, 'DEDUCTION', -6, 'Days taken', $4)`,
      [people.officer, annualId, y2026.id, request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_is_approved_by_every_stage',
    });

    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      status: 'SUBMITTED',
      awaitingApprovalFrom: 'MANAGER',
    });
  });

  /* And the refusal names the stage that never saw it, because the reader is whoever is
     holding the second writer and that is the whole of what they need to know. */
  it('and the refusal names the stage that was never asked', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of)
       VALUES ($1, 'APPROVE', 'MANAGER')`,
      [request.id],
    );
    await admin.query(
      `UPDATE leave_request SET status = 'APPROVED', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toThrow(/approved without HR/);
  });

  /**
   * And days can never be taken for leave that has ended. FR 42, where no service reaches.
   *
   * The story's second criterion said to the ledger. The request is over, its days are back
   * in the balance, and a second writer posting a DEDUCTION against it — a retry, an import,
   * a reconciliation that decided a request "looked approved" — would charge somebody for
   * leave they were turned down for. The balance would reconcile perfectly afterwards, which
   * is what makes it the kind of defect design principle 1 cannot catch on its own.
   */
  it('and days cannot be taken for a request that was refused', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);
    await requests.refuse(asOfficer(), request.id, WHY_NOT);

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
         VALUES ($1, $2, $3, 'DEDUCTION', -6, 'Days taken', $4)`,
        [people.officer, annualId, y2026.id, request.id],
      ),
    ).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_takes_no_days_for_ended_leave',
    });
  });

  /* And the same for the other two endings, which are one movement with three names — the
     list is `RELEASING_STATUSES` and the suite asserts the trigger holds the same three. */
  it.each([
    ['withdrawn', (id: string) => requests.withdraw(asThemselves(), id)],
    ['cancelled', (id: string) => requests.cancel(asOfficer(), id)],
  ] as const)('and not for one that was %s either', async (_ending, end) => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await end(request.id);

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
         VALUES ($1, $2, $3, 'DEDUCTION', -6, 'Days taken', $4)`,
        [people.officer, annualId, y2026.id, request.id],
      ),
    ).rejects.toMatchObject({
      constraint: 'leave_ledger_entry_takes_no_days_for_ended_leave',
    });
  });

  /**
   * And the three it names are the three the domain calls an ending.
   *
   * The pairing every list in this schema has with its counterpart in `/domain`. A status
   * added to `RELEASING_STATUSES` without being added here is leave that has ended and can
   * still be charged for.
   */
  it('and the endings it refuses are the ones the code calls an ending', async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `SELECT pg_get_functiondef(oid) AS definition
         FROM pg_proc
        WHERE proname = 'refuse_days_taken_for_leave_that_ended'`,
    );

    expect(rows).toHaveLength(1);

    for (const status of RELEASING_STATUSES) {
      expect(rows[0].definition).toContain(`'${status}'`);
    }
  });

  /**
   * And a request still being decided is deliberately not refused.
   *
   * The rule this story declined to make, named rather than left to be discovered. The
   * converse of `leave_request_takes_its_days` — days committed belong to leave that was
   * approved — is truer and stronger, and it refuses every use of `BalanceService.commit`,
   * the primitive LMS 314 kept on purpose beside the approval door. Taking a movement away
   * from the ledger is somebody's decision rather than a side effect of tightening the
   * workflow, so it stays permitted and this says so out loud.
   */
  it('but a request still being decided is not refused, which is a boundary rather than a gap', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);

    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
         VALUES ($1, $2, $3, 'DEDUCTION', -6, 'Days taken', $4)`,
        [people.officer, annualId, y2026.id, request.id],
      ),
    ).resolves.toBeDefined();
  });

  /* And one desk decides one request once, on every connection. The walk never asks twice
     since LMS 316; this is what keeps that from being a promise the application makes to
     itself. */
  it('and one desk decides one request exactly once', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);

    await expect(
      admin.query(
        `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of)
         VALUES ($1, 'APPROVE', 'MANAGER')`,
        [request.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_request_decision_once_per_desk' });
  });

  /**
   * Puts a different chain on annual leave, the way an HR Administrator would. FR 31.
   *
   * The same two statements the routing suite uses, and for the same reason: a chain is
   * replaced as a whole, and `leave_type_approval_chain_is_whole` is deferred so that only
   * the state which will be stored is judged. The outer `beforeEach` puts the shipped chains
   * back afterwards.
   */
  async function rewriteTheAnnualChain(...desks: readonly string[]): Promise<void> {
    await admin.query('BEGIN');
    await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);

    for (const [index, desk] of desks.entries()) {
      await admin.query(
        `INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
         VALUES ($1, $2, $3)`,
        [annualId, index + 1, desk],
      );
    }

    await admin.query('COMMIT');
  }

  /* Kwame Asante, the one employee with no line manager. FR 04. */
  function asTheChiefExecutive() {
    return signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true });
  }
});

/* ------------------------------------------ days come back on rejection, FR 43 */

/**
 * The days are back the moment a request is rejected, at whatever stage. FR 43. LMS 317.
 *
 * Most of this has held since LMS 306, which built the three endings as one movement and
 * writes the RELEASE and the status in one transaction. What this suite adds is the two
 * things that story could not say:
 *
 *   **At any stage.** LMS 306 refused requests that were still with their first approver,
 *   because that was the only place a request could be. A chain has stages now, and a
 *   rejection in the middle of one has to give back exactly as much as a rejection at the
 *   start — the days were never partly spent, because only the last approval commits.
 *
 *   **All of them.** `leave_request_gives_its_days_back` asked whether anything came back and
 *   not how much, and a release of one day out of six satisfied it while leaving five in
 *   `pending` that nothing would ever return. That is worse than releasing nothing, because
 *   nobody notices.
 *
 * And the story's "so that", which is the only assertion here that is about the employee
 * rather than about the ledger: the same dates can be asked for again straight away.
 */
describe('the days a rejected request was holding', () => {
  /* The first stage, which is where LMS 306 left it: the whole hold, at once, with the
     balance reading exactly what it did before the request was made. */
  it('come back in full when the first approver rejects it', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const refused = await requests.refuse(asTheirManager(), request.id, WHY_NOT);

    expect(refused.request.status).toBe('REFUSED');
    expect(refused.entry.days).toBe(6);
    expect(refused.balance.pending).toBe(0);
    expect(refused.balance.available).toBe(20);
  });

  /**
   * And in full when a middle stage rejects it, which is the case a chain of three makes
   * possible for the first time.
   *
   * Two desks have approved. Nothing has been taken — a `DEDUCTION` is written by the last
   * approval and by nothing else — so what comes back is the same six days, and the earlier
   * approvals cost the employee nothing.
   */
  it('and in full when a stage in the middle of the chain rejects it', async () => {
    await rewriteTheAnnualChain('MANAGER', 'HR', 'CEO');

    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), request.id);

    const waiting = await requests.byId(asThemselves(), request.id);
    expect(waiting.awaitingApprovalFrom).toBe('HR');

    const refused = await requests.refuse(asOfficer(), request.id, WHY_NOT);

    expect(refused.request.status).toBe('REFUSED');
    expect(refused.entry.days).toBe(6);
    expect(refused.balance.pending).toBe(0);
    expect(refused.balance.available).toBe(20);
    expect(refused.balance.taken).toBe(0);
  });

  /* And the RELEASE says which of the three endings it was, because five days coming back
     look identical whether the person changed their mind or a manager turned them down. */
  it('and the movement says the request was refused', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    const refused = await requests.refuse(asTheirManager(), request.id, WHY_NOT);

    expect(refused.entry.entryType).toBe('RELEASE');
    expect(refused.entry.reason).toContain('6 days of Annual Leave given back');
    expect(refused.entry.reason).toContain('the request was refused');
  });

  /**
   * And nobody has to do anything for it. The story's "so that", end to end.
   *
   * The same fortnight, refused, and asked for again in the next breath — which needs two
   * separate things to have happened at the moment of the rejection and not later. The days
   * have to be back in the balance, or the second request is refused with `NotEnoughDays`;
   * and the first request has to have stopped blocking the calendar, or it is refused with
   * `LeaveOverlapsAnother`. Neither waits on HR, a job, or a nightly anything.
   */
  it('and the same dates can be asked for again at once, with nobody releasing anything', async () => {
    const first = await requests.submit(asThemselves(), aRequest());

    await requests.approve(asTheirManager(), first.request.id);
    await requests.refuse(asOfficer(), first.request.id, WHY_NOT);

    const again = await requests.submit(asThemselves(), aRequest());

    expect(again.request.status).toBe('SUBMITTED');
    expect(again.request.awaitingApprovalFrom).toBe('MANAGER');
    expect(again.balance.pending).toBe(6);
    expect(again.balance.available).toBe(14);
  });

  /* And the days went back exactly once on the way. A second RELEASE against one request is
     refused by the index, and the balance is what it would have been had neither request
     ever existed but the second. */
  it('and the days were given back exactly once', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await requests.refuse(asTheirManager(), request.id, WHY_NOT);
    await requests.refuse(asTheirManager(), request.id, WHY_NOT).catch(() => undefined);

    expect(
      (
        await admin.query(
          "SELECT count(*) FROM leave_ledger_entry WHERE entry_type = 'RELEASE' AND leave_request_id = $1",
          [request.id],
        )
      ).rows[0].count,
    ).toBe('1');

    expect((await balances.forOne(asThemselves(), theBalance())).available).toBe(20);
  });

  /* ------------------------------------- and what the database holds anyway */

  /**
   * A request that ended having given back part of what it held is refused at COMMIT.
   *
   * The hole LMS 306 left, and the one this story is for. Its trigger asked whether a
   * RELEASE existed; one day out of six satisfied that and left five in `pending` that
   * nothing would ever return — a balance permanently short against a request that says it
   * ended, with a ledger that reconciles.
   *
   * The writer here is the one that story named: a data fix marking a request refused and
   * releasing a figure it worked out for itself.
   */
  it('cannot be released in part by a writer that works out its own figure', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of, comment)
       VALUES ($1, 'REFUSE', 'MANAGER', 'No cover that week')`,
      [request.id],
    );
    await admin.query(
      `UPDATE leave_request SET status = 'REFUSED', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       VALUES ($1, $2, $3, 'RELEASE', 1, 'Some of them back', $4)`,
      [people.officer, annualId, y2026.id, request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_gives_its_days_back',
    });

    expect(await requests.byId(asThemselves(), request.id)).toMatchObject({
      status: 'SUBMITTED',
    });
  });

  /* And the refusal names both figures, because the reader is holding a writer that reached
     its own number and has to see which one was wanted. */
  it('and the refusal names what was held and what came back', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of, comment)
       VALUES ($1, 'REFUSE', 'MANAGER', 'No cover that week')`,
      [request.id],
    );
    await admin.query(
      `UPDATE leave_request SET status = 'REFUSED', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       VALUES ($1, $2, $3, 'RELEASE', 1, 'Some of them back', $4)`,
      [people.officer, annualId, y2026.id, request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toThrow(/holding 6 day\(s\) and gave back 1/);
  });

  /* And releasing nothing is still refused, in the sentence LMS 306 wrote. Widening a rule
     is only safe if it goes on refusing what it refused before. */
  it('and a request that ended releasing nothing is refused as it always was', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `INSERT INTO leave_request_decision (leave_request_id, action, on_behalf_of, comment)
       VALUES ($1, 'REFUSE', 'MANAGER', 'No cover that week')`,
      [request.id],
    );
    await admin.query(
      `UPDATE leave_request SET status = 'REFUSED', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toThrow(/without giving its days back/);
  });

  /* And the rule is about what a request was holding rather than about which button was
     pressed, so a withdrawal that gave back part of it is refused too. */
  it('and a withdrawal that gives back part of the hold is refused the same way', async () => {
    const { request } = await requests.submit(asThemselves(), aRequest());

    await admin.query('BEGIN');
    await admin.query(
      `UPDATE leave_request SET status = 'WITHDRAWN', awaiting_approval_from = NULL
        WHERE id = $1`,
      [request.id],
    );
    await admin.query(
      `INSERT INTO leave_ledger_entry
         (employee_id, leave_type_id, leave_year_id, entry_type, days, reason, leave_request_id)
       VALUES ($1, $2, $3, 'RELEASE', 2, 'Some of them back', $4)`,
      [people.officer, annualId, y2026.id, request.id],
    );

    await expect(admin.query('COMMIT')).rejects.toMatchObject({
      constraint: 'leave_request_gives_its_days_back',
    });
  });

  /** The balance every test here moves: her annual leave, this year. */
  function theBalance() {
    return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id };
  }

  /** As an HR Administrator would, and restored by the outer `beforeEach`. FR 31. */
  async function rewriteTheAnnualChain(...desks: readonly string[]): Promise<void> {
    await admin.query('BEGIN');
    await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);

    for (const [index, desk] of desks.entries()) {
      await admin.query(
        `INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
         VALUES ($1, $2, $3)`,
        [annualId, index + 1, desk],
      );
    }

    await admin.query('COMMIT');
  }
});
