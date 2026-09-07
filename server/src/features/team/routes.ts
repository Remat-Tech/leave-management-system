/** The team screen, over HTTP. FR 55, FR 56, LMS 405, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { BalanceStatementLine } from '../balance/balance-statement.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import type { TeamBooking, TeamCalendar, TeamDay, TeamMember, TeamView } from './team.js';
import type { TeamService } from './team.service.js';
import { actorOf } from '../../http/identify.js';

export interface TeamRoutes {
  team: TeamService;
}

export function teamRoutes({ team }: TeamRoutes): Router {
  const routes = Router();

  /**
   * The people who report to me, with their balances and their booked leave. FR 55, FR 56.
   *
   * `/me` names the *manager*, and there is no id to supply: the team is whoever reports to
   * the id on the verified cookie. A manager two levels up sees their own reports here and
   * reaches nobody below them.
   */
  routes.get('/me/team', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    if (actor.employeeId === null) {
      next(new Error('This route was reached by an actor with no employee behind it.'));
      return;
    }

    void team
      .forManager(actor, actor.employeeId, { leaveYearId: oneYearIn(request) })
      .then((view) => {
        response.json(teamAsJson(view));
      })
      .catch(next);
  });

  return routes;
}

/** The leave year asked for, where one string was asked for. */
function oneYearIn(request: Request): string | undefined {
  const value = request.query.leaveYearId;

  return typeof value === 'string' && value !== '' ? value : undefined;
}

function teamAsJson(view: TeamView): unknown {
  return {
    managerId: view.managerId,
    year: yearAsJson(view.year),
    years: view.years.map(yearAsJson),
    size: view.size,
    inWords: view.inWords,
    members: view.members.map(memberAsJson),
    calendar: calendarAsJson(view.calendar),
  };
}

/** A leave year. NFR DAT 03. */
function yearAsJson(year: LeaveYear): unknown {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isClosed: year.isClosed,
  };
}

function memberAsJson(member: TeamMember): unknown {
  return {
    employeeId: member.employeeId,
    name: member.name,
    jobTitle: member.jobTitle,
    /** FR 06. */
    employmentStatus: member.employmentStatus,
    daysBooked: member.daysBooked,
    awayToday: member.awayToday,
    inWords: member.inWords,
    /** FR 55. */
    balances: member.balances.map(lineAsJson),
    /** FR 56. */
    booked: member.booked.map(bookingAsJson),
  };
}

/** One line of a report's balance, as `/api/me/balances` sends the reader's own. FR 55. */
function lineAsJson(line: BalanceStatementLine): unknown {
  return {
    leaveTypeId: line.leaveTypeId,
    code: line.code,
    name: line.name,
    countingBasis: line.countingBasis,
    countingBasisLabel: line.countingBasisLabel,
    entitlementBasis: line.entitlementBasis,
    allowanceInWords: line.allowanceInWords,
    unit: line.unit,
    isPaid: line.isPaid,
    stillOffered: line.stillOffered,

    entitled: line.entitled,
    carriedOver: line.carriedOver,
    adjustment: line.adjustment,
    taken: line.taken,
    pending: line.pending,
    owed: line.owed,
    available: line.available,

    hasMoved: line.hasMoved,
    /** An instant, and the only thing here that is. NFR DAT 03. */
    updatedAt: line.updatedAt === null ? null : line.updatedAt.toISOString(),
  };
}

function bookingAsJson(booking: TeamBooking): unknown {
  return {
    requestId: booking.requestId,
    leaveTypeId: booking.leaveTypeId,
    typeName: booking.typeName,
    /** Ten characters, each way. NFR DAT 03. */
    from: booking.from,
    to: booking.to,
    countingBasis: booking.countingBasis,
    countingBasisLabel: booking.countingBasisLabel,
    days: booking.days,
    calendarDays: booking.calendarDays,
    status: booking.status,
    agreed: booking.agreed,
    /** FR 38a. */
    awaiting: booking.awaiting,
    inWords: booking.inWords,
  };
}

function calendarAsJson(calendar: TeamCalendar): unknown {
  return {
    from: calendar.from,
    to: calendar.to,
    busiest: calendar.busiest,
    clashes: calendar.clashes,
    inWords: calendar.inWords,
    days: calendar.days.map(dayAsJson),
  };
}

function dayAsJson(day: TeamDay): unknown {
  return {
    date: day.date,
    isClash: day.isClash,
    isEverybody: day.isEverybody,
    away: day.away.map((one) => ({
      employeeId: one.employeeId,
      name: one.name,
      requestId: one.requestId,
      status: one.status,
      typeName: one.typeName,
    })),
  };
}
