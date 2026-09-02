/** Database access for leave types. FR 21, FR 31, FR 32, §5.5., LMS 201, LMS 204. */

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveTypeApprovalStepTable, LeaveTypeTable } from '../../db/schema.js';
import { type ApproverRole, chainOf, InvalidApprovalChain, stepsOf } from './approval-chain.js';
import type { Attribution } from '../audit/audit.js';
import type { Gender } from '../employee/employee.js';
import {
  type AllowanceUnit,
  type CountingBasis,
  type DocumentationRule,
  DuplicateLeaveTypeCode,
  DuplicateLeaveTypeName,
  type EntitlementBasis,
  InvalidLeaveType,
  type LeaveType,
  type ValidatedLeaveType,
} from './leave-type.js';
import { recording } from '../../db/recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `check_violation`, which every cross field rule on this table raises. */
const CHECK_VIOLATION = '23514';

/** The indexes created by the leave-type-rules migration. */
const CODE_INDEX = 'leave_type_code_unique';
const NAME_INDEX = 'leave_type_name_unique';

/** Which field a refused row is reported against. */
const CHECKED_FIELDS: Record<string, string> = {
  leave_type_counting_basis_known: 'countingBasis',
  leave_type_entitlement_basis_known: 'entitlementBasis',
  leave_type_unit_known: 'unit',
  leave_type_documentation_known: 'documentation',
  leave_type_documentation_agrees: 'documentationAfterDays',
  leave_type_documentation_threshold_positive: 'documentationAfterDays',
  leave_type_expiry_months_positive: 'entitlementExpiryMonths',
  leave_type_notice_not_negative: 'minNoticeCalendarDays',
  leave_type_backdating_not_negative: 'maxBackdateCalendarDays',
  leave_type_never_deducts_from_annual: 'deductsFromAnnual',
  leave_type_gender_known: 'genderRestriction',
  leave_type_code_not_blank: 'code',
  leave_type_name_not_blank: 'name',
};

/** What the approval chain is refused for, all of it reported as one error. */
const REFUSED_CHAINS = [
  'leave_type_approval_chain_is_whole',
  'leave_type_approval_step_role_known',
  'leave_type_approval_step_order_positive',
];

/** The two unique keys on the steps: one step per position, one position per desk. */
const STEP_ORDER_KEY = 'leave_type_approval_step_pkey';
const ROLE_ONCE_INDEX = 'leave_type_approval_step_role_once';

type LeaveTypeRow = Selectable<LeaveTypeTable>;
type ApprovalStepRow = Selectable<LeaveTypeApprovalStepTable>;

export interface LeaveTypeListOptions {
  /** Only the types a request form should offer. */
  offeredOnly?: boolean;
}

