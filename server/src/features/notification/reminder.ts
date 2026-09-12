/**
 * Chasing whoever a request is waiting on, every day until they decide it. FR 50, FR 60, §7.1., LMS 330.
 */

import { type LeaveRequest, noticeGiven } from '../leave-request/leave-request.js';
import {
  inDays,
  leaveInWords,
  type NewNotice,
  type NoticeEvent,
  validateNotice,
} from './notification.js';
import { fillIn, ORIGINAL_WORDING, type Wording } from './wording.js';
import { type CalendarDate, calendarDateIn, formatDay } from '../../shared/time.js';

/** The one event a reminder is written under. FR 50. */
export const REMINDER_EVENT: NoticeEvent = 'STILL_WAITING';

/** One reminder that has already gone, as the job reads them back. FR 50. */
export interface ReminderSent {
  /** The approver who was chased. */
  employeeId: string;
  leaveRequestId: string;
}

/** Everything one reminder is composed from, and nothing else. FR 50, FR 60. */
export interface WhatIsWaiting {
  /** Who is being chased: somebody at the desk it sits at. FR 48, FR 49, FR 60. */
  approver: { id: string; firstName: string };
  /** Whose leave it is, named because the message is written to somebody else. */
  employee: { name: string };
  /** The request as it stands, which is where the dates and the day count come from. */
  request: LeaveRequest;
  typeName: string;
  /** The day the waiting is measured against. NFR DAT 03. */
  asAt: CalendarDate;
}

/** How long the person has been waiting for an answer, in whole days. FR 50. */
export function daysWaiting(request: LeaveRequest, asAt: CalendarDate): number {
  return noticeGiven(calendarDateIn(request.submittedAt, 'UTC'), asAt);
}

/** Calendar days until the leave starts, negative once it has. FR 17. */
export function daysUntilItStarts(request: LeaveRequest, asAt: CalendarDate): number {
  return noticeGiven(asAt, request.from);
}

/** Whether this person has already been chased about this request. FR 50. */
export function alreadyReminded(
  sent: readonly ReminderSent[],
  approverId: string,
  leaveRequestId: string,
): boolean {
  return sent.some((one) => one.employeeId === approverId && one.leaveRequestId === leaveRequestId);
}

/**
 * The reminder, for both channels, in HR's wording where there is some. FR 50, FR 59, FR 60, FR 61.
 *
 * Apart from `noticeOf` because it is the one message about nothing having happened.
 */
export function reminderOf(waiting: WhatIsWaiting, wording?: Wording): NewNotice {
  const { approver, employee, request, typeName, asAt } = waiting;

  const leave = leaveInWords({
    firstName: approver.firstName,
    employeeName: employee.name,
    request,
    typeName,
  });

  const waited = daysWaiting(request, asAt);

  const filled = fillIn(wording ?? ORIGINAL_WORDING.STILL_WAITING, {
    ...leave,
    whenAsked:
      waited <= 0
        ? `${employee.name} asked for ${leave.cost} today, and it is waiting on you.`
        : `${employee.name} asked for ${leave.cost} ${inDays(waited)} ago, on ` +
          `${formatDay(calendarDateIn(request.submittedAt, 'UTC'))}, and it is still waiting on you.`,
    whenItStarts: whenItStarts(request, asAt),
  });

  return validateNotice({
    /** FR 60. The approver being chased, never the person whose leave it is. */
    employeeId: approver.id,
    leaveRequestId: request.id,
    event: REMINDER_EVENT,
    subject: filled.subject,
    body: filled.body,
  });
}

/** How close the leave is, which is what makes one of these urgent. FR 17, FR 50. */
function whenItStarts(request: LeaveRequest, asAt: CalendarDate): string {
  const away = daysUntilItStarts(request, asAt);

  if (away < 0) {
    return (
      `The leave started ${inDays(-away)} ago, on ${formatDay(request.from)}, and it is ` +
      'still not decided.'
    );
  }

  if (away === 0) {
    return 'The leave starts today.';
  }

  return away === 1 ? 'The leave starts tomorrow.' : `The leave starts in ${inDays(away)}.`;
}
