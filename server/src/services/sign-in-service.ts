/**
 * Signing in with a company email address, and the one time code that follows it. NFR SEC 01, LMS 109, LMS 110, LMS 112.
 */

import { type Actor, signedInAs } from '../auth/actor.js';
import {
  allowedDomains,
  assertCompanyEmail,
  isCompanyEmail,
  NotACompanyEmail,
} from '../auth/company-email.js';
import {
  challengeIsLive,
  checkCode,
  CodeIsMandatory,
  CodeRefused,
  type CodeSettings,
  codeEmail,
  codeSettings,
  expiryFrom,
  generateCode,
  hashCode,
  holdsMandatoryRole,
  isCodeRequired,
  MAX_CODE_ATTEMPTS,
} from '../auth/mfa.js';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import {
  assertCanSignIn,
  assertUsablePassword,
  EmploymentHasEnded,
  type SignInAccount,
  SignInAccountNotFound,
  SignInRefused,
} from '../auth/sign-in.js';
import type { Guard } from '../auth/policy.js';
import { signInPolicy } from '../auth/sign-in-policy.js';
import { EmployeeNotFound, type Employee } from '../domain/employee.js';
import type { Mailer } from '../mail/mailer.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { RoleRepository } from '../repositories/role-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';

export interface SignInServiceOptions {
  /** The company domains an address may belong to. */
  domains?: string[];
  /** How long a code lives and how many digits it has. */
  code?: CodeSettings;
}

/** Who signed in. */
export interface SignedIn {
  account: SignInAccount;
  employee: Employee;
  /** What they may do. NFR SEC 02, LMS 112. */
  actor: Actor;
}

/** What happened when somebody gave the right password. */
export type SignInOutcome =
  | ({ status: 'SIGNED_IN' } & SignedIn)
  | {
      status: 'CODE_SENT';
      /** Where it went, so a screen can say "we have sent a code to a...h@..." */
      companyEmail: string;
      /** When it stops working, so a screen can say how long they have. */
      expiresAt: Date;
    };

export class SignInService {
  private readonly domains: string[];
  private readonly code: CodeSettings;

  constructor(
    private readonly accounts: SignInAccountRepository,
    private readonly employees: EmployeeRepository,
    /**
     * One question asked of it, in one place: does this account hold a role for which a code is mandatory. LMS 110.
     */
    private readonly roles: RoleRepository,
    private readonly mailer: Mailer,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    options: SignInServiceOptions = {},
  ) {
    this.domains = options.domains ?? allowedDomains();
    this.code = options.code ?? codeSettings();
  }

  /** Signs somebody in, or refuses. LMS 110. */
  async signIn(email: string, password: string): Promise<SignInOutcome> {
    const address = typeof email === 'string' ? email : '';
    const supplied = typeof password === 'string' ? password : '';

    assertCompanyEmail(address, this.domains);

    const credentials = await this.accounts.credentialsByEmail(address);

    if (credentials === undefined) {
      // The same work, so that an address with no login is not measurably faster
      // to try than one with a login and a wrong password.
      await verifyPassword(supplied, null);
      throw new SignInRefused('NO_ACCOUNT');
    }

    const { account, passwordHash } = credentials;

    if (!(await verifyPassword(supplied, passwordHash))) {
      throw new SignInRefused(passwordHash === null ? 'NO_PASSWORD' : 'WRONG_PASSWORD');
    }

    const employee = await this.employees.findById(account.employeeId);

    // Read now, from the employee record, rather than from anything copied onto
    // the account when they left. This is the whole of "access ends when the
    // company account does".
    assertCanSignIn(account, employee);

    if (isCodeRequired(account, await this.roles.codesFor(account.id))) {
      return this.sendCode(account.companyEmail, account.id);
    }

    return {
      status: 'SIGNED_IN',
      // employee is defined: assertCanSignIn refuses undefined above.
      ...(await this.open(account, employee!, passwordHash, supplied)),
    };
  }

