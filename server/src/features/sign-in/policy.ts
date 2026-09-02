/**
 * Who may give somebody a login, take one away, and see one. NFR SEC 01, NFR SEC 02, §10., LMS 112, LMS 109, LMS 110.
 */

import { type Actor, holdsAny, isSelf } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { ADMINISTERS_ACCESS, PROVIDES_LOGINS } from '../role/roles.js';

const about = policyFor('sign in account');

/** Said openly. */
const SETTING_UP_IS_HRS =
  'Logins are created and passwords reset by HR. Ask them — they can do it from ' +
  'the same screen as your employee record.';

const CLOSING_IS_ADMINISTRATIVE =
  'Closing and reopening a login is an HR Administrator or a System ' +
  'Administrator, because it is a decision about somebody rather than part of ' +
  'joining or leaving. Ask one of them.';

/** Setting a joiner up, and resetting a password for somebody locked out. */
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

/** The administrative lock, and undoing it. */
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

  /** Giving somebody a login. LMS 109. */
  provision(actor: Actor, employeeId: string): Decision {
    return settingUp(actor, 'provision', employeeId);
  },

  /** Setting or resetting one. */
  setPassword(actor: Actor, employeeId: string): Decision {
    return settingUp(actor, 'setPassword', employeeId);
  },

  /** Shutting a login for a reason of its own. */
  close(actor: Actor, employeeId: string): Decision {
    return lock(actor, 'close', employeeId);
  },

  reopen(actor: Actor, employeeId: string): Decision {
    return lock(actor, 'reopen', employeeId);
  },

  /** Somebody's account, and whether they will be asked for a code. */
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

  /** Finding an account by the address on it. */
  search(actor: Actor): Decision {
    return holdsAny(actor, ...PROVIDES_LOGINS)
      ? about.allow(actor, 'search')
      : about.refuse(actor, 'search', null, 'holds no role that provides logins');
  },

  /** Turning the one time code on or off for somebody. LMS 110. */
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
