/**
 * What a policy is, and what happens when one says no. NFR SEC 02 and NFR SEC
 * 03. Technical Design Document §10. LMS 112.
 *
 * The story is about where a rule lives. "My records protected on the server
 * rather than hidden in the interface" is not a request for a different
 * mechanism, it is a request that the mechanism be somewhere a web address
 * cannot go round — and the way an interface-shaped rule gets written is one
 * `if` at a time, in whichever handler needed it first, until nobody can say
 * what the rule is without reading eleven files.
 *
 * So there is one policy object per resource type, each of them a set of pure
 * functions from an {@link Actor} and a record to a {@link Decision}, and the
 * services are what call them. Three things follow, and they are the story's
 * three criteria:
 *
 *   **The rule is in one file per resource.** ./employee-policy.ts is the
 *   complete answer to "who may see an employee record", and it is readable in a
 *   minute by somebody who has never seen this system. That is the property that
 *   scattered `if` statements cannot have at any quantity of care.
 *
 *   **A route cannot be the place it is enforced.** The service refuses before
 *   it reads or writes anything, so a route that forgets to check has not opened
 *   a hole — and neither has a job, a test, an import, or next year's GraphQL
 *   layer. There is no second entrance to guard.
 *
 *   **A refusal is an event.** {@link Guard} writes every one of them down
 *   before throwing. See ./denials.ts.
 *
 * ## Decisions are values, not exceptions
 *
 * A policy never throws. It returns a {@link Decision}, which carries the answer
 * *and* everything the log needs to describe the attempt, and the {@link Guard}
 * is the only thing that turns a refusal into an exception.
 *
 * That separation buys the two things this layer actually needs. A screen can
 * ask whether to offer a button — {@link Guard.permits} — without provoking a
 * log entry for a click nobody made. And the rules can be tested exhaustively as
 * arithmetic, with no database, no service and no exception handling, which is
 * server/tests/unit/policy.test.ts and is where the real coverage of this story
 * lives.
 *
 * ## Two kinds of refusal
 *
 * This is the security design of the file and it is not incidental.
 *
 * A refusal aimed at somebody who **cannot see the record at all** says nothing.
 * One sentence, the same one for every resource and every action, and in
 * particular the same one a record that does not exist gets. That is the whole
 * of "a colleague cannot reach them by guessing a web address": guessing an id
 * and being told "you may not read employee 4471" has learned that employee 4471
 * is somebody, which is the disclosure the story exists to prevent. The
 * services are what make the second half of that true — see the `search`
 * decision each of them consults before reporting a record missing.
 *
 * A refusal aimed at somebody who **can see the record but may not do that to
 * it** says what the rule is. A line manager reading their report's record and
 * then trying to change it has already been shown the record; telling them
 * "employee records are changed by HR" discloses nothing they did not have, and
 * "no record you have access to matches that" would be a lie about a record they
 * are looking at.
 *
 * It is the same distinction ./sign-in.ts makes at the door — vague until
 * something has been proved, specific once it has — applied to records rather
 * than to credentials.
 */

import type { Actor } from './actor.js';
import { type DeniedAttempt, type DenialLog, denialsToStderr } from './denials.js';

/**
 * A policy's answer, and the whole of the attempt it answers.
 *
 * Self-describing on purpose. The {@link Guard} takes one of these and needs no
 * other argument to write a complete log entry, which means a service can never
 * enforce a decision while describing it as something else — there is no second
 * copy of "what was being attempted" for the two to disagree about.
 */
export interface Decision {
  readonly allowed: boolean;
  readonly actor: Actor;
  /** Which kind of record: 'employee', 'department', … */
  readonly resource: string;
  /** What was being attempted: 'read', 'terminate', 'grant', … */
  readonly action: string;
  /** The record aimed at, when the attempt named one. */
  readonly subject: string | null;
  /** The reason, for the log. Null when allowed. Never shown to anybody. */
  readonly because: string | null;
  /**
   * What the person is told, when saying it discloses nothing.
   *
   * Null is the generic message, which is what a refusal says when being more
   * specific would confirm that the record exists. See the note at the top of
   * this file.
   */
  readonly told: string | null;
}

/**
 * Every policy names the resource it is about.
 *
 * A structural type rather than a base class, because a policy is an object of
 * pure functions and the only thing they have in common is the noun. What each
 * one offers beyond that is its own — an employee record is terminated and a
 * department is closed, and pretending both are `delete` to satisfy a shared
 * interface would put the wrong word in the log.
 */
export interface ResourcePolicy {
  readonly resource: string;
}

/**
 * The three sentences a policy writes, bound to one resource name.
 *
 * Exists so that no policy spells its own resource name at every return — which
 * is the kind of thing that stays right until somebody copies a file — and so
 * that the choice between the two kinds of refusal is made by picking a function
 * rather than by remembering a flag.
 */
