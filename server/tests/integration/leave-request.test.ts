import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceOverdrawn } from '../../src/domain/balance.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import { LeaveCountsNoDays, InvalidLeavePeriod } from '../../src/domain/leave-calculator.js';
import {
  InvalidLeaveRequest,
  LeaveCrossesAYearEnd,
  LeaveRequestNotFound,
  type NewLeaveRequest,
} from '../../src/domain/leave-request.js';
import { LeaveTypeRetired } from '../../src/domain/leave-type.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';
import { BalanceRepository } from '../../src/repositories/balance-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { HolidayRepository } from '../../src/repositories/holiday-repository.js';
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
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: LeaveYear;
let annualId: string;
let maternityId: string;

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

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  repository = new LeaveRequestRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    repository,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
  );

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request');
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

  const codes = await admin.query(
    "SELECT code, id FROM leave_type WHERE code IN ('ANNUAL','MATERNITY')",
  );
  const byCode = Object.fromEntries(codes.rows.map((row) => [row.code, row.id as string]));

  annualId = byCode.ANNUAL;
  maternityId = byCode.MATERNITY;

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
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request');
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
    ).rejects.toBeInstanceOf(BalanceOverdrawn);
  });

  /**
   * And a refused submission writes neither row.
   *
   * The pair is one act. A request holding nothing could be submitted three times
   * against a balance with five days in it; a reservation with no request behind it is
   * days missing that nobody can explain.
   */
  it('and a refused submission leaves no request and no entry behind', async () => {
    await expect(
      requests.submit(asThemselves(), aRequest({ from: '2026-05-04', to: '2026-06-30' })),
    ).rejects.toBeInstanceOf(BalanceOverdrawn);

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
            reason, counting_basis, days, calendar_days, status)
         VALUES ($1, $2, $3, $4, $5, 'straight to the table', 'WORKING_DAYS', 7, 9, 'SUBMITTED')`,
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

  /* And the database holds the same rule for every other writer, so the two cannot
     drift. */
  it('and the database refuses one filed under the wrong year, by anybody', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_request (
            employee_id, leave_type_id, leave_year_id, start_date, end_date,
            reason, counting_basis, days, calendar_days, status)
         VALUES ($1, $2, $3, '2025-03-02', '2025-03-10', 'the wrong year',
                 'WORKING_DAYS', 7, 9, 'SUBMITTED')`,
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
