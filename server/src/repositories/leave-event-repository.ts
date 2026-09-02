/** Database access for entitlement events. FR 32g, FR 32e, LMS 218. */

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

/** Which field a refused row is reported against. */
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

  /** Records one, naming the grant it caused. */
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

  /** Closes an event off with the `LAPSE` that ended it. FR 32e. */
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

  /** One balance's events, oldest first. */
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

  /** Every event whose deadline has passed and which has not been closed off. FR 32e. */
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

  /** Turns the database's refusals into the domain's. */
  private async catchRefusals<T>(
    occurredOn: CalendarDate | null,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = error as { code?: string; constraint?: string };

      if (violation.code === UNIQUE_VIOLATION && violation.constraint === ONE_PER_DAY) {
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

/** A row as the domain sees it. NFR DAT 03. */
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
