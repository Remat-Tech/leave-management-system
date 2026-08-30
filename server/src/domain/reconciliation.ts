/**
 * Checking the cache against the record it is a cache of. §7.4. LMS 213.
 *
 * Design principle 1 says "the ledger is the truth; balances are a cache. If they ever
 * disagree, the ledger wins and the balance is rebuilt." Three stories have now taken
 * that on trust. This is where "if they ever disagree" stops being a hypothetical and
 * becomes something the system asks itself every night.
 *
 * ## What is here, and what is deliberately in SQL
 *
 * **No arithmetic.** What the ledger says a balance should be is
 * `what_the_ledger_says` in the nightly-balance-reconciliation migration, which is
 * §5.7's projection lifted out of `rebuild_one_balance_from_the_ledger()` so that the
 * writer and the checker read one definition. A reconciliation that computed its own
 * expected figures in TypeScript would be the second copy LMS 210 refused to write —
 * and it would have the special property of being able to agree only with itself.
 *
 * So this file takes a disagreement the database found and says what it *means*: which
 * columns differ, how many days are at stake, and how to put it into a sentence
 * somebody reading it at nine on a Monday can act on.
 *
 * ## Nothing here corrects anything, and nothing here can
 *
 * The third acceptance criterion. There is no function below that returns a repaired
 * balance, and the job that uses this holds a repository that can only read.
 *
 * The temptation is real rather than theoretical: the rebuild function exists, it is
 * correct, and calling it for every disagreeing balance would empty the report. It
 * would also destroy the evidence. A discrepancy is the only sign that something in
 * this system does not work; a job that erases that sign nightly is a job that
 * guarantees nobody ever finds the cause, and the second time it happens it will be
 * for a reason that also lost days.
 *
 * Putting a balance right is a person's decision, made after reading the ledger.
 */

import type { BalanceBucket } from './balance.js';

/** The five figures, from one side or the other. */
export interface FiveFigures {
  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
}

/**
 * One balance where the cache and the ledger do not agree.
 *
 * Named for the employee number, the leave type and the year rather than for three
 * ids, because the only thing anybody does with one of these is go and look.
 */
export interface BalanceDisagreement {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveYearId: string;
  leaveYearLabel: string;
  /**
   * False where the ledger has movements and there is no cached row at all.
   *
   * The worst of the three shapes and the one a join from `leave_balance` could never
   * find: somebody's balance simply does not exist, so every screen shows them nought
   * days while the ledger says otherwise. It reads identically to a genuine row of
   * noughts, which is why it is carried as a field rather than inferred.
   */
  hasCachedRow: boolean;
  cached: FiveFigures;
  ledger: FiveFigures;
}

/** What one run found. */
export interface Reconciliation {
  checkedAt: Date;
  /** How many balances were compared, from both sides. */
  balancesChecked: number;
  disagreements: readonly BalanceDisagreement[];
  /** The addresses the alert reached. Empty on a clean run. */
  told: readonly string[];
  /**
   * The addresses it could not reach, and the reason.
   *
   * Carried rather than thrown, because the job's contract is to report and a report
   * that says "I could not tell Ama" is still a report. A throw would lose the
   * discrepancy along with the failure, which is the one outcome worse than either.
   */
  couldNotTell: readonly { to: string; because: string }[];
}

/** Whether the cache and the ledger agreed about everything. */
export function isClean(run: Reconciliation): boolean {
  return run.disagreements.length === 0;
}

/**
 * Which of the five columns differ. §5.7's own names.
 *
 * In the order a balance reads rather than in the order they were found, so that two
 * disagreements in a report line up under each other.
 */
export function columnsThatDiffer(disagreement: BalanceDisagreement): BalanceBucket[] {
  const { cached, ledger } = disagreement;

  return (['entitled', 'carriedOver', 'adjustment', 'taken', 'pending'] as const).filter(
    (bucket) => cached[bucket] !== ledger[bucket],
  );
}

