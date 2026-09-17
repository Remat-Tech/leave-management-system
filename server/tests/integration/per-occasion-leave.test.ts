import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { type Actor, signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { calendarDateIn } from '../../src/shared/time.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { ReclassificationRepository } from '../../src/features/leave-request/reclassification.db.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../../src/features/entitlement/entitlement-rule.db.js';
import { EntitlementRuleService } from '../../src/features/entitlement/entitlement-rule.service.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { earliestOpenDayFrom } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * Per-occasion leave asked for with nothing granted yet, and granted on approval. FR 32g.
 *
 * Compassionate leave, five working days an occasion on the migrated rules.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('per-occasion leave integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let requests: LeaveRequestService;
let balances: BalanceService;
let people: Record<string, string>;

let compassionateId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const rules = new EntitlementRuleService(
    new EntitlementRuleRepository(db),
    guard,
    earliestOpenDayFrom(yearRepository),
  );

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    new LeaveTypeRepository(db),
    yearRepository,
    new LeaveRequestRepository(db),
    new LeaveDecisionRepository(db),
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    new ReclassificationRepository(db),
    new AttachmentRepository(db),
    new RoleRepository(db),
    delegationService(db, guard),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
    async (employee, leaveTypeId, on) =>
      (await rules.entitlementOn(system, employee, leaveTypeId, on))?.entitlementDays,
  );
});

beforeEach(async () => {
  await clear();

  people = (await seed(admin)) as Record<string, string>;

  compassionateId = (await admin.query("SELECT id FROM leave_type WHERE code = 'COMPASSIONATE'"))
    .rows[0].id;
});

afterAll(async () => {
  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_recalculation, leave_request_reclassification, leave_request_attachment, leave_request_decision, leave_request_reassignment, leave_request_routing, leave_request_withdrawal, leave_request_reversal, leave_request',
  );
}

/** A Monday a few weeks out, so a period is working days whatever today is. */
function aMonday(weeksOut: number, plusDays = 0): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + 7 * weeksOut + ((8 - day.getUTCDay()) % 7) + plusDays);

  return calendarDateIn(day, 'UTC');
}

const asTheEmployee = () => signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

const DESKS: Record<string, () => Actor> = {
  MANAGER: () => signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true }),
  HR: () => signedInAs(people.hrOfficer, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false }),
  CEO: () =>
    signedInAs(people.ceo, { roles: ['EMPLOYEE'], isManager: true, isChiefExecutive: true }),
};

/** Mon to Wed, or longer: `lastDay` days after the Monday. */
async function ask(weeksOut: number, lastDay = 2): Promise<LeaveRequest> {
  const { request } = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId: compassionateId,
    from: aMonday(weeksOut),
    to: aMonday(weeksOut, lastDay),
    reason: 'A funeral',
    acknowledgesShortNotice: true,
  });

  return request;
}

/** Every desk in the chain says the same thing. */
async function decideAll(request: LeaveRequest, yes: boolean): Promise<LeaveRequest> {
  let current = request;

  while (current.awaitingApprovalFrom !== null) {
    const actor = DESKS[current.awaitingApprovalFrom]();

    current = (
      yes
        ? await requests.approve(actor, current.id)
        : await requests.refuse(actor, current.id, 'Not this time')
    ).request;
  }

  return current;
}

async function theBalance(request: LeaveRequest) {
  return balances.forOne(system, {
    employeeId: people.officer,
    leaveTypeId: compassionateId,
    leaveYearId: request.leaveYearId,
  });
}

async function events(): Promise<{ occurred_on: string }[]> {
  return (
    await admin.query<{ occurred_on: string }>(
      'SELECT occurred_on::text FROM leave_entitlement_event WHERE employee_id = $1',
      [people.officer],
    )
  ).rows;
}

describe('asking for per-occasion leave', () => {
  it('is quoted against what one occasion grants, with nothing granted yet', async () => {
    const quote = await requests.quote(asTheEmployee(), {
      employeeId: people.officer,
      leaveTypeId: compassionateId,
      from: aMonday(3),
      to: aMonday(3, 2),
    });

    expect(quote).toMatchObject({ perOccasion: 5, availableNow: 5, availableAfter: 2 });
    expect(quote.warnings.map((one) => one.code)).not.toContain('NOT_ENOUGH_DAYS');
  });

  it('is submitted with an empty balance, and grants nothing until it is decided', async () => {
    const request = await ask(3);

    expect(request.status).not.toBe('REFUSED');
    expect(await events()).toEqual([]);
    expect((await theBalance(request)).entitled).toBe(0);
  });

  it('is refused past what one occasion grants', async () => {
    await expect(ask(3, 7)).rejects.toMatchObject({ name: 'MoreThanAnOccasionGrants' });
  });
});

describe('deciding it', () => {
  it('grants the occasion on the final approval, and takes the days from it', async () => {
    const request = await decideAll(await ask(3), true);
    const balance = await theBalance(request);

    expect(request.status).toBe('APPROVED');
    expect(balance).toMatchObject({ entitled: 5, taken: request.days, pending: 0 });
    expect(balance.available).toBe(5 - request.days);
    expect(await events()).toEqual([{ occurred_on: request.from }]);
  });

  it('grants nothing when it is refused', async () => {
    const request = await decideAll(await ask(3), false);

    expect(request.status).toBe('REFUSED');
    expect(await theBalance(request)).toMatchObject({ entitled: 0, available: 0 });
    expect(await events()).toEqual([]);
  });

  it('draws a second request on what the first grant left, without granting again', async () => {
    const first = await decideAll(await ask(3, 1), true);
    const second = await decideAll(await ask(5, 1), true);
    const balance = await theBalance(second);

    expect(balance.entitled).toBe(5);
    expect(balance.available).toBe(5 - first.days - second.days);
    expect(await events()).toHaveLength(1);
  });

  it('grants once for two requests decided while both were waiting', async () => {
    const first = await ask(3, 1);
    const second = await ask(5, 1);

    await decideAll(first, true);
    await decideAll(second, true);

    expect((await theBalance(first)).entitled).toBe(5);
    expect(await events()).toHaveLength(1);
  });

  it('grants when the Chief Executive reverses a refusal into an approval', async () => {
    const refused = await decideAll(await ask(3), false);

    const reversed = await requests.reverse(DESKS.CEO(), refused.id, 'It qualifies');

    expect(reversed.request.status).toBe('APPROVED');
    expect(await theBalance(refused)).toMatchObject({ entitled: 5, taken: refused.days });
    expect(await events()).toHaveLength(1);
  });
});
