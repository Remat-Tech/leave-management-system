/**
 * Who may ask for leave, who may see what somebody asked for, and who may end it. FR 10, FR 26, NFR SEC 02, §6, §10., LMS 301, LMS 306, LMS 313, FR 18, LMS 314, FR 38a, FR 04, FR 48, §8.6, LMS 319, FR 48b, FR 39, LMS 315.
 */

import { type ApproverRole, APPROVER_ROLES } from '../leave-type/approval-chain.js';
import { type DesksStaffed, staffsAnyDesk } from './approver-queue.js';
import { type DecidingAction, isADecision, type OverridingAction } from './leave-decision.js';
import { type RequestAction, type Standing, standingsFor } from './leave-request.js';
import { type Actor, holdsAny, isSelf } from '../../auth/actor.js';
import type { BalanceOwner } from '../balance/policy.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import { APPROVES_AS_HR, MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from '../role/roles.js';

const about = policyFor('leave request');

/** Everything a decision about a request is made from, beyond who is asking. §6, §10., LMS 314. */
export interface RequestAtADesk extends BalanceOwner {
  /** FR 38a. */
  awaiting: ApproverRole | null;
  /** FR 04. */
  chiefExecutiveId: string | null;
}

/** The facts a standing may be decided from, whether or not the caller has all of them. LMS 313. */
type StandingFacts = BalanceOwner & Partial<Pick<RequestAtADesk, 'awaiting' | 'chiefExecutiveId'>>;

/** Which roles satisfy each standing the transition table names. §6, §10., LMS 313. */
function hasStanding(actor: Actor, subject: StandingFacts, standing: Standing): boolean {
  switch (standing) {
    case 'THE_REQUESTER':
      return isSelf(actor, subject.employeeId);
    case 'THEIR_LINE_MANAGER':
      return isSelf(actor, subject.managerId);
    case 'LEAVE_ADMINISTRATION':
      return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS);
    case 'THE_DESK_IT_IS_WITH':
      /** The requester's exclusion used to be the other half of this line. LMS 319. */
      return isAt(actor, subject);
  }
}

/** Nobody decides their own request, whatever they hold. FR 48, §8.6, §10., LMS 319. */
function notTheirOwn(actor: Actor, owner: BalanceOwner, action: DecidingAction): Decision {
  const said = action.toLowerCase();

  return isSelf(actor, owner.employeeId)
    ? about.refuseOpenly(
        actor,
        said,
        owner.employeeId,
        'is the person who asked for the leave, and nobody decides their own request',
        DECIDING_IS_SOMEBODY_ELSE,
      )
    : about.allow(actor, said, owner.employeeId);
}

/**
 * Whether this actor is the person the chain's current desk resolves to. FR 38a, FR 48, LMS 314, FR 04.
 */
function isAt(actor: Actor, subject: StandingFacts): boolean {
  switch (subject.awaiting) {
    case 'MANAGER':
      return isSelf(actor, subject.managerId);
    case 'HR':
      return holdsAny(actor, ...APPROVES_AS_HR);
    case 'CEO':
      return isSelf(actor, subject.chiefExecutiveId ?? null);
    default:
      return false;
  }
}

/**
 * Which desks this person answers at, whosever request arrives. FR 38a, FR 40, FR 04, LMS 404.
 *
 * {@link isAt} asked the other way round: that one takes a request and answers *are you the
 * desk it is sitting on*, and a queue has no request in hand. Same three branches, so a desk
 * added to `APPROVER_ROLES` cannot be answered by one and forgotten by the other — the unit
 * suite walks every role and asserts the two agree.
 *
 * `MANAGER` is `actor.isManager` rather than a role, which is what {@link UnknownRole} says in
 * words. `CEO` takes the root's id because FR 04 makes it a reporting line rather than a role;
 * a null is nobody, as {@link isSelf} answers.
 */
