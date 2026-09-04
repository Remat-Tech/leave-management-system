/**
 * Database access for a leave request. FR 10, FR 11, FR 15, FR 26, §8., LMS 301, LMS 304, LMS 306, LMS 314, §6.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveRequestTable } from '../../db/schema.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import { companyWideDesks, type DesksStaffed } from './approver-queue.js';
import type { Attribution } from '../audit/audit.js';
import type { LeavePeriod } from '../leave-calculator/leave-calculator.js';
import {
  InvalidLeaveRequest,
  type LeaveRequest,
  LeaveOverlapsAnother,
  LIVE_STATUSES,
  type RequestStatus,
  type ValidatedLeaveRequest,
} from './leave-request.js';
import type { CountingBasis } from '../leave-type/leave-type.js';
import { recording } from '../../db/recording.js';

/** Postgres `restrict_violation`, which every refusal in this schema raises. */
const RESTRICT_VIOLATION = '23001';

/** The triggers from the create-and-submit-a-leave-request migration. */
const OUTSIDE_ITS_YEAR = 'leave_request_falls_in_its_leave_year';
const HOLDS_NO_DAYS = 'leave_request_holds_its_days';
const ALREADY_PRICED = 'leave_request_says_what_it_said';

/** The trigger from the release-days-when-a-request-ends migration. LMS 306. */
const KEPT_ITS_DAYS = 'leave_request_gives_its_days_back';

/** The two from route-a-request-through-its-chain. LMS 314. */
const MOVED_WRONGLY = 'leave_request_moves_as_the_table_says';
const KEPT_ITS_DAYS_ON_APPROVAL = 'leave_request_takes_its_days';

/** The exclusion constraint from the prevent-overlapping-requests migration. */
const OVERLAPS_ANOTHER = 'leave_request_never_overlaps';

/** Which field a refused row is reported against. */
const CHECKED_FIELDS: Record<string, string> = {
  leave_request_ends_after_it_starts: 'to',
  leave_request_reason_not_blank: 'reason',
  leave_request_late_entry_reason_not_blank: 'lateEntryReason',
  leave_request_counting_basis_known: 'countingBasis',
  leave_request_status_known: 'status',
  leave_request_costs_at_least_a_day: 'days',
  leave_request_costs_no_more_than_it_spans: 'days',
  leave_request_spans_its_own_dates: 'calendarDays',
  leave_request_awaiting_role_known: 'awaitingApprovalFrom',
  leave_request_waits_at_a_desk: 'awaitingApprovalFrom',
};

/** Which field a missing reference is reported against. */
const REFERENCED_FIELDS: Record<string, string> = {
  leave_request_employee_id_fkey: 'employeeId',
  leave_request_leave_type_id_fkey: 'leaveTypeId',
  leave_request_leave_year_id_fkey: 'leaveYearId',
};

type LeaveRequestRow = Selectable<LeaveRequestTable>;

/** Which requests to read. */
export interface LeaveRequestListOptions {
  employeeId: string;
  leaveTypeId?: string;
  leaveYearId?: string;
  status?: RequestStatus;
  /** Requests overlapping this period. */
  from?: string;
  to?: string;
}

