/** Who the Chief Executive is, and the rest of the policy settings. FR 44, FR 48c, NFR SEC 06, §4.3.1, LMS 321, LMS 505. */

import type { Employee } from '../employee/employee.js';

/** The organisation's own settings. FR 44, FR 48c, NFR SEC 06. */
export interface OrganisationSettings {
  /** Who the `CEO` desk resolves to. Null is nobody, which FR 48b routes round. */
  chiefExecutiveId: string | null;
  /** FR 44. False makes a line manager's decision final. */
  overridesAreAllowed: boolean;
  /** NFR SEC 06. Whole months, or null for kept indefinitely. */
  attachmentRetentionMonths: number | null;
  updatedAt: Date;
}

/** What the settings are on a database nobody has configured. */
export const UNCONFIGURED: Omit<OrganisationSettings, 'updatedAt'> = {
  chiefExecutiveId: null,
  overridesAreAllowed: true,
  attachmentRetentionMonths: null,
};

/** The settings that are not the Chief Executive. That one has its own door. LMS 505. */
export interface PolicyChanges {
  overridesAreAllowed?: boolean;
  attachmentRetentionMonths?: number | null;
}

/** The longest window offered. Longer than a person's memory of why the file is there. */
export const LONGEST_RETENTION_MONTHS = 120;

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

/** A policy setting that was refused, and the field that caused it. NFR USA 03. */
export class InvalidPolicySetting extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidPolicySetting';
    this.field = field;
  }
}

/** An override attempted while the rule is switched off. FR 44, LMS 505. */
export class OverridesAreSwitchedOff extends Error {
  /** FR 44. */
  readonly code = 'OVERRIDES_ARE_SWITCHED_OFF';

  constructor() {
    super(
      'HR overrides are switched off, so a line manager’s decision on this request is ' +
        'the final one. Nobody can approve leave they turned down or turn down leave they ' +
        'approved. An HR Administrator can switch overrides back on in the policy settings. ' +
        'FR 44.',
    );
    this.name = 'OverridesAreSwitchedOff';
  }
}

/* ------------------------------------------------------------- what is valid */

/** Checks and tidies a change to the policy settings. Only what is sent is read. */
export function validatePolicyChanges(changes: PolicyChanges): PolicyChanges {
  const validated: PolicyChanges = {};

  if ('overridesAreAllowed' in changes) {
    validated.overridesAreAllowed = requireYesOrNo(changes.overridesAreAllowed);
  }
  if ('attachmentRetentionMonths' in changes) {
    validated.attachmentRetentionMonths = requireRetention(changes.attachmentRetentionMonths);
  }

  return validated;
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

/* ----------------------------------------------------------------- the words */

/** What the override rule means for a manager, as it stands. FR 44, LMS 505. */
export function overrideRuleInWords(allowed: boolean): string {
  return allowed
    ? 'HR sees every request a manager turned down and can overturn it, in writing. The ' +
        'manager is told, and both decisions stay on the record.'
    : 'A line manager’s decision is the final one. HR can still agree with it, and cannot ' +
        'reverse it.';
}

/** What the retention window means for a certificate. NFR SEC 06, LMS 505. */
export function retentionInWords(months: number | null): string {
  if (months === null) {
    return (
      'Certificates and supporting documents are kept for as long as the request is, ' +
      'which is for ever.'
    );
  }

  return (
    `Certificates and supporting documents are kept for ${inMonths(months)} after the ` +
    'request they are attached to ends. Nothing removes them on that window yet — it is the ' +
    'figure the retention sweep will read.'
  );
}

/** "18 months", "2 years" where it divides. */
function inMonths(months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return `${String(years)} ${years === 1 ? 'year' : 'years'}`;
  }

  return `${String(months)} months`;
}

/* ---------------------------------------------------------------- the fields */

function requireYesOrNo(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new InvalidPolicySetting(
      'overridesAreAllowed',
      'Whether HR may overturn a line manager’s decision is yes or no. FR 44.',
    );
  }

  return value;
}

/** Null is kept indefinitely, which is a setting rather than an unanswered question. */
function requireRetention(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidPolicySetting(
      'attachmentRetentionMonths',
      'A retention window is a whole number of months, one or more. Leave it empty to keep ' +
        'certificates indefinitely. NFR SEC 06.',
    );
  }

  if (value > LONGEST_RETENTION_MONTHS) {
    throw new InvalidPolicySetting(
      'attachmentRetentionMonths',
      `${String(LONGEST_RETENTION_MONTHS)} months is the longest window offered. A longer ` +
        'one is the same as keeping them indefinitely, which is what leaving it empty says.',
    );
  }

  return value;
}
