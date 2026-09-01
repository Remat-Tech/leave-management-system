import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { columnsThatDiffer, isClean } from '../../src/domain/reconciliation.js';
import { BalanceReconciliation } from '../../src/jobs/balance-reconciliation.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { ReconciliationRepository } from '../../src/repositories/reconciliation-repository.js';
import { RoleRepository } from '../../src/repositories/role-repository.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The nightly balance reconciliation against a real database. §7.4. LMS 213.
 *
 * Almost all of this story is here, because the thing it does is notice something the
 * rest of the system has arranged to be impossible. The cache follows the ledger by
 * trigger, in the same transaction, on every connection; to test a job that catches
 * drift, the drift has to be manufactured — and how it is manufactured is the most
 * interesting decision in the file.
 *
 * Two ways, and each is a real failure wearing a costume:
 *
 *   **The trigger is turned off and an entry is written.** `ALTER TABLE ... DISABLE
 *   TRIGGER` is exactly what a maintenance window or a bulk data fix does, and it
 *   produces the worst of the three shapes: a balance the ledger knows about and the
 *   cache has never heard of.
 *
 *   **The cache is written by hand.** With `lms.balance.from_the_ledger` set, which is
 *   the seam `rebuild_one_balance_from_the_ledger()` uses — so this is a figure moved
 *   without a movement behind it, which is what a restore from a backup taken between
 *   two statements leaves behind.
 *
 * Neither can be reached through the application, which is the point of the three
 * stories before this one. That they cannot is proved in ./balance.test.ts; that the
 * system notices when they happen anyway is proved here.
 *
 * The assertion this story turns on is a negative one, and it is repeated deliberately:
 * **after every run below, the balance is exactly as wrong as it was**. A
 * reconciliation that quietly put things right would pass every other test in this file.
 */

const testDatabaseUrl = inject('testDatabaseUrl');

/** Every role and nobody, which is what the nightly run is. */
const nightly = theSystem('the nightly balance reconciliation');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let job: BalanceReconciliation;
let checks: ReconciliationRepository;
let mailer: RecordingMailer;
let people: Record<string, string>;
let annualId: string;
let sickId: string;
let y2026Id: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  mailer = recordingMailer();
  checks = new ReconciliationRepository(db);
  job = new BalanceReconciliation(
    checks,
    guard,
    new RoleRepository(db),
    new EmployeeRepository(db),
    mailer,
  );
});

beforeEach(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request');
  currentRequest = undefined;

  people = (await seed(admin)) as Record<string, string>;
  mailer.clear();

  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0]
    .id as string;
  sickId = (await admin.query("SELECT id FROM leave_type WHERE code = 'SICK'")).rows[0]
    .id as string;
  y2026Id = (await admin.query("SELECT id FROM leave_year WHERE label = '2026'")).rows[0]
    .id as string;
});

afterAll(async () => {
  await admin.query('TRUNCATE leave_balance');
  await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request');

  await db?.destroy();
  await admin?.end();
});

/** A ledger entry, written the ordinary way, so the cache follows it. */
async function post(
  entryType: string,
  days: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const row: Record<string, unknown> = {
    employee_id: people.officer,
    leave_type_id: annualId,
    leave_year_id: y2026Id,
    entry_type: entryType,
    days: days.toFixed(2),
    reason: 'a movement for the suite',
    ...overrides,
  };

  /* LMS 301: a request-shaped entry names the request that caused it, and a request
     holds days — judged at COMMIT, so the pair goes in one transaction. A RESERVATION
     is the hold and brings a request of its own; a DEDUCTION or RELEASE draws down the
     one the RESERVATION before it made. */
  if (REQUEST_SHAPED.includes(entryType) && row.leave_request_id === undefined) {
    if (entryType === 'RESERVATION') {
      await admin.query('BEGIN');
      try {
        currentRequest = await insertRequest(row, Math.abs(days));
        await insertEntry({ ...row, leave_request_id: currentRequest });
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }

      return;
    }

    row.leave_request_id = currentRequest;
  }

  await insertEntry(row);
}

/** The four kinds of movement a leave request causes. See ../../src/domain/ledger.ts. */
const REQUEST_SHAPED = ['RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'];

/** The request the request-shaped entries of the current test are filed under. */
let currentRequest: string | undefined;

async function insertEntry(row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await admin.query(
    `INSERT INTO leave_ledger_entry (${columns.join(', ')}) VALUES (${placeholders})`,
    Object.values(row),
  );
}

