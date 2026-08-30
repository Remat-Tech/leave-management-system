/**
 * Database access for public holidays. FR 22, §5.4. LMS 206.
 *
 * Queries and row mapping, nothing else. What a holiday is and how a stretch of
 * days is read against the calendar is ../domain/holiday.ts; when the calendar may
 * be changed is ../services/holiday-service.ts.
 *
 * Refusals are translated rather than allowed to surface, the same way the leave
 * type, leave year and entitlement rule repositories do it and for the same
 * reason: checking first and writing afterwards is a race. Two officers
 * transcribing the same gazette in the same minute both find the sixth of March
 * free and both write it; `holiday_one_per_day` is what actually decides, and this
 * turns its answer back into the domain error for it.
 *
 * The other translated refusal is the settled year, which is *not* a race and is
 * here anyway. The service checks it first with a clearer message — it can name
 * the earliest day still open — but a leave year is closed by somebody else while
 * this officer has the form open, and a write either side of that instant has to
 * be refused rather than accepted by whichever half of the second it landed in.
 * The trigger is the guarantee; the service's check is the sentence.
 *
 * Unlike the other configuration repositories there is a {@link
 * HolidayRepository.remove}, and it is a real delete. `lms_app` holds DELETE on
 * this table because nothing is filed under a holiday: what a request stores is
 * the days it cost, not which days those were. See the privileges section of the
 * public-holiday-calendar migration.
 */

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../db/index.js';
import type { HolidayTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import {
  DuplicateHoliday,
  type Holiday,
  InvalidHoliday,
  type ValidatedHoliday,
} from '../domain/holiday.js';
import type { CalendarDate } from '../domain/time.js';
import { recording } from './recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `check_violation`, which the blank name rule raises. */
const CHECK_VIOLATION = '23514';

/**
 * Postgres `restrict_violation`, which the settled-year trigger raises with a
 * constraint name of its own so that this file can recognise it the way it
 * recognises a real constraint.
 */
const RESTRICT_VIOLATION = '23001';

const ONE_PER_DAY = 'holiday_one_per_day';
const SETTLED_YEARS = 'holiday_leaves_settled_years_alone';

/**
 * Which field a refused row is reported against.
 *
 * Read from the constraint name the driver hands back rather than guessed from
 * the message, so a violation of some future constraint is re-thrown as itself.
 */
const CHECKED_FIELDS: Record<string, string> = {
  holiday_name_not_blank: 'name',
};

type HolidayRow = Selectable<HolidayTable>;

export interface HolidayListOptions {
  /** The first day to include. Inclusive. */
  from?: CalendarDate;
  /** The last day to include. Inclusive, because a calendar's last day is a day. */
  to?: CalendarDate;
}

export class HolidayRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(by: Attribution, record: ValidatedHoliday): Promise<Holiday> {
    return this.catchRefusals(record.date, async () => {
      const row = await recording(this.db, by, (on) =>
        on.insertInto('holiday').values(rowFor(record)).returningAll().executeTakeFirstOrThrow(),
      );

      return toHoliday(row);
    });
  }

  /**
   * Applies a change. Returns undefined if there is no such holiday, which the
   * service turns into {@link HolidayNotFound}.
   *
   * updated_at is not set here, for the reason it is not set in any of the other
   * repositories: the trigger does it, so a migration correcting data and the
   * seed get the same treatment as the application rather than only the writer
   * who remembered.
   */
  async update(
    by: Attribution,
    holiday: Holiday,
    changes: Partial<ValidatedHoliday>,
  ): Promise<Holiday | undefined> {
    const values = changedColumnsOf(changes);

    if (Object.keys(values).length === 0) {
      // A form somebody submitted without touching it. The record should come
      // back as it stands rather than being rewritten with itself.
      return this.findById(holiday.id);
    }

    return this.catchRefusals(changes.date ?? holiday.date, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('holiday')
          .set(values)
          .where('id', '=', holiday.id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toHoliday(row);
    });
  }

  /**
   * Takes a day off the calendar. A real delete.
   *
   * False rather than a throw when there was nothing to remove, so the service
   * decides what a missing record means — which it does differently depending on
   * whether it had already read one.
   */
  async remove(by: Attribution, holiday: Holiday): Promise<boolean> {
    return this.catchRefusals(holiday.date, async () => {
      const deleted = await recording(this.db, by, (on) =>
        on.deleteFrom('holiday').where('id', '=', holiday.id).executeTakeFirst(),
      );

      return deleted.numDeletedRows > 0n;
    });
  }

  async findById(id: string): Promise<Holiday | undefined> {
    const row = await this.db
      .selectFrom('holiday')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toHoliday(row);
  }

  /**
   * The holiday on a day, or undefined.
   *
   * The read every day count makes, and `holiday_one_per_day` is why there is no
   * ORDER BY picking a winner: a query that ordered would be a second answer to a
   * question the schema already answers once.
   */
  async findOn(day: CalendarDate): Promise<Holiday | undefined> {
    const row = await this.db
      .selectFrom('holiday')
      .selectAll()
      .where('holiday_date', '=', day)
      .executeTakeFirst();

    return row === undefined ? undefined : toHoliday(row);
  }

  /**
   * The calendar, or a stretch of it, in the order the days fall.
   *
   * Both bounds inclusive, because a leave request's last day is a day somebody is
   * away and a half open range here would drop a Christmas Day that a request
   * ended on. `holiday_one_per_day` serves the range scan as well as the
   * uniqueness — see the migration.
   */
  async list(options: HolidayListOptions = {}): Promise<Holiday[]> {
    let query = this.db.selectFrom('holiday').selectAll();

    if (options.from !== undefined) {
      query = query.where('holiday_date', '>=', options.from);
    }
    if (options.to !== undefined) {
      query = query.where('holiday_date', '<=', options.to);
    }

    return (await query.orderBy('holiday_date').execute()).map(toHoliday);
  }

  /**
   * Runs a write and turns whatever the database refused it for into the domain
   * error for that refusal.
   *
   * `day` is the day the write was about, so that a duplicate can name it. On an
   * edit that is the new date where one was given and the stored one otherwise,
   * because a rename leaving the date alone can still collide with nothing else.
   */
  private async catchRefusals<T>(day: CalendarDate, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (violation?.code === UNIQUE_VIOLATION && violation.constraint === ONE_PER_DAY) {
        throw new DuplicateHoliday(day);
      }

      if (violation?.code === RESTRICT_VIOLATION && violation.constraint === SETTLED_YEARS) {
        /* Reached by losing a race — a leave year closed while this officer had
           the form open — or by a writer that did not come through the service.
           Reported as an {@link InvalidHoliday} against the date rather than as a
           {@link HolidayInASettledYear}, the same choice the leave year repository
           makes for its own trigger: that error promises to name the earliest day
           still open, and the boundary is the service's to read. What is carried
           instead is the database's own message, which names the year and the day
           it was closed on — which is the half the person actually needs. */
        throw new InvalidHoliday(
          'date',
          error instanceof Error ? error.message : `The holiday breaks ${violation.constraint}.`,
        );
      }

      if (violation?.code === CHECK_VIOLATION) {
        const field = CHECKED_FIELDS[violation.constraint];

        if (field !== undefined) {
          throw new InvalidHoliday(
            field,
            error instanceof Error ? error.message : `The holiday breaks ${violation.constraint}.`,
          );
        }
      }

      throw error;
    }
  }
}

