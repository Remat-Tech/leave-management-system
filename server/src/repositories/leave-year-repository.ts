/**
 * Database access for leave years. §5.4. LMS 205.
 *
 * Queries and row mapping, nothing else. What a leave year is and which day falls
 * in which one is ../domain/leave-year.ts; when a year may be closed is
 * ../services/leave-year-service.ts.
 *
 * Refusals are translated rather than allowed to surface, the same way the leave
 * type and working pattern repositories do it and for the same reason: checking
 * first and writing afterwards is a race. Two administrators defining 2028 at the
 * same moment both find the table free of it and both write it; the exclusion
 * constraint is what actually decides, and this turns its answer back into the
 * domain error for it.
 *
 * That matters more here than usual, because two of the three rules are deferred.
 * `leave_year_never_overlaps` and `leave_year_leaves_no_gap` are both checked at
 * COMMIT, so the refusal arrives from the commit rather than from the statement —
 * which is why {@link LeaveYearRepository.catchRefusals} wraps the whole
 * transaction rather than the write inside it.
 *
 * There is no `remove`. lms_app holds no DELETE on this table — see the privileges
 * section of the leave-year-rules migration — so a delete method here would be one
 * that always fails, which is worse than one that does not exist. A leave year is
 * the heading a year of balances is filed under.
 */

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveYearTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import {
  DuplicateLeaveYearLabel,
  InvalidLeaveYear,
  type LeaveYear,
  type ValidatedLeaveYear,
} from '../domain/leave-year.js';
import type { CalendarDate } from '../domain/time.js';
import { recording } from './recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `exclusion_violation`, which is what two overlapping years raise. */
const EXCLUSION_VIOLATION = '23P01';

/** Postgres `check_violation`, which the gap trigger and both date rules raise. */
const CHECK_VIOLATION = '23514';

/**
 * Postgres `restrict_violation`, which the closed-year trigger raises with a
 * constraint name of its own so that this file can recognise it the way it
 * recognises a real constraint.
 */
const RESTRICT_VIOLATION = '23001';

const LABEL_INDEX = 'leave_year_label_unique';
const OVERLAP_CONSTRAINT = 'leave_year_never_overlaps';
const GAP_CONSTRAINT = 'leave_year_leaves_no_gap';
const CLOSED_IS_FINAL = 'leave_year_closed_is_final';

/**
 * Which field a refused row is reported against.
 *
 * Read from the constraint name the driver hands back rather than guessed from
 * the message, so a violation of some future constraint is re-thrown as itself.
 * Every one of these is held in the domain as well, so reaching one means the
 * write came from outside this application — or from a race the domain cannot
 * see, which is the whole reason the database is asked at all.
 */
const CHECKED_FIELDS: Record<string, string> = {
  leave_year_label_not_blank: 'label',
  leave_year_runs_forwards: 'endDate',
  leave_year_closed_at_agrees: 'isClosed',
};

type LeaveYearRow = Selectable<LeaveYearTable>;

export interface LeaveYearListOptions {
  /** Only the years still open, which are the ones anything may still be written into. */
  openOnly?: boolean;
}

