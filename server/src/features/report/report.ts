/** HR's reports on leave across the company. FR 63, LMS 510. */

import { available, type LeaveBalance, owed } from '../balance/balance.js';
import type { Department } from '../department/department.js';
import type { Employee } from '../employee/employee.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import {
  byDisplayOrder,
  type CountingBasis,
  countingBasisLabel,
  hasRunningBalance,
  isEligible,
  type LeaveType,
} from '../leave-type/leave-type.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import {
  noticeGiven,
  type LeaveRequest,
  type RequestStatus,
} from '../leave-request/leave-request.js';
import { calendarDateIn, type CalendarDate, isCalendarDate } from '../../shared/time.js';

/** Calendar days a request may wait for a decision before it is reported. FR 63. */
export const AGREED_TURNAROUND_DAYS = 5;

/** The longest turnaround a report may be asked about. */
export const LONGEST_TURNAROUND_DAYS = 365;

/** The widest period leave taken is reported over, in months. */
export const LONGEST_PERIOD_MONTHS = 24;

/** No leave year defined, so there is nothing to report against. §5.4. */
export class NoLeaveYearForTheReport extends Error {
  constructor() {
    super(
      'There is no leave year to report against. Every balance is per person, per leave ' +
        'type, per leave year. Ask an HR Administrator to define one. §5.4.',
    );
    this.name = 'NoLeaveYearForTheReport';
  }
}

/** A period that is not two dates in order. */
export class InvalidReportPeriod extends Error {
  readonly field: 'from' | 'to';

  constructor(field: 'from' | 'to', message: string) {
    super(message);
    this.name = 'InvalidReportPeriod';
    this.field = field;
  }
}

/** A turnaround that is not a whole number of days. */
export class InvalidTurnaroundDays extends Error {
  readonly field = 'turnaroundDays';

  constructor() {
    super(
      `A turnaround is a whole number of calendar days, from 0 to ` +
        `${String(LONGEST_TURNAROUND_DAYS)}. FR 63.`,
    );
    this.name = 'InvalidTurnaroundDays';
  }
}

/* ------------------------------------------------------------------- the shapes */

/** A leave year as a report names it. */
export interface ReportYear {
  id: string;
  label: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  isClosed: boolean;
}

/** One kind of leave, as a report heads a line with it. */
export interface ReportLeaveType {
  leaveTypeId: string;
  name: string;
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  isPaid: boolean;
}

/** One kind of leave's unused days, summed over a group of people. */
export interface LiabilityLine extends ReportLeaveType {
  /** People with a balance of this type. */
  people: number;
  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  /** `entitled + carriedOver + adjustment − taken`. */
  unused: number;
}

export interface DepartmentLiability {
  departmentId: string;
  name: string;
  headcount: number;
  lines: LiabilityLine[];
}

/** Leave liability by department. */
export interface LiabilityReport {
  year: ReportYear;
  departments: DepartmentLiability[];
  /** The same lines over the whole company. */
  company: LiabilityLine[];
}

export interface LeaveTakenLine extends ReportLeaveType {
  requests: number;
  days: number;
  /** Days per month, in the order of `months`. */
  byMonth: number[];
}

/** Leave taken by type and period. */
export interface LeaveTakenReport {
  from: CalendarDate;
  to: CalendarDate;
  /** `YYYY-MM`, first to last. */
  months: string[];
  lines: LeaveTakenLine[];
}

export interface OverdueRequest {
  requestId: string;
  employeeId: string;
  name: string;
  department: string;
  typeName: string;
  from: CalendarDate;
  to: CalendarDate;
  days: number;
  status: RequestStatus;
  /** Null where nobody could be found to decide it. FR 48b. */
  awaiting: ApproverRole | null;
  submittedOn: CalendarDate;
  daysWaiting: number;
}

/** Requests pending beyond the agreed turnaround. */
export interface OverdueRequestsReport {
  asAt: CalendarDate;
  turnaroundDays: number;
  requests: OverdueRequest[];
}

