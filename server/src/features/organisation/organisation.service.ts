/** Setting the organisation up, which today is naming the Chief Executive. FR 48c, §4.3.1, LMS 321. */

import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import type { Employee } from '../employee/employee.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import { organisationPolicy } from './policy.js';
import {
  ChiefExecutiveNotFound,
  isReadyForGoLive,
  NoChiefExecutiveNamed,
  type OrganisationSettings,
  readChiefExecutiveId,
  whyTheyCannotBeNamed,
} from './organisation.js';
import type { OrganisationRepository } from './organisation.db.js';

/**
 * The one door that reads and writes how the company is configured. FR 48c.
 *
 * Leave routing does not come through here: it reads `OrganisationRepository` directly, the
 * way it reads every other fact a desk resolves from. A policy in the middle would refuse the
 * one approver §4.3.1 names — the same seam `ApproverQueueService` argues about balances.
 */
export class OrganisationService {
  constructor(
    private readonly organisation: OrganisationRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../../auth/policy.ts. */
    private readonly guard: Guard,
    /** Whether the person named is anybody, and whether they are still here. FR 06. */
    private readonly employees: EmployeeRepository,
  ) {}

  /** How the organisation is set up. An unconfigured database answers rather than throwing. */
  async settings(actor: Actor): Promise<OrganisationSettings> {
    this.guard.enforce(organisationPolicy.read(actor));

    return (
      (await this.organisation.settings()) ?? { chiefExecutiveId: null, updatedAt: new Date() }
    );
  }

  /**
   * The Chief Executive, as a record. FR 48c.
   *
   * Throws {@link NoChiefExecutiveNamed} where nobody has been named, and
   * {@link ChiefExecutiveNotFound} where the setting points at a record that has gone — which
   * the foreign key makes unreachable and which is answered anyway.
   */
  async chiefExecutive(actor: Actor): Promise<Employee> {
    const { chiefExecutiveId } = await this.settings(actor);

    if (chiefExecutiveId === null) {
      throw new NoChiefExecutiveNamed();
    }

    const employee = await this.employees.findById(chiefExecutiveId);

    if (employee === undefined) {
      throw new ChiefExecutiveNotFound(chiefExecutiveId);
    }

    return employee;
  }

  /** The story's second criterion as a question rather than as a refusal. FR 48c. */
  async isReadyForGoLive(actor: Actor): Promise<boolean> {
    return isReadyForGoLive(await this.settings(actor));
  }

  /**
   * Names the Chief Executive. FR 48c, §4.3.1.
   *
   * A person by their employee record, and nothing anywhere reads a job title to work out who
   * they are. Changing it moves the `CEO` desk for every request standing at it, which is why
   * it is an HR Administrator's and is audited.
   *
   * The questions are ordered so each refusal is the useful one: may you do this, then is this
   * anybody, then are they here.
   *
   * Throws {@link ChiefExecutiveCannotBeCleared} for an empty box,
   * {@link ChiefExecutiveNotFound} for an id that is nobody's, {@link ChiefExecutiveHasLeft}
   * for somebody who has gone, and {@link NotAuthorised} for anybody but an HR Administrator.
   */
  async nameTheChiefExecutive(actor: Actor, employeeId: unknown): Promise<OrganisationSettings> {
    const id = readChiefExecutiveId(employeeId);

    this.guard.enforce(organisationPolicy.nameTheChiefExecutive(actor, id));

    const employee = await this.employees.findById(id);

    if (employee === undefined) {
      throw new ChiefExecutiveNotFound(id);
    }

    const refusal = whyTheyCannotBeNamed(employee);

    if (refusal !== null) {
      throw refusal;
    }

    return this.organisation.nameTheChiefExecutive(actor, employee);
  }
}