export class LeaveRequestRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes a request. */
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

  /** One person's requests, the leave they start with first. */
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

    if (options.from !== undefined) {
      query = query.where('end_date', '>=', options.from);
    }
    if (options.to !== undefined) {
      query = query.where('start_date', '<=', options.to);
    }

    return (await query.orderBy('start_date').orderBy('id').execute()).map(toRequest);
  }

  /**
   * Every request sitting at one of these desks. FR 20, FR 40, FR 38a, LMS 404.
   *
   * Filtered on the desk and not on the status: `leave_request_waits_at_a_desk` makes the two
   * an equivalence, so a row at a desk is a row still being decided.
   *
   * `HR` and `CEO` are staffed for the whole company and are a plain `IN`. `MANAGER` resolves
   * through a reporting line, so it is narrowed to this manager's own reports.
   */
  async awaiting(staffed: DesksStaffed): Promise<LeaveRequest[]> {
    const companyWide = companyWideDesks(staffed);

    /* Unreachable: `leaveRequestPolicy.queue` refuses somebody who staffs nothing. Answered
       anyway, because a `WHERE` built from no desks is the shape that becomes `WHERE true`. */
    if (companyWide.length === 0 && staffed.managerId === null) {
      return [];
    }

    const managerId = staffed.managerId;

    const rows = await this.db
      .selectFrom('leave_request')
      .innerJoin('employee', 'employee.id', 'leave_request.employee_id')
      .selectAll('leave_request')
      .where((eb) =>
        eb.or([
          ...(managerId === null
            ? []
            : [
                eb.and([
                  eb('leave_request.awaiting_approval_from', '=', 'MANAGER'),
                  eb('employee.manager_id', '=', managerId),
                ]),
              ]),
          ...(companyWide.length === 0
            ? []
            : [eb('leave_request.awaiting_approval_from', 'in', [...companyWide])]),
        ]),
      )
      /** Soonest to start first, which is what `bySoonestToStart` sorts by. */
      .orderBy('leave_request.start_date')
      .orderBy('leave_request.submitted_at')
      .orderBy('leave_request.id')
      .execute();

    return rows.map(toRequest);
  }

  /**
   * The live leave these people have over this span. FR 20, LMS 404.
   *
   * {@link LeaveRequestRepository.findOverlapping} asked about a group, for the team context an
   * approver decides on. A span rather than a period, so one statement answers a whole
   * screenful and `teamFor` narrows each row with `periodsOverlap`.
   *
   * `LIVE_STATUSES` rather than `SUBMITTED` alone: a colleague who has asked for the same week
   * keeps somebody off the desk as surely as one who has been granted it.
   */
  async liveOverlapping(
    employeeIds: readonly string[],
    span: LeavePeriod,
  ): Promise<LeaveRequest[]> {
    if (employeeIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_request')
      .selectAll()
      .where('employee_id', 'in', [...employeeIds])
      .where('status', 'in', [...LIVE_STATUSES])
      .where('end_date', '>=', span.from)
      .where('start_date', '<=', span.to)
      .orderBy('start_date')
      .orderBy('id')
      .execute();

    return rows.map(toRequest);
  }

  /** The live leave this period would land on top of, if there is any. FR 15, §5.6.. */
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

  /** Improves the reason, which is the only field of substance that may change. */
  async reword(
    by: Attribution,
    id: string,
    reason: string | null,
  ): Promise<LeaveRequest | undefined> {
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
   * Moves a request, which is the only thing that touches `status` or the desk it is waiting at. FR 26, FR 38a, §6., LMS 306, LMS 314.
   */
  async moveTo(
    by: Attribution,
    id: string,
    to: RequestStatus,
    awaiting: ApproverRole | null,
  ): Promise<LeaveRequest | undefined> {
    return this.catchRefusals(async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('leave_request')
          .set({ status: to, awaiting_approval_from: awaiting })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toRequest(row);
    });
  }

  /** Runs a write and turns whatever the database refused it for into a domain error. */
  private async catchRefusals<T>(write: () => Promise<T>, period?: LeavePeriod): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const constraint = failure.constraint ?? '';

      /** FR 15. */
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

        /* The state machine's three, and all of them are backstops rather than paths.
           `settlementTo` and `approvalTo` ask the first question inside the balance lock,
           which is what makes a second withdrawal wait and then be refused with a
           sentence; `BalanceService` writes the movement in the same transaction as the
           status, which is what keeps the other two from ever being reached. What they
           catch is a writer that found another way in, and it is told what it broke rather
           than which trigger. */
        if (
          constraint === MOVED_WRONGLY ||
          constraint === KEPT_ITS_DAYS ||
          constraint === KEPT_ITS_DAYS_ON_APPROVAL
        ) {
          throw new InvalidLeaveRequest('status', (error as Error).message);
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
    case 'leave_request_late_entry_reason_not_blank':
      return 'Leave entered past its backdating window says why it is being entered now.';
    case 'leave_request_costs_at_least_a_day':
      return 'Leave that costs nothing is leave nobody needs to ask for.';
    case 'leave_request_costs_no_more_than_it_spans':
      return 'Leave cannot cost more days than the period it covers.';
    case 'leave_request_spans_its_own_dates':
      return 'The number of calendar days does not match the two dates it is a count of.';
    case 'leave_request_awaiting_role_known':
      return 'A request waits at one of the three approver desks: MANAGER, HR or CEO.';
    case 'leave_request_waits_at_a_desk':
      return (
        'A request that is still being decided is waiting on exactly one desk, and one ' +
        'that has been approved or has ended is waiting on none. FR 38a.'
      );
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
    /** FR 18. Null on everything inside the window. LMS 308. */
    late_entry_reason: request.lateEntryReason,
    counting_basis: request.countingBasis,
    days: request.days,
    calendar_days: request.calendarDays,
    status: request.status,
    /* FR 38a. The first desk in the type's chain, worked out by `validateNewLeaveRequest`
       rather than chosen here. `leave_request_waits_at_a_desk` refuses the row without it
       while the status is SUBMITTED, which is what a submission always is. */
    awaiting_approval_from: request.awaitingApprovalFrom,
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
    lateEntryReason: row.late_entry_reason,
    countingBasis: row.counting_basis as CountingBasis,
    days: row.days,
    calendarDays: row.calendar_days,
    status: row.status as RequestStatus,
    awaitingApprovalFrom: row.awaiting_approval_from as ApproverRole | null,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
