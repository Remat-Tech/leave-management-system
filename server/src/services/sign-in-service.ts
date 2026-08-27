/**
 * Signing in with a company email address. NFR SEC 01. LMS 109.
 *
 * The login door, and the other side of the provisioning door that
 * {@link EmployeeService.create} already holds. The story asks for both, and the
 * reason it asks for both is that they are two entrances to the same building:
 * refusing a personal address when a record is created stops that record
 * existing, and refusing one here stops anybody signing in with an address that
 * got past the first door before the list said what it says today.
 *
 * The order of the checks in {@link signIn} is the security design of this file
 * and is not incidental. Nothing that could be discovered by guessing is
 * disclosed before a password has been proved, and everything after that point
 * is said plainly, because at that point the person has proved they are the
 * account holder.
 *
 * What this service does not do, all of it deliberate and none of it hidden:
 *
 *   No session. Signing in returns who signed in; it does not issue a cookie,
 *   because there is no HTTP layer to set one on and a token minted here would be
 *   a security decision made in the wrong place and a month early. SESSION_SECRET
 *   is in the environment waiting for it. LMS 112 is where the request side of
 *   this lands.
 *
 *   No second factor. LMS 110 sends a one time code to the same company address
 *   and makes it mandatory for the HR and administrator roles. The seam is marked
 *   in {@link signIn}: this method is the first of what will be two steps, and
 *   `mfaEnabled` is read by nothing until then.
 *
 *   No roles. What somebody may do once they are in is LMS 111 and LMS 112.
 *   This answers who they are, and stops.
 *
 *   No rate limit and no lockout. Ten thousand guesses a second against this
 *   method are refused ten thousand times and nothing notices. scrypt makes each
 *   guess cost something, which is a floor rather than a defence, and the real
 *   answer is a counter and a delay in front of the route. It needs doing, it
 *   belongs with the route, and it is not done.
 *
 *   No password reset, and no self service change. HR sets a password through
 *   {@link setPassword}, which is enough for a system with no email based
 *   identity flow in it yet, and not enough for long. It needs doing.
 */

import {
  allowedDomains,
  assertCompanyEmail,
  isCompanyEmail,
  NotACompanyEmail,
} from '../auth/company-email.js';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password.js';
import {
  assertCanSignIn,
  assertUsablePassword,
  EmploymentHasEnded,
  type SignInAccount,
  SignInAccountNotFound,
  SignInRefused,
} from '../auth/sign-in.js';
import { EmployeeNotFound, type Employee } from '../domain/employee.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { SignInAccountRepository } from '../repositories/sign-in-account-repository.js';

export interface SignInServiceOptions {
  /**
   * The company domains an address may belong to. Read from
   * ALLOWED_EMAIL_DOMAINS when not given, which is how the application runs;
   * tests pass their own so they need no environment.
   */
  domains?: string[];
}

/** Who signed in. Not a session, and not a token. */
export interface SignedIn {
  account: SignInAccount;
  employee: Employee;
}

export class SignInService {
  private readonly domains: string[];

  constructor(
    private readonly accounts: SignInAccountRepository,
    /* The employee repository rather than the EmployeeService, for the same
       reason EmployeeService takes the department repository rather than its
       service: what is wanted here is one record read, not the employee rules.
       Bringing the service would put "may this person's manager be changed"
       behind the sign in surface, which is not this layer's question. */
    private readonly employees: EmployeeRepository,
    options: SignInServiceOptions = {},
  ) {
    // Resolved once, at construction. allowedDomains() throws on an empty list,
    // so a misconfigured environment stops the application starting rather than
    // letting the first sign in attempt decide what an empty allow list means.
    this.domains = options.domains ?? allowedDomains();
  }

  /**
   * Signs somebody in, or refuses.
   *
   * The order:
   *
   *   1. The address is a company address. {@link NotACompanyEmail}, with a
   *      message that says so, which is the story's second acceptance criterion.
   *      This one is specific on purpose and discloses nothing: which domains the
   *      company uses is on its website, and telling somebody that their Gmail
   *      address will never work here saves them trying it again tomorrow. It
   *      also means a personal address never reaches the database at all.
   *
   *   2. There is a login for it, and the password matches. Both of those are
   *      one message — {@link SignInRefused} with the generic text — because
   *      separate messages turn this method into a way of finding out who works
   *      here. The work of verifying is done even when there is no such login,
   *      so that "no account" and "wrong password" take the same time as well as
   *      saying the same thing.
   *
   *   3. Only now, the account and the employee. Closed account, leaver,
   *      suspension: each says which it is, because the password has been proved
   *      and there is no longer a stranger to keep anything from.
   *
   * The password is not checked for strength here, ever. Strength is a rule about
   * what may be *stored*, and applying it at the door would lock everybody out on
   * the day {@link MINIMUM_PASSWORD_LENGTH} is raised — which is exactly the day
   * nobody should be locked out.
   *
   * LMS 110 goes between steps 3 and 4: a successful return here becomes "the
   * first factor is satisfied, now send a code", and only the second step returns
   * a {@link SignedIn}.
   */
  async signIn(email: string, password: string): Promise<SignedIn> {
    /* This is the outermost door of the system and whatever is pushed through it
       has been through no parser of ours. A door does not raise a TypeError at
       what it is handed; it refuses it. The route layer of Phase 5 will validate
       its own body, and this stays true whether or not it remembers to. */
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
      /* Two reasons, one message. Which of them it was is worth having in the
         log — an account nobody ever set a password on is a provisioning job
         somebody did not finish, not an attack — and is worth nothing on screen. */
      throw new SignInRefused(passwordHash === null ? 'NO_PASSWORD' : 'WRONG_PASSWORD');
    }

