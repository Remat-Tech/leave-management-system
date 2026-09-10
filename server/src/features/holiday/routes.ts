/** The holiday calendar screen, over HTTP. FR 22, LMS 504. */

import { type Request, type Response, Router } from 'express';
import type { HolidayService } from './holiday.service.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import {
  closedYearsInWords,
  fixedReason,
  type Holiday,
  type HolidayChanges,
  type NewHoliday,
  yearsWithoutHolidays,
} from './holiday.js';
import { earliestOpenDayOf, type LeaveYear, yearFor } from '../leave-year/leave-year.js';
import { type CalendarDate, calendarDateIn, formatDay, isoWeekdayOf } from '../../shared/time.js';
import { actorOf } from '../../http/identify.js';

export interface HolidayRoutes {
  holidays: HolidayService;
  /** FR 22. Where the closed years end, and what each day is filed under. */
  years: LeaveYearRepository;
}

/** The fields a change may name. */
const CHANGEABLE = ['name', 'date'] as const;

/** ISO weekday order, so `isoWeekdayOf` indexes straight into it. */
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function holidayRoutes(parts: HolidayRoutes): Router {
  const routes = Router();

  /**
   * The whole calendar, with the vocabulary a form needs. FR 22.
   *
   * Never a stretch of it: `yearsAwaitingACalendar` is a claim about every year at once, and
   * a filtered read would make it say a year was empty because the query skipped it.
   */
  routes.get('/holidays', (_request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void Promise.all([parts.holidays.list(actor), parts.years.list()])
      .then(([found, years]) => {
        const earliestOpenDay = earliestOpenDayOf(years);

        response.json({
          holidays: found.map((holiday) => holidayAsJson(holiday, years, earliestOpenDay)),
          years: years.map(yearAsJson),
          /** FR 22. A year nobody has transcribed the gazette for, before December. */
          yearsAwaitingACalendar: yearsWithoutHolidays(years, found).map(yearAsJson),
          today: calendarDateIn(new Date(), 'UTC'),
          /** Null where nothing has been closed, which is not the same as no check. */
          earliestOpenDay,
          closedYearsInWords: closedYearsInWords(earliestOpenDay),
        });
      })
      .catch(next);
  });

  /** Adds a day. */
  routes.post('/holidays', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.holidays
      .add(actor, bodyOf(request) as unknown as NewHoliday)
      .then(async (added) => {
        response.status(201).json(await withItsYear(parts, added));
      })
      .catch(next);
  });

  /** Renames a day or moves it. Only what is sent changes. */
  routes.patch('/holidays/:id', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.holidays
      .correct(actor, asString(request.params.id), changesIn(request))
      .then(async (corrected) => {
        response.json(await withItsYear(parts, corrected));
      })
      .catch(next);
  });

  /** Takes a day off the calendar, making it a working day again. */
  routes.delete('/holidays/:id', (request: Request, response: Response, next) => {
    void parts.holidays
      .remove(actorOf(response), asString(request.params.id))
      .then(() => {
        response.status(204).end();
      })
      .catch(next);
  });

  return routes;
}

/** One day as the screen needs it: the columns, and the sentences they add up to. */
function holidayAsJson(
  holiday: Holiday,
  years: readonly LeaveYear[],
  earliestOpenDay: CalendarDate | null,
): unknown {
  const fixed = fixedReason(holiday, earliestOpenDay);
  const year = yearFor(years, holiday.date);

  return {
    id: holiday.id,
    name: holiday.name,
    date: holiday.date,
    inWords: formatDay(holiday.date),
    weekday: WEEKDAYS[isoWeekdayOf(holiday.date) - 1],

    /* Null where the day falls outside every leave year HR has defined, which is a gap in
       the configuration rather than a fault. The screen files those under their own heading. */
    leaveYearId: year?.id ?? null,
    leaveYearLabel: year?.label ?? null,

    /** FR 22. Whether the calendar is still open for it, and the sentence saying it is not. */
    mayBeChanged: fixed === null,
    fixedReason: fixed,

    createdAt: holiday.createdAt.toISOString(),
    updatedAt: holiday.updatedAt.toISOString(),
  };
}

function yearAsJson(year: LeaveYear): unknown {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isClosed: year.isClosed,
  };
}

/** One written day, with the year it landed in. */
async function withItsYear(parts: HolidayRoutes, holiday: Holiday): Promise<unknown> {
  const years = await parts.years.list();

  return holidayAsJson(holiday, years, earliestOpenDayOf(years));
}

/**
 * The fields a change named, untouched.
 *
 * `in` rather than a truthiness check: renaming a day and moving it are different
 * instructions all the way down to the UPDATE.
 */
function changesIn(request: Request): HolidayChanges {
  const sent = bodyOf(request);
  const changes: Record<string, unknown> = {};

  for (const field of CHANGEABLE) {
    if (field in sent) {
      changes[field] = sent[field];
    }
  }

  return changes as HolidayChanges;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
