import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  type AnnualGrantRun,
  daysGranted,
  passedOver,
} from '../../src/features/entitlement/annual-grant.js';
import { earliestOpenDayFrom } from '../../src/features/leave-year/leave-year.service.js';
import { AnnualGrant } from '../../src/features/entitlement/annual-grant.job.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { EntitlementRuleService } from '../../src/features/entitlement/entitlement-rule.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The annual grant of entitlement, against a real database. FR 30. LMS 214.
 *
 * The unit suite proves the decision — who is granted what, and why anybody is passed
 * over. What needs a server is the half a pure function cannot have, and for this story
 * it is two things:
 *
 *   **A grant is a ledger entry, and the balance follows it.** The story's second
 *   criterion. Not a figure written into `leave_balance`, which nothing above the
 *   database may do at all since LMS 211, but a `GRANT` row with a reason and a name
 *   against it — and a cache that arrives at the same number by itself, in the same
 *   transaction.
 *
 *   **Running it twice does not grant the year twice.** Which is not a hypothetical
 *   about idempotence: it is what happens when the job fails at employee three hundred
 *   on a January morning and somebody runs it again. The refusal is inside the lock, in
 *   `BalanceService.grantTheYear`, so this suite is checking a property of the database
 *   rather than of the loop above it.
 *
 * The fixtures do most of the work. The seeded organisation already has the awkward
 * cases in it — a part timer, a lone HR officer, people in different departments — and
 * the statutory entitlement rules come from the migration rather than from anything
 * here, so what is granted is what a real database would grant.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Every role and nobody, which is what the January run is. */
const january = theSystem('the annual grant of entitlement');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let job: AnnualGrant;
let balances: BalanceService;
let years: LeaveYearService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];
let y2026Id: string;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(new LeaveYearRepository(db), guard);

  job = new AnnualGrant(
    balances,
    years,
    new EntitlementRuleService(
      new EntitlementRuleRepository(db),
      guard,
      earliestOpenDayFrom(new LeaveYearRepository(db)),
    ),
    employees,
    new LeaveTypeRepository(db),
  );

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry');
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026Id = (await admin.query("SELECT id FROM leave_year WHERE label = '2026'")).rows[0]
    .id as string;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
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

/** Every ledger entry in the 2026 year, oldest first. */
async function entries(): Promise<Record<string, unknown>[]> {
  const { rows } = await admin.query(
    'SELECT * FROM leave_ledger_entry WHERE leave_year_id = $1 ORDER BY id',
    [y2026Id],
  );

  return rows as Record<string, unknown>[];
}

/** What one person was granted of annual leave, as the run recorded it. */
function grantFor(run: AnnualGrantRun, employeeId: string) {
  return run.granted.find(
    (grant) => grant.employeeId === employeeId && grant.leaveTypeId === annualId,
  );
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: true });
}

function asOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

/* ------------------------------------------------------ what a year's grant produces */

