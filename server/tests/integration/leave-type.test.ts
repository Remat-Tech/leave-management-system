import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { Employee } from '../../src/features/employee/employee.js';
import {
  balanceMayBeExceededWithDocument,
  countsWorkingDays,
  DuplicateLeaveTypeCode,
  DuplicateLeaveTypeName,
  grantExpires,
  hasRunningBalance,
  InvalidLeaveType,
  type LeaveType,
  LeaveTypeNotFound,
  LeaveTypeRetired,
  NotEligibleForLeaveType,
  noticeShortfall,
} from '../../src/features/leave-type/leave-type.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { EmployeeService } from '../../src/features/employee/employee.service.js';
import { LeaveTypeService } from '../../src/features/leave-type/leave-type.service.js';
import { seed } from '../../seeds/seed.mjs';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';

/**
 * Leave types against a real database. FR 21, FR 31, FR 32, §5.5. LMS 201.
 *
 * The unit suite covers what a rule means and which pairs of fields may not
 * disagree; ../unit/leave-type.test.ts is where the story is proved. What needs a
 * database is the half the database itself decides, and there is more of it here
 * than for any other configuration table:
 *
 *   The statutory set the migration inserts is really there, and really has the
 *   shape it claims. A production database is migrated and never seeded, so this
 *   is the only thing standing between an installation and a leave system with no
 *   leave types in it.
 *
 *   The four cross field rules are held as constraints and not only in the
 *   domain, so a row written from a psql prompt is refused the same way one
 *   written through the service is.
 *
 *   The application role can never delete one, which is what makes "retired
 *   rather than deleted" true for every writer rather than for the ones who read
 *   the service.
 *
 *   Every change is one audit entry naming the administrator who made it, which
 *   is what a disputed balance is settled against.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

const DOMAINS = ['rematholdings.com'];

/**
 * The actor these fixtures are built by, and the guard the services are given.
 *
 * {@link theSystem} rather than a person, for the reason every integration suite
 * uses it: it holds every role and is nobody, so no policy refuses it. Whether
 * the policies refuse the right people is ../unit/policy.test.ts; what is
 * asserted here is that the service asks.
 */
const system = theSystem('leave type integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let types: LeaveTypeService;
let employees: EmployeeService;
let people: Record<string, string>;

/**
 * The table as the migration left it, read once before anything has touched it.
 *
 * A snapshot rather than a list written out here, and that is the point. These
 * rows are reference data owned by the leave-type-rules migration, so restating
 * them in the test would mean the suite asserting its own copy — and the first
 * assertion below, that a migrated database really has them, would be asserting
 * nothing at all.
 */
let statutory: Record<string, unknown>[];

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  types = new LeaveTypeService(new LeaveTypeRepository(db), guard);
  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    { domains: DOMAINS },
  );

  const { rows } = await admin.query('SELECT * FROM leave_type ORDER BY id');
  statutory = rows as Record<string, unknown>[];
});

beforeEach(async () => {
  /* Put the table back before the seed rather than after it, so that the writes
     this does are cleared along with everything else — the seed truncates
     audit_log, and an entry from the restoration would be indistinguishable from
     one a test provoked. */
  await restoreTheStatutorySet();

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  /* Left as the migrations left it, which matters since LMS 204 because this is
     no longer the only file that snapshots this table in beforeAll. A type
     created here and not cleared would be part of ./approval-chain.test.ts's idea
     of the statutory set when it runs second — a failure that depends on the
     order the files happened to run in, which is the worst kind to debug. */
  await restoreTheStatutorySet();

  await db?.destroy();
  await admin?.end();
});

/**
 * The table as the migration left it, exactly.
 *
 * Emptied and rewritten from the snapshot rather than patched back field by
 * field: a test that moves a notice window has to leave no trace, and "undo
 * whichever columns I remembered" is how a suite acquires a dependency on the
 * order its own tests run in. The ids come back with the rows, because the audit
 * log files its entries under them.
 */
