/**
 * Signing in with a company email address, and the one time code that follows
 * it. NFR SEC 01. LMS 109 and LMS 110.
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
 * Signing in is two steps for anybody who needs a code. {@link signIn} takes the
 * password and either opens the door or sends a code and says so;
 * {@link submitCode} takes the code and opens the door. Which of the two
 * {@link signIn} does is not the caller's choice and not the caller's business to
 * predict — it is decided here, from the account and the roles it holds, and the
 * return type is a union so that a caller cannot forget the second case exists.
 *
 * What this service does not do, all of it deliberate and none of it hidden:
 *
 *   No session. Signing in returns who signed in — and, since LMS 112, the
 *   {@link Actor} that says what they may do. It still does not issue a cookie
 *   or a token, because there is no HTTP layer to set one on and minting a
 *   signed credential here would be a security decision made in the wrong place.
 *   SESSION_SECRET is still in the environment and still unread. What LMS 112
 *   settled is the half that has to be right whatever the interface does: what
 *   happens once a request is identified.
 *
 *   No roles beyond reading them. What somebody may do once they are in is
 *   ../auth/, and the four policy objects there are what read the actor this
 *   service hands out. Two questions are answered here and no more: do they hold
 *   a role for which a code is mandatory, and what does the actor for this person
 *   look like.
 *
 *   No rate limit and no lockout, and LMS 110 adds a second thing that needs one.
 *   A code challenge is answered by address, so somebody who knows a colleague's
 *   address and polls this method can spend that colleague's five attempts as
 *   soon as they appear and make them start again. It grants no access — every
 *   guess is still a guess — but it is a denial of service, and the answer is the
 *   same counter and delay in front of the route that unlimited password guesses
 *   need. It belongs with the route, it needs doing, and it is not done. The
 *   alternative, binding the second step to an opaque token issued by the first,
 *   is the better answer if that route never arrives.
 *
 *   No password reset, and no self service change. HR sets a password through
 *   {@link setPassword}, which is enough for a system with no email based
 *   identity flow in it yet, and not enough for long. It needs doing.
 *
 *   No recovery codes. Somebody locked out of their company mailbox is locked out
 *   of this, and the answer for now is that IT can restore the mailbox, because
 *   the mailbox is the company account this whole story ties access to.
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
  /**
   * The company domains an address may belong to. Read from
   * ALLOWED_EMAIL_DOMAINS when not given, which is how the application runs;
   * tests pass their own so they need no environment.
   */
  domains?: string[];
  /**
   * How long a code lives and how many digits it has. Read from
   * MFA_CODE_TTL_MINUTES and MFA_CODE_LENGTH when not given.
   */
  code?: CodeSettings;
}

/** Who signed in. Not a session, and not a token. */
export interface SignedIn {
  account: SignInAccount;
  employee: Employee;
  /**
   * What they may do. NFR SEC 02, LMS 112.
   *
   * The only place in the system a person's {@link Actor} is minted, and it is
   * here because this is the only place that has just proved who somebody is.
   * Everything above this line passes it down; nothing else constructs one.
   *
   * It is not a session and cannot be used as one. There is no signature on it
   * and nothing that could verify one, so a route layer must derive its own from
   * whatever it uses to identify a request rather than taking one over the wire
   * — the whole point of this object is that it is the *answer* to "who is this",
   * never the evidence for it.
   */
  actor: Actor;
}

