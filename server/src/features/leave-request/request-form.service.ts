/** The request form's rules, assembled. LMS 403, FR 13, FR 17, FR 32f, FR 05, FR 55, FR 56. */

import type { Actor } from '../../auth/actor.js';
import { leaveRequestPolicy } from './policy.js';
import type { BalanceOwner } from '../balance/policy.js';
import type { Guard } from '../../auth/policy.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import { byDisplayOrder } from '../leave-type/leave-type.js';
import { formFor, type RequestForm } from './request-form.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { LeaveTypeService } from '../leave-type/leave-type.service.js';

/**
 * What the form knows before a date is typed.
 *
 * A read service beside the write door, for the reason `RequestHistoryService` gives at
 * length and which holds harder here: `LeaveRequestService` is where a request is *made*, so
 * it holds the balance service, the day calculator and the notifier. Every one of those would
 * have to be constructed to answer "what does compassionate leave ask of me" — a question no
 * part of which touches a balance, a working pattern or an SMTP transport. A form that could
 * not render its own rules because the mail server was unreachable would be the read path
 * failing for a reason the read path has nothing to do with.
 *
 * It is deliberately thin. Everything it decides is decided somewhere else already:
 * `LeaveTypeService.offeredTo` narrows the list by FR 05, `byDisplayOrder` orders it by §7.4,
 * and `formFor` composes the sentences. What is left here is asking those three in an order,
 * which is the whole job of a service in this codebase.
 */
export class RequestFormService {
  constructor(
    /**
     * Which types this person may ask for, and their rules. FR 05, FR 21.
     *
     * The service rather than the repository, unlike every other collaborator on this class,
     * because `offeredTo` is where FR 05's eligibility filter lives and reading the type
     * table is a permission of its own. Reaching past it to the repository would be a second
     * place that decides who may see maternity leave on a form.
     */
    private readonly types: LeaveTypeService,
    /* NFR SEC 02. Required rather than defaulted; see ../../auth/policy.ts. */
    private readonly guard: Guard,
    /** For the gender FR 05 filters on, and to establish the person exists at all. */
    private readonly employees: EmployeeRepository,
  ) {}

  /**
   * The kinds of leave this person may ask for, each with what it asks of them. LMS 403.
   *
   * Reads nothing about their leave and writes nothing at all. The figures — what a period
   * costs, what the balance holds, what it would hold afterwards — are
   * `LeaveRequestService.quote`'s, and they need dates this has not been given.
   *
   * The guard is asked the request's own read question rather than a form-shaped one, which
   * is the same call `LeaveRequestService.resolve` makes: whoever may see somebody's requests
   * may see what the types would ask of them. `offeredTo` asks `leaveTypePolicy.list` for
   * itself on the way through.
   */
  async forEmployee(actor: Actor, employeeId: string): Promise<RequestForm> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));

    const offered = await this.types.offeredTo(actor, employee);

    return formFor({
      employeeId: employee.id,
      /* §7.4's ordering, which is the same one the balance screen lists cards in — so the
         kinds of leave are in one order everywhere somebody meets them, and it is an order
         somebody decided rather than an alphabetical accident. Sorted on a copy: `offeredTo`
         returns the repository's array and sorting in place would reorder a caller's list. */
      types: [...offered].sort(byDisplayOrder),
    });
  }

  /** The record, or EmployeeNotFound. */
  private async require(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }
}

/** Whose form this is, and who their line manager is. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
