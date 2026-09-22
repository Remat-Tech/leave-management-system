/**
 * Grants a leave year's entitlements to everybody owed them. FR 31.
 *
 * The grant is what turns an entitlement figure into a balance: the figures are rules, and a
 * balance is the sum of the ledger entries posted against them. The server grants the current
 * year daily; this is for granting a year by hand, without waiting for the server.
 *
 *   npx tsx scripts/grant-leave-year.ts 2026
 *
 * **What it writes cannot be edited.** A ledger entry is permanent and a mistake is corrected
 * by an adjustment on top of it, so check the start dates first: annual leave is pro-rated
 * from each person's, and a wrong start date is a wrong entitlement for good.
 *
 * Safe to run twice. The job grants nobody a second year, and finishes anybody the first run
 * did not reach.
 */

import { config } from 'dotenv';
import { Client } from 'pg';
import { theSystem } from '../server/src/auth/actor.js';
import { Guard } from '../server/src/auth/policy.js';
import { databaseFor } from '../server/src/db/index.js';
import { Transactions } from '../server/src/db/transaction.js';
import { AnnualGrant } from '../server/src/features/entitlement/annual-grant.job.js';
import { BalanceRepository } from '../server/src/features/balance/balance.db.js';
import { BalanceService } from '../server/src/features/balance/balance.service.js';
import { EmployeeRepository } from '../server/src/features/employee/employee.db.js';
import { EntitlementRuleRepository } from '../server/src/features/entitlement/entitlement-rule.db.js';
import { EntitlementRuleService } from '../server/src/features/entitlement/entitlement-rule.service.js';
import { LeaveTypeRepository } from '../server/src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../server/src/features/leave-year/leave-year.db.js';
import {
  earliestOpenDayFrom,
  LeaveYearService,
} from '../server/src/features/leave-year/leave-year.service.js';

config();

const actor = theSystem('granting a leave year');

async function main(): Promise<void> {
  const label = process.argv[2];

  if (!label) {
    throw new Error('Usage: npx tsx scripts/grant-leave-year.ts <leave year label, e.g. 2026>');
  }

  const url = process.env.DATABASE_MIGRATION_URL;

  if (url === undefined) {
    throw new Error('DATABASE_MIGRATION_URL is not set. This runs as the owner. See .env.example.');
  }

  const target = new URL(url);
  process.stdout.write(`database: ${target.hostname}${target.pathname} as ${target.username}\n\n`);

  const db = databaseFor(url);
  const guard = new Guard();
  const employees = new EmployeeRepository(db);
  const years = new LeaveYearService(new LeaveYearRepository(db), guard);

  const job = new AnnualGrant(
    new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db)),
    years,
    new EntitlementRuleService(
      new EntitlementRuleRepository(db),
      guard,
      earliestOpenDayFrom(new LeaveYearRepository(db)),
    ),
    employees,
    new LeaveTypeRepository(db),
  );

  try {
    const year = await years.byLabel(actor, label);

    if (year === undefined) {
      throw new Error(`There is no leave year called "${label}".`);
    }

    await job.run(actor, year.id);
    await report(url, year.id);
  } finally {
    await db.destroy();
  }
}

/** What everybody now holds, read back off the balances the grant moved. */
async function report(url: string, leaveYearId: string): Promise<void> {
  const owner = new Client({ connectionString: url });
  await owner.connect();

  try {
    const { rows } = await owner.query<{ who: string; type: string; entitled: string }>(
      `SELECT e.employee_number || '  ' || e.first_name || ' ' || e.last_name AS who,
              t.name AS type,
              b.entitled
         FROM leave_balance b
         JOIN employee e ON e.id = b.employee_id
         JOIN leave_type t ON t.id = b.leave_type_id
        WHERE b.leave_year_id = $1 AND b.entitled <> 0
        ORDER BY e.employee_number, t.name`,
      [leaveYearId],
    );

    let last = '';
    for (const row of rows) {
      if (row.who !== last) {
        process.stdout.write(`\n${row.who}\n`);
        last = row.who;
      }
      process.stdout.write(`  ${row.type.padEnd(14)} ${Number(row.entitled).toFixed(2)}\n`);
    }
  } finally {
    await owner.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
