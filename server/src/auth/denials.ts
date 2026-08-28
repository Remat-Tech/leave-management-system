/**
 * Refused attempts, written down. NFR SEC 03. LMS 112.
 *
 * The story's third criterion, and the one that is worth the most on the day
 * something has actually gone wrong. An authorisation layer that refuses
 * silently protects the records and tells nobody that somebody went looking:
 * the colleague working through employee ids one at a time is refused four
 * hundred times and the first anybody hears of it is never.
 *
 * What is recorded is the attempt, and deliberately not the record.
 *
 *   The actor, as an id and a description. Who tried.
 *
 *   The roles they held. Which is how "she should have been able to do that" is
 *   settled without guessing at what her account looked like at the time.
 *
 *   The resource type, the action, and the id of the thing aimed at. What they
 *   tried to do, and to which record.
 *
 *   The reason the policy gave. Why it was refused, in the policy's own words —
 *   the sentence that is never shown to the person, because showing it is how a
 *   refusal turns into a description of the rule somebody is probing.
 *
 * **No field of the record appears here, ever.** Not the name, not the work
 * address, not the leave. A refused read is a read that did not happen, and a
 * log that quotes the record has performed the disclosure the refusal existed to
 * prevent — into a file that is usually less protected than the database and
 * routinely shipped somewhere else. The id is enough to find the row with, for
 * anybody who is allowed to.
 *
 * The actor's own id and roles *are* here, and that is the deliberate exception.
 * A record of a refusal that cannot say who was refused is not a record of
 * anything.
 *
 * ## Where it goes
 *
 * Behind an interface, exactly as ../mail and ../storage are, and for the same
 * reason: what this system does with a denial in development is not what it will
 * do in production, and nothing above this file should know which.
 *
 * The default writes one JSON line per denial to stderr. That is a stop-gap and
 * it is worth being plain about which parts of it are: the shape is right, the
 * destination is not. A log line is not queryable, is rotated away, and is not
 * an audit trail — NFR AUD 02 wants rows nobody can update or delete, which is
 * the append-only `audit_log` table of LMS 113. When that arrives, the driver
 * that writes to it replaces this one and nothing above changes.
 *
 * ## What it is not
 *
 * Not a rate limiter. Nothing here counts, throttles or locks anybody out. Four
 * hundred refusals in a minute are four hundred lines and no delay, and the
 * counter that ought to sit in front of the route is the same one unlimited
 * password guesses need — see the note at the top of ../services/sign-in-service.ts.
 * It needs doing, and it is not done.
 *
 * Not a record of what was allowed. Only refusals are here. "Who read whose
 * record" is a different and much larger question, it belongs in the audit log
 * rather than beside the refusals, and answering half of it here would produce a
 * file that looks like an access log and is not one.
 */

import type { RoleCode } from './roles.js';

/** One refused attempt, as it is written down. */
export interface DeniedAttempt {
  /** When it happened. The only handle anybody has when they come asking later. */
  at: Date;
  /** The actor, in words. See {@link Actor.description}. */
  actor: string;
  /** The employee behind it, or null for the system. */
  employeeId: string | null;
  /** What they held at the time, which is what settles "she should have been able to". */
  roles: readonly RoleCode[];
  /** Which kind of record: 'employee', 'department', 'role', … */
  resource: string;
  /** What was attempted: 'read', 'update', 'grant', … */
  action: string;
  /** The record aimed at, when the attempt named one. */
  subject: string | null;
  /** The policy's reason. Never shown to the person refused. */
  because: string;
}

/**
 * Somewhere to write refusals.
 *
 * `record` returns nothing and must not throw. A logging failure that turns into
 * an exception would convert a refusal into a server error, which is a way of
 * making the system less safe by trying to observe it — and worse, a way for
 * somebody who can break the log to change what the refusal looks like from
 * outside. A driver that cannot write does its own complaining.
 */
export interface DenialLog {
  record(attempt: DeniedAttempt): void;
}

/**
 * The default. One JSON line per denial, on stderr.
 *
 * JSON rather than prose because the thing anybody does with these is search
 * them — every attempt by one employee, every attempt at one record — and prose
 * has to be parsed back out with a regular expression that is wrong for the
 * fifth field.
 *
 * stderr rather than stdout so that a denial is not interleaved with whatever
 * the process is printing, and so it survives a pipe that only takes stdout.
 *
 * `console.error` rather than a logging library, because there is no logging
 * library in this tree yet and choosing one on behalf of the whole application
 * is not this story's decision to make. When one arrives, it is a driver here.
 */
export function denialsToStderr(): DenialLog {
  return {
    record(attempt) {
      console.error(
        JSON.stringify({
          event: 'authorisation.denied',
          at: attempt.at.toISOString(),
          actor: attempt.actor,
          employeeId: attempt.employeeId,
          roles: attempt.roles,
          resource: attempt.resource,
          action: attempt.action,
          subject: attempt.subject,
          because: attempt.because,
        }),
      );
    },
  };
}

/**
 * Nowhere.
 *
 * For the one caller that genuinely wants refusals thrown away: a screen asking
 * "should I offer this button" is not a denied attempt and must not fill the log
 * with the answer. {@link Guard.permits} is that caller, and it does not reach
 * the log at all — this exists for a process that wants no denial output for a
 * reason of its own, and it is deliberately awkward to reach for.
 */
export function denialsNowhere(): DenialLog {
  return { record() {} };
}