describe('granting a leave year', () => {
  it('gives everybody employed at the start of it their annual entitlement', async () => {
    const run = await job.run(january, y2026Id);

    expect(run.leaveYearLabel).toBe('2026');
    expect(run.granted.length).toBeGreaterThan(0);
    expect(grantFor(run, people.officer)?.days).toBeGreaterThan(0);
  });

  /**
   * The story's second criterion, and the shape of every figure in this system.
   *
   * Not a number written into `leave_balance` — nothing above the database may write
   * that at all — but a `GRANT` row carrying a reason and the name of whoever ran it.
   * Somebody asking in March why they have twenty days gets a date, an amount and a
   * sentence rather than an assertion.
   */
  it('and writes each one as a grant ledger entry, with a reason and a name', async () => {
    await job.run(january, y2026Id);

    const posted = await entries();

    expect(posted.length).toBeGreaterThan(0);
    for (const entry of posted) {
      expect(entry.entry_type).toBe('GRANT');
      expect(Number(entry.days)).toBeGreaterThan(0);
      expect(entry.reason).toMatch(/entitlement for 2026$/);
      expect(entry.created_by).toContain('the annual grant of entitlement');
    }
  });

  /* And the cache arrives at the same figure by itself, in the same transaction. LMS
     211's trigger, reached by a story that knows nothing about it. */
  it('and the cached balance follows every one of them', async () => {
    const run = await job.run(january, y2026Id);

    const balance = await balances.forOne(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026Id,
    });

    expect(balance.entitled).toBe(grantFor(run, people.officer)?.days);
    expect(balance.available).toBe(balance.entitled);

    const { rows } = await admin.query('SELECT count(*) FROM leave_balance');
    expect(Number(rows[0].count)).toBe(run.granted.length);
  });

  /**
   * And only types with a yearly balance are granted. FR 32g.
   *
   * Maternity and paternity leave are `EVENT` types: the entitlement arrives with the
   * confinement or the birth, not with January. A run that granted a hundred and twenty
   * days of maternity leave to everybody in the company would be a balance screen that
   * lied to every one of them.
   */
  it('and grants nothing for a type whose entitlement arrives with an event', async () => {
    await job.run(january, y2026Id);

    const { rows } = await admin.query(
      `SELECT count(*) FROM leave_ledger_entry entry
         JOIN leave_type ON leave_type.id = entry.leave_type_id
        WHERE leave_type.entitlement_basis = 'EVENT'`,
    );

    expect(Number(rows[0].count)).toBe(0);
  });

  /**
   * And passes over a type nobody has said the worth of, rather than granting nought.
   *
   * Every quota type the migration ships has a statutory figure behind it, so the case
   * has to be made: a new type, with no rule. That is not contrived — FR 31 gives HR the
   * figures, and a type added on a Tuesday afternoon has none until somebody writes one.
   * A run that fell over on it, or granted nought days, would be a run nobody could add
   * a leave type in front of.
   *
   * The existing figures are deliberately not touched instead: a rule that has already
   * applied cannot be deleted by anybody, which is LMS 203's doing and is the right
   * answer to "make this case by removing history".
   */
  it('and passes over a type nobody has said the worth of', async () => {
    await admin.query(
      `INSERT INTO leave_type (code, name, counting_basis, entitlement_basis, display_order)
       VALUES ('STUDY', 'Study Leave', 'WORKING_DAYS', 'QUOTA', 90)`,
    );

    const run = await job.run(january, y2026Id);

    expect(passedOver(run).NO_ENTITLEMENT_RULE).toBeGreaterThan(0);
    expect(
      run.notGranted.every(
        (one) => one.because !== 'NO_ENTITLEMENT_RULE' || one.leaveTypeName === 'Study Leave',
      ),
    ).toBe(true);
    expect(passedOver(run).NOT_EMPLOYED_IN_THE_YEAR).toBe(0);
    expect(run.granted.some((grant) => grant.leaveTypeName === 'Study Leave')).toBe(false);
    expect(run.granted.length).toBeGreaterThan(0);
  });

  /* The figure is the rule in force on the first day of the year, not the rule in force
     today. A year granted in arrears gets the figure that was true when it began. */
  it('and takes the figure from the rule in force when the year began', async () => {
    const { rows } = await admin.query(
      `SELECT entitlement_days FROM leave_entitlement_rule
        WHERE leave_type_id = $1 AND employee_id IS NULL AND department_id IS NULL
          AND effective_from <= '2026-01-01' ORDER BY effective_from DESC LIMIT 1`,
      [annualId],
    );

    const run = await job.run(january, y2026Id);

    expect(grantFor(run, people.officer)?.days).toBe(rows[0].entitlement_days);
  });
});

/* ------------------------------------------------------------- running it twice */

/* ------------------------------------------- the joiner and the leaver. FR 29, LMS 215 */

