/**
 * Database access for entitlement rules. FR 31, §5.5. LMS 203.
 *
 * Queries and row mapping, nothing else. What a rule means and which of several
 * applies is ../domain/entitlement-rule.ts; when one may be written is
 * ../services/entitlement-rule-service.ts.
 *
 * ## The query that deliberately does not answer the question
 *
 * {@link EntitlementRuleRepository.candidatesFor} fetches every rule that could
 * apply to one person for one type and hands all of them back, unordered and
 * unfiltered by date. The obvious query is the other one — narrow by day, order
 * by specificity and starting date, take the first — and it would be a second
 * implementation of the rule the story says to implement once.
 *
 * The cost of not writing it is a handful of rows crossing the wire: one rule per
 * scope per change of policy, for one type, which is single digits for years.
 * The cost of writing it is that the precedence rule lives in two places, one of
 * which has no unit tests and cannot have any without a database.
 *
 * ## Refusals are translated rather than surfaced
 *
 * The same arrangement as the leave type and working pattern repositories: the
 * write is attempted and the database's answer is turned back into the domain
 * error for it, because checking first and writing afterwards is a race.
 *
 * One of them is not a race and is here anyway. The trigger that refuses to let a
 * rule already in effect be rewritten is checked by the service first, with a
 * clearer message — but a rule dated to start tomorrow becomes a rule in effect at
 * midnight, and a form submitted either side of that instant has to be refused
 * rather than accepted by whichever half of the second it landed in.
 */

import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveEntitlementRuleTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import {
  DuplicateEntitlementRule,
  type EntitlementRule,
  EntitlementRuleAlreadyApplies,
  InvalidEntitlementRule,
  type ValidatedEntitlementRule,
} from '../domain/entitlement-rule.js';
import { recording } from './recording.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `check_violation`, which every cross field rule on this table raises. */
const CHECK_VIOLATION = '23514';

/** Postgres `foreign_key_violation`: a rule naming a type, person or team that is not there. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Postgres `restrict_violation`, which the trigger raises with a constraint name
 * of its own so that this file can recognise it the same way it recognises a real
 * constraint. RAISE ... USING CONSTRAINT is what makes that possible.
 */
const RESTRICT_VIOLATION = '23001';

const SCOPE_AND_DAY_INDEX = 'leave_entitlement_rule_one_per_scope_and_day';
const IN_EFFECT_IS_HISTORY = 'leave_entitlement_rule_in_effect_is_history';

/**
 * Which field a refused row is reported against.
 *
 * Read from the constraint name the driver hands back rather than guessed from
 * the message, so a violation of some future constraint is re-thrown as itself.
 * Every one of these is also held in the domain, so reaching one means the write
 * came from outside this application, or from a race the domain cannot see.
 */
const CHECKED_FIELDS: Record<string, string> = {
  leave_entitlement_rule_scope_is_one_thing: 'departmentId',
  leave_entitlement_rule_days_not_negative: 'entitlementDays',
  leave_entitlement_rule_period_runs_forwards: 'effectiveTo',
  leave_entitlement_rule_carryover_agrees: 'carriesOver',
  leave_entitlement_rule_carryover_cap_positive: 'carryoverMaxDays',
  leave_entitlement_rule_carryover_month_real: 'carryoverExpiryMonth',
  leave_entitlement_rule_leave_type_id_fkey: 'leaveTypeId',
  leave_entitlement_rule_employee_id_fkey: 'employeeId',
  leave_entitlement_rule_department_id_fkey: 'departmentId',
};

type EntitlementRuleRow = Selectable<LeaveEntitlementRuleTable>;

/** Who a set of rules is being asked for. Every field narrows; none is required. */
export interface EntitlementRuleListOptions {
  leaveTypeId?: string;
  /** Rules naming this employee. Not "rules that apply to them"; see {@link resolve}. */
  employeeId?: string;
  departmentId?: string;
  /** Only the rules nobody has been paid against yet, which are the editable ones. */
  draftsOnly?: boolean;
}

/** The three facts that pick out the rules that could answer for somebody. */
export interface EntitlementCandidates {
  leaveTypeId: string;
  employeeId: string;
  departmentId: string;
}

