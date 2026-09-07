/**
 * A manager's direct reports, with what each has left and what each has booked. FR 55, FR 56, §7.4, NFR USA 03, LMS 405.
 */

import type { ApproverRole } from '../leave-type/approval-chain.js';
import { type BalanceStatementLine, linesFor } from '../balance/balance-statement.js';
import type { LeaveBalance } from '../balance/balance.js';
import type { Employee, EmploymentStatus } from '../employee/employee.js';
import {
  type CountingBasis,
  countingBasisLabel,
  type LeaveType,
} from '../leave-type/leave-type.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import type { LeaveRequest, RequestStatus } from '../leave-request/leave-request.js';
import { type CalendarDate, eachDay, formatDay } from '../../shared/time.js';

/** Nobody has defined a leave year this team could hold a balance in. §5.4. */
export class NoLeaveYearForTheTeam extends Error {
  readonly managerId: string;

  constructor(managerId: string) {
    super(
      'There is no leave year to show this team against. Every balance is per person, per ' +
        'leave type, per leave year, and no leave year has been defined. Ask an HR ' +
        'Administrator to define the one that covers today. §5.4.',
    );
    this.name = 'NoLeaveYearForTheTeam';
    this.managerId = managerId;
  }
}

/** One piece of live leave a report holds. FR 56. */
export interface TeamBooking {
  requestId: string;
  leaveTypeId: string;
  typeName: string;
  /** Ten characters. NFR DAT 03. */
  from: CalendarDate;
  to: CalendarDate;
  /** FR 11, FR 24. Off the request as it was priced, never off the type as it stands. */
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** FR 41. */
  agreed: boolean;
  /** FR 38a. The desk it is sitting on, null once it is sitting nowhere. */
  awaiting: ApproverRole | null;
  /** NFR USA 03. */
  inWords: string;
}

/** One direct report. FR 55, FR 56. */
export interface TeamMember {
  employeeId: string;
  name: string;
  jobTitle: string | null;
  /** FR 06. A leaver still reports to somebody until HR moves the line. */
  employmentStatus: EmploymentStatus;
  /** FR 55. The same lines the person's own balance screen shows. */
  balances: BalanceStatementLine[];
  /** FR 56. Soonest first. */
  booked: TeamBooking[];
  /** Days of live leave in this year, across every type. */
  daysBooked: number;
  awayToday: boolean;
  /** NFR USA 03. */
  inWords: string;
}

/** One report away on one day. */
export interface TeamAwayOn {
  employeeId: string;
  name: string;
  requestId: string;
  status: RequestStatus;
  typeName: string;
}

/** One day somebody is away. Days nobody is away are not listed. */
export interface TeamDay {
  date: CalendarDate;
  away: TeamAwayOn[];
  /** More than one report away, which is the day a manager is looking for. */
  isClash: boolean;
  /** Every report away at once. */
  isEverybody: boolean;
}

/** Who is away when, across the team. FR 56. */
export interface TeamCalendar {
  from: CalendarDate;
  to: CalendarDate;
  /** Only the days somebody is away, soonest first. */
  days: TeamDay[];
  /** The most reports away on any one day. */
  busiest: number;
  /** How many of those days have more than one away. */
  clashes: number;
  /** NFR USA 03. */
  inWords: string;
}

/** A manager's team, for one leave year. FR 55, FR 56, LMS 405. */
export interface TeamView {
  managerId: string;
  /** The year these figures are for. */
  year: LeaveYear;
  /** The years that may be asked for instead. */
  years: LeaveYear[];
  /** How many report to this person. */
  size: number;
  /** Surname first, then forename, then employee number. */
  members: TeamMember[];
  calendar: TeamCalendar;
  /** NFR USA 03. */
  inWords: string;
}

/** Everything a team view is assembled from, all of it read by the caller. */
export interface TeamFacts {
  managerId: string;
  /** FR 55. The direct reports, and nobody beneath them. */
  reports: readonly Employee[];
  year: LeaveYear;
  years: readonly LeaveYear[];
  /** Every leave type there is, retired ones included. */
  types: readonly LeaveType[];
  /** The reports' balances. Keys with no row read as nought, as `linesFor` reads them. */
  balances: readonly LeaveBalance[];
  /** The reports' live leave in this year, from `LeaveRequestRepository.liveOverlapping`. */
  leave: readonly LeaveRequest[];
  /** NFR DAT 03. */
  today: CalendarDate;
}