async function restoreTheStatutorySet(): Promise<void> {
  /* updated_at is maintained by the trigger and refuses to be supplied. */
  const columns = Object.keys(statutory[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  /* Since LMS 203 the entitlement figures point at these rows, and the key has no
     cascade — which is the guarantee that table gives leave_type, so they have to
     go first. TRUNCATE rather than DELETE, for the same reason the fixture seed
     truncates the audit log: a rule that has taken effect refuses to be deleted by
     anybody, which is FR 31 working, and emptying a table on purpose on the owner
     connection is not the thing that refusal exists to prevent. The figures are
     put back at the foot of this function by the function that owns them, so no
     figure in this suite comes from a copy written here. */
  await admin.query('TRUNCATE leave_entitlement_rule RESTART IDENTITY');
  await admin.query('DELETE FROM leave_type');

  for (const row of statutory) {
    await admin.query(
      `INSERT INTO leave_type (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('leave_type_id_seq', (SELECT max(id) FROM leave_type))`);
  await admin.query('SELECT ensure_statutory_entitlement_rules()');

  /* And the approval chains, which the DELETE above took with the types — the
     steps cascade, because a step is part of a type rather than a record about
     one. LMS 204. Put back by the function that owns them for the same reason the
     figures are: nothing in this file knows who approves unpaid leave, and
     nothing here should. Leaving them out would hand every other suite a database
     full of types nobody can approve leave against. */
  await admin.query('SELECT ensure_statutory_approval_chains()');
}

async function byCode(code: string): Promise<LeaveType> {
  const found = await types.byCode(system, code);
  expect(found, `no leave type with the code ${code}`).toBeDefined();
  return found!;
}

/** A whole employee record, which is what eligibility is decided against. */
async function person(id: string): Promise<Employee> {
  return employees.byId(system, id);
}

describe('the seven types of FR 32', () => {
  /* A production database is migrated and never seeded. Reference data, like the
     standard Monday to Friday week and unlike the fixture organisation, and for
     the same reason: a leave system with no leave types is one where nobody can
     request anything at all. */
  it('are all there on a database nothing has seeded, in the order a form shows them', async () => {
    expect((await types.list(system)).map((type) => type.code)).toEqual([
      'ANNUAL',
      'SICK',
      'UNPAID',
      'COMPASSIONATE',
      'MATERNITY',
      'PATERNITY',
      'MAT_EXT_UNPAID',
    ]);
  });

  /* FR 22, read off the rows rather than off a constant: annual, sick and
     compassionate count working days; maternity and paternity count calendar
     days. The story's first criterion is the fact that this is a column at all. */
  it('count each type on the basis §4.3.1 gives it', async () => {
    const basis = new Map(
      (await types.list(system)).map((type) => [type.code, countsWorkingDays(type)]),
    );

    expect(basis.get('ANNUAL')).toBe(true);
    expect(basis.get('SICK')).toBe(true);
    expect(basis.get('COMPASSIONATE')).toBe(true);
    expect(basis.get('MATERNITY')).toBe(false);
    expect(basis.get('PATERNITY')).toBe(false);
  });

  /**
   * FR 32g. Annual, sick and unpaid are annual allowances that reset; everything else is
   * granted per qualifying occurrence.
   *
   * Unpaid leave was on the other side of this line until LMS 401. FR 32g listed it with
   * the event types on the reading that it is "agreed occasion by occasion rather than
   * accrued" — and the business settled it as ten working days *for the year*, which is an
   * allowance that resets whatever it is called. The classification moved with the figure,
   * because it had to: `AnnualGrant` only ever loops over types this predicate is true of,
   * so an entitlement rule against an event type is a figure nothing would grant.
   */
  it('give a quota to annual, sick and unpaid leave and to nothing else', async () => {
    const quota = (await types.list(system)).filter(hasRunningBalance).map((type) => type.code);

    expect(quota).toEqual(['ANNUAL', 'SICK', 'UNPAID']);
  });

  /* FR 32a, and the distinction this story is easiest to get wrong. Sick leave's
     allowance is a documentation threshold rather than a cap, and the threshold
     is the yearly balance rather than the length of the request — so the flag
     that carries it is exceedable_with_document, not the documentation rule. */
  it('make sick leave exceedable with a certificate, and nothing else', async () => {
    const exceedable = (await types.list(system))
      .filter(balanceMayBeExceededWithDocument)
      .map((type) => type.code);

    expect(exceedable).toEqual(['SICK']);
    expect((await byCode('SICK')).documentation).toBe('NOT_REQUIRED');
  });

  /* FR 13. Maternity and the unpaid extension are the types that always want a
     document; nothing shipped uses the length-of-request threshold. */
  it('ask for a document on the two types that always need one', async () => {
    const always = (await types.list(system))
      .filter((type) => type.documentation === 'ALWAYS')
      .map((type) => type.code);

    expect(always).toEqual(['MATERNITY', 'MAT_EXT_UNPAID']);
  });

  /* FR 32e. Fourteen calendar days per birth, usable within six months. The one
     type that has an expiry, and the reason the column is not about carry over. */
  it('lapse a paternity grant after six months and nothing else after anything', async () => {
    const expiring = (await types.list(system))
      .filter(grantExpires)
      .map((type) => [type.code, type.entitlementExpiryMonths]);

    expect(expiring).toEqual([['PATERNITY', 6]]);
  });

  /* FR 17. Annual leave alone carries a notice expectation, because "the event
     based types cannot be foreseen, and sick leave by its nature cannot be given
     notice at all". */
  it('expect notice for annual leave and for no other type', async () => {
    const withNotice = (await types.list(system))
      .filter((type) => type.minNoticeCalendarDays > 0)
      .map((type) => [type.code, type.minNoticeCalendarDays]);

    expect(withNotice).toEqual([['ANNUAL', 14]]);
  });

  /* FR 18. One week, on every type, because any type can be overtaken by events.
     Annual leave holds both windows at once, which an earlier draft of this
     story wrongly forbade. */
  it('let every type be recorded a week after the fact, annual leave included', async () => {
    for (const type of await types.list(system)) {
      expect(type.maxBackdateCalendarDays, `${type.name} cannot be backdated`).toBe(7);
    }

    const annual = await byCode('ANNUAL');
    expect(annual.minNoticeCalendarDays).toBe(14);
    expect(annual.maxBackdateCalendarDays).toBe(7);
    expect(noticeShortfall(annual, 3)).toBe(11);
  });

  /* FR 32h. The two unpaid types, which are also the two the approval chain of
     FR 38a sends to HR and the CEO — a rule that is not in this table. */
  it('mark the two unpaid types as unpaid and everything else as paid', async () => {
    const unpaid = (await types.list(system))
      .filter((type) => !type.isPaid)
      .map((type) => type.code);

    expect(unpaid).toEqual(['UNPAID', 'MAT_EXT_UNPAID']);
  });

  /* FR 05. Three restricted types, and the column that exists for them. */
  it('restrict only the three types that are restricted', async () => {
    const restricted = (await types.list(system))
      .filter((type) => type.genderRestriction !== null)
      .map((type) => [type.code, type.genderRestriction]);

    expect(restricted).toEqual([
      ['MATERNITY', 'FEMALE'],
      ['PATERNITY', 'MALE'],
      ['MAT_EXT_UNPAID', 'FEMALE'],
    ]);
  });

  /* §8.6aa: the column exists "so that a future type which genuinely must be
     continuous, maternity being the obvious candidate, can say so". Nobody has
     thrown that switch, and asserting it keeps the decision deliberate. */
  it('leave every type splittable, maternity included, as the TDD seeds them', async () => {
    for (const type of await types.list(system)) {
      expect(type.mayBeSplit, `${type.name} may not be split`).toBe(true);
    }
  });

  /* FR 33. A column whose only permitted value is false, so the requirement is a
     constraint rather than the TDD's comment. */
  it('let nothing deduct from annual leave', async () => {
    for (const type of await types.list(system)) {
      expect(type.deductsFromAnnual, `${type.name} deducts from annual leave`).toBe(false);
    }

    await expect(
      admin.query(`UPDATE leave_type SET deducts_from_annual = TRUE WHERE code = 'SICK'`),
    ).rejects.toThrow(/leave_type_never_deducts_from_annual/);
  });

  /* The figures are not here, and that is FR 31 rather than an omission: they
     have to be versioned with an effective date and must not alter closed leave
     years, which a column cannot do. */
  it('carry no entitlement figure at all', async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'leave_type'
          AND (column_name LIKE '%days_per%' OR column_name LIKE '%allowance%'
               OR column_name LIKE '%carryover%' OR column_name LIKE '%entitlement_days%')`,
    );

    expect(rows).toEqual([]);
  });
});

/**
 * The set as something that can be put back, rather than something that was put
 * there once. LMS 202.
 *
 * The insert in the leave-type-rules migration ran against a table created four
 * statements earlier and can never run again, so what it proves is that a
 * database migrated in order started out right. `ensure_statutory_leave_types()`
 * is the same seven rows as a thing with a name, and what has to be true of it is
 * mostly what it refuses to do: it puts back what is missing, it leaves every
 * edit HR has made exactly where it is, and it does not fall over on the one
 * database that has been used enough for somebody to have reworded a type.
 */
describe('putting the statutory set back, LMS 202', () => {
  /* Everything except the three columns that are about the row rather than about
     the rule. A repaired type is compared against the snapshot taken before any
     test ran — that is, against what the *other* copy of this reference data
     produced — so the two can never quietly disagree about what a leave type is. */
  const ABOUT_THE_ROW = new Set(['id', 'created_at', 'updated_at']);

  function theRuleItself(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([column]) => !ABOUT_THE_ROW.has(column)));
  }

  async function ensureTheStatutoryTypes(): Promise<number> {
    const { rows } = await admin.query<{ inserted: number }>(
      'SELECT ensure_statutory_leave_types() AS inserted',
    );

    return rows[0].inserted;
  }

  /* What losing a type looks like since LMS 203: the figures go first, because
     leave_entitlement_rule points at the type and the key has no cascade — the FK
     now doing the job the withheld DELETE privilege was standing in for. They are
     truncated rather than deleted because a rule that has taken effect refuses to
     be deleted at all; see restoreTheStatutorySet above. */
  async function loseTheType(code: string): Promise<void> {
    await admin.query('TRUNCATE leave_entitlement_rule RESTART IDENTITY');
    await admin.query('DELETE FROM leave_type WHERE code = $1', [code]);
  }

  async function leaveTypeEntries(): Promise<{ action: string; actor: string }[]> {
    const { rows } = await admin.query<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log WHERE entity = 'leave_type' ORDER BY occurred_at, id`,
    );

    return rows;
  }

  /* The state every already migrated database is in, and the state this file
     leaves a fresh one in a statement after it ran. Doing nothing has to be
     genuinely nothing: not a no-op insert, not an audit entry, not a bumped
     updated_at on a row somebody is about to read a notice window off. */
  it('does nothing at all where the seven are already there', async () => {
    const before = await admin.query('SELECT * FROM leave_type ORDER BY id');

    expect(await ensureTheStatutoryTypes()).toBe(0);

    const after = await admin.query('SELECT * FROM leave_type ORDER BY id');
    expect(after.rows).toEqual(before.rows);
    expect(await leaveTypeEntries()).toEqual([]);
  });

  /* The case the story exists for. lms_app cannot do this — it holds no DELETE
     on the table — but the owner can, a restore from an old backup amounts to
     the same thing, and the repair for either is otherwise an INSERT typed at a
     psql prompt. */
  it('puts back a type that has gone missing, in the shape §4.3.1 gives it', async () => {
    await loseTheType('COMPASSIONATE');

    expect(await ensureTheStatutoryTypes()).toBe(1);

    const { rows } = await admin.query(`SELECT * FROM leave_type WHERE code = 'COMPASSIONATE'`);
    const original = statutory.find((row) => row.code === 'COMPASSIONATE');

    expect(rows).toHaveLength(1);
    expect(theRuleItself(rows[0] as Record<string, unknown>)).toEqual(theRuleItself(original!));
  });

  it('offers it again in its own place in the list rather than at the end', async () => {
    await loseTheType('MATERNITY');
    await ensureTheStatutoryTypes();

    expect((await types.list(system)).map((type) => type.code)).toEqual([
      'ANNUAL',
      'SICK',
      'UNPAID',
      'COMPASSIONATE',
      'MATERNITY',
      'PATERNITY',
      'MAT_EXT_UNPAID',
    ]);
  });

  /* The reason the guard reads the code as well as the name, and the one failure
     that would have arrived only on a database somebody had been using. HR
     rewording 'Annual Leave' to 'Vacation' is the exact thing `code` exists to
     survive; a guard that asked only about the name would find it free, offer the
     row, and be refused by leave_type_code_unique. */
  it('leaves a type HR has reworded alone rather than adding a second under its code', async () => {
    await admin.query(`UPDATE leave_type SET name = 'Vacation' WHERE code = 'ANNUAL'`);

    expect(await ensureTheStatutoryTypes()).toBe(0);

    const { rows } = await admin.query<{ name: string }>(
      `SELECT name FROM leave_type WHERE upper(code) = 'ANNUAL'`,
    );

    expect(rows).toEqual([{ name: 'Vacation' }]);
  });

  /* It inserts and it never updates. Editing a type without waiting on a
     developer is the whole of FR 31, so reconciling the rows back to these values
     would take away the thing the table exists to give. */
  it('does not undo an edit an administrator made', async () => {
    const ama = signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: false });
    const annual = await byCode('ANNUAL');

    await types.update(ama, annual.id, { minNoticeCalendarDays: 21 });
    await types.retire(ama, (await byCode('UNPAID')).id);

    expect(await ensureTheStatutoryTypes()).toBe(0);

    expect((await byCode('ANNUAL')).minNoticeCalendarDays).toBe(21);
    expect((await byCode('UNPAID')).isActive).toBe(false);
  });

  /* NFR AUD 01. A leave type reappearing is a configuration change, and "not
     named by the writer" is a true but thin answer to where it came from. */
  it('names itself in the audit log as the writer of a type it put back', async () => {
    await loseTheType('UNPAID');
    await ensureTheStatutoryTypes();

    expect(await leaveTypeEntries()).toEqual([
      { action: 'DELETE', actor: 'not named by the writer' },
      { action: 'CREATE', actor: 'ensure_statutory_leave_types()' },
    ]);
  });

  /* And gives the name back when there was one. A caller who said who they were
     is not overwritten, and the setting is left exactly as it was found — this
     runs inside somebody else's transaction often enough for that to matter. */
  it('keeps the name of a caller who gave one, and puts the setting back', async () => {
    await admin.query(`SET lms.audit.actor = 'Ama Mensah, at a psql prompt'`);

    try {
      await loseTheType('PATERNITY');
      await ensureTheStatutoryTypes();

      expect((await leaveTypeEntries()).at(-1)).toEqual({
        action: 'CREATE',
        actor: 'Ama Mensah, at a psql prompt',
      });

      const { rows } = await admin.query<{ actor: string }>(
        `SELECT current_setting('lms.audit.actor', true) AS actor`,
      );
      expect(rows[0].actor).toBe('Ama Mensah, at a psql prompt');
    } finally {
      await admin.query(`RESET lms.audit.actor`);
    }
  });

  /* Restoring reference data is an operator's, done knowingly. lms_app holds
     INSERT on the table and could write these rows one at a time through the
     service, so this withholds no power it has elsewhere — it keeps seven rows
     from being one function call away from anybody who is merely connected. */
  it('belongs to the owner rather than to the application', async () => {
    const { rows } = await admin.query<{ may: boolean }>(
      `SELECT has_function_privilege('lms_app', 'ensure_statutory_leave_types()', 'EXECUTE') AS may`,
    );

    expect(rows[0].may).toBe(false);
  });
});

