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
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import {
  HolidayAlreadyCredited,
  HolidayInASettledYear,
} from '../../src/features/holiday/holiday.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { HolidayService } from '../../src/features/holiday/holiday.service.js';
import type { HolidayRecalculationService } from '../../src/features/holiday/recalculation.service.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { earliestOpenDayFrom } from '../../src/features/leave-year/leave-year.service.js';
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
import { holidayRecalculationService } from '../support/holiday-recalculations.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * A public holiday declared inside leave people already had. FR 25, §8.8. LMS 508.
 *
 * ../unit/recalculation.test.ts proves what is pure: how much a late-declared day is worth
 * to one piece of agreed leave, and the sentences that go with it. What needs a server:
 *
 *   **The day actually comes back.** One `RECALCULATION` against the balance the leave was
 *   charged to, for the difference, and `available` moves by exactly that.
 *
 *   **Working day types only.** Leave counted in calendar days is over the same date and is
 *   charged exactly what it was, which is the story's second criterion and is an absence of
 *   a write rather than a branch.
 *
 *   **The button is safe to press twice.** The unique index is what makes that true, not
 *   the read in front of it.
 *
 *   **The request is untouched**, and everybody it credited is told.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('holiday recalculation integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let holidays: HolidayService;
let recalculations: HolidayRecalculationService;
let notices: NotificationRepository;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;
let compassionateId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const organisation = new OrganisationRepository(db);

  notices = new NotificationRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  holidays = new HolidayService(
    new HolidayRepository(db),
    guard,
    earliestOpenDayFrom(yearRepository),
    yearRepository,
  );

  recalculations = holidayRecalculationService(db, guard, balances);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    requestRepository,
    new LeaveDecisionRepository(db),
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    delegationService(db, guard),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(notices, recordingMailer(), guard),
  );
});

beforeEach(async () => {
  /* FR 18, LMS 308. Every fixture here is leave that has already been taken, which is
     further back than annual leave's seven day window. Widened rather than dated forward,
     as ./withdrawal.test.ts and ./sickness-reclassification.test.ts widen it. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await clear();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;
  compassionateId = (await admin.query("SELECT id FROM leave_type WHERE code = 'COMPASSIONATE'"))
    .rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [
    compassionateId,
  ]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await grant(annualId, 20);
  /** FR 23. Abena works Monday, Tuesday, Thursday and Friday. Both report to the team lead. */
  await grant(annualId, 20, people.partTimer);
  await grant(compassionateId, 20, people.partTimer);
});

afterAll(async () => {
  await clear();

  await db?.destroy();
  await admin?.end();
});

/**
 * The calendar goes with the rest of the fixtures.
 *
 * The gazette for 2026 is reference data written by a migration, and a fixture landing on
 * one of its days would be priced against a holiday this test did not declare. Truncated
 * with the credits, which reference it.
 */
async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_request_recalculation, holiday, ' +
      'leave_ledger_entry, attachment_access, attachment_download_link, ' +
      'leave_request_reclassification, leave_request_attachment, leave_request_decision, ' +
      'leave_request_reassignment, leave_request_routing, leave_request_withdrawal, ' +
      'leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

async function grant(
  leaveTypeId: string,
  days: number,
  employeeId: string = people.officer,
): Promise<void> {
  await balances.grantTheYear(system, {
    employeeId,
    leaveTypeId,
    leaveYearId: y2026.id,
    days,
    reason: 'Entitlement for 2026',
  });
}

/** The nth working day before today. A calendar offset lands fixtures on a Saturday. */
function workingDaysAgo(offset: number): string {
  const day = new Date();

  for (let counted = 0; counted < offset;) {
    day.setUTCDate(day.getUTCDate() - 1);

    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      counted += 1;
    }
  }

  return calendarDateIn(day, 'UTC');
}

/** Five working days, a fortnight back: leave that has been taken. */
function theFortnightTaken(): [string, string] {
  return [workingDaysAgo(14), workingDaysAgo(10)];
}

/** A working day in the middle of it, which is the day the gazette will name late. */
function theDayInTheMiddle(): string {
  return workingDaysAgo(12);
}

