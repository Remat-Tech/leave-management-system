/** Database access for public holidays. FR 22, §5.4., LMS 206. */

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { HolidayTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import {
  DuplicateHoliday,
  type Holiday,
  InvalidHoliday,
  type ValidatedHoliday,
} from './holiday.js';
import type { CalendarDate } from '../../shared/time.js';
import { recording } from '../../db/recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `check_violation`, which the blank name rule raises. */
const CHECK_VIOLATION = '23514';

/**
 * Postgres `restrict_violation`, which the settled-year trigger raises with a constraint name of its own so that this file can recognise it the way i…
 */
const RESTRICT_VIOLATION = '23001';

const ONE_PER_DAY = 'holiday_one_per_day';
const SETTLED_YEARS = 'holiday_leaves_settled_years_alone';

/** Which field a refused row is reported against. */
const CHECKED_FIELDS: Record<string, string> = {
  holiday_name_not_blank: 'name',
};

type HolidayRow = Selectable<HolidayTable>;

export interface HolidayListOptions {
  /** The first day to include. */
  from?: CalendarDate;
  /** The last day to include. */
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

  /** Applies a change. */
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

  /** Takes a day off the calendar. */
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

  /** The holiday on a day, or undefined. */
  async findOn(day: CalendarDate): Promise<Holiday | undefined> {
    const row = await this.db
      .selectFrom('holiday')
      .selectAll()
      .where('holiday_date', '=', day)
      .executeTakeFirst();

    return row === undefined ? undefined : toHoliday(row);
  }

  /** The calendar, or a stretch of it, in the order the days fall. */
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
   * Runs a write and turns whatever the database refused it for into the domain error for that refusal.
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