/**
 * How many days the disagreement is worth, as the person whose balance it is would
 * feel it.
 *
 * The difference between the two availables, signed: positive means the cache is
 * showing more days than the ledger supports and somebody may book leave they have not
 * got; negative means it is showing fewer and somebody has quietly lost days.
 *
 * Both matter and they are not equally urgent, which is why this is signed rather than
 * an absolute size. The second one is the story's own case — a discrepancy discovered
 * by an employee is always this one, because nobody reports being given too much.
 */
export function daysAtStake(disagreement: BalanceDisagreement): number {
  return round(availableOf(disagreement.cached) - availableOf(disagreement.ledger));
}

/**
 * The report, as text somebody can read.
 *
 * Plain text and not a `Mail`, because `/domain` holds what a record is and imports
 * nothing. The job wraps this in an envelope; see ../jobs/balance-reconciliation.ts.
 *
 * Written for the person opening it at nine on a Monday rather than for a machine. It
 * says what was checked, what disagreed, by how much, and — the part a generated
 * report usually leaves out — what to do, which is to read the ledger before touching
 * anything.
 */
export function reportOf(run: Reconciliation): string {
  const when = run.checkedAt.toISOString();

  if (isClean(run)) {
    return [
      `The leave balances were checked against the ledger at ${when}.`,
      '',
      `All ${run.balancesChecked} of them agree.`,
    ].join('\n');
  }

  return [
    `${count(run.disagreements.length, 'leave balance disagrees', 'leave balances disagree')} ` +
      `with the ledger.`,
    '',
    `Checked at ${when}. ${run.balancesChecked} balances compared.`,
    '',
    'The ledger is the record and the balance is a cache of it, so where the two',
    'differ the ledger is what actually happened. Nothing has been changed: a balance',
    'is only put right by somebody who has read the movements behind it, because the',
    'difference is the only evidence of how it arose.',
    '',
    ...run.disagreements.flatMap(linesFor),
    ...(run.couldNotTell.length === 0
      ? []
      : [
          'This report could not be sent to:',
          ...run.couldNotTell.map((failure) => `  ${failure.to} — ${failure.because}`),
          '',
        ]),
    'Remat Holdings Leave',
  ].join('\n');
}

/** One disagreement, as the three or four lines somebody reads about it. */
function linesFor(disagreement: BalanceDisagreement): string[] {
  const stake = daysAtStake(disagreement);

  return [
    `${disagreement.employeeNumber} — ${disagreement.leaveTypeName}, ${disagreement.leaveYearLabel}`,
    ...(disagreement.hasCachedRow
      ? []
      : ['  There is no cached balance at all. Every screen is showing nought days.']),
    ...columnsThatDiffer(disagreement).map(
      (bucket) =>
        `  ${labelFor(bucket)}: the balance says ${disagreement.cached[bucket]}, ` +
        `the ledger says ${disagreement.ledger[bucket]}`,
    ),
    `  Available is out by ${Math.abs(stake)} ${stake === 1 || stake === -1 ? 'day' : 'days'}, ` +
      `${stake > 0 ? 'in their favour' : 'against them'}.`,
    '',
  ];
}

/** §5.7's columns, in the words a person uses for them. */
function labelFor(bucket: BalanceBucket): string {
  switch (bucket) {
    case 'entitled':
      return 'Entitled';
    case 'carriedOver':
      return 'Carried over';
    case 'adjustment':
      return 'Adjustments';
    case 'taken':
      return 'Taken';
    case 'pending':
      return 'Pending';
  }
}

function availableOf(figures: FiveFigures): number {
  return round(
    figures.entitled + figures.carriedOver + figures.adjustment - figures.taken - figures.pending,
  );
}

function count(howMany: number, one: string, many: string): string {
  return `${howMany} ${howMany === 1 ? one : many}`;
}

/** Two decimal places, which is what the columns hold. See ./balance.ts. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