    const employee = await this.employees.findById(account.employeeId);

    // Read now, from the employee record, rather than from anything copied onto
    // the account when they left. This is the whole of "access ends when the
    // company account does".
    assertCanSignIn(account, employee);

    const at = new Date();

    /* The one moment the plain password is legitimately in hand, so the one
       moment a hash made with an older cost can be brought up to the current one.
       Nobody is asked to change anything and nothing is migrated. */
    await this.accounts.recordSignIn(
      account.id,
      at,
      needsRehash(passwordHash) ? await hashPassword(supplied) : undefined,
    );

    return {
      // employee is defined: assertCanSignIn refuses undefined above.
      employee: employee!,
      account: { ...account, lastLoginAt: at },
    };
  }

  /**
   * Gives an employee a login. The provisioning door.
   *
   * The address is taken from the employee record and is never a parameter. That
   * is the point of the method's shape: an address a caller could supply is an
   * address a caller could get wrong, and "who may sign in as this person" is not
   * a free text field. The database holds the same rule, in
   * app_user_email_is_the_work_email, for the writers that never come through
   * here.
   *
   * The domain is checked again even though {@link EmployeeService.create}
   * checked it. The record may predate today's allow list — a subsidiary sold, a
   * domain retired — and this is the door that decides whether somebody may sign
   * in today, not whether they could have been employed then.
   *
   * A leaver gets no login. It would be refused at sign in anyway, so this is
   * about not creating access that has to be remembered about later.
   *
   * The password is optional. A login with none exists and cannot be signed into
   * — which is the honest state of a joiner's account between HR creating it and
   * somebody choosing a password — and is told from a wrong password only in the
   * log.
   */
  async provision(employeeId: string, options: { password?: string } = {}): Promise<SignInAccount> {
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

    return this.accounts.create({
      employeeId: employee.id,
      /* Folded, as the employee domain folds it on the way in. The address is a
         machine identifier rather than a name and there is nothing to preserve
         the capitals of; the unique index compares folded in any event. */
      companyEmail: employee.workEmail.trim().toLowerCase(),
      passwordHash,
    });
  }

  /**
   * Sets or replaces somebody's password.
   *
   * Keyed on the employee rather than the account, because one person has one
   * login and HR works in terms of people. It does not ask for the current
   * password: this is HR setting a joiner up or helping somebody who is locked
   * out, not a person changing their own. Self service change, which does have to
   * ask, is not written — see the note at the top of this file.
   */
  async setPassword(employeeId: string, password: string): Promise<SignInAccount> {
    const account = await this.requireAccount(employeeId);
    const updated = await this.accounts.setPassword(
      account.id,
      await hashPassword(assertUsablePassword(password)),
    );

    if (updated === undefined) {
      throw new SignInAccountNotFound(`employee ${employeeId}`);
    }

    return updated;
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
  async close(employeeId: string): Promise<SignInAccount> {
    return this.setActive(employeeId, false);
  }

  async reopen(employeeId: string): Promise<SignInAccount> {
    return this.setActive(employeeId, true);
  }

  /** Somebody's login, if they have one. Undefined rather than a throw: it is a fair question. */
  async forEmployee(employeeId: string): Promise<SignInAccount | undefined> {
    return this.accounts.findByEmployeeId(employeeId);
  }

  /**
   * The login for an address.
   *
   * Undefined rather than a throw, and unlike {@link signIn} it says whether the
   * address is known. That is safe because nothing anonymous calls it: this is
   * for HR looking somebody up, behind the authorisation of LMS 112, not for the
   * sign in box.
   */
  async forEmail(companyEmail: string): Promise<SignInAccount | undefined> {
    return this.accounts.findByEmail(companyEmail);
  }

  private async setActive(employeeId: string, isActive: boolean): Promise<SignInAccount> {
    const account = await this.requireAccount(employeeId);
    const updated = await this.accounts.setActive(account.id, isActive);

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
