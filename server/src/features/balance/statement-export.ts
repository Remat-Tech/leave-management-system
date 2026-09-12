/** My balances as a table to export. FR 64, LMS 511. */

import type { Table } from '../../export/table.js';
import type { BalanceStatement } from './balance-statement.js';

export function statementTable(statement: BalanceStatement): Table {
  return {
    name: `My leave balances ${statement.year.label}`,
    headings: [
      'Leave type',
      'Counted in',
      'Paid',
      'Entitled',
      'Carried over',
      'Adjustment',
      'Taken',
      'Pending',
      'Owed',
      'Available',
    ],
    rows: statement.lines.map((line) => [
      line.name,
      line.countingBasisLabel,
      line.isPaid ? 'Yes' : 'No',
      line.entitled,
      line.carriedOver,
      line.adjustment,
      line.taken,
      line.pending,
      line.owed,
      line.available,
    ]),
  };
}
