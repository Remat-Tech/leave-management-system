/** The approver queue, assembled. FR 20, FR 40, FR 38a, FR 48, FR 48c, §8.6a, LMS 404, LMS 321. */

import type { Actor } from '../../auth/actor.js';
import { desksStaffedBy, leaveRequestPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import {
  type ApproverQueue,
  balanceKeyOf,
  queueFor,
  rejectionsToReview,
} from './approver-queue.js';
import type { Employee } from '../employee/employee.js';
import type { LeaveRequest } from './leave-request.js';
import type { LeavePeriod } from '../leave-calculator/leave-calculator.js';
import { calendarDateIn } from '../../shared/time.js';
import type { BalanceRepository } from '../balance/balance.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { ApprovalDelegationService } from './delegation.service.js';
import type { LeaveDecisionRepository } from './leave-decision.db.js';
import type { LeaveRequestRepository } from './leave-request.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import type { OrganisationRepository } from '../organisation/organisation.db.js';

export class ApproverQueueService {
  constructor(
    private readonly requests: LeaveRequestRepository,
    /** FR 41. Which stages have already signed. */
    private readonly decisions: LeaveDecisionRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../../auth/policy.ts. */
    private readonly guard: Guard,
    /** The askers and their teammates. */
    private readonly employees: EmployeeRepository,
    /** FR 48c. Who the `CEO` desk resolves to. LMS 321. */
    private readonly organisation: OrganisationRepository,
    /**
     * The balance context, read through the repository rather than `BalanceService`. §8.6.
     *
     * The service enforces `ledgerPolicy.read`, which the manager's desk and the HR desk pass
     * and the Chief Executive does not — they are nobody's line manager and hold no role, so
     * every unpaid request §4.3.1 routes to them would arrive with no figure beside it. The
     * standing here is the desk, which `leaveRequestPolicy.queue` has already established.
     */
    private readonly balances: BalanceRepository,
    /** Each request's type name and its chain as it now stands. */
    private readonly types: LeaveTypeRepository,
    /** The year label the balance sentence names. */
    private readonly years: LeaveYearRepository,
    /** FR 49. Whose approvals this person is covering today. LMS 327. */
    private readonly delegations: ApprovalDelegationService,
  ) {}

  /**
   * The requests a line manager turned down that are now waiting on this person. FR 44, §7.2. LMS 318.
   *
   * The same queue, narrowed. Since a rejection routes rather than ends, these arrive at
   * HR's desk on their own and each carries what the manager said and why.
   */
  async rejectionsFor(actor: Actor): Promise<ApproverQueue> {
    return rejectionsToReview(await this.forApprover(actor));
  }

  /** Everything waiting on this person, soonest to start first. LMS 404. */
  async forApprover(actor: Actor): Promise<ApproverQueue> {
    /* FR 48c. The same read `LeaveRequestService.whoCanDecide` makes, so the queue and the
       approve door cannot disagree about who holds that seat. LMS 321. */
    const chiefExecutiveId = await this.organisation.chiefExecutiveId();

    /* FR 49, LMS 327. A delegate staffs whatever their delegator staffs, for as long as the
       nomination runs — read now, so a delegation that ended this morning reaches nothing. */
    const staffed = desksStaffedBy(
      actor,
      chiefExecutiveId,
      await this.delegations.standingInFor(actor.employeeId),
    );

    this.guard.enforce(leaveRequestPolicy.queue(actor, staffed));

    const requests = await this.requests.awaiting(staffed);

    const askers = await this.employees.findAllById(whoAsked(requests));

    /* The askers and their teammates in one read, because the team is defined by the askers'
       managers and both are wanted by id. A queue with nobody in it asks for nothing. */
    const team = await this.employees.findReportsOf(managersOf(askers));

    const people = [...askers, ...team.filter((one) => !askers.some((who) => who.id === one.id))];

    const span = spanning(requests);

    return queueFor({
      approverId: actor.employeeId ?? '',
      staffed,
      requests,
      people,
      /** FR 49, LMS 327. The colleagues being covered for, so a row can name them. */
      covering: await this.employees.findAllById(
        staffed.delegated.map((one) => one.approverId).concat(managersOf(askers)),
      ),
      types: await this.types.list(),
      years: await this.years.list(),
      decisions: await this.decisions.forRequests(requests.map((request) => request.id)),
      balances: await this.balances.forKeys(requests.map(balanceKeyOf)),
      teamLeave:
        span === null
          ? []
          : await this.requests.liveOverlapping(
              team.map((one) => one.id),
              span,
            ),
      today: calendarDateIn(new Date(), 'UTC'),
      /* Asked through `permits` rather than `enforce`: a name left off a team line is not a
         refused attempt and has no business in the denial log. */
      mayBeNamed: (colleague: Employee) =>
        this.guard.permits(
          leaveRequestPolicy.read(actor, {
            employeeId: colleague.id,
            managerId: colleague.managerId,
          }),
        ),
      /**
       * FR 48, §8.6a, FR 49. The policy's own answers and its own sentences.
       *
       * Both questions the approve door asks, in its order, so the queue and the door cannot
       * disagree about who may decide what. The second one is the delegate's case: a row can
       * be at a desk somebody covers and still not be theirs to answer, because a delegation
       * carries no say over the delegator's own leave. LMS 327.
       */
      whyNotDecidable: (request: LeaveRequest) => {
        const asker = askers.find((one) => one.id === request.employeeId);
        const owner = { employeeId: request.employeeId, managerId: asker?.managerId ?? null };

        const theirs = leaveRequestPolicy.notTheirOwn(actor, owner, 'APPROVE');

        if (!theirs.allowed) {
          return theirs.told;
        }

        const desk = leaveRequestPolicy.approve(actor, {
          ...owner,
          awaiting: request.awaitingApprovalFrom,
          chiefExecutiveId,
          standingIn: staffed.delegated,
        });

        return desk.allowed ? null : desk.told;
      },
    });
  }
}

/** Whose requests these are. */
function whoAsked(requests: readonly LeaveRequest[]): string[] {
  return [...new Set(requests.map((request) => request.employeeId))];
}

/** The line managers the teams hang off. */
function managersOf(askers: readonly Employee[]): string[] {
  return [...new Set(askers.map((one) => one.managerId).filter((id): id is string => id !== null))];
}

/**
 * The days the whole queue covers, or null where it covers none.
 *
 * One span for one statement, which `LeaveRequestRepository.liveOverlapping` takes and
 * `teamFor` narrows per row.
 */
function spanning(requests: readonly LeaveRequest[]): LeavePeriod | null {
  if (requests.length === 0) {
    return null;
  }

  return {
    from: requests.reduce((first, one) => (one.from < first ? one.from : first), requests[0].from),
    to: requests.reduce((last, one) => (one.to > last ? one.to : last), requests[0].to),
  };
}