/**
 * The Wednesday inside the same week.
 *
 * The fixture the seed was written for: Abena works Monday, Tuesday, Thursday and Friday,
 * "and a Wednesday public holiday costs her nothing". A week is five working days, so there
 * is exactly one of them in it.
 */
function theWednesdayInIt(): string {
  const day = new Date(`${workingDaysAgo(14)}T00:00:00Z`);

  while (day.getUTCDay() !== 3) {
    day.setUTCDate(day.getUTCDate() + 1);
  }

  return calendarDateIn(day, 'UTC');
}

function asTheEmployee(employeeId: string = people.officer) {
  return signedInAs(employeeId, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAnHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/** One approved request, through the real doors, so its `DEDUCTION` actually moved. */
async function anApprovedRequest(
  from: string,
  to: string,
  options: { leaveTypeId?: string; employeeId?: string } = {},
): Promise<string> {
  const employeeId = options.employeeId ?? people.officer;

  const { request } = await requests.submit(asTheEmployee(employeeId), {
    employeeId,
    leaveTypeId: options.leaveTypeId ?? annualId,
    from,
    to,
    reason: 'A fortnight by the sea',
    acknowledgesShortNotice: true,
  });

  await requests.approve(asTheirManager(), request.id);
  await requests.approve(asAnHrOfficer(), request.id);

  return request.id;
}

/** A day the gazette declared this morning. */
async function declare(date: string, name = 'A Day of National Mourning'): Promise<string> {
  return (await holidays.add(asAnHrOfficer(), { name, date })).id;
}

function annualBalance(employeeId: string = people.officer) {
  return { employeeId, leaveTypeId: annualId, leaveYearId: y2026.id };
}

async function availableIn(key: ReturnType<typeof annualBalance>): Promise<number> {
  return (await balances.forOne(system, key)).available;
}

async function theRequest(id: string) {
  const { rows } = await admin.query<{
    status: string;
    start_date: string;
    end_date: string;
    days: number;
  }>('SELECT status, start_date, end_date, days FROM leave_request WHERE id = $1', [id]);

  return rows[0];
}

async function entriesFor(id: string) {
  const { rows } = await admin.query<{ entry_type: string; days: string; reason: string }>(
    'SELECT entry_type, days, reason FROM leave_ledger_entry WHERE leave_request_id = $1 ' +
      'ORDER BY id',
    [id],
  );

  return rows;
}

/* ------------------------------------- HR triggers it, FR 25's first criterion */

describe('a holiday gazetted after the leave was approved', () => {
  it('credits the day back to everybody who was charged for it', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;

    expect(await availableIn(annualBalance())).toBe(20 - cost);

    const run = await recalculations.recalculate(
      asAnHrOfficer(),
      await declare(theDayInTheMiddle()),
    );

    expect(run.days).toBe(1);
    expect(run.credited).toHaveLength(1);
    expect(run.failed).toEqual([]);
    expect(await availableIn(annualBalance())).toBe(20 - cost + 1);
  });

  /* FR 25's third criterion, and the entry type LMS 314 said this story would collect on.
     The reason names the gazetted day, because that is the question asked of this line. */
  it('and the credit is a RECALCULATION naming the day', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const day = theDayInTheMiddle();

    await recalculations.recalculate(asAnHrOfficer(), await declare(day, 'Independence Day'));

    const entries = await entriesFor(id);
    const credit = entries.find((entry) => entry.entry_type === 'RECALCULATION');

    expect(credit).toBeDefined();
    expect(Number(credit!.days)).toBe(1);
    expect(credit!.reason).toContain('Independence Day');
    expect(credit!.reason).toContain(day);
  });

  /* The leave still happened on the days it happened on. Nothing is added to the end of it
     and nothing about the record moves — only what it cost. */
  it('and the leave itself is exactly as it was booked', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const before = await theRequest(id);

    await recalculations.recalculate(asAnHrOfficer(), await declare(theDayInTheMiddle()));

    expect(await theRequest(id)).toEqual(before);
    expect(before.status).toBe('APPROVED');
  });

  /* FR 25's fourth criterion. */
  it('and the person is told, in a notice of its own', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());

    await recalculations.recalculate(
      asAnHrOfficer(),
      await declare(theDayInTheMiddle(), 'Independence Day'),
    );

    const told = await notices.forRequest(id);
    const credit = told.find((notice) => notice.event === 'LEAVE_RECALCULATED');

    expect(credit).toBeDefined();
    expect(credit!.employeeId).toBe(people.officer);
    expect(credit!.body).toContain('Independence Day');
    expect(credit!.body).toContain('back in your balance');
  });
});

