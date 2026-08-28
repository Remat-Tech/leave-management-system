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
import type { Attribution } from '../domain/audit.js';
import { recording } from './recording.js';
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
 * A one time code challenge as it stands on the row. LMS 110.
 *
 * All three together, because they are only meaningful together: a hash with no
 * expiry is a code that never dies, an expiry with no hash is a question nothing
 * answers, and a count with neither is counting nothing. The
 * app_user_code_and_expiry_together constraint holds the first two to that.
 *
 * `hash` is here rather than on {@link SignInAccount} for the reason the password
 * hash is: a secret at rest leaves the repository only through something whose
 * name says it is handing one over.
 */
export interface CodeChallenge {
  hash: string | null;
  expiresAt: Date | null;
  attempts: number;
}

/**
 * An account together with the secrets to check an answer against.
 *
 * Returned in one object rather than by several reads because they are read
 * together exactly once, in the sign in path, and a second round trip there is a
 * second chance for the row to have changed between them.
 */
export interface SignInCredentials {
  account: SignInAccount;
  passwordHash: string | null;
  challenge: CodeChallenge;
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
  async create(by: Attribution, record: NewSignInAccount): Promise<SignInAccount> {
    const row = await this.catchRefusals(record, () =>
      recording(this.db, by, (on) =>
        on
          .insertInto('app_user')
          .values({
            employee_id: record.employeeId,
            company_email: record.companyEmail,
            password_hash: record.passwordHash,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      ),
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

    return row === undefined ? undefined : toCredentials(row);
  }

  /**
   * Starts a one time code challenge, replacing whatever was there. LMS 110.
   *
   * One statement, and it is what makes a code single use from the moment it is
   * issued: the previous hash, its expiry and its attempt count all go at once.
   * Two codes in flight for one account would mean the older one still opens the
   * door, which is exactly the code an attacker who has been fishing in a mailbox
   * already has.
   *
   * The attempt count is reset here rather than anywhere else, because this is
   * the only place a new challenge begins.
   */
  async startChallenge(id: string, hash: string, expiresAt: Date): Promise<void> {
    await this.db
      .updateTable('app_user')
      .set({ mfa_code_hash: hash, mfa_code_expires_at: expiresAt, mfa_code_attempts: 0 })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Ends a challenge, whether it was answered or abandoned.
   *
   * The other half of single use. Called on a correct code, on the attempt that
   * exhausts the limit, and on a code found to have expired — a dead challenge is
   * cleared rather than left lying about, so that the resting state of the column
   * is genuinely "nobody is half way through signing in".
   */
  async clearChallenge(id: string): Promise<void> {
    await this.db
      .updateTable('app_user')
      .set({ mfa_code_hash: null, mfa_code_expires_at: null, mfa_code_attempts: 0 })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Counts a wrong answer, and says how many have now been made.
   *
   * Incremented in the database rather than read, added to and written back. The
   * two are not the same under concurrency: somebody guessing from four
   * connections at once against a read-modify-write records one attempt where
   * four were made, which is how a five attempt limit becomes a twenty attempt
   * one. `attempts + 1` is decided by the database, once, per statement.
   */
  async countFailedAttempt(id: string): Promise<number> {
    const row = await this.db
      .updateTable('app_user')
      .set((eb) => ({ mfa_code_attempts: eb('mfa_code_attempts', '+', 1) }))
      .where('id', '=', id)
      .returning('mfa_code_attempts')
      .executeTakeFirst();

    return row?.mfa_code_attempts ?? 0;
  }

  /*
   * A note on which methods here carry an {@link Attribution} and which do not.
   * LMS 113.
   *
   * The three challenge methods above — startChallenge, clearChallenge and
   * countFailedAttempt — touch nothing but mfa_code_hash, mfa_code_expires_at
   * and mfa_code_attempts, and the audit trigger is told those are noise. A
   * change to nothing but noise writes no entry, so there is no entry for a name
   * to go on. That is deliberate and it is the difference between an audit log
   * and an access log: a code issued and answered is how somebody got in, not a
   * decision anybody will dispute two years from now. See the audit-log
   * migration, and ../auth/denials.ts, which draws the same line about refusals.
   *
   * recordSignIn does carry one, because it can also rewrite the password hash
   * when the cost has been raised. That is a real change to a credential, it is
   * recorded, and the person it is attributed to is the person signing in — who
   * has, at that exact moment, just proved who they are.
   */

  /** Turns the code requirement on or off for somebody who may choose. LMS 110. */
  async setMfaEnabled(
    by: Attribution,
    id: string,
    enabled: boolean,
  ): Promise<SignInAccount | undefined> {
    const row = await recording(this.db, by, (on) =>
      on
        .updateTable('app_user')
        .set({ mfa_enabled: enabled })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : toAccount(row);
  }

  /** Sets or replaces the password. Undefined if there is no such login. */
  async setPassword(
    by: Attribution,
    id: string,
    passwordHash: string,
  ): Promise<SignInAccount | undefined> {
    const row = await recording(this.db, by, (on) =>
      on
        .updateTable('app_user')
        .set({ password_hash: passwordHash })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : toAccount(row);
  }

  /** Closes or reopens a login. Undefined if there is no such login. */
  async setActive(
    by: Attribution,
    id: string,
    isActive: boolean,
  ): Promise<SignInAccount | undefined> {
    const row = await recording(this.db, by, (on) =>
      on
        .updateTable('app_user')
        .set({ is_active: isActive })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : toAccount(row);
  }

  /**
   * Stamps a successful sign in, ends any challenge, and rewrites the password
   * hash if it was made with an older cost.
   *
   * One statement for all three, because they are one event. The door opened, so
   * whatever challenge was in progress is finished by definition — leaving it
   * behind is how a code that has already been used stays usable — and this is
   * the only point at which the plain password is legitimately in hand, so it is
   * the only point at which an old hash can be brought up to the current cost
   * without asking anybody to change anything.
   *
   * Clearing unconditionally is deliberate. Most sign ins never had a challenge
   * and set three columns that were already null, which costs nothing and means
   * there is no path through this method that leaves a live code behind.
   */
  async recordSignIn(by: Attribution, id: string, at: Date, passwordHash?: string): Promise<void> {
    await recording(this.db, by, (on) =>
      on
        .updateTable('app_user')
        .set({
          last_login_at: at,
          mfa_code_hash: null,
          mfa_code_expires_at: null,
          mfa_code_attempts: 0,
          ...(passwordHash === undefined ? {} : { password_hash: passwordHash }),
        })
        .where('id', '=', id)
        .execute(),
    );
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
 * A row with the secrets the sign in path has to check an answer against.
 *
 * The one shape in this file that carries a hash, and it is built in one place so
 * that adding a secret to the table is a change here rather than in every read.
 */
function toCredentials(row: AppUserRow): SignInCredentials {
  return {
    account: toAccount(row),
    passwordHash: row.password_hash,
    challenge: {
      hash: row.mfa_code_hash,
      expiresAt: row.mfa_code_expires_at,
      attempts: row.mfa_code_attempts,
    },
  };
}

/**
 * A row as the rest of the application wants it, which is a row without any of
 * its secrets. Adding one here is how it starts appearing in logs.
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
