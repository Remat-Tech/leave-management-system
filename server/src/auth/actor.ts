/** Who is asking. NFR SEC 02, LMS 112, LMS 111. */

import type { Authority, RoleCode } from './roles.js';

/** Somebody, or something, making a request of a service. */
export interface Actor extends Authority {
  /** The employee making the request, or null for theSystem. */
  employeeId: string | null;
  /** What to call this in the denial log. */
  description: string;
}

/** The actor for somebody who has just signed in. */
export function signedInAs(employeeId: string, authority: Authority): Actor {
  return {
    employeeId,
    roles: [...authority.roles],
    isManager: authority.isManager,
    description: `employee ${employeeId}`,
  };
}

/**
 * Work that no person asked for.
 *
 * A scheduled job, a migration correcting data, a seed loading fixtures, a test
 * building the organisation it is about to make assertions on. All of those have
 * to write records and none of them has a person behind them, so refusing them
 * would mean either no jobs or a second, unguarded way into every service — and
 * the second way is the one that quietly becomes the way everything is done.
 *
 * So it exists, and three things are true of it on purpose.
 *
 * **It holds every role.** Not a flag that policies branch on: a branch in every
 * policy is a branch that one policy forgets, and the forgetting is silent. It
 * is an actor like any other, judged by the same rules as anybody else, and it
 * passes them because it holds the roles that pass them.
 *
 * **It is nobody.** `employeeId` is null, so it matches no record's owner and no
 * record's manager. It cannot be somebody's colleague by accident.
 *
 * **It says why it exists.** `purpose` is not decoration — it is what the denial
 * log prints, and it is the difference between "the system was refused" and "the
 * nightly reminder job was refused". Being made to write a sentence is also the
 * point: `theSystem('')` looks wrong in a diff in a way that a bare constant
 * never would.
 *
 * This is a back door with a name on it, and a name is what makes it reviewable.
 * `grep -rn theSystem server/src` is the list of everything in the application
 * that runs unattended, and it should stay short.
 */
export function theSystem(purpose: string): Actor {
  return {
    employeeId: null,
    roles: ['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'],
    isManager: false,
    description: `the system (${purpose})`,
  };
}

/** Whether the actor holds any of these roles. */
export function holdsAny(actor: Actor, ...codes: readonly RoleCode[]): boolean {
  return codes.some((code) => actor.roles.includes(code));
}

/**
 * Whether this record is the actor's own.
 *
 * Written as a function rather than as `actor.employeeId === id` at each call
 * site, because the comparison has one wrong answer that is easy to write by
 * accident: `null === null` is true, and two records with no owner are not the
 * same person. The system is nobody, and nobody owns nothing.
 */
export function isSelf(actor: Actor, employeeId: string | null): boolean {
  return actor.employeeId !== null && employeeId !== null && actor.employeeId === employeeId;
}
