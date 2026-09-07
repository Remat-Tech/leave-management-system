/** Who is away and when, for a colleague rather than a manager. FR 57, LMS 406. */

import type { Employee, EmploymentStatus } from '../employee/employee.js';
import type { LeaveRequest } from '../leave-request/leave-request.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import { type CalendarDate, eachDay, formatDay } from '../../shared/time.js';

/** No leave year for the calendar to run over. §5.4. */
export class NoLeaveYearForTheCalendar extends Error {
  readonly employeeId: string;

  constructor(employeeId: string) {
    super(
      'There is no leave year to show this calendar over. A calendar runs from the start ' +
        'of a leave year to the end of it, and no leave year has been defined. Ask an HR ' +
        'Administrator to define the one that covers today. §5.4.',
    );
    this.name = 'NoLeaveYearForTheCalendar';
    this.employeeId = employeeId;
  }
}

/** One absence: dates, and nothing about the leave behind them. FR 57. */
export interface Absence {
  /** Ten characters. NFR DAT 03. */
  from: CalendarDate;
  to: CalendarDate;
  /** Days off the calendar. What it costs them is theirs. FR 24. */
  calendarDays: number;
  /** FR 41. Agreed, or asked for and not yet decided. */
  agreed: boolean;
  /** NFR USA 03. */
  inWords: string;
}

/** Somebody on the calendar. FR 57. */
export interface Colleague {
  employeeId: string;
  name: string;
  jobTitle: string | null;
  /** FR 06. A leaver is still on the line until HR moves it. */
  employmentStatus: EmploymentStatus;
  /** The reader. */
  isMe: boolean;
  /** The line manager everybody here shares. */
  isTheManager: boolean;
  awayToday: boolean;
  /** Soonest first. */
  absences: Absence[];
  /** NFR USA 03. */
  inWords: string;
}

/** One person away on one day. */
export interface AwayOn {
  employeeId: string;
  name: string;
  agreed: boolean;
  isMe: boolean;
}

/** One day somebody is away. Days nobody is away are not listed. */
export interface AwayDay {
  date: CalendarDate;
  away: AwayOn[];
  /** Everybody on the calendar, at once. */
  isEverybody: boolean;
}

/** The team calendar, for one leave year. FR 57, LMS 406. */
export interface TeamCalendarView {
  /** The reader. */
  employeeId: string;
  year: LeaveYear;
  years: LeaveYear[];
  from: CalendarDate;
  to: CalendarDate;
  /** How many the calendar covers, the reader included. */
  size: number;
  /** The manager first, then surname order. */
  colleagues: Colleague[];
  /** Only the days somebody is away, soonest first. */
  days: AwayDay[];
  /** The most away on any one day. */
  busiest: number;
  /** Out right now. */
  awayToday: AwayOn[];
  /** NFR USA 03. */
  inWords: string;
}

/** Everything the calendar is assembled from, all of it read by the caller. */
export interface TeamCalendarFacts {
  reader: Employee;
  /** The reader, their line manager, and everybody else reporting to them. */
  team: readonly Employee[];
  year: LeaveYear;
  years: readonly LeaveYear[];
  /** The team's live leave in this year, from `LeaveRequestRepository.liveOverlapping`. */
  leave: readonly LeaveRequest[];
  /** NFR DAT 03. */
  today: CalendarDate;
}

/**
 * The calendar, from the facts the service gathered. FR 57, LMS 406.
 *
 * **Dates and names, and nothing else.** No leave type reaches this function and no reason
 * ever could: `TeamCalendarFacts` carries no `LeaveType`, so a type name is not something
 * this projection chose to leave out — it is something it cannot assemble.
 *
 * **Live leave only.** A refused or withdrawn request is not an absence.
 */
export function teamCalendarFor(facts: TeamCalendarFacts): TeamCalendarView {
  const colleagues = [...facts.team]
    .sort(byManagerThenName(facts.reader.managerId))
    .map((person) => colleagueFor(person, facts));

  const days = daysOf(colleagues, facts);
  const busiest = days.reduce((most, day) => Math.max(most, day.away.length), 0);
  const awayToday = days.find((day) => day.date === facts.today)?.away ?? [];

  return {
    employeeId: facts.reader.id,
    year: facts.year,
    years: [...facts.years],
    from: facts.year.startDate,
    to: facts.year.endDate,
    size: colleagues.length,
    colleagues,
    days,
    busiest,
    awayToday,
    inWords: calendarInWords(colleagues, days, awayToday, busiest, facts.year),
  };
}

