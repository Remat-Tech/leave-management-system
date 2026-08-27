/**
 * Database access for the sign in account. NFR SEC 01, LMS 109.
 *
 * Queries and row mapping, nothing else. What a login is and what makes one
 * usable is ../auth/sign-in.ts; when to apply those rules is
 * ../services/sign-in-service.ts; how a password becomes a hash is
 * ../auth/password.ts, and nothing in this file knows.
 *
 * The one thing this file is stricter about than its neighbours is what leaves
 * it. `password_hash` is not part of {@link SignInAccount} and is returned by
 * exactly one method, {@link SignInAccountRepository.credentialsByEmail}, whose
 * name says what it is handing over. Every other read is a login without its
 * credential, so a hash cannot end up in a log line, an API response or an error
 * message by being carried along in an object nobody looked inside.
 *
 * Addresses are compared folded, matching the app_user_company_email_unique
 * index, so a lookup finds the single row that index would have refused a second
 * of.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { AppUserTable } from '../db/schema.js';
import {
  SignInAccountExists,
  SignInAddressMustBeTheWorkAddress,
  type SignInAccount,
} from '../auth/sign-in.js';
import { EmployeeNotFound } from '../domain/employee.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Postgres `check_violation`, which is what the address trigger raises. */
const CHECK_VIOLATION = '23514';

/** The index created by the sign-in-account-rules migration. */
const EMAIL_INDEX = 'app_user_company_email_unique';

/** One login per employee, from the organisation migration's UNIQUE. */
const EMPLOYEE_KEY = 'app_user_employee_id_key';

const EMPLOYEE_FK = 'app_user_employee_id_fkey';

/** The deferred constraint trigger from the sign-in-account-rules migration. */
const ADDRESS_TRIGGER = 'app_user_email_is_the_work_email';

type AppUserRow = Selectable<AppUserTable>;

/** What a login is created from. The address is not among them; see {@link create}. */
export interface NewSignInAccount {
  employeeId: string;
  companyEmail: string;
  passwordHash: string | null;
}

/**
 * An account together with the hash to check a password against.
 *
 * The two are returned in one object rather than by two reads because they are
 * read together exactly once, in the sign in path, and a second round trip there
 * is a second chance for the row to have changed between them.
 */
export interface SignInCredentials {
  account: SignInAccount;
  passwordHash: string | null;
}

export class SignInAccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Creates a login.
   *
   * `companyEmail` is supplied by the service, which took it from the employee
   * record rather than from whoever asked. The database checks that anyway — the
   * app_user_email_is_the_work_email trigger — because this is not the only thing
   * that can write to the table.
   */
  async create(record: NewSignInAccount): Promise<SignInAccount> {
    const row = await this.catchRefusals(record, () =>
      this.db
        .insertInto('app_user')
        .values({
          employee_id: record.employeeId,
          company_email: record.companyEmail,
          password_hash: record.passwordHash,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toAccount(row);
  }

  async findById(id: string): Promise<SignInAccount | undefined> {
    const row = await this.db
      .selectFrom('app_user')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toAccount(row);
  }

  async findByEmployeeId(employeeId: string): Promise<SignInAccount | undefined> {
    const row = await this.db
      .selectFrom('app_user')
      .selectAll()
      .where('employee_id', '=', employeeId)
      .executeTakeFirst();

    return row === undefined ? undefined : toAccount(row);
  }

  async findByEmail(companyEmail: string): Promise<SignInAccount | undefined> {
    return (await this.credentialsByEmail(companyEmail))?.account;
  }

  /**
   * The login for an address, with its password hash. The sign in path's one read.
   *
   * Undefined when there is no such login, which the service turns into a refusal
   * with the same message a wrong password gets. Whether the address exists is
   * not something a stranger may learn from the outside, so it is not something
   * this method's caller may report.
   */
  async credentialsByEmail(companyEmail: string): Promise<SignInCredentials | undefined> {
    const row = await this.db
      .selectFrom('app_user')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['company_email']), '=', fold(companyEmail)))
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : { account: toAccount(row), passwordHash: row.password_hash };
  }

  /** Sets or replaces the password. Undefined if there is no such login. */
  async setPassword(id: string, passwordHash: string): Promise<SignInAccount | undefined> {
    const row = await this.db
      .updateTable('app_user')
      .set({ password_hash: passwordHash })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toAccount(row);
  }

  /** Closes or reopens a login. Undefined if there is no such login. */
  async setActive(id: string, isActive: boolean): Promise<SignInAccount | undefined> {
    const row = await this.db
      .updateTable('app_user')
      .set({ is_active: isActive })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toAccount(row);
  }

  /**
   * Stamps a successful sign in, and rewrites the hash if it was made with an
   * older cost.
   *
   * One statement for both, because they happen at the same moment and for the
   * same reason: this is the only point at which the plain password is
   * legitimately in hand, so it is the only point at which a hash can be brought
   * up to the current cost without asking anybody to change anything.
   */
  async recordSignIn(id: string, at: Date, passwordHash?: string): Promise<void> {
    await this.db
      .updateTable('app_user')
      .set(
        passwordHash === undefined
          ? { last_login_at: at }
          : { last_login_at: at, password_hash: passwordHash },
      )
      .where('id', '=', id)
      .execute();
  }

  /**
   * Turns whatever the database refused a write for into the error for that
   * refusal, reading the constraint name from the driver rather than guessing
   * from the message text.
   *
   * Both unique violations are the same answer said two ways — the address is
   * taken, or the employee already has a login — and since the address is the
   * employee's own work address, one is always the other. It is reported once,
   * with the address, because that is what the caller has to act on.
   */
  private async catchRefusals<T>(attempted: NewSignInAccount, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (
        violation?.code === UNIQUE_VIOLATION &&
        (violation.constraint === EMAIL_INDEX || violation.constraint === EMPLOYEE_KEY)
      ) {
        throw new SignInAccountExists(attempted.companyEmail);
      }

      if (violation?.code === FOREIGN_KEY_VIOLATION && violation.constraint === EMPLOYEE_FK) {
        throw new EmployeeNotFound(attempted.employeeId);
      }

      if (violation?.code === CHECK_VIOLATION && violation.constraint === ADDRESS_TRIGGER) {
        /* Deferred, so this arrives at COMMIT. The service takes the address from
           the employee record and cannot provoke it; something else wrote to the
           table, and this says so rather than reporting a check violation nobody
           can place. */
        throw new SignInAddressMustBeTheWorkAddress();
      }

      throw error;
    }
  }
}

/**
 * The SQLSTATE and constraint name of a refusal, when the error carries both.
 *
 * The same shape as the employee repository's, and deliberately a copy rather
 * than something shared: two identical eight line functions are cheaper to read
 * than one utility module that every repository has to be traced through.
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

function fold(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A row as the rest of the application wants it, which is a row without its
 * password hash. Adding it here is how it starts appearing in logs.
 */
function toAccount(row: AppUserRow): SignInAccount {
  return {
    id: row.id,
    employeeId: row.employee_id,
    companyEmail: row.company_email,
    isActive: row.is_active,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
