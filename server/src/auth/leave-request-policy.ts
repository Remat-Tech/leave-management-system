/**
 * Who may ask for leave, who may see what somebody asked for, and who may end it. FR 10, FR 26, NFR SEC 02, §6, §10., LMS 301, LMS 306, LMS 313, FR 18, LMS 314, FR 38a, FR 04, FR 48, §8.6, LMS 319, FR 48b, FR 39, LMS 315.
 */

import type { ApproverRole } from '../domain/approval-chain.js';
import { type DecidingAction, isADecision } from '../domain/leave-decision.js';
import { type RequestAction, type Standing, standingsFor } from '../domain/leave-request.js';
import { type Actor, holdsAny, isSelf } from './actor.js';
import type { BalanceOwner } from './ledger-policy.js';
import { type Decision, policyFor } from './policy.js';
import { APPROVES_AS_HR, MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from './roles.js';

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
   * Turning down leave somebody asked for. FR 26, FR 38a, LMS 306, LMS 212, LMS 314, §4.3.1, LMS 319.
   */
  refuse(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'REFUSE', {
      because: 'is not their line manager and holds no role that decides leave for the company',
      told:
        'Leave is turned down by the line manager it was addressed to, or by HR. Taking ' +
        'back your own request is withdrawing it. FR 38a.',
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
