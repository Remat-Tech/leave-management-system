/**
 * Database access for a leave request. FR 10, FR 11, FR 15, §8. LMS 301, LMS 304.
 *
 * Queries and row mapping, nothing else. What a valid request is lives in
 * ../domain/leave-request.ts, what a period costs in ../domain/leave-calculator.ts,
 * and when to apply either in ../services/leave-request-service.ts.
 *
 * The one piece of judgement here is the same one every repository in this system
 * makes: turning what the database refused into something a caller can act on. Three of
 * those refusals are worth knowing before they are met.
 *
 * **The overlap check fires at INSERT, and is the only one an ordinary caller meets.**
 * `leave_request_never_overlaps` is a GiST exclusion constraint, and the service asks
 * the same question first so that the person gets {@link LeaveOverlapsAnother} naming
 * the leave in the way. Unlike the two below, that first ask cannot be made to close the
 * window: two tabs submitting the same fortnight at the same moment both read a table
 * with no conflict in it. So this one is a real path rather than a psql backstop, and it
 * is mapped to the same class and the same code the service raises — see
 * {@link LeaveRequestRepository.catchRefusals} for what it cannot carry.
 *
 * **The year check fires at INSERT, not at COMMIT.** A period running past the end of
 * its leave year is refused by `refuse_a_request_outside_its_leave_year()` with a
 * `restrict_violation`, and the service asks the same question first so that the person
 * gets {@link LeaveCrossesAYearEnd} with both years named. This is the backstop for
 * every other writer.
 *
 * **The reservation check fires at COMMIT.** `leave_request_holds_its_days` is a
 * deferred constraint trigger, so a request written without its RESERVATION is refused
 * when the transaction closes rather than when the row is inserted — which is what
 * makes the legitimate order possible at all: the entry cannot name a request that does
 * not exist yet. A caller that has gone through `BalanceService.reserveForRequest`
 * never meets it; a caller that has found another way in meets it and is told so.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveRequestTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import type { LeavePeriod } from '../domain/leave-calculator.js';
import {
  InvalidLeaveRequest,
  type LeaveRequest,
  LeaveOverlapsAnother,
  LIVE_STATUSES,
  type RequestStatus,
  type ValidatedLeaveRequest,
} from '../domain/leave-request.js';
import type { CountingBasis } from '../domain/leave-type.js';
import { recording } from './recording.js';

/** Postgres `restrict_violation`, which every refusal in this schema raises. */
const RESTRICT_VIOLATION = '23001';

/** The triggers from the create-and-submit-a-leave-request migration. */
const OUTSIDE_ITS_YEAR = 'leave_request_falls_in_its_leave_year';
const HOLDS_NO_DAYS = 'leave_request_holds_its_days';
const ALREADY_PRICED = 'leave_request_says_what_it_said';

/** The exclusion constraint from the prevent-overlapping-requests migration. */
const OVERLAPS_ANOTHER = 'leave_request_never_overlaps';

/**
 * Which field a refused row is reported against.
 *
 * Read from the constraint name the driver hands back rather than guessed from the
 * message, so a violation of some future constraint is re-thrown as itself rather than
 * blamed on whichever field this map happens to mention.
 */
const CHECKED_FIELDS: Record<string, string> = {
  leave_request_ends_after_it_starts: 'to',
  leave_request_reason_not_blank: 'reason',
  leave_request_counting_basis_known: 'countingBasis',
  leave_request_status_known: 'status',
  leave_request_costs_at_least_a_day: 'days',
  leave_request_costs_no_more_than_it_spans: 'days',
  leave_request_spans_its_own_dates: 'calendarDays',
};

/** Which field a missing reference is reported against. */
const REFERENCED_FIELDS: Record<string, string> = {
  leave_request_employee_id_fkey: 'employeeId',
  leave_request_leave_type_id_fkey: 'leaveTypeId',
  leave_request_leave_year_id_fkey: 'leaveYearId',
};

type LeaveRequestRow = Selectable<LeaveRequestTable>;

/**
 * Which requests to read.
 *
 * `employeeId` is not optional and there is no method without it, for the reason
 * {@link LedgerReadOptions} gives: a read across everybody is a report, and a report is
 * a query written for the figures it needs rather than a history screen with its filter
 * left off. The approval story's queue is that report and will be its own method with
 * its own policy.
 */
export interface LeaveRequestListOptions {
  employeeId: string;
  leaveTypeId?: string;
  leaveYearId?: string;
  status?: RequestStatus;
  /** Requests overlapping this period. What a calendar asks, and the overlap check. */
  from?: string;
  to?: string;
}