describe('adding a type, which is the story', () => {
  it('stores every rule and reads it back, offered from the moment it exists', async () => {
    /* Study leave is the type §5.5's own code comment lists and the seed does
       not create, so it is the honest test of the story: a type nobody wrote a
       migration for, with rules nothing in the tree has heard of. */
    const created = await types.create(system, {
      code: 'study',
      name: 'Study Leave',
      description: 'For an examination or a course agreed with your manager.',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      unit: 'DAYS',
      documentation: 'AFTER_DAYS',
      documentationAfterDays: 3,
      mayBeSplit: true,
      minNoticeCalendarDays: 30,
      displayOrder: 8,
    });

    expect(await types.byId(system, created.id)).toMatchObject({
      code: 'STUDY',
      name: 'Study Leave',
      description: 'For an examination or a course agreed with your manager.',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      isPaid: true,
      unit: 'DAYS',
      documentation: 'AFTER_DAYS',
      documentationAfterDays: 3,
      exceedableWithDocument: false,
      entitlementExpiryMonths: null,
      mayBeSplit: true,
      minNoticeCalendarDays: 30,
      maxBackdateCalendarDays: 7,
      genderRestriction: null,
      deductsFromAnnual: false,
      displayOrder: 8,
      isActive: true,
    });

    // And it is offered from the moment it exists, at the end of the list.
    expect((await types.list(system, { offeredOnly: true })).at(-1)?.code).toBe('STUDY');
  });

  it('refuses a second type with the same code, however it was typed', async () => {
    await expect(
      types.create(system, {
        code: 'annual',
        name: 'Vacation Days',
        countingBasis: 'WORKING_DAYS',
        entitlementBasis: 'QUOTA',
      }),
    ).rejects.toBeInstanceOf(DuplicateLeaveTypeCode);
  });

  it('refuses a second type with the same name, however it was cased', async () => {
    await expect(
      types.create(system, {
        code: 'ANNUAL_2',
        name: 'annual leave',
        countingBasis: 'WORKING_DAYS',
        entitlementBasis: 'QUOTA',
      }),
    ).rejects.toBeInstanceOf(DuplicateLeaveTypeName);
  });
});

