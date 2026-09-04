import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { EmployeeNotFound } from '../../src/features/employee/employee.js';
import { AlreadyLapsed, EventAlreadyRecorded } from '../../src/features/leave-event/leave-event.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  EntitlementExpiry,
  daysLapsed,
} from '../../src/features/entitlement/entitlement-expiry.job.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { LeaveEventRepository } from '../../src/features/leave-event/leave-event.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { EntitlementRuleService } from '../../src/features/entitlement/entitlement-rule.service.js';
import {
  LeaveEventService,
  NoEntitlementForTheEvent,
  NotAnEventBasedType,
  NotEligibleForTheType,
} from '../../src/features/leave-event/leave-event.service.js';
import {
  earliestOpenDayFrom,
  LeaveYearService,
} from '../../src/features/leave-year/leave-year.service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Entitlement that arrives with an event, against a real database. FR 32g, FR 32e,
 * §8.6aa. LMS 218.
 *
 * ../unit/leave-event.test.ts proves the two rules that are arithmetic — when a grant
 * runs out, and what is left when it does. What needs a server is everything the story
 * is actually about:
 *
 *   **The grant is recorded against the event.** Two rows, one transaction, each
 *   naming the other. That the pair cannot come apart is a foreign key and a rollback,
 *   which is not a property any pure function has.
 *
 *   **A ninth kind of ledger entry exists and lands where it should.** `LAPSE` takes
 *   days out of `entitled`, where the `GRANT` put them — not out of `carriedOver`,
 *   which is FR 36a's clock. That is a CHECK constraint and a view, and the only place
 *   it can be asked whether it is right is against a migrated database.
 *
 *   **The expiry job can be run every night.** Idempotence here is the operating mode
 *   rather than a nicety, and it is a claim about a guarded update rather than about
 *   care.
 *
 * ## The fixture moves the clock rather than the calendar
 *
 * `EntitlementExpiry.run` takes the day to judge deadlines against, which is why this
 * suite can watch six months pass without waiting for them. That parameter exists for
 * the reason `assertMayBeClosed` takes today: nothing in `/domain` reads a clock, and
 * the service says which day the answer comes from.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, which is what a nightly run is. */
const nightly = theSystem('the entitlement expiry');
const system = theSystem('leave event integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let events: LeaveEventService;
let expiry: EntitlementExpiry;
let balances: BalanceService;
let eventRepository: LeaveEventRepository;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: LeaveYear;
let maternityId: string;
let paternityId: string;
let compassionateId: string;
let annualId: string;

/** A day in the seeded 2026 year, comfortably in the past. Today is 2026-08-31. */
const A_BIRTH = '2026-03-04';
/** Six months after it, which is when a paternity grant runs out. */
const SIX_MONTHS_ON = '2026-09-04';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);

  eventRepository = new LeaveEventRepository(db);
  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  const rules = new EntitlementRuleService(
    new EntitlementRuleRepository(db),
    guard,
    earliestOpenDayFrom(yearRepository),
  );

  events = new LeaveEventService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    eventRepository,
    async (employee, leaveTypeId, on) =>
      (await rules.entitlementOn(system, employee, leaveTypeId, on))?.entitlementDays,
  );

  expiry = new EntitlementExpiry(balances, eventRepository, types, yearRepository);

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;

  /* One test below changes this column to prove that a deadline already given does not
     move with it, and `leave_type` is not reset between tests in this file or between
     files at all — the seven types are the migration's and every suite reads them as
     given. Put back here rather than in that test, so a failure part way through it
     cannot leave paternity's six months at one. */
  await admin.query("UPDATE leave_type SET entitlement_expiry_months = 6 WHERE code = 'PATERNITY'");

  const codes = await admin.query(
    "SELECT code, id FROM leave_type WHERE code IN ('MATERNITY','PATERNITY','COMPASSIONATE','ANNUAL')",
  );
  const byCode = Object.fromEntries(codes.rows.map((row) => [row.code, row.id as string]));

  maternityId = byCode.MATERNITY;
  paternityId = byCode.PATERNITY;
  compassionateId = byCode.COMPASSIONATE;
  annualId = byCode.ANNUAL;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await admin.query("UPDATE leave_type SET entitlement_expiry_months = 6 WHERE code = 'PATERNITY'");
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