export class LeaveRequestRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes a request.
   *
   * Called only from inside `BalanceService.reserveForRequest`'s transaction, which
   * writes the RESERVATION naming the row this returns. Called anywhere else, the
   * deferred trigger refuses it at COMMIT and says why — see the module note.
   *
   * `submitted_at` is not sent and could not be honoured if it were:
   * `stamp_when_a_request_was_submitted()` overwrites it.
   */
  async submit(by: Attribution, request: ValidatedLeaveRequest): Promise<LeaveRequest> {
    return this.catchRefusals(
      async () => {
        const row = await recording(this.db, by, (on) =>
          on
            .insertInto('leave_request')
            .values(rowFor(request))
            .returningAll()
            .executeTakeFirstOrThrow(),
        );

        return toRequest(row);
      },
      { from: request.from, to: request.to },
    );
  }

  async findById(id: string): Promise<LeaveRequest | undefined> {
    const row = await this.db
      .selectFrom('leave_request')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toRequest(row);
  }

  /**
   * One person's requests, the leave they start with first.
   *
   * By `start_date` rather than by when they were submitted, because a leave page is
   * read as a calendar: what somebody wants to see is the shape of their year, and a
   * fortnight booked in January for August belongs in August.
   */
  async list(options: LeaveRequestListOptions): Promise<LeaveRequest[]> {
    let query = this.db
      .selectFrom('leave_request')
      .selectAll()
      .where('employee_id', '=', options.employeeId);

    if (options.leaveTypeId !== undefined) {
      query = query.where('leave_type_id', '=', options.leaveTypeId);
    }
    if (options.leaveYearId !== undefined) {
      query = query.where('leave_year_id', '=', options.leaveYearId);
    }
    if (options.status !== undefined) {
      query = query.where('status', '=', options.status);
    }

    /* Overlap, not containment: a request from the first to the thirtieth overlaps a
       window of the fifteenth to the sixteenth, and a calendar that only found
       requests wholly inside its month would show a fortnight on neither of the two
       months it spans. */
    if (options.from !== undefined) {
      query = query.where('end_date', '>=', options.from);
    }
    if (options.to !== undefined) {
      query = query.where('start_date', '<=', options.to);
    }

    return (await query.orderBy('start_date').orderBy('id').execute()).map(toRequest);
  }

  /**
   * The live leave this period would land on top of, if there is any. FR 15, §5.6.
   *
   * The earliest one, and one is enough: the refusal names a request the person has to
   * do something about, and a list of three would still be answered by dealing with the
   * first. `limit 1` keeps it a single index probe on the constraint's own GiST index.
   *
   * **Filtered by {@link LIVE_STATUSES} rather than by every status there is.** A
   * withdrawn or refused request has given its days back and blocking against one would
   * tell somebody to withdraw leave they had already withdrawn. The list is the domain's
   * and it is the same list `leave_request_never_overlaps` carries as its predicate.
   *
   * The comparison is the two inequalities rather than a `daterange`, for the reason
   * `list()` uses them: the dates are `DATE` columns and a range built per row could not
   * use the index behind them. It is the same overlap either way, and
   * {@link periodsOverlap} is the third statement of it — a unit test asserts that one
   * against this one's answers.
   *
   * `except` is the request being amended, where there is one. Nothing amends dates
   * today — `refuse_rewriting_what_a_request_cost()` refuses it — so it is unused and
   * present because the alternative is an amendment story discovering that every request
   * overlaps itself.
   */
  async findOverlapping(
    employeeId: string,
    period: LeavePeriod,
    except?: string,
  ): Promise<LeaveRequest | undefined> {
    let query = this.db
      .selectFrom('leave_request')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .where('status', 'in', [...LIVE_STATUSES])
      .where('end_date', '>=', period.from)
      .where('start_date', '<=', period.to);

    if (except !== undefined) {
      query = query.where('id', '!=', except);
    }

    const row = await query.orderBy('start_date').orderBy('id').executeTakeFirst();

    return row === undefined ? undefined : toRequest(row);
  }

  /**
   * Improves the reason, which is the only field of substance that may change.
   *
   * Every other column is refused by `refuse_rewriting_what_a_request_cost()` on every
   * connection, so this method's narrowness is a convenience rather than the
   * protection — the type has no other field to offer and the database would refuse it
   * if it did.
   */
  async reword(by: Attribution, id: string, reason: string): Promise<LeaveRequest | undefined> {
    return this.catchRefusals(async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('leave_request')
          .set({ reason })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toRequest(row);
    });
  }

  /**
   * Runs a write and turns whatever the database refused it for into a domain error.
   *
   * The constraint name is read from the driver's error rather than guessed from the
   * message text, so a violation of some future constraint is re-thrown rather than
   * reported against a field it has nothing to do with.
   *
   * `period` is the one thing a refusal here cannot recover for itself. Postgres names
   * the constraint that was violated and not the row that was being written, and the
   * overlap refusal is about a period; the caller that has it hands it over. Absent for
   * a write that cannot move a date, which is every write but the insert.
   */
  private async catchRefusals<T>(write: () => Promise<T>, period?: LeavePeriod): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const constraint = failure.constraint ?? '';

      /* FR 15. The one refusal here that a legitimate caller meets in normal use rather
         than only from psql: two tabs submitting the same fortnight at the same moment
         both pass the service's check and the second is refused as it writes.
         `LeaveOverlapsAnother` rather than the driver's "conflicting key value violates
         exclusion constraint", so both callers meet the same class and the same code —
         and without a conflict named, because the transaction is aborted by the time
         this runs and cannot be asked which row it collided with. */
      if (
        failure.code === EXCLUSION_VIOLATION &&
        constraint === OVERLAPS_ANOTHER &&
        period !== undefined
      ) {
        throw new LeaveOverlapsAnother(period);
      }

      if (failure.code === CHECK_VIOLATION && constraint in CHECKED_FIELDS) {
        throw new InvalidLeaveRequest(CHECKED_FIELDS[constraint], messageFor(constraint));
      }

      if (failure.code === FOREIGN_KEY_VIOLATION && constraint in REFERENCED_FIELDS) {
        throw new InvalidLeaveRequest(
          REFERENCED_FIELDS[constraint],
          `${REFERENCED_FIELDS[constraint]} does not name anything that exists.`,
        );
      }

      /* The three triggers. Their messages are written for a person — the year check
         names both years, the deferred one explains what a request holding nothing
         would let somebody do — so they are carried through rather than reworded, and
         only the field is added. */
      if (failure.code === RESTRICT_VIOLATION) {
        if (constraint === OUTSIDE_ITS_YEAR) {
          throw new InvalidLeaveRequest('leaveYearId', (error as Error).message);
        }
        if (constraint === HOLDS_NO_DAYS) {
          throw new InvalidLeaveRequest('days', (error as Error).message);
        }
        if (constraint === ALREADY_PRICED) {
          throw new InvalidLeaveRequest('id', (error as Error).message);
        }
      }

      throw error;
    }
  }
}

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Postgres `exclusion_violation`, which `leave_request_never_overlaps` raises. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * What each CHECK means, in words.
 *
 * Every one of these is unreachable through {@link LeaveRequestService}, which asks
 * the same questions first and in a voice that names the days. They are what a
 * migration correcting data, a bulk load or somebody in psql is told, and they are
 * worth a sentence each for the same reason the ledger's are: a caller reading
 * `violates check constraint "leave_request_costs_at_least_a_day"` has to go and find
 * this file to know what it was about.
 */
