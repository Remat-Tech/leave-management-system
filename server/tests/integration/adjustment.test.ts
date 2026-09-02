import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { EmployeeNotFound } from '../../src/features/employee/employee.js';
import { InvalidLedgerEntry, LedgerEntryNotFound } from '../../src/features/balance/ledger.js';
import { LeaveTypeNotFound } from '../../src/features/leave-type/leave-type.js';
import { type LeaveYear, LeaveYearNotFound } from '../../src/features/leave-year/leave-year.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { LedgerRepository } from '../../src/features/balance/ledger.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { type Adjustment, BalanceService } from '../../src/features/balance/balance.service.js';
import { LedgerService } from '../../src/features/balance/ledger.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Moving a balance by hand. FR 37. LMS 216.
 *
 * The story is one HR person putting a genuine mistake right: a figure that is wrong,
 * a sentence saying why, and a movement anybody can find afterwards. Its three
 * criteria are a positive or negative adjustment, a mandatory reason, and an entry
 * that appears in the ledger like any other movement.
 *
 * ## What is proved elsewhere, deliberately
 *
 * The machinery this rides on arrived earlier and is tested where it lives, and
 * repeating it here would be two suites that could disagree:
 *
 *   **That the entry can never be changed or removed**, by any connection including
 *   the owner, is ./ledger.test.ts. It is the "without editing history" half of the
 *   story's own sentence and it is a property of the table rather than of this call.
 *
 *   **That an `ADJUSTMENT` moves the `adjustment` column and no other**, and that the
 *   cache moves inside the entry's transaction, is ./balance.test.ts against
 *   `BUCKETS`.
 *
 *   **That a settled leave year accepts an adjustment and nothing else** — §8.9, the
 *   one exception in this schema — is in both of those.
 *
 * ## What is here
 *
 * The story as somebody in HR would actually meet it, end to end, and the two things
 * LMS 216 changed:
 *
 *   **Both directions, in one balance, netting to what they add up to.** FR 37 asks
 *   for "positive or negative" and the interesting case is a balance that has had
 *   both, because `adjustment` is the one bucket where the two can cancel.
 *
 *   **The reason survives to the screen somebody reads it on**, trimmed, beside the
 *   figure it explains. A reason held in a column nothing renders would satisfy the
 *   criterion and none of the story.
 *
 *   **A mistyped id is answered with a sentence rather than a foreign key.** The
 *   three ids of an adjustment are typed by a person, which is true of no other
 *   movement, so this is the one that had to learn to say `LeaveTypeNotFound`.
 *
 *   **An HR Officer is refused, openly, and told which desk can.** The story says "as
 *   an HR Officer" and §10's matrix has an ✗ against that column; the matrix is what
 *   the code follows. The sentence they are given is the part of that disagreement a
 *   person actually experiences, so it is asserted rather than left to the policy
 *   unit suite.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('adjustment integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let balances: BalanceService;
let ledger: LedgerService;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

/** The 2026 leave year and the two leave types this suite adjusts. */
let y2026: LeaveYear;
let annualId: string;
let sickId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  ledger = new LedgerService(new LedgerRepository(db), guard, employees);
  years = new LeaveYearService(new LeaveYearRepository(db), guard);

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  /* The cache first and the ledger second, which is the order they depend in, and
     both by TRUNCATE because each table refuses a DELETE on every connection. */
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0]
    .id as string;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
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