export class EntitlementRuleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(by: Attribution, record: ValidatedEntitlementRule): Promise<EntitlementRule> {
    return this.catchRefusals(record.effectiveFrom, null, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_entitlement_rule')
          .values(rowFor(record))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toEntitlementRule(row);
    });
  }

  /**
   * Applies a change to a rule that has not taken effect yet.
   *
   * Takes the record rather than only its id, because the refusal the database
   * may raise is about the date on it: "rule 12 cannot be changed" says less than
   * it needs to, and re-reading the row to find out is a second round trip on the
   * path that has just lost a race.
   *
   * updated_at is not set here, for the reason it is not set in any repository:
   * the trigger does it, so a migration correcting data gets the same treatment
   * as the application.
   */
  async update(
    by: Attribution,
    rule: EntitlementRule,
    changes: Partial<ValidatedEntitlementRule>,
  ): Promise<EntitlementRule | undefined> {
    const values = changedColumnsOf(changes);

    if (Object.keys(values).length === 0) {
      // A form somebody submitted without touching it.
      return this.findById(rule.id);
    }

    return this.catchRefusals(changes.effectiveFrom ?? rule.effectiveFrom, rule, async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .updateTable('leave_entitlement_rule')
          .set(values)
          .where('id', '=', rule.id)
          .returningAll()
          .executeTakeFirst(),
      );

      return row === undefined ? undefined : toEntitlementRule(row);
    });
  }

  /**
   * Removes a rule that never applied to anybody. Returns whether there was one.
   *
   * There is a DELETE here, which there is not on `leave_type` and not on
   * `employee`, and the difference is what the row is. A rule dated to start next
   * January is a plan; nothing has been calculated from it, nothing is filed under
   * it, and the honest correction for one entered by mistake is to remove it. The
   * moment it starts applying it becomes history and the trigger refuses this for
   * every writer, so the privilege is only ever exercised on drafts.
   */
  async remove(by: Attribution, rule: EntitlementRule): Promise<boolean> {
    return this.catchRefusals(rule.effectiveFrom, rule, async () => {
      const deleted = await recording(this.db, by, (on) =>
        on.deleteFrom('leave_entitlement_rule').where('id', '=', rule.id).executeTakeFirst(),
      );

      return deleted.numDeletedRows > 0n;
    });
  }

  async findById(id: string): Promise<EntitlementRule | undefined> {
    const row = await this.db
      .selectFrom('leave_entitlement_rule')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toEntitlementRule(row);
  }

  /**
   * Every rule that could apply to one person for one type.
   *
   * Three scopes in one read: the rules naming them, the rules naming their
   * department, and the rules naming nobody. No date filter and no ordering —
   * both of those are the resolution rule, and the resolution rule is
   * {@link resolve}.
   */
  async candidatesFor(who: EntitlementCandidates): Promise<EntitlementRule[]> {
    const rows = await this.db
      .selectFrom('leave_entitlement_rule')
      .selectAll()
      .where('leave_type_id', '=', who.leaveTypeId)
      .where((eb) =>
        eb.or([
          eb('employee_id', '=', who.employeeId),
          eb('department_id', '=', who.departmentId),
          eb.and([eb('employee_id', 'is', null), eb('department_id', 'is', null)]),
        ]),
      )
      .execute();

    return rows.map(toEntitlementRule);
  }

  /**
   * Rules, newest starting date first, for a screen rather than for a decision.
   *
   * The order is presentation: HR reads the history of a figure downwards from the
   * one in force now. Nothing decides anything from this order — see the note at
   * the top of this file.
   */
  async list(options: EntitlementRuleListOptions = {}, today?: string): Promise<EntitlementRule[]> {
    let query = this.db.selectFrom('leave_entitlement_rule').selectAll();

    if (options.leaveTypeId !== undefined) {
      query = query.where('leave_type_id', '=', options.leaveTypeId);
    }
    if (options.employeeId !== undefined) {
      query = query.where('employee_id', '=', options.employeeId);
    }
    if (options.departmentId !== undefined) {
      query = query.where('department_id', '=', options.departmentId);
    }
    if (options.draftsOnly === true && today !== undefined) {
      query = query.where('effective_from', '>', today);
    }

    const rows = await query.orderBy('effective_from', 'desc').orderBy('id', 'desc').execute();

    return rows.map(toEntitlementRule);
  }

  private async catchRefusals<T>(
    effectiveFrom: string,
    rule: EntitlementRule | null,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (violation?.code === UNIQUE_VIOLATION && violation.constraint === SCOPE_AND_DAY_INDEX) {
        throw new DuplicateEntitlementRule(effectiveFrom);
      }

      if (violation?.code === RESTRICT_VIOLATION && violation.constraint === IN_EFFECT_IS_HISTORY) {
        /* Reached only by losing a race with midnight, or by a writer that did
           not come through the service. Either way the database is right and the
           refusal is the one FR 31 asks for. */
        throw new EntitlementRuleAlreadyApplies(
          rule?.id ?? '',
          rule?.effectiveFrom ?? effectiveFrom,
          'changed',
        );
      }

      if (violation?.code === CHECK_VIOLATION || violation?.code === FOREIGN_KEY_VIOLATION) {
        const field = CHECKED_FIELDS[violation.constraint];

        if (field !== undefined) {
          throw new InvalidEntitlementRule(
            field,
            error instanceof Error
              ? error.message
              : `The entitlement rule breaks ${violation.constraint}.`,
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
function rowFor(record: ValidatedEntitlementRule): Insertable<LeaveEntitlementRuleTable> {
  return {
    leave_type_id: record.leaveTypeId,
    employee_id: record.employeeId,
    department_id: record.departmentId,
    entitlement_days: record.entitlementDays,
    prorate_on_join: record.prorateOnJoin,
    carries_over: record.carriesOver,
    carryover_max_days: record.carryoverMaxDays,
    carryover_expiry_month: record.carryoverExpiryMonth,
    effective_from: record.effectiveFrom,
    effective_to: record.effectiveTo,
    note: record.note,
  };
}

/**
 * The fields a change actually named, as columns.
 *
 * `in` rather than a check for undefined, because clearing an end date and
 * leaving it alone are different instructions and stay different all the way down
 * to the UPDATE statement.
 */
function changedColumnsOf(
  changes: Partial<ValidatedEntitlementRule>,
): Updateable<LeaveEntitlementRuleTable> {
  const values: Updateable<LeaveEntitlementRuleTable> = {};

  if ('leaveTypeId' in changes) values.leave_type_id = changes.leaveTypeId;
  if ('employeeId' in changes) values.employee_id = changes.employeeId;
  if ('departmentId' in changes) values.department_id = changes.departmentId;
  if ('entitlementDays' in changes) values.entitlement_days = changes.entitlementDays;
  if ('prorateOnJoin' in changes) values.prorate_on_join = changes.prorateOnJoin;
  if ('carriesOver' in changes) values.carries_over = changes.carriesOver;
  if ('carryoverMaxDays' in changes) values.carryover_max_days = changes.carryoverMaxDays;
  if ('carryoverExpiryMonth' in changes) {
    values.carryover_expiry_month = changes.carryoverExpiryMonth;
  }
  if ('effectiveFrom' in changes) values.effective_from = changes.effectiveFrom;
  if ('effectiveTo' in changes) values.effective_to = changes.effectiveTo;
  if ('note' in changes) values.note = changes.note;

  return values;
}

/**
 * A row as the domain sees it.
 *
 * The two dates arrive as the ten characters they are stored as, not as `Date`s:
 * the driver is configured in ../db/index.ts to hand `date` columns back
 * untouched, which is the off by one day bug NFR DAT 03 exists to prevent.
 */
function toEntitlementRule(row: EntitlementRuleRow): EntitlementRule {
  return {
    id: row.id,
    leaveTypeId: row.leave_type_id,
    employeeId: row.employee_id,
    departmentId: row.department_id,
    entitlementDays: row.entitlement_days,
    prorateOnJoin: row.prorate_on_join,
    carriesOver: row.carries_over,
    carryoverMaxDays: row.carryover_max_days,
    carryoverExpiryMonth: row.carryover_expiry_month,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
