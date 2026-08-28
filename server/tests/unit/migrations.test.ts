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
