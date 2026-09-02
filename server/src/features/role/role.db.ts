/** Database access for roles. §5.3., LMS 112, LMS 110, LMS 111. */

import type { Kysely } from 'kysely';
import type { Database } from '../../db/index.js';
import type { Attribution } from '../audit/audit.js';
import { recording } from '../../db/recording.js';
import { orderRoles, type RoleCode } from './roles.js';

export interface Role {
  id: string;
  code: RoleCode;
  name: string;
}

/** A grant, as it is recorded. LMS 111. */
export interface RoleGrant {
  code: RoleCode;
  grantedAt: Date;
}

/** Postgres `check_violation`, which is what both role triggers raise. */
const CHECK_VIOLATION = '23514';

/** The triggers created by the role-assignment-rules migration. */
const BASELINE_TRIGGER = 'user_role_keeps_the_baseline';
const LAST_ADMIN_TRIGGER = 'user_role_keeps_a_system_administrator';

/**
 * A refusal that came from one of the role triggers rather than from a check the service made first.
 */
export class RoleRefusedByDatabase extends Error {
  readonly constraintName: string;

  constructor(constraintName: string, message: string) {
    super(message);
    this.name = 'RoleRefusedByDatabase';
    this.constraintName = constraintName;
  }
}

export { BASELINE_TRIGGER, LAST_ADMIN_TRIGGER };

export class RoleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** The role codes an account holds, ordered from least to most power. */
  async codesFor(accountId: string): Promise<RoleCode[]> {
    const rows = await this.db
      .selectFrom('user_role')
      .innerJoin('role', 'role.id', 'user_role.role_id')
      .where('user_role.user_id', '=', accountId)
      .select('role.code')
      .execute();

    return orderRoles(rows.map((row) => row.code));
  }

  /** The same, with the date each was granted. LMS 111. */
  async grantsFor(accountId: string): Promise<RoleGrant[]> {
    const rows = await this.db
      .selectFrom('user_role')
      .innerJoin('role', 'role.id', 'user_role.role_id')
      .where('user_role.user_id', '=', accountId)
      .select(['role.code', 'user_role.granted_at'])
      .execute();

    const byCode = new Map(rows.map((row) => [row.code, row.granted_at]));

    return orderRoles(rows.map((row) => row.code)).map((code) => ({
      code,
      // Present by construction: the code came out of the same rows.
      grantedAt: byCode.get(code)!,
    }));
  }

  /** Gives an account a role. */
  async grant(by: Attribution, accountId: string, code: RoleCode): Promise<boolean> {
    const result = await this.catchRefusals(() =>
      recording(this.db, by, (on) =>
        on
          .insertInto('user_role')
          .values({ user_id: accountId, role_id: this.idOf(code) })
          .onConflict((conflict) => conflict.columns(['user_id', 'role_id']).doNothing())
          .executeTakeFirst(),
      ),
    );

    return (result?.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  /** Takes a role away. */
  async revoke(by: Attribution, accountId: string, code: RoleCode): Promise<boolean> {
    const result = await this.catchRefusals(() =>
      recording(this.db, by, (on) =>
        on
          .deleteFrom('user_role')
          .where('user_id', '=', accountId)
          .where('role_id', '=', this.idOf(code))
          .executeTakeFirst(),
      ),
    );

    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  /** The id of a role, as a subquery rather than as a read. */
  private idOf(code: RoleCode) {
    return this.db.selectFrom('role').select('id').where('code', '=', code).limit(1);
  }

  /** Everybody holding a role, as employee ids. */
  async employeeIdsHolding(code: RoleCode): Promise<string[]> {
    const rows = await this.db
      .selectFrom('user_role')
      .innerJoin('role', 'role.id', 'user_role.role_id')
      .innerJoin('app_user', 'app_user.id', 'user_role.user_id')
      .where('role.code', '=', code)
      .select('app_user.employee_id')
      .execute();

    return rows.map((row) => row.employee_id);
  }

  /** How many accounts hold a role. */
  async countHolding(code: RoleCode): Promise<number> {
    const row = await this.db
      .selectFrom('user_role')
      .innerJoin('role', 'role.id', 'user_role.role_id')
      .where('role.code', '=', code)
      .select((eb) => eb.fn.countAll<string>().as('held'))
      .executeTakeFirstOrThrow();

    // count() comes back as a string, because a count can exceed 2^53 in
    // principle. It cannot here, and a headcount is a number.
    return Number(row.held);
  }

  /** Every role there is. */
  async list(): Promise<Role[]> {
    const rows = await this.db
      .selectFrom('role')
      .select(['id', 'code', 'name'])
      .orderBy('code')
      .execute();

    return rows.map((row) => ({ ...row, code: row.code as RoleCode }));
  }

  /**
   * Runs a write and turns a trigger's refusal into something the service can translate, reading the constraint name from the driver rather than guessi…
   */
  private async catchRefusals<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (
        violation?.code === CHECK_VIOLATION &&
        (violation.constraint === BASELINE_TRIGGER || violation.constraint === LAST_ADMIN_TRIGGER)
      ) {
        throw new RoleRefusedByDatabase(
          violation.constraint,
          error instanceof Error ? error.message : String(error),
        );
      }

      throw error;
    }
  }
}

/** The SQLSTATE and constraint name of a refusal, when the error carries both. */
function violationOf(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  return typeof code === 'string' && typeof constraint === 'string'
    ? { code, constraint }
    : undefined;
}
