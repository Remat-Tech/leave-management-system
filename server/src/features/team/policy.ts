/** Who may look at a team. FR 55, FR 56, FR 57, NFR SEC 02, §10., LMS 405, LMS 406, LMS 409. */

import { type Actor, holdsAny } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { READS_EVERY_RECORD } from '../role/roles.js';

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
   * Looking at the calendar of the department you are in. FR 57, LMS 406, LMS 409.
   *
   * Names no subject: what may be seen of a colleague is decided by the projection, which
   * carries dates and names and can assemble nothing else. `department_id` is NOT NULL, so
   * this refuses nobody in practice — it is here so an empty query says what went wrong.
   */
  calendar(actor: Actor, size: number): Decision {
    return size > 0
      ? about.allow(actor, 'calendar', null)
      : about.refuseOpenly(
          actor,
          'calendar',
          null,
          'is in no department the calendar can be drawn for',
          'This calendar is the people in your department, and your record names no ' +
            'department with anybody in it. Ask an HR Administrator to check it. FR 57.',
        );
  },

  /**
   * Looking past your own department. FR 57, LMS 409.
   *
   * HR reads every record, so HR reads every department. Refused openly rather than as a 404:
   * which departments exist is no secret, and who is away inside one is.
   */
  everyDepartment(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'everyDepartment', null)
      : about.refuseOpenly(
          actor,
          'everyDepartment',
          null,
          'does not read every record',
          'This calendar shows the department you are in. Looking across departments is ' +
            'for HR. FR 57.',
        );
  },
};