export class LeaveTypeRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** The type and its approval chain, or neither. */
  async create(by: Attribution, record: ValidatedLeaveType): Promise<LeaveType> {
    return this.catchRefusals(record, () =>
      recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('leave_type')
          .values(rowFor(record))
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeChain(on, row.id, record.approvalChain);

        return { ...toLeaveType(row), approvalChain: [...record.approvalChain] };
      }),
    );
  }

  /** Applies a change. */
  async update(
    by: Attribution,
    id: string,
    changes: Partial<ValidatedLeaveType>,
  ): Promise<LeaveType | undefined> {
    const values = changedColumnsOf(changes);

    if (Object.keys(values).length === 0) {
      // A form somebody submitted without touching it. The record should come
      // back as it stands rather than being rewritten with itself.
      return this.findById(id);
    }

    return this.catchRefusals(changes, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('leave_type')
          .set(values)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : this.withChain(row);
    });
  }

  /** Replaces the approval chain. FR 38a. */
  async setApprovalChain(
    by: Attribution,
    id: string,
    chain: readonly ApproverRole[],
  ): Promise<LeaveType | undefined> {
    return this.catchRefusals({}, () =>
      recording(this.db, by, async (on) => {
        const row = await on
          .updateTable('leave_type')
          .set((eb) => ({ code: eb.ref('code') }))
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();

        if (row === undefined) {
          return undefined;
        }

        await on.deleteFrom('leave_type_approval_step').where('leave_type_id', '=', id).execute();

        await writeChain(on, id, chain);

        return { ...toLeaveType(row), approvalChain: [...chain] };
      }),
    );
  }

  /** Retires a type, or brings it back. */
  async setActive(by: Attribution, id: string, isActive: boolean): Promise<LeaveType | undefined> {
    const row = await recording(this.db, by, (on) =>
      on
        .updateTable('leave_type')
        .set({ is_active: isActive })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : this.withChain(row);
  }

  async findById(id: string): Promise<LeaveType | undefined> {
    const row = await this.db
      .selectFrom('leave_type')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : this.withChain(row);
  }

  /**
   * By code, compared without regard to case, so a lookup finds the same single record the unique index would have refused a second of.
   */
  async findByCode(code: string): Promise<LeaveType | undefined> {
    const row = await this.db
      .selectFrom('leave_type')
      .selectAll()
      .where((eb) => eb(eb.fn('upper', ['code']), '=', code.trim().toUpperCase()))
      .executeTakeFirst();

    return row === undefined ? undefined : this.withChain(row);
  }

  async findByName(name: string): Promise<LeaveType | undefined> {
    const row = await this.db
      .selectFrom('leave_type')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['name']), '=', name.trim().toLowerCase()))
      .executeTakeFirst();

    return row === undefined ? undefined : this.withChain(row);
  }

  /** Every type, or only the ones still offered, in the order a form shows them. §7.4. */
  async list(options: LeaveTypeListOptions = {}): Promise<LeaveType[]> {
    let query = this.db.selectFrom('leave_type').selectAll();

    if (options.offeredOnly === true) {
      query = query.where('is_active', '=', true);
    }

    const rows = await query.orderBy('display_order').orderBy('name').execute();

    if (rows.length === 0) {
      return [];
    }

    const steps = await this.db
      .selectFrom('leave_type_approval_step')
      .selectAll()
      .where(
        'leave_type_id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();

    const byType = new Map<string, ApprovalStepRow[]>();
    for (const step of steps) {
      byType.set(step.leave_type_id, [...(byType.get(step.leave_type_id) ?? []), step]);
    }

    return rows.map((row) => ({
      ...toLeaveType(row),
      approvalChain: toApprovalChain(byType.get(row.id) ?? []),
    }));
  }

  /** A type row with the chain that belongs to it. */
  private async withChain(row: LeaveTypeRow): Promise<LeaveType> {
    const steps = await this.db
      .selectFrom('leave_type_approval_step')
      .selectAll()
      .where('leave_type_id', '=', row.id)
      .execute();

    return { ...toLeaveType(row), approvalChain: toApprovalChain(steps) };
  }

  private async catchRefusals<T>(
    attempted: Partial<ValidatedLeaveType>,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (violation?.code === UNIQUE_VIOLATION) {
        if (violation.constraint === CODE_INDEX) {
          throw new DuplicateLeaveTypeCode(attempted.code ?? '');
        }
        if (violation.constraint === NAME_INDEX) {
          throw new DuplicateLeaveTypeName(attempted.name ?? '');
        }
      }

      if (violation?.code === UNIQUE_VIOLATION) {
        if (violation.constraint === ROLE_ONCE_INDEX || violation.constraint === STEP_ORDER_KEY) {
          throw new InvalidApprovalChain(
            error instanceof Error
              ? error.message
              : 'The approval chain names the same approver twice.',
          );
        }
      }

      if (violation?.code === CHECK_VIOLATION) {
        if (REFUSED_CHAINS.includes(violation.constraint)) {
          throw new InvalidApprovalChain(
            error instanceof Error
              ? error.message
              : `The approval chain breaks ${violation.constraint}.`,
          );
        }

        const field = CHECKED_FIELDS[violation.constraint];

        if (field !== undefined) {
          /* Reachable only from outside the domain, which validates all of these
             first. Reported as what it is rather than dressed up as something
             this repository decided. */
          throw new InvalidLeaveType(
            field,
            error instanceof Error
              ? error.message
              : `The leave type breaks ${violation.constraint}.`,
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
 * The same shape as the employee and working pattern repositories', and separate
 * from both for the same reason they are separate from each other: no repository
 * imports another, and a shared copy of six lines would be the first thing to
 * grow a parameter.
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
function rowFor(record: ValidatedLeaveType): Insertable<LeaveTypeTable> {
  return {
    code: record.code,
    name: record.name,
    description: record.description,
    counting_basis: record.countingBasis,
    entitlement_basis: record.entitlementBasis,
    is_paid: record.isPaid,
    unit: record.unit,
    documentation: record.documentation,
    documentation_after_days: record.documentationAfterDays,
    exceedable_with_document: record.exceedableWithDocument,
    entitlement_expiry_months: record.entitlementExpiryMonths,
    may_be_split: record.mayBeSplit,
    min_notice_calendar_days: record.minNoticeCalendarDays,
    max_backdate_calendar_days: record.maxBackdateCalendarDays,
    gender_restriction: record.genderRestriction,
    display_order: record.displayOrder,
  };
}

/**
 * The fields a change actually named, as columns.
 *
 * `in` rather than a check for undefined, because clearing an expiry and leaving
 * it alone are different instructions and stay different all the way down to the
 * UPDATE statement. Sending the whole record instead would silently revert
 * anything a colleague changed while this caller had the form open.
 */
function changedColumnsOf(changes: Partial<ValidatedLeaveType>): Updateable<LeaveTypeTable> {
  const values: Updateable<LeaveTypeTable> = {};

  if ('code' in changes) values.code = changes.code;
  if ('name' in changes) values.name = changes.name;
  if ('description' in changes) values.description = changes.description;
  if ('countingBasis' in changes) values.counting_basis = changes.countingBasis;
  if ('entitlementBasis' in changes) values.entitlement_basis = changes.entitlementBasis;
  if ('isPaid' in changes) values.is_paid = changes.isPaid;
  if ('unit' in changes) values.unit = changes.unit;
  if ('documentation' in changes) values.documentation = changes.documentation;
  if ('documentationAfterDays' in changes) {
    values.documentation_after_days = changes.documentationAfterDays;
  }
  if ('exceedableWithDocument' in changes) {
    values.exceedable_with_document = changes.exceedableWithDocument;
  }
  if ('entitlementExpiryMonths' in changes) {
    values.entitlement_expiry_months = changes.entitlementExpiryMonths;
  }
  if ('mayBeSplit' in changes) values.may_be_split = changes.mayBeSplit;
  if ('minNoticeCalendarDays' in changes) {
    values.min_notice_calendar_days = changes.minNoticeCalendarDays;
  }
  if ('maxBackdateCalendarDays' in changes) {
    values.max_backdate_calendar_days = changes.maxBackdateCalendarDays;
  }
  if ('genderRestriction' in changes) values.gender_restriction = changes.genderRestriction;
  if ('displayOrder' in changes) values.display_order = changes.displayOrder;

  return values;
}

/**
 * The steps a chain is stored as, written in one statement.
 *
 * The numbering comes from {@link stepsOf}, so a gap cannot be introduced from
 * this side; `leave_type_approval_chain_is_whole` is the same rule for every
 * other writer. Called on the handle {@link recording} gave, never on `this.db`,
 * because the writer's name lives on that one connection.
 */
async function writeChain(
  on: Kysely<Database>,
  leaveTypeId: string,
  chain: readonly ApproverRole[],
): Promise<void> {
  if (chain.length === 0) {
    return;
  }

  await on
    .insertInto('leave_type_approval_step')
    .values(
      stepsOf(chain).map((step) => ({
        leave_type_id: leaveTypeId,
        step_order: step.stepOrder,
        approver_role: step.approverRole,
      })),
    )
    .execute();
}

/**
 * A chain read back out of its rows, in order.
 *
 * Ordered by {@link chainOf} rather than by the query, so that the one read which
 * forgets an ORDER BY cannot silently reverse who signs off first. The roles come
 * back as the strings the database holds, cast rather than parsed, for the reason
 * the closed sets on `leave_type` are: `leave_type_approval_step_role_known` makes
 * a value outside the set impossible on any connection.
 */
function toApprovalChain(steps: readonly ApprovalStepRow[]): ApproverRole[] {
  return chainOf(
    steps.map((step) => ({
      stepOrder: step.step_order,
      approverRole: step.approver_role as ApproverRole,
    })),
  );
}

/**
 * A row as the domain sees it, without the chain, which is read separately and
 * merged by the caller.
 *
 * The three closed sets come back as the strings the database holds, cast rather
 * than parsed. The CHECK constraints are what make that safe — a value outside
 * the set cannot be in the column on any connection — and a parse here would be a
 * second copy of the same list, drifting.
 */
function toLeaveType(row: LeaveTypeRow): Omit<LeaveType, 'approvalChain'> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    countingBasis: row.counting_basis as CountingBasis,
    entitlementBasis: row.entitlement_basis as EntitlementBasis,
    isPaid: row.is_paid,
    unit: row.unit as AllowanceUnit,
    documentation: row.documentation as DocumentationRule,
    documentationAfterDays: row.documentation_after_days,
    exceedableWithDocument: row.exceedable_with_document,
    entitlementExpiryMonths: row.entitlement_expiry_months,
    mayBeSplit: row.may_be_split,
    minNoticeCalendarDays: row.min_notice_calendar_days,
    maxBackdateCalendarDays: row.max_backdate_calendar_days,
    genderRestriction: row.gender_restriction as Gender | null,
    deductsFromAnnual: row.deducts_from_annual,
    displayOrder: row.display_order,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