export function policyFor(resource: string) {
  return {
    resource,

    allow(actor: Actor, action: string, subject: string | null = null): Decision {
      return { allowed: true, actor, resource, action, subject, because: null, told: null };
    },

    /**
     * Refused, and the person is told nothing.
     *
     * The default, and the one to reach for whenever the actor could not have
     * seen the record in the first place.
     */
    refuse(actor: Actor, action: string, subject: string | null, because: string): Decision {
      return { allowed: false, actor, resource, action, subject, because, told: null };
    },

    /**
     * Refused, and the person is told which rule refused them.
     *
     * Only for an actor who can already see the record. `told` is read by
     * somebody who is doing their job and has hit a boundary, so it should say
     * where the boundary is and who to ask, not that they are forbidden.
     */
    refuseOpenly(
      actor: Actor,
      action: string,
      subject: string | null,
      because: string,
      told: string,
    ): Decision {
      return { allowed: false, actor, resource, action, subject, because, told };
    },
  };
}

/**
 * What a refusal says when saying more would disclose something.
 *
 * One sentence for every resource, every action and every actor, and — this is
 * the part that matters — the same sentence a record that is not there produces.
 * Two messages that differ are a way of asking the server whether a record
 * exists, which is the question the whole story is about not answering.
 *
 * It does say how to get the refusal looked at, and it says it in terms of the
 * time rather than of an incident number, because there is no incident number
 * and the log is searchable by time. Somebody who has genuinely been refused
 * something they need must have a way forward that is not "try a different id".
 */
export const NOT_AUTHORISED_MESSAGE =
  'No record you have access to matches that. If you think that is wrong, ask HR ' +
  'or IT and tell them roughly when you tried — the attempt is in the log.';

/**
 * A refused attempt, as an exception.
 *
 * Thrown by {@link Guard.enforce} and by nothing else, so that every refusal in
 * the system has been through the log on its way out.
 *
 * `attempt` is carried for the same reason {@link SignInRefused.reason} is: the
 * accurate account of what happened has to travel with the vague message, or
 * there is no way to have both. **Nothing that reaches a screen may read it and
 * turn it back into a message.** The moment something downstream is more
 * specific than this class is, the vagueness has bought nothing.
 */
export class NotAuthorised extends Error {
  readonly attempt: DeniedAttempt;

  constructor(attempt: DeniedAttempt, told: string | null) {
    super(told ?? NOT_AUTHORISED_MESSAGE);
    this.name = 'NotAuthorised';
    this.attempt = attempt;
  }
}

/**
 * The thing that turns a decision into a refusal, and writes it down on the way.
 *
 * One per application, given to every service at construction. It holds the
 * denial log and nothing else — no rules, no roles, no knowledge of any
 * particular resource — so that changing where refusals are recorded is a change
 * to one constructor argument rather than to every policy.
 *
 * It is required rather than defaulted in the services on purpose. A service
 * that can be built without a guard is a service somebody builds without a
 * guard, and the failure is silent: everything works, nothing is refused, and
 * nothing is logged.
 */
export class Guard {
  constructor(private readonly denials: DenialLog = denialsToStderr()) {}

  /**
   * Lets an allowed decision through and refuses a denied one, having recorded
   * it. NFR SEC 03.
   *
   * The log is written before the throw rather than in a catch somewhere above,
   * because a catch somewhere above is a catch that one caller does not have.
   * There is exactly one path out of a refusal and it goes through here.
   */
  enforce(decision: Decision): void {
    if (decision.allowed) {
      return;
    }

    const attempt: DeniedAttempt = {
      at: new Date(),
      actor: decision.actor.description,
      employeeId: decision.actor.employeeId,
      roles: [...decision.actor.roles],
      resource: decision.resource,
      action: decision.action,
      subject: decision.subject,
      // Null cannot occur — refuse() and refuseOpenly() both require a reason —
      // but a refusal with no reason in the log would be worse than a clumsy
      // one, so it is answered rather than assumed.
      because: decision.because ?? 'no reason was given',
    };

    this.denials.record(attempt);

    throw new NotAuthorised(attempt, decision.told);
  }

  /**
   * The same question without the refusal, and without the log.
   *
   * For a screen deciding what to offer: whether to draw the "close this
   * department" button at all, rather than drawing it and refusing the click.
   *
   * Deliberately silent. A button that was never offered is not an attempt
   * anybody made, and recording it would fill the denial log with the ordinary
   * business of rendering a page — which is how a log that matters becomes a log
   * nobody reads. The refusals worth writing down are the ones somebody had to
   * go round the interface to provoke, and those come through
   * {@link Guard.enforce} whatever a screen decided to draw.
   */
  permits(decision: Decision): boolean {
    return decision.allowed;
  }
}
