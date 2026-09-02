/** Checking the cache against the record it is a cache of. §7.4., LMS 213, §5.7, LMS 210. */

import type { BalanceBucket } from './balance.js';

/** The five figures, from one side or the other. */
export interface FiveFigures {
  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
}

/** One balance where the cache and the ledger do not agree. */
export interface BalanceDisagreement {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveYearId: string;
  leaveYearLabel: string;
  /** False where the ledger has movements and there is no cached row at all. */
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
  /** The addresses the alert reached. */
  told: readonly string[];
  /** The addresses it could not reach, and the reason. */
  couldNotTell: readonly { to: string; because: string }[];
}

/** Whether the cache and the ledger agreed about everything. */
export function isClean(run: Reconciliation): boolean {
  return run.disagreements.length === 0;
}

/** Which of the five columns differ. §5.7. */
export function columnsThatDiffer(disagreement: BalanceDisagreement): BalanceBucket[] {
  const { cached, ledger } = disagreement;

  return (['entitled', 'carriedOver', 'adjustment', 'taken', 'pending'] as const).filter(
    (bucket) => cached[bucket] !== ledger[bucket],
  );
}

/** How many days the disagreement is worth, as the person whose balance it is would feel it. */
export function daysAtStake(disagreement: BalanceDisagreement): number {
  return round(availableOf(disagreement.cached) - availableOf(disagreement.ledger));
}

/** The report, as text somebody can read. */
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