export class LeaveYearRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(by: Attribution, record: ValidatedLeaveYear): Promise<LeaveYear> {
    return this.catchRefusals(record, async () => {
      const row = await recording(this.db, by, (on) =>
        on.insertInto('leave_year').values(rowFor(record)).returningAll().executeTakeFirstOrThrow(),
      );

      return toLeaveYear(row);
    });
  }

  /**
   * Applies a change. Returns undefined if there is no such year, which the
   * service turns into {@link LeaveYearNotFound}.
   *
   * updated_at is not set here, for the reason it is not set in any of the other
   * repositories: the trigger does it, so a migration correcting data and the
   * seed get the same treatment as the application rather than only the writer
   * who remembered.
   */
  async update(
    by: Attribution,
    id: string,
    changes: Partial<ValidatedLeaveYear>,
  ): Promise<LeaveYear | undefined> {
    const values = changedColumnsOf(changes);

    if (Object.keys(values).length === 0) {
      // A form somebody submitted without touching it. The record should come
      // back as it stands rather than being rewritten with itself.
      return this.findById(id);
    }

    return this.catchRefusals(changes, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('leave_year')
          .set(values)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toLeaveYear(row);
    });
  }

  /**
   * Closes a year. The one write this story is about.
   *
   * Only the flag is sent. `closed_at` is stamped by the trigger rather than
   * supplied here, so that a year closed from a psql prompt carries the same
   * stamp as one closed through this method — the same argument `updated_at`
   * makes, and it matters more here because the stamp is the record of the
   * decision rather than of a housekeeping detail.
   *
   * There is no counterpart. Reopening a year is refused by
   * `leave_year_closed_is_final` for every writer, so a method for it would be a
   * method that always fails.
   */
  async close(by: Attribution, id: string): Promise<LeaveYear | undefined> {
    return this.catchRefusals({}, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('leave_year')
          .set({ is_closed: true })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toLeaveYear(row);
    });
  }

  async findById(id: string): Promise<LeaveYear | undefined> {
    const row = await this.db
      .selectFrom('leave_year')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toLeaveYear(row);
  }

  /**
   * By label, compared without regard to case, so a lookup finds the same single
   * record the unique index would have refused a second of.
   */
  async findByLabel(label: string): Promise<LeaveYear | undefined> {
    const row = await this.db
      .selectFrom('leave_year')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['label']), '=', label.trim().toLowerCase()))
      .executeTakeFirst();

    return row === undefined ? undefined : toLeaveYear(row);
  }

  /**
   * The year a day falls in, or undefined.
   *
   * A containment search rather than a fetch of every year and a filter, because
   * this is the read every balance question makes and there will be one row per
   * year for the life of the system. `leave_year_by_day` is the index.
   *
   * The rule that there is at most one to find is `leave_year_never_overlaps`,
   * not this query — which is why there is no ORDER BY to pick a winner. A query
   * that ordered would be a second answer to a question the schema already
   * answers once.
   */
  async findCovering(day: CalendarDate): Promise<LeaveYear | undefined> {
    const row = await this.db
      .selectFrom('leave_year')
      .selectAll()
      .where('start_date', '<=', day)
      .where('end_date', '>=', day)
      .executeTakeFirst();

    return row === undefined ? undefined : toLeaveYear(row);
  }

  /** Every year, in the order they run, which is the order a screen shows them. */
  async list(options: LeaveYearListOptions = {}): Promise<LeaveYear[]> {
    let query = this.db.selectFrom('leave_year').selectAll();

    if (options.openOnly === true) {
      query = query.where('is_closed', '=', false);
    }

    return (await query.orderBy('start_date').execute()).map(toLeaveYear);
  }

  /**
   * Runs a write and turns whatever the database refused it for into the domain
   * error for that refusal.
   *
   * Two of the three rules are deferred, so their refusal arrives when the
   * transaction commits rather than when the statement runs. `recording` opens
   * that transaction, so this has to wrap the call to it rather than the write
   * inside — a try around the statement alone would catch nothing at all and the
   * driver's error would surface untranslated.
   */
  private async catchRefusals<T>(
    attempted: Partial<ValidatedLeaveYear>,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (violation?.code === UNIQUE_VIOLATION && violation.constraint === LABEL_INDEX) {
        throw new DuplicateLeaveYearLabel(attempted.label ?? '');
      }

      if (
        violation?.code === EXCLUSION_VIOLATION ||
        (violation?.code === CHECK_VIOLATION && violation.constraint === GAP_CONSTRAINT) ||
        (violation?.code === CHECK_VIOLATION && violation.constraint === CLOSED_IS_FINAL) ||
        (violation?.code === RESTRICT_VIOLATION && violation.constraint === CLOSED_IS_FINAL)
      ) {
        /* Reached by losing a race — two administrators defining the same year, or
           one closing a year the other is still editing — or by a writer that did
           not come through the service. The database is right either way, and its
           message names the year and the days, which is what the person needs.
           Reported against the field a form would put it beside. */
        throw new InvalidLeaveYear(
          violation.constraint === OVERLAP_CONSTRAINT || violation.constraint === GAP_CONSTRAINT
            ? 'startDate'
            : 'isClosed',
          error instanceof Error ? error.message : `The leave year breaks ${violation.constraint}.`,
        );
      }

      if (violation?.code === CHECK_VIOLATION) {
        const field = CHECKED_FIELDS[violation.constraint];

        if (field !== undefined) {
          throw new InvalidLeaveYear(
            field,
            error instanceof Error
              ? error.message
              : `The leave year breaks ${violation.constraint}.`,
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
function rowFor(record: ValidatedLeaveYear): Insertable<LeaveYearTable> {
  return {
    label: record.label,
    start_date: record.startDate,
    end_date: record.endDate,
  };
}

/**
 * The fields a change actually named, as columns.
 *
 * `in` rather than a check for undefined, so that sending the whole record is
 * never mistaken for a change to all of it — which would silently revert whatever
 * a colleague moved while this caller had the form open.
 */
function changedColumnsOf(changes: Partial<ValidatedLeaveYear>): Updateable<LeaveYearTable> {
  const values: Updateable<LeaveYearTable> = {};

  if ('label' in changes) values.label = changes.label;
  if ('startDate' in changes) values.start_date = changes.startDate;
  if ('endDate' in changes) values.end_date = changes.endDate;

  return values;
}

/**
 * A row as the domain sees it.
 *
 * The two dates arrive as the ten characters they are stored as, not as `Date`s:
 * the driver is configured in ../db/index.ts to hand `date` columns back
 * untouched, which is the off by one day bug NFR DAT 03 exists to prevent.
 * `closed_at` is an instant and stays one.
 */
function toLeaveYear(row: LeaveYearRow): LeaveYear {
  return {
    id: row.id,
    label: row.label,
    startDate: row.start_date,
    endDate: row.end_date,
    isClosed: row.is_closed,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