/* ------------------------- working day types only, FR 25's second criterion */

describe('what it leaves alone', () => {
  it('does not touch leave counted in calendar days', async () => {
    await admin.query("UPDATE leave_type SET counting_basis = 'CALENDAR_DAYS' WHERE id = $1", [
      compassionateId,
    ]);

    const [from, to] = theFortnightTaken();
    const id = await anApprovedRequest(from, to, {
      leaveTypeId: compassionateId,
      employeeId: people.partTimer,
    });

    const cost = (await theRequest(id)).days;
    const run = await recalculations.recalculate(
      asAnHrOfficer(),
      await declare(theDayInTheMiddle()),
    );

    expect(run.credited).toEqual([]);
    expect(run.untouched.map((one) => one.because)).toContain('COUNTS_CALENDAR_DAYS');
    expect(await entriesFor(id)).not.toContainEqual(
      expect.objectContaining({ entry_type: 'RECALCULATION' }),
    );
    expect((await theRequest(id)).days).toBe(cost);
  });

  /* FR 23, §7.3. The pattern is asked before the calendar, so a Wednesday holiday costs
     somebody who does not work Wednesdays nothing, and gives them nothing back. The same
     day, the same week, two people, two answers. */
  it('and credits nothing to somebody who does not work that day', async () => {
    const [from, to] = theFortnightTaken();

    const hers = await anApprovedRequest(from, to);
    const theirs = await anApprovedRequest(from, to, { employeeId: people.partTimer });

    const full = (await theRequest(hers)).days;
    const part = (await theRequest(theirs)).days;

    const run = await recalculations.recalculate(
      asAnHrOfficer(),
      await declare(theWednesdayInIt()),
    );

    expect(run.credited.map((one) => one.employee.id)).toEqual([people.officer]);
    expect(run.untouched.map((one) => one.because)).toEqual(['NOT_A_DAY_THEY_WORK']);

    expect(await availableIn(annualBalance())).toBe(20 - full + 1);
    expect(await availableIn(annualBalance(people.partTimer))).toBe(20 - part);
  });

  it('and leaves alone leave the day falls outside', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;

    const run = await recalculations.recalculate(asAnHrOfficer(), await declare(workingDaysAgo(3)));

    expect(run.credited).toEqual([]);
    expect(run.untouched).toEqual([]);
    expect(await availableIn(annualBalance())).toBe(20 - cost);
    expect(await entriesFor(id)).not.toContainEqual(
      expect.objectContaining({ entry_type: 'RECALCULATION' }),
    );
  });
});

/* ------------------------------------------------- pressing the button twice */

describe('running it again', () => {
  it('credits nobody a second time, and says so', async () => {
    await anApprovedRequest(...theFortnightTaken());
    const holidayId = await declare(theDayInTheMiddle());

    const first = await recalculations.recalculate(asAnHrOfficer(), holidayId);
    const again = await recalculations.recalculate(asAnHrOfficer(), holidayId);

    expect(first.days).toBe(1);
    expect(again.days).toBe(0);
    expect(again.credited).toEqual([]);
    expect(again.untouched.map((one) => one.because)).toEqual(['ALREADY_CREDITED']);
  });

  it('and the balance is one day up, not two', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;
    const holidayId = await declare(theDayInTheMiddle());

    await recalculations.recalculate(asAnHrOfficer(), holidayId);
    await recalculations.recalculate(asAnHrOfficer(), holidayId);

    expect(await availableIn(annualBalance())).toBe(20 - cost + 1);
    expect(
      (await entriesFor(id)).filter((entry) => entry.entry_type === 'RECALCULATION'),
    ).toHaveLength(1);
  });
});

/* --------------------------------------------------- what HR sees before pressing */

