import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { Employee } from '../../src/features/employee/employee.js';
import {
  type ApproverRole,
  nextUnapproved,
  DEFAULT_APPROVAL_CHAIN,
  firstApprover,
  InvalidApprovalChain,
} from '../../src/features/leave-type/approval-chain.js';
import {
  type LeaveType,
  NobodyApprovesLeaveType,
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
 * Who approves each kind of leave, against a real database. FR 38a, §5.5.
 * LMS 204.
 *
 * The unit suite covers what a chain is and how the walk runs;
 * ../unit/approval-chain.test.ts is where that is proved without a database.
 * What needs one is everything the database itself decides, and there is a
 * particular reason to want it here rather than to take the migration's word:
 *
 *   The chains the story names are really on a migrated database — the default
 *   for five types and HR then the Chief Executive for the two unpaid ones. A
 *   production database is migrated and never seeded, so this is the only thing
 *   standing between an installation and a leave system where nobody approves
 *   anything.
 *
 *   The default this file's own domain applies and the default the migration
 *   writes are the same two desks. They are stated in two places on purpose, and
 *   two statements of one fact drift unless something asserts they agree.
 *
 *   A chain cannot acquire a hole, a repeated desk or a desk nobody has heard of,
 *   whoever is writing — including somebody at a psql prompt.
 *
 *   The application role can never rewrite a step in place, which is what makes
 *   "a chain is replaced as a whole" true for every writer rather than for the
 *   ones who read the repository.
 */

const testDatabaseUrl = await databaseForThisFile();

const DOMAINS = ['rematholdings.com'];

/** Every role and nobody, so that no policy refuses the fixtures. */
const system = theSystem('approval chain integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let types: LeaveTypeService;
let employees: EmployeeService;
let people: Record<string, string>;

/**
 * The two tables as the migrations left them, read once before anything has
 * touched them.
 *
 * A snapshot rather than a list written out here, for the reason
 * ./leave-type.test.ts takes one: these are reference data owned by a migration,
 * and restating them would mean the suite asserting its own copy.
 */
let statutoryTypes: Record<string, unknown>[];
let statutorySteps: Record<string, unknown>[];

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

  statutoryTypes = (await admin.query('SELECT * FROM leave_type ORDER BY id')).rows;
  statutorySteps = (
    await admin.query('SELECT * FROM leave_type_approval_step ORDER BY leave_type_id, step_order')
  ).rows;
});

beforeEach(async () => {
  await restoreTheStatutorySet();

  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  /* Left as the migrations left it, for the reason ./leave-type.test.ts now does
     the same: both files snapshot this table in beforeAll, and a type created
     here and not cleared would become part of the other's idea of the statutory
     set whenever it ran second. */
  await restoreTheStatutorySet();

  await db?.destroy();
  await admin?.end();
});

/**
 * Both tables as the migrations left them, exactly.
 *
 * Emptied and rewritten from the snapshots rather than patched back, for the
 * reason ./leave-type.test.ts gives: "undo whichever columns I remembered" is how
 * a suite acquires a dependency on the order its own tests run in. The steps go
 * back after the types because they point at them, and the ids come back with the
 * rows because the audit log files its entries under them.
 */
