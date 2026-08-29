import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The example unit test. It guards two rules the README states but nothing
 * otherwise enforces: migrations sort in the order they were written, and every
 * one of them can be rolled back.
 *
 * Since LMS 114 it guards a third, which is how a column is declared: an instant
 * is `TIMESTAMPTZ` and a day is `DATE`, and neither is ever the other. NFR DAT
 * 03. That check reads the SQL rather than a database, so it fails on the
 * afternoon somebody writes the column instead of the evening the integration
 * suite runs — ../integration/time.test.ts asks the same question of a real
 * server, which is the authoritative answer.
 *
 * Domain unit tests start with LeaveCalculator and the case list in Technical
 * Design Document section 7.3.
 */
const MIGRATIONS_DIR = join(process.cwd(), 'server', 'migrations');
const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));

describe('migrations', () => {
  it('there is at least one', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s sorts by when it was written', (file) => {
    expect(file).toMatch(/^\d{17}_[a-z0-9-]+\.sql$/);
  });

  it.each(files)('%s has a down section that does something', (file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const marker = '-- Down Migration';

    expect(sql).toContain('-- Up Migration');
    expect(sql).toContain(marker);

    // A down section holding only comments is not a rollback, it is a promise.
    const down = sql.slice(sql.indexOf(marker) + marker.length);
    const statements = down
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();

    expect(statements).not.toBe('');
  });
});

/**
 * How a column that holds a moment or a day is declared. NFR DAT 03. LMS 114.
 *
 * Three rules, and each is the off by one day bug arriving from a different
 * direction:
 *
 *   A moment is `TIMESTAMPTZ`. `TIMESTAMP` without a zone is stored as whatever
 *   characters were handed to it, so the same instant written by two hosts is two
 *   different rows and neither of them says which was which. Postgres accepts it
 *   silently, which is the problem.
 *
 *   A day is `DATE`. A leave date with a time on it is a leave date that moves,
 *   and by the time anybody notices there are approved requests resting on it.
 *
 *   The name says which. `_at` is a moment and `_date` is a day, so that a column
 *   can be read correctly in a query nobody has written yet.
 *
 * Read from the SQL with the comments taken out, because the SQL is the source of
 * truth and every one of these files is mostly prose.
 */
describe('columns that hold a time', () => {
  /* Every type in this schema that carries a date or a time in it, longest first
     so that TIMESTAMP WITHOUT TIME ZONE is matched whole rather than as a bare
     TIMESTAMP followed by words. */
  const TEMPORAL_TYPE =
    /\b([a-z_]+)\s+(timestamp\s+with(?:out)?\s+time\s+zone|timestamptz|timestamp|date|time)\b/gi;

  const ACCEPTED = ['timestamptz', 'timestamp with time zone', 'date'];

  interface Declaration {
    file: string;
    name: string;
    type: string;
  }

  const declarations: Declaration[] = files.flatMap((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');

    return [...sql.matchAll(TEMPORAL_TYPE)].map(([, name, type]) => ({
      file,
      name: name.toLowerCase(),
      type: type.toLowerCase().replace(/\s+/g, ' '),
    }));
  });

  it('there are some to check', () => {
    expect(declarations.length).toBeGreaterThan(0);
  });

  it('a moment is stored with its zone, never as a bare timestamp', () => {
    const naked = declarations.filter((declaration) => !ACCEPTED.includes(declaration.type));

    expect(
      naked.map((declaration) => `${declaration.file}: ${declaration.name} ${declaration.type}`),
    ).toEqual([]);
  });

  it('a column named for a day is a date, and one named for a moment is not', () => {
    const wrong = declarations.filter(
      (declaration) =>
        (declaration.name.endsWith('_date') && declaration.type !== 'date') ||
        (declaration.name.endsWith('_at') && declaration.type === 'date'),
    );

    expect(
      wrong.map((declaration) => `${declaration.file}: ${declaration.name} ${declaration.type}`),
    ).toEqual([]);
  });
});

/**
 * Which side of the line reference data sits on. LMS 202, and LMS 106 before it.
 *
 * A production database is migrated and never seeded, so anything the system
 * cannot run without belongs to a migration: the roles, the standard Monday to
 * Friday week, and the seven leave types of FR 32. The fixture set in
 * server/seeds is the opposite thing — an organisation with the awkward cases in
 * it, reloaded and thrown away — and a leave type that arrived from there would
 * be a leave system that worked on every machine except the real one.
 *
 * The story's third criterion is "seed runs as a migration, not by hand", and
 * this is the half of it that can be checked without a database. That the seven
 * are really on a migrated database, and really have the shapes §4.3.1 gives
 * them, is ../integration/leave-type.test.ts.
 */
