/**
 * Database access for roles. §5.3.
 *
 * Queries and row mapping, nothing else. What a role is and which of them may be
 * granted is ../auth/roles.ts; deciding when to grant one is
 * ../services/role-service.ts; deciding what a role *permits* is LMS 112 and is
 * nowhere yet.
 *
 * A repository of its own rather than more methods on
 * {@link SignInAccountRepository}, because roles are a subject in their own right
 * and because the sign in path is not the only thing that asks: LMS 110 wants to
 * know whether a code is mandatory, LMS 111 grants and revokes, and the
 * authorisation layer of LMS 112 is the next caller and is not about signing in
 * at all.
 *
 * Everything here is keyed on the *account* id rather than the employee id,
 * because that is what user_role holds. Translating from a person to their login
 * is the service's job, and it is a translation worth keeping visible: an
 * employee with no login holds no roles, which is different from holding none.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { orderRoles, type RoleCode } from '../auth/roles.js';

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
 * A refusal that came from one of the role triggers rather than from a check the
 * service made first.
 *
 * Carried as a distinct type so the service can turn it into the domain error
 * with the good message, without every caller having to know a constraint name.
 * Every one of these is a race the service asked about and lost — two people
 * removing the last System Administrator at the same moment — which is exactly
 * the case a check cannot cover and a constraint can.
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

  /**
   * The role codes an account holds, ordered from least to most power.
   *
   * Codes rather than rows, because that is what every caller does with them:
   * asks whether one of them is in a list. Ordered by {@link orderRoles} rather
   * than by the database, because the order that means something is the order
   * ROLE_CODES declares — alphabetically, HR_ADMIN comes before HR_OFFICER,
   * which is the reverse of what it means.
   *
   * An account with no roles gives an empty array, and that means "no roles",
   * never "all of them".
   */
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

  /**
   * Gives an account a role.
   *
   * Returns false when they already had it, rather than throwing. Granting a role
   * somebody holds is not a mistake worth a refusal — it is two HR officers doing
   * the same sensible thing, or one of them clicking twice — and the state
   * afterwards is the state that was wanted either way. The service decides
   * whether the caller is told.
   *
   * `ON CONFLICT DO NOTHING` rather than a read and an insert, because the read
   * and the insert are a race: two grants of the same role at the same instant
   * both find nothing and both insert, and one of them gets a primary key
   * violation for doing what it was asked. The database settles it in one
   * statement.
   */
  async grant(accountId: string, code: RoleCode): Promise<boolean> {
    const result = await this.catchRefusals(() =>
      this.db
        .insertInto('user_role')
        .values({ user_id: accountId, role_id: this.idOf(code) })
        .onConflict((conflict) => conflict.columns(['user_id', 'role_id']).doNothing())
        .executeTakeFirst(),
    );

    return (result?.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Takes a role away. Returns false when they did not hold it.
   *
   * The two triggers from the role-assignment-rules migration are what can refuse
   * this — the baseline immediately, the last System Administrator at COMMIT —
   * and both come back as {@link RoleRefusedByDatabase} for the service to
   * translate.
   */
  async revoke(accountId: string, code: RoleCode): Promise<boolean> {
    const result = await this.catchRefusals(() =>
      this.db
        .deleteFrom('user_role')
        .where('user_id', '=', accountId)
        .where('role_id', '=', this.idOf(code))
        .executeTakeFirst(),
    );

    return (result?.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * The id of a role, as a subquery rather than as a read.
   *
   * `role` is four rows of reference data that a CHECK constraint holds closed
   * and that lms_app can no longer even insert into, so joining to it costs
   * nothing and reading it first would be a round trip to learn something that
   * cannot change. Keeping it inside the statement also means a grant is one
   * statement, which is what lets the conflict clause settle a race.
   */
  private idOf(code: RoleCode) {
    return this.db.selectFrom('role').select('id').where('code', '=', code).limit(1);
  }

  /**
   * Everybody holding a role, as employee ids.
   *
   * The join through app_user is done here rather than by the caller reading each
   * account in turn, because "who are the System Administrators" is one question
   * and should be one statement. The service turns the ids into records.
   */
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

  /** How many accounts hold a role. Asked of SYS_ADMIN before taking it away. */
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

  /**
   * Every role there is. Reference data, seeded by the organisation migration and
   * held to four by role_code_known.
   */
  async list(): Promise<Role[]> {
    const rows = await this.db
      .selectFrom('role')
      .select(['id', 'code', 'name'])
      .orderBy('code')
      .execute();

    return rows.map((row) => ({ ...row, code: row.code as RoleCode }));
  }

  /**
   * Runs a write and turns a trigger's refusal into something the service can
   * translate, reading the constraint name from the driver rather than guessing
   * from the message text.
   *
   * A primary key violation is deliberately not translated. `grant` cannot
   * provoke one — it conflicts and does nothing — so a unique violation reaching
   * here is a bug rather than a race, and it should arrive as itself.
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

      /* Everything else, including a unique violation, arrives as itself. `grant`
         conflicts and does nothing rather than colliding, so a duplicate key
         reaching here is a bug and should look like one. */
      throw error;
    }
  }
}

/**
 * The SQLSTATE and constraint name of a refusal, when the error carries both.
 *
 * The same shape as the employee and sign in account repositories', and
 * deliberately a copy rather than something shared: three identical eight line
 * functions are cheaper to read than one utility module that every repository has
 * to be traced through.
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
