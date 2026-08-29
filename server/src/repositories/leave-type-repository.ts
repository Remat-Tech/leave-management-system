/**
 * Database access for leave types. FR 21, FR 31, FR 32, §5.5. LMS 201.
 *
 * Queries and row mapping, nothing else. What a rule means is
 * ../domain/leave-type.ts and when to apply one is
 * ../services/leave-type-service.ts.
 *
 * Three pieces of judgement live here rather than above.
 *
 * Refusals are translated rather than allowed to surface, the same way the
 * working pattern repository does it and for the same reason: checking first and
 * writing afterwards is a race, so the write is attempted and the database's
 * answer is turned back into the domain error for it. The unique indexes are what
 * actually decide, which makes the answer right even when two administrators are
 * adding the same type at the same moment.
 *
 * A type is two tables since LMS 204, and is written as one thing. Every write
 * that touches the approval chain opens a transaction, and a chain is replaced
 * rather than reconciled — every step deleted, the new ones inserted — which is
 * the arrangement the working pattern repository has with a week and is why
 * `leave_type_approval_chain_is_whole` is deferred. Between those two statements
 * the type has no chain at all, and at COMMIT that state does not exist.
 *
 * There is no `remove`. lms_app holds no DELETE on `leave_type` — see the
 * privileges section of the leave-type-rules migration — so a delete method here
 * would be a method that always fails, which is worse than one that does not
 * exist. Retiring is {@link LeaveTypeRepository.setActive}. The DELETE it does
 * hold is on `leave_type_approval_step`, which is a different thing: a step is
 * part of a type rather than a record about one.
 */

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveTypeApprovalStepTable, LeaveTypeTable } from '../db/schema.js';
import {
  type ApproverRole,
  chainOf,
  InvalidApprovalChain,
  stepsOf,
} from '../domain/approval-chain.js';
import type { Attribution } from '../domain/audit.js';
import type { Gender } from '../domain/employee.js';
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
} from '../domain/leave-type.js';
import { recording } from './recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `check_violation`, which every cross field rule on this table raises. */
const CHECK_VIOLATION = '23514';

/** The indexes created by the leave-type-rules migration. */
const CODE_INDEX = 'leave_type_code_unique';
const NAME_INDEX = 'leave_type_name_unique';

/**
 * Which field a refused row is reported against.
 *
 * The constraint name is read from the driver rather than guessed from the
 * message, so a violation of some future constraint is re-thrown as itself rather
 * than blamed on whichever field this table happened to know about. Every one of
 * these is also held in the domain, so reaching one of them means the write came
 * from outside this application — a migration correcting data, or somebody at a
 * psql prompt — and the honest thing is to say which rule refused it.
 */
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

/**
 * What the approval chain is refused for, all of it reported as one error.
 *
 * A chain has one field on a form and one thing wrong with it — the desks named,
 * or their order — so there is nothing for a {@link CHECKED_FIELDS} style mapping
 * to say that {@link InvalidApprovalChain} does not. The database's own message
 * is carried through, because reaching any of these means the write did not come
 * from this repository: every chain written here is validated and numbered by
 * ../domain/approval-chain.ts first.
 *
 * `leave_type_approval_chain_is_whole` is the deferred trigger, which raises with
 * a constraint name of its own so that it is recognisable here the same way a
 * real constraint is.
 */
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
  /** Only the types a request form should offer. Everything, unless asked. */
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

  /**
   * Applies a change. Returns undefined if there is no such type, which the
   * service turns into {@link LeaveTypeNotFound}.
   *
   * updated_at is not set here, for the reason it is not set in any of the other
   * repositories: the trigger does it, so a migration correcting data and the
   * seed get the same treatment as the application rather than only the writer
   * who remembered.
   */
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

  /**
   * Replaces the approval chain. FR 38a.
   *
   * Separate from {@link update} rather than a field of it, for the reason
   * {@link setActive} is separate: it is a decision about every request that will
   * ever be raised against the type rather than a correction to what the type is,
   * and the audit log should say which of the two happened.
   *
   * The chain is replaced rather than reconciled step by step. There is nothing
   * to preserve in a step row and no history kept in one — the history is the
   * audit entries, which are filed under the type — and reconciling would have to
   * pass through an intermediate chain that is a real chain: rewriting 'manager
   * then HR' to 'HR then CEO' in place is 'HR then HR' or 'manager then CEO' for
   * a statement, depending on which row moves first. Deleting and inserting has
   * no such state to be read, which is why `lms_app` holds DELETE on the steps and
   * no UPDATE.
   *
   * `leave_type` itself is touched so that `updated_at` moves. "When did this last
   * change" is asked of a type whose requests went to the wrong desk, and the
   * chain is exactly the part most likely to be behind it — the same reason the
   * working pattern repository touches the pattern when only the week changed.
   *
   * Returns undefined if there is no such type.
   */
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

  /**
   * Retires a type, or brings it back. The ending this table has.
   *
   * Separate from {@link update} rather than a field of it, because it is a
   * decision about every request that will ever be raised against the type rather
   * than a correction to what the type is. Doing it twice writes the boolean that
   * is already there and is allowed, like closing an already closed department.
   */
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
   * By code, compared without regard to case, so a lookup finds the same single
   * record the unique index would have refused a second of.
   *
   * This is the join a report and a staff import make, and it is the only reason
   * the column exists. It is not a way to ask "is this the maternity type" in
   * order to do something different: every rule is a column, and reading one is
   * reading the row this hands back.
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

  /**
   * Every type, or only the ones still offered, in the order a form shows them.
   *
   * `display_order` first, which is the order §7.4 reads balances in, so a screen
   * and a report agree without either of them sorting. Name second, so that two
   * types HR left at the same order are still in a fixed order and the same table
   * always produces the same list rather than whatever the planner returned.
   */
  async list(options: LeaveTypeListOptions = {}): Promise<LeaveType[]> {
    let query = this.db.selectFrom('leave_type').selectAll();

    if (options.offeredOnly === true) {
      query = query.where('is_active', '=', true);
    }

    const rows = await query.orderBy('display_order').orderBy('name').execute();

    if (rows.length === 0) {
      return [];
    }

    /* One statement for every type's chain rather than one per type, the way the
       working pattern repository reads a list of weeks. The database is usually a
       Neon branch at the end of a network, where the round trip costs far more
       than the work. */
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
          /* Reachable only from outside this repository — every write here sends
             a whole chain, validated, and numbers it itself. Reported as what it
             is rather than dressed up as something this file decided. */
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
