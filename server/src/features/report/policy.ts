/** Who may read HR's reports. FR 63, NFR SEC 02, LMS 510. */

import { type Actor, holdsAny } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { READS_EVERY_RECORD } from '../role/roles.js';

const about = policyFor('report');

export const reportPolicy = {
  resource: about.resource,

  /** Every report reads the whole company, so it is the roles that read every record. */
  read(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'read', null)
      : about.refuseOpenly(
          actor,
          'read',
          null,
          'holds no role that reads every record',
          'Reports read the whole company’s leave at once, so they are HR’s. Your own leave ' +
            'is on your leave pages. FR 63.',
        );
  },
};