/** What HR types in: a signed figure and a sentence, against one balance. */
function anAdjustment(days: number, reason = 'Agreed with the employee on 4 March'): Adjustment {
  return { employeeId: people.officer, leaveTypeId: annualId, leaveYearId: y2026.id, days, reason };
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asThemselves() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

/* --------------------------------------------------- positive or negative, FR 37 */

describe('HR posts an adjustment in either direction', () => {
  it('gives days, and the balance says so before the call returns', async () => {
    const { entry, balance } = await balances.adjust(
      asAdministrator(),
      anAdjustment(3, 'Three days of the 2025 carry over were missed at go live'),
    );

    expect(entry).toMatchObject({ entryType: 'ADJUSTMENT', days: 3, correctsId: null });
    expect(balance.adjustment).toBe(3);
    expect(balance.available).toBe(3);
  });

  it('and takes them, with the same call and the opposite sign', async () => {
    const { entry, balance } = await balances.adjust(
      asAdministrator(),
      anAdjustment(-2, 'Two days in February were never recorded against her balance'),
    );

    expect(entry).toMatchObject({ entryType: 'ADJUSTMENT', days: -2 });
    expect(balance.adjustment).toBe(-2);
    expect(balance.available).toBe(-2);
  });

  /**
   * The case the bucket exists for.
   *
   * `adjustment` is the one column of the five that both kinds of movement land in,
   * so a balance that has had a correction and then a correction of the correction
   * arrives at the net of the two — with three rows still there saying how.
   */
  it('and a balance that has had both arrives at what they add up to', async () => {
    await balances.adjust(asAdministrator(), anAdjustment(3, 'Carry over missed at go live'));
    await balances.adjust(asAdministrator(), anAdjustment(-2, 'February absence never recorded'));
    const { balance } = await balances.adjust(
      asAdministrator(),
      anAdjustment(-1, 'March absence never recorded'),
    );

    expect(balance.adjustment).toBe(0);
    expect(
      (await ledger.history(asAdministrator(), people.officer)).map(({ days }) => days),
    ).toEqual([3, -2, -1]);
  });

  /**
   * And it may take a balance below nought, which no other movement may.
   *
   * `daysToReserve` refuses to overdraw a balance and `daysToCommit` refuses to spend
   * days nothing is holding. An adjustment checks nothing, because there is nothing
   * to check it against: where HR means to put somebody eight days in arrears — days
   * taken that were never recorded — they mean to do it, and refusing would leave the
   * true figure unrecordable.
   */
  it('and may put a balance below nought, because HR meant to', async () => {
    const { balance } = await balances.adjust(
      asAdministrator(),
      anAdjustment(-8, 'Eight days taken in 2026 were never recorded against her balance'),
    );

    expect(balance.available).toBe(-8);
  });

  /* §8.6d's hundredth of a day. An adjustment is one of the four entitlement types,
     so it is not held to FR 24's whole days — a pro rated figure being put right is
     10.08 and not 10. */
  it('and carries a fraction, because what somebody is owed is divisible', async () => {
    const { entry, balance } = await balances.adjust(
      asAdministrator(),
      anAdjustment(10.08, 'Pro rated joining entitlement, posted late'),
    );

    expect(entry.days).toBe(10.08);
    expect(balance.adjustment).toBe(10.08);
  });

  it('but not a movement of no days at all', async () => {
    await expect(balances.adjust(asAdministrator(), anAdjustment(0))).rejects.toMatchObject({
      name: 'InvalidLedgerEntry',
      field: 'days',
    });
  });
});

/* ------------------------------------------------------------ reason mandatory */

describe('the reason is mandatory, and is the point of the story', () => {
  it('refuses a blank one against the field, before the database is asked', async () => {
    await expect(balances.adjust(asAdministrator(), anAdjustment(3, ''))).rejects.toMatchObject({
      name: 'InvalidLedgerEntry',
      field: 'reason',
    });

    await expect(balances.adjust(asAdministrator(), anAdjustment(3, '   '))).rejects.toBeInstanceOf(
      InvalidLedgerEntry,
    );
  });

  /* NFR USA 03: the sentence has to reach the form beside the input it is about, so
     it says what a reason is for rather than that a field is required. */
  it('and says why it wants one', async () => {
    await expect(balances.adjust(asAdministrator(), anAdjustment(3, ''))).rejects.toThrow(
      /Every movement in a balance needs a reason/,
    );
  });

  it('keeps what was written, trimmed', async () => {
    const { entry } = await balances.adjust(
      asAdministrator(),
      anAdjustment(3, '  Agreed with the employee on 4 March  '),
    );

    expect(entry.reason).toBe('Agreed with the employee on 4 March');
  });

  /* Nothing stops an adjustment being posted without one, in this application or in
     the table — which is what "mandatory" has to mean for a column whose whole value
     is that it is never empty. */
  it('and the column refuses a blank one from a writer that never came through here', async () => {
    await expect(
      admin.query(
        `INSERT INTO leave_ledger_entry
           (employee_id, leave_type_id, leave_year_id, entry_type, days, reason)
         VALUES ($1, $2, $3, 'ADJUSTMENT', '3.00', '   ')`,
        [people.officer, annualId, y2026.id],
      ),
    ).rejects.toMatchObject({ constraint: 'leave_ledger_entry_reason_not_blank' });
  });
});

/* ------------------------------------- it appears in the ledger like any other */

describe('an adjustment reads as an ordinary movement', () => {
  /**
   * The third criterion, taken literally: the screen somebody opens to ask why they
   * have twelve days rather than fifteen shows it in its place, with the running
   * figure it left behind and the sentence that explains it.
   */
  it('appears in the history in the order written, with the figure it left', async () => {
    await balances.adjust(asAdministrator(), anAdjustment(20, 'Opening balance at go live'));
    await balances.adjust(asAdministrator(), anAdjustment(-5, 'Five days taken before go live'));

    const account = await ledger.history(asAdministrator(), people.officer);

    expect(
      account.map(({ entryType, days, after, reason }) => ({ entryType, days, after, reason })),
    ).toEqual([
      {
        entryType: 'ADJUSTMENT',
        days: 20,
        after: 20,
        reason: 'Opening balance at go live',
      },
      {
        entryType: 'ADJUSTMENT',
        days: -5,
        after: 15,
        reason: 'Five days taken before go live',
      },
    ]);
  });

  /* And the person whose balance it is can read it, which is FR 53 and is the whole
     of "without losing the explanation": the explanation is no use in a table only
     the person who wrote it can open. */
  it('and the employee can read it themselves, reason and all', async () => {
    await balances.adjust(asAdministrator(), anAdjustment(-3, 'Three days taken in January'));

    const [entry] = await ledger.history(asThemselves(), people.officer);

    expect(entry.reason).toBe('Three days taken in January');
    expect(entry.createdByEmployeeId).toBe(people.headOfHr);
  });

  /* It is filed under one balance and shows up in that one only. An adjustment to
     annual leave is not a movement in the sick leave account. */
  it('and belongs to the one balance it names', async () => {
    await balances.adjust(asAdministrator(), anAdjustment(3));

    const annual = await ledger.history(asAdministrator(), people.officer, {
      leaveTypeId: annualId,
    });
    const sick = await ledger.history(asAdministrator(), people.officer, { leaveTypeId: sickId });

    expect(annual).toHaveLength(1);
    expect(sick).toHaveLength(0);
  });

  /**
   * And it is findable as what it is.
   *
   * `ADJUSTMENT` is the entry type a report of "every figure HR moved by hand" reads,
   * and the reason every correction is routed through it rather than disguised as a
   * grant. The filter is `LedgerService.history`'s, and this is the read that makes
   * FR 37 auditable rather than merely recorded.
   */
  it('and can be picked out of a history that has other movements in it', async () => {
    await balances.grantTheYear(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
      days: 20,
      reason: 'The 2026 annual grant',
    });
    await balances.adjust(asAdministrator(), anAdjustment(3, 'Long service day, agreed 4 March'));

    const byHand = await ledger.history(asAdministrator(), people.officer, {
      entryTypes: ['ADJUSTMENT'],
    });

    expect(byHand).toHaveLength(1);
    expect(byHand[0]).toMatchObject({ days: 3, reason: 'Long service day, agreed 4 March' });
  });
});

