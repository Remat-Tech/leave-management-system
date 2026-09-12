import { describe, expect, it } from 'vitest';
import { type LeaveBalance, noMovementsYet } from '../../src/features/balance/balance.js';
import type { Department } from '../../src/features/department/department.js';
import type { Employee } from '../../src/features/employee/employee.js';
import type {
  LeaveRequest,
  RequestStatus,
} from '../../src/features/leave-request/leave-request.js';
import type { LeaveType } from '../../src/features/leave-type/leave-type.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  AGREED_TURNAROUND_DAYS,
  carriedOverBalances,
  InvalidReportPeriod,
  InvalidTurnaroundDays,
  leaveTakenByTypeAndPeriod,
  leaveUsage,
  liabilityByDepartment,
  monthsBetween,
  readReportPeriod,
  readTurnaroundDays,
  requestsPastTurnaround,
} from '../../src/features/report/report.js';

/** HR reporting. FR 63, LMS 510. */

const YEAR: LeaveYear = {
  id: 'y2026',
  label: '2026',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  isClosed: false,
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ANNUAL = leaveType('annual', 'Annual Leave', 1);
const SICK = leaveType('sick', 'Sick Leave', 2);
const UNPAID = leaveType('unpaid', 'Unpaid Leave', 3, { isPaid: false });
const MATERNITY = leaveType('maternity', 'Maternity Leave', 4, { entitlementBasis: 'EVENT' });
const TYPES = [SICK, ANNUAL, UNPAID, MATERNITY];

const OPERATIONS = department('ops', 'Operations');
const FINANCE = department('fin', 'Finance');
const EMPTY = department('empty', 'Empty');
const DEPARTMENTS = [OPERATIONS, FINANCE, EMPTY];

const AMA = employee('ama', 'Ama', 'Mensah', OPERATIONS.id);
const KOFI = employee('kofi', 'Kofi', 'Boateng', OPERATIONS.id);
const EFE = employee('efe', 'Efe', 'Danquah', FINANCE.id);
const GONE = employee('gone', 'Kojo', 'Antwi', OPERATIONS.id, { employmentStatus: 'TERMINATED' });
const EMPLOYEES = [AMA, KOFI, EFE, GONE];

describe('leave liability by department', () => {
  const report = liabilityByDepartment({
    year: YEAR,
    employees: EMPLOYEES,
    departments: DEPARTMENTS,
    types: TYPES,
    balances: [
      balance(AMA, ANNUAL, { entitled: 20, carriedOver: 4, taken: 6, pending: 2 }),
      balance(KOFI, ANNUAL, { entitled: 20, adjustment: -1, taken: 10 }),
      balance(EFE, ANNUAL, { entitled: 20 }),
      balance(AMA, UNPAID, { entitled: 10 }),
      balance(GONE, ANNUAL, { entitled: 20 }),
      balance(AMA, ANNUAL, { entitled: 99 }, 'another year'),
    ],
  });

  it('sums unused paid days per department, less what was taken', () => {
    const operations = report.departments.find((one) => one.name === 'Operations');
    const annual = operations?.lines.find((line) => line.leaveTypeId === ANNUAL.id);

    expect(operations?.headcount).toBe(2);
    expect(annual).toMatchObject({
      people: 2,
      entitled: 40,
      carriedOver: 4,
      adjustment: -1,
      taken: 16,
      pending: 2,
      unused: 27,
    });
  });

  it('and leaves out unpaid leave, event leave, leavers and empty departments', () => {
    expect(report.company.map((line) => line.name)).toEqual(['Annual Leave', 'Sick Leave']);
    expect(report.departments.map((one) => one.name)).toEqual(['Finance', 'Operations']);
    expect(report.company.find((line) => line.leaveTypeId === ANNUAL.id)?.unused).toBe(47);
  });
});

describe('leave taken by type and period', () => {
  const report = leaveTakenByTypeAndPeriod({
    from: '2026-03-01',
    to: '2026-04-30',
    types: TYPES,
    approved: [
      request('one', AMA, ANNUAL, '2026-03-02', 5),
      request('two', KOFI, ANNUAL, '2026-04-30', 3),
      request('three', EFE, SICK, '2026-04-10', 2),
      request('before', EFE, ANNUAL, '2026-02-27', 4),
      request('refused', EFE, ANNUAL, '2026-03-10', 4, { status: 'REFUSED' }),
    ],
  });

  it('counts approved days in the month they start', () => {
    expect(report.months).toEqual(['2026-03', '2026-04']);
    expect(report.lines.find((line) => line.leaveTypeId === ANNUAL.id)).toMatchObject({
      requests: 2,
      days: 8,
      byMonth: [5, 3],
    });
    expect(report.lines.find((line) => line.leaveTypeId === SICK.id)?.byMonth).toEqual([0, 2]);
  });

  it('and hides a retired type with nothing in the period', () => {
    const retired = { ...UNPAID, isActive: false };
    const lines = leaveTakenByTypeAndPeriod({
      from: '2026-03-01',
      to: '2026-03-31',
      types: [ANNUAL, retired],
      approved: [],
    }).lines;

    expect(lines.map((line) => line.name)).toEqual(['Annual Leave']);
  });
});

describe('requests pending beyond the agreed turnaround', () => {
  const report = requestsPastTurnaround({
    asAt: '2026-03-11',
    turnaroundDays: 5,
    employees: EMPLOYEES,
    departments: DEPARTMENTS,
    types: TYPES,
    undecided: [
      request('ten', AMA, ANNUAL, '2026-04-01', 3, { submittedAt: '2026-03-01' }),
      request('five', KOFI, ANNUAL, '2026-04-01', 3, { submittedAt: '2026-03-06' }),
      request('seven', EFE, SICK, '2026-04-01', 1, {
        submittedAt: '2026-03-04',
        status: 'UNROUTABLE',
        awaitingApprovalFrom: null,
      }),
    ],
  });

  it('lists those waiting longer, longest first', () => {
    expect(report.requests.map((one) => [one.requestId, one.daysWaiting])).toEqual([
      ['ten', 10],
      ['seven', 7],
    ]);
    expect(report.requests[0]).toMatchObject({
      name: 'Ama Mensah',
      department: 'Operations',
      typeName: 'Annual Leave',
      awaiting: 'MANAGER',
      submittedOn: '2026-03-01',
    });
  });

  it('and includes a request nobody could be routed to', () => {
    expect(report.requests[1]).toMatchObject({ status: 'UNROUTABLE', awaiting: null });
  });
});

describe('zero or excessive leave taken', () => {
  const report = leaveUsage({
    year: YEAR,
    employees: EMPLOYEES,
    departments: DEPARTMENTS,
    types: TYPES,
    balances: [
      balance(AMA, ANNUAL, { entitled: 20 }),
      balance(KOFI, ANNUAL, { entitled: 20, taken: 5 }),
      balance(EFE, SICK, { entitled: 3, taken: 5 }),
      balance(EFE, UNPAID, {}),
      balance(GONE, ANNUAL, { entitled: 20 }),
    ],
  });

  it('names who was given days and took none', () => {
    expect(report.zero.map((line) => [line.name, line.typeName])).toEqual([
      ['Ama Mensah', 'Annual Leave'],
    ]);
  });

  it('and who took more than they were given', () => {
    expect(report.excessive).toEqual([
      expect.objectContaining({ name: 'Efe Danquah', given: 3, taken: 5, available: -2 }),
    ]);
  });
});

describe('carried over balances', () => {
  const report = carriedOverBalances({
    year: YEAR,
    employees: EMPLOYEES,
    departments: DEPARTMENTS,
    types: TYPES,
    balances: [
      balance(AMA, ANNUAL, { entitled: 20, carriedOver: 12, taken: 2 }),
      balance(EFE, ANNUAL, { entitled: 20, carriedOver: 30 }),
      balance(KOFI, ANNUAL, { entitled: 20 }),
      balance(GONE, ANNUAL, { carriedOver: 5 }),
    ],
  });

  it('lists every balance with days carried in, uncapped', () => {
    expect(report.balances.map((line) => [line.name, line.carriedOver, line.available])).toEqual([
      ['Efe Danquah', 30, 50],
      ['Ama Mensah', 12, 30],
    ]);
    expect(report.totals).toEqual([
      expect.objectContaining({ name: 'Annual Leave', people: 2, carriedOver: 42 }),
    ]);
  });
});

describe('what a report may be asked', () => {
  it('uses the agreed turnaround unless another is given', () => {
    expect(readTurnaroundDays(undefined)).toBe(AGREED_TURNAROUND_DAYS);
    expect(readTurnaroundDays('0')).toBe(0);
    expect(() => readTurnaroundDays('2.5')).toThrow(InvalidTurnaroundDays);
    expect(() => readTurnaroundDays('366')).toThrow(InvalidTurnaroundDays);
  });

  it('reads a period, falling back to the year', () => {
    const year = { from: '2026-01-01', to: '2026-12-31' };

    expect(readReportPeriod(undefined, '2026-06-30', year)).toEqual({
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(() => readReportPeriod('2026-06-30', '2026-06-01', year)).toThrow(InvalidReportPeriod);
    expect(() => readReportPeriod('30/06/2026', undefined, year)).toThrow(InvalidReportPeriod);
    expect(() => readReportPeriod('2024-01-01', '2026-01-01', year)).toThrow(InvalidReportPeriod);
  });

  it('names every month a period touches', () => {
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });
});

/* --------------------------------------------------------------------- fixtures */

function leaveType(
  id: string,
  name: string,
  displayOrder: number,
  overrides: Partial<LeaveType> = {},
): LeaveType {
  return {
    id,
    code: id.toUpperCase(),
    name,
    description: null,
    countingBasis: 'WORKING_DAYS',
    entitlementBasis: 'QUOTA',
    isPaid: true,
    unit: 'DAYS',
    documentation: 'NOT_REQUIRED',
    documentationAfterDays: null,
    exceedableWithDocument: false,
    entitlementExpiryMonths: null,
    mayBeSplit: true,
    minNoticeCalendarDays: 0,
    maxBackdateCalendarDays: 0,
    genderRestriction: null,
    reasonRequired: false,
    deductsFromAnnual: false,
    approvalChain: ['MANAGER'],
    displayOrder,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function department(id: string, name: string): Department {
  return { id, name, parentId: null, isActive: true, createdAt: new Date(), updatedAt: new Date() };
}

function employee(
  id: string,
  firstName: string,
  lastName: string,
  departmentId: string,
  overrides: Partial<Employee> = {},
): Employee {
  return {
    id,
    employeeNumber: id,
    firstName,
    lastName,
    workEmail: `${id}@rematholdings.com`,
    jobTitle: null,
    departmentId,
    managerId: null,
    workPatternId: 'standard',
    startDate: '2020-01-01',
    exitDate: null,
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    gender: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function balance(
  who: Employee,
  type: LeaveType,
  figures: Partial<LeaveBalance>,
  leaveYearId = YEAR.id,
): LeaveBalance {
  return {
    ...noMovementsYet({ employeeId: who.id, leaveTypeId: type.id, leaveYearId }),
    updatedAt: new Date(),
    ...figures,
  };
}

function request(
  id: string,
  who: Employee,
  type: LeaveType,
  from: string,
  days: number,
  overrides: Partial<Omit<LeaveRequest, 'submittedAt'>> & {
    submittedAt?: string;
    status?: RequestStatus;
  } = {},
): LeaveRequest {
  const { submittedAt, ...rest } = overrides;

  return {
    id,
    employeeId: who.id,
    leaveTypeId: type.id,
    leaveYearId: YEAR.id,
    from,
    to: from,
    reason: null,
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days,
    calendarDays: days,
    status: 'APPROVED',
    awaitingApprovalFrom: 'MANAGER',
    decidedBySingleApprover: false,
    submittedAt: new Date(`${submittedAt ?? '2026-01-01'}T09:00:00Z`),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...rest,
  };
}