function messageFor(constraint: string): string {
  switch (constraint) {
    case 'leave_request_ends_after_it_starts':
      return 'Leave that ends before it starts is two dates entered the wrong way round.';
    case 'leave_request_reason_not_blank':
      return 'A leave request says why.';
    case 'leave_request_costs_at_least_a_day':
      return 'Leave that costs nothing is leave nobody needs to ask for.';
    case 'leave_request_costs_no_more_than_it_spans':
      return 'Leave cannot cost more days than the period it covers.';
    case 'leave_request_spans_its_own_dates':
      return 'The number of calendar days does not match the two dates it is a count of.';
    default:
      return `${constraint} refused this request.`;
  }
}

/**
 * The row to write.
 *
 * `submitted_at` is absent. Sending it would achieve nothing —
 * `stamp_when_a_request_was_submitted()` overwrites it — and its absence here is what
 * makes that unmistakable at the call site.
 */
function rowFor(request: ValidatedLeaveRequest): Insertable<LeaveRequestTable> {
  return {
    employee_id: request.employeeId,
    leave_type_id: request.leaveTypeId,
    leave_year_id: request.leaveYearId,
    start_date: request.from,
    end_date: request.to,
    reason: request.reason,
    counting_basis: request.countingBasis,
    days: request.days,
    calendar_days: request.calendarDays,
    status: request.status,
  };
}

function toRequest(row: LeaveRequestRow): LeaveRequest {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    leaveYearId: row.leave_year_id,
    from: row.start_date,
    to: row.end_date,
    reason: row.reason,
    countingBasis: row.counting_basis as CountingBasis,
    days: row.days,
    calendarDays: row.calendar_days,
    status: row.status as RequestStatus,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
