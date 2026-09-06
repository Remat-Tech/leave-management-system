/** An approver's approvals, answered by a colleague while they are away. FR 49, FR 52, §8.6a, LMS 327. */

import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { Authority, RoleCode } from '../role/roles.js';
import {
  type CalendarDate,
  calendarDateIn,
  calendarDaysBetween,
  formatDay,
  isCalendarDate,
} from '../../shared/time.js';

/** The longest anybody may hand their approvals over for, in days. */
const LONGEST_DELEGATION_DAYS = 366;

/** What an approver hands over, as it is asked for. FR 49. */
export interface NewDelegation {
  /** Whose approvals these are. */
  approverId: string;
  /** Who answers them meanwhile. */
  delegateId: string;
  /** Inclusive at both ends, as every period here. */
  from: CalendarDate;
  to: CalendarDate;
  /** NFR USA 03. Optional. */
  because?: unknown;
}

/** The same, checked. */
export interface ValidatedDelegation {
  approverId: string;
  delegateId: string;
  from: CalendarDate;
  to: CalendarDate;
  because: string | null;
}

/** One delegation as it comes back out. FR 49. */
export interface ApprovalDelegation extends ValidatedDelegation {
  id: string;
  /** Null while it stands. */
  revokedAt: Date | null;
  revokedBy: string | null;
  nominatedBy: string;
  nominatedAt: Date;
}

/**
 * One colleague's approvals and what they amount to, for {@link desksStaffedBy}. FR 49, LMS 327.
 *
 * A delegation is of a person, so which desks it reaches is a question about the delegator's
 * roles and reporting line rather than about the row.
 */
export interface DelegatedDesks {
  approverId: string;
  desks: readonly ApproverRole[];
}

/** One delegation, with what the delegator holds today. FR 49, LMS 327. */
export interface DelegatedApprover extends Authority {
  approverId: string;
}

/** What each delegation amounts to, from what its approver holds. FR 49, LMS 327. */
export function delegatedAuthorityFrom(
  delegations: readonly ApprovalDelegation[],
  rolesHeld: ReadonlyMap<string, readonly RoleCode[]>,
  managers: readonly string[],
): DelegatedApprover[] {
  return delegations.map((one) => ({
    approverId: one.approverId,
    roles: [...(rolesHeld.get(one.approverId) ?? [])],
    isManager: managers.includes(one.approverId),
  }));
}

/** A delegation that would hand somebody their own approvals. FR 49. */
export class DelegateIsTheApprover extends Error {
  readonly code = 'DELEGATE_IS_THE_APPROVER';
  readonly field = 'delegateId';

  constructor() {
    super(
      'A delegate is a colleague. Nominating yourself hands nothing to anybody, and the ' +
        'requests waiting on you would still be waiting on you. FR 49.',
    );
    this.name = 'DelegateIsTheApprover';
  }
}

/** A delegation the record cannot hold. NFR USA 03, FR 49. */
export class InvalidDelegation extends Error {
  readonly code = 'INVALID_DELEGATION';
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidDelegation';
    this.field = field;
  }
}

/** A second delegate over days a first already covers. FR 49. */
export class AlreadyDelegated extends Error {
  readonly code = 'ALREADY_DELEGATED';
  readonly field = 'from';

  constructor(period: { from: CalendarDate; to: CalendarDate }) {
    super(
      `Your approvals are already handed to somebody over ${formatDay(period.from)} to ` +
        `${formatDay(period.to)}. One delegate at a time — two people holding the same ` +
        'approvals is a decision recorded under whichever of them pressed first. End the ' +
        'delegation that stands first. FR 49.',
    );
    this.name = 'AlreadyDelegated';
  }
}

/** An id that names no delegation of this person's. FR 49. */
export class DelegationNotFound extends Error {
  readonly code = 'DELEGATION_NOT_FOUND';
  readonly delegationId: string;

  constructor(id: string) {
    super(`There is no delegation ${id}.`);
    this.name = 'DelegationNotFound';
    this.delegationId = id;
  }
}

/** A delegation ended twice. FR 49. */
export class DelegationAlreadyEnded extends Error {
  readonly code = 'DELEGATION_ALREADY_ENDED';
  readonly delegationId: string;

  constructor(delegation: ApprovalDelegation) {
    super(
      `This delegation ended on ${formatDay(dayOf(delegation.revokedAt))}. Nobody has been ` +
        'answering under it since, and ending it again would move that moment. FR 49.',
    );
    this.name = 'DelegationAlreadyEnded';
    this.delegationId = delegation.id;
  }
}

/** Checks a nomination on its way to being written. FR 49. */
export function validateNewDelegation(input: NewDelegation): ValidatedDelegation {
  const approverId = requireId('approverId', input.approverId);
  const delegateId = requireId('delegateId', input.delegateId);

  if (approverId === delegateId) {
    throw new DelegateIsTheApprover();
  }

  const from = requireDay('from', input.from);
  const to = requireDay('to', input.to);

  if (to < from) {
    throw new InvalidDelegation(
      'to',
      `A delegation cannot end on ${to}, before it starts on ${from}. Both days are inside ` +
        'it, so handing your approvals over for one day is the same date twice.',
    );
  }

  if (calendarDaysBetween(from, to) > LONGEST_DELEGATION_DAYS) {
    throw new InvalidDelegation(
      'to',
      `${from} to ${to} is over a year of somebody else answering for you. Cover while an ` +
        'approver is away is a date range rather than a standing arrangement; a permanent ' +
        'change of approver is a change to the reporting line or to a role. FR 49.',
    );
  }

  return { approverId, delegateId, from, to, because: readBecause(input.because) };
}

/* Which days a delegation covers is deliberately not a function here. The repository's
   `WHERE` is the one implementation, because a second one is an answer waiting to disagree
   with it — the same argument `balanceFrom(entries)` loses in ../balance/balance.ts. */

/**
 * The delegations that carry standing over this request. FR 48, FR 49, §8.6a, LMS 319, LMS 327.
 *
 * A delegation hands over the approvals somebody owes other people, never a say over their
 * own leave — otherwise the lone HR officer whose own request stands at her desk could grant
 * herself an approver this morning.
 */
export function delegationsThatBearOn<T extends { approverId: string }>(
  delegations: readonly T[],
  requesterId: string,
): T[] {
  return delegations.filter((one) => one.approverId !== requesterId);
}

/** Who is answering for whom, as ids at each desk. FR 49. */
export function delegatesOf(
  delegations: readonly ApprovalDelegation[],
  approverIds: readonly string[],
): string[] {
  return [
    ...new Set(
      delegations
        .filter((one) => approverIds.includes(one.approverId))
        .map((one) => one.delegateId),
    ),
  ];
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidDelegation(
      field,
      field === 'approverId'
        ? 'A delegation says whose approvals are being handed over.'
        : 'A delegation says who is answering them.',
    );
  }

  return value.trim();
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidDelegation(
      field,
      `The ${field === 'from' ? 'first' : 'last'} day a delegate answers is a date in the ` +
        'form YYYY-MM-DD.',
    );
  }

  return value;
}

/** Blank is nothing, as it is on a decision's comment. */
function readBecause(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const said = value.trim();

  return said === '' ? null : said;
}

/** The day an instant fell on, for the sentence above. NFR DAT 03. */
function dayOf(instant: Date | null): CalendarDate {
  return calendarDateIn(instant ?? new Date(), 'UTC');
}
