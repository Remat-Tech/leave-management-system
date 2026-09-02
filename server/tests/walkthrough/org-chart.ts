import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Kysely } from 'kysely';

import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import type { Employee } from '../../src/features/employee/employee.js';
import {
  buildOrgChart,
  concerns,
  renderOrgChart,
  renderOrgChartAsMermaid,
  type OrgChartNode,
} from '../../src/features/employee/org-chart.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { EmployeeService } from '../../src/features/employee/employee.service.js';
import { seed } from '../../seeds/seed.mjs';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * A walkthrough of the organisation chart, for a person rather than for a build.
 * FR 09 and LMS 107.
 *
 * The story is an HR Officer spotting a wrong or missing manager before it
 * causes a stuck request, and it is a story about *looking*. Assertions can
 * prove the tree has the right shape — ../unit/org-chart.test.ts does, against
 * organisations no database would accept — but they cannot show that the shape
 * is one somebody can read at a glance, and that is the whole claim being made.
 * So this prints, and you judge it.
 *
 * It builds a disposable database of its own and drops it again, so nothing you
 * have is touched. It needs no mail server: unlike ./sign-in.ts there is nothing
 * here that leaves the machine.
 *
 * Run it with:
 *   npm run chart
 *
 * Needs local Postgres 17 (TEST_DATABASE_URL). It is deliberately outside both
 * test configs, for the reason every walkthrough is: it prints rather than
 * asserts.
 *
 * The six steps are the story in order. The organisation as it should be, and
 * as Mermaid for anywhere a diagram can be drawn. Then a manager leaves and the
 * chart says so. Then the same chart drawn without the leavers, which is the
 * decision this story turned on and the one worth seeing rather than reading
 * about. Then a loop, which the database refuses and the chart draws anyway.
 * Then the refusal, because a chart of who answers to whom is not for everybody.
 */

loadEnv();

let adminUrl: string;
let databaseName: string;

let db: Kysely<Database>;
let admin: Client;
let employees: EmployeeService;
let people: Record<string, string>;

/**
 * Nobody, holding every role, doing work no person asked for. The same actor
 * ./sign-in.ts builds its organisation with, and for the same reason: whether
 * the policies refuse the right people is ../unit/policy.test.ts's question, not
 * this file's — except in step 6, which is entirely about a refusal and uses a
 * real person to provoke it.
 *
 * The guard is given a denial log that prints where you can see it, rather than
 * the default one that writes to stderr. Not to hide anything — the opposite.
 * Step 6 is about a refusal, and the entry it writes is half of what that step
 * is showing, so it belongs in the narration rather than in whatever the test
 * runner does with stderr. Nothing else here provokes one.
 */
const system = theSystem('the organisation chart walkthrough');
const guard = new Guard({
  record(attempt) {
    say(`  denial log: ${JSON.stringify(attempt)}`);
  },
});

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function rule(title: string): void {
  say(`--- ${title} ${'-'.repeat(Math.max(0, 71 - title.length))}`);
  say();
}

/** The chart, indented so it reads as output rather than as more narration. */
function draw(text: string): void {
  for (const line of text.split('\n')) {
    say(line === '' ? '' : `  ${line}`);
  }
  say();
}

beforeAll(async () => {
  adminUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_MIGRATION_URL || '';
  if (!adminUrl) {
    throw new Error('Set TEST_DATABASE_URL (local Postgres 17) in .env.');
  }

  databaseName = `lms_chart_${randomBytes(4).toString('hex')}`;

  const owner = new Client({ connectionString: adminUrl });
  await owner.connect();
  await owner.query(`CREATE DATABASE "${databaseName}"`);
  await owner.end();

  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const databaseUrl = url.toString();

  say();
  say(`Building a disposable database: ${databaseName}`);
  execSync('npm run migrate up', {
    env: { ...process.env, DATABASE_MIGRATION_URL: databaseUrl },
    stdio: 'pipe',
  });

  db = databaseFor(databaseUrl);
  admin = new Client({ connectionString: databaseUrl });
  await admin.connect();

  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
  );

  people = (await seed(admin)) as Record<string, string>;

  say('Seeded the fixture organisation: thirteen people, five levels, one leaver.');
  say();
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();

  const owner = new Client({ connectionString: adminUrl });
  await owner.connect();
  await owner.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await owner.end();

  say();
  say(`Dropped ${databaseName}. Nothing else was touched.`);
  say();
});

