/** Database access for the sign in account. NFR SEC 01, LMS 109. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { AppUserTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import { recording } from '../../db/recording.js';
import {
  SignInAccountExists,
  SignInAddressMustBeTheWorkAddress,
  type SignInAccount,
} from './sign-in.js';
import { EmployeeNotFound } from '../employee/employee.js';

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

/** What a login is created from. */
export interface NewSignInAccount {
  employeeId: string;
  companyEmail: string;
  passwordHash: string | null;
}

/** A one time code challenge as it stands on the row. LMS 110. */
export interface CodeChallenge {
  hash: string | null;
  expiresAt: Date | null;
  attempts: number;
}

/** An account together with the secrets to check an answer against. */
export interface SignInCredentials {
  account: SignInAccount;
  passwordHash: string | null;
  challenge: CodeChallenge;
}

export class SignInAccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Creates a login. */
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

  /** The login for an address, with its password hash. */
  async credentialsByEmail(companyEmail: string): Promise<SignInCredentials | undefined> {
    const row = await this.db
      .selectFrom('app_user')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['company_email']), '=', fold(companyEmail)))
      .executeTakeFirst();

    return row === undefined ? undefined : toCredentials(row);
  }

  /** Starts a one time code challenge, replacing whatever was there. LMS 110. */
  async startChallenge(id: string, hash: string, expiresAt: Date): Promise<void> {
    await this.db
      .updateTable('app_user')
      .set({ mfa_code_hash: hash, mfa_code_expires_at: expiresAt, mfa_code_attempts: 0 })
      .where('id', '=', id)
      .execute();
  }

  /** Ends a challenge, whether it was answered or abandoned. */
  async clearChallenge(id: string): Promise<void> {
    await this.db
      .updateTable('app_user')
      .set({ mfa_code_hash: null, mfa_code_expires_at: null, mfa_code_attempts: 0 })
      .where('id', '=', id)
      .execute();
  }

  /** Counts a wrong answer, and says how many have now been made. */
  async countFailedAttempt(id: string): Promise<number> {
    const row = await this.db
      .updateTable('app_user')
      .set((eb) => ({ mfa_code_attempts: eb('mfa_code_attempts', '+', 1) }))
      .where('id', '=', id)
      .returning('mfa_code_attempts')
      .executeTakeFirst();

    return row?.mfa_code_attempts ?? 0;
  }

  /** A note on which methods here carry an Attribution and which do not. LMS 113. */

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

  /** Sets or replaces the password. */
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

  /** Closes or reopens a login. */
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
   * Stamps a successful sign in, ends any challenge, and rewrites the password hash if it was made with an older cost.
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
   * Turns whatever the database refused a write for into the error for that refusal, reading the constraint name from the driver rather than guessing f…
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
        throw new SignInAddressMustBeTheWorkAddress();
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

function fold(email: string): string {
  return email.trim().toLowerCase();
}

/** A row with the secrets the sign in path has to check an answer against. */
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

/** A row as the rest of the application wants it, which is a row without any of its secrets. */
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