describe('what it would do, before it does any of it', () => {
  it('says how many days and how many people, and moves nothing', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;

    const preview = await recalculations.whatWouldChange(
      asAnHrOfficer(),
      await declare(theDayInTheMiddle()),
    );

    expect(preview.days).toBe(1);
    expect(preview.people).toBe(1);
    expect(preview.affected).toHaveLength(1);
    expect(await availableIn(annualBalance())).toBe(20 - cost);
  });

  /* NFR USA 03. A screen never shows a bare token, so the sentence comes with the reason. */
  it('and says in words why it would leave something alone', async () => {
    await anApprovedRequest(...theFortnightTaken(), { employeeId: people.partTimer });

    const preview = await recalculations.whatWouldChange(
      asAnHrOfficer(),
      await declare(theWednesdayInIt()),
    );

    expect(preview.days).toBe(0);
    expect(preview.affected[0].because).toBe('NOT_A_DAY_THEY_WORK');
    expect(preview.affected[0].inWords).toContain('does not work');
  });
});

/* ----------------------------------------------------------------- who may run it */

describe('whose act it is', () => {
  it('is HR’s, and nobody else’s', async () => {
    await anApprovedRequest(...theFortnightTaken());
    const holidayId = await declare(theDayInTheMiddle());

    await expect(recalculations.recalculate(asTheEmployee(), holidayId)).rejects.toThrow(
      NotAuthorised,
    );
    await expect(recalculations.recalculate(asTheirManager(), holidayId)).rejects.toThrow(
      NotAuthorised,
    );
    await expect(recalculations.whatWouldChange(asTheEmployee(), holidayId)).rejects.toThrow(
      NotAuthorised,
    );
  });
});

/* --------------------------------------------------- a year that has been settled */

describe('a closed leave year', () => {
  /* §8.9, FR 22. Every request over a day in a closed year was counted against the calendar
     as it stood, and a closed year is never recalculated — which is the same sentence the
     calendar gives when a day is typed into one. */
  /**
   * The year is closed after the day was declared, which is the only way this happens.
   *
   * A holiday cannot be typed into a year that is already settled —
   * `holiday_leaves_settled_years_alone` refuses that on every connection. What is
   * reachable is Boxing Day declared in December, the year closing in January, and HR
   * running the recalculation a week too late.
   */
  it('is never recalculated, and the run says so before it moves anything', async () => {
    const id = await anApprovedRequest(...theFortnightTaken());
    const cost = (await theRequest(id)).days;

    await admin.query(
      'INSERT INTO leave_year (label, start_date, end_date) ' +
        "VALUES ('2025', '2025-01-01', '2025-12-31')",
    );

    const lastYear = await declare('2025-12-26', 'Boxing Day');

    await admin.query("UPDATE leave_year SET is_closed = TRUE WHERE label = '2025'");

    await expect(recalculations.recalculate(asAnHrOfficer(), lastYear)).rejects.toThrow(
      HolidayInASettledYear,
    );
    expect(await availableIn(annualBalance())).toBe(20 - cost);
  });
});

/* -------------------------------------------- and the day itself stops being editable */

describe('a day that has credited somebody', () => {
  it('cannot be cleared off the calendar or moved', async () => {
    await anApprovedRequest(...theFortnightTaken());
    const holidayId = await declare(theDayInTheMiddle());

    await recalculations.recalculate(asAnHrOfficer(), holidayId);

    await expect(holidays.remove(asAnHrOfficer(), holidayId)).rejects.toThrow(
      HolidayAlreadyCredited,
    );
    await expect(
      holidays.correct(asAnHrOfficer(), holidayId, { date: workingDaysAgo(11) }),
    ).rejects.toThrow(HolidayAlreadyCredited);
  });

  /* Renaming it is still HR's, because nothing was priced against the name. */
  it('and may still be renamed', async () => {
    await anApprovedRequest(...theFortnightTaken());
    const holidayId = await declare(theDayInTheMiddle());

    await recalculations.recalculate(asAnHrOfficer(), holidayId);

    expect((await holidays.correct(asAnHrOfficer(), holidayId, { name: 'Eid al-Fitr' })).name).toBe(
      'Eid al-Fitr',
    );
  });
});
