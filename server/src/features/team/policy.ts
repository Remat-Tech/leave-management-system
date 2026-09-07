/** Who may look at a team of direct reports. FR 55, FR 56, NFR SEC 02, §10., LMS 405. */

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
};
