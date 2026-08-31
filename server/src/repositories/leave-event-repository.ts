/**
 * Database access for entitlement events. FR 32g, FR 32e. LMS 218.
 *
 * Queries and row mapping, nothing else. What an event is and what lapses is
 * ../domain/leave-event.ts; who may record one is ../services/leave-event-service.ts.
 *
 * ## Two writers, and the second one writes a single column
 *
 * {@link LeaveEventRepository.record} inserts, and {@link LeaveEventRepository.markLapsed}
 * sets `lapsed_entry_id`. Nothing else, ever: the
 * event-based-entitlement-grants migration refuses an update to any other column on
 * every connection, so a third method here would be one that always fails.
 *
 * There is no `remove`. `lms_app` holds no DELETE on this table and the owner is
 * refused by a trigger — an event heads a `GRANT` that is in the ledger forever, so
 * deleting the row would leave days in a balance with nothing to explain them.
 *
 * ## Refusals are translated rather than allowed to surface
 *
 * The same arrangement the leave year and leave type repositories use, and for the
 * same reason: checking first and writing afterwards is a race. Two people recording
 * the same birth in the same second both find the table free of it and both write;
 * the unique index is what actually decides, and this turns its answer back into
 * {@link EventAlreadyRecorded}, which is a sentence a form can show.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveEntitlementEventTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import {
  AlreadyLapsed,
  EventAlreadyRecorded,
  InvalidLeaveEvent,
  type LeaveEvent,
  type ValidatedLeaveEvent,
} from '../domain/leave-event.js';
import type { CalendarDate } from '../domain/time.js';
import { recording } from './recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `restrict_violation`, which every trigger on this table raises. */
const RESTRICT_VIOLATION = '23001';

const ONE_PER_DAY = 'leave_entitlement_event_one_per_day';
const LAPSES_ONCE = 'leave_entitlement_event_lapses_once';

/**
 * Which field a refused row is reported against.
 *
 * Read from the constraint name the driver hands back rather than guessed from the
 * message, so a violation of some future constraint is re-thrown as itself.
 */
const CHECKED_FIELDS: Record<string, string> = {
  leave_entitlement_event_falls_in_its_leave_year: 'occurredOn',
  leave_entitlement_event_expires_after_it_happened: 'expiresOn',
  leave_entitlement_event_lapse_needs_an_expiry: 'expiresOn',
  leave_entitlement_event_note_not_blank: 'note',
  leave_entitlement_event_is_what_happened: 'occurredOn',
};

type EventRow = Selectable<LeaveEntitlementEventTable>;

/** Which slice of the table to read. */
export interface LeaveEventListOptions {
  employeeId?: string;
  leaveTypeId?: string;
  leaveYearId?: string;
}