async function restoreTheStatutorySet(): Promise<void> {
  const columns = Object.keys(statutoryTypes[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  /* The entitlement figures point at the types and the key has no cascade, so
     they go first; the steps do cascade and go with the types. Both are put back
     by the functions that own them rather than from a copy written here. */
  await admin.query('TRUNCATE leave_entitlement_rule RESTART IDENTITY');
  await admin.query('DELETE FROM leave_type');

  for (const row of statutoryTypes) {
    await admin.query(
      `INSERT INTO leave_type (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  for (const step of statutorySteps) {
    await admin.query(
      `INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
       VALUES ($1, $2, $3)`,
      [step.leave_type_id, step.step_order, step.approver_role],
    );
  }

  await admin.query(`SELECT setval('leave_type_id_seq', (SELECT max(id) FROM leave_type))`);
  await admin.query('SELECT ensure_statutory_entitlement_rules()');
}

async function byCode(code: string): Promise<LeaveType> {
  const found = await types.byCode(system, code);
  expect(found, `no leave type with the code ${code}`).toBeDefined();
  return found!;
}

async function chainFor(code: string): Promise<ApproverRole[]> {
  return (await byCode(code)).approvalChain;
}

/** The steps as the table holds them, which is where a hole would show. */
async function stepsFor(code: string): Promise<{ step_order: number; approver_role: string }[]> {
  const { rows } = await admin.query<{ step_order: number; approver_role: string }>(
    `SELECT step.step_order, step.approver_role
       FROM leave_type_approval_step step
       JOIN leave_type type ON type.id = step.leave_type_id
      WHERE upper(type.code) = $1
      ORDER BY step.step_order`,
    [code],
  );

  return rows;
}

async function person(id: string): Promise<Employee> {
  return employees.byId(system, id);
}

function asAdministrator() {
  return signedInAs(people.headOfHr, { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: false });
}

describe('the chains of FR 38a, which is the story', () => {
  /* The story in one assertion, read off the database rather than off a
     constant: unpaid leave goes to HR and the Chief Executive, everything else
     goes to the manager and then HR. Neither is an `if` anywhere. */
  it('send the two unpaid types to HR and the CEO, and everything else to the manager', async () => {
    const chains = new Map(
      (await types.list(system)).map((type) => [type.code, type.approvalChain]),
    );

    expect(chains.get('UNPAID')).toEqual(['HR', 'CEO']);
    expect(chains.get('MAT_EXT_UNPAID')).toEqual(['HR', 'CEO']);

    for (const code of ['ANNUAL', 'SICK', 'COMPASSIONATE', 'MATERNITY', 'PATERNITY']) {
      expect(chains.get(code), `${code} does not go to the manager and then HR`).toEqual([
        'MANAGER',
        'HR',
      ]);
    }
  });

  /* §4.3.1 says it of both unpaid types: "Decided by HR and the Chief
     Executive." No manager stage on either, which is the part worth asserting
     rather than assuming — unpaid leave is not a request a line manager signs off
     and HR confirms, it is an arrangement with the company. */
  it('leave the manager out of the unpaid chains altogether', async () => {
    for (const code of ['UNPAID', 'MAT_EXT_UNPAID']) {
      expect(await chainFor(code)).not.toContain('MANAGER');
      expect(firstApprover(await chainFor(code))).toBe('HR');
      expect(nextUnapproved(await chainFor(code), ['HR'])).toBe('CEO');
    }
  });

  it('give every type on a database nothing has seeded somebody to approve it', async () => {
    for (const type of await types.list(system)) {
      expect(type.approvalChain.length, `nobody approves ${type.name}`).toBeGreaterThan(0);
    }
  });

  /* A chain that skips a number stops at the gap, and the request waits in a
     queue nobody is looking at. Asserted against the rows rather than against the
     read, because the read sorts and a hole would not show in it. */
  it('number every chain from one with no gaps', async () => {
    for (const type of await types.list(system)) {
      const steps = await stepsFor(type.code);

      expect(steps.map((step) => step.step_order)).toEqual(steps.map((_step, index) => index + 1));
    }
  });

  /* Two statements of one fact, which drift unless something asserts they agree:
     ../../src/features/leave-type/approval-chain.ts defaults a type nobody configured, and the
     migration writes the chain for a type an operator restores. Same two desks.
     The same arrangement READS_EVERY_RECORD has with MANDATORY_ROLES. */
  it('default to the same two desks the domain does', async () => {
    expect(await chainFor('ANNUAL')).toEqual([...DEFAULT_APPROVAL_CHAIN]);

    await admin.query(
      `DELETE FROM leave_type_approval_step
        WHERE leave_type_id = (SELECT id FROM leave_type WHERE upper(code) = 'COMPASSIONATE')`,
    );
    await admin.query('SELECT ensure_statutory_approval_chains()');

    expect(await chainFor('COMPASSIONATE')).toEqual([...DEFAULT_APPROVAL_CHAIN]);
  });
});

describe('saying who approves a type, which never waits on a developer', () => {
  it('replaces the chain outright rather than adding to it', async () => {
    const annual = await byCode('ANNUAL');

    await types.setApprovalChain(asAdministrator(), annual.id, ['HR', 'CEO']);

    expect(await chainFor('ANNUAL')).toEqual(['HR', 'CEO']);
    expect(await stepsFor('ANNUAL')).toEqual([
      { step_order: 1, approver_role: 'HR' },
      { step_order: 2, approver_role: 'CEO' },
    ]);
  });

  /* The change HR is most likely to want, and the one this story exists for: the
     day the Chief Executive stops signing off unpaid leave, it is this call and
     no release. */
  it('takes the Chief Executive out of the unpaid chain in one call', async () => {
    const unpaid = await byCode('UNPAID');

    await types.setApprovalChain(asAdministrator(), unpaid.id, ['HR']);

    expect(await chainFor('UNPAID')).toEqual(['HR']);
    expect(nextUnapproved(await chainFor('UNPAID'), ['HR'])).toBeUndefined();
  });

  it('accepts a three stage chain, which is as long as one can be', async () => {
    const maternity = await byCode('MATERNITY');

    await types.setApprovalChain(asAdministrator(), maternity.id, ['MANAGER', 'HR', 'CEO']);

    expect(await chainFor('MATERNITY')).toEqual(['MANAGER', 'HR', 'CEO']);
  });

  /* The intermediate state the deferred trigger exists for: between the delete
     and the insert the type has no chain at all, and at COMMIT that state does
     not exist. A trigger checked per statement would refuse the ordinary
     operation. */
  it('passes through having no chain at all without being refused', async () => {
    const sick = await byCode('SICK');

    await expect(
      types.setApprovalChain(asAdministrator(), sick.id, ['CEO']),
    ).resolves.toMatchObject({ approvalChain: ['CEO'] });
  });

  it('moves updated_at, which is what a type whose requests went astray is read by', async () => {
    const annual = await byCode('ANNUAL');

    const updated = await types.setApprovalChain(asAdministrator(), annual.id, ['HR']);

    expect(updated.updatedAt.getTime()).toBeGreaterThan(annual.updatedAt.getTime());
  });

  it('refuses a chain with nobody in it, and one naming a desk that is not one', async () => {
    const annual = await byCode('ANNUAL');
    const ama = asAdministrator();

    await expect(types.setApprovalChain(ama, annual.id, [])).rejects.toBeInstanceOf(
      InvalidApprovalChain,
    );
    await expect(
      types.setApprovalChain(ama, annual.id, ['MANAGER', 'HR_ADMIN']),
    ).rejects.toBeInstanceOf(InvalidApprovalChain);

    // And the chain that was there is still there.
    expect(await chainFor('ANNUAL')).toEqual(['MANAGER', 'HR']);
  });

  it('reports an id that is nobody rather than silently doing nothing', async () => {
    await expect(types.setApprovalChain(asAdministrator(), '9999', ['HR'])).rejects.toThrow(/9999/);
  });

  /* A new type is approved by somebody from the moment it exists, and by the
     manager and then HR unless the person creating it said otherwise. */
  it('gives a type created without a word about approvals the default chain', async () => {
    const created = await types.create(system, {
      code: 'STUDY',
      name: 'Study Leave',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      displayOrder: 8,
    });

    expect(created.approvalChain).toEqual([...DEFAULT_APPROVAL_CHAIN]);
    expect((await types.byId(system, created.id)).approvalChain).toEqual([
      ...DEFAULT_APPROVAL_CHAIN,
    ]);
  });

  it('stores the chain a type was created with', async () => {
    const created = await types.create(system, {
      code: 'SABBATICAL',
      name: 'Sabbatical',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'EVENT',
      approvalChain: ['hr', 'ceo'],
      displayOrder: 9,
    });

    expect(created.approvalChain).toEqual(['HR', 'CEO']);
    expect(await stepsFor('SABBATICAL')).toEqual([
      { step_order: 1, approver_role: 'HR' },
      { step_order: 2, approver_role: 'CEO' },
    ]);
  });

  /* The type and its chain are one write. A type row with no steps beside it is
     not half a type, it is a type nobody can approve leave against. */
  it('writes neither the type nor the chain when the chain is nonsense', async () => {
    await expect(
      types.create(system, {
        code: 'BOARD',
        name: 'Board Leave',
        countingBasis: 'WORKING_DAYS',
        entitlementBasis: 'EVENT',
        approvalChain: ['CHAIRMAN'],
      }),
    ).rejects.toBeInstanceOf(InvalidApprovalChain);

    expect(await types.byCode(system, 'BOARD')).toBeUndefined();
  });
});

describe('the rules are held by the database as well as by the domain', () => {
  /**
   * Written straight to the table on the owner connection, going round the domain
   * entirely — which is the point. The validation in ../../src/domain makes the
   * refusal name the field; these constraints make the row impossible for every
   * writer, including a migration correcting data and somebody at a psql prompt.
   */
  async function writeStep(code: string, stepOrder: number, role: string): Promise<void> {
    await admin.query(
      `INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
       SELECT id, $2, $3 FROM leave_type WHERE upper(code) = $1`,
      [code, stepOrder, role],
    );
  }

  async function clearChain(code: string): Promise<void> {
    await admin.query(
      `DELETE FROM leave_type_approval_step
        WHERE leave_type_id = (SELECT id FROM leave_type WHERE upper(code) = $1)`,
      [code],
    );
  }

  it('refuses a desk nobody knows how to find', async () => {
    await clearChain('ANNUAL');

    await expect(writeStep('ANNUAL', 1, 'DIRECTOR')).rejects.toThrow(
      /leave_type_approval_step_role_known/,
    );
  });

  /* The four role codes are not desks. 'HR_ADMIN' is the one somebody will
     actually type, and it has to be refused at the table as well as at the door. */
  it('refuses a role code in place of a desk', async () => {
    await clearChain('ANNUAL');

    await expect(writeStep('ANNUAL', 1, 'HR_ADMIN')).rejects.toThrow(
      /leave_type_approval_step_role_known/,
    );
  });

  it('refuses a chain numbered from zero', async () => {
    await clearChain('ANNUAL');

    await expect(writeStep('ANNUAL', 0, 'HR')).rejects.toThrow(
      /leave_type_approval_step_order_positive/,
    );
  });

  it('refuses two desks at the same position', async () => {
    await expect(writeStep('ANNUAL', 1, 'CEO')).rejects.toThrow(/leave_type_approval_step_pkey/);
  });

  it('refuses the same desk twice in one chain', async () => {
    await expect(writeStep('ANNUAL', 3, 'HR')).rejects.toThrow(
      /leave_type_approval_step_role_once/,
    );
  });

  /* The one a primary key and a unique index between them cannot say. Steps 1 and
     3 is a chain that stops after the first approval, because the walk from 1
     asks for 2 and is handed nothing. */
  it('refuses a chain with a hole in it', async () => {
    await clearChain('ANNUAL');
    await writeStep('ANNUAL', 1, 'MANAGER');

    /* The trigger raises its own message, so it names itself in the constraint
       the driver carries rather than in the text — which is what lets the
       repository recognise it the same way it recognises a real constraint. */
    await expect(writeStep('ANNUAL', 3, 'HR')).rejects.toMatchObject({
      constraint: 'leave_type_approval_chain_is_whole',
      message: expect.stringContaining('numbered up to 3'),
    });
  });

  /* And permits the whole chain being replaced inside one transaction, which is
     the operation the deferred check exists to allow. */
  it('permits a chain being emptied and rewritten in one transaction', async () => {
    await admin.query('BEGIN');
    await clearChain('ANNUAL');
    await writeStep('ANNUAL', 1, 'CEO');
    await admin.query('COMMIT');

    expect(await chainFor('ANNUAL')).toEqual(['CEO']);
  });

  /* A step is part of a type rather than a record about one, so it goes when the
     type goes — the same cascade work_pattern_day has from a pattern. lms_app
     cannot reach this: it holds no DELETE on leave_type. */
  it('takes a chain with the type it belongs to', async () => {
    await admin.query('TRUNCATE leave_entitlement_rule RESTART IDENTITY');
    await admin.query(`DELETE FROM leave_type WHERE upper(code) = 'PATERNITY'`);

    expect(await stepsFor('PATERNITY')).toEqual([]);
  });

  /* A chain is replaced as a whole, never edited in place. Moving 'manager then
     HR' to 'HR then CEO' by updating rows passes through 'HR then HR' or 'manager
     then CEO' depending on which row moves first, and both are real chains a
     concurrent reader would find. Delete and insert has no such state. */
  it('gives the application role no way to rewrite a step in place', async () => {
    const { rows } = await admin.query<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
    }>(
      `SELECT has_table_privilege('lms_app', 'leave_type_approval_step', 'SELECT') AS sel,
              has_table_privilege('lms_app', 'leave_type_approval_step', 'INSERT') AS ins,
              has_table_privilege('lms_app', 'leave_type_approval_step', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'leave_type_approval_step', 'DELETE') AS del`,
    );

    expect(rows[0]).toEqual({ sel: true, ins: true, upd: false, del: true });
  });
});

describe('a type nobody approves', () => {
  /**
   * The seam the leave-type-approval-chain migration names, reproduced rather
   * than described. `ensure_statutory_leave_types()` was written before this
   * table existed, so a type it puts back comes back with no chain — and the
   * repair is the call beside it.
   */
  async function loseTheTypeAndPutItBack(code: string): Promise<void> {
    await admin.query('TRUNCATE leave_entitlement_rule RESTART IDENTITY');
    await admin.query('DELETE FROM leave_type WHERE upper(code) = $1', [code]);
    await admin.query('SELECT ensure_statutory_leave_types()');
  }

  it('is what a type restored on its own comes back as', async () => {
    await loseTheTypeAndPutItBack('COMPASSIONATE');

    expect(await chainFor('COMPASSIONATE')).toEqual([]);
  });

  /* Refused at the point of asking rather than by a constraint on the operator
     putting the type back, and the refusal says whose job it is to fix. FR 38a.
     A request against a type nobody approves does not fail loudly on its own — it
     waits — which is why this is checked before anything is filed. */
  it('refuses new leave against it, and says who can fix it', async () => {
    await loseTheTypeAndPutItBack('COMPASSIONATE');

    const compassionate = await byCode('COMPASSIONATE');

    await expect(
      types.requestable(system, compassionate.id, await person(people.officer)),
    ).rejects.toBeInstanceOf(NobodyApprovesLeaveType);
  });

  /* And "nobody approves this" is told apart from "you may not have this", which
     is the whole reason it is a refusal of its own: one is somebody's job to fix
     and the other is a fact about the person asking. */
  it('is a different refusal from a type the person is not eligible for', async () => {
    await loseTheTypeAndPutItBack('COMPASSIONATE');

    const compassionate = await byCode('COMPASSIONATE');
    const maternity = await byCode('MATERNITY');
    const kofi = await person(people.teamLead);

    await expect(types.requestable(system, compassionate.id, kofi)).rejects.toBeInstanceOf(
      NobodyApprovesLeaveType,
    );
    await expect(types.requestable(system, maternity.id, kofi)).rejects.not.toBeInstanceOf(
      NobodyApprovesLeaveType,
    );
  });

  it('is put right by the call that owns the chains', async () => {
    await loseTheTypeAndPutItBack('UNPAID');

    expect(await chainFor('UNPAID')).toEqual([]);

    await admin.query('SELECT ensure_statutory_approval_chains()');

    expect(await chainFor('UNPAID')).toEqual(['HR', 'CEO']);
    await expect(
      types.requestable(system, (await byCode('UNPAID')).id, await person(people.officer)),
    ).resolves.toBeDefined();
  });
});

describe('putting the chains back, and refusing to rewrite them', () => {
  async function ensureTheChains(): Promise<number> {
    const { rows } = await admin.query<{ given: number }>(
      'SELECT ensure_statutory_approval_chains() AS given',
    );

    return rows[0].given;
  }

  async function stepEntries(): Promise<{ action: string; actor: string }[]> {
    const { rows } = await admin.query<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log
        WHERE entity = 'leave_type_approval_step' ORDER BY occurred_at, id`,
    );

    return rows;
  }

  /* The state every already migrated database is in. Doing nothing has to be
     genuinely nothing: not a no-op insert, not an audit entry. */
  it('does nothing at all where every type has a chain', async () => {
    const before = await admin.query(
      'SELECT * FROM leave_type_approval_step ORDER BY leave_type_id, step_order',
    );

    expect(await ensureTheChains()).toBe(0);

    const after = await admin.query(
      'SELECT * FROM leave_type_approval_step ORDER BY leave_type_id, step_order',
    );
    expect(after.rows).toEqual(before.rows);
    expect(await stepEntries()).toEqual([]);
  });

  /* It inserts and it never rewrites. FR 31 gives the chain to HR, so reconciling
     the rows back to the values shipped here would take away the thing this story
     exists to give — the first time somebody added the Chief Executive to the
     compassionate leave chain, it would be taken out again. */
  it('does not undo a chain an administrator changed', async () => {
    const compassionate = await byCode('COMPASSIONATE');

    await types.setApprovalChain(asAdministrator(), compassionate.id, ['MANAGER', 'HR', 'CEO']);

    expect(await ensureTheChains()).toBe(0);
    expect(await chainFor('COMPASSIONATE')).toEqual(['MANAGER', 'HR', 'CEO']);
  });

  it('gives a chain only to the types that have none', async () => {
    await admin.query(
      `DELETE FROM leave_type_approval_step
        WHERE leave_type_id IN (SELECT id FROM leave_type WHERE upper(code) IN ('SICK', 'UNPAID'))`,
    );

    expect(await ensureTheChains()).toBe(2);

    expect(await chainFor('SICK')).toEqual(['MANAGER', 'HR']);
    expect(await chainFor('UNPAID')).toEqual(['HR', 'CEO']);
  });

  /* NFR AUD 01. A chain that reappeared is a configuration change, and "not named
     by the writer" is a thin answer when the question is who decided that unpaid
     leave goes to the Chief Executive. */
  it('names itself in the audit log as the writer of a chain it put back', async () => {
    await admin.query(
      `DELETE FROM leave_type_approval_step
        WHERE leave_type_id = (SELECT id FROM leave_type WHERE upper(code) = 'UNPAID')`,
    );
    await ensureTheChains();

    expect(await stepEntries()).toEqual([
      { action: 'DELETE', actor: 'not named by the writer' },
      { action: 'DELETE', actor: 'not named by the writer' },
      { action: 'CREATE', actor: 'ensure_statutory_approval_chains()' },
      { action: 'CREATE', actor: 'ensure_statutory_approval_chains()' },
    ]);
  });

  it('keeps the name of a caller who gave one, and puts the setting back', async () => {
    await admin.query(`SET lms.audit.actor = 'Ama Mensah, at a psql prompt'`);

    try {
      await admin.query(
        `DELETE FROM leave_type_approval_step
          WHERE leave_type_id = (SELECT id FROM leave_type WHERE upper(code) = 'SICK')`,
      );
      await ensureTheChains();

      expect((await stepEntries()).at(-1)).toEqual({
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

  /* Restoring reference data is an operator's job, done knowingly. lms_app writes
     chains through the service all day, so this withholds no power it has
     elsewhere — it keeps a bulk rewrite of every unapprovable type from being one
     call away from anything that happens to be connected. */
  it('belongs to the owner rather than to the application', async () => {
    const { rows } = await admin.query<{ may: boolean }>(
      `SELECT has_function_privilege('lms_app', 'ensure_statutory_approval_chains()', 'EXECUTE') AS may`,
    );

    expect(rows[0].may).toBe(false);
  });
});

describe('who may say who approves a type, LMS 112', () => {
  /* The matrix belongs to ../unit/policy.test.ts; what is asserted here is that
     the service asks before it writes. */
  it('is refused to an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    await expect(
      types.setApprovalChain(adwoa, (await byCode('UNPAID')).id, ['HR']),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  it('is refused to an HR Officer, who may do almost everything else', async () => {
    const efua = signedInAs(people.hrOfficer ?? people.headOfHr, {
      roles: ['EMPLOYEE', 'HR_OFFICER'],
      isManager: false,
    });

    await expect(
      types.setApprovalChain(efua, (await byCode('UNPAID')).id, ['HR']),
    ).rejects.toBeInstanceOf(NotAuthorised);
  });

  /* And reading is open, for the reason the rest of the type is: the person who
     most needs to know who signs their leave off is the one waiting for it. */
  it('is readable by an ordinary employee', async () => {
    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    expect((await types.byCode(adwoa, 'UNPAID'))?.approvalChain).toEqual(['HR', 'CEO']);
  });

  it('is changed by an HR Administrator', async () => {
    await expect(
      types.setApprovalChain(asAdministrator(), (await byCode('UNPAID')).id, ['HR']),
    ).resolves.toMatchObject({ approvalChain: ['HR'] });
  });
});

describe('every change is in the audit log, NFR AUD 01', () => {
  async function entriesFor(leaveTypeId: string) {
    const { rows } = await admin.query<{
      entity: string;
      action: string;
      actor: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      `SELECT entity, action, actor, before, after
         FROM audit_log
        WHERE entity = 'leave_type_approval_step' AND entity_id = $1
        ORDER BY occurred_at, id`,
      [leaveTypeId],
    );

    return rows;
  }

  /* Filed under the type rather than under the step, the way work_pattern_day
     files under the pattern. Nobody searches for the second stage of a chain;
     they search for the leave type whose requests went to the wrong desk. */
  it('files a chain change under the leave type it changed', async () => {
    const unpaid = await byCode('UNPAID');

    await types.setApprovalChain(asAdministrator(), unpaid.id, ['MANAGER', 'HR']);

    const entries = await entriesFor(unpaid.id);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.entity).toBe('leave_type_approval_step');
      expect(entry.actor).toContain(people.headOfHr);
    }
  });

  /* The whole of the history, because there is no updated_at on a step to carry
     it: two desks taken out and two put in, with what each of them was. */
  it('says which desk went and which arrived', async () => {
    const unpaid = await byCode('UNPAID');

    await types.setApprovalChain(asAdministrator(), unpaid.id, ['MANAGER', 'HR']);

    const entries = await entriesFor(unpaid.id);

    expect(
      entries.filter((entry) => entry.action === 'DELETE').map((entry) => entry.before),
    ).toEqual([
      expect.objectContaining({ step_order: 1, approver_role: 'HR' }),
      expect.objectContaining({ step_order: 2, approver_role: 'CEO' }),
    ]);

    expect(
      entries.filter((entry) => entry.action === 'CREATE').map((entry) => entry.after),
    ).toEqual([
      expect.objectContaining({ step_order: 1, approver_role: 'MANAGER' }),
      expect.objectContaining({ step_order: 2, approver_role: 'HR' }),
    ]);
  });

  it('records the chain a new type was created with', async () => {
    const created = await types.create(asAdministrator(), {
      code: 'STUDY',
      name: 'Study Leave',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      approvalChain: ['MANAGER', 'HR', 'CEO'],
      displayOrder: 8,
    });

    expect((await entriesFor(created.id)).map((entry) => entry.after)).toEqual([
      expect.objectContaining({ step_order: 1, approver_role: 'MANAGER' }),
      expect.objectContaining({ step_order: 2, approver_role: 'HR' }),
      expect.objectContaining({ step_order: 3, approver_role: 'CEO' }),
    ]);
  });
});