/** One person's figures for one kind of leave. */
export interface PersonLine {
  employeeId: string;
  name: string;
  department: string;
  leaveTypeId: string;
  typeName: string;
  /** `entitled + carriedOver + adjustment`. */
  given: number;
  carriedOver: number;
  taken: number;
  pending: number;
  available: number;
}

/** Employees with zero or excessive leave taken. */
export interface LeaveUsageReport {
  year: ReportYear;
  types: ReportLeaveType[];
  /** Given days of this type and took none. */
  zero: PersonLine[];
  /** Took more than they were given. */
  excessive: PersonLine[];
}

export interface CarriedOverTotal extends ReportLeaveType {
  people: number;
  carriedOver: number;
}

/** Carried over balances. Carry over is uncapped, FR 36a. */
export interface CarriedOverReport {
  year: ReportYear;
  totals: CarriedOverTotal[];
  balances: PersonLine[];
}

/** What the balance reports are built from. */
export interface BalanceFacts {
  year: LeaveYear;
  employees: readonly Employee[];
  departments: readonly Department[];
  types: readonly LeaveType[];
  balances: readonly LeaveBalance[];
}

/* ------------------------------------------------------------------ the reports */

/** Unused days by department, per kind of paid leave. Leavers are settled apart. FR 37a. */
export function liabilityByDepartment(facts: BalanceFacts): LiabilityReport {
  const types = paidRunningTypes(facts.types);
  const staff = stillEmployed(facts.employees);
  const balances = balancesOf(facts, staff, types);

  const departments = [...facts.departments]
    .map((department) => {
      const members = staff.filter((one) => one.departmentId === department.id);
      const ids = new Set(members.map((one) => one.id));

      return {
        departmentId: department.id,
        name: department.name,
        headcount: members.length,
        lines: types.map((type) =>
          liabilityLine(
            type,
            balances.filter((one) => ids.has(one.employeeId)),
          ),
        ),
      };
    })
    .filter((department) => department.headcount > 0)
    .sort((one, other) => one.name.localeCompare(other.name));

  return {
    year: reportYearOf(facts.year),
    departments,
    company: types.map((type) => liabilityLine(type, balances)),
  };
}

/** Approved leave per type and month, counted in the month it starts. */
export function leaveTakenByTypeAndPeriod(facts: {
  from: CalendarDate;
  to: CalendarDate;
  types: readonly LeaveType[];
  approved: readonly LeaveRequest[];
}): LeaveTakenReport {
  const months = monthsBetween(facts.from, facts.to);
  const inPeriod = facts.approved.filter(
    (request) =>
      request.status === 'APPROVED' && request.from >= facts.from && request.from <= facts.to,
  );

  const lines = [...facts.types]
    .sort(byDisplayOrder)
    .map((type) => {
      const ofType = inPeriod.filter((request) => request.leaveTypeId === type.id);

      return {
        ...reportLeaveTypeOf(type),
        requests: ofType.length,
        days: sum(ofType.map((request) => request.days)),
        byMonth: months.map((month) =>
          sum(
            ofType
              .filter((request) => request.from.startsWith(month))
              .map((request) => request.days),
          ),
        ),
      };
    })
    .filter(stillShown(facts.types));

  return { from: facts.from, to: facts.to, months, lines };
}

/** Undecided requests waiting longer than the turnaround, longest first. */
export function requestsPastTurnaround(facts: {
  asAt: CalendarDate;
  turnaroundDays: number;
  undecided: readonly LeaveRequest[];
  employees: readonly Employee[];
  departments: readonly Department[];
  types: readonly LeaveType[];
}): OverdueRequestsReport {
  const people = new Map(facts.employees.map((one) => [one.id, one]));
  const departments = new Map(facts.departments.map((one) => [one.id, one.name]));
  const types = new Map(facts.types.map((one) => [one.id, one.name]));

  const requests = facts.undecided
    .map((request) => {
      const submittedOn = calendarDateIn(request.submittedAt, 'UTC');
      const employee = people.get(request.employeeId);

      return {
        requestId: request.id,
        employeeId: request.employeeId,
        name: employee === undefined ? '' : nameOf(employee),
        department: employee === undefined ? '' : (departments.get(employee.departmentId) ?? ''),
        typeName: types.get(request.leaveTypeId) ?? '',
        from: request.from,
        to: request.to,
        days: request.days,
        status: request.status,
        awaiting: request.awaitingApprovalFrom,
        submittedOn,
        daysWaiting: noticeGiven(submittedOn, facts.asAt),
      };
    })
    .filter((request) => request.daysWaiting > facts.turnaroundDays)
    .sort(
      (one, other) =>
        other.daysWaiting - one.daysWaiting || one.requestId.localeCompare(other.requestId),
    );

  return { asAt: facts.asAt, turnaroundDays: facts.turnaroundDays, requests };
}

