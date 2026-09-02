/** Who may grant a role, and who may see who holds one. NFR SEC 02, §5.3, §10., LMS 112, LMS 111. */

import { type Actor, holdsAny, isSelf } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { ADMINISTERS_ACCESS, type RoleCode } from './roles.js';

const about = policyFor('role');

/** Said openly. */
const ASSIGNMENT_IS_ADMINISTRATIVE =
  'Roles are given and taken away by an HR Administrator or a System ' +
  'Administrator, and never by the person they are about. Ask one of them.';

/** The rule that stops a grant being a self-service escalation. */
function assignment(actor: Actor, action: string, employeeId: string, code: RoleCode): Decision {
  if (isSelf(actor, employeeId)) {
    return about.refuseOpenly(
      actor,
      action,
      employeeId,
      'nobody changes their own roles',
      'You cannot change your own roles. That is the point of them being granted: ' +
        'a power somebody gave themselves is a power nobody gave them. Ask another ' +
        'administrator.',
    );
  }

  if (!holdsAny(actor, ...ADMINISTERS_ACCESS)) {
    return about.refuseOpenly(
      actor,
      action,
      employeeId,
      'holds no role that administers access',
      ASSIGNMENT_IS_ADMINISTRATIVE,
    );
  }

  if (code === 'SYS_ADMIN' && !holdsAny(actor, 'SYS_ADMIN')) {
    return about.refuseOpenly(
      actor,
      action,
      employeeId,
      'SYS_ADMIN is granted and revoked only by a System Administrator',
      'Only a System Administrator can give or take away System Administrator. ' +
        'Ask one of the people who already hold it.',
    );
  }

  return about.allow(actor, action, employeeId);
}

export const rolePolicy = {
  resource: about.resource,

  grant(actor: Actor, employeeId: string, code: RoleCode): Decision {
    return assignment(actor, 'grant', employeeId, code);
  },

  revoke(actor: Actor, employeeId: string, code: RoleCode): Decision {
    return assignment(actor, 'revoke', employeeId, code);
  },

  /** What somebody holds, and what they may therefore do. */
  read(actor: Actor, employeeId: string): Decision {
    if (isSelf(actor, employeeId)) {
      return about.allow(actor, 'read', employeeId);
    }

    return holdsAny(actor, ...ADMINISTERS_ACCESS)
      ? about.allow(actor, 'read', employeeId)
      : about.refuse(
          actor,
          'read',
          employeeId,
          'not their own roles, and holds no role that administers access',
        );
  },

  /** Everybody holding a role. */
  holders(actor: Actor, code: RoleCode): Decision {
    return holdsAny(actor, ...ADMINISTERS_ACCESS)
      ? about.allow(actor, 'holders', code)
      : about.refuse(actor, 'holders', code, 'holds no role that administers access');
  },

  /** The four roles. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },
};
