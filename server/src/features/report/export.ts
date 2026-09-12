/** Each report as one table to export. FR 58, FR 64, LMS 511. */

import type { Table } from '../../export/table.js';
import type {
  CarriedOverReport,
  LeaveTakenReport,
  LeaveUsageReport,
  LiabilityReport,
  OverdueRequestsReport,
  PersonLine,
} from './report.js';

const PERSON_HEADINGS = [
  'Employee',
  'Department',
  'Leave type',
  'Given',
  'Carried over',
  'Taken',
  'Pending',
  'Available',
];

/** Every department's lines, then the whole company's. */
export function liabilityTable(report: LiabilityReport): Table {
  const lines = [
    ...report.departments.flatMap((department) =>
      department.lines.map((line) => ({ department: department.name, line })),
    ),
    ...report.company.map((line) => ({ department: 'All departments', line })),
  ];

  return {
    name: `Leave liability ${report.year.label}`,
    headings: [
      'Department',
      'Leave type',
      'Counted in',
      'People',
      'Entitled',
      'Carried over',
      'Adjustment',
      'Taken',
      'Pending',
      'Unused',
    ],
    rows: lines.map(({ department, line }) => [
      department,
      line.name,
      line.countingBasisLabel,
      line.people,
      line.entitled,
      line.carriedOver,
      line.adjustment,
      line.taken,
      line.pending,
      line.unused,
    ]),
  };
}

export function leaveTakenTable(report: LeaveTakenReport): Table {
  return {
    name: `Leave taken ${report.from} to ${report.to}`,
    headings: ['Leave type', 'Counted in', ...report.months, 'Days', 'Requests'],
    rows: report.lines.map((line) => [
      line.name,
      line.countingBasisLabel,
      ...line.byMonth,
      line.days,
      line.requests,
    ]),
  };
}

export function overdueRequestsTable(report: OverdueRequestsReport): Table {
  return {
    name: `Requests past ${String(report.turnaroundDays)} days ${report.asAt}`,
    headings: [
      'Employee',
      'Department',
      'Leave type',
      'From',
      'To',
      'Days',
      'Status',
      'Waiting on',
      'Submitted on',
      'Days waiting',
    ],
    rows: report.requests.map((one) => [
      one.name,
      one.department,
      one.typeName,
      one.from,
      one.to,
      one.days,
      one.status,
      one.awaiting ?? 'Nobody to approve',
      one.submittedOn,
      one.daysWaiting,
    ]),
  };
}

/** Both lists in one table, told apart by the first column. */
export function usageTable(report: LeaveUsageReport): Table {
  return {
    name: `Zero or excessive leave ${report.year.label}`,
    headings: ['Finding', ...PERSON_HEADINGS],
    rows: [
      ...report.zero.map((line) => ['Took none', ...personCells(line)]),
      ...report.excessive.map((line) => ['Took more than given', ...personCells(line)]),
    ],
  };
}

export function carriedOverTable(report: CarriedOverReport): Table {
  return {
    name: `Carried over ${report.year.label}`,
    headings: PERSON_HEADINGS,
    rows: report.balances.map(personCells),
  };
}

function personCells(line: PersonLine): (string | number)[] {
  return [
    line.name,
    line.department,
    line.typeName,
    line.given,
    line.carriedOver,
    line.taken,
    line.pending,
    line.available,
  ];
}