describe('somebody who was here for part of the year', () => {
  /** What the annual leave rule is worth for a whole year on a migrated database. */
  async function fullYear(): Promise<number> {
    const { rows } = await admin.query(
      `SELECT entitlement_days FROM leave_entitlement_rule
        WHERE leave_type_id = $1 AND employee_id IS NULL AND department_id IS NULL
        ORDER BY effective_from DESC LIMIT 1`,
      [annualId],
    );

    return rows[0].entitlement_days as number;
  }

  async function reasonOn(employeeId: string, leaveTypeId = annualId): Promise<string> {
    const { rows } = await admin.query(
      'SELECT reason FROM leave_ledger_entry WHERE employee_id = $1 AND leave_type_id = $2',
      [employeeId, leaveTypeId],
    );

    return rows[0].reason as string;
  }

  /**
   * A joiner on 1 July is granted §8.6d's own worked example.
   *
   * 20 × 184/365 = 10.08 days, posted as a `GRANT` like any other. The story's "so
   * that" is exactly this: their balance is right from the first day rather than right
   * after somebody notices and corrects it.
   */
  it('is granted the proportion of it they worked', async () => {
    await admin.query("UPDATE employee SET start_date = '2026-07-01' WHERE id = $1", [
      people.officer,
    ]);

    const run = await job.run(january, y2026Id);

    expect(await fullYear()).toBe(20);
    expect(grantFor(run, people.officer)?.days).toBe(10.08);
  });

  /**
   * And the entry carries the name of the rule that produced the figure.
   *
   * The story's third criterion, and its answer to the fourth: LMS 013 has not settled
   * the formula, so a grant made under today's says which one it was made under. When
   * the answer lands, the figures to put right are a query rather than an
   * investigation.
   */
  it('and the grant says which rule worked the figure out, and over what', async () => {
    await admin.query("UPDATE employee SET start_date = '2026-07-01' WHERE id = $1", [
      people.officer,
    ]);

    await job.run(january, y2026Id);

    expect(await reasonOn(people.officer)).toBe(
      'Annual Leave entitlement for 2026, pro rated for 2026-07-01 to 2026-12-31 by the calendar-days rule',
    );
  });

  /**
   * And a leaver is the same call with the other end moved in. FR 29a.
   *
   * The second acceptance criterion, proved where it costs something: nothing in the
   * job or in the decision knows whether it is looking at a joiner or a leaver, and
   * somebody whose last day is already on the record is granted the part of the year
   * they will actually be here for.
   */
  it('and somebody whose last day is already known is granted only up to it', async () => {
    await admin.query("UPDATE employee SET exit_date = '2026-03-31' WHERE id = $1", [
      people.officer,
    ]);

    const run = await job.run(january, y2026Id);

    expect(grantFor(run, people.officer)?.days).toBe(Math.round(((20 * 90) / 365) * 100) / 100);
    expect(await reasonOn(people.officer)).toContain('pro rated for 2026-01-01 to 2026-03-31');
  });

  /* Somebody who started on the first day of the year is not a joiner: they get the
     whole figure and the reason names no rule, because none was asked. An off by one
     here would quietly deprive everybody who started on 1 January of a year of leave. */
  it('and somebody who started on the first day of the year gets the whole of it', async () => {
    await admin.query("UPDATE employee SET start_date = '2026-01-01' WHERE id = $1", [
      people.officer,
    ]);

    const run = await job.run(january, y2026Id);

    expect(grantFor(run, people.officer)?.days).toBe(await fullYear());
    expect(await reasonOn(people.officer)).toBe('Annual Leave entitlement for 2026');
  });

  /**
   * And a type nobody pro rates gives a July joiner the whole of it anyway.
   *
   * `leave_entitlement_rule.prorate_on_join`, FR 29: annual leave is pro rated and the
   * three days of sick leave are not, because a sick day is not something anybody
   * accrues. Read off the figure rather than decided anywhere — there is no leave type
   * code compared to anything in this story.
   */
  it('and a type nobody pro rates gives a July joiner the whole of it', async () => {
    await admin.query("UPDATE employee SET start_date = '2026-07-01' WHERE id = $1", [
      people.officer,
    ]);

    const sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0]
      .id as string;
    const { rows } = await admin.query(
      'SELECT entitlement_days, prorate_on_join FROM leave_entitlement_rule WHERE leave_type_id = $1',
      [sickId],
    );

    const run = await job.run(january, y2026Id);
    const sick = run.granted.find(
      (grant) => grant.employeeId === people.officer && grant.leaveTypeId === sickId,
    );

    expect(rows[0].prorate_on_join).toBe(false);
    expect(sick?.days).toBe(rows[0].entitlement_days);
    expect(await reasonOn(people.officer, sickId)).toBe('Sick Leave entitlement for 2026');
  });

  /* Somebody recorded before they start has no part of this year at all, which is a
     different answer from having a part worth nothing. */
  it('and somebody not employed in the year at all is passed over', async () => {
    await admin.query("UPDATE employee SET start_date = '2027-02-01' WHERE id = $1", [
      people.officer,
    ]);

    const run = await job.run(january, y2026Id);

    expect(grantFor(run, people.officer)).toBeUndefined();
    expect(
      run.notGranted.some(
        (one) => one.employeeId === people.officer && one.because === 'NOT_EMPLOYED_IN_THE_YEAR',
      ),
    ).toBe(true);

    const { rows } = await admin.query(
      'SELECT count(*) FROM leave_ledger_entry WHERE employee_id = $1',
      [people.officer],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  /**
   * And a joiner can be granted on their first morning rather than next January.
   *
   * The story's "so that", taken literally. A run may name one employee, so whoever
   * owns the joining flow grants them then and there — through exactly the code that
   * grants everybody in January, including the refusal that stops them being granted
   * twice.
   */
  it('and can be granted on their own, on the day they arrive', async () => {
    await admin.query("UPDATE employee SET start_date = '2026-07-01' WHERE id = $1", [
      people.officer,
    ]);

    const run = await job.run(january, y2026Id, { employeeId: people.officer });

    expect(run.granted.every((grant) => grant.employeeId === people.officer)).toBe(true);
    expect(grantFor(run, people.officer)?.days).toBe(10.08);

    const { rows } = await admin.query('SELECT count(DISTINCT employee_id) FROM leave_balance');
    expect(Number(rows[0].count)).toBe(1);
  });
});

describe('running it again', () => {
  /**
   * Grants nobody a second year, and says that is what happened.
   *
   * The realistic case: the job failed at employee three hundred on a January morning
   * and somebody ran it again. Every balance keeps exactly the entitlement it had, and
   * the report says they had already been granted rather than saying nothing.
   */
  it('grants nothing twice, and reports why not', async () => {
    const first = await job.run(january, y2026Id);
    const before = await entries();

    const second = await job.run(january, y2026Id);

    expect(second.granted).toEqual([]);
    expect(passedOver(second).ALREADY_GRANTED).toBe(first.granted.length);
    expect(await entries()).toEqual(before);
  });

  /* And the balance is untouched, which is the assertion that would fail if a second
     grant were posted and the cache followed it. */
  it('and leaves every balance exactly as it was', async () => {
    const first = await job.run(january, y2026Id);
    const before = await balances.forEmployee(asAdministrator(), people.officer, y2026Id);

    await job.run(january, y2026Id);

    expect(await balances.forEmployee(asAdministrator(), people.officer, y2026Id)).toEqual(before);
    expect(daysGranted(first)).toBeGreaterThan(0);
  });

  /**
   * And a run that only got halfway is finished by the next one.
   *
   * The other half of the same property, and the reason each grant is its own
   * transaction rather than the year being one: the two hundred and ninety-nine
   * employees who were granted keep theirs, and the re-run picks up the rest.
   */
  it('and finishes a run that stopped partway', async () => {
    await balances.grantTheYear(asAdministrator(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      leaveYearId: y2026Id,
      days: 20,
      reason: 'Annual Leave entitlement for 2026',
    });

    const run = await job.run(january, y2026Id);

    expect(grantFor(run, people.officer)).toBeUndefined();
    expect(run.granted.length).toBeGreaterThan(0);
    expect(
      run.notGranted.some(
        (one) =>
          one.employeeId === people.officer &&
          one.leaveTypeId === annualId &&
          one.because === 'ALREADY_GRANTED',
      ),
    ).toBe(true);

    /* And their other balances were granted by this run, which is the half that makes
       it a resumption rather than a skip. */
    expect(
      run.granted.some(
        (grant) => grant.employeeId === people.officer && grant.leaveTypeId !== annualId,
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------- who may run it */

describe('who may grant a year', () => {
  /* The same desk that writes the entitlement figures. An Officer applying figures only
     an Administrator may write would put a year's entitlement one desk below the
     decision behind it. */
  it('is an HR Administrator, and the January run', async () => {
    await expect(job.run(asAdministrator(), y2026Id)).resolves.toMatchObject({
      leaveYearLabel: '2026',
    });
  });

  it('and not an HR Officer', async () => {
    await expect(job.run(asOfficer(), y2026Id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  /* And a refusal grants nobody, rather than granting until it reaches somebody the
     actor may not touch. The policy is asked per movement, before any transaction. */
  it('and a refused run leaves the ledger empty', async () => {
    await expect(job.run(asOfficer(), y2026Id)).rejects.toBeInstanceOf(NotAuthorised);

    expect(await entries()).toEqual([]);
  });
});

/* ------------------------------------------------------------------- a settled year */

describe('a leave year that has been closed', () => {
  /**
   * Takes no grant at all, and the refusal comes from the ledger rather than from here.
   *
   * §8.9: a closed year is never recomputed, and the only entry it accepts is a manual
   * adjustment with a reason. A grant arriving in one would be a settled figure moving
   * with nobody's decision behind it — which is the thing the leave year rules exist to
   * prevent, reached by a story that knows nothing about them.
   */
  it('is refused, and the run stops rather than granting half a year', async () => {
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date) VALUES ('2025', '2025-01-01', '2025-12-31')`,
    );

    /* A figure for that year, written while it was still open — otherwise there is
       nothing to grant and the run would pass everybody over without the ledger ever
       being asked, which would prove nothing at all. */
    await admin.query(
      `INSERT INTO leave_entitlement_rule (leave_type_id, entitlement_days, effective_from, effective_to)
       VALUES ($1, 20, '2025-01-01', '2025-12-31')`,
      [annualId],
    );

    const y2025 = (await years.byLabel(january, '2025'))!;
    await years.close(asAdministrator(), y2025.id);

    await expect(job.run(january, y2025.id)).rejects.toThrow(/closed/);

    const { rows } = await admin.query(
      'SELECT count(*) FROM leave_ledger_entry WHERE leave_year_id = $1',
      [y2025.id],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