export function desksStaffedBy(actor: Actor, chiefExecutiveId: string | null): DesksStaffed {
  const desks = APPROVER_ROLES.filter((desk) => {
    switch (desk) {
      case 'MANAGER':
        return actor.isManager;
      case 'HR':
        return holdsAny(actor, ...APPROVES_AS_HR);
      default:
        return isSelf(actor, chiefExecutiveId);
    }
  });

  return {
    desks,
    /* The manager's desk covers this person's own reports and nobody else's, so the queue's
       query needs their id beside the desk rather than the desk alone. Null where they are not
       a manager at all, so that a caller cannot narrow by somebody who manages nobody. */
    managerId: desks.includes('MANAGER') ? actor.employeeId : null,
  };
}

/** Whether this actor may make this move, decided against the table. §6., LMS 313. */
function mayMove(
  actor: Actor,
  subject: StandingFacts,
  action: RequestAction,
  words: { because: string; told: string },
): Decision {
  const said = action.toLowerCase();

  /** FR 48, §8.6a. */
  if (isADecision(action)) {
    const theirs = notTheirOwn(actor, subject, action);

    if (!theirs.allowed) {
      return theirs;
    }
  }

  return standingsFor(action).some((standing) => hasStanding(actor, subject, standing))
    ? about.allow(actor, said, subject.employeeId)
    : about.refuseOpenly(actor, said, subject.employeeId, words.because, words.told);
}

/** Said openly to everybody it refuses, including a line manager. */
const ASKING_IS_YOURS =
  'Leave is asked for by the person taking it, or entered by HR on their behalf where ' +
  'somebody was away and could not ask. A manager approves leave rather than ' +
  'requesting it. FR 18.';

/** Said openly, and to the only person it can ever be said to. FR 48, §8.6, LMS 319. */
const DECIDING_IS_SOMEBODY_ELSE =
  'Leave is decided by somebody other than the person taking it, whatever roles they hold ' +
  'and wherever the request is sitting. If you no longer want this leave, withdraw it; if ' +
  'it should not be on the books at all, HR cancels it. FR 48.';