export class LeaveEventRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Records one, naming the grant it caused.
   *
   * Called inside `BalanceService.grantForAnEvent`'s transaction, immediately after
   * the `GRANT` it names — the two rows land together or neither does, because a grant
   * with no event behind it and an event that granted nothing are both halves of
   * something that did not happen.
   */
  async record(by: Attribution, event: ValidatedLeaveEvent): Promise<LeaveEvent> {
    return this.catchRefusals(event.occurredOn, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_entitlement_event')
          .values(rowFor(event))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toEvent(row);
    });
  }

  /**
   * Closes an event off with the `LAPSE` that ended it. FR 32e.
   *
   * The one update this table takes, and the whole of the expiry job's idempotency.
   * Guarded on `lapsed_entry_id IS NULL` in the WHERE rather than only by the trigger,
   * so that two runs racing over the same row produce one winner and one `undefined`
   * rather than one winner and one exception — the caller turns that into
   * {@link AlreadyLapsed} with the event named, which is the sentence a report wants.
   *
   * `updated_at` is not set here, for the reason it is not set in any of the other
   * repositories: the trigger does it, so a migration correcting data gets the same
   * treatment as the application rather than only the writer who remembered.
   */
  async markLapsed(by: Attribution, id: string, lapsedEntryId: string): Promise<LeaveEvent> {
    const row = await this.catchRefusals(null, async () =>
      recording(this.db, by, (on) =>
        on
          .updateTable('leave_entitlement_event')
          .set({ lapsed_entry_id: lapsedEntryId })
          .where('id', '=', id)
          .where('lapsed_entry_id', 'is', null)
          .returningAll()
          .executeTakeFirst(),
      ),
    );

    if (row === undefined) {
      throw new AlreadyLapsed(id);
    }

    return toEvent(row);
  }

  async findById(id: string): Promise<LeaveEvent | undefined> {
    const row = await this.db
      .selectFrom('leave_entitlement_event')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toEvent(row);
  }

  /**
   * One balance's events, oldest first.
   *
   * What the expiry job asks when it needs to know whether another grant in the same
   * balance is still within its own deadline, and what a history screen asks to put a
   * date beside a figure. `leave_entitlement_event_by_balance` is exactly this read.
   */
  async list(options: LeaveEventListOptions = {}): Promise<LeaveEvent[]> {
    let query = this.db.selectFrom('leave_entitlement_event').selectAll();

    if (options.employeeId !== undefined) {
      query = query.where('employee_id', '=', options.employeeId);
    }
    if (options.leaveTypeId !== undefined) {
      query = query.where('leave_type_id', '=', options.leaveTypeId);
    }
    if (options.leaveYearId !== undefined) {
      query = query.where('leave_year_id', '=', options.leaveYearId);
    }

    return (await query.orderBy('occurred_on').orderBy('id').execute()).map(toEvent);
  }

  /**
   * Every event whose deadline has passed and which has not been closed off. FR 32e.
   *
   * The expiry job's own read, and the reason
   * `leave_entitlement_event_still_to_lapse` is a partial index: the rows it wants are
   * a vanishing fraction of the table, because most events never lapse at all and most
   * of those that can have already been dealt with.
   *
   * Strictly *after* the deadline, matching `hasExpired` in ../domain/leave-event.ts:
   * somebody whose six months are up on the fourth of September may still take the
   * leave on the fourth, and the job lapses what is left from the fifth. The comparison
   * is a string one, which every date in this system is safe for — see
   * ../domain/time.ts.
   */
  async expiredBy(day: CalendarDate): Promise<LeaveEvent[]> {
    const rows = await this.db
      .selectFrom('leave_entitlement_event')
      .selectAll()
      .where('lapsed_entry_id', 'is', null)
      .where('expires_on', 'is not', null)
      .where('expires_on', '<', day)
      .orderBy('expires_on')
      .orderBy('id')
      .execute();

    return rows.map(toEvent);
  }

  /**
   * Turns the database's refusals into the domain's.
   *
   * Every rule below is also stated in ../domain/leave-event.ts, and neither copy is
   * redundant: the domain names the field while somebody still has the form open, and
   * this is what holds when two writers race or when the write comes from somewhere
   * else entirely.
   */
  private async catchRefusals<T>(
    occurredOn: CalendarDate | null,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = error as { code?: string; constraint?: string };

      if (violation.code === UNIQUE_VIOLATION && violation.constraint === ONE_PER_DAY) {
        /* Unreachable with a null date: only `record` can raise this one. */
        throw new EventAlreadyRecorded(occurredOn ?? ('unknown' as CalendarDate));
      }

      if (violation.code === RESTRICT_VIOLATION && violation.constraint === LAPSES_ONCE) {
        throw new AlreadyLapsed('this event');
      }

      const field =
        violation.constraint === undefined ? undefined : CHECKED_FIELDS[violation.constraint];

      if (field !== undefined) {
        throw new InvalidLeaveEvent(field, (error as Error).message);
      }

      throw error;
    }
  }
}

function rowFor(event: ValidatedLeaveEvent): Insertable<LeaveEntitlementEventTable> {
  return {
    employee_id: event.employeeId,
    leave_type_id: event.leaveTypeId,
    leave_year_id: event.leaveYearId,
    occurred_on: event.occurredOn,
    expires_on: event.expiresOn,
    note: event.note,
    granted_entry_id: event.grantedEntryId,
  };
}

/**
 * A row as the domain sees it.
 *
 * `occurred_on` and `expires_on` come back as the ten characters they went in as —
 * the driver is configured in ../db/index.ts to hand `date` back untouched rather than
 * building a `Date` at UTC midnight, which is the off by one day bug NFR DAT 03 exists
 * to prevent.
 */
function toEvent(row: EventRow): LeaveEvent {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    leaveYearId: row.leave_year_id,
    occurredOn: row.occurred_on as CalendarDate,
    expiresOn: row.expires_on as CalendarDate | null,
    note: row.note,
    grantedEntryId: row.granted_entry_id,
    lapsedEntryId: row.lapsed_entry_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
