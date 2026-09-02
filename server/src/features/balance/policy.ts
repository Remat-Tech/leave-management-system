/**
 * Who may read and post to the balance ledger. FR 27, FR 37, NFR SEC 02, §10., LMS 210, FR 53, FR 55, FR 56, §10, LMS 212, FR 38a.
 */

import { type Actor, holdsAny, isSelf } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import {
  MAINTAINS_EMPLOYEE_RECORDS,
  READS_EVERY_RECORD,
  SETS_UP_THE_ORGANISATION,
} from '../role/roles.js';

const about = policyFor('ledger');

/** Whose balance this is, as the caller has established it. */
export interface BalanceOwner {
  employeeId: string;
  /** Their line manager, or null. */
  managerId: string | null;
}

/**
 * Said openly, because anybody who reaches it can already read the balance they are trying to adjust.
 */
const ADJUSTMENTS_ARE_ADMINISTRATORS =
  'A balance adjustment moves days with no request behind it and can never be ' +
  'removed afterwards, only compensated. It is an HR Administrator’s to post. ' +
  'FR 37.';

/** Said openly to everybody it refuses, including the person whose leave it is. */
const APPROVAL_IS_SOMEBODY_ELSE =
  'Approving leave turns days that were held into days that were taken, and it is ' +
  'the approver’s to do rather than the person taking the leave. FR 38a.';

export const ledgerPolicy = {
  resource: about.resource,

  /** Every movement in one balance. FR 53, FR 55, FR 56. */
  read(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId)) {
      return about.allow(actor, 'read', owner.employeeId);
    }
    if (isSelf(actor, owner.managerId)) {
      return about.allow(actor, 'read', owner.employeeId);
    }
    if (holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'read', owner.employeeId);
    }

    return about.refuse(
      actor,
      'read',
      owner.employeeId,
      'not their balance, not their line manager, and holds no role that reads everybody',
    );
  },

  /** Posting a manual adjustment, and therefore also a correction of an earlier entry. FR 37, §10.. */
  adjust(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'adjust', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'adjust',
          owner.employeeId,
          'holds no role that adjusts balances',
          ADJUSTMENTS_ARE_ADMINISTRATORS,
        );
  },

  /** Holding days for leave that has been asked for. FR 26, LMS 212, FR 18. */
  reserve(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId) || holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'reserve', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'reserve',
      owner.employeeId,
      'not their own balance, and holds no role that enters leave for somebody else',
      'Leave is asked for by the person taking it, or entered by HR on their behalf. ' + 'FR 18.',
    );
  },

  /**
   * Turning held days into taken days, which is what approval does. FR 26, §10, FR 38a, LMS 314, FR 32h, FR 04, §4.3.1.
   */
  commit(
    actor: Actor,
    owner: BalanceOwner,
    /** FR 04. */
    chiefExecutiveId: string | null = null,
  ): Decision {
    if (isSelf(actor, owner.employeeId)) {
      return about.refuseOpenly(
        actor,
        'commit',
        owner.employeeId,
        'is the person whose leave it is',
        APPROVAL_IS_SOMEBODY_ELSE,
      );
    }

    if (
      isSelf(actor, owner.managerId) ||
      isSelf(actor, chiefExecutiveId) ||
      holdsAny(actor, ...READS_EVERY_RECORD)
    ) {
      return about.allow(actor, 'commit', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'commit',
      owner.employeeId,
      'not their line manager, not an approver this leave is routed to, and holds no ' +
        'role that reads everybody',
      APPROVAL_IS_SOMEBODY_ELSE,
    );
  },

  /** Granting a year's entitlement. FR 30, LMS 214. */
  grant(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'grant', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'grant',
          owner.employeeId,
          'holds no role that grants a year of entitlement',
          'A year’s entitlement arrives from the rule that says what a leave type is ' +
            'worth, and applying it is the same desk that writes it — an HR ' +
            'Administrator’s. FR 30.',
        );
  },

  /** Recording something that happened, and the entitlement it brings. FR 32g, LMS 218. */
  grantForAnEvent(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? about.allow(actor, 'grantForAnEvent', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'grantForAnEvent',
          owner.employeeId,
          'holds no role that keeps employee records',
          'Entitlement that arrives with an event is granted when HR records the ' +
            'event. It is the desk that keeps the employee records, and the figure ' +
            'comes from the entitlement rule rather than from whoever enters it. ' +
            'FR 32g.',
        );
  },

  /** Lapsing an event grant that was not used in time. FR 32e, LMS 218. */
  lapse(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'lapse', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'lapse',
          owner.employeeId,
          'holds no role that lapses an unused grant',
          'Days lapse because a leave type says how long a grant is usable for, and ' +
            'applying that is the same desk that writes it — an HR Administrator’s. ' +
            'FR 32e.',
        );
  },

  /** Carrying last year's unused days into the new one. FR 36, LMS 217. */
  carryForward(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'carryForward', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'carryForward',
          owner.employeeId,
          'holds no role that carries a year forward',
          'Carrying unused days into a new year applies the rule that says whether a ' +
            'leave type carries at all, and applying it is the same desk that writes ' +
            'it — an HR Administrator’s. FR 36.',
        );
  },

  /** Checking every balance in the company against the ledger. §7.4, LMS 213. */
  reconcile(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'reconcile', null)
      : about.refuseOpenly(
          actor,
          'reconcile',
          null,
          'holds no role that reads every record',
          'Checking every balance against the ledger reads the whole company’s leave at ' +
            'once, so it is HR’s. Your own balance and its history are on your leave ' +
            'page. §7.4.',
        );
  },

  /** Giving held days back, when a request is withdrawn, refused or cancelled. */
  release(actor: Actor, owner: BalanceOwner): Decision {
    if (
      isSelf(actor, owner.employeeId) ||
      isSelf(actor, owner.managerId) ||
      holdsAny(actor, ...READS_EVERY_RECORD)
    ) {
      return about.allow(actor, 'release', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'release',
      owner.employeeId,
      'not their balance, not their line manager, and holds no role that reads everybody',
      'Held days are given back by the person who asked for the leave, by their line ' +
        'manager, or by HR.',
    );
  },
};
