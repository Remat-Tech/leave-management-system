/** Who may see how the organisation is set up, and who may change it. FR 48c, NFR SEC 02, §10., LMS 112, LMS 321. */

import { type Actor, holdsAny } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { SETS_UP_THE_ORGANISATION } from '../role/roles.js';

const about = policyFor('organisation');

/** Said openly, because there is nothing to disclose by saying it. */
const SETUP_IS_THE_ADMINISTRATORS =
  'Who the Chief Executive is decides where unpaid leave goes for everybody, so it is set ' +
  'by an HR Administrator rather than by anybody who can see it. Ask one. FR 48c.';

export const organisationPolicy = {
  resource: about.resource,

  /**
   * Reading the settings. FR 48c.
   *
   * Everybody signed in: the request form already tells the person asking that unpaid leave
   * goes to the Chief Executive, so the name behind that desk is not a disclosure.
   */
  read(actor: Actor): Decision {
    return about.allow(actor, 'read');
  },

  /**
   * Naming the Chief Executive. FR 48c, §4.3.1.
   *
   * `SETS_UP_THE_ORGANISATION`, narrower than `MAINTAINS_EMPLOYEE_RECORDS` on purpose: an HR
   * Officer edits people, and this edits where every unpaid request in the company is sent.
   */
  nameTheChiefExecutive(actor: Actor, employeeId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'name the chief executive', employeeId)
      : about.refuseOpenly(
          actor,
          'name the chief executive',
          employeeId,
          'holds no role that sets the organisation up',
          SETUP_IS_THE_ADMINISTRATORS,
        );
  },
};