/** A request row, inside whatever transaction the caller has open. */
async function insertRequest(key: Record<string, unknown>, days: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO leave_request (
        employee_id, leave_type_id, leave_year_id,
        start_date, end_date, reason, counting_basis, days, calendar_days, status,
        awaiting_approval_from)
     SELECT $1, $2, $3, y.start_date, y.start_date + ($4::int - 1), 'a request for the suite',
            'CALENDAR_DAYS', $4, $4, 'SUBMITTED', 'MANAGER'
       FROM leave_year y WHERE y.id = $3
     RETURNING id`,
    [key.employee_id, key.leave_type_id, key.leave_year_id, Math.max(1, Math.trunc(days) || 1)],
  );

  return rows[0].id;
}

/**
 * A ledger entry the cache never hears about.
 *
 * What a maintenance window looks like from the database's point of view: the trigger
 * off, rows written, the trigger back on, and nothing anywhere recording that the two
 * are now out of step.
 */
async function postBehindTheTriggersBack(
  movements: readonly [string, number][],
  overrides: Record<string, unknown> = {},
) {
  await admin.query(
    'ALTER TABLE leave_ledger_entry DISABLE TRIGGER leave_ledger_entry_keeps_the_balance_in_step',
  );

  try {
    for (const [entryType, days] of movements) {
      await post(entryType, days, overrides);
    }
  } finally {
    await admin.query(
      'ALTER TABLE leave_ledger_entry ENABLE TRIGGER leave_ledger_entry_keeps_the_balance_in_step',
    );
  }
}

/**
 * A cached figure moved with no movement behind it.
 *
 * Through the seam the rebuild function uses, because nothing else can write this
 * table at all — which is LMS 211's whole point and is why the drift this job exists
 * to find has to be manufactured rather than provoked.
 */
async function driftTheCache(set: string): Promise<void> {
  await admin.query('BEGIN');
  await admin.query("SELECT set_config('lms.balance.from_the_ledger', 'on', true)");
  await admin.query(`UPDATE leave_balance SET ${set}`);
  await admin.query('COMMIT');
}

async function cachedFigures(): Promise<Record<string, unknown>> {
  const { rows } = await admin.query(
    'SELECT entitled, carried_over, adjustment, taken, pending FROM leave_balance ORDER BY id LIMIT 1',
  );

  return rows[0] as Record<string, unknown>;
}

function asHrOfficer() {
  return signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asAnEmployee() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

/* ---------------------------------------------------- a system that agrees with itself */

describe('when the cache and the ledger agree', () => {
  it('finds nothing, and says how much it checked', async () => {
    await post('GRANT', 20);
    await post('RESERVATION', -5);
    await post('DEDUCTION', -5);
    await post('GRANT', 12, { leave_type_id: sickId });

    const found = await job.run(nightly);

    expect(isClean(found)).toBe(true);
    expect(found.disagreements).toEqual([]);
    expect(found.balancesChecked).toBe(2);
  });

  /**
   * And sends nothing at all.
   *
   * Deliberate rather than a saving. A nightly email saying nothing is wrong is a
   * nightly email nobody reads by March, and the one that matters arrives looking
   * exactly like it.
   */
  it('and tells nobody, because there is nothing to tell', async () => {
    await post('GRANT', 20);

    await job.run(nightly);

    expect(mailer.sent).toEqual([]);
  });

  /* Nothing to compare is not a failure. A company on its first morning has no
     movements and no balances, and a job that fell over on that would fall over in
     exactly the week somebody is watching it. */
  it('and survives a company with no balances at all', async () => {
    const found = await job.run(nightly);

    expect(found.balancesChecked).toBe(0);
    expect(isClean(found)).toBe(true);
  });
});

/* ------------------------------------------------- the three shapes of disagreement */

describe('when a cached figure has drifted', () => {
  beforeEach(async () => {
    await post('GRANT', 20);
    await driftTheCache('entitled = 15, taken = 2');
  });

  it('finds it, and says what each side holds', async () => {
    const found = await job.run(nightly);

    expect(found.disagreements).toHaveLength(1);

    const [out] = found.disagreements;
    expect(out.employeeNumber).toMatch(/^RH-/);
    expect(out.leaveTypeName).toBe('Annual Leave');
    expect(out.leaveYearLabel).toBe('2026');
    expect(out.hasCachedRow).toBe(true);
    expect(columnsThatDiffer(out)).toEqual(['entitled', 'taken']);
    expect(out.cached.entitled).toBe(15);
    expect(out.ledger.entitled).toBe(20);
    expect(out.cached.taken).toBe(2);
    expect(out.ledger.taken).toBe(0);
  });

  /**
   * And leaves it exactly as wrong as it was. The third acceptance criterion.
   *
   * The assertion the whole story turns on. `rebuild_one_balance_from_the_ledger()` is
   * one call away and would put this right in a millisecond — and would destroy the
   * only evidence that something in this system does not work. A job that erases that
   * evidence every night at two guarantees nobody ever finds the cause.
   */
  it('and changes nothing, so the evidence survives the alert', async () => {
    const before = await cachedFigures();

    await job.run(nightly);

    expect(await cachedFigures()).toEqual(before);
    expect(Number((await cachedFigures()).entitled)).toBe(15);
  });

  /* And running it twice reports the same thing twice, which follows from the above and
     is worth pinning down: a job that corrected on the quiet would be clean the second
     time and nobody would ever know why the first alert arrived. */
  it('and reports it again the next night', async () => {
    await job.run(nightly);
    const second = await job.run(nightly);

    expect(second.disagreements).toHaveLength(1);
  });
});

describe('when a balance does not exist at all', () => {
  /**
   * The worst of the three, and invisible from `leave_balance`.
   *
   * The ledger has movements and the cache has never heard of them, so every screen
   * shows that person nought days. A reconciliation that joined from the balance table
   * would report a clean night.
   */
  it('finds it, which a join from the cache never could', async () => {
    await postBehindTheTriggersBack([['GRANT', 20]]);

    const found = await job.run(nightly);

    expect(found.disagreements).toHaveLength(1);
    expect(found.disagreements[0].hasCachedRow).toBe(false);
    expect(found.disagreements[0].cached.entitled).toBe(0);
    expect(found.disagreements[0].ledger.entitled).toBe(20);
    expect(found.balancesChecked).toBe(1);
  });

  /**
   * And even where every figure happens to agree at nought.
   *
   * A reservation and the release that gave it back are both `pending`, so they net to
   * nothing and all five columns match a balance that is not there. The row should
   * still exist, because the trigger should have opened it — the mildest possible
   * symptom of the most serious possible fault, and the reason the view has a clause
   * about the missing row on top of the five about the figures.
   */
  it('and even when all five figures agree at nought', async () => {
    await postBehindTheTriggersBack([
      ['RESERVATION', -5],
      ['RELEASE', 5],
    ]);

    const found = await job.run(nightly);

    expect(found.disagreements).toHaveLength(1);
    expect(found.disagreements[0].hasCachedRow).toBe(false);
    expect(columnsThatDiffer(found.disagreements[0])).toEqual([]);
  });
});

describe('when a cached balance has nothing behind it', () => {
  /* Figures with nothing to explain them, which is the one state design principle 1
     exists to make impossible. */
  it('finds it, and says the ledger holds nothing', async () => {
    await post('GRANT', 20);
    await admin.query('TRUNCATE leave_entitlement_event, leave_ledger_entry, leave_request');

    const found = await job.run(nightly);

    expect(found.disagreements).toHaveLength(1);
    expect(found.disagreements[0].hasCachedRow).toBe(true);
    expect(found.disagreements[0].cached.entitled).toBe(20);
    expect(found.disagreements[0].ledger.entitled).toBe(0);
  });
});

/* ------------------------------------------------------------------- who hears about it */

describe('the alert', () => {
  beforeEach(async () => {
    await post('GRANT', 20);
    await driftTheCache('entitled = 15');
  });

  /* HR, found from the roles table rather than from a configured address, so somebody
     joining HR starts being told and somebody leaving stops without anybody remembering
     to edit an environment variable. */
  it('goes to everybody holding an HR role, at their work address', async () => {
    const found = await job.run(nightly);

    const hr = (
      await admin.query(
        `SELECT DISTINCT employee.work_email FROM employee
           JOIN app_user ON app_user.employee_id = employee.id
           JOIN user_role ON user_role.user_id = app_user.id
           JOIN role ON role.id = user_role.role_id
          WHERE role.code IN ('HR_OFFICER', 'HR_ADMIN')`,
      )
    ).rows.map((row: { work_email: string }) => row.work_email);

    expect(hr.length).toBeGreaterThan(0);
    expect([...found.told].sort()).toEqual([...hr].sort());
    expect(mailer.sent.map((mail) => mail.to).sort()).toEqual([...hr].sort());
  });

  /* Somebody holding both HR roles is one person and gets one email. Two copies of the
     same alert is how a person learns to filter them. */
  it('and reaches somebody holding both HR roles exactly once', async () => {
    const found = await job.run(nightly);

    expect(new Set(found.told).size).toBe(found.told.length);
  });

  /* Nobody outside HR is told. A wrong balance is somebody's leave, and a system that
     mails it to every administrator as a matter of routine is one that has stopped
     treating it as somebody's leave. */
  it('and to nobody else', async () => {
    const found = await job.run(nightly);

    const engineer = (
      await admin.query('SELECT work_email FROM employee WHERE id = $1', [people.engineer])
    ).rows[0].work_email as string;

    expect(found.told).not.toContain(engineer);
  });

  it('and says which balance, in the words somebody can act on', async () => {
    await job.run(nightly);

    const alert = mailer.last();
    const { rows } = await admin.query('SELECT employee_number FROM employee WHERE id = $1', [
      people.officer,
    ]);

    expect(alert.subject).toBe('A leave balance disagrees with the ledger');
    expect(alert.text).toContain(rows[0].employee_number as string);
    expect(alert.text).toContain('Annual Leave, 2026');
    expect(alert.text).toContain('the balance says 15, the ledger says 20');
    expect(alert.text).toContain('Nothing has been changed');
  });

  /**
   * And an address that will not take it does not stop the others being told.
   *
   * Every failure is caught and carried rather than thrown. A discrepancy nobody was
   * told about is the exact situation this job exists to prevent, so the failure to
   * tell somebody has to be visible to whatever ran the job rather than replacing the
   * report with a stack trace.
   */
  it('and survives an address that will not take it', async () => {
    mailer.failNext(new Error('SMTP is not answering.'));

    const found = await job.run(nightly);

    expect(found.couldNotTell).toHaveLength(1);
    expect(found.couldNotTell[0].because).toBe('SMTP is not answering.');
    expect(found.told.length).toBeGreaterThan(0);
    expect(found.disagreements).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ who may run it */

describe('who may reconcile', () => {
  beforeEach(async () => {
    await post('GRANT', 20);
  });

  /* The story's own "as an HR Officer": somebody who suspects a figure is wrong should
     be able to ask this afternoon rather than wait for two in the morning. */
  it('is HR, this afternoon, as well as the job at two in the morning', async () => {
    await expect(job.run(asHrOfficer())).resolves.toMatchObject({ balancesChecked: 1 });
  });

  /* It reads every balance in the company in one answer, which is every employee's
     leave. Refused openly, because it names nobody and discloses nothing. */
  it('and not somebody who may only read their own', async () => {
    await expect(job.run(asAnEmployee())).rejects.toBeInstanceOf(NotAuthorised);

    await expect(job.run(asAnEmployee())).rejects.toThrow(/whole company/);
  });
});

/* --------------------------------------------------- one definition of the projection */

describe('the checker and the writer read the same projection', () => {
  /**
   * The property that makes this reconciliation worth running.
   *
   * If the check computed its own expected figures, it could only ever agree with
   * itself — the drift it exists to find would be invisible in exactly the case where
   * the writer's arithmetic was the thing that was wrong. So `what_the_ledger_says` is
   * the view the rebuild function writes from, and this asserts the two really are the
   * same one: rebuild every balance the checker complains about, and the complaint goes
   * away, on figures the checker itself produced.
   */
  it('so a rebuild silences exactly what the check found', async () => {
    await post('GRANT', 20);
    await post('RESERVATION', -5);
    await driftTheCache('entitled = 3, pending = 99');
    await postBehindTheTriggersBack([['GRANT', 12]], { employee_id: people.engineer });

    const before = await job.run(nightly);
    expect(before.disagreements).toHaveLength(2);

    for (const out of before.disagreements) {
      await admin.query('SELECT rebuild_one_balance_from_the_ledger($1, $2, $3)', [
        out.employeeId,
        out.leaveTypeId,
        out.leaveYearId,
      ]);
    }

    const after = await job.run(nightly);

    expect(isClean(after)).toBe(true);
    expect(Number((await cachedFigures()).entitled)).toBe(20);
  });

  /* And the count is of both sides. A balance the ledger knows about and the cache does
     not is exactly the fault worth finding, and counting only cached rows would report
     a smaller number on the night something went most wrong. */
  it('and counts balances from both sides of the comparison', async () => {
    await post('GRANT', 20);
    await postBehindTheTriggersBack([['GRANT', 12]], { employee_id: people.engineer });

    expect(await checks.balancesChecked()).toBe(2);
  });
});