describe('changing a type', () => {
  /* The story's own sentence: adding or changing a type never waits on a
     developer. Every one of these was a code change in the system this replaces. */
  it('moves a counting basis without touching a single employee record', async () => {
    const annual = await byCode('ANNUAL');

    const updated = await types.update(system, annual.id, { countingBasis: 'CALENDAR_DAYS' });

    expect(countsWorkingDays(updated)).toBe(false);
    expect(countsWorkingDays(await byCode('ANNUAL'))).toBe(false);
  });

  /* FR 17's number, which is the one HR is most likely to want to move: two
     weeks' notice becoming three is a row here and nothing else anywhere. */
  it('moves a notice window, and the shortfall a request is warned about moves with it', async () => {
    const annual = await byCode('ANNUAL');
    expect(noticeShortfall(annual, 14)).toBe(0);

    await types.update(system, annual.id, { minNoticeCalendarDays: 21 });

    expect(noticeShortfall(await byCode('ANNUAL'), 14)).toBe(7);
  });

  /* FR 32a as a checkbox: the day HR decides compassionate leave works the way
     sick leave does, this is the whole change. */
  it('makes another type exceedable with a document', async () => {
    const compassionate = await byCode('COMPASSIONATE');
    expect(balanceMayBeExceededWithDocument(compassionate)).toBe(false);

    await types.update(system, compassionate.id, { exceedableWithDocument: true });

    expect(balanceMayBeExceededWithDocument(await byCode('COMPASSIONATE'))).toBe(true);
  });

  it('touches nothing it was not asked to touch', async () => {
    const sick = await byCode('SICK');

    await types.update(system, sick.id, { name: 'Sickness Absence' });

    expect(await byCode('SICK')).toMatchObject({
      name: 'Sickness Absence',
      documentation: sick.documentation,
      exceedableWithDocument: sick.exceedableWithDocument,
      maxBackdateCalendarDays: sick.maxBackdateCalendarDays,
      displayOrder: sick.displayOrder,
    });
  });

  it('moves updated_at, which is the first question asked of a disputed rule', async () => {
    const annual = await byCode('ANNUAL');

    const updated = await types.update(system, annual.id, { minNoticeCalendarDays: 21 });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(annual.updatedAt.getTime());
  });

  it('reports an id that is nobody rather than silently doing nothing', async () => {
    await expect(types.update(system, '9999', { name: 'Nothing' })).rejects.toBeInstanceOf(
      LeaveTypeNotFound,
    );
  });
});

