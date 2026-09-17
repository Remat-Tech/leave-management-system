/**
 * Which HR sections a signed-in person may reach.
 *
 * The page asks; the server answers. Each entry names the decision that screen already
 * turns on rather than restating its rule, so a policy that changes takes the section
 * with it and no role is named here. `/me` still carries no roles: this says what may be
 * reached, not what somebody holds, and the screens are refused by the same policies
 * whether or not a tab was drawn.
 */

import type { Actor } from '../../auth/actor.js';
import type { Decision, Guard } from '../../auth/policy.js';
import type { DesksStaffed } from '../leave-request/approver-queue.js';
import { leaveRequestPolicy } from '../leave-request/policy.js';
import { auditPolicy } from '../audit/policy.js';
import { ledgerPolicy } from '../balance/policy.js';
import { employeePolicy } from '../employee/policy.js';
import { entitlementRulePolicy } from '../entitlement/policy.js';
import { holidayPolicy } from '../holiday/policy.js';
import { leaveTypePolicy } from '../leave-type/policy.js';
import { notificationPolicy } from '../notification/policy.js';
import { organisationPolicy } from '../organisation/policy.js';
import { reportPolicy } from '../report/policy.js';

/** A subject is a label on a decision; `permits` reads only whether it was allowed. */
const ANY = 'any';

export interface Section {
  id: string;
  may: (actor: Actor) => Decision;
}

export const HR_SECTIONS: Section[] = [
  { id: 'leave-types', may: (actor) => leaveTypePolicy.create(actor) },
  { id: 'entitlements', may: (actor) => entitlementRulePolicy.list(actor) },
  { id: 'approval-chains', may: (actor) => leaveTypePolicy.setApprovalChain(actor, ANY) },
  { id: 'holidays', may: (actor) => holidayPolicy.create(actor) },
  {
    id: 'adjustments',
    // Who may adjust is the same answer for every balance, so the owner is this actor.
    may: (actor) =>
      ledgerPolicy.adjust(actor, { employeeId: actor.employeeId ?? ANY, managerId: null }),
  },
  {
    id: 'leave-events',
    may: (actor) =>
      ledgerPolicy.grantForAnEvent(actor, { employeeId: actor.employeeId ?? ANY, managerId: null }),
  },
  { id: 'leavers', may: (actor) => employeePolicy.list(actor) },
  { id: 'policy', may: (actor) => organisationPolicy.changePolicy(actor) },
  { id: 'email-wording', may: (actor) => notificationPolicy.readWording(actor) },
  { id: 'reports', may: (actor) => reportPolicy.read(actor) },
  { id: 'audit', may: (actor) => auditPolicy.search(actor) },
];

/**
 * "Waiting on me", which is a desk rather than a role. FR 40.
 *
 * Not in the list above because it cannot be answered from the actor alone: who staffs a desk
 * turns on a reporting line, an HR role, FR 04's seat and any delegation running this morning.
 * The desks are read, then `leaveRequestPolicy.queue` — the queue screen's own decision — says
 * whether there is one. A tab nobody could have a row in is a tab that only ever refuses.
 */
const APPROVALS = 'approvals';

/** Everybody's leave, the Chief Executive's page. */
const ALL_LEAVE = 'all-leave';

/** In the order here, so the page never decides what comes first either. */
export function sectionsFor(actor: Actor, guard: Guard, staffed: DesksStaffed): string[] {
  const queue = guard.permits(leaveRequestPolicy.queue(actor, staffed)) ? [APPROVALS] : [];
  const everyone = guard.permits(leaveRequestPolicy.listEveryone(actor)) ? [ALL_LEAVE] : [];

  return [
    ...queue,
    ...everyone,
    ...HR_SECTIONS.filter((section) => guard.permits(section.may(actor))).map(
      (section) => section.id,
    ),
  ];
}