/** Adwoa is female, so maternity leave is open to her. FR 05. */
function aBirthFor(employeeId: string, leaveTypeId: string, occurredOn = A_BIRTH, note?: string) {
  return events.record(asOfficer(), { employeeId, leaveTypeId, occurredOn, note });
}

/**
 * Days taken, the way they are actually taken since LMS 301.
 *
 * A RESERVATION has to name a request and a request has to hold days, so "five days
 * gone" is no longer one call — it is a request that holds them and an approval that
 * turns the hold into days taken. The period runs from the first day of the leave year
 * so that any figure is a period the table accepts; what these tests are about is the
 * balance rather than the counting.
 */
async function takeDays(movement: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  days: number;
  reason: string;
}): Promise<void> {
  const { request } = await holdDays(movement);

  await balances.commit(asAdministrator(), { ...movement, leaveRequestId: request.id });
}

/** The holding half of {@link takeDays}, for leave nobody has decided yet. */
async function holdDays(movement: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  days: number;
  reason: string;
}) {
  const { rows } = await admin.query<{ start_date: string; end_date: string }>(
    `SELECT start_date, start_date + ($2::int - 1) AS end_date FROM leave_year WHERE id = $1`,
    [movement.leaveYearId, movement.days],
  );

  return balances.reserveForRequest(asAdministrator(), {
    request: {
      employeeId: movement.employeeId,
      leaveTypeId: movement.leaveTypeId,
      leaveYearId: movement.leaveYearId,
      from: rows[0].start_date,
      to: rows[0].end_date,
      reason: movement.reason,
      /** FR 18, LMS 308. */
      lateEntryReason: null,
      countingBasis: 'CALENDAR_DAYS' as const,
      days: movement.days,
      calendarDays: movement.days,
      /* FR 38a. Where a request starts, which `LeaveRequestService` reads off the leave
         type's chain. This fixture goes straight to the door, so it says it. LMS 314. */
      awaitingApprovalFrom: 'MANAGER' as const,
      /** FR 48b. Nothing to skip: every desk can be asked. LMS 320. */
      skips: [],
      status: 'SUBMITTED' as const,
    },
    reason: movement.reason,
  });
}
function balanceOf(employeeId: string, leaveTypeId: string) {
  return balances.forOne(asAdministrator(), { employeeId, leaveTypeId, leaveYearId: y2026.id });
}

async function entriesOfType(entryType: string): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query(
    'SELECT * FROM leave_ledger_entry WHERE entry_type = $1 ORDER BY id',
    [entryType],
  );

  return rows as Record<string, unknown>[];
}

async function eventRows(): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query('SELECT * FROM leave_entitlement_event ORDER BY id');

  return rows as Record<string, unknown>[];
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asAColleague() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

/* ------------------------------------------------- the grant, against the event */

