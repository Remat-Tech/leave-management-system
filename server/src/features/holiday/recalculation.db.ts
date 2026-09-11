/** Database access for holidays credited back into agreed leave. FR 25, LMS 508. */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestRecalculationTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import { InvalidHoliday } from './holiday.js';
import type { Recalculation, ValidatedRecalculation } from './recalculation.js';
import { recording } from '../../db/recording.js';

/** Postgres `unique_violation` and `restrict_violation`, which this table's triggers raise with. */
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

const ONCE_PER_HOLIDAY = 'leave_request_recalculation_credits_a_holiday_once';

/** Which field a refused row is reported against. */
const REFUSED_FIELDS: Record<string, string> = {
  leave_request_recalculation_credits_the_gazetted_day: 'holidayDate',
  leave_request_recalculation_falls_inside_the_leave: 'holidayDate',
  leave_request_recalculation_credits_agreed_leave: 'leaveRequestId',
  leave_request_recalculation_credits_a_working_day_type: 'leaveRequestId',
  leave_request_recalculation_credits_a_day_they_work: 'holidayDate',
  leave_request_recalculation_credits_its_days: 'days',
};

type RecalculationRow = Selectable<LeaveRequestRecalculationTable>;

/** A credit the same holiday had already given this leave. FR 25. */
export class DayAlreadyCredited extends Error {
  readonly code = 'DAY_ALREADY_CREDITED';
  readonly leaveRequestId: string;

  constructor(leaveRequestId: string) {
    super(
      'This public holiday has already been credited back to this leave. A second credit ' +
        'would give back a day that was only ever charged once. FR 25.',
    );
    this.name = 'DayAlreadyCredited';
    this.leaveRequestId = leaveRequestId;
  }
}

export class HolidayRecalculationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes one. */
  async record(by: Attribution, credit: ValidatedRecalculation): Promise<Recalculation> {
    return this.catchRefusals(credit, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_request_recalculation')
          .values(rowFor(credit))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toRecalculation(row);
    });
  }

  /** Everything one holiday has credited, oldest first. */
  async forHoliday(holidayId: string): Promise<Recalculation[]> {
    const rows = await this.db
      .selectFrom('leave_request_recalculation')
      .selectAll()
      .where('holiday_id', '=', holidayId)
      .orderBy('id')
      .execute();

    return rows.map(toRecalculation);
  }

  /**
   * Turns what the database refused into something a caller can act on.
   *
   * The unique index is the one worth catching: the service reads what this holiday has
   * already credited and skips those requests a moment earlier, and two officers pressing
   * the button together both read a request nothing has credited yet. This is where that
   * race actually ends, and it is the reason the button is safe to press twice.
   */
  private async catchRefusals<T>(
    credit: ValidatedRecalculation,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const said = error instanceof Error ? error.message : '';

      if (failure.code === UNIQUE_VIOLATION && failure.constraint === ONCE_PER_HOLIDAY) {
        throw new DayAlreadyCredited(credit.leaveRequestId);
      }

      if (failure.code === RESTRICT_VIOLATION && failure.constraint !== undefined) {
        const field = REFUSED_FIELDS[failure.constraint];

        if (field !== undefined) {
          throw new InvalidHoliday(field, said);
        }
      }

      throw error;
    }
  }
}

function rowFor(credit: ValidatedRecalculation): Insertable<LeaveRequestRecalculationTable> {
  return {
    leave_request_id: credit.leaveRequestId,
    holiday_id: credit.holidayId,
    holiday_date: credit.holidayDate,
    days: credit.days,
    reason: credit.reason,
    ledger_entry_id: credit.ledgerEntryId,
  };
}

function toRecalculation(row: RecalculationRow): Recalculation {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    holidayId: row.holiday_id,
    holidayDate: row.holiday_date,
    days: Number(row.days),
    reason: row.reason,
    ledgerEntryId: row.ledger_entry_id,
    recordedBy: row.recorded_by,
    recordedByEmployeeId: row.recorded_by_employee_id,
    recordedAt: row.recorded_at,
  };
}