describe('the rules are held by the database as well as by the domain', () => {
  /**
   * Written straight to the table on the owner connection, going round the
   * domain entirely.
   *
   * That is the point of the exercise. The validation in ../../src/domain makes
   * the refusal name the field and say what to do; these constraints make the row
   * impossible for every writer, including a migration correcting data and
   * somebody at a psql prompt at nine on a Friday. A rule held in one place only
   * is a rule that holds while everybody remembers.
   */
  async function writeDirectly(overrides: Record<string, string>): Promise<void> {
    const columns: Record<string, string> = {
      code: `'TEST'`,
      name: `'Test Leave'`,
      counting_basis: `'WORKING_DAYS'`,
      entitlement_basis: `'QUOTA'`,
      ...overrides,
    };

    await admin.query(
      `INSERT INTO leave_type (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  }

  it('refuses a counting basis that is not one of the two', async () => {
    await expect(writeDirectly({ counting_basis: `'HOURS'` })).rejects.toThrow(
      /leave_type_counting_basis_known/,
    );
  });

  it('refuses a documentation threshold with no rule to read it', async () => {
    await expect(writeDirectly({ documentation_after_days: '2' })).rejects.toThrow(
      /leave_type_documentation_agrees/,
    );
  });

  it('refuses a documentation rule of AFTER_DAYS with no threshold', async () => {
    await expect(writeDirectly({ documentation: `'AFTER_DAYS'` })).rejects.toThrow(
      /leave_type_documentation_agrees/,
    );
  });

  it('refuses a unit that is not one of the three', async () => {
    await expect(writeDirectly({ unit: `'HOURS'` })).rejects.toThrow(/leave_type_unit_known/);
  });

  it('refuses a restriction naming something no employee record can hold', async () => {
    await expect(writeDirectly({ gender_restriction: `'OTHER'` })).rejects.toThrow(
      /leave_type_gender_known/,
    );
  });

  /* FR 33, held as a constraint rather than as the TDD's "must stay FALSE"
     comment, so that the configuration screen this story is about has nothing to
     tick. */
  it('refuses a type that deducts from annual leave', async () => {
    await expect(writeDirectly({ deducts_from_annual: 'TRUE' })).rejects.toThrow(
      /leave_type_never_deducts_from_annual/,
    );
  });

  /* Annual leave has both windows, so a constraint forbidding that would have
     made the one type everybody uses unconfigurable. An earlier draft of this
     story had one; FR 17 and FR 18 together are why it is gone. */
  it('permits a type that both expects notice and allows backdating', async () => {
    await expect(
      writeDirectly({ min_notice_calendar_days: '14', max_backdate_calendar_days: '7' }),
    ).resolves.toBeUndefined();
  });

  /* And the repository reports a refusal as the field it is about, rather than
     letting a driver error surface. */
  it('reports a refusal from outside the domain against the field it is about', async () => {
    const annual = await byCode('ANNUAL');

    /* The domain would have caught this; going through the repository with the
       cross field check bypassed is what a migration correcting data looks like. */
    const repository = new LeaveTypeRepository(db);

    await expect(
      repository.update(system, annual.id, { documentationAfterDays: 3 }),
    ).rejects.toBeInstanceOf(InvalidLeaveType);
  });
});

describe('a type is retired rather than deleted', () => {
  /* A type is the heading every request, ledger entry and report of either is
     filed under. Removing the row would rewrite history in the way FR 06 refuses
     for an employee — and there is no foreign key pointing here yet, which is
     exactly why the privilege has to close it now. */
  it('gives the application role no way to delete one', async () => {
    const { rows } = await admin.query<{ del: boolean; upd: boolean; ins: boolean }>(
      `SELECT has_table_privilege('lms_app', 'leave_type', 'DELETE') AS del,
              has_table_privilege('lms_app', 'leave_type', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'leave_type', 'INSERT') AS ins`,
    );

    expect(rows[0]).toEqual({ del: false, upd: true, ins: true });
  });

  it('takes it off what a form offers and leaves it readable', async () => {
    const unpaid = await byCode('UNPAID');

    await types.retire(system, unpaid.id);

    const offered = (await types.list(system, { offeredOnly: true })).map((type) => type.code);
    const everything = (await types.list(system)).map((type) => type.code);

    expect(offered).not.toContain('UNPAID');
    expect(everything).toContain('UNPAID');
    expect((await types.byId(system, unpaid.id)).isActive).toBe(false);
  });

  it('refuses new leave against it, and says so by name', async () => {
    const unpaid = await byCode('UNPAID');
    await types.retire(system, unpaid.id);

    await expect(
      types.requestable(system, unpaid.id, await person(people.officer)),
    ).rejects.toBeInstanceOf(LeaveTypeRetired);
  });

  it('can be brought back, which is the correction for retiring one by mistake', async () => {
    const unpaid = await byCode('UNPAID');

    await types.retire(system, unpaid.id);
    await types.reinstate(system, unpaid.id);

    expect((await byCode('UNPAID')).isActive).toBe(true);
  });

  it('is allowed twice and does nothing the second time', async () => {
    const unpaid = await byCode('UNPAID');

    await types.retire(system, unpaid.id);
    await expect(types.retire(system, unpaid.id)).resolves.toMatchObject({ isActive: false });
  });
});

describe('who a type is offered to, FR 05', () => {
  it('keeps a restricted type off the list for somebody it does not name', async () => {
    /* Kofi Boateng, the team lead, whose record says MALE. */
    const codes = (await types.offeredTo(system, await person(people.teamLead))).map(
      (type) => type.code,
    );

    expect(codes).toContain('PATERNITY');
    expect(codes).not.toContain('MATERNITY');
    expect(codes).toContain('ANNUAL');
  });

  it('refuses it directly, and says which way it was refused', async () => {
    const maternity = await byCode('MATERNITY');

    await expect(
      types.requestable(system, maternity.id, await person(people.teamLead)),
    ).rejects.toBeInstanceOf(NotEligibleForLeaveType);
  });

  /* The column is nullable so that nobody has to state a gender to be employed
     here. A record that says nothing is offered the unrestricted types, and being
     refused a restricted one directly says the record is incomplete rather than
     that they are ineligible — which a list cannot say, and is why the direct
     refusal is worded the way it is. */
  it('treats a record that says nothing as incomplete rather than ineligible', async () => {
    const nobodyStated = await employees.update(system, people.officer, { gender: null });

    const codes = (await types.offeredTo(system, nobodyStated)).map((type) => type.code);
    expect(codes).toContain('ANNUAL');
    expect(codes).not.toContain('MATERNITY');

    const maternity = await byCode('MATERNITY');
    try {
      await types.requestable(system, maternity.id, nobodyStated);
      throw new Error('That was allowed, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(NotEligibleForLeaveType);
      expect((error as NotEligibleForLeaveType).genderNotRecorded).toBe(true);
      expect((error as Error).message).toMatch(/does not say/);
    }
  });

  it('offers an unrestricted type to everybody', async () => {
    for (const id of [people.teamLead, people.officer, people.ceo]) {
      const codes = (await types.offeredTo(system, await person(id))).map((type) => type.code);
      expect(codes).toContain('ANNUAL');
    }
  });
});

describe('who may change a type, LMS 112', () => {
  /* The matrix belongs to ../unit/policy.test.ts; what is asserted here is that
     the service asks before it reads or writes anything. */
  it('is refused to an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
    const annual = await byCode('ANNUAL');

    await expect(
      types.update(adwoa, annual.id, { minNoticeCalendarDays: 0 }),
    ).rejects.toBeInstanceOf(NotAuthorised);
    await expect(types.retire(adwoa, annual.id)).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('is refused to an HR Officer, who may do almost everything else', async () => {
    const efua = signedInAs(people.hrOfficer ?? people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_OFFICER'],
      isManager: false,
    });
    const annual = await byCode('ANNUAL');

    await expect(
      types.update(efua, annual.id, { minNoticeCalendarDays: 0 }),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  /* And reading is open, because the person who most needs to know a notice
     window is the one about to miss it. */
  it('is readable by an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    expect((await types.list(adwoa, { offeredOnly: true })).length).toBeGreaterThan(0);
    expect(await types.byCode(adwoa, 'ANNUAL')).toBeDefined();
  });

  it('is changed by an HR Administrator', async () => {
    const ama = signedInAs(people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_ADMIN'],
      isManager: false,
    });
    const annual = await byCode('ANNUAL');

    await expect(
      types.update(ama, annual.id, { minNoticeCalendarDays: 21 }),
    ).resolves.toMatchObject({
      minNoticeCalendarDays: 21,
    });
  });
});

describe('every change is in the audit log, NFR AUD 01', () => {
  async function entriesFor(id: string) {
    const { rows } = await admin.query<{
      action: string;
      actor: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      `SELECT action, actor, before, after
         FROM audit_log
        WHERE entity = 'leave_type' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [id],
    );

    return rows;
  }

  it('names the administrator who moved a rule, and what it moved from', async () => {
    const ama = signedInAs(people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_ADMIN'],
      isManager: false,
    });
    const annual = await byCode('ANNUAL');

    await types.update(ama, annual.id, { minNoticeCalendarDays: 21 });

    const entries = await entriesFor(annual.id);
    const last = entries[entries.length - 1];

    expect(last.action).toBe('UPDATE');
    expect(last.actor).toContain(people.headOfHr);
    expect(last.before?.min_notice_calendar_days).toBe(14);
    expect(last.after?.min_notice_calendar_days).toBe(21);
  });

  it('records retiring one as the change it is', async () => {
    const unpaid = await byCode('UNPAID');

    await types.retire(system, unpaid.id);

    const last = (await entriesFor(unpaid.id)).at(-1);

    expect(last?.action).toBe('UPDATE');
    expect(last?.before?.is_active).toBe(true);
    expect(last?.after?.is_active).toBe(false);
  });

  it('writes nothing for a change that changed nothing', async () => {
    const annual = await byCode('ANNUAL');
    const before = (await entriesFor(annual.id)).length;

    await types.update(system, annual.id, { name: annual.name });

    expect((await entriesFor(annual.id)).length).toBe(before);
  });
});
