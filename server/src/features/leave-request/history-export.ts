/** My requests as a table to export. FR 64, LMS 511. */

import type { Table } from '../../export/table.js';
import { calendarDateIn } from '../../shared/time.js';
import type { RequestHistory } from './request-history.js';

export function historyTable(history: RequestHistory): Table {
  return {
    name: `My leave requests ${history.year?.label ?? 'all years'}`,
    headings: [
      'Leave type',
      'From',
      'To',
      'Days',
      'Counted in',
      'Status',
      'Progress',
      'Submitted on',
      'Reason',
      'Late entry reason',
    ],
    rows: history.entries.map((entry) => [
      entry.typeName,
      entry.from,
      entry.to,
      entry.days,
      entry.countingBasisLabel,
      entry.statusInWords,
      entry.progress.inWords,
      calendarDateIn(entry.submittedAt, 'UTC'),
      entry.reason,
      entry.lateEntryReason,
    ]),
  };
}
