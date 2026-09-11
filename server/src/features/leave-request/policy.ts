/**
 * Who may ask for leave, who may see what somebody asked for, and who may end it. FR 10, FR 26, NFR SEC 02, §6, §10., LMS 301, LMS 306, LMS 313, FR 18, LMS 314, FR 38a, FR 04, FR 48, §8.6, LMS 319, FR 48b, FR 39, LMS 315, FR 19, LMS 302.
 */

import { type ApproverRole, APPROVER_ROLES } from '../leave-type/approval-chain.js';
import { type DesksStaffed, staffsAnyDesk } from './approver-queue.js';
import {
  type DelegatedApprover,
  type DelegatedDesks,
  delegationsThatBearOn,
} from './delegation.js';
import { type DecidingAction, isADecision, type OverridingAction } from './leave-decision.js';
import { type RequestAction, type Standing, standingsFor } from './leave-request.js';
import { type DeskDecision, decidedBy } from './routing.js';
import { isAnAnswer, type WithdrawalAnswer } from './withdrawal.js';
import { type Actor, holdsAny, isSelf } from '../../auth/actor.js';
import type { BalanceOwner } from '../balance/policy.js';
import { type Decision, policyFor } from '../../auth/policy.js';
import {
  APPROVES_AS_HR,
  type Authority,
  MAINTAINS_EMPLOYEE_RECORDS,
  READS_EVERY_RECORD,
} from '../role/roles.js';

const about = policyFor('leave request');

/** FR 49, LMS 327. */
const aboutDelegation = policyFor('approval delegation');

/** Everything a decision about a request is made from, beyond who is asking. §6, §10., LMS 314. */
export interface RequestAtADesk extends BalanceOwner {
  /** FR 38a. */
  awaiting: ApproverRole | null;
  /** FR 48c. */
  chiefExecutiveId: string | null;
  /**
   * FR 49. What colleagues have handed to whoever is asking, in force today. LMS 327.
   *
   * The one field here that is about the asker rather than the request: which desks a
   * delegation reaches is a question about the delegator's roles and reporting line, and
   * only the caller can read those.
   */
  standingIn: readonly DelegatedDesks[];
}

/** The facts a standing may be decided from, whether or not the caller has all of them. LMS 313. */
type StandingFacts = BalanceOwner &
  Partial<Pick<RequestAtADesk, 'awaiting' | 'chiefExecutiveId' | 'standingIn'>>;

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

/**
 * Nobody decides their own request, whatever they hold. FR 48, §8.6, §10., LMS 319, LMS 324.
 *
 * Widened past the four deciding verbs by LMS 324: HR answering their own ask would be
 * putting their own days back on their own say-so.
 */
function notTheirOwn(actor: Actor, owner: BalanceOwner, action: RequestAction): Decision {
  const said = action.toLowerCase();

  return isSelf(actor, owner.employeeId)
    ? about.refuseOpenly(
        actor,
        said,
        owner.employeeId,
        'is the person who asked for the leave, and nobody decides their own request',
        isAnAnswer(action) ? ANSWERING_IS_SOMEBODY_ELSE : DECIDING_IS_SOMEBODY_ELSE,
      )
    : about.allow(actor, said, owner.employeeId);
}

/**
 * Two stages are answered by two people. FR 48d, §8.6a, LMS 322.
 *
 * The half of FR 48d routing cannot do: a desk with a second officer is asked as usual, and
 * the officer who signed the earlier stage is refused there. An actor no decision names is
 * nobody — `theSystem` — and two of its decisions are not one person's.
 */
function eachStageADifferentPerson(
  actor: Actor,
  owner: BalanceOwner,
  action: RequestAction,
  decided: readonly DeskDecision[],
): Decision {
  const said = action.toLowerCase();

  return actor.employeeId !== null && decidedBy(decided, actor.employeeId)
    ? about.refuseOpenly(
        actor,
        said,
        owner.employeeId,
        'has already decided this request at an earlier stage',
        A_SECOND_STAGE_IS_SOMEBODY_ELSE,
      )
    : about.allow(actor, said, owner.employeeId);
}

/**
 * Whether this actor answers at the desk the request is sitting on. FR 38a, FR 48, FR 48c, FR 49, LMS 314, LMS 321, LMS 327.
 *
 * In their own right, or for a colleague who handed their approvals over.
 */