/**
 * What happened when somebody gave the right password.
 *
 * A union rather than a {@link SignedIn} with a nullable field, because the two
 * cases are not the same event wearing different clothes. In one, somebody is in.
 * In the other, nobody is in, a code is in a mailbox, and the caller has another
 * screen to show. A caller that treats the second as the first has let somebody
 * past a factor, and the type is what stops that being a thing you can do by
 * forgetting.
 *
 * `CODE_SENT` carries no account and no employee. Nothing about who they are is
 * settled until the code comes back, and handing over a record at this point is
 * how it ends up on a screen that has not finished authenticating anybody.
 */
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
    /* The employee repository rather than the EmployeeService, for the same
       reason EmployeeService takes the department repository rather than its
       service: what is wanted here is one record read, not the employee rules.
       Bringing the service would put "may this person's manager be changed"
       behind the sign in surface, which is not this layer's question. */
    private readonly employees: EmployeeRepository,
    /* One question asked of it, in one place: does this account hold a role for
       which a code is mandatory. LMS 110. */
    private readonly roles: RoleRepository,
    /* Sending, behind the interface in /mail, so that this service neither holds
       an SMTP connection nor knows that nodemailer exists — and so that a test
       can read what the message actually said. */
    private readonly mailer: Mailer,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. It
       guards everything HR does with an account and deliberately guards neither
       {@link signIn} nor {@link submitCode} — see ../auth/sign-in-policy.ts. */
    private readonly guard: Guard,
    options: SignInServiceOptions = {},
  ) {
    /* Both resolved once, at construction, so that a misconfigured environment
       stops the application starting rather than letting the first sign in
       attempt discover it. allowedDomains() throws on an empty list; codeSettings()
       throws on a length or a lifetime that is present and nonsense. */
    this.domains = options.domains ?? allowedDomains();
    this.code = options.code ?? codeSettings();
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
   *   4. And only now, whether a code is needed. LMS 110. Asked last on purpose:
   *      sending a code is sending mail to a real person, and doing it before the
   *      password is proved would turn this method into a way of posting a message
   *      into any colleague's mailbox as often as you like.
   *
   * The password is not checked for strength here, ever. Strength is a rule about
   * what may be *stored*, and applying it at the door would lock everybody out on
   * the day {@link MINIMUM_PASSWORD_LENGTH} is raised — which is exactly the day
   * nobody should be locked out.
   *
   * Returns either `SIGNED_IN` or `CODE_SENT`, and the caller does not get to
   * choose which. See {@link SignInOutcome}.
   */
  async signIn(email: string, password: string): Promise<SignInOutcome> {
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

    /* Read now as well, and for the same reason: an HR officer who had their
       role removed this morning is not an HR officer this afternoon, and one who
       was given it this morning is. A copy of this on the account row would be
       wrong on both of those days. */
    if (isCodeRequired(account, await this.roles.codesFor(account.id))) {
      return this.sendCode(account.companyEmail, account.id);
    }

    return {
      status: 'SIGNED_IN',
      // employee is defined: assertCanSignIn refuses undefined above.
      ...(await this.open(account, employee!, passwordHash, supplied)),
    };
  }

  /**
   * Answers the code, and opens the door. LMS 110, the second step.
   *
   * Keyed on the address rather than on something the first step handed out,
   * which is the simplest thing that works without a session and is the thing
   * that needs a rate limiter in front of it — see the note at the top of this
   * file. It discloses nothing: an address with no challenge in progress is every
   * address, to anybody who has not already given the right password.
   *
   * The order here is as deliberate as the first step's:
   *
   *   Is there a live challenge at all — one that exists, has not expired and has
   *   attempts left. A dead one is cleared as it is found, so that the resting
   *   state of those columns is honestly "nobody is half way through signing in".
   *
   *   Is the code right. A wrong one costs an attempt, counted by the database so
   *   that four connections guessing at once cost four.
   *
   *   And *then* the account and the employee again. Not a repetition of the
   *   first step: minutes have passed, and somebody terminated in between must
   *   not be let in by a code that was issued while they still worked here.
   *
   * The challenge is consumed by {@link SignInAccountRepository.recordSignIn}, in
   * the same statement that stamps the sign in, which is what makes a code single
   * use rather than merely intended to be.
   */
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

  /**
   * Issues a code, sends it, and says so.
   *
   * The hash is written before the message is sent, and the order matters. Sent
   * first, a failure to write leaves somebody holding a code the system has no
   * record of; written first, a failure to send leaves a challenge nobody can
   * answer, which expires in ten minutes and costs one more sign in attempt. The
   * second is the cheaper failure.
   *
   * A send that throws comes out of {@link signIn} unchanged rather than being
   * swallowed. "We have sent you a code" when nothing was sent is the worst of
   * the three outcomes: the person waits, then telephones.
   */
  private async sendCode(companyEmail: string, accountId: string): Promise<SignInOutcome> {
    const code = generateCode(this.code.length);
    const expiresAt = expiryFrom(new Date(), this.code.ttlMinutes);

    await this.accounts.startChallenge(accountId, await hashCode(code), expiresAt);
    await this.mailer.send(codeEmail(companyEmail, code, this.code.ttlMinutes));

    return { status: 'CODE_SENT', companyEmail, expiresAt };
  }

  /**
   * The last thing every successful sign in does, whichever door it came through.
   *
   * One place, so that the stamp, the consumed challenge and the rehash cannot
   * happen on one path and not the other. `password` is present only on the path
   * that had one in hand — the code step never sees a password, so a hash made at
   * an older cost is left for the next single factor sign in to rewrite rather
   * than being rewritten from nothing.
   *
   * Since LMS 112 it is also the one place a person's {@link Actor} is minted,
   * and for the same reason it is the one place the sign in is stamped: whatever
   * is true of somebody the moment they get in has to be settled here or it is
   * settled twice and differently.
   *
   * The two reads it takes are the two halves of {@link Authority}, and they are
   * made here rather than through {@link RoleService.authorityFor} on purpose.
   * That method asks the role policy whether the caller may read somebody's
   * roles, and the caller at this instant is somebody who has just finished
   * proving who they are and holds no actor yet — there is nothing to authorise
   * with. The roles are read here already, for the mandatory code rule; this
   * adds one count of the reporting lines beside it.
   */
  private async open(
    account: SignInAccount,
    employee: Employee,
    passwordHash: string | null,
    password: string | undefined,
  ): Promise<SignedIn> {
    const at = new Date();

    /* The one moment the plain password is legitimately in hand, so the one
       moment a hash made with an older cost can be brought up to the current one.
       Nobody is asked to change anything and nothing is migrated. */
    const rehashed =
      password !== undefined && needsRehash(passwordHash)
        ? await hashPassword(password)
        : undefined;

    const [roles, reports] = await Promise.all([
      this.roles.codesFor(account.id),
      this.employees.countReports(employee.id),
    ]);

    /* Built before the write rather than after it, because the write is
       attributed to them. Stamping a sign in records nothing — the audit trigger
       is told those columns are noise — but a hash rewritten at a raised cost is
       a real change to a credential, and the person it is recorded against is
       the person who has just this moment proved who they are. LMS 113. */
    const actor = signedInAs(employee.id, { roles, isManager: reports > 0 });

    await this.accounts.recordSignIn(actor, account.id, at, rehashed);

    return {
      employee,
      account: { ...account, lastLoginAt: at },
      /* Being a manager is derived above, from the reporting lines, exactly as
         RoleService derives it and for the reason the organisation migration
         gave when it refused to store MANAGER as a role. It is a snapshot taken
         now, which is what the whole actor is; see ../auth/actor.ts. */
      actor,
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
   *
   * The EMPLOYEE role arrives with the login and is not granted here. LMS 111 put
   * it in the app_user_holds_the_baseline_role trigger, so that a login and the
   * baseline role it cannot function without land in one transaction and so that
   * every writer gets it, not only this one. Anything beyond the baseline is
   * {@link RoleService.grant}.
   */
  async provision(
    actor: Actor,
    employeeId: string,
    options: { password?: string } = {},
  ): Promise<SignInAccount> {
    /* HR, and not only an administrator. Setting a joiner up is the same five
       minutes as creating their record, and a rule that turns it into a ticket
       is a rule that gets worked around with a shared password. See
       ../auth/sign-in-policy.ts, where that argument is made properly. */
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
