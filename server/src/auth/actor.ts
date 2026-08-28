/**
 * Who is asking. NFR SEC 02. LMS 112.
 *
 * Every service method that reaches a record takes one of these as its first
 * argument. That is the whole mechanism of this story: the question "who is
 * this" cannot be forgotten, because a call that does not answer it does not
 * compile.
 *
 * An actor is not a session and not a token. It is the answer to three
 * questions, and nothing else:
 *
 *   Which employee is this? {@link Actor.employeeId}, which is what "my own
 *   record" means and the only thing that lets somebody read their own leave
 *   without holding a role.
 *
 *   What were they granted? {@link Authority.roles}, read from user_role at the
 *   moment they signed in.
 *
 *   What is true of them? {@link Authority.isManager}, derived from the
 *   reporting lines. Never granted, never stored, and never an entry in the role
 *   list — see {@link Authority} for the whole of that argument.
 *
 * It is {@link Authority} with a name attached, which is deliberate: LMS 111
 * wrote that shape saying it was what the authorisation layer would authorise
 * from, and this is that layer taking it at its word rather than inventing a
 * second one beside it.
 *
 * There is exactly one place a person's actor is minted — {@link
 * SignInService.signIn}, which has just proved who they are — and one place
 * anything else's is: {@link theSystem}, below, which is named so that it can be
 * grepped for. Nothing constructs an `Actor` object literal, and nothing should
 * start to.
 *
 * What is deliberately not here is a session, a cookie or a token. Those are the
 * route layer's, and there is no route layer; minting a signed token in this
 * file would be a security decision made in the wrong place and several stories
 * early. SESSION_SECRET is still in the environment, still unread, and the note
 * beside it in the README still says what it is waiting for. What this story
 * settles is what happens *after* a request has been identified, which is the
 * half that has to be right on the server whatever the interface does.
 */

import type { Authority, RoleCode } from './roles.js';

/**
 * Somebody, or something, making a request of a service.
 *
 * `employeeId` is null for {@link theSystem} and for nothing else. A null can
 * never match a record's owner or a record's manager, which is the property that
 * makes the null safe: the system passes every role check and no "this is mine"
 * check, so a system actor can never be mistaken for a person by a policy that
 * forgot to consider it.
 *
 * `description` is for the denial log and for nothing else. It is words rather
 * than an id because the person reading that log at nine on a Monday morning is
 * trying to work out what happened, and `0193b2c4-…` is not the beginning of an
 * answer. It deliberately holds no name and no email address — see
 * ./denials.ts, which explains why a log of refused attempts is a poor place to
 * accumulate staff details.
 */
export interface Actor extends Authority {
  /** The employee making the request, or null for {@link theSystem}. */
  employeeId: string | null;
  /** What to call this in the denial log. Never a name, never an address. */
  description: string;
}

/**
 * The actor for somebody who has just signed in.
 *
 * Called by {@link SignInService} at the moment the last factor is answered, and
 * nowhere else. Passing the authority in rather than reading it here keeps this
 * file free of a database, exactly as ./sign-in.ts and ./mfa.ts are free of one.
 *
 * The roles are a snapshot, taken at sign in. That is a real property and worth
 * saying rather than discovering: somebody whose HR_ADMIN role is revoked while
 * they are working keeps it until they sign in again. The alternative — reading
 * user_role on every authorisation decision — is a round trip per policy check
 * and would still be a snapshot, just a fresher one. Where freshness genuinely
 * matters the answer is to close the account, which {@link SignInService.close}
 * does and which the next request cannot survive.
 */
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
