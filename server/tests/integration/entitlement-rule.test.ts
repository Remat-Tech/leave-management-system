import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { Employee } from '../../src/features/employee/employee.js';
import {
  DuplicateEntitlementRule,
  type EarliestOpenDay,
  type EntitlementRule,
  EntitlementRuleAlreadyApplies,
  EntitlementRuleNotFound,
  InvalidEntitlementRule,
  NOTHING_IS_CLOSED_YET,
  ReachesIntoAClosedYear,
} from '../../src/features/entitlement/entitlement-rule.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { EmployeeService } from '../../src/features/employee/employee.service.js';
import { EntitlementRuleService } from '../../src/features/entitlement/entitlement-rule.service.js';
import { earliestOpenDayFrom } from '../../src/features/leave-year/leave-year.service.js';
import { LeaveTypeService } from '../../src/features/leave-type/leave-type.service.js';
import { seed } from '../../seeds/seed.mjs';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';

/**
 * Entitlement rules against a real database. FR 31, §5.5. LMS 203.
 *
 * ../unit/entitlement-rule.test.ts is where the resolution rule is proved, because
 * it is a pure function and a database would only slow the proof down. What needs
 * one is the half the database decides, and for this story that is most of what
 * makes FR 31 true rather than merely intended:
 *
 *   The figures of the FR 32 table are on a migrated database, effective dated,
 *   and the two types that have no figure have no rule rather than a zero.
 *
 *   A rule that has taken effect cannot be rewritten or removed **by anybody** —
 *   including a psql prompt and including this suite, which is why the fixtures
 *   truncate rather than delete.
 *
 *   The repository hands back candidates and decides nothing, and the database has
 *   not quietly grown a view that decides it instead. That is the story's fourth
 *   criterion — implemented once — held as an assertion rather than as a habit.
 *
 *   The fixture reload puts the statutory figures back. It has to: a rule may name
 *   an employee, so the table has a foreign key to one, and TRUNCATE CASCADE
 *   empties every referencing table wholesale.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

const DOMAINS = ['rematholdings.com'];

const system = theSystem('entitlement rule integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let rules: EntitlementRuleService;
let types: LeaveTypeService;
let employees: EmployeeService;
let people: Record<string, string>;

/** Today, on the same clock the service and the trigger both read. */
const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = Number(TODAY.slice(0, 4));

/** A date that has certainly passed, and one that certainly has not. */
const LAST_YEAR = `${THIS_YEAR - 1}-01-01`;
const NEXT_YEAR = `${THIS_YEAR + 1}-01-01`;

/** The day the statutory figures take effect from, straight out of the migration. */
const GO_LIVE = '2026-01-01';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  rules = ruleServiceWith(NOTHING_IS_CLOSED_YET);
  types = new LeaveTypeService(new LeaveTypeRepository(db), guard);
  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    { domains: DOMAINS },
  );
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/**
 * A service with a particular idea of what has been closed.
 *
 * The boundary is a constructor argument rather than a table read, which is what
 * lets the rule itself be proved with a fixed answer and lets the real reader be
 * proved separately — see "the boundary read from the leave years themselves"
 * below, where LMS 205 hands it {@link earliestOpenDayFrom} and an administrator
 * closes an actual year.
 */
function ruleServiceWith(earliestOpenDay: EarliestOpenDay): EntitlementRuleService {
  return new EntitlementRuleService(new EntitlementRuleRepository(db), guard, earliestOpenDay);
}

async function person(id: string): Promise<Employee> {
  return employees.byId(system, id);
}

async function typeIdFor(code: string): Promise<string> {
  const type = await types.byCode(system, code);
  expect(type, `no leave type with the code ${code}`).toBeDefined();
  return type!.id;
}

/** The figure that applies to somebody today, as a number, which is what a reader wants. */
async function daysFor(code: string, who: Employee, on = TODAY): Promise<number | undefined> {
  const rule = await rules.entitlementOn(system, who, await typeIdFor(code), on);

  return rule?.entitlementDays;
}

