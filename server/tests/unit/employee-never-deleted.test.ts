import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * There is no way to delete an employee. FR 06, LMS 102.
 *
 * The other two halves of this are elsewhere and are both stronger than this
 * file. lms_app holds no DELETE privilege on the table, and a trigger refuses the
 * statement even on the owner connection; the integration suite proves both.
 *
 * What neither of those catches is somebody writing the delete in the first
 * place. They catch it when it runs, which for a route nobody has exercised yet
 * means in front of whoever pressed the button. This is the cheap check that
 * catches it at `npm test`, and it is the only one of the three that will still
 * be looking when the API and the screens arrive — it reads whatever source is
 * there, so a `DELETE /employees/:id` added in Phase 5 fails this test on the
 * day it is written.
 *
 * If a hard delete is ever genuinely needed, this test is the conversation. Do
 * not quietly add the path to the exceptions; FR 06 says the record stays.
 */

const ROOTS = ['server/src', 'client/src'];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Ways to delete an employee, and what to say when one turns up. */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  {
    pattern: /deleteFrom\s*\(\s*['"`]employee['"`]/,
    // The repository has no such method. This is what stops one being added.
    what: 'a Kysely delete against the employee table',
  },
  {
    pattern: /\bDELETE\s+FROM\s+employee\b/i,
    what: 'a raw SQL delete against the employee table',
  },
  {
    // `router.delete('/employees/:id')`, and anything shaped like it. Scoped to a
    // quoted path so that storage.delete(key) and the like are left alone.
    pattern: /\.delete\s*\(\s*['"`][^'"`]*employee/i,
    what: 'an HTTP DELETE route for an employee',
  },
  {
    pattern: /\bTRUNCATE\b[^\n;]*\bemployee\b/i,
    // The seed truncates, but the seed is not application source and is not read
    // here. Nothing under src has any business doing it.
    what: 'a truncate of the employee table',
  },
];

/** Every source file under the roots that exist. A client is coming; it is not here yet. */
function sourceFiles(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // The root is not in the tree yet.
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (SOURCE.test(entry.name)) {
        found.push(path);
      }
    }
  };

  for (const root of ROOTS) {
    walk(join(process.cwd(), root));
  }

  return found;
}

const files = sourceFiles();

describe('no delete path exists', () => {
  it('has source to check, so a passing run means something', () => {
    // Without this the suite would pass just as happily if the walk found
    // nothing at all, which is the failure mode of every test like this one.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)('nothing in the application is $what', ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