function isAt(actor: Actor, subject: StandingFacts): boolean {
  return isThereThemselves(actor, subject) || whoTheyAnswerFor(subject) !== null;
}

/** The same, without the delegations: this actor is the desk. FR 38a, FR 48c, LMS 314, LMS 321. */
function isThereThemselves(actor: Actor, subject: StandingFacts): boolean {
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
 * The colleague whose approvals this desk is being answered for, or null. FR 49, FR 52, LMS 327.
 *
 * `MANAGER` is narrowed to the requester's own line, because that desk is a relationship: a
 * delegate of one manager has no standing over another manager's reports. And a delegation
 * never carries a say over the delegator's own leave — {@link delegationsThatBearOn}, asked
 * again here because this is the answer that binds whoever assembled the facts. FR 48.
 */
function whoTheyAnswerFor(subject: StandingFacts): string | null {
  const desk = subject.awaiting;

  if (desk === null || desk === undefined) {
    return null;
  }

  const bearing = delegationsThatBearOn(subject.standingIn ?? [], subject.employeeId);

  return (
    bearing.find(
      (one) =>
        one.desks.includes(desk) && (desk !== 'MANAGER' || one.approverId === subject.managerId),
    )?.approverId ?? null
  );
}

/**
 * Whose approvals a decision at this desk answers, or null where the decider's own. FR 49, FR 52, LMS 327.
 *
 * What `leave_request_decision.delegated_for_employee_id` is written from. The desk is passed
 * rather than read off the request, because the one that binds is the desk the walk found
 * inside the lock.
 */
export function answeredOnBehalfOf(
  actor: Actor,
  desk: ApproverRole,
  subject: RequestAtADesk,
): string | null {
  const atThisDesk = { ...subject, awaiting: desk };

  return isThereThemselves(actor, atThisDesk) ? null : whoTheyAnswerFor(atThisDesk);
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
 * words. `CEO` takes the configured id because FR 48c makes it a setting rather than a role or
 * a reporting line; a null is nobody, as {@link isSelf} answers.
 */
export function desksStaffedBy(
  actor: Actor,
  chiefExecutiveId: string | null,
  /** FR 49. What colleagues have handed over to them, in force today. LMS 327. */
  delegated: readonly DelegatedApprover[] = [],
): DesksStaffed {
  const own = desksOf(actor.employeeId, actor, chiefExecutiveId);

  /* Read through the same function, so a delegate's desks are whatever their delegator's
     roles and reporting line say — never a copy taken when the nomination was written. */
  const handed = delegated
    .map((one) => ({
      approverId: one.approverId,
      desks: desksOf(one.approverId, one, chiefExecutiveId),
    }))
    .filter((one) => one.desks.length > 0);

  return {
    desks: APPROVER_ROLES.filter(
      (desk) => own.includes(desk) || handed.some((one) => one.desks.includes(desk)),
    ),
    own,
    /* The manager's desk covers one person's own reports and nobody else's, so the queue's
       query needs the ids beside the desk rather than the desk alone. Empty where nobody
       whose desks these are manages anybody, so a caller cannot narrow by nothing. */
    managerIds: [
      ...(own.includes('MANAGER') && actor.employeeId !== null ? [actor.employeeId] : []),
      ...handed.filter((one) => one.desks.includes('MANAGER')).map((one) => one.approverId),
    ],
    delegated: handed,
  };
}

/**
 * Whether this actor answers any desk of this request for a colleague. FR 49, LMS 327.
 *
 * What the ledger door is widened by. It is asked before the walk has settled which desk
 * binds, so it asks about every desk rather than one: standing to move this balance at all
 * is a weaker question than standing to answer the stage it is sitting on, and
 * {@link leaveRequestPolicy.decide} asks that one inside the lock.
 */
export function standsInForAnApprover(subject: RequestAtADesk): boolean {
  return APPROVER_ROLES.some((desk) => whoTheyAnswerFor({ ...subject, awaiting: desk }) !== null);
}

/**
 * The desks colleagues have handed to this actor, as {@link RequestAtADesk.standingIn}. FR 49, LMS 327.
 *
 * {@link desksStaffedBy}'s delegated half, so the queue and the decide door work a delegate's
 * desks out the same way.
 */
export function desksHandedTo(
  actor: Actor,
  chiefExecutiveId: string | null,
  delegated: readonly DelegatedApprover[],
): readonly DelegatedDesks[] {
  return desksStaffedBy(actor, chiefExecutiveId, delegated).delegated;
}

/** One person's desks, from what they hold and who they are. FR 38a, FR 04, FR 48c. */
function desksOf(
  employeeId: string | null,
  authority: Authority,
  chiefExecutiveId: string | null,
): ApproverRole[] {
  return APPROVER_ROLES.filter((desk) => {
    switch (desk) {
      case 'MANAGER':
        return authority.isManager;
      case 'HR':
        return holdsAny(authority, ...APPROVES_AS_HR);
      default:
        return employeeId !== null && employeeId === chiefExecutiveId;
    }
  });
}

/** Whether this actor may make this move, decided against the table. §6., LMS 313. */
function mayMove(
  actor: Actor,
  subject: StandingFacts,
  action: RequestAction,
  words: { because: string; told: string },
): Decision {
  const said = action.toLowerCase();

  /** FR 48, §8.6a, FR 47. And an answer to a withdrawal is a decision too, since LMS 324. */
  if (isADecision(action) || isAnAnswer(action)) {
    const theirs = notTheirOwn(actor, subject, action);

    if (!theirs.allowed) {
      return theirs;
    }
  }

  return standingsFor(action).some((standing) => hasStanding(actor, subject, standing))
    ? about.allow(actor, said, subject.employeeId)
    : about.refuseOpenly(actor, said, subject.employeeId, words.because, words.told);
}

/** Said openly to everybody it refuses, including a manager. */
const ASKING_IS_YOURS =
  'Leave is asked for by the person taking it, or entered by HR on their behalf where ' +
  'somebody was away and could not ask. A manager approves leave rather than ' +
  'requesting it. FR 18.';

/** Said openly, and to the only person it can ever be said to. FR 48, §8.6, LMS 319. */
const DECIDING_IS_SOMEBODY_ELSE =
  'Leave is decided by somebody other than the person taking it, whatever roles they hold ' +
  'and wherever the request is sitting. If you no longer want this leave, withdraw it; if ' +
  'it should not be on the books at all, HR cancels it. FR 48.';

/** Said openly, and only to somebody who is an approver of this request. FR 48d, LMS 322. */
const A_SECOND_STAGE_IS_SOMEBODY_ELSE =
  'A request that two stages decide is decided by two people. You answered an earlier stage ' +
  'of this one, so this stage is a colleague’s to answer, and where the company has nobody ' +
  'else to ask, the request goes through stamped as decided by a single approver rather ' +
  'than carrying your name twice. FR 48d.';

/** The same rule at the other end of a request's life. FR 47, FR 48, LMS 324. */
const ANSWERING_IS_SOMEBODY_ELSE =
  'An ask to take agreed leave off the books is answered by somebody other than the person ' +
  'whose leave it is, whatever roles they hold. Your own ask is on the record and another ' +
  'HR desk will answer it, agreeing to it yourself would be putting your own days back on ' +
  'your own say-so. FR 47, FR 48.';

export const leaveRequestPolicy = {
  resource: about.resource,

  /** Nobody decides their own request. FR 48, §8.6, LMS 319. */
  notTheirOwn,

  /** And nobody decides two stages of one. FR 48d, §8.6a, LMS 322. */
  eachStageADifferentPerson,

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

  /**
   * Entering leave further back than its type's window allows. FR 18, LMS 308.
   *
   * Asked rather than enforced — `Guard.permits`, not `Guard.enforce` — because the person it
   * says no to is not being refused anything: their request is refused by `TooLateToRecord`,
   * which names HR and reads as advice rather than as a locked door.
   *
   * HR's own late leave is admitted, and that is the reading FR 18 supports: what is reserved
   * to HR is *entering the record*, and the leave still goes to somebody else's desk to be
   * decided. Refusing it would leave an HR officer off sick for a fortnight with no way to
   * record it at all.
   */
  recordLate(actor: Actor, owner: BalanceOwner): Decision {
    return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? about.allow(actor, 'recordLate', owner.employeeId)
      : about.refuseOpenly(
          actor,
          'recordLate',
          owner.employeeId,
          'holds no role that enters leave past its backdating window',
          'Leave further back than its window allows is put on the record by HR, with a ' +
            'reason. FR 18.',
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
      'not their leave, not their manager, and holds no role that reads everybody',
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
        'this request is not waiting on you. Most kinds of leave go to the manager ' +
        'and then to HR; unpaid leave goes to HR and then to the Chief Executive. FR 38a.',
    });
  },

  /**
   * Overturning a manager's decision, which is a decision at this desk like any other. FR 44, §7.2, LMS 318.
   */
  override(actor: Actor, action: OverridingAction, subject: RequestAtADesk): Decision {
    return mayMove(actor, subject, action, {
      because: 'is not the approver this request is currently waiting on',
      told:
        'A manager’s decision is overturned by the next desk the request goes to, ' +
        'and this request is not waiting on you. It is the same standing as approving or ' +
        'refusing it. An override is an ordinary decision that happens to disagree with ' +
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
   * who is nobody's manager and holds no role. Being the desk is its own reason to be
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
            'manager it was addressed to, by HR, or by the Chief Executive, so this ' +
            'screen belongs to somebody with a report, an HR role, or FR 04’s seat. Your own ' +
            'requests and what became of them are on your leave pages. FR 38a.',
        );
  },

  /**
   * Reading everything the company is waiting on, and who owes each answer. FR 50, FR 60, LMS 330.
   *
   * Nobody's own queue: it crosses every team, so it is the daily reminder's `theSystem` and
   * the roles that already read every record. An approver's own is {@link queue}.
   */
  chaseTheCompany(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'chaseTheCompany', null)
      : about.refuse(
          actor,
          'chaseTheCompany',
          null,
          'holds no role that reads every record, and this is every team’s pending leave',
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

  /**
   * Asking for leave every desk has agreed to be taken off the books. FR 47, §6, LMS 324.
   *
   * `THE_REQUESTER` alone — the one place a withdrawal is narrower than the `WITHDRAW` above
   * rather than wider, because HR asking and then answering would be one desk on both sides.
   */
  askToWithdraw(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'ASK_TO_WITHDRAW', {
      because: 'is not the person whose leave this is',
      told:
        'Leave that has been agreed comes off the books because the person taking it asks ' +
        'for that and HR agrees. Nobody asks on somebody else’s behalf: the ask is the ' +
        'account HR decides on, and it has to be the account of the person who no longer ' +
        'needs the time off. FR 47.',
    });
  },

  /**
   * Answering one of those asks, whichever way it goes. FR 47, §6, §10, LMS 324.
   *
   * One rule for all three, because which of them applies is `grantingAction`'s answer rather
   * than the desk's. HR's, and never the manager's.
   */
  answerAWithdrawal(actor: Actor, action: WithdrawalAnswer, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, action, {
      because: 'holds no role that maintains leave for the company',
      told:
        'An ask to take agreed leave off the books is answered by HR. The days are spent ' +
        'rather than held, so putting them back is a correction to a balance rather than a ' +
        'decision at a desk. A manager approves leave and does not unspend it. FR 47.',
    });
  },

  /**
   * Moving days of agreed leave to sick leave. FR 32c, §6, §10, LMS 507.
   *
   * HR's, like the answer to a withdrawal and for the same reason: the days are spent rather
   * than held, so moving them between two balances is a correction to both. The certificate
   * is the employee's part of it, and they can neither credit their own annual leave back
   * nor decide what their own absence was.
   */
  reclassify(actor: Actor, owner: BalanceOwner): Decision {
    return mayMove(actor, owner, 'RECLASSIFY', {
      because: 'holds no role that maintains leave for the company',
      told:
        'Sickness during agreed leave is moved to sick leave by HR, on a medical ' +
        'certificate. The days have been taken, so putting them back into one balance and ' +
        'out of another is a correction rather than a decision at a desk. Send the ' +
        'certificate to HR. FR 32c.',
    });
  },

  /**
   * Reading, editing, discarding or submitting a draft. FR 19, §10., LMS 302.
   *
   * The narrowest rule in this file: the person planning the leave and nobody else. Not
   * their manager and not a role that reads every record, which `read` above admits —
   * a draft is leave nobody has asked for, so there is no request for a manager to be the
   * manager of and no record for a reader to read.
   *
   * Refused silently, as `read` is: somebody asking after a draft that is not theirs has
   * not been shown that one exists.
   */
  draft(actor: Actor, owner: BalanceOwner, action: string): Decision {
    return isSelf(actor, owner.employeeId)
      ? about.allow(actor, `draft.${action}`, owner.employeeId)
      : about.refuse(
          actor,
          `draft.${action}`,
          owner.employeeId,
          'is not the person whose draft it is, and a draft is nobody else’s to see',
        );
  },

  /**
   * Attaching evidence to a request, or taking it back off. FR 12, LMS 310.
   *
   * The standings `submit` carries: the person whose leave it is, or HR entering the
   * record for somebody who could not. Not the manager — an approver asks for a
   * certificate rather than supplying one.
   */
  attach(actor: Actor, owner: BalanceOwner): Decision {
    if (isSelf(actor, owner.employeeId) || holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'attach', owner.employeeId);
    }

    return about.refuseOpenly(
      actor,
      'attach',
      owner.employeeId,
      'not their own leave, and holds no role that keeps records for somebody else',
      'A certificate is attached by the person whose leave it evidences, or by HR on ' +
        'their behalf. An approver who needs to see one asks for it. FR 12.',
    );
  },

  /**
   * Reading what is attached, and downloading it. FR 12, NFR SEC 04, LMS 310.
   *
   * {@link read} widened by the desk the request is sitting on, which is the seam
   * {@link queue} already argues: FR 32h sends unpaid leave to the Chief Executive, who
   * is nobody's manager and holds no role, and an approver who cannot open the
   * certificate cannot decide on it.
   */
  readAttachment(actor: Actor, subject: RequestAtADesk): Decision {
    return isAt(actor, subject)
      ? about.allow(actor, 'readAttachment', subject.employeeId)
      : this.read(actor, subject);
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

/** Handing your approvals to a colleague, and taking them back. FR 49, §8.6a, §10., LMS 327. */
export const approvalDelegationPolicy = {
  resource: aboutDelegation.resource,

  /**
   * Nominating a delegate. FR 49.
   *
   * The approver's own act and nobody else's, which is the narrowness `askToWithdraw` keeps
   * and for the same reason: handing out somebody else's approval authority is a power
   * nobody asked for, and the story is an approver planning their own absence.
   */
  nominate(actor: Actor, approverId: string): Decision {
    return isSelf(actor, approverId)
      ? aboutDelegation.allow(actor, 'nominate', approverId)
      : aboutDelegation.refuseOpenly(
          actor,
          'nominate',
          approverId,
          'is not the approver whose approvals these are',
          'A delegate is nominated by the approver whose approvals are being handed over. ' +
            'Nobody hands out somebody else’s authority to decide leave. FR 49.',
        );
  },

  /**
   * Ending one. FR 49.
   *
   * Wider than {@link nominate} by one standing, and deliberately: HR cannot give an
   * approver's authority away and can take it back, because taking authority away is the
   * safe direction to be wrong in when the approver is unreachable.
   */
  revoke(actor: Actor, approverId: string): Decision {
    return isSelf(actor, approverId) || holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? aboutDelegation.allow(actor, 'revoke', approverId)
      : aboutDelegation.refuseOpenly(
          actor,
          'revoke',
          approverId,
          'is neither the approver nor a role that maintains leave for the company',
          'A delegation is ended by the approver who nominated it, or by HR. Being the ' +
            'delegate is not standing to end it. Hand the requests back by deciding them ' +
            'or by asking them to. FR 49.',
        );
  },

  /**
   * Reading what somebody has handed over, or been handed. FR 49.
   *
   * Either end of it, because a delegate has to be able to see what they are answering for,
   * and a role that reads every record. Refused silently, as `read` is.
   */
  read(actor: Actor, employeeId: string): Decision {
    return isSelf(actor, employeeId) || holdsAny(actor, ...READS_EVERY_RECORD)
      ? aboutDelegation.allow(actor, 'read', employeeId)
      : aboutDelegation.refuse(
          actor,
          'read',
          employeeId,
          'is not the person whose delegations these are, and holds no role that reads ' +
            'everybody',
        );
  },
};