/** Who took none of what they were given, and who took more than it. */
export function leaveUsage(facts: BalanceFacts): LeaveUsageReport {
  const types = [...facts.types].filter(hasRunningBalance).sort(byDisplayOrder);
  const staff = stillEmployed(facts.employees);
  const lines = personLines(facts, staff, types);

  return {
    year: reportYearOf(facts.year),
    types: types.map(reportLeaveTypeOf),
    zero: lines.filter((line) => line.given > 0 && line.taken === 0),
    excessive: lines.filter((line) => line.taken > line.given),
  };
}

/** Every balance with days carried into this year, and the totals per type. FR 36, FR 36a. */
export function carriedOverBalances(facts: BalanceFacts): CarriedOverReport {
  const types = [...facts.types].filter(hasRunningBalance).sort(byDisplayOrder);
  const staff = stillEmployed(facts.employees);
  const balances = personLines(facts, staff, types).filter((line) => line.carriedOver !== 0);

  return {
    year: reportYearOf(facts.year),
    totals: types
      .map((type) => {
        const ofType = balances.filter((line) => line.leaveTypeId === type.id);

        return {
          ...reportLeaveTypeOf(type),
          people: ofType.length,
          carriedOver: sum(ofType.map((line) => line.carriedOver)),
        };
      })
      .filter((total) => total.people > 0),
    balances,
  };
}

/* ------------------------------------------------------------------ the inputs */

/** The turnaround asked for, or the agreed one. */
export function readTurnaroundDays(value: unknown): number {
  if (value === undefined || value === '') {
    return AGREED_TURNAROUND_DAYS;
  }

  const days = typeof value === 'string' ? Number(value) : value;

  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > LONGEST_TURNAROUND_DAYS
  ) {
    throw new InvalidTurnaroundDays();
  }

  return days;
}

/** The period asked for, or the leave year's where a date is missing. */
export function readReportPeriod(
  from: unknown,
  to: unknown,
  fallback: { from: CalendarDate; to: CalendarDate },
): { from: CalendarDate; to: CalendarDate } {
  const start = dateOr(from, fallback.from, 'from');
  const end = dateOr(to, fallback.to, 'to');

  if (end < start) {
    throw new InvalidReportPeriod('to', `The period ends on ${end}, before it starts on ${start}.`);
  }

  if (monthsBetween(start, end).length > LONGEST_PERIOD_MONTHS) {
    throw new InvalidReportPeriod(
      'to',
      `A period is at most ${String(LONGEST_PERIOD_MONTHS)} months. Report a shorter one.`,
    );
  }

  return { from: start, to: end };
}

/* --------------------------------------------------------------------- helpers */

export function reportYearOf(year: LeaveYear): ReportYear {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isClosed: year.isClosed,
  };
}

/** `YYYY-MM` for every month the period touches. */
export function monthsBetween(from: CalendarDate, to: CalendarDate): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);

  for (;;) {
    const label = `${String(year)}-${String(month).padStart(2, '0')}`;

    if (label > last) {
      return months;
    }

    months.push(label);
    month = month === 12 ? 1 : month + 1;
    year = month === 1 ? year + 1 : year;
  }
}

function dateOr(value: unknown, fallback: CalendarDate, field: 'from' | 'to'): CalendarDate {
  if (value === undefined || value === '') {
    return fallback;
  }

  if (!isCalendarDate(value)) {
    throw new InvalidReportPeriod(field, `${String(value)} is not a date. Write it YYYY-MM-DD.`);
  }

  return value;
}

