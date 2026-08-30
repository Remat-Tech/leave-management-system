import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type BalanceDisagreement,
  columnsThatDiffer,
  daysAtStake,
  type FiveFigures,
  isClean,
  type Reconciliation,
  reportOf,
} from '../../src/domain/reconciliation.js';
import { discrepancyEmail } from '../../src/jobs/balance-reconciliation.js';

/**
 * What a discrepancy means, once the database has found one. §7.4. LMS 213.
 *
 * A short file, and for the same reason ./balance.test.ts is short: the arithmetic this
 * story is about is not in TypeScript. What the ledger says a balance should be is
 * `what_the_ledger_says`, a view, which is §5.7's projection lifted out of the function
 * that writes the cache — so the writer and the checker read one definition, and a
 * reconciliation cannot end up agreeing only with itself.
 * ../integration/reconciliation.test.ts is where the finding is proved.
 *
 * What is here is the half that decides whether the alert is worth reading: which
 * columns differ, which way the difference goes, and what the email actually says. That
 * last one matters more than it looks. This message is read once, at nine on a Monday,
 * by somebody who has to decide whether it is a half day of nothing or a Sunday night
 * phone call — and an alert nobody can act on is an alert that trains people to ignore
 * the next one.
 */

const NOTHING: FiveFigures = {
  entitled: 0,
  carriedOver: 0,
  adjustment: 0,
  taken: 0,
  pending: 0,
};

function disagreement(
  cached: Partial<FiveFigures>,
  ledger: Partial<FiveFigures>,
  overrides: Partial<BalanceDisagreement> = {},
): BalanceDisagreement {
  return {
    employeeId: '11',
    employeeNumber: 'RH-0011',
    leaveTypeId: '1',
    leaveTypeName: 'Annual Leave',
    leaveYearId: '1',
    leaveYearLabel: '2026',
    hasCachedRow: true,
    cached: { ...NOTHING, ...cached },
    ledger: { ...NOTHING, ...ledger },
    ...overrides,
  };
}

function run(overrides: Partial<Reconciliation> = {}): Reconciliation {
  return {
    checkedAt: new Date('2026-09-01T02:00:00Z'),
    balancesChecked: 412,
    disagreements: [],
    told: [],
    couldNotTell: [],
    ...overrides,
  };
}

describe('which columns disagree', () => {
  it('names the ones that differ and none of the ones that do not', () => {
    const out = disagreement({ entitled: 15, taken: 2 }, { entitled: 20, taken: 0 });

    expect(columnsThatDiffer(out)).toEqual(['entitled', 'taken']);
  });

  /* In the order a balance reads rather than the order they were found, so that two
     disagreements in one report line up under each other. */
  it('and names them in the order the five columns read', () => {
    const out = disagreement(
      { pending: 1, entitled: 1, taken: 1, adjustment: 1, carriedOver: 1 },
      NOTHING,
    );

    expect(columnsThatDiffer(out)).toEqual([
      'entitled',
      'carriedOver',
      'adjustment',
      'taken',
      'pending',
    ]);
  });
});

describe('how many days it is worth', () => {
  /**
   * Signed rather than a size, and the sign is the urgency.
   *
   * A cache showing more than the ledger supports lets somebody book leave they have
   * not got. A cache showing less has quietly taken days off them — and that is the
   * story's own case, because nobody ever reports having been given too much.
   */
  it('is positive when the cache flatters somebody', () => {
    expect(daysAtStake(disagreement({ entitled: 20 }, { entitled: 15 }))).toBe(5);
  });

  it('and negative when it has quietly taken days off them', () => {
    expect(daysAtStake(disagreement({ taken: 8 }, { taken: 3 }))).toBe(-5);
  });

  /* Held days are subtracted on both sides, so a disagreement about `pending` is worth
     as much as one about `entitled` and in the opposite direction. */
  it('and counts days spoken for the same way a balance does', () => {
    expect(daysAtStake(disagreement({ pending: 0 }, { pending: 5 }))).toBe(5);
  });

  /* §8.6d's hundredths survive the subtraction rather than arriving with fourteen
     decimal places on the end of them. */
  it('and stays at the precision the columns hold', () => {
    expect(daysAtStake(disagreement({ entitled: 10.08 }, { entitled: 10.07 }))).toBe(0.01);
  });
});

