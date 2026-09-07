/** Who may look at a team. FR 55, FR 56, FR 57, NFR SEC 02, §10., LMS 405, LMS 406. */

import type { Actor } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';

const about = policyFor('team');

export const teamPolicy = {
  resource: about.resource,

  /**
   * Looking at your own direct reports. FR 55, FR 56, LMS 405.
   *
   * Names no subject, as `leaveRequestPolicy.queue` names none: the rows are whoever reports
   * to the reader, so this decides only whether there is a team at all. Each row is still
   * bound by `ledgerPolicy.read`, which is where "direct reports only" is actually written.
   *
   * Refused openly, because whether somebody has a report is a fact about themselves.
   */
  read(actor: Actor, reports: number): Decision {
    return reports > 0
      ? about.allow(actor, 'read', null)
      : about.refuseOpenly(
          actor,
          'read',
          null,
          'has nobody reporting to them',
          'This screen holds the balances and booked leave of the people who report to ' +
            'you, and nobody reports to you. Your own leave is on your leave pages. FR 55.',
        );
  },

  /**
   * Looking at the calendar of the team you are on. FR 57, LMS 406.
   *
   * Names no subject either, and for the same reason. The rows are the people who share the
   * reader's line manager, so this decides only whether the reader is on a team at all — and
   * what may be *seen* of a colleague is not decided here but in the projection, which carries
   * dates and names and can assemble nothing else.
   *
   * Refused openly, because whether somebody reports to anybody is a fact about themselves.
   */
  calendar(actor: Actor, size: number): Decision {
    return size > 0
      ? about.allow(actor, 'calendar', null)
      : about.refuseOpenly(
          actor,
          'calendar',
          null,
          'is not recorded as reporting to anybody',
          'This calendar is the people you share a line manager with, and you are not ' +
            'recorded as reporting to anybody. FR 57.',
        );
  },
};
