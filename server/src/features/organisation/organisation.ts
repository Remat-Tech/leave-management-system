/** Who the Chief Executive is. FR 48c, FR 04, FR 38a, §4.3.1, LMS 321. */

import type { Employee } from '../employee/employee.js';

/** The organisation's own settings. FR 48c. */
export interface OrganisationSettings {
  /** Who the `CEO` desk resolves to. Null is nobody, which FR 48b routes round. */
  chiefExecutiveId: string | null;
  updatedAt: Date;
}

/** Naming somebody who is not an employee. FR 48c. */
export class ChiefExecutiveNotFound extends Error {
  readonly employeeId: string;

  constructor(employeeId: string) {
    super(
      `No employee with id ${employeeId}, so nobody was named as the Chief Executive. The ` +
        `setting names a person by their record rather than by their job title. FR 48c.`,
    );
    this.name = 'ChiefExecutiveNotFound';
    this.employeeId = employeeId;
  }
}

/** Naming somebody who has left. FR 48c, FR 06. */
export class ChiefExecutiveHasLeft extends Error {
  readonly employeeId: string;

  constructor(employee: Employee) {
    super(
      `${employee.firstName} ${employee.lastName} has left the company, so naming them ` +
        `would send every unpaid request to a desk nobody can sign in to. Name whoever ` +
        `holds the post now. FR 48c, FR 06.`,
    );
    this.name = 'ChiefExecutiveHasLeft';
    this.employeeId = employee.id;
  }
}

/** Emptying a seat somebody was in. The setting is changed, never cleared. FR 48c. */
export class ChiefExecutiveCannotBeCleared extends Error {
  constructor() {
    super(
      'The organisation would be left with no Chief Executive named. Unpaid leave is ' +
        'decided by HR and the Chief Executive, so an empty seat is a stage no request can ' +
        'be sent to. Name their successor instead. FR 48c, §4.3.1.',
    );
    this.name = 'ChiefExecutiveCannotBeCleared';
  }
}

/**
 * Asked for the Chief Executive before anybody named one. FR 48c.
 *
 * Deliberately not what leave routing raises: an unnamed Chief Executive leaves that desk
 * unstaffed and FR 48b takes over, so an unconfigured company still approves annual leave.
 */
export class NoChiefExecutiveNamed extends Error {
  constructor() {
    super(
      'Nobody is named as the Chief Executive. Unpaid leave and the unpaid maternity ' +
        'extension are decided by HR and the Chief Executive, so this has to be set before ' +
        'the system goes live. FR 48c, §4.3.1.',
    );
    this.name = 'NoChiefExecutiveNamed';
  }
}

/** The id a caller supplied, or a refusal. Whether it is anybody's is asked where the rows are. */
export function readChiefExecutiveId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ChiefExecutiveCannotBeCleared();
  }

  return value.trim();
}

/** Why this record may not be named, or null. FR 48c, FR 06. */
export function whyTheyCannotBeNamed(employee: Employee): Error | null {
  return employee.employmentStatus === 'TERMINATED' ? new ChiefExecutiveHasLeft(employee) : null;
}

/**
 * Whether the organisation is configured enough to go live. FR 48c.
 *
 * A question about the setting, not the person: somebody named and since departed is a
 * configured organisation with a succession to do.
 */
export function isReadyForGoLive(settings: OrganisationSettings): boolean {
  return settings.chiefExecutiveId !== null;
}
