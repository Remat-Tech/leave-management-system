/**
 * Database access for roles.
 *
 * Reads only, and that is the whole of what LMS 110 needs: the one time code is
 * mandatory for HR Officer, HR Administrator and System Administrator, so the
 * sign in path has to ask what somebody holds. Assigning and removing roles is
 * LMS 111, and the writes belong to it — lms_app already holds the INSERT and
 * DELETE on user_role that it will use.
 *
 * A repository of its own rather than two more methods on
 * {@link SignInAccountRepository}, because roles are a subject in their own right
 * with a story of their own coming, and because the sign in path is not the only
 * thing that will ask: the authorisation layer of LMS 112 is the next caller and
 * it is not about signing in at all.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';

export interface Role {
  id: string;
  code: string;
  name: string;
}

export class RoleRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The role codes an account holds, in a stable order.
   *
   * Codes rather than rows, because that is what every caller does with them:
   * asks whether one of them is in a list. Ordered so that a message listing them
   * reads the same way twice, which matters for {@link CodeIsMandatory} and for
   * any test that compares one.
   *
   * An account with no roles gives an empty array. That is a real state — the
   * seed grants EMPLOYEE to everybody, but nothing forces it — and it means "no
   * mandatory role", never "all of them".
   */
  async codesFor(accountId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('user_role')
      .innerJoin('role', 'role.id', 'user_role.role_id')
      .where('user_role.user_id', '=', accountId)
      .select('role.code')
      .orderBy('role.code')
      .execute();

    return rows.map((row) => row.code);
  }

  /** Every role there is. Reference data, seeded by the organisation migration. */
  async list(): Promise<Role[]> {
    return this.db.selectFrom('role').select(['id', 'code', 'name']).orderBy('code').execute();
  }
}
