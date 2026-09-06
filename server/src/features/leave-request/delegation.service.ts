/** Handing approvals to a colleague while an approver is away. FR 49, §8.6a, LMS 327. */

import type { Actor } from '../../auth/actor.js';
import { approvalDelegationPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import {
  type ApprovalDelegation,
  type DelegatedApprover,
  delegatedAuthorityFrom,
  DelegationAlreadyEnded,
  DelegationNotFound,
  InvalidDelegation,
  type NewDelegation,
  validateNewDelegation,
} from './delegation.js';
import type { ApprovalDelegationRepository } from './delegation.db.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { RoleRepository } from '../role/role.db.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';

export class ApprovalDelegationService {
  constructor(
    private readonly delegations: ApprovalDelegationRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../../auth/policy.ts. */
    private readonly guard: Guard,
    /** Whether the delegate is somebody who can still answer, and who manages anybody. */
    private readonly employees: EmployeeRepository,
    /** What a delegator holds, so a delegate's desks are never a copy. FR 38a. */
    private readonly roles: RoleRepository,
  ) {}

  /**
   * Hands this approver's approvals to a colleague for a date range. FR 49, the story's first criterion.
   *
   * The approver's own act — {@link approvalDelegationPolicy.nominate}. Nothing about which
   * desks it reaches is decided or stored here: a delegation is of a person, and the desks
   * follow from what that person holds on the day a request arrives.
   *
   * Throws {@link DelegateIsTheApprover}, {@link InvalidDelegation} for dates that are not a
   * range, {@link EmployeeNotFound} for a delegate who is nobody, and {@link AlreadyDelegated}
   * where these days are already covered.
   */
  async nominate(actor: Actor, input: NewDelegation): Promise<ApprovalDelegation> {
    const delegation = validateNewDelegation(input);

    this.guard.enforce(approvalDelegationPolicy.nominate(actor, delegation.approverId));

    /* A leaver cannot sign in, so a desk handed to one is a desk nothing reaches. Refused
       here rather than silently at resolution, where nobody would find out. FR 06. */
    const delegate = await this.employees.findById(delegation.delegateId);

    if (delegate === undefined) {
      throw new EmployeeNotFound(delegation.delegateId);
    }

    if (delegate.employmentStatus === 'TERMINATED') {
      throw new InvalidDelegation(
        'delegateId',
        `${delegate.firstName} ${delegate.lastName} has left, so nothing would reach them. ` +
          'A delegate is a colleague who can still sign in. FR 49.',
      );
    }

    return this.delegations.nominate(actor, delegation);
  }

  /**
   * Ends one before its last day. FR 49.
   *
   * The approver's, or HR's. Nothing already decided under it is unpicked: a decision
   * carries the delegation it was made under in its own columns.
   */
  async revoke(actor: Actor, id: string): Promise<ApprovalDelegation> {
    const standing = await this.oneOf(id);

    this.guard.enforce(approvalDelegationPolicy.revoke(actor, standing.approverId));

    if (standing.revokedAt !== null) {
      throw new DelegationAlreadyEnded(standing);
    }

    const ended = await this.delegations.revoke(actor, standing.id);

    /* Unreachable: the row was read a statement ago and nothing deletes one. */
    if (ended === undefined) {
      throw new DelegationNotFound(id);
    }

    return ended;
  }

  /** What this person has handed over, soonest first. FR 49. */
  async handedOverBy(actor: Actor, employeeId: string): Promise<ApprovalDelegation[]> {
    this.guard.enforce(approvalDelegationPolicy.read(actor, employeeId));

    return this.delegations.byApprover(employeeId);
  }

  /** What this person has been handed. FR 49. */
  async handedTo(actor: Actor, employeeId: string): Promise<ApprovalDelegation[]> {
    this.guard.enforce(approvalDelegationPolicy.read(actor, employeeId));

    return this.delegations.toDelegate(employeeId);
  }

  /**
   * Whose approvals this person answers today, and what each of them holds. FR 49, FR 40.
   *
   * The read `ApproverQueueService` and `LeaveRequestService` both make about the person
   * asking, so the queue and the decide door cannot disagree about who is covering for whom.
   * Unguarded, as `employeesInHr` is: it names nobody the caller is not already.
   */
  async standingInFor(employeeId: string | null): Promise<DelegatedApprover[]> {
    if (employeeId === null) {
      return [];
    }

    const inForce = await this.delegations.inForceFor(employeeId, this.today());

    return this.authorityBehind(inForce);
  }

  /** Who is covering for these approvers today. FR 49, FR 48b. */
  async delegatesAt(approverIds: readonly string[]): Promise<ApprovalDelegation[]> {
    return this.delegations.inForceBy(approverIds, this.today());
  }

  /** One delegation, before anybody's standing over it is decided. */
  private async oneOf(id: string): Promise<ApprovalDelegation> {
    const standing = await this.delegations.findById(id);

    if (standing === undefined) {
      throw new DelegationNotFound(id);
    }

    return standing;
  }

  /** What each delegator holds, read now rather than stored on the nomination. FR 38a. */
  private async authorityBehind(
    delegations: readonly ApprovalDelegation[],
  ): Promise<DelegatedApprover[]> {
    if (delegations.length === 0) {
      return [];
    }

    const approverIds = [...new Set(delegations.map((one) => one.approverId))];

    const [rolesHeld, reports, records] = await Promise.all([
      this.roles.codesForEmployees(approverIds),
      this.employees.findReportsOf(approverIds),
      this.employees.findAllById(approverIds),
    ]);

    /* A delegator who has left staffs nothing, so neither does anybody covering for them. */
    const stillHere = new Set(records.filter(canStillAnswer).map((one) => one.id));

    return delegatedAuthorityFrom(
      delegations.filter((one) => stillHere.has(one.approverId)),
      rolesHeld,
      [...new Set(reports.map((one) => one.managerId).filter((id): id is string => id !== null))],
    );
  }

  /** The same clock the rest of this feature reads. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/** FR 06. Somebody who has left answers nothing, so nothing is answered for them either. */
function canStillAnswer(employee: Employee): boolean {
  return employee.employmentStatus !== 'TERMINATED';
}