describe('the figures of the FR 32 table', () => {
  /* Reference data, like the seven types themselves. A production database is
     migrated and never seeded, and a leave system whose annual leave is worth
     nothing is one where every balance is zero. */
  it('are on a migrated database, effective from the go live year', async () => {
    const { rows } = await admin.query<{ code: string; days: number; from: string }>(
      `SELECT t.code, r.entitlement_days AS days, r.effective_from::text AS from
         FROM leave_entitlement_rule r JOIN leave_type t ON t.id = r.leave_type_id
        ORDER BY t.display_order`,
    );

    expect(rows).toEqual([
      { code: 'ANNUAL', days: 20, from: GO_LIVE },
      { code: 'SICK', days: 3, from: GO_LIVE },
      { code: 'UNPAID', days: 10, from: GO_LIVE },
      { code: 'COMPASSIONATE', days: 5, from: GO_LIVE },
      { code: 'MATERNITY', days: 120, from: GO_LIVE },
      { code: 'PATERNITY', days: 14, from: GO_LIVE },
      { code: 'MAT_EXT_UNPAID', days: 30, from: GO_LIVE },
    ]);
  });

  /**
   * The two figures LMS 203 left for HR, and LMS 401 settled.
   *
   * This test used to assert their **absence** — "no rule at all is the honest answer for
   * both, and it is a different answer from zero" — because FR 32h was read as agreed
   * occasion by occasion and the extension's "further month" was a figure the table did
   * not give in days. Neither is unsettled any more: unpaid leave is ten working days a
   * year, and a month is thirty calendar days, which is paid maternity's own convention of
   * a hundred and twenty days as four months.
   *
   * So this asserts the figures rather than the gap. The distinction the old test was
   * really about — **no rule is not a rule of zero**, which is why `resolve()` "returns
   * `undefined` rather than throwing so that every caller has to notice the difference" —
   * is unchanged and is still asserted, by "has no answer for a day before the system held
   * any figure" below. What the two unpaid types no longer are is its standing example.
   */
  it('give unpaid leave a yearly figure and the maternity extension a monthly one', async () => {
    const adwoa = await person(people.officer);

    expect(await daysFor('UNPAID', adwoa)).toBe(10);
    expect(await daysFor('MAT_EXT_UNPAID', adwoa)).toBe(30);
  });

  it('are company wide, so they are policy rather than one person arrangements', async () => {
    const { rows } = await admin.query<{ scoped: number }>(
      `SELECT count(*)::int AS scoped FROM leave_entitlement_rule
        WHERE employee_id IS NOT NULL OR department_id IS NOT NULL`,
    );

    expect(rows[0].scoped).toBe(0);
  });

  it('carry annual leave over and nothing else, which is what the rollover reads', async () => {
    const { rows } = await admin.query<{ code: string }>(
      `SELECT t.code FROM leave_entitlement_rule r JOIN leave_type t ON t.id = r.leave_type_id
        WHERE r.carries_over ORDER BY t.code`,
    );

    expect(rows.map((row) => row.code)).toEqual(['ANNUAL']);
  });

  it('pro rate annual leave for a joiner and nothing else', async () => {
    const { rows } = await admin.query<{ code: string }>(
      `SELECT t.code FROM leave_entitlement_rule r JOIN leave_type t ON t.id = r.leave_type_id
        WHERE r.prorate_on_join ORDER BY t.code`,
    );

    expect(rows.map((row) => row.code)).toEqual(['ANNUAL']);
  });

  /* FR 36a: carry over is uncapped and does not expire. Both columns unset is how
     that is said, and asserting it keeps it a decision rather than an oversight. */
  it('cap nothing and expire nothing, because current policy does neither', async () => {
    const { rows } = await admin.query<{ capped: number }>(
      `SELECT count(*)::int AS capped FROM leave_entitlement_rule
        WHERE carryover_max_days IS NOT NULL OR carryover_expiry_month IS NOT NULL`,
    );

    expect(rows[0].capped).toBe(0);
  });

  /* The trap this beat: a rule may name an employee, so the table has a foreign
     key to one, and the fixture seed's TRUNCATE ... CASCADE empties every
     referencing table wholesale rather than the rows that point at what was
     cleared. Without the restore in seed.mjs every figure in every integration
     run would be missing, and only this assertion would say so. */
  it('are still there after the fixture organisation is reloaded', async () => {
    await seed(admin);

    const adwoa = await person(people.officer);
    expect(await daysFor('ANNUAL', adwoa)).toBe(20);
  });
});

