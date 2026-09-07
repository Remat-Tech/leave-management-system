/**
 * Who may read somebody's notifications, and who may mark one read. FR 59, NFR SEC 02, §7.1, §10., LMS 329.
 */

import { type Actor, holdsAny, isSelf } from '../../auth/actor.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { READS_EVERY_RECORD } from '../role/roles.js';

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

  /**
   * Chasing an approver who has not decided, and reading which chases have gone. FR 50, LMS 330.
   *
   * The company's, not one person's: the daily run is `theSystem`, and HR is who asks about
   * it when somebody says nobody has answered them.
   */
  remind(actor: Actor): Decision {
    if (holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'remind');
    }

    return about.refuse(
      actor,
      'remind',
      null,
      'holds no role that chases the company’s outstanding approvals',
    );
  },

  /**
   * Draining the notices whose email did not send. FR 59, LMS 331.
   *
   * The company's post rather than one person's, so it is the same standing as the daily
   * chase: `theSystem` runs it, and HR runs it by hand when the mail server comes back.
   */
  resend(actor: Actor): Decision {
    if (holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'resend');
    }

    return about.refuse(
      actor,
      'resend',
      null,
      'holds no role that sends the company’s undelivered post',
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