describe('the seven leave types are reference data', () => {
  const migrations = files.map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));

  /* An insert inside the file that creates the table proves a database started
     out right and can never run again. The set has an owner as well: a function
     that puts back whatever is missing, so that the repair for a lost type is a
     call rather than seven rows retyped at a psql prompt. */
  const owner = migrations.find((sql) =>
    /CREATE\s+FUNCTION\s+ensure_statutory_leave_types/i.test(sql),
  );

  it('are inserted by a migration, and by one that can be run again', () => {
    expect(migrations.some((sql) => /INSERT\s+INTO\s+leave_type\b/i.test(sql))).toBe(true);
    expect(owner).toBeDefined();
    expect(owner).toMatch(/INSERT\s+INTO\s+leave_type\b/i);
  });

  /* Guarded on both identifiers, because both are unique without regard to case
     and either being taken means somebody already has this type under a spelling
     of their own. A guard reading only the name is refused by
     leave_type_code_unique on the first database where HR reworded one. */
  it('are put back only where neither the name nor the code is already taken', () => {
    expect(owner).toMatch(/lower\(\s*existing\.name\s*\)/i);
    expect(owner).toMatch(/upper\(\s*existing\.code\s*\)/i);
  });

  /* It inserts and it never updates. Editing a type without waiting on a
     developer is FR 31, so a repair that reconciled the rows back to the values
     shipped here would take that away. */
  it('are never rewritten by the migration that puts them back', () => {
    expect(owner).not.toMatch(/UPDATE\s+leave_type\b/i);
    expect(owner).not.toMatch(/ON\s+CONFLICT/i);
  });

  /* The fixture seed may name these tables — since LMS 203 it has to, because it
     truncates one of them and calls the migration's function to put the reference
     data back — but it may never carry the data itself. A type or a figure written
     out in that file is a second source for something that has to have exactly
     one, and it would hold only on a machine somebody had seeded. */
  it('are not owned by the fixture seed, which no production database runs', () => {
    const fixtures = readFileSync(join(process.cwd(), 'server', 'seeds', 'seed.mjs'), 'utf8');

    expect(fixtures).not.toMatch(/INSERT\s+INTO\s+leave_type\b/i);
    expect(fixtures).not.toMatch(/INSERT\s+INTO\s+leave_entitlement_rule\b/i);
    expect(fixtures).not.toMatch(/'(ANNUAL|SICK|COMPASSIONATE|MATERNITY|PATERNITY)'/);
  });
});

/**
 * Where the approval chains live. FR 38a, LMS 204.
 *
 * The same side of the same line as the seven types and the figures they carry:
 * a production database is migrated and never seeded, and a leave system where
 * nobody is set up to approve anything is one where every request waits forever.
 *
 * What is checked here is the half that can be checked without a database — that
 * the chains are a migration's, that they have an owner that can put them back,
 * and that the owner refuses to rewrite a chain HR has since changed. That the
 * chains really are on a migrated database, and that unpaid leave really goes to
 * HR and the Chief Executive, is ../integration/approval-chain.test.ts.
 */
describe('the approval chains of FR 38a are reference data', () => {
  const migrations = files.map((file) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));

  const owner = migrations.find((sql) =>
    /CREATE\s+FUNCTION\s+ensure_statutory_approval_chains/i.test(sql),
  );

  it('are written by a migration, and by one that can be run again', () => {
    expect(owner).toBeDefined();
    expect(owner).toMatch(/INSERT\s+INTO\s+leave_type_approval_step\b/i);
  });

  /* It gives a chain to a type that has none and never touches a type that has
     one. FR 31 gives the chain to HR, so a repair that reconciled the rows back
     to the shipped values would take that away the first time somebody added the
     Chief Executive to the compassionate leave chain. */
  it('are never rewritten by the migration that puts them back', () => {
    expect(owner).not.toMatch(/UPDATE\s+leave_type_approval_step\b/i);
    expect(owner).not.toMatch(/DELETE\s+FROM\s+leave_type_approval_step\b/i);
    expect(owner).not.toMatch(/ON\s+CONFLICT/i);
  });

  /* The one place a leave type code may be read, and it is the same latitude
     ensure_statutory_entitlement_rules() takes when it joins by code: this is
     reference data being placed once, not a rule deciding where a request goes.
     Nothing above the database may do it — that is design principle 5 — and the
     rest of the tree is asserted to keep off it below. */
  it('name the two unpaid types once, in the function that seeds them', () => {
    expect(owner).toMatch(/'UNPAID'/);
    expect(owner).toMatch(/'MAT_EXT_UNPAID'/);
  });

  /**
   * And nothing above the database names one at all.
   *
   * Design principle 5, stated as a test rather than as a paragraph: "Counting
   * basis and approval chain vary by leave type... Both are configuration. If
   * either appears as an `if` on a type code, that is a bug." The two most
   * tempting places for one are the leave calculator that does not exist yet and
   * the routing that does not either, so the guard is worth having before either
   * arrives rather than after.
   *
   * Comments are stripped first, because the source explains at length why a code
   * may not be read and would otherwise fail its own rule.
   */
  it('are never a type code read by the application', () => {
    const sources = readdirSync(join(process.cwd(), 'server', 'src'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((file) => file.endsWith('.ts'));

    const naming = sources.filter((file) => {
      const code = readFileSync(join(process.cwd(), 'server', 'src', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ');

      return /'(ANNUAL|SICK|COMPASSIONATE|MATERNITY|PATERNITY|UNPAID|MAT_EXT_UNPAID)'/.test(code);
    });

    expect(naming).toEqual([]);
  });
});
