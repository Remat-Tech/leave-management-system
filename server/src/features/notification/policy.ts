/**
 * Who may read somebody's notifications, and who may mark one read. FR 59, NFR SEC 02, §7.1, §10., LMS 329.
 */

import { type Actor, isSelf } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';

const about = policyFor('notification');

/** Whose post this is. */
export interface NoticeOwner {
  employeeId: string;
}

export const notificationPolicy = {
  resource: about.resource,

  /** Reading somebody's notifications, or one of them. */
  read(actor: Actor, owner: NoticeOwner): Decision {
    if (isSelf(actor, owner.employeeId)) {
      return about.allow(actor, 'read', owner.employeeId);
    }

    return about.refuse(
      actor,
      'read',
      owner.employeeId,
      'a notification is a message to one person, and this is not that person',
    );
  },

  /** Marking one read, or putting it back to unread. */
  markRead(actor: Actor, owner: NoticeOwner): Decision {
    if (isSelf(actor, owner.employeeId)) {
      return about.allow(actor, 'markRead', owner.employeeId);
    }

    return about.refuse(
      actor,
      'markRead',
      owner.employeeId,
      'only the person a notification was sent to can have read it',
    );
  },
};
