import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The example unit test. It guards two rules the README states but nothing
 * otherwise enforces: migrations sort in the order they were written, and every
 * one of them can be rolled back.
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