describe('the organisation chart', () => {
  it('1. draws the whole organisation from the manager relationships', async () => {
    rule('The organisation as it should be. FR 09');

    const chart = await employees.orgChart(system);

    say(`  ${chart.total} people, ${chart.roots.length} line, ${chart.depth} levels deep.`);
    say();
    draw(renderOrgChart(chart));

    say('  Kwame at the top, Adwoa and Abena at the fifth level. The connecting');
    say('  lines are the point: at twelve spaces of plain indentation nobody can');
    say('  tell which of three people at the same depth report to which manager,');
    say('  and that is exactly the reading the story asks for.');
    say();
  });

  it('2. draws the same thing as a diagram, for anywhere text is not enough', async () => {
    rule('The same chart, as Mermaid');

    const drawn = renderOrgChartAsMermaid(await employees.orgChart(system));

    draw(drawn.split('\n').slice(0, 8).join('\n'));
    say(`  ... ${drawn.split('\n').length - 8} more lines.`);
    say();
    say('  Paste it into a pull request, an issue or a markdown document and it');
    say('  is a picture. No dependency, nothing to keep patched, and it is what');
    say('  the front end will replace rather than what it will wrap.');
    say();
  });

  it('3. shows the whole team when their manager leaves', async () => {
    rule('Kofi Boateng, Operations Team Lead, leaves. FR 06');

    await employees.terminate(system, people.teamLead, { exitDate: '2026-08-31' });

    const chart = await employees.orgChart(system);

    say('  Nobody edited his three reports, so no write time check ever ran on');
    say('  them and every one of their records is still perfectly valid:');
    say();
    draw(branchAround(chart.roots[0].node, people.opsManager));

    const warnings = await employees.reportingLineWarnings(system);
    for (const warning of warnings) {
      say(`  warning: ${warning.code} — ${warning.message}`);
    }
    say();
    say('  The warning is a sentence and the chart is a shape, and the two catch');
    say('  different mistakes. The warning finds the manager who has left. Only');
    say('  the chart finds a new starter put under the wrong team lead, because');
    say('  nothing is invalid about that record — it is simply in the wrong');
    say('  place, and being in the wrong place is a thing you see.');
    say();
  });

  it('4. keeps the leaver on the chart, because dropping him hides the fault', async () => {
    rule('The same organisation, charted without its leavers');

    const stillHere = await employees.list(system, { activeOnly: true });
    const chart = buildOrgChart(stillHere);

    say(
      `  ${chart.roots.length} lines rather than one, and ${concerns(chart).length} of them say why:`,
    );
    say();
    draw(renderOrgChart(chart));

    say('  Adwoa and Abena now hang off nothing. That is a true reading of the');
    say('  set it was handed and it is the wrong chart to show HR, which is why');
    say('  EmployeeService.orgChart() charts everybody and marks the leaver');
    say('  instead. A chart that drops the people it could not place looks');
    say('  correct precisely when the organisation is not.');
    say();
  });

  it('5. draws a reporting line that loops, which the database will not hold', async () => {
    rule('A circle. FR 03');

    try {
      await employees.update(system, people.ceo, { managerId: people.opsManager });
      say('  The update was accepted, which it should never be.');
    } catch (error) {
      say(`  update(ceo, { managerId: opsManager }) -> ${(error as Error).name}`);
      say(`    "${(error as Error).message}"`);
    }
    say();
    say('  Refused before it reached the database, and the deferred trigger would');
    say('  have refused it after. So a loop takes bad data from somewhere else —');
    say('  a restored backup, an import that predates the trigger — and the chart');
    say('  still has to survive being handed one:');
    say();

    const everybody = await employees.list(system);
    const looped = everybody.map((employee) =>
      employee.id === people.ceo ? { ...employee, managerId: people.opsManager } : employee,
    );

    const chart = buildOrgChart(looped);
    const circle = concerns(chart)[0];

    say(`  ! ${circle?.concern}`);
    say();
    say(`  Still ${chart.total} people on the chart, every one of them placed, and`);
    say('  it returned. To anything that walks a loop without remembering where');
    say('  it has been that line is infinitely deep, which is why the tree is');
    say('  built and drawn with explicit stacks rather than by recursion. Five');
    say('  levels is a fact about these fixtures; it is not a ceiling.');
    say();
  });

  it('6. is refused to somebody who may not read everybody', async () => {
    rule('Who the chart is for. LMS 112');

    const adwoa = signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });

    say('  Adwoa Frimpong, Operations Officer, EMPLOYEE and nothing else.');
    say();

    try {
      await employees.orgChart(adwoa);
      say('  She got the chart, which she should not have.');
    } catch (error) {
      say(`  orgChart(adwoa) -> ${(error as Error).name}`);
      say(`    "${(error as Error).message}"`);
    }
    say();
    say('  Two things in that. The sentence she is told carries nothing — it is');
    say('  the same one an id that is nobody gets, so neither answer tells her');
    say('  what exists. The line above it is the denial log, which carries the');
    say('  lot, because an authorisation layer that refuses silently protects the');
    say('  records and tells nobody that somebody went looking. NFR SEC 03.');
    say();
    say('  The chart names everybody, their job title and who they answer to, so');
    say('  it is the staff list with the lines drawn in and it goes to the same');
    say('  people: HR_OFFICER, HR_ADMIN, SYS_ADMIN. Not to a manager for their');
    say('  own branch either — that is the skip level read employee-policy.ts');
    say('  declines, arriving through a different door.');
    say();
  });
});

/**
 * One manager and the people under them, drawn on their own.
 *
 * The whole organisation is thirteen lines and step 3 is about three of them, so
 * this finds the branch and charts it by itself. It is the same builder and the
 * same renderer — a chart of a subset is an ordinary thing to ask for, and this
 * is what it looks like.
 */
function branchAround(root: OrgChartNode, managerId: string): string {
  const found = findNode(root, managerId);

  return found === null ? '(not found)' : renderOrgChart(buildOrgChart(flatten(found)));
}

function findNode(node: OrgChartNode, id: string): OrgChartNode | null {
  if (node.employee.id === id) {
    return node;
  }

  for (const report of node.reports) {
    const found = findNode(report, id);
    if (found !== null) {
      return found;
    }
  }

  return null;
}

/**
 * A branch back to a flat list, with its top cut loose so that charting it again
 * makes it a line of its own rather than one hanging off a manager who is not
 * in the set.
 */
function flatten(node: OrgChartNode): Employee[] {
  const found: Employee[] = [{ ...node.employee, managerId: null }];
  const pending: OrgChartNode[] = [...node.reports];

  while (pending.length > 0) {
    const next = pending.pop() as OrgChartNode;

    found.push(next.employee);
    pending.push(...next.reports);
  }

  return found;
}
