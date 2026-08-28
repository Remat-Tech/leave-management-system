/**
 * Who may give somebody a login, take one away, and see one. NFR SEC 01 and
 * NFR SEC 02. §10. LMS 112, over LMS 109 and LMS 110.
 *
 * ## What is not here, and must never be
 *
 * **Signing in.** {@link SignInService.signIn} and {@link SignInService.submitCode}
 * take no actor and consult no policy, and that is the one exemption in this
 * whole layer. They are the door: nobody is anybody until they have been through
 * it, and an authorisation check in front of them would be a check on a person
 * the system has not yet identified. Their own rules — the company domain, the
 * password, the leaver, the code — are ./sign-in.ts and ./mfa.ts, and those are
 * a different kind of question with a different and much more careful answer
 * about what may be disclosed.
 *
 * That exemption is worth stating in a file rather than leaving as the absence
 * of two methods, because "the sign in path has no authorisation check" is
 * exactly the sentence somebody will read as a bug and fix.
 *
 * ## Setting somebody up is HR's, and closing an account is not
 *
 * This is the one boundary in this layer that was argued about, so it is written
 * down rather than left in the shape of the code.
 *
 * Provisioning a login and setting a password are {@link PROVIDES_LOGINS} — HR
 * Officers included. The joining process is HR's: they create the record on
 * somebody's first morning and the login belongs in the same five minutes. Put
 * it behind an administrator instead and the two minute job becomes a ticket,
 * and a company that has to raise a ticket to let a new starter in is a company
 * where four people in HR know the administrator password by March. The rule
 * that gets worked around protects nothing.
 *
 * Closing and reopening an account is {@link ADMINISTERS_ACCESS} — an HR
 * Administrator or a System Administrator. That is not the joining process, it
 * is a decision about somebody: a shared password, a lost laptop, an
 * investigation. It wants the second pair of eyes that onboarding does not.
 *
 * Note what neither of them touches. A leaver is refused at the door by their
 * employee record, with nothing written to `app_user` at all, so ending
 * somebody's access on the day they leave needs no login privilege and is
 * {@link EmployeeService.terminate}. That is the arrangement LMS 109 chose so
 * that access could not be left open by a path that forgot to revoke it, and it
 * is what makes the split above affordable.
 *
 * ## Reading, and the code
 *
 * Reading an account, and choosing whether to be asked for a one time code, are
 * yours as well as an administrator's. A person is entitled to see the state of
 * their own access without signing in somewhere else to find out, and LMS 110
 * already said that anybody may turn a code on for themselves — the switch is
 * theirs, and the refusal for the roles that cannot turn it off is
 * {@link CodeIsMandatory}, which is a rule about the role rather than about who
 * is asking.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { ADMINISTERS_ACCESS, PROVIDES_LOGINS } from './roles.js';

const about = policyFor('sign in account');

/** Said openly. Somebody being refused this is being told which door they are at. */
const SETTING_UP_IS_HRS =
  'Logins are created and passwords reset by HR. Ask them — they can do it from ' +
  'the same screen as your employee record.';

const CLOSING_IS_ADMINISTRATIVE =
  'Closing and reopening a login is an HR Administrator or a System ' +
  'Administrator, because it is a decision about somebody rather than part of ' +
  'joining or leaving. Ask one of them.';

/**
 * Setting a joiner up, and resetting a password for somebody locked out.
 *
 * Self is deliberately not a case, and it is the case somebody will want to add.
 * Setting your own password sounds like the most ordinary thing in the world and
 * is a different feature with a different shape — it has to ask for the current
 * password, or for something emailed, and neither of those exists. See the note
 * at the top of ../services/sign-in-service.ts: self service password change is
 * not built, and letting it in through this door would build the dangerous half
 * of it without the safe half.
 */
function settingUp(actor: Actor, action: string, employeeId: string): Decision {
  return holdsAny(actor, ...PROVIDES_LOGINS)
    ? about.allow(actor, action, employeeId)
    : about.refuseOpenly(
        actor,
        action,
        employeeId,
        'holds no role that provides logins',
        SETTING_UP_IS_HRS,
      );
}

/** The administrative lock, and undoing it. A rank above setting somebody up. */
function lock(actor: Actor, action: string, employeeId: string): Decision {
  return holdsAny(actor, ...ADMINISTERS_ACCESS)
    ? about.allow(actor, action, employeeId)
    : about.refuseOpenly(
        actor,
        action,
        employeeId,
        'holds no role that administers access',
        CLOSING_IS_ADMINISTRATIVE,
      );
}

export const signInPolicy = {
  resource: about.resource,

  /** Giving somebody a login. LMS 109. HR, on the joiner's first morning. */
  provision(actor: Actor, employeeId: string): Decision {
    return settingUp(actor, 'provision', employeeId);
  },

  /** Setting or resetting one. Not the same thing as changing your own, which is not built. */
  setPassword(actor: Actor, employeeId: string): Decision {
    return settingUp(actor, 'setPassword', employeeId);
  },

  /** Shutting a login for a reason of its own. Nothing to do with employment. */
  close(actor: Actor, employeeId: string): Decision {
    return lock(actor, 'close', employeeId);
  },

  reopen(actor: Actor, employeeId: string): Decision {
    return lock(actor, 'reopen', employeeId);
  },

  /**
   * Somebody's account, and whether they will be asked for a code.
   *
   * Yours, or anybody in HR — the same people who provision one, since a screen
   * that offers "reset this password" has to be able to show whether there is an
   * account to reset. Refused vaguely rather than openly for anybody else,
   * because "no account for that employee" and "not yours to look at" are the
   * same disclosure problem the employee policy has: a login exists for
   * everybody who has been provisioned one, so being able to tell the two apart
   * is a way of finding out who has access.
   */
  read(actor: Actor, employeeId: string): Decision {
    if (isSelf(actor, employeeId)) {
      return about.allow(actor, 'read', employeeId);
    }

    return holdsAny(actor, ...PROVIDES_LOGINS)
      ? about.allow(actor, 'read', employeeId)
      : about.refuse(
          actor,
          'read',
          employeeId,
          'not their own account, and holds no role that provides logins',
        );
  },

  /**
   * Finding an account by the address on it.
   *
   * HR only, and never the account holder, because there is nothing here for
   * them: somebody looking up their own account has their own employee id and
   * {@link signInPolicy.read}. What a lookup by address is for is HR answering
   * "who is a.mensah@ and can she sign in", and what it would be for otherwise
   * is confirming that an address is somebody's — which is the exact disclosure
   * {@link SignInService.signIn} refuses to make at the door.
   */
  search(actor: Actor): Decision {
    return holdsAny(actor, ...PROVIDES_LOGINS)
      ? about.allow(actor, 'search')
      : about.refuse(actor, 'search', null, 'holds no role that provides logins');
  },

  /**
   * Turning the one time code on or off for somebody. LMS 110.
   *
   * Yours, or HR's. Everybody may ask for a second factor on their own account —
   * that is what LMS 110 meant by the choice half of it — and turning one off is
   * refused by {@link CodeIsMandatory} where the roles say so, which is a
   * different refusal for a different reason and is not this one.
   */
  changeCodeSetting(actor: Actor, employeeId: string): Decision {
    if (isSelf(actor, employeeId)) {
      return about.allow(actor, 'changeCodeSetting', employeeId);
    }

    return holdsAny(actor, ...PROVIDES_LOGINS)
      ? about.allow(actor, 'changeCodeSetting', employeeId)
      : about.refuse(
          actor,
          'changeCodeSetting',
          employeeId,
          'not their own account, and holds no role that provides logins',
        );
  },
};
