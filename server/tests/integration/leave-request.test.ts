import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceOverdrawn } from '../../src/domain/balance.js';
import { EmployeeNotFound } from '../../src/domain/employee.js';
import { InvalidLeavePeriod } from '../../src/domain/leave-calculator.js';
import {
  InvalidLeaveRequest,
  LeaveCountsNoDays,
  LeaveCrossesAYearEnd,
  LeaveOverlapsAnother,
  LeaveRequestNotFound,
  LIVE_STATUSES,
  type NewLeaveRequest,
  NotEnoughDays,
  validateNewLeaveRequest,
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
    "SELECT code, id FROM leave_type WHERE code IN ('ANNUAL','MATERNITY','SICK')",
  );
  const byCode = Object.fromEntries(codes.rows.map((row) => [row.code, row.id as string]));

  annualId = byCode.ANNUAL;
  maternityId = byCode.MATERNITY;
  sickId = byCode.SICK;

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
            reason, counting_basis, days, calendar_days, status)
         VALUES ($1, $2, $3, '2026-03-09', '2026-03-13', 'straight past the service',
                 'WORKING_DAYS', 4, 5, 'SUBMITTED')`,
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