/**
 * The team, from the facts the service has gathered. FR 55, FR 56, LMS 405.
 *
 * **Direct reports only.** The wider structure beneath them is not here and is not filtered
 * out here either — `EmployeeRepository.findReportsOf` is asked for one level, so a report
 * who manages people of their own brings none of them onto this screen.
 *
 * **Live leave only.** A refused or withdrawn request is not a booking and holds no days.
 *
 * **Nothing is totalled across leave types.** Twenty annual days and three sick days are not
 * twenty-three of anything, which is the rule the balance statement sets. `daysBooked` totals
 * requests rather than allowances, which is a count of days off and not of entitlement.
 */
export function teamViewFor(facts: TeamFacts): TeamView {
  const typesById = new Map(facts.types.map((type) => [type.id, type] as const));

  const members = [...facts.reports]
    .sort(byName)
    .map((report) => memberFor(report, facts, typesById));

  const calendar = calendarFor(members, facts);

  return {
    managerId: facts.managerId,
    year: facts.year,
    years: [...facts.years],
    size: members.length,
    members,
    calendar,
    inWords: teamInWords(members, calendar, facts.year),
  };
}

/** One report, with their figures and their leave. */
function memberFor(
  report: Employee,
  facts: TeamFacts,
  typesById: ReadonlyMap<string, LeaveType>,
): TeamMember {
  const booked = facts.leave
    .filter((request) => request.employeeId === report.id)
    .sort(bySoonest)
    .map((request) => bookingFor(request, typesById));

  const daysBooked = round(booked.reduce((total, one) => total + one.days, 0));

  const awayToday = booked.some((one) => one.from <= facts.today && facts.today <= one.to);

  return {
    employeeId: report.id,
    name: nameOf(report),
    jobTitle: report.jobTitle,
    employmentStatus: report.employmentStatus,
    /** FR 55, FR 05. The same two-limbed rule the person's own statement uses. */
    balances: linesFor({
      employeeId: report.id,
      gender: report.gender,
      year: facts.year,
      years: facts.years,
      types: facts.types,
      balances: facts.balances.filter((balance) => balance.employeeId === report.id),
    }),
    booked,
    daysBooked,
    awayToday,
    inWords: memberInWords(report, booked, daysBooked, awayToday, facts.year),
  };
}

/** One booking. */
function bookingFor(request: LeaveRequest, typesById: ReadonlyMap<string, LeaveType>): TeamBooking {
  const typeName = typesById.get(request.leaveTypeId)?.name ?? 'leave';

  return {
    requestId: request.id,
    leaveTypeId: request.leaveTypeId,
    typeName,
    from: request.from,
    to: request.to,
    countingBasis: request.countingBasis,
    countingBasisLabel: countingBasisLabel(request.countingBasis),
    days: request.days,
    calendarDays: request.calendarDays,
    status: request.status,
    agreed: request.status === 'APPROVED',
    awaiting: request.awaitingApprovalFrom,
    inWords:
      `${formatDay(request.from)} to ${formatDay(request.to)}, ${days(request.days)} of ` +
      `${typeName}, ${standingInWords(request.status)}.`,
  };
}

/** What a live request's status means to the manager reading it. FR 41, FR 48b. */
function standingInWords(status: RequestStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'agreed';
    case 'UNROUTABLE':
      return 'asked for, and nobody could be found to decide it';
    default:
      return 'asked for and not yet decided';
  }
}

/**
 * Who is away on which day. FR 56, the story's calendar.
 *
 * Only the days somebody is away are listed. A year is three hundred and sixty-five rows of
 * which a handful matter, and the ones that matter are the days two people are off at once.
 */