describe('what somebody is entitled to, on a day', () => {
  it('is the company figure when nothing narrower applies', async () => {
    const adwoa = await person(people.officer);

    expect(await daysFor('ANNUAL', adwoa)).toBe(20);
    expect(await daysFor('SICK', adwoa)).toBe(3);
    expect(await daysFor('MATERNITY', adwoa)).toBe(120);
  });

  it('is the department figure where the department has one', async () => {
    const adwoa = await person(people.officer);

    await rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      departmentId: adwoa.departmentId,
      entitlementDays: 22,
      effectiveFrom: LAST_YEAR,
      note: 'Operations, by agreement.',
    });

    expect(await daysFor('ANNUAL', adwoa)).toBe(22);
  });

  it('is the personal figure where there is one, over both of the others', async () => {
    const adwoa = await person(people.officer);

    await rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      departmentId: adwoa.departmentId,
      entitlementDays: 22,
      effectiveFrom: LAST_YEAR,
    });
    await rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      employeeId: adwoa.id,
      entitlementDays: 25,
      effectiveFrom: LAST_YEAR,
      note: 'Contract, clause 14.',
    });

    expect(await daysFor('ANNUAL', adwoa)).toBe(25);
  });

  it('leaves a colleague in another team on the company figure', async () => {
    const adwoa = await person(people.officer);
    const ama = await person(people.headOfHr);

    await rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      departmentId: adwoa.departmentId,
      entitlementDays: 22,
      effectiveFrom: LAST_YEAR,
    });

    expect(await daysFor('ANNUAL', adwoa)).toBe(22);
    expect(await daysFor('ANNUAL', ama)).toBe(20);
  });

  /* The story, against a real table: the figure rises next year and the day
     before it rises is untouched. Nothing had to be closed off for that. */
  it('answers a day before a rise with the figure that was in force then', async () => {
    const adwoa = await person(people.officer);
    const annual = await typeIdFor('ANNUAL');

    await rules.create(system, {
      leaveTypeId: annual,
      entitlementDays: 22,
      effectiveFrom: NEXT_YEAR,
    });

    expect(await daysFor('ANNUAL', adwoa, TODAY)).toBe(20);
    expect(await daysFor('ANNUAL', adwoa, NEXT_YEAR)).toBe(22);
    expect(await daysFor('ANNUAL', adwoa, GO_LIVE)).toBe(20);
  });

  it('has no answer for a day before the system held any figure', async () => {
    const adwoa = await person(people.officer);

    expect(await daysFor('ANNUAL', adwoa, '2025-12-31')).toBeUndefined();
  });

  it('shows the chain a figure came from, best first', async () => {
    const adwoa = await person(people.officer);
    const annual = await typeIdFor('ANNUAL');

    await rules.create(system, {
      leaveTypeId: annual,
      employeeId: adwoa.id,
      entitlementDays: 25,
      effectiveFrom: LAST_YEAR,
    });

    const chain = await rules.rulesInForceOn(system, adwoa, annual, TODAY);

    expect(chain.map((rule) => rule.entitlementDays)).toEqual([25, 20]);
  });
});

