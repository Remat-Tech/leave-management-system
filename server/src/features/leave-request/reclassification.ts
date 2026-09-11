/**
 * Days of agreed leave that turned out to be sickness. FR 32c, §8.6c, FR 13, NFR SEC 07, LMS 507.
 */

import { type LeavePeriod, validateLeavePeriod } from '../leave-calculator/leave-calculator.js';
import {
  attachmentSatisfiesADocumentationRule,
  type LeaveRequestAttachment,
} from './attachment.js';
import { InvalidLeaveRequest, type LeaveRequest, periodsOverlap } from './leave-request.js';
import type { LeaveType } from '../leave-type/leave-type.js';
import { type CalendarDate, formatDay } from '../../shared/time.js';

/** What the caller supplies. Dates omitted mean the whole request. FR 32c. */
export interface ReclassificationAsked {
  /** The type the days become. Named rather than found: there is no `if (code === 'SICK')` here. */
  toLeaveTypeId: string;
  /** Both optional, and both or neither: a single day is the same date twice. */
  from?: CalendarDate | null;
  to?: CalendarDate | null;
  /** FR 13. The file this stands on. */
  certificateId: string;
}

/** The shape a checked one has by the time it reaches the repository. */
export interface ValidatedReclassification {
  leaveRequestId: string;
  toLeaveTypeId: string;
  from: CalendarDate;
  to: CalendarDate;
  days: number;
  /** FR 27. The sentence both ledger entries carry. */
  reason: string;
  correlationId: string;
  certificateId: string;
}

/** One as it comes back out, with who recorded it. FR 52. */
export interface Reclassification extends ValidatedReclassification {
  id: string;
  recordedBy: string;
  recordedByEmployeeId: string | null;
  recordedAt: Date;
}

/* ------------------------------------------------------------------- refusals */

/** Days outside the leave they are said to be part of. FR 32c, NFR USA 03. */
export class DaysOutsideTheLeave extends Error {
  readonly code = 'OUTSIDE_THE_LEAVE';
  readonly leaveRequestId: string;
  readonly period: LeavePeriod;

  constructor(request: LeaveRequest, period: LeavePeriod) {
    super(
      `This leave runs from ${formatDay(request.from)} to ${formatDay(request.to)}, and ` +
        `${formatDay(period.from)} to ${formatDay(period.to)} is not inside it. What moves ` +
        `to sick leave is days somebody was already booked off for; being ill outside agreed ` +
        `leave is a sick leave request of its own. FR 32c.`,
    );
    this.name = 'DaysOutsideTheLeave';
    this.leaveRequestId = request.id;
    this.period = { ...period };
  }
}

/**
 * Days that have already been moved once. FR 32c.
 *
 * `already` is null where the exclusion constraint refused this rather than a read — two
 * tabs pressing together — and the sentence says to look rather than pretending to have.
 */
export class DaysAlreadyMoved extends Error {
  readonly code = 'DAYS_ALREADY_MOVED';
  readonly leaveRequestId: string;
  /** The move that already covers them, where one was read. */
  readonly period: LeavePeriod | null;

  constructor(leaveRequestId: string, already: Reclassification | null) {
    super(
      already === null
        ? `Some of these days have just been moved to sick leave by somebody else. Reload ` +
            `this leave and look at what has already moved before moving the rest. FR 32c.`
        : `${formatDay(already.from)} to ${formatDay(already.to)} of this leave has already ` +
            `been moved to sick leave. Moving a day twice would credit it back twice and ` +
            `charge it twice. The days either side of it can still be moved. FR 32c.`,
    );
    this.name = 'DaysAlreadyMoved';
    this.leaveRequestId = leaveRequestId;
    this.period = already === null ? null : { from: already.from, to: already.to };
  }
}

/** A destination the days cannot go to. FR 32c, §8.6b. */
export class NotATypeToMoveInto extends Error {
  readonly code = 'NOT_A_TYPE_TO_MOVE_INTO';
  readonly leaveTypeId: string;

  constructor(into: LeaveType, because: 'the same type' | 'not exceedable') {
    super(
      because === 'the same type'
        ? `This leave is already ${into.name}, so there is nowhere to move it to. A move ` +
            `from a balance to itself is two entries that cancel out. FR 32c.`
        : `${into.name} is refused at its allowance rather than exceeded with a document, ` +
            `so days cannot be moved into it: they arrive whether or not the balance can ` +
            `afford them. Sick leave is the type FR 32a makes exceedable. §8.6b.`,
    );
    this.name = 'NotATypeToMoveInto';
    this.leaveTypeId = into.id;
  }
}

/** A certificate that is somebody else's, or that nothing has cleared. FR 13, NFR SEC 07. */
export class CertificateNotUsable extends Error {
  readonly code = 'CERTIFICATE_NOT_USABLE';
  readonly field = 'certificateId';
  readonly attachmentId: string | null;

