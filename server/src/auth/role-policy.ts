/**
 * Who may grant a role, and who may see who holds one. NFR SEC 02. §5.3, §10.
 * LMS 112, enforcing LMS 111.
 *
 * LMS 111 built the whole of role assignment and said, at the top of
 * ../services/role-service.ts, that nothing there checked whether the caller may
 * assign roles and that "As an HR Administrator" was this story's to enforce.
 * This file is that sentence.
 *
 * It is the most consequential policy in the tree, because it is the one that
 * decides who may change the others. Everything else in this system is protected
 * by roles; the roles are protected by this.
 *
 * ## Three rules, and the reason for each
 *
 * **Granting and revoking is {@link ADMINISTERS_ACCESS}.** HR Administrators and
 * System Administrators. An HR Officer maintains records and does not decide who
 * has HR powers, which is the distinction between the two HR roles put to its
 * most important use.
 *
 * **The master key is handed on by somebody holding it.** Granting or revoking
 * SYS_ADMIN needs SYS_ADMIN. Otherwise the rule above would let an HR
 * Administrator make themselves a System Administrator, which is not
 * "administrators appoint administrators", it is "the lock can be picked from
 * the next room". The database already refuses the last one being removed —
 * user_role_keeps_a_system_administrator — and this is the other end of the same
 * concern: who the role may be *given* to.
 *
 * **Nobody changes their own roles.** Not granting, not revoking, whatever they
 * hold. This is the story's "so that" taken literally: powers are held because
 * somebody granted them, and a power somebody granted themselves is a power
 * nobody granted. It also costs an attacker a second account — a stolen HR
 * Administrator session cannot quietly become a System Administrator session —
 * and it costs a legitimate administrator nothing, because there is always
 * another one by the rule above.
 *
 * The bootstrap is not a problem, and it is worth showing why rather than
 * asserting it. The first System Administrator is not granted through this
 * policy at all: the seed and the migrations write user_role on the owner
 * connection, and {@link theSystem} — which is what a job or a fixture runs as —
 * has a null `employeeId`, so it can never be the self that this rule refuses.
 *
 * ## Reading
 *
 * "Who has HR powers and since when" is the review LMS 111 exists to make
 * possible, and it goes to the people who could act on the answer:
 * {@link ADMINISTERS_ACCESS}. Anybody may read **their own** roles, because a
 * person is entitled to know what the system thinks they are.
 *
 * The four roles themselves are reference data and open to anybody signed in.
 * They are four codes and four names, they are on the company handbook page that
 * explains who approves what, and a screen cannot render the sentence "you hold
 * HR Officer" without them.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { ADMINISTERS_ACCESS, type RoleCode } from './roles.js';

const about = policyFor('role');

/** Said openly. Anybody who reaches it knows perfectly well which roles they hold. */
const ASSIGNMENT_IS_ADMINISTRATIVE =
  'Roles are given and taken away by an HR Administrator or a System ' +
  'Administrator, and never by the person they are about. Ask one of them.';

/**
 * The rule that stops a grant being a self-service escalation.
 *
 * Written once and applied to both directions, because revoking your own role is
 * the same class of act as granting one: it is the only change to your own
 * powers that nobody else has agreed to, and the reason it is refused is that
 * "removed by mistake" and "removed on purpose so that a check would pass" look
 * identical afterwards.
 */
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

  /* The master key. Held by whoever already holds it, and by nobody else — see
     the note at the top of this file. Named in the message rather than refused
     silently, because an HR Administrator who has just been refused this needs
     to know that they were refused the *role* and not the person. */
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

  /**
   * What somebody holds, and what they may therefore do.
   *
   * Yourself, or an administrator. A line manager is deliberately not included:
   * they may see that somebody is one of their reports, which is what routing an
   * approval needs, and whether that person also holds HR_ADMIN is none of a
   * line manager's business.
   */
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

  /**
   * Everybody holding a role. "Who are the System Administrators", which is the
   * question somebody asks before taking a role away from anybody — and, for the
   * same reason, one that answers "who is worth attacking" for anybody else.
   */
  holders(actor: Actor, code: RoleCode): Decision {
    return holdsAny(actor, ...ADMINISTERS_ACCESS)
      ? about.allow(actor, 'holders', code)
      : about.refuse(actor, 'holders', code, 'holds no role that administers access');
  },

  /** The four roles. Reference data: four codes and four names, and nothing about anybody. */
  list(actor: Actor): Decision {
    return about.allow(actor, 'list');
  },
};