function reportLeaveTypeOf(type: LeaveType): ReportLeaveType {
  return {
    leaveTypeId: type.id,
    name: type.name,
    countingBasis: type.countingBasis,
    countingBasisLabel: countingBasisLabel(type.countingBasis),
    isPaid: type.isPaid,
  };
}

/** Paid leave with a yearly balance, which is what a liability is made of. */
function paidRunningTypes(types: readonly LeaveType[]): LeaveType[] {
  return [...types].filter((type) => hasRunningBalance(type) && type.isPaid).sort(byDisplayOrder);
}

function stillEmployed(employees: readonly Employee[]): Employee[] {
  return employees.filter((one) => one.employmentStatus !== 'TERMINATED');
}

/** A retired type stays only where it has leave in the period. */
function stillShown(types: readonly LeaveType[]) {
  const active = new Map(types.map((type) => [type.id, type.isActive]));

  return (line: LeaveTakenLine): boolean =>
    line.requests > 0 || active.get(line.leaveTypeId) === true;
}

function balancesOf(
  facts: BalanceFacts,
  staff: readonly Employee[],
  types: readonly LeaveType[],
): LeaveBalance[] {
  const ids = new Set(staff.map((one) => one.id));
  const typeIds = new Set(types.map((one) => one.id));

  return facts.balances.filter(
    (one) =>
      one.leaveYearId === facts.year.id && ids.has(one.employeeId) && typeIds.has(one.leaveTypeId),
  );
}

function liabilityLine(type: LeaveType, balances: readonly LeaveBalance[]): LiabilityLine {
  const ofType = balances.filter((one) => one.leaveTypeId === type.id);
  const entitled = sum(ofType.map((one) => one.entitled));
  const carriedOver = sum(ofType.map((one) => one.carriedOver));
  const adjustment = sum(ofType.map((one) => one.adjustment));
  const taken = sum(ofType.map((one) => one.taken));

  return {
    ...reportLeaveTypeOf(type),
    people: ofType.length,
    entitled,
    carriedOver,
    adjustment,
    taken,
    pending: sum(ofType.map((one) => one.pending)),
    unused: round(entitled + carriedOver + adjustment - taken),
  };
}

/** One line per person per type they have a balance in, by department then surname. */
function personLines(
  facts: BalanceFacts,
  staff: readonly Employee[],
  types: readonly LeaveType[],
): PersonLine[] {
  const people = new Map(staff.map((one) => [one.id, one]));
  const departments = new Map(facts.departments.map((one) => [one.id, one.name]));
  const order = new Map(types.map((type, index) => [type.id, index]));
  const byId = new Map(types.map((type) => [type.id, type]));

  return balancesOf(facts, staff, types)
    .flatMap((balance) => {
      const employee = people.get(balance.employeeId);
      const type = byId.get(balance.leaveTypeId);

      if (employee === undefined || type === undefined || !isEligible(type, employee.gender)) {
        return [];
      }

      return [
        {
          employeeId: employee.id,
          name: nameOf(employee),
          department: departments.get(employee.departmentId) ?? '',
          leaveTypeId: type.id,
          typeName: type.name,
          given: owed(balance),
          carriedOver: balance.carriedOver,
          taken: balance.taken,
          pending: balance.pending,
          available: available(balance),
        },
      ];
    })
    .sort(
      (one, other) =>
        one.department.localeCompare(other.department) ||
        surnameOf(one).localeCompare(surnameOf(other)) ||
        one.name.localeCompare(other.name) ||
        (order.get(one.leaveTypeId) ?? 0) - (order.get(other.leaveTypeId) ?? 0),
    );

  function surnameOf(line: PersonLine): string {
    return people.get(line.employeeId)?.lastName ?? '';
  }
}

function nameOf(employee: Employee): string {
  return `${employee.firstName} ${employee.lastName}`;
}

function sum(figures: readonly number[]): number {
  return round(figures.reduce((running, figure) => running + figure, 0));
}

/** Two decimal places, which is what the balance columns hold. §8.6. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