  /** Answers the code, and opens the door. LMS 110. */
  async submitCode(email: string, code: string): Promise<SignedIn> {
    const address = typeof email === 'string' ? email : '';
    const answer = typeof code === 'string' ? code.trim() : '';

    assertCompanyEmail(address, this.domains);

    const credentials = await this.accounts.credentialsByEmail(address);
    if (credentials === undefined) {
      throw new CodeRefused('NO_CHALLENGE');
    }

    const { account, passwordHash, challenge } = credentials;

    const dead = challengeIsLive(challenge.expiresAt, challenge.attempts, new Date());
    if (dead !== null) {
      if (dead !== 'NO_CHALLENGE') {
        await this.accounts.clearChallenge(account.id);
      }
      throw new CodeRefused(dead);
    }

    if (!(await checkCode(answer, challenge.hash))) {
      const attempts = await this.accounts.countFailedAttempt(account.id);

      if (attempts >= MAX_CODE_ATTEMPTS) {
        await this.accounts.clearChallenge(account.id);
        throw new CodeRefused('TOO_MANY_ATTEMPTS');
      }

      throw new CodeRefused('WRONG_CODE', MAX_CODE_ATTEMPTS - attempts);
    }

    const employee = await this.employees.findById(account.employeeId);
    assertCanSignIn(account, employee);

    return this.open(account, employee!, passwordHash, undefined);
  }

  /** Issues a code, sends it, and says so. */
  private async sendCode(companyEmail: string, accountId: string): Promise<SignInOutcome> {
    const code = generateCode(this.code.length);
    const expiresAt = expiryFrom(new Date(), this.code.ttlMinutes);

    await this.accounts.startChallenge(accountId, await hashCode(code), expiresAt);
    await this.mailer.send(codeEmail(companyEmail, code, this.code.ttlMinutes));

    return { status: 'CODE_SENT', companyEmail, expiresAt };
  }

  /** The last thing every successful sign in does, whichever door it came through. LMS 112. */
  private async open(
    account: SignInAccount,
    employee: Employee,
    passwordHash: string | null,
    password: string | undefined,
  ): Promise<SignedIn> {
    const at = new Date();

    const rehashed =
      password !== undefined && needsRehash(passwordHash)
        ? await hashPassword(password)
        : undefined;

    const [roles, reports] = await Promise.all([
      this.roles.codesFor(account.id),
      this.employees.countReports(employee.id),
    ]);

    /**
     * Built before the write rather than after it, because the write is attributed to them. LMS 113.
     */
    const actor = signedInAs(employee.id, { roles, isManager: reports > 0 });

    await this.accounts.recordSignIn(actor, account.id, at, rehashed);

    return {
      employee,
      account: { ...account, lastLoginAt: at },
      actor,
    };
  }

  /** Gives an employee a login. LMS 111. */
  async provision(
    actor: Actor,
    employeeId: string,
    options: { password?: string } = {},
  ): Promise<SignInAccount> {
    this.guard.enforce(signInPolicy.provision(actor, employeeId));

    const employee = await this.employees.findById(employeeId);
    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    if (!isCompanyEmail(employee.workEmail, this.domains)) {
      throw new NotACompanyEmail(employee.workEmail);
    }

    if (employee.employmentStatus === 'TERMINATED') {
      throw new EmploymentHasEnded(employee);
    }

    const passwordHash =
      options.password === undefined
        ? null
        : await hashPassword(assertUsablePassword(options.password));

    return this.accounts.create(actor, {
      employeeId: employee.id,
      companyEmail: employee.workEmail.trim().toLowerCase(),
      passwordHash,
    });
  }

  /** Sets or replaces somebody's password. */
  async setPassword(actor: Actor, employeeId: string, password: string): Promise<SignInAccount> {
    this.guard.enforce(signInPolicy.setPassword(actor, employeeId));

    const account = await this.requireAccount(employeeId);
    const updated = await this.accounts.setPassword(
      actor,
      account.id,
      await hashPassword(assertUsablePassword(password)),
    );

    if (updated === undefined) {
      throw new SignInAccountNotFound(`employee ${employeeId}`);
    }

    return updated;
  }

  /**
   * Turns the one time code on for somebody who is not obliged to have it.
   *
   * The choice half of {@link isCodeRequired}. An ordinary employee who wants a
   * second factor gets one by asking; an HR officer has one whether they ask or
   * not, so calling this for them changes nothing they did not already have.
   */
  async requireCode(actor: Actor, employeeId: string): Promise<SignInAccount> {
    return this.setMfa(actor, employeeId, true);
  }