/* --------------------------------------------- a mistake in the mistake fixing */

describe('an adjustment posted in error is put right by another entry', () => {
  it('by its exact opposite, naming the row it corrects', async () => {
    const wrong = await balances.adjust(asAdministrator(), anAdjustment(30, 'Opening balance'));

    const { entry, balance } = await balances.correct(
      asAdministrator(),
      wrong.entry.id,
      'Opening balance was 20; 30 was a typing error',
    );

    expect(entry).toMatchObject({ entryType: 'ADJUSTMENT', days: -30, correctsId: wrong.entry.id });
    expect(balance.adjustment).toBe(0);
  });

  /* Both rows stay, and both stay readable, which is the difference between fixing a
     mistake and hiding one. The balance is nought and the account is three lines. */
  it('and the history keeps both, so the figure is still explained', async () => {
    const wrong = await balances.adjust(asAdministrator(), anAdjustment(30, 'Opening balance'));
    await balances.correct(asAdministrator(), wrong.entry.id, '30 was a typing error');
    await balances.adjust(asAdministrator(), anAdjustment(20, 'Opening balance, corrected'));

    const account = await ledger.history(asAdministrator(), people.officer);

    expect(account.map(({ days, after }) => [days, after])).toEqual([
      [30, 30],
      [-30, 0],
      [20, 20],
    ]);
  });

  it('and there is nothing to correct where there is no such entry', async () => {
    await expect(
      balances.correct(asAdministrator(), '987654321', 'posted twice'),
    ).rejects.toBeInstanceOf(LedgerEntryNotFound);
  });
});

/* ----------------------------------------------------- the ids somebody typed */