  constructor(attachment: LeaveRequestAttachment | undefined, employeeId: string) {
    super(whyItCannotStand(attachment, employeeId));
    this.name = 'CertificateNotUsable';
    this.attachmentId = attachment?.id ?? null;
  }
}

function whyItCannotStand(
  attachment: LeaveRequestAttachment | undefined,
  employeeId: string,
): string {
  if (attachment === undefined || attachment.heldForEmployeeId !== employeeId) {
    return (
      'Moving agreed leave to sick leave stands on a medical certificate for the person ' +
      'whose leave it is. Upload it against their record first, and name it here. FR 13, FR 32c.'
    );
  }

  return attachment.scanStatus === 'INFECTED'
    ? 'The scanner refused this file, so it cannot stand as a certificate. Send a clean ' +
        'copy — a photograph of the certificate is usually enough. NFR SEC 07.'
    : 'This file is still being checked for viruses and cannot count until that is done. ' +
        'Nothing has cleared it, so nothing can be let through on it. NFR SEC 07.';
}

/* ------------------------------------------------------------- what is valid */

/**
 * Which days are being moved: the ones asked for, or the whole request. FR 32c.
 *
 * The story's first criterion, and the reason the dates are optional rather than a flag.
 */
export function periodToMove(request: LeaveRequest, asked: ReclassificationAsked): LeavePeriod {
  const said = asked.from ?? asked.to;

  if (said === undefined || said === null) {
    return { from: request.from, to: request.to };
  }

  if (
    asked.from === undefined ||
    asked.from === null ||
    asked.to === undefined ||
    asked.to === null
  ) {
    throw new InvalidLeaveRequest(
      asked.from === undefined || asked.from === null ? 'from' : 'to',
      'Moving part of agreed leave needs both dates. Leave them both out to move the whole ' +
        'of it; a single day is the same date twice.',
    );
  }

  const period = validateLeavePeriod({ from: asked.from, to: asked.to });

  if (period.from < request.from || period.to > request.to) {
    throw new DaysOutsideTheLeave(request, period);
  }

  return period;
}

/**
 * Refuses days a certificate has already moved. FR 32c.
 *
 * `leave_request_reclassification_covers_each_day_once` says the same where two tabs press
 * together; this is where the sentence naming the earlier move is.
 */
export function assertTheDaysAreNotAlreadyMoved(
  request: LeaveRequest,
  period: LeavePeriod,
  already: readonly Reclassification[],
): void {
  const clash = already.find((moved) => periodsOverlap(period, { from: moved.from, to: moved.to }));

  if (clash !== undefined) {
    throw new DaysAlreadyMoved(request.id, clash);
  }
}

/** Refuses a destination the days cannot go to. FR 32c, §8.6b. */
export function assertItCanBeMovedInto(from: LeaveType, into: LeaveType): void {
  if (from.id === into.id) {
    throw new NotATypeToMoveInto(into, 'the same type');
  }

  if (!into.exceedableWithDocument) {
    throw new NotATypeToMoveInto(into, 'not exceedable');
  }
}

/** Refuses anything but a clean file of this person's. FR 13, NFR SEC 07. */
export function assertTheCertificateStands(
  employeeId: string,
  certificate: LeaveRequestAttachment | undefined,
): LeaveRequestAttachment {
  if (
    certificate === undefined ||
    certificate.heldForEmployeeId !== employeeId ||
    !attachmentSatisfiesADocumentationRule(certificate)
  ) {
    throw new CertificateNotUsable(certificate, employeeId);
  }

  return certificate;
}

/**
 * The one sentence both entries carry. FR 27, FR 32c.
 *
 * Read from either side: the annual balance says the days went to sick leave, the sick
 * balance says they came from annual, and the dates say which days.
 */
export function reasonForReclassification(input: {
  typeName: string;
  intoName: string;
  period: LeavePeriod;
  days: number;
}): string {
  const { typeName, intoName, period, days } = input;

  return (
    `${days} ${days === 1 ? 'day' : 'days'} of ${typeName} moved to ${intoName}, ` +
    `${period.from} to ${period.to}, ill on a medical certificate`
  );
}

/** How many days of one request have moved so far. */
export function daysMovedSoFar(already: readonly Reclassification[]): number {
  return already.reduce((total, moved) => total + moved.days, 0);
}

/** One move, in the words the person whose leave it is reads. NFR USA 03. */
export function reclassificationInWords(moved: Reclassification, intoName: string): string {
  return (
    `${moved.days} ${moved.days === 1 ? 'day' : 'days'} of this leave — ` +
    `${formatDay(moved.from)} to ${formatDay(moved.to)} — became ${intoName} on a medical ` +
    `certificate. The days went back into the balance they came out of.`
  );
}
