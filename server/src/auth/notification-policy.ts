/**
 * Who may read somebody's notifications, and who may mark one read. FR 59, NFR SEC 02.
 * §7.1, §10. LMS 329.
 *
 * The narrowest policy in this system, and the only one whose answer is a single
 * comparison in every direction. **A notice is yours and nobody else's.** Not your line
 * manager's, not HR's, not an administrator's.
 *
 * That is a deliberate break from every other policy about leave, so it is worth being
 * exact about why rather than leaving it to look like an oversight.
 *
 * ## A notice is a message, not a record
 *
 * Everything else in this feature's neighbourhood is a *record about* somebody, and
 * `ledgerPolicy.read`'s three standings follow from that: your balance, your report's, or
 * everybody's if a role says so. A balance is a fact your manager has business knowing. So
 * is a request, so is the decision that turned it down — see
 * `leaveRequestPolicy.decisionsFor`, which is decided by exactly the rule that decides who
 * may see the request itself, "because a decision is the explanation of a status".
 *
 * A notification is not one of those. It is a message that was *sent to a person*, and it
 * carries a fact nothing else in this schema carries: **whether they have read it.** There
 * is no version of "my line manager may see which of my messages I have opened" that is
 * about leave administration. It is about surveillance, and it arrives by accident the
 * moment this policy is written as a copy of the one next door.
 *
 * The check on that reasoning is what a wider rule would actually buy. HR settling a
 * dispute about whether somebody was told their leave was refused wants to know **that a
 * notice was sent, and when** — which is a fact about the request and reads perfectly well
 * off `notification` joined to it, with no policy here involved, the day somebody builds
 * that screen. What they do not need is the person's inbox.
 *
 * ## Which is why there is no HR role on any of these
 *
 * `READS_EVERY_RECORD` — HR_OFFICER and HR_ADMIN — is on `ledgerPolicy.read`,
 * `leaveRequestPolicy.read`, `employeePolicy.read` and every other reading decision in
 * `/auth`. It is on none of these, and this file names it nowhere. A role that reads every
 * record is exactly right for records; these are not records of the company's, they are
 * somebody's post.
 *
 * **The system is not admitted either**, and that is the one refusal here worth reading
 * twice. {@link theSystem} holds every role and is nobody — `employeeId` is null — so it
 * fails `isSelf` and is refused by every decision in this file. That is correct rather than
 * awkward: nothing unattended has any business reading a person's messages. Writing them is
 * a different act with no policy on it at all, and ../services/notification-service.ts
 * argues that separately.
 *
 * ## Marking one read is the same rule as reading it
 *
 * Deliberately not narrower and deliberately not wider. Only the person can read a notice,
 * so only the person can have read it, and a second rule would be a second answer to a
 * question with one.
 *
 * ## The refusals say nothing
 *
 * All of them use the silent form — ./policy.ts's default. Somebody asking after another
 * person's notifications has not been shown that those notifications exist, and a refusal
 * that named the rule would confirm that an id belongs to a colleague with post in it. It
 * is the same reading `leaveRequestPolicy.read` makes and the reasoning is stronger here,
 * because the id in the request is a *notice* id: a stranger who guessed one and was told
 * "you may only read your own" would have learned that the notice is somebody's.
 */

import { type Actor, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';

const about = policyFor('notification');

/**
 * Whose post this is.
 *
 * One id, where every other policy in this neighbourhood takes a {@link BalanceOwner} with
 * a manager on it. The manager is absent because no decision here consults one, and a field
 * nothing reads is an invitation for somebody to start reading it — which in this file
 * would be the exact widening the module note argues against.
 */
export interface NoticeOwner {
  employeeId: string;
}

export const notificationPolicy = {
  resource: about.resource,

  /**
   * Reading somebody's notifications, or one of them.
   *
   * Theirs alone. See the module note for why no role and no reporting line is on this.
   *
   * Refused silently, which is the default of ./policy.ts and is what keeps a guessed id
   * from confirming that somebody has post.
   */
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
   * Marking one read, or putting it back to unread.
   *
   * The same rule as {@link notificationPolicy.read} and asked as its own decision, so the
   * denial log says which of the two somebody was attempting. A log that recorded a write
   * as a read would be the one place a refusal is described as something else, which is
   * precisely what {@link Decision} being self-describing exists to prevent.
   */
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