/** One person on the calendar, with their dates. */
function colleagueFor(person: Employee, facts: TeamCalendarFacts): Colleague {
  const absences = facts.leave
    .filter((request) => request.employeeId === person.id)
    .sort(bySoonest)
    .map(absenceFor);

  const isMe = person.id === facts.reader.id;
  const awayToday = absences.some((one) => one.from <= facts.today && facts.today <= one.to);

  return {
    employeeId: person.id,
    name: nameOf(person),
    jobTitle: person.jobTitle,
    employmentStatus: person.employmentStatus,
    isMe,
    isTheManager: person.id === facts.reader.managerId,
    awayToday,
    absences,
    inWords: colleagueInWords(person, isMe, absences, awayToday, facts.year),
  };
}

/** FR 57. The span and how long it is, and no field the type or the reason could reach. */
function absenceFor(request: LeaveRequest): Absence {
  return {
    from: request.from,
    to: request.to,
    calendarDays: request.calendarDays,
    agreed: request.status === 'APPROVED',
    inWords:
      `${formatDay(request.from)} to ${formatDay(request.to)}, ` +
      `${days(request.calendarDays)} away, ` +
      `${request.status === 'APPROVED' ? 'agreed' : 'asked for and not yet decided'}.`,
  };
}

/** Who is away on which day. Days nobody is away are not listed. */
function daysOf(colleagues: readonly Colleague[], facts: TeamCalendarFacts): AwayDay[] {
  const byDay = new Map<CalendarDate, AwayOn[]>();

  for (const colleague of colleagues) {
    for (const absence of colleague.absences) {
      for (const day of eachDay(absence.from, absence.to)) {
        if (day < facts.year.startDate || day > facts.year.endDate) {
          continue;
        }

        const away = byDay.get(day) ?? [];

        away.push({
          employeeId: colleague.employeeId,
          name: colleague.name,
          agreed: absence.agreed,
          isMe: colleague.isMe,
        });

        byDay.set(day, away);
      }
    }
  }

  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([date, away]) => ({
      date,
      away,
      isEverybody: colleagues.length > 0 && away.length === colleagues.length,
    }));
}

/* ------------------------------------------------------------------ the sentences */

/** NFR USA 03. Says what the calendar shows, and what it deliberately does not. FR 57. */
function calendarInWords(
  colleagues: readonly Colleague[],
  awayDays: readonly AwayDay[],
  awayToday: readonly AwayOn[],
  busiest: number,
  year: LeaveYear,
): string {
  const privacy =
    'It shows who is away and on which dates, and nothing about what kind of leave it ' +
    'is or why.';

  if (colleagues.length === 0) {
    return `There is nobody on your team calendar. ${privacy}`;
  }

  const counted =
    `${people(colleagues.length)} on this calendar, you included, and ` +
    `${awayToday.length === 0 ? 'none of them is' : `${String(awayToday.length)} ${awayToday.length === 1 ? 'is' : 'are'}`} ` +
    'away today.';

  if (awayDays.length === 0) {
    return `${counted} Nobody has leave booked in ${year.label}. ${privacy}`;
  }

  return (
    `${counted} ${sentenceCase(days(awayDays.length))} in ${year.label} ` +
    `${awayDays.length === 1 ? 'has' : 'have'} somebody away` +
    (busiest < 2 ? ', never more than one at a time' : `, up to ${String(busiest)} at once`) +
    `. ${privacy}`
  );
}

/** NFR USA 03. */
function colleagueInWords(
  person: Employee,
  isMe: boolean,
  absences: readonly Absence[],
  awayToday: boolean,
  year: LeaveYear,
): string {
  const who = isMe ? 'You have' : `${nameOf(person)} has`;
  const they = isMe ? 'You are' : 'They are';

  const booked =
    absences.length === 0
      ? `${who} nothing booked in ${year.label}.`
      : `${who} ${absences.length === 1 ? '1 absence' : `${String(absences.length)} absences`} ` +
        `booked in ${year.label}, over ${days(totalOf(absences))}.`;

  return (
    booked +
    (awayToday ? ` ${they} away today.` : '') +
    (person.employmentStatus === 'TERMINATED' ? ' They have left. FR 06.' : '')
  );
}

/* --------------------------------------------------------------------------- helpers */

/** The shared line manager first, then surname, forename, employee number. */
function byManagerThenName(managerId: string | null) {
  return (left: Employee, right: Employee): number => {
    if ((left.id === managerId) !== (right.id === managerId)) {
      return left.id === managerId ? -1 : 1;
    }

    return (
      left.lastName.localeCompare(right.lastName) ||
      left.firstName.localeCompare(right.firstName) ||
      left.employeeNumber.localeCompare(right.employeeNumber)
    );
  };
}

/** Soonest to start first, then longest waiting. */
function bySoonest(left: LeaveRequest, right: LeaveRequest): number {
  if (left.from !== right.from) {
    return left.from < right.from ? -1 : 1;
  }

  return left.submittedAt.getTime() - right.submittedAt.getTime();
}

function totalOf(absences: readonly Absence[]): number {
  return absences.reduce((total, one) => total + one.calendarDays, 0);
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
