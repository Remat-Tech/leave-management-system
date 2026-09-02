/** Refused attempts, written down. NFR SEC 03, LMS 112, NFR AUD 02, LMS 113. */

import type { RoleCode } from './roles.js';

/** One refused attempt, as it is written down. */
export interface DeniedAttempt {
  /** When it happened. */
  at: Date;
  /** The actor, in words. */
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
  /** The policy's reason. */
  because: string;
}

/** Somewhere to write refusals. */
export interface DenialLog {
  record(attempt: DeniedAttempt): void;
}

/** The default. */
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

/** Nowhere. */
export function denialsNowhere(): DenialLog {
  return { record() {} };
}