describe('recording an event grants what it brings', () => {
  /**
   * The story, as one employee's balance.
   *
   * Adwoa has a child on the fourth of March, HR records it, and the hundred and
   * twenty days of §4.3.1 are there — not next January, and not tied to a leave year
   * she has to wait for.
   */
  it('puts the entitlement in the balance the day it is recorded', async () => {
    const { entry, balance, event } = await aBirthFor(people.officer, maternityId);

    expect(entry).toMatchObject({ entryType: 'GRANT', days: 120 });
    expect(balance.entitled).toBe(120);
    expect(balance.available).toBe(120);
    expect(event.occurredOn).toBe(A_BIRTH);
  });

  /* The story's first criterion, as a foreign key: the grant is recorded *against* the
     event, and each row names the other. */
  it('and the grant and the event name each other', async () => {
    const { entry, event } = await aBirthFor(people.officer, maternityId);

    expect(event.grantedEntryId).toBe(entry.id);

    const [row] = await eventRows();

    expect(row.granted_entry_id).toBe(entry.id);
    expect(row.employee_id).toBe(people.officer);
    expect(row.leave_type_id).toBe(maternityId);
  });

  /* FR 27, and the sentence that makes the figure explainable. "120 days" says
     nothing; the day it was for says all of it. */
  it('and the entry says which event it was for', async () => {
    const { entry } = await aBirthFor(people.officer, maternityId);

    expect(entry.reason).toBe(`Maternity Leave for the event recorded on ${A_BIRTH}`);
    expect(entry.createdByEmployeeId).toBe(people.hrOfficer);
  });

  /**
   * And the grant lands in the year the event fell in, never today's.
   *
   * A birth in December told to HR in January belongs to December's balance. The
   * service reads the year covering the day, and the database holds the same rule —
   * so a caller that filed it elsewhere would be refused rather than quietly believed.
   */
  it('and lands in the leave year the event fell in', async () => {
    const { event } = await aBirthFor(people.officer, maternityId);

    expect(event.leaveYearId).toBe(y2026.id);

    await expect(
      admin.query(
        `INSERT INTO leave_entitlement_event
           (employee_id, leave_type_id, leave_year_id, occurred_on, granted_entry_id)
         SELECT $1, $2, (SELECT id FROM leave_year WHERE label = '2027'), $3, id
           FROM leave_ledger_entry LIMIT 1`,
        [people.officer, maternityId, A_BIRTH],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_entitlement_event_falls_in_its_leave_year' });
  });

  /**
   * And a second occurrence is a second grant, which is what FR 32g means by "per
   * qualifying occurrence".
   *
   * This is the rule `grantTheYear` is explicitly not: a year is granted once, and an
   * event type is granted every time the event happens. Two bereavements in one leave
   * year are ten days of compassionate leave, not five.
   */
  it('and a second occurrence grants again, unlike a year', async () => {
    await aBirthFor(people.officer, compassionateId, '2026-02-10');
    await aBirthFor(people.officer, compassionateId, '2026-06-20');

    expect((await balanceOf(people.officer, compassionateId)).entitled).toBe(10);
    expect(await entriesOfType('GRANT')).toHaveLength(2);
  });

  /**
   * But the same occurrence is not recorded twice.
   *
   * The duplicate that actually happens: somebody rings HR about a birth, and the
   * second person to hear about it does not know the first has already entered it.
   */
  it('and the same event on the same day is refused rather than granted twice', async () => {
    await aBirthFor(people.officer, maternityId);

    await expect(aBirthFor(people.officer, maternityId)).rejects.toBeInstanceOf(
      EventAlreadyRecorded,
    );
    expect((await balanceOf(people.officer, maternityId)).entitled).toBe(120);
  });

  /* And the refusal leaves neither row. The two are one act, so a refusal that wrote
     the grant and not the event would leave a hundred and twenty days nobody can
     explain. */
  it('and a refused recording writes neither row', async () => {
    await aBirthFor(people.officer, maternityId);

    await expect(aBirthFor(people.officer, maternityId)).rejects.toBeInstanceOf(
      EventAlreadyRecorded,
    );

    expect(await entriesOfType('GRANT')).toHaveLength(1);
    expect(await eventRows()).toHaveLength(1);
  });
});

/* ------------------------------------------------------ what may be recorded */

describe('what an event may be recorded against', () => {
  /**
   * A quota type is refused, and it is the one refusal here that is about the system
   * rather than about the person.
   *
   * Annual leave arrives with the year and is granted once by `grantTheYear`. Reaching
   * it through this door would be a second year of annual leave that goes past that
   * refusal entirely.
   */
  it('never a type whose entitlement arrives with the leave year', async () => {
    await expect(aBirthFor(people.officer, annualId)).rejects.toBeInstanceOf(NotAnEventBasedType);
    expect(await entriesOfType('GRANT')).toHaveLength(0);
  });

  /* FR 05, read off `gender_restriction` rather than decided anywhere. The chief
     executive is male in the seed, so maternity leave is not open to him. */
  it('nor a type the person is not eligible for', async () => {
    await expect(aBirthFor(people.ceo, maternityId)).rejects.toBeInstanceOf(NotEligibleForTheType);
  });

  /**
   * A type with no entitlement rule at all, so there is a figure to be had from nowhere.
   * Reported by name rather than granted as nought, because a ledger entry of no days is
   * not a movement.
   *
   * **The example is made rather than borrowed, and that is LMS 401's doing.** This used
   * to reach for unpaid leave, which was an event type with no figure — FR 32h read as
   * agreed occasion by occasion. Unpaid leave is now ten working days a year and every
   * statutory type carries a figure, so there is no longer a shipped type in this state.
   *
   * Which is the better test anyway. A rule proved against a fixture that happens to have
   * the right shape is a rule that stops being proved the day somebody prices that type —
   * exactly what just happened. This one builds the condition it is about, so it goes on
   * asserting the rule whatever HR does to the statutory set.
   */
  it('nor a type nobody has said the worth of', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO leave_type (code, name, counting_basis, entitlement_basis, display_order)
       VALUES ('UNPRICED', 'Unpriced Leave', 'WORKING_DAYS', 'EVENT', 99)
       RETURNING id`,
    );

    await expect(aBirthFor(people.officer, rows[0].id)).rejects.toBeInstanceOf(
      NoEntitlementForTheEvent,
    );

    await admin.query(`DELETE FROM leave_type WHERE code = 'UNPRICED'`);
  });

  it('nor against somebody who does not exist', async () => {
    await expect(aBirthFor('987654321', maternityId)).rejects.toBeInstanceOf(EmployeeNotFound);
  });

  /**
   * And not a date in the future.
   *
   * The failure this prevents is a typo rather than fraud: 2027 for 2026 puts
   * somebody's leave a year out and starts the deadline clock in the wrong place.
   * FR 18's seven day backdating window is deliberately not applied — a birth told to
   * HR three weeks late is ordinary, and refusing it would leave the entitlement
   * ungrantable.
   */
  it('and not one that has not happened yet', async () => {
    await expect(aBirthFor(people.officer, maternityId, '2027-01-04')).rejects.toMatchObject({
      name: 'InvalidLeaveEvent',
      field: 'occurredOn',
    });
  });
});

/* ---------------------------------------------------------------- the deadline */

describe('a paternity grant carries an expiry six months out', () => {
  /* The story's second criterion, and it is one column read once: paternity's
     `entitlement_expiry_months` is six, and every other type's is null. */
  it('is recorded on the event, six months after the birth', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);

    expect(event.expiresOn).toBe(SIX_MONTHS_ON);
  });

  it('and the entry tells the employee when it runs out', async () => {
    const { entry } = await aBirthFor(people.teamLead, paternityId);

    expect(entry.reason).toBe(
      `Paternity Leave for the event recorded on ${A_BIRTH}, usable up to ${SIX_MONTHS_ON}`,
    );
  });

  /* And maternity's hundred and twenty days do not run out at all, which is the same
     column saying nothing. */
  it('and a type with no expiry months carries no deadline', async () => {
    const { event } = await aBirthFor(people.officer, maternityId);

    expect(event.expiresOn).toBeNull();
  });

  it('and it is the column that decides it, not the type', async () => {
    const { rows } = await admin.query(
      'SELECT code, entitlement_expiry_months FROM leave_type ORDER BY code',
    );

    expect(rows.filter((row) => row.entitlement_expiry_months !== null)).toEqual([
      { code: 'PATERNITY', entitlement_expiry_months: 6 },
    ]);
  });

  /**
   * And the deadline is not moved by changing the column afterwards.
   *
   * FR 31's argument about closed years, applied to a clock: a grant already made
   * keeps the deadline it was made under. That is why `expires_on` is a stored column
   * rather than something recomputed on every read, and the table refuses to have it
   * rewritten — on the owner connection as well.
   */
  it('and a grant already made keeps the deadline it was made under', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);

    await admin.query('UPDATE leave_type SET entitlement_expiry_months = 1 WHERE id = $1', [
      paternityId,
    ]);

    expect((await eventRepository.findById(event.id))?.expiresOn).toBe(SIX_MONTHS_ON);

    await expect(
      admin.query('UPDATE leave_entitlement_event SET expires_on = $1 WHERE id = $2', [
        '2026-04-04',
        event.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_entitlement_event_is_what_happened' });
  });
});

/* ------------------------------------------------------------- the expiry job */

describe('the expiry job lapses whatever remains', () => {
  /* The story's third criterion. Fourteen days, none of them taken, six months gone. */
  it('takes back what was never used', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);

    const run = await expiry.run(nightly, '2026-09-05');

    expect(run.lapsed).toHaveLength(1);
    expect(run.lapsed[0]).toMatchObject({ leaveEventId: event.id, days: 14 });
    expect(daysLapsed(run)).toBe(14);
    expect((await balanceOf(people.teamLead, paternityId)).available).toBe(0);
  });

  /**
   * As a `LAPSE`, and it takes the days back out of `entitled` where the grant put
   * them.
   *
   * This is the whole reason LMS 218 spent a migration on a ninth entry type. An
   * `EXPIRY` moves `carriedOver` — FR 36a's clock — and using it here would leave a
   * paternity balance reading `carriedOver: -14` on a type that cannot carry a single
   * day. Available would be right and the column would be false.
   */
  it('as a LAPSE, out of entitled rather than out of carried over', async () => {
    await aBirthFor(people.teamLead, paternityId);
    await expiry.run(nightly, '2026-09-05');

    const balance = await balanceOf(people.teamLead, paternityId);

    expect(balance).toMatchObject({ entitled: 0, carriedOver: 0, available: 0 });
    expect(await entriesOfType('EXPIRY')).toHaveLength(0);

    const [lapse] = await entriesOfType('LAPSE');

    expect(Number(lapse.days)).toBe(-14);
    expect(lapse.created_by).toContain('the entitlement expiry');
  });

  /* §8.6aa: one grant may be drawn down by several requests, so a partly used grant is
     the ordinary case. What lapses is what is left. */
  it('and only what is left of a grant that was partly used', async () => {
    await aBirthFor(people.teamLead, paternityId);

    const movement = {
      employeeId: people.teamLead,
      leaveTypeId: paternityId,
      leaveYearId: y2026.id,
      days: 10,
      reason: 'Ten of the fourteen days, taken in March',
    };
    await takeDays(movement);

    const run = await expiry.run(nightly, '2026-09-05');

    expect(run.lapsed[0]?.days).toBe(4);
    expect(await balanceOf(people.teamLead, paternityId)).toMatchObject({
      entitled: 10,
      taken: 10,
      available: 0,
    });
  });

  /* FR 27, and the sentence somebody disputes. It names the deadline that was missed
     rather than the night the job ran. */
  it('and the entry names the deadline rather than the night it ran', async () => {
    await aBirthFor(people.teamLead, paternityId);
    await expiry.run(nightly, '2026-12-25');

    const [lapse] = await entriesOfType('LAPSE');

    expect(lapse.reason).toBe(
      `Unused Paternity Leave from the event on ${A_BIRTH} lapsed after ${SIX_MONTHS_ON}. FR 32e`,
    );
  });

  /* Not on the deadline itself. Somebody whose six months are up on the fourth may
     still take the leave on the fourth. */
  it('and does nothing on the deadline itself', async () => {
    await aBirthFor(people.teamLead, paternityId);

    const run = await expiry.run(nightly, SIX_MONTHS_ON);

    expect(run.lapsed).toHaveLength(0);
    expect(run.notLapsed).toHaveLength(0);
    expect((await balanceOf(people.teamLead, paternityId)).available).toBe(14);
  });

  /* And never touches a grant with no deadline. Maternity's hundred and twenty days do
     not run out, so no run ever sees them. */
  it('and never touches a grant that has no deadline at all', async () => {
    await aBirthFor(people.officer, maternityId);

    const run = await expiry.run(nightly, '2099-01-01');

    expect(run.lapsed).toHaveLength(0);
    expect((await balanceOf(people.officer, maternityId)).available).toBe(120);
  });

  it('and reports a grant that had nothing left rather than posting nothing quietly', async () => {
    await aBirthFor(people.teamLead, paternityId);

    const movement = {
      employeeId: people.teamLead,
      leaveTypeId: paternityId,
      leaveYearId: y2026.id,
      days: 14,
      reason: 'All fourteen days, taken in March',
    };
    await takeDays(movement);

    const run = await expiry.run(nightly, '2026-09-05');

    expect(run.lapsed).toHaveLength(0);
    expect(run.notLapsed[0]?.because).toBe('NOTHING_LEFT');
  });
});

/* -------------------------------------------------------- run it every night */

describe('the expiry job is safe to run every night', () => {
  /**
   * Idempotence is the operating mode here rather than a nicety: every night after
   * the first is a second run over rows the first already saw.
   */
  it('writes not one further ledger row on a second run', async () => {
    await aBirthFor(people.teamLead, paternityId);
    await expiry.run(nightly, '2026-09-05');

    const { rows: before } = await admin.query('SELECT * FROM leave_ledger_entry ORDER BY id');

    const again = await expiry.run(nightly, '2026-09-06');

    expect(again.lapsed).toHaveLength(0);
    expect(again.notLapsed).toHaveLength(0);
    expect((await admin.query('SELECT * FROM leave_ledger_entry ORDER BY id')).rows).toEqual(
      before,
    );
  });

  /* The refusal is the event row's, read inside the transaction that posts the entry,
     rather than the job remembering. A second lapse posted directly through the one
     door is refused the same way. */
  it('and a second lapse against the same event is refused inside the transaction', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);
    await expiry.run(nightly, '2026-09-05');

    await expect(
      balances.lapse(asAdministrator(), {
        employeeId: people.teamLead,
        leaveTypeId: paternityId,
        leaveYearId: y2026.id,
        days: 14,
        reason: 'a second helping',
        leaveEventId: event.id,
      }),
    ).rejects.toBeInstanceOf(AlreadyLapsed);

    expect(await entriesOfType('LAPSE')).toHaveLength(1);
  });

  /* And the event row records which entry closed it, so the pair can never come apart
     — a run that died between the two would have left neither. */
  it('and the event names the lapse that closed it', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);
    await expiry.run(nightly, '2026-09-05');

    const [lapse] = await entriesOfType('LAPSE');

    expect((await eventRepository.findById(event.id))?.lapsedEntryId).toBe(lapse.id);
  });

  /* And a lapse, once posted, is not un-posted. The entry it names is in the ledger
     forever, so clearing the column would leave the days gone and the row saying they
     are still there — the one state that would lapse them twice. */
  it('and the column cannot be cleared, by anybody', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);
    await expiry.run(nightly, '2026-09-05');

    await expect(
      admin.query('UPDATE leave_entitlement_event SET lapsed_entry_id = NULL WHERE id = $1', [
        event.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'leave_entitlement_event_lapses_once' });
  });
});

/* ------------------------------------------------- two grants in one balance */

describe('a grant is left alone while another in the same balance is still live', () => {
  /**
   * The rare case that makes "whatever remains" honest.
   *
   * Two births in one leave year, the first six months up and the second not. There is
   * no per-grant consumption anywhere in this system — the balance is what tracks what
   * has been taken — so the days cannot be attributed to one or the other. Lapsing the
   * first's deadline would take days somebody still has a live claim on.
   */
  it('lapses nothing, and says why', async () => {
    await aBirthFor(people.teamLead, paternityId, '2026-01-10');
    await aBirthFor(people.teamLead, paternityId, '2026-06-20');

    const run = await expiry.run(nightly, '2026-07-15');

    expect(run.lapsed).toHaveLength(0);
    expect(run.notLapsed[0]?.because).toBe('ANOTHER_GRANT_IS_LIVE');
    expect((await balanceOf(people.teamLead, paternityId)).available).toBe(28);
  });

  /**
   * And once both deadlines have passed, everything goes.
   *
   * Nothing is lost by holding back, which is the argument for holding back rather
   * than guessing. What happens is the honest consequence of there being one balance
   * rather than two: the first event's lapse takes all twenty-eight days, and the
   * second finds nothing left and says so. The days are gone once, and both rows in
   * the ledger say when and why.
   */
  it('and once both deadlines have passed, everything left goes', async () => {
    await aBirthFor(people.teamLead, paternityId, '2026-01-10');
    await aBirthFor(people.teamLead, paternityId, '2026-06-20');

    await expiry.run(nightly, '2026-07-15');
    const run = await expiry.run(nightly, '2026-12-21');

    expect(daysLapsed(run)).toBe(28);
    expect(run.lapsed).toHaveLength(1);
    expect(run.notLapsed.map((one) => one.because)).toEqual(['NOTHING_LEFT']);
    expect((await balanceOf(people.teamLead, paternityId)).available).toBe(0);
  });

  /**
   * And the one that found nothing stays open, on purpose.
   *
   * An event is closed off by the `LAPSE` that ended it, and nothing ended this one —
   * there was nothing to take. Marking it done anyway would mean recording a lapse
   * that never happened.
   *
   * Leaving it open is also the useful answer rather than merely the honest one. A
   * balance is not finished moving when a deadline passes: HR may post an
   * `ADJUSTMENT` next week correcting a figure, and those days are days past their
   * deadline. Because the event is still open, the next night's run finds them and
   * takes them; had it been closed, they would sit there with a deadline nothing
   * enforces.
   */
  it('and one that found nothing stays open, so a later correction still lapses', async () => {
    await aBirthFor(people.teamLead, paternityId, '2026-01-10');
    await aBirthFor(people.teamLead, paternityId, '2026-06-20');

    await expiry.run(nightly, '2026-12-21');

    expect(
      (await eventRepository.expiredBy('2026-12-22')).map((event) => event.occurredOn),
    ).toEqual(['2026-06-20']);

    await balances.adjust(asAdministrator(), {
      employeeId: people.teamLead,
      leaveTypeId: paternityId,
      leaveYearId: y2026.id,
      days: 3,
      reason: 'Three days that were wrongly recorded as taken',
    });

    const run = await expiry.run(nightly, '2026-12-22');

    expect(run.lapsed[0]?.days).toBe(3);
    expect((await balanceOf(people.teamLead, paternityId)).available).toBe(0);
  });
});

/* ------------------------------------------------ a year settled underneath it */

describe('a grant whose leave year has since been closed', () => {
  /**
   * A paternity grant made in December runs to June, and December's year may well have
   * been closed in February.
   *
   * §8.9 lets nothing but an `ADJUSTMENT` into a settled year, so nothing is posted —
   * and nothing is lost by that, because a closed year's balance cannot be booked
   * against either. Reported rather than thrown, so a nightly run does not stop on it.
   */
  it('is reported rather than lapsed, and the run carries on', async () => {
    /* A year that has ended, so it can be closed, and a figure covering it — the
       statutory rules run from 2026, and a birth in a year nobody has said the worth
       of is a different refusal from the one this test is about. */
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
    );
    await admin.query(
      `INSERT INTO leave_entitlement_rule
         (leave_type_id, entitlement_days, effective_from, effective_to, note)
       VALUES ($1, 14, '2025-01-01', '2025-12-31', 'The 2025 paternity figure, for this suite')`,
      [paternityId],
    );

    const y2025 = (await years.byLabel(system, '2025'))!;

    await aBirthFor(people.teamLead, paternityId, '2025-11-10');
    await years.close(asAdministrator(), y2025.id);

    const run = await expiry.run(nightly, '2026-05-15');

    expect(run.lapsed).toHaveLength(0);
    expect(run.notLapsed[0]?.because).toBe('THE_YEAR_IS_CLOSED');
    expect(await entriesOfType('LAPSE')).toHaveLength(0);
  });
});

/* ----------------------------------------------- an event is what happened */

describe('an event is a record of something that happened', () => {
  /* The three facts the grant was calculated from are what it was calculated from, so
     changing one afterwards would move a balance with nothing in the ledger to say
     why. FR 27, applied to the record rather than to the movement. */
  it('and the facts the grant was calculated from cannot be rewritten', async () => {
    const { event } = await aBirthFor(people.officer, maternityId);

    for (const [column, value] of [
      ['employee_id', people.teamLead],
      ['occurred_on', '2026-04-04'],
      ['leave_type_id', compassionateId],
    ]) {
      await expect(
        admin.query(`UPDATE leave_entitlement_event SET ${column} = $1 WHERE id = $2`, [
          value,
          event.id,
        ]),
      ).rejects.toMatchObject({ constraint: 'leave_entitlement_event_is_what_happened' });
    }
  });

  /* A note explains rather than decides, exactly as an entitlement rule's note stays
     editable once the rule is in effect. */
  it('but the note that explains it may still be improved', async () => {
    const { event } = await aBirthFor(people.officer, maternityId, A_BIRTH, 'second child');

    await expect(
      admin.query('UPDATE leave_entitlement_event SET note = $1 WHERE id = $2', [
        'second child; certificate seen 6 March',
        event.id,
      ]),
    ).resolves.toBeDefined();
  });

  /* And nothing is removed. The grant it caused is in the ledger forever, so deleting
     the row would leave a hundred and twenty days with nothing to explain them. */
  it('and nothing is ever removed, by anybody', async () => {
    const { event } = await aBirthFor(people.officer, maternityId);

    await expect(
      admin.query('DELETE FROM leave_entitlement_event WHERE id = $1', [event.id]),
    ).rejects.toThrow(/never deleted/);

    const { rows } = await admin.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'lms_app' AND table_name = 'leave_entitlement_event'
        ORDER BY privilege_type`,
    );

    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  /* NFR AUD 01. This is the largest single figure the system puts into anybody's
     balance, and it goes there because one person said a thing had happened. */
  it('and who recorded it is in the audit log', async () => {
    await aBirthFor(people.officer, maternityId);

    const { rows } = await admin.query(
      "SELECT * FROM audit_log WHERE entity = 'leave_entitlement_event' ORDER BY id",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('CREATE');
    expect(rows[0].actor_employee_id).toBe(people.hrOfficer);
  });
});

/* ---------------------------------------------------------------- whose job it is */

describe('who may record an event, and who may lapse one', () => {
  /**
   * Recording is HR's, both desks, and it is the one grant in this system that is not
   * an Administrator's alone.
   *
   * The two that are — a year's entitlement, and a year's remainder — apply a policy to
   * everybody at once. Recording a birth is one fact about one person, told to whoever
   * answered the telephone, and the figure still comes from the entitlement rule. A new
   * father with fourteen days he cannot book because an Administrator has not been in
   * this week is the system failing at the only moment it was going to matter to him.
   */
  it('an HR Officer may record one', async () => {
    await expect(aBirthFor(people.officer, maternityId)).resolves.toMatchObject({
      entry: { days: 120 },
    });
  });

  it('and so may an HR Administrator', async () => {
    await expect(
      events.record(asAdministrator(), {
        employeeId: people.officer,
        leaveTypeId: maternityId,
        occurredOn: A_BIRTH,
      }),
    ).resolves.toBeDefined();
  });

  it('but not a colleague, nor the person themselves', async () => {
    await expect(
      events.record(asAColleague(), {
        employeeId: people.officer,
        leaveTypeId: maternityId,
        occurredOn: A_BIRTH,
      }),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  /**
   * Lapsing is an Administrator's, and the line is the one this system keeps
   * everywhere: recording that something happened to one person is the employee-record
   * desk, and applying a rule that takes days off people is the desk that writes it.
   *
   * It matters more here than for a grant because of the direction. A wrong grant
   * leaves somebody with days they did not earn, which a report catches. A wrong lapse
   * takes days off somebody who was going to use them, and they find out when they try
   * to book.
   */
  it('and lapsing one is an HR Administrator’s, not an Officer’s', async () => {
    const { event } = await aBirthFor(people.teamLead, paternityId);

    await expect(
      balances.lapse(asOfficer(), {
        employeeId: people.teamLead,
        leaveTypeId: paternityId,
        leaveYearId: y2026.id,
        days: 14,
        reason: 'lapsed',
        leaveEventId: event.id,
      }),
    ).rejects.toThrow(/HR Administrator/);
  });

  /* And the events on somebody's record follow the balance's own read rule, because an
     event is the reason a figure is what it is: standing to see one without the other
     would be standing to see half an explanation. */
  it('and the events on a record are read by whoever may read the balance', async () => {
    await aBirthFor(people.officer, maternityId);

    await expect(events.forEmployee(asAdministrator(), people.officer)).resolves.toHaveLength(1);
    await expect(
      events.forEmployee(
        signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false }),
        people.officer,
      ),
    ).resolves.toHaveLength(1);
    await expect(events.forEmployee(asAColleague(), people.officer)).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });
});
