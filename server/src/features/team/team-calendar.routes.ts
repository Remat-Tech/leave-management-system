/** The team calendar, over HTTP. FR 57, LMS 406, LMS 409, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { LeaveYear } from '../leave-year/leave-year.js';
import type {
  Absence,
  AwayDay,
  AwayOn,
  Colleague,
  DepartmentOnTheCalendar,
  TeamCalendarView,
} from './team-calendar.js';
import type { TeamCalendarService } from './team-calendar.service.js';
import { actorOf } from '../../http/identify.js';

export interface TeamCalendarRoutes {
  calendar: TeamCalendarService;
}

export function teamCalendarRoutes({ calendar }: TeamCalendarRoutes): Router {
  const routes = Router();

  /**
   * Who is away, in the department I am in. FR 57, LMS 409.
   *
   * `/me` names the *reader*, and there is no employee id to supply. `departmentId` is the one
   * thing that may be asked for, and asking for another department is HR's — the service
   * refuses it for everybody else rather than the route deciding.
   */
  routes.get('/me/calendar', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    if (actor.employeeId === null) {
      next(new Error('This route was reached by an actor with no employee behind it.'));
      return;
    }

    void calendar
      .forEmployee(actor, actor.employeeId, {
        leaveYearId: oneYearIn(request),
        departmentId: oneDepartmentIn(request),
      })
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
 * The department asked for. LMS 409.
 *
 * The empty string is kept rather than dropped, because it is what "every department" is
 * asked for with — and it is `undefined`, the parameter not being there at all, that means
 * the reader's own.
 */
function oneDepartmentIn(request: Request): string | undefined {
  const value = request.query.departmentId;

  return typeof value === 'string' ? value : undefined;
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
    /** LMS 409. Null where every department is being shown at once. */
    department: departmentAsJson(view.department),
    departments: view.departments.map(departmentAsJson),
    canChooseDepartment: view.canChooseDepartment,
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
    /** LMS 409. The heading they sit under where the calendar spans more than one. */
    department: departmentAsJson(colleague.department),
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

/** A department, written out for the same reason everything else here is. LMS 409. */
function departmentAsJson(department: DepartmentOnTheCalendar | null): unknown {
  return department === null ? null : { id: department.id, name: department.name };
}

function awayAsJson(one: AwayOn): unknown {
  return { employeeId: one.employeeId, name: one.name, agreed: one.agreed, isMe: one.isMe };
}