export const leaveRequestPolicy = {
  resource: about.resource,

  /** Nobody decides their own request. FR 48, §8.6, LMS 319. */
  notTheirOwn,

  /** Asking for leave. FR 10. */
  submit(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId) || holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'submit', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'submit',
      owner.employeeId,
      'not their own leave, and holds no role that enters leave for somebody else',
      ASKING_IS_YOURS,
    );
  },

  /** Reading one person's requests, or one of them. */
  read(actor: Actor, owner: BalanceOwner): Decision {
    if (
      isSelf(actor, owner.employeeId) ||
      isSelf(actor, owner.managerId) ||
      holdsAny(actor, ...READS_EVERY_RECORD)
    ) {
      return about.allow(actor, 'read', owner.employeeId);
    }

    return about.refuse(
      actor,
      'read',
      owner.employeeId,
      'not their leave, not their line manager, and holds no role that reads everybody',
    );
  },

  /** Taking back leave you asked for. FR 26, FR 46, LMS 306, LMS 323, FR 18. */
  withdraw(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'WITHDRAW', {
      because: 'not their own leave, and holds no role that maintains leave for somebody else',
      told: ASKING_IS_YOURS,
    });
  },

  /**
   * Turning down leave at the desk it is sitting on. FR 26, FR 38a, FR 44, LMS 306, LMS 314, §4.3.1, LMS 319, LMS 318.
   */
  refuse(actor: Actor, subject: RequestAtADesk): Decision {
    return mayMove(actor, subject, 'REFUSE', {
      because: 'is not the approver this request is currently waiting on',
      told:
        'Leave is turned down by each desk in its type’s approval chain, in order, and ' +
        'this request is not waiting on you. A rejection at one stage sends the request ' +
        'on to the next rather than ending it, so it is the desk’s to make. Taking back ' +
        'your own request is withdrawing it. FR 38a, FR 44.',
    });
  },

  /** Unwinding a request that should not stand. FR 26, FR 37, LMS 306. */
  cancel(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'CANCEL', {
      because: 'holds no role that maintains leave for the company',
      told:
        'Cancelling a request is HR unwinding something that should not be on the ' +
        'books. Taking back your own leave is withdrawing it, and a manager who ' +
        'does not agree to it refuses it.',
    });
  },

  /**
   * Saying yes at the desk the chain has this request sitting on. FR 38, FR 38a, FR 40, LMS 314, §4.3.1, LMS 319, FR 48b.
   */
  approve(actor: Actor, subject: RequestAtADesk): Decision {
    return mayMove(actor, subject, 'APPROVE', {
      because: 'is not the approver this request is currently waiting on',
      told:
        'Leave is approved by each desk in its type’s approval chain, in order, and ' +
        'this request is not waiting on you. Most kinds of leave go to the line manager ' +
        'and then to HR; unpaid leave goes to HR and then to the Chief Executive. FR 38a.',
    });
  },

  /**
   * Overturning a line manager's decision, which is a decision at this desk like any other. FR 44, §7.2, LMS 318.
   */
  override(actor: Actor, action: OverridingAction, subject: RequestAtADesk): Decision {
    return mayMove(actor, subject, action, {
      because: 'is not the approver this request is currently waiting on',
      told:
        'A line manager’s decision is overturned by the next desk the request goes to, ' +
        'and this request is not waiting on you. It is the same standing as approving or ' +
        'refusing it — an override is an ordinary decision that happens to disagree with ' +
        'an earlier stage. FR 44.',
    });
  },

  /** Whichever of the four this is. FR 38a, FR 44, LMS 314, LMS 318. */
  decide(actor: Actor, action: DecidingAction, subject: RequestAtADesk): Decision {
    switch (action) {
      case 'APPROVE':
        return this.approve(actor, subject);
      case 'REFUSE':
        return this.refuse(actor, subject);
      default:
        return this.override(actor, action, subject);
    }
  },

  /**
   * Looking at everything waiting on you. FR 20, FR 40, FR 38a, LMS 404.
   *
   * The one decision here that names no subject: a queue is about which desks the asker staffs,
   * which {@link desksStaffedBy} answers from the actor alone.
   *
   * It is the whole of the disclosure gate, because the rows are defined by it — a desk this
   * person answers, `MANAGER` narrowed to their own reports. A per-row `read` on top would
   * refuse the one approver §4.3.1 names: FR 32h routes unpaid leave to the Chief Executive,
   * who is nobody's line manager and holds no role. Being the desk is its own reason to be
   * looking, which is the seam `LeaveRequestService.approve` argues.
   *
   * Refused openly, because whether somebody manages a report is a fact about themselves — and
   * refused rather than answered empty, because an empty queue and no queue are different news.
   */
  queue(actor: Actor, staffed: DesksStaffed): Decision {
    return staffsAnyDesk(staffed)
      ? about.allow(actor, 'queue', null)
      : about.refuseOpenly(
          actor,
          'queue',
          null,
          'has nobody reporting to them and staffs no approver desk',
          'An approver queue holds the requests waiting on you. Leave is approved by the ' +
            'line manager it was addressed to, by HR, or by the Chief Executive — so this ' +
            'screen belongs to somebody with a report, an HR role, or FR 04’s seat. Your own ' +
            'requests and what became of them are on your leave pages. FR 38a.',
        );
  },

  /**
   * Sending a request nobody could decide back into its chain. FR 48b, §8.6a, LMS 320.
   *
   * HR's, and deliberately not the requester's: what the alert asks for is a change to the
   * organisation, and somebody who could re-route their own stuck request would be deciding
   * when their own leave became decidable.
   */
  route(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'ROUTE', {
      because: 'holds no role that maintains leave for the company',
      told:
        'A request nobody could decide is put back into its chain by HR, once somebody is ' +
        'at the desk it stopped at. If you no longer want the leave, withdraw it. FR 48b.',
    });
  },

  /** Improving the reason on a request already submitted. FR 18. */
  reword(actor: Actor, owner: BalanceOwner): Decision {
    return isSelf(actor, owner.employeeId)
      ? about.allow(actor, 'reword', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'reword',
          owner.employeeId,
          'is not the person who asked for the leave',
          'The reason on a request is the account given by the person who asked for it, ' +
            'and it is what an approver decides on. Only they may change it.',
        );
  },
};
