/**
 * Saving a request and finishing it later. FR 19, FR 10, §6., LMS 302.
 */

import type { Actor } from '../../auth/actor.js';
import { leaveRequestPolicy } from './policy.js';
import type { BalanceOwner } from '../balance/policy.js';
import type { Employee } from '../employee/employee.js';
import { EmployeeNotFound } from '../employee/employee.js';
import type { Guard } from '../../auth/policy.js';
import {
  type DraftAsSent,
  InvalidLeaveRequestDraft,
  type LeaveRequestDraft,
  LeaveRequestDraftNotFound,
  readyToSubmit,
  validateDraftContents,
} from './draft.js';
import type { LeaveRequestDraftRepository } from './draft.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveRequested } from '../balance/balance.service.js';
import type { LeaveRequestService } from './leave-request.service.js';

export class LeaveRequestDraftService {
  constructor(
    /* NFR SEC 02. Required rather than defaulted; see ../../auth/policy.ts. */
    private readonly guard: Guard,
    private readonly drafts: LeaveRequestDraftRepository,
    /** Whose draft it is, which no id can say by itself. */
    private readonly employees: EmployeeRepository,
    /**
     * The one door that prices and writes a request. LMS 301.
     *
     * Held rather than reimplemented: finishing a draft is an ordinary submission, and a
     * second path into `leave_request` would be a second answer to what a fortnight costs
     * and a second place to forget the balance lock.
     */
    private readonly requests: LeaveRequestService,
  ) {}

  /**
   * Saves what somebody has filled in so far. FR 19, the story's first criterion.
   *
   * Writes one row, holds no days, asks nobody and tells nobody. What is checked is that
   * the fields are the fields; everything about the leave itself is checked at submission.
   *
   * Throws {@link InvalidLeaveRequestDraft} for a draft with nothing in it or with dates
   * the wrong way round.
   */
  async save(actor: Actor, employeeId: string, input: DraftAsSent): Promise<LeaveRequestDraft> {
    const employee = await this.employeeFor(employeeId);

    this.guard.enforce(leaveRequestPolicy.draft(actor, ownerOf(employee), 'save'));

    return this.drafts.save(employee.id, validateDraftContents(input));
  }

  /**
   * Replaces what a draft holds. FR 19, the story's second criterion.
   *
   * Every field, always, for as long as it is a draft — there is no state to check,
   * because a request that has been submitted is a row in another table.
   *
   * A whole replacement rather than a patch: what arrives is the form as it now stands, so
   * a field somebody cleared is cleared here.
   */
  async replace(actor: Actor, id: string, input: DraftAsSent): Promise<LeaveRequestDraft> {
    await this.mine(actor, id, 'replace');

    const written = await this.drafts.replace(id, validateDraftContents(input));

    if (written === undefined) {
      /* Unreachable: the row was read a statement ago. Answered rather than asserted,
         because the alternative is returning undefined from a method that says it does
         not. */
      throw new LeaveRequestDraftNotFound(id);
    }

    return written;
  }

  /** One draft, if it is the asker's own. FR 19. */
  async byId(actor: Actor, id: string): Promise<LeaveRequestDraft> {
    return this.mine(actor, id, 'read');
  }

  /** Everything this person has started, the one they last worked on first. FR 19. */
  async forEmployee(actor: Actor, employeeId: string): Promise<LeaveRequestDraft[]> {
    const employee = await this.employeeFor(employeeId);

    this.guard.enforce(leaveRequestPolicy.draft(actor, ownerOf(employee), 'read'));

    return this.drafts.forEmployee(employee.id);
  }

  /** Throws a draft away. FR 19. Nothing was held, so nothing comes back. */
  async discard(actor: Actor, id: string): Promise<void> {
    await this.mine(actor, id, 'discard');

    if (!(await this.drafts.discard(id))) {
      /* Two tabs discarding the same draft. The second is told what the first did rather
         than that nothing happened. */
      throw new LeaveRequestDraftNotFound(id);
    }
  }

  /**
   * Asks for the leave a draft describes, and throws the draft away. FR 19, FR 10.
   *
   * The moment it enters the workflow, and it is `LeaveRequestService.submit` that takes
   * it there — so a draft is priced, checked against the balance, held to one leave year
   * and refused over leave already booked exactly as anything typed straight into the form
   * is. None of those refusals leaves the draft any worse: it is discarded only once the
   * request is written.
   *
   * **In that order**, and a crash between the two leaves a draft for leave that was
   * asked for rather than losing somebody's work — and submitting it again meets
   * {@link LeaveOverlapsAnother}, which names the request that is already there.
   *
   * Neither the acknowledgement nor the late entry reason is one of the draft's fields.
   * FR 17, FR 18, LMS 307, LMS 308: both depend on the day it is submitted rather than on
   * anything planned, so they arrive with the finishing.
   *
   * Throws {@link DraftIsNotFinished} for one with a field still to fill in,
   * {@link ShortNoticeNotAcknowledged} for short notice nobody has answered, and every other
   * refusal `submit` throws.
   */
  async submit(
    actor: Actor,
    id: string,
    acknowledgesShortNotice = false,
    lateEntryReason = '',
    evidence: readonly string[] = [],
  ): Promise<LeaveRequested> {
    const draft = await this.mine(actor, id, 'submit');

    const submitted = await this.requests.submit(actor, {
      employeeId: draft.employeeId,
      ...readyToSubmit(draft),
      /** FR 17, LMS 307. */
      acknowledgesShortNotice,
      /** FR 18, LMS 308. */
      lateEntryReason,
      /** FR 13, FR 32a, LMS 311. Named when the draft is finished; a draft holds no files. */
      evidence,
    });

    await this.drafts.discard(draft.id);

    return submitted;
  }

  /**
   * The draft, if it is the asker's own. FR 19, §10.
   *
   * The employee record is read before the policy because a draft's id says nothing about
   * whose it is, and refused silently — see {@link leaveRequestPolicy.draft}.
   */
  private async mine(actor: Actor, id: string, action: string): Promise<LeaveRequestDraft> {
    const draft = await this.drafts.findById(requireId(id));

    if (draft === undefined) {
      throw new LeaveRequestDraftNotFound(id);
    }

    const employee = await this.employeeFor(draft.employeeId);

    this.guard.enforce(leaveRequestPolicy.draft(actor, ownerOf(employee), action));

    return draft;
  }

  private async employeeFor(employeeId: unknown): Promise<Employee> {
    if (typeof employeeId !== 'string' || employeeId.trim() === '') {
      throw new InvalidLeaveRequestDraft('employeeId', 'A draft has to say whose leave it is.');
    }

    const employee = await this.employees.findById(employeeId.trim());

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId.trim());
    }

    return employee;
  }
}

function requireId(id: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new InvalidLeaveRequestDraft('id', 'A draft is asked for by its id.');
  }

  return id.trim();
}

/** Whose draft this is, as the policy wants it. The same two ids a balance is owned by. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