describe('the resolution rule is implemented once', () => {
  /* The repository's job is to fetch what could apply, not to choose. A rule that
     covers no day near today still comes back, which is the observable difference
     between "the query narrows" and "the domain decides". */
  it('hands back candidates the day filter would have removed', async () => {
    const adwoa = await person(people.officer);
    const annual = await typeIdFor('ANNUAL');

    await rules.create(system, {
      leaveTypeId: annual,
      entitlementDays: 99,
      effectiveFrom: NEXT_YEAR,
    });

    const candidates = await new EntitlementRuleRepository(db).candidatesFor({
      leaveTypeId: annual,
      employeeId: adwoa.id,
      departmentId: adwoa.departmentId,
    });

    expect(candidates.map((rule) => rule.entitlementDays).sort()).toEqual([20, 99]);
    expect(await daysFor('ANNUAL', adwoa)).toBe(20);
  });

  it('leaves no view in the database to decide it a second time', async () => {
    const { rows } = await admin.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.views
        WHERE table_schema = 'public' AND table_name LIKE '%entitlement%'`,
    );

    expect(rows).toEqual([]);
  });
});

describe('a rule that has taken effect is history', () => {
  async function anAppliedRule(): Promise<EntitlementRule> {
    return rules.create(system, {
      leaveTypeId: await typeIdFor('COMPASSIONATE'),
      entitlementDays: 5,
      effectiveFrom: LAST_YEAR,
    });
  }

  it('refuses a correction, and says to add a later rule instead', async () => {
    const applied = await anAppliedRule();

    await expect(rules.correct(system, applied.id, { entitlementDays: 6 })).rejects.toBeInstanceOf(
      EntitlementRuleAlreadyApplies,
    );
    await expect(rules.correct(system, applied.id, { entitlementDays: 6 })).rejects.toThrow(
      /later date/,
    );
  });

  it('refuses to be withdrawn', async () => {
    const applied = await anAppliedRule();

    await expect(rules.withdraw(system, applied.id)).rejects.toBeInstanceOf(
      EntitlementRuleAlreadyApplies,
    );
  });

  /* The half that matters most, because the service is not the only writer. A
     correction typed at a psql prompt at half past six is exactly how last year
     gets rewritten, and the trigger is what makes that impossible rather than
     unlikely. */
  it('refuses the same change written straight to the table by the owner', async () => {
    const applied = await anAppliedRule();

    await expect(
      admin.query('UPDATE leave_entitlement_rule SET entitlement_days = 6 WHERE id = $1', [
        applied.id,
      ]),
    ).rejects.toThrow(/cannot be changed/);

    await expect(
      admin.query('DELETE FROM leave_entitlement_rule WHERE id = $1', [applied.id]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('lets its note be improved, because explaining a figure does not change it', async () => {
    const applied = await anAppliedRule();

    await admin.query('UPDATE leave_entitlement_rule SET note = $2 WHERE id = $1', [
      applied.id,
      'Board minute 4, March.',
    ]);

    const { rows } = await admin.query<{ note: string }>(
      'SELECT note FROM leave_entitlement_rule WHERE id = $1',
      [applied.id],
    );

    expect(rows[0].note).toBe('Board minute 4, March.');
  });

  it('may be ended today or later, which is how a standing policy stops', async () => {
    const applied = await anAppliedRule();

    await admin.query('UPDATE leave_entitlement_rule SET effective_to = $2 WHERE id = $1', [
      applied.id,
      NEXT_YEAR,
    ]);

    const { rows } = await admin.query<{ to: string }>(
      'SELECT effective_to::text AS to FROM leave_entitlement_rule WHERE id = $1',
      [applied.id],
    );

    expect(rows[0].to).toBe(NEXT_YEAR);
  });

  /* Ending a rule and ending it retroactively look symmetrical and are not. Every
     day between the new end and today has already been counted against this
     figure, so closing it in the past is the same silent rewrite by another
     route. */
  it('may not be ended in the past', async () => {
    const applied = await anAppliedRule();

    await expect(
      admin.query('UPDATE leave_entitlement_rule SET effective_to = $2 WHERE id = $1', [
        applied.id,
        LAST_YEAR,
      ]),
    ).rejects.toThrow(/in the past/);
  });
});

describe('a rule that has not started yet is a draft', () => {
  async function aDraft(): Promise<EntitlementRule> {
    return rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      entitlementDays: 22,
      effectiveFrom: NEXT_YEAR,
      note: 'Board decision, pending.',
    });
  }

  it('may be corrected, because nothing has been calculated from it', async () => {
    const draft = await aDraft();

    const corrected = await rules.correct(system, draft.id, { entitlementDays: 25 });

    expect(corrected.entitlementDays).toBe(25);
    expect(corrected.id).toBe(draft.id);
  });

  it('may be withdrawn outright, which a leave type may never be', async () => {
    const draft = await aDraft();

    await rules.withdraw(system, draft.id);

    await expect(rules.byId(system, draft.id)).rejects.toBeInstanceOf(EntitlementRuleNotFound);
  });

  it('does not change what anybody is entitled to until it starts', async () => {
    const adwoa = await person(people.officer);
    await aDraft();

    expect(await daysFor('ANNUAL', adwoa, TODAY)).toBe(20);
    expect(await daysFor('ANNUAL', adwoa, NEXT_YEAR)).toBe(22);
  });
});

describe('the rules the database holds as well as the domain', () => {
  it('refuses a second rule for the same scope on the same day', async () => {
    const annual = await typeIdFor('ANNUAL');

    await expect(
      rules.create(system, {
        leaveTypeId: annual,
        entitlementDays: 30,
        effectiveFrom: GO_LIVE,
      }),
    ).rejects.toBeInstanceOf(DuplicateEntitlementRule);
  });

  /* The company-wide scope is the one where two NULLs would not be equal under
     the default rule, so it would have been the one scope with no uniqueness at
     all. NULLS NOT DISTINCT is what closes it, and this is what would fail. */
  it('refuses it for the company wide scope too, where both scope columns are null', async () => {
    const { rows } = await admin.query<{ nulls: string }>(
      `SELECT indnullsnotdistinct::text AS nulls FROM pg_index
        WHERE indexrelid = 'leave_entitlement_rule_one_per_scope_and_day'::regclass`,
    );

    expect(rows[0].nulls).toBe('true');
  });

  it('refuses a rule naming a leave type that is not there', async () => {
    await expect(
      rules.create(system, {
        leaveTypeId: '999999',
        entitlementDays: 20,
        effectiveFrom: NEXT_YEAR,
      }),
    ).rejects.toBeInstanceOf(InvalidEntitlementRule);
  });

  it('refuses a row written outside the domain that breaks a cross field rule', async () => {
    const annual = await typeIdFor('ANNUAL');

    await expect(
      admin.query(
        `INSERT INTO leave_entitlement_rule
           (leave_type_id, entitlement_days, carries_over, carryover_max_days, effective_from)
         VALUES ($1, 20, FALSE, 5, $2)`,
        [annual, NEXT_YEAR],
      ),
    ).rejects.toThrow(/carryover_agrees/);
  });

  it('refuses to let a leave type with figures against it be deleted', async () => {
    const annual = await typeIdFor('ANNUAL');

    await expect(admin.query('DELETE FROM leave_type WHERE id = $1', [annual])).rejects.toThrow(
      /leave_entitlement_rule/,
    );
  });
});

describe('a closed leave year, LMS 205', () => {
  /* The boundary is the one rule no constraint on this table can hold, because a
     closed year is a row in another one. A service built with a fixed answer is
     how the rule itself is proved; that the answer now comes from `leave_year` is
     the block below. */
  const closedUntil: EarliestOpenDay = async () => NEXT_YEAR;

  it('refuses a rule dated back into it', async () => {
    const strict = ruleServiceWith(closedUntil);

    await expect(
      strict.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: TODAY,
      }),
    ).rejects.toBeInstanceOf(ReachesIntoAClosedYear);
  });

  it('accepts one from the first open day', async () => {
    const strict = ruleServiceWith(closedUntil);

    await expect(
      strict.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: NEXT_YEAR,
      }),
    ).resolves.toMatchObject({ entitlementDays: 6 });
  });

  it('accepts anything at all while no year has been closed', async () => {
    await expect(
      rules.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: '2019-01-01',
      }),
    ).resolves.toMatchObject({ effectiveFrom: '2019-01-01' });
  });
});

/**
 * The seam this story left, joined from the side that reads it. LMS 205.
 *
 * This file used to say that swapping {@link NOTHING_IS_CLOSED_YET} for the real
 * reader was all LMS 205 had to do here, and this is that swap being taken at its
 * word: a service built with {@link earliestOpenDayFrom} rather than with a fixed
 * answer, refusing a figure dated into a year an administrator actually closed.
 *
 * The years themselves are put back afterwards, because closing one is
 * irreversible by design and every other test in this file expects an open 2026.
 */
describe('the boundary read from the leave years themselves', () => {
  /**
   * A rule service whose boundary is read from `leave_year`, built when a test
   * runs rather than when the file is collected — `db` is opened in beforeAll,
   * and a repository built out here would hold an undefined connection.
   */
  function ruleServiceReadingTheYears(): EntitlementRuleService {
    return ruleServiceWith(earliestOpenDayFrom(new LeaveYearRepository(db)));
  }

  /** A year that has ended, so that closing it is a legal thing to do. */
  async function closeAFinishedYear(): Promise<void> {
    await admin.query(
      `INSERT INTO leave_year (label, start_date, end_date)
       VALUES ('2025', '2025-01-01', '2025-12-31')`,
    );
    await admin.query(`UPDATE leave_year SET is_closed = TRUE WHERE label = '2025'`);
  }

  /* CASCADE since LMS 210: a leave year is now the heading a run of ledger entries
     is filed under, and Postgres will not truncate a referenced table without being
     told what to do about the rows pointing at it. */
  afterEach(async () => {
    await admin.query(`TRUNCATE leave_year CASCADE`);
    await admin.query('SELECT ensure_the_first_leave_years()');
  });

  /* Which is the state a database goes live in, and the reason it has to be
     allowed: on the first morning the whole of 2026 is open, nothing has been
     settled, and entering the current policy from a date already past is exactly
     what HR has to be able to do. */
  it('lets a figure be dated into the past while every year is open', async () => {
    const live = ruleServiceReadingTheYears();

    await expect(
      live.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: '2025-06-01',
      }),
    ).resolves.toMatchObject({ effectiveFrom: '2025-06-01' });
  });

  /* The whole story of LMS 205 in one assertion: an administrator closes 2025,
     and a figure dated into it is refused — by a rule that read a row rather
     than an argument somebody passed in. */
  it('refuses a figure dated into a year somebody has closed', async () => {
    const live = ruleServiceReadingTheYears();

    await closeAFinishedYear();

    await expect(
      live.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: '2025-06-01',
      }),
    ).rejects.toBeInstanceOf(ReachesIntoAClosedYear);
  });

  /* And the first open day is the day after the closed year ends. The statutory
     figures already occupy the first of January 2026 for every type, so this is
     dated a day later — which is the boundary being open rather than the whole
     year being open, and is the sharper assertion of the two. */
  it('accepts a figure from the day after the closed year ends', async () => {
    const live = ruleServiceReadingTheYears();

    await closeAFinishedYear();

    await expect(
      live.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: '2026-01-02',
      }),
    ).resolves.toMatchObject({ effectiveFrom: '2026-01-02' });
  });

  /* Read fresh on every write, which is why the type is a function rather than a
     date: the same service that accepted a figure a moment ago refuses it once a
     year has been closed underneath it, with nothing rebuilt in between. */
  it('moves under a service that is already running', async () => {
    const live = ruleServiceReadingTheYears();

    await expect(
      live.create(system, {
        leaveTypeId: await typeIdFor('SICK'),
        entitlementDays: 4,
        effectiveFrom: '2025-06-01',
      }),
    ).resolves.toMatchObject({ effectiveFrom: '2025-06-01' });

    await closeAFinishedYear();

    await expect(
      live.create(system, {
        leaveTypeId: await typeIdFor('COMPASSIONATE'),
        entitlementDays: 6,
        effectiveFrom: '2025-06-01',
      }),
    ).rejects.toBeInstanceOf(ReachesIntoAClosedYear);
  });
});

describe('who may see and set a figure, LMS 112', () => {
  const asEmployee = (id: string) => signedInAs(id, { roles: ['EMPLOYEE'], isManager: false });

  it('is set by an HR Administrator', async () => {
    const ama = signedInAs(people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_ADMIN'],
      isManager: false,
    });

    await expect(
      rules.create(ama, {
        leaveTypeId: await typeIdFor('ANNUAL'),
        entitlementDays: 22,
        effectiveFrom: NEXT_YEAR,
      }),
    ).resolves.toMatchObject({ entitlementDays: 22 });
  });

  it('is not for an HR Officer to set, though almost everything else is', async () => {
    const efua = signedInAs(people.hrOfficer, {
      roles: ['EMPLOYEE', 'HR_OFFICER'],
      isManager: false,
    });

    await expect(
      rules.create(efua, {
        leaveTypeId: await typeIdFor('ANNUAL'),
        entitlementDays: 40,
        effectiveFrom: NEXT_YEAR,
      }),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('lets anybody read a company figure, because it is what people plan against', async () => {
    const adwoa = await person(people.officer);
    const company = await rules.create(system, {
      leaveTypeId: await typeIdFor('COMPASSIONATE'),
      entitlementDays: 6,
      effectiveFrom: NEXT_YEAR,
    });

    await expect(rules.byId(asEmployee(adwoa.id), company.id)).resolves.toMatchObject({
      entitlementDays: 6,
    });
  });

  /* A rule naming a person is that person's terms, and being told "you may not
     read rule 41" is being told rule 41 is somebody's. */
  it('keeps a personal arrangement from a colleague', async () => {
    const adwoa = await person(people.officer);
    const abena = await person(people.partTimer);

    const hers = await rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      employeeId: abena.id,
      entitlementDays: 25,
      effectiveFrom: NEXT_YEAR,
    });

    await expect(rules.byId(asEmployee(adwoa.id), hers.id)).rejects.toBeInstanceOf(NotAuthorised);
    await expect(rules.byId(asEmployee(abena.id), hers.id)).resolves.toMatchObject({
      entitlementDays: 25,
    });
  });

  it('gives the same answer for a rule that is not there as for one that is not theirs', async () => {
    const adwoa = await person(people.officer);

    await expect(rules.byId(asEmployee(adwoa.id), '999999')).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('lets somebody ask what they themselves are entitled to', async () => {
    const adwoa = await person(people.officer);

    await expect(
      rules.entitlementOn(asEmployee(adwoa.id), adwoa, await typeIdFor('ANNUAL'), TODAY),
    ).resolves.toMatchObject({ entitlementDays: 20 });
  });

  /* A manager approves their report's leave, and approving it without being able
     to see what they are entitled to is deciding blind. Direct reports only. */
  it('lets a manager ask what one of their reports is entitled to', async () => {
    const adwoa = await person(people.officer);
    const kofi = signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });

    await expect(
      rules.entitlementOn(kofi, adwoa, await typeIdFor('ANNUAL'), TODAY),
    ).resolves.toMatchObject({ entitlementDays: 20 });
  });

  it('refuses a colleague who is neither', async () => {
    const adwoa = await person(people.officer);
    const abena = await person(people.partTimer);

    await expect(
      rules.entitlementOn(asEmployee(abena.id), adwoa, await typeIdFor('ANNUAL'), TODAY),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('keeps the whole list back, because a list of exceptions names who has one', async () => {
    const adwoa = await person(people.officer);

    await expect(rules.list(asEmployee(adwoa.id))).rejects.toBeInstanceOf(NotAuthorised);
    await expect(
      rules.list(
        signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false }),
      ),
      /* One company-wide figure per leave type, which since LMS 401 is all seven of them
         rather than the five LMS 203 shipped. */
    ).resolves.toHaveLength(7);
  });
});

describe('every change is in the audit log, NFR AUD 01', () => {
  async function entriesFor(id: string) {
    const { rows } = await admin.query<{
      action: string;
      actor: string;
      after: Record<string, unknown> | null;
    }>(
      `SELECT action, actor, after FROM audit_log
        WHERE entity = 'leave_entitlement_rule' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [id],
    );

    return rows;
  }

  it('names the administrator who raised a figure, and what they set it to', async () => {
    const ama = signedInAs(people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_ADMIN'],
      isManager: false,
    });

    const raised = await rules.create(ama, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      entitlementDays: 22,
      effectiveFrom: NEXT_YEAR,
    });

    const entries = await entriesFor(raised.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('CREATE');
    expect(entries[0].actor).toContain(people.headOfHr);
    expect(entries[0].after?.entitlement_days).toBe(22);
  });

  it('records a draft being withdrawn as the deletion it is', async () => {
    const draft = await rules.create(system, {
      leaveTypeId: await typeIdFor('ANNUAL'),
      entitlementDays: 22,
      effectiveFrom: NEXT_YEAR,
    });

    await rules.withdraw(system, draft.id);

    expect((await entriesFor(draft.id)).map((entry) => entry.action)).toEqual(['CREATE', 'DELETE']);
  });

  it('names the function the statutory figures come from rather than nobody', async () => {
    const { rows } = await admin.query<{ actor: string }>(
      `SELECT DISTINCT actor FROM audit_log WHERE entity = 'leave_entitlement_rule'
         AND action = 'CREATE'`,
    );

    expect(rows.map((row) => row.actor)).toContain('ensure_statutory_entitlement_rules()');
  });
});

describe('the privileges this table has and leave_type does not', () => {
  /* A leave type has no state in which deleting it is harmless. A rule that has
     not taken effect has produced nothing and heads nothing, so the delete is
     granted — and the trigger is what keeps it to drafts. */
  it('lets the application update and delete, unlike a leave type', async () => {
    const { rows } = await admin.query<Record<string, boolean>>(
      `SELECT has_table_privilege('lms_app', 'leave_entitlement_rule', 'UPDATE') AS rule_upd,
              has_table_privilege('lms_app', 'leave_entitlement_rule', 'DELETE') AS rule_del,
              has_table_privilege('lms_app', 'leave_type', 'DELETE') AS type_del`,
    );

    expect(rows[0]).toEqual({ rule_upd: true, rule_del: true, type_del: false });
  });

  it('keeps restoring the statutory figures to the owner', async () => {
    const { rows } = await admin.query<{ may: boolean }>(
      `SELECT has_function_privilege('lms_app', 'ensure_statutory_entitlement_rules()', 'EXECUTE')
              AS may`,
    );

    expect(rows[0].may).toBe(false);
  });
});