/**
 * The SQLSTATE and constraint name of a refusal, when the error carries both.
 *
 * The same shape as the other repositories', and separate from them for the same
 * reason they are separate from each other: no repository imports another, and a
 * shared copy of six lines would be the first thing to grow a parameter.
 */
function violationOf(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  return typeof code === 'string' && typeof constraint === 'string'
    ? { code, constraint }
    : undefined;
}

/** A whole validated record as the columns it is written to. */
function rowFor(record: ValidatedHoliday): Insertable<HolidayTable> {
  return {
    name: record.name,
    holiday_date: record.date,
  };
}

/**
 * The fields a change actually named, as columns.
 *
 * `in` rather than a check for undefined, so that sending the whole record is
 * never mistaken for a change to all of it — which would silently revert whatever
 * a colleague moved while this caller had the form open.
 */
function changedColumnsOf(changes: Partial<ValidatedHoliday>): Updateable<HolidayTable> {
  const values: Updateable<HolidayTable> = {};

  if ('name' in changes) values.name = changes.name;
  if ('date' in changes) values.holiday_date = changes.date;

  return values;
}

/**
 * A row as the domain sees it.
 *
 * The date arrives as the ten characters it is stored as, not as a `Date`: the
 * driver is configured in ../db/index.ts to hand `date` columns back untouched,
 * which is the off by one day bug NFR DAT 03 exists to prevent — and on this table
 * it would be the bug that gives somebody Christmas Eve off instead of Christmas.
 */
function toHoliday(row: HolidayRow): Holiday {
  return {
    id: row.id,
    name: row.name,
    date: row.holiday_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
