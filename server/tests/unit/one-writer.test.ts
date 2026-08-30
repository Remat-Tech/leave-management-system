import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * There is one writer of balance movements. FR 26, §8.2. LMS 212.
 *
 * The story's first acceptance criterion, and the only one of the four that cannot be
 * proved by running anything. The other three are behaviour — available is the right
 * subtraction, the three operations do what they say, the row is locked while it is
 * checked — and a test can watch them happen. "Only writer" is a claim about code
 * that does not exist, so the only way to check it is to read the source.
 *
 * ## What this is actually protecting against
 *
 * Not a rogue `UPDATE leave_balance`. The database has refused those on every
 * connection since LMS 211, and `db/schema.ts` types the columns so one does not
 * compile.
 *
 * The realistic second writer is an honest service. The rollover story needs to post
 * a `GRANT`, so it takes a `LedgerRepository` and posts one — reasonably, correctly,
 * and without the lock, because a grant has nothing to check. Then the request story
 * follows the pattern the rollover set, posts a `DEDUCTION` the same way, and the
 * approval that was supposed to draw down a hold instead subtracts five days a second
 * time. Nothing about that arrives as a bug report; it arrives as a balance that is
 * wrong by five days, in a system whose whole claim is that a figure can be explained.
 *
 * So the rule is not "be careful when you post an entry", it is "there is one door".
 * A story that needs a movement the door does not offer adds a method to
 * `BalanceService` — where the lock, the rule and the policy already are — rather than
 * a second way in.
 *
 * ## Read from the source, with the comments taken out
 *
 * The same technique ./migrations.test.ts uses for the rules it reads out of the SQL,
 * and for the same reason: these files are mostly prose, and every one of them
 * discusses the thing being searched for at length.
 */

const SOURCE = join(process.cwd(), 'server', 'src');

const sources = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({
    file,
    code: readFileSync(join(SOURCE, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' '),
  }));

/**
 * The three files that may name the ledger repository, and what each is for.
 *
 * `ledger-repository.ts` declares it. `transaction.ts` constructs it, because a
 * movement is written inside a transaction and that file is the seam that owns them.
 * `balance-service.ts` posts through it, and is the door.
 *
 * `ledger-service.ts` is deliberately not here. It reads the account and wrote
 * nothing after LMS 212 moved `adjust` and `correct` out of it.
 */
const MAY_POST = [
  'repositories/ledger-repository.ts',
  'repositories/transaction.ts',
  'services/balance-service.ts',
];

describe('one writer of balance movements', () => {
  it('there is source to read', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  /* A `post()` or `postAll()` anywhere else is a second door, whatever it is called
     and however carefully it was written. */
  it('and nothing outside those three posts a ledger entry', () => {
    const posting = sources.filter(
      ({ file, code }) =>
        !MAY_POST.includes(file.replace(/\\/g, '/')) && /\.postAll?\s*\(/.test(code),
    );

    expect(posting.map(({ file }) => file)).toEqual([]);
  });

  /* And nothing outside them holds one to post through. A service that takes a
     `LedgerRepository` has taken the ability rather than the habit. */
  it('and nothing outside those three holds a ledger repository', () => {
    const holding = sources.filter(
      ({ file, code }) =>
        !MAY_POST.includes(file.replace(/\\/g, '/')) &&
        file !== 'services/ledger-service.ts' &&
        /LedgerRepository/.test(code),
    );

    expect(holding.map(({ file }) => file)).toEqual([]);
  });

  /**
   * `LedgerService` keeps one, and reads through it, and that is the exception the
   * test above names rather than hides.
   *
   * Reading the account is what a ledger service is for. What it may not do is write,
   * and this is the half of that which matters: the file that most obviously *could*
   * post an entry is asserted not to.
   */
  it('and the ledger service reads the account without writing to it', () => {
    const ledger = sources.find(
      ({ file }) => file.replace(/\\/g, '/') === 'services/ledger-service.ts',
    );

    expect(ledger).toBeDefined();
    expect(ledger?.code).toMatch(/entriesFor|correctionsAround/);
    expect(ledger?.code).not.toMatch(/\.postAll?\s*\(/);
    expect(ledger?.code).not.toMatch(/validateNewLedgerEntry/);
  });

  /**
   * And the door takes the lock.
   *
   * A weaker check than the ones above and worth having anyway: it fails on the
   * change that would quietly undo §8.2, which is somebody replacing `holdStill` with
   * the ordinary read while chasing a deadlock or a slow test. The integration suite
   * proves the lock works; this notices if it stops being asked for.
   */
  it('and the one writer holds the balance still before it checks one', () => {
    const service = sources.find(
      ({ file }) => file.replace(/\\/g, '/') === 'services/balance-service.ts',
    );

    expect(service?.code).toMatch(/holdStill\(/);
    expect(service?.code).toMatch(/allOrNothing\(/);
  });

  /* And nothing but the one writer consults the three rules. A caller that checked
     the days itself would be deciding outside the window that makes the answer
     true. */
  it('and nothing else decides whether the days are there', () => {
    const deciding = sources.filter(
      ({ file, code }) =>
        file.replace(/\\/g, '/') !== 'services/balance-service.ts' &&
        file.replace(/\\/g, '/') !== 'domain/balance.ts' &&
        /daysTo(Reserve|Commit|Release)\s*\(/.test(code),
    );

    expect(deciding.map(({ file }) => file)).toEqual([]);
  });
});