  /**
   * Turns it off, unless the roles they hold say it cannot be turned off.
   *
   * {@link CodeIsMandatory} names the roles rather than saying no. "You cannot do
   * that" is not something an HR administrator can act on; "this is required for
   * HR_ADMIN, remove the role first if that is what you meant" is, and it is also
   * the sentence that stops somebody quietly stripping a colleague's second
   * factor and believing they have done it.
   *
   * Refused rather than silently ignored, for the same reason: a switch that
   * reports off while the thing is on is worse than one that refuses.
   */
  async stopRequiringCode(actor: Actor, employeeId: string): Promise<SignInAccount> {
    return this.setMfa(actor, employeeId, false);
  }

  private async setMfa(actor: Actor, employeeId: string, enabled: boolean): Promise<SignInAccount> {
    /* Your own switch, or HR's. Two refusals can come out of this method and they
       are for different things: this one says the caller has no business touching
       that account, and CodeIsMandatory below says the *account holder's roles*
       will not let the code be turned off whoever is asking. */
    this.guard.enforce(signInPolicy.changeCodeSetting(actor, employeeId));

    const account = await this.requireAccount(employeeId);

    if (!enabled) {
      const codes = await this.roles.codesFor(account.id);
      if (holdsMandatoryRole(codes)) {
        throw new CodeIsMandatory(codes);
      }
    }

    const updated = await this.accounts.setMfaEnabled(actor, account.id, enabled);
    if (updated === undefined) {
      throw new SignInAccountNotFound(`employee ${employeeId}`);
    }

    return updated;
  }

  /**
   * Whether this person will be asked for a code, and why.
   *
   * A read, for a screen that has to show somebody the state of their own account
   * without making them sign in to find out. `mandatory` is what distinguishes
   * "you chose this" from "your role decides this", which is the difference
   * between a switch to show and a sentence to show.
   */
  async codePolicyFor(
    actor: Actor,
    employeeId: string,
  ): Promise<{ required: boolean; mandatory: boolean }> {
    this.guard.enforce(signInPolicy.read(actor, employeeId));

    const account = await this.requireAccount(employeeId);
    const codes = await this.roles.codesFor(account.id);

    return { required: isCodeRequired(account, codes), mandatory: holdsMandatoryRole(codes) };
  }

  /**
   * Closes a login, and reopens one.
   *
   * The administrative lock, and nothing to do with employment. A leaver is
   * refused by their employee record and needs nothing done here; this is for the
   * account that has to be shut for a reason of its own — a shared password, a
   * lost laptop, an investigation — and for undoing that afterwards.
   *
   * Never a delete. lms_app holds no DELETE on app_user, user_role rows point at
   * it, and LMS 113's audit entries will name it. An account that was removed
   * rather than closed leaves a trail referring to somebody nobody can identify.
   */
  async close(actor: Actor, employeeId: string): Promise<SignInAccount> {
    this.guard.enforce(signInPolicy.close(actor, employeeId));

    return this.setActive(actor, employeeId, false);
  }

  async reopen(actor: Actor, employeeId: string): Promise<SignInAccount> {
    this.guard.enforce(signInPolicy.reopen(actor, employeeId));

    return this.setActive(actor, employeeId, true);
  }

  /** Somebody's login, if they have one. Undefined rather than a throw: it is a fair question. */
  async forEmployee(actor: Actor, employeeId: string): Promise<SignInAccount | undefined> {
    this.guard.enforce(signInPolicy.read(actor, employeeId));

    return this.accounts.findByEmployeeId(employeeId);
  }

  /**
   * The login for an address.
   *
   * Undefined rather than a throw, and unlike {@link signIn} it says whether the
   * address is known. That is safe because nothing anonymous calls it: this is
   * for HR looking somebody up, and since LMS 112 the authorisation that sentence
   * was relying on is on the line below rather than in a story yet to be written.
   */
  async forEmail(actor: Actor, companyEmail: string): Promise<SignInAccount | undefined> {
    this.guard.enforce(signInPolicy.search(actor));

    return this.accounts.findByEmail(companyEmail);
  }

  private async setActive(
    actor: Actor,
    employeeId: string,
    isActive: boolean,
  ): Promise<SignInAccount> {
    const account = await this.requireAccount(employeeId);
    const updated = await this.accounts.setActive(actor, account.id, isActive);

    if (updated === undefined) {
      throw new SignInAccountNotFound(`employee ${employeeId}`);
    }

    return updated;
  }

  private async requireAccount(employeeId: string): Promise<SignInAccount> {
    const account = await this.accounts.findByEmployeeId(employeeId);

    if (account === undefined) {
      throw new SignInAccountNotFound(`employee ${employeeId}`);
    }

    return account;
  }
}