function calendarFor(members: readonly TeamMember[], facts: TeamFacts): TeamCalendar {
  const byDay = new Map<CalendarDate, TeamAwayOn[]>();

  for (const member of members) {
    for (const booking of member.booked) {
      for (const day of eachDay(booking.from, booking.to)) {
        if (day < facts.year.startDate || day > facts.year.endDate) {
          continue;
        }

        const away = byDay.get(day) ?? [];

        away.push({
          employeeId: member.employeeId,
          name: member.name,
          requestId: booking.requestId,
          status: booking.status,
          typeName: booking.typeName,
        });

        byDay.set(day, away);
      }
    }
  }

  const listed: TeamDay[] = [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, away]) => ({
      date,
      away,
      isClash: away.length > 1,
      isEverybody: members.length > 0 && away.length === members.length,
    }));

  const busiest = listed.reduce((most, day) => Math.max(most, day.away.length), 0);
  const clashes = listed.filter((day) => day.isClash).length;

  return {
    from: facts.year.startDate,
    to: facts.year.endDate,
    days: listed,
    busiest,
    clashes,
    inWords: calendarInWords(listed.length, clashes, busiest, facts.year),
  };
}

/* ------------------------------------------------------------------ the sentences */

/** NFR USA 03. */
function teamInWords(
  members: readonly TeamMember[],
  calendar: TeamCalendar,
  year: LeaveYear,
): string {
  if (members.length === 0) {
    return 'Nobody reports to you.';
  }

  const away = members.filter((one) => one.awayToday).length;
  const counted =
    `${people(members.length)} ${members.length === 1 ? 'reports' : 'report'} to you, ` +
    `and ${away === 0 ? 'none of them is' : `${String(away)} of them ${away === 1 ? 'is' : 'are'}`} ` +
    'away today.';

  return calendar.clashes === 0
    ? `${counted} No two of them are booked off on the same day in ${year.label}.`
    : `${counted} ${sentenceCase(days(calendar.clashes))} in ${year.label} ` +
        `${calendar.clashes === 1 ? 'has' : 'have'} more than one of them away.`;
}

/** NFR USA 03. */
function memberInWords(
  report: Employee,
  booked: readonly TeamBooking[],
  daysBooked: number,
  awayToday: boolean,
  year: LeaveYear,
): string {
  const left = report.employmentStatus === 'TERMINATED';

  const has =
    booked.length === 0
      ? `has no leave booked in ${year.label}`
      : `has ${days(daysBooked)} booked in ${year.label}, across ` +
        `${booked.length === 1 ? '1 request' : `${String(booked.length)} requests`}`;

  const undecided = booked.filter((one) => !one.agreed).length;

  return (
    `${nameOf(report)} ${has}.` +
    (undecided === 0
      ? ''
      : ` ${String(undecided)} of ${undecided === 1 ? 'them is' : 'them are'} still to be decided.`) +
    (awayToday ? ' They are away today.' : '') +
    (left ? ' They have left, so this is what stands on the record. FR 06.' : '')
  );
}

/** NFR USA 03. */
function calendarInWords(
  daysAway: number,
  clashes: number,
  busiest: number,
  year: LeaveYear,
): string {
  if (daysAway === 0) {
    return `Nobody on your team has leave booked in ${year.label}.`;
  }

  return (
    `${sentenceCase(days(daysAway))} in ${year.label} ${daysAway === 1 ? 'has' : 'have'} ` +
    `somebody on your team away` +
    (clashes === 0
      ? ', and never more than one at a time.'
      : `, and on ${days(clashes)} of them ${busiest === 2 ? 'two' : `up to ${String(busiest)}`} ` +
        'are away at once.')
  );
}

/* --------------------------------------------------------------------------- helpers */

/** Surname, then forename, then employee number, as the org chart orders people. */
function byName(left: Employee, right: Employee): number {
  return (
    left.lastName.localeCompare(right.lastName) ||
    left.firstName.localeCompare(right.firstName) ||
    left.employeeNumber.localeCompare(right.employeeNumber)
  );
}

/** Soonest to start first, then longest waiting. */
function bySoonest(left: LeaveRequest, right: LeaveRequest): number {
  if (left.from !== right.from) {
    return left.from < right.from ? -1 : 1;
  }

  return left.submittedAt.getTime() - right.submittedAt.getTime();
}

function nameOf(person: Employee): string {
  return `${person.firstName} ${person.lastName}`;
}

function days(count: number): string {
  return `${String(count)} ${count === 1 ? 'day' : 'days'}`;
}

function people(count: number): string {
  return `${String(count)} ${count === 1 ? 'person' : 'people'}`;
}

function sentenceCase(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Back to the precision `days` is stored at, after a sum of decimals. §8.6. */
function round(figure: number): number {
  return Math.round(figure * 100) / 100;
}
