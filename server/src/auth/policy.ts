/** What a policy is, and what happens when one says no. NFR SEC 02, NFR SEC 03, §10., LMS 112. */

import type { Actor } from './actor.js';
import { type DeniedAttempt, type DenialLog, denialsToStderr } from './denials.js';

/** A policy's answer, and the whole of the attempt it answers. */
export interface Decision {
  readonly allowed: boolean;
  readonly actor: Actor;
  /** Which kind of record: 'employee', 'department', … */
  readonly resource: string;
  /** What was being attempted: 'read', 'terminate', 'grant', … */
  readonly action: string;
  /** The record aimed at, when the attempt named one. */
  readonly subject: string | null;
  /** The reason, for the log. */
  readonly because: string | null;
  /** What the person is told, when saying it discloses nothing. */
  readonly told: string | null;
}

/** Every policy names the resource it is about. */
export interface ResourcePolicy {
  readonly resource: string;
}

/** The three sentences a policy writes, bound to one resource name. */
export function policyFor(resource: string) {
  return {
    resource,

    allow(actor: Actor, action: string, subject: string | null = null): Decision {
      return { allowed: true, actor, resource, action, subject, because: null, told: null };
    },

    /** Refused, and the person is told nothing. */
    refuse(actor: Actor, action: string, subject: string | null, because: string): Decision {
      return { allowed: false, actor, resource, action, subject, because, told: null };
    },

    /** Refused, and the person is told which rule refused them. */
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

/** What a refusal says when saying more would disclose something. */
export const NOT_AUTHORISED_MESSAGE =
  'No record you have access to matches that. If you think that is wrong, ask HR ' +
  'or IT and tell them roughly when you tried — the attempt is in the log.';

/** A refused attempt, as an exception. */
export class NotAuthorised extends Error {
  readonly attempt: DeniedAttempt;

  constructor(attempt: DeniedAttempt, told: string | null) {
    super(told ?? NOT_AUTHORISED_MESSAGE);
    this.name = 'NotAuthorised';
    this.attempt = attempt;
  }
}

/** The thing that turns a decision into a refusal, and writes it down on the way. */
export class Guard {
  constructor(private readonly denials: DenialLog = denialsToStderr()) {}

  /** Lets an allowed decision through and refuses a denied one, having recorded it. NFR SEC 03. */
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

  /** The same question without the refusal, and without the log. */
  permits(decision: Decision): boolean {
    return decision.allowed;
  }
}