describe('the report', () => {
  it('says everything agreed, and how much was checked', () => {
    const clean = run();

    expect(isClean(clean)).toBe(true);
    expect(reportOf(clean)).toContain('All 412 of them agree');
  });

  /**
   * And a report of a discrepancy says four things, each of which somebody needs.
   *
   * Who it is about, in the handle every other report in this system uses. Which
   * figures disagree and what each side says. How many days the person is out by. And
   * that nothing has been changed — which is the part a generated report usually
   * leaves out and the part that stops somebody assuming it has been dealt with.
   */
  it('names the balance, both figures, the days at stake, and that nothing was changed', () => {
    const report = reportOf(
      run({ disagreements: [disagreement({ entitled: 15 }, { entitled: 20 })] }),
    );

    expect(report).toContain('RH-0011 — Annual Leave, 2026');
    expect(report).toContain('Entitled: the balance says 15, the ledger says 20');
    expect(report).toContain('Available is out by 5 days, against them');
    expect(report).toContain('Nothing has been changed');
    expect(report).toContain('the ledger is what actually happened');
  });

  /* The worst of the three shapes, and the one that reads as nothing at all unless the
     report says so: the ledger has movements and there is no cached balance. Every
     screen shows that person nought days. */
  it('and says outright when a balance does not exist at all', () => {
    const report = reportOf(
      run({
        disagreements: [disagreement({}, { entitled: 20 }, { hasCachedRow: false })],
      }),
    );

    expect(report).toContain('There is no cached balance at all');
    expect(report).toContain('showing nought days');
  });

  it('and counts one balance as one rather than as 1 balances', () => {
    const one = reportOf(run({ disagreements: [disagreement({ taken: 1 }, {})] }));

    expect(one).toContain('1 leave balance disagrees with the ledger');
    expect(one).toContain('out by 1 day,');
  });

  /**
   * And a report that could not be delivered says so inside itself.
   *
   * Which reads oddly until you notice where it ends up: in the copy that *was*
   * delivered, and in whatever the scheduler logged. A discrepancy nobody was told
   * about is the precise situation this job exists to prevent, so the failure to tell
   * somebody travels with the thing they were supposed to be told.
   */
  it('and carries the addresses it could not reach', () => {
    const report = reportOf(
      run({
        disagreements: [disagreement({ entitled: 15 }, { entitled: 20 })],
        told: ['ama@rematholdings.com'],
        couldNotTell: [{ to: 'kojo@rematholdings.com', because: 'SMTP is not answering.' }],
      }),
    );

    expect(report).toContain('This report could not be sent to:');
    expect(report).toContain('kojo@rematholdings.com — SMTP is not answering.');
  });
});

/**
 * And nothing in the reconciliation can put a balance right. The third criterion.
 *
 * Read out of the source, the way ./one-writer.test.ts reads the rule it guards, and
 * for the same reason: this is a claim about code that is not there. Every other test
 * in this file and in ../integration/reconciliation.test.ts would still pass if a
 * well-meaning line were added that rebuilt each disagreeing balance — the integration
 * suite would catch it in one assertion, and a reader would have to know to look.
 *
 * The temptation is not hypothetical. `rebuild_one_balance_from_the_ledger()` is one
 * call away, it is correct, and calling it would empty the report every night. It would
 * also destroy the only evidence that something in this system does not work.
 */
describe('nothing in the reconciliation corrects anything', () => {
  const files = ['../../src/jobs/balance-reconciliation.ts', '../../src/domain/reconciliation.ts'];

  it.each(files)('%s never calls the rebuild', (file) => {
    const code = readFileSync(join(import.meta.dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    expect(code).not.toMatch(/rebuild_one_balance_from_the_ledger/);
    expect(code).not.toMatch(/BalanceRepository|LedgerRepository|BalanceService/);
  });

  /* And the repository it does hold offers nothing to call. Two reads, and the file is
     short enough that a third would be a decision somebody made on purpose. */
  it('and the repository it holds offers only reads', () => {
    const code = readFileSync(
      join(import.meta.dirname, '../../src/repositories/reconciliation-repository.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    expect(code).not.toMatch(/insertInto|updateTable|deleteFrom|rebuild_one_balance/);
    expect([...code.matchAll(/^\s{2}async\s+(\w+)/gm)].map(([, name]) => name)).toEqual([
      'disagreements',
      'balancesChecked',
    ]);
  });
});

describe('the alert', () => {
  /* Somebody scanning a mailbox has to tell "one balance is out by half a day" from
     "four hundred are" without opening anything: a Monday morning job and a Sunday
     night phone call look identical otherwise. */
  it('carries the count in the subject, so a mailbox can be triaged', () => {
    const one = discrepancyEmail(
      'ama@rematholdings.com',
      run({ disagreements: [disagreement({ taken: 1 }, {})] }),
      'the report',
    );
    const many = discrepancyEmail(
      'ama@rematholdings.com',
      run({ disagreements: [disagreement({}, {}), disagreement({}, {})] }),
      'the report',
    );

    expect(one.subject).toBe('A leave balance disagrees with the ledger');
    expect(many.subject).toBe('2 leave balances disagree with the ledger');
    expect(one.to).toBe('ama@rematholdings.com');
    expect(one.text).toBe('the report');
  });
});