describe('the three ids an adjustment names are checked, and answered in words', () => {
  /**
   * The one movement whose employee, leave type and leave year come from a form.
   *
   * Every other movement is called by a job or by the request story, holding records
   * it has already resolved; `correct` takes its key off the row it is putting right.
   * So this is the only place a mistyped id would otherwise reach a foreign key, and
   * `insert or update on table "leave_ledger_entry" violates foreign key constraint`
   * is not a sentence a form can put beside an input. NFR USA 03.
   */
  it('an employee who is nobody', async () => {
    await expect(
      balances.adjust(asAdministrator(), { ...anAdjustment(3), employeeId: '987654321' }),
    ).rejects.toBeInstanceOf(EmployeeNotFound);
  });

  it('a leave type that is nothing', async () => {
    await expect(
      balances.adjust(asAdministrator(), { ...anAdjustment(3), leaveTypeId: '987654321' }),
    ).rejects.toMatchObject({ name: 'LeaveTypeNotFound', leaveTypeId: '987654321' });
  });

  it('a leave year that is no year', async () => {
    await expect(
      balances.adjust(asAdministrator(), { ...anAdjustment(3), leaveYearId: '987654321' }),
    ).rejects.toMatchObject({ name: 'LeaveYearNotFound', leaveYearId: '987654321' });
  });

  /* And none of the three leaves a row behind. The check is inside the transaction
     the movement is written in, so a refusal rolls back with everything else. */
  it('and a refused adjustment writes nothing', async () => {
    await expect(
      balances.adjust(asAdministrator(), { ...anAdjustment(3), leaveTypeId: '987654321' }),
    ).rejects.toBeInstanceOf(LeaveTypeNotFound);
    await expect(
      balances.adjust(asAdministrator(), { ...anAdjustment(3), leaveYearId: '987654321' }),
    ).rejects.toBeInstanceOf(LeaveYearNotFound);

    const { rows } = await admin.query('SELECT count(*)::int AS n FROM leave_ledger_entry');

    expect(rows[0].n).toBe(0);
  });
});

/* ------------------------------------------------------------ whose job it is */

describe('who may move a balance by hand, FR 37 and §10', () => {
  it('an HR Administrator, and that is the whole list', async () => {
    await expect(balances.adjust(asAdministrator(), anAdjustment(3))).resolves.toMatchObject({
      entry: { days: 3 },
    });
  });

  /**
   * And **not** an HR Officer, which is where this story and the authorisation matrix
   * disagree.
   *
   * LMS 216 is written "as an HR Officer"; §10 has an ✗ against that column and every
   * other one. The matrix is what the code follows — an adjustment moves days by
   * fiat, with no request and no rule behind it, and can never be removed, only
   * compensated — and the argument is `ledgerPolicy.adjust`'s.
   *
   * The refusal is open rather than silent, and that is the part worth asserting.
   * Somebody who has been asked to fix a balance and cannot needs to be told which
   * desk can, not merely that they may not; they can already read the balance, so the
   * sentence discloses nothing.
   */
  it('and not an HR Officer, who is told which desk can', async () => {
    await expect(balances.adjust(asOfficer(), anAdjustment(3))).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(balances.adjust(asOfficer(), anAdjustment(3))).rejects.toThrow(
      /HR Administrator.*to post/,
    );
  });

  it('nor a line manager, nor the person whose balance it is', async () => {
    await expect(balances.adjust(asTheirManager(), anAdjustment(3))).rejects.toBeInstanceOf(
      NotAuthorised,
    );
    await expect(balances.adjust(asThemselves(), anAdjustment(3))).rejects.toBeInstanceOf(
      NotAuthorised,
    );
  });

  /* Correcting an entry is decided by the same rule rather than a separate one:
     whoever can post an adjustment can already post its opposite, and a split would
     suggest somebody might hold one and not the other. */
  it('and correcting an entry is the same decision, not a second one', async () => {
    const wrong = await balances.adjust(asAdministrator(), anAdjustment(20));

    await expect(
      balances.correct(asOfficer(), wrong.entry.id, 'posted twice'),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  /* A refusal writes nothing, which matters more here than for a read: the whole
     claim of the ledger is that every row in it was posted by somebody entitled to. */
  it('and a refused adjustment leaves the balance exactly as it was', async () => {
    await balances.adjust(asAdministrator(), anAdjustment(20, 'Opening balance'));
    await expect(balances.adjust(asOfficer(), anAdjustment(5))).rejects.toBeInstanceOf(
      NotAuthorised,
    );

    const balance = await balances.forOne(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026.id,
    });

    expect(balance.adjustment).toBe(20);
  });
});
