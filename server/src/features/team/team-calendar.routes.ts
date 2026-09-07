/** The team calendar, over HTTP. FR 57, LMS 406, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { LeaveYear } from '../leave-year/leave-year.js';
import type { Absence, AwayDay, AwayOn, Colleague, TeamCalendarView } from './team-calendar.js';
import type { TeamCalendarService } from './team-calendar.service.js';
import { actorOf } from '../../http/identify.js';

export interface TeamCalendarRoutes {
  calendar: TeamCalendarService;
}

export function teamCalendarRoutes({ calendar }: TeamCalendarRoutes): Router {
  const routes = Router();

  /**
   * Who is away, on the team I am on. FR 57.
   *
   * `/me` names the *reader*, and there is no id to supply: the calendar is whoever shares
   * their line manager. Somebody else's team cannot be asked for.
   */
  routes.get('/me/calendar', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    if (actor.employeeId === null) {
      next(new Error('This route was reached by an actor with no employee behind it.'));
      return;
    }

    void calendar
      .forEmployee(actor, actor.employeeId, { leaveYearId: oneYearIn(request) })
      .then((view) => {
        response.json(calendarAsJson(view));
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

/**
 * The whole answer, field by field.
 *
 * Written out rather than sent whole, so that a field added to the domain reaches a colleague
 * only when somebody edits this file. FR 57.
 */
function calendarAsJson(view: TeamCalendarView): unknown {
  return {
    employeeId: view.employeeId,
    year: yearAsJson(view.year),
    years: view.years.map(yearAsJson),
    from: view.from,
    to: view.to,
    size: view.size,
    busiest: view.busiest,
    inWords: view.inWords,
    awayToday: view.awayToday.map(awayAsJson),
    colleagues: view.colleagues.map(colleagueAsJson),
    days: view.days.map(dayAsJson),
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

function colleagueAsJson(colleague: Colleague): unknown {
  return {
    employeeId: colleague.employeeId,
    name: colleague.name,
    jobTitle: colleague.jobTitle,
    /** FR 06. */
    employmentStatus: colleague.employmentStatus,
    isMe: colleague.isMe,
    isTheManager: colleague.isTheManager,
    awayToday: colleague.awayToday,
    inWords: colleague.inWords,
    absences: colleague.absences.map(absenceAsJson),
  };
}

/** FR 57. Dates and how long, and no handle on the request behind them. */
function absenceAsJson(absence: Absence): unknown {
  return {
    /** Ten characters, each way. NFR DAT 03. */
    from: absence.from,
    to: absence.to,
    calendarDays: absence.calendarDays,
    /** FR 41. */
    agreed: absence.agreed,
    inWords: absence.inWords,
  };
}

function dayAsJson(day: AwayDay): unknown {
  return {
    date: day.date,
    isEverybody: day.isEverybody,
    away: day.away.map(awayAsJson),
  };
}

function awayAsJson(one: AwayOn): unknown {
  return { employeeId: one.employeeId, name: one.name, agreed: one.agreed, isMe: one.isMe };
}
