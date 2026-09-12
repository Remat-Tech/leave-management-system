/** An email, filled in on a made up request, so HR can read it before saving. FR 61, LMS 512. */

import type { LeaveRequest } from '../leave-request/leave-request.js';
import { noticeOf, type WhatHappened } from './notification.js';
import { reminderOf } from './reminder.js';
import type { EmailName, Wording } from './wording.js';

const EXAMPLE_REQUEST: LeaveRequest = {
  id: '0',
  employeeId: '1',
  leaveTypeId: '1',
  leaveYearId: '1',
  from: '2026-03-02',
  to: '2026-03-10',
  reason: null,
  lateEntryReason: null,
  evidenceRequired: false,
  certifiedDays: 0,
  countingBasis: 'WORKING_DAYS',
  days: 6,
  calendarDays: 9,
  status: 'SUBMITTED',
  awaitingApprovalFrom: 'HR',
  decidedBySingleApprover: false,
  submittedAt: new Date('2026-02-20T09:00:00Z'),
  createdAt: new Date('2026-02-20T09:00:00Z'),
  updatedAt: new Date('2026-02-20T09:00:00Z'),
};

const EMPLOYEE = { id: '1', firstName: 'Ama', name: 'Ama Mensah' };

/** The emails written to somebody other than the person taking the leave. */
const TO_SOMEBODY_ELSE: readonly EmailName[] = [
  'DECISION_OVERTURNED',
  'UNROUTABLE_FOR_HR',
  'REASSIGNED',
  'WITHDRAWAL_ASKED',
];

/** The wording, filled in the way it would be sent. */
export function previewOf(name: EmailName, wording: Wording): Wording {
  const { subject, body } =
    name === 'STILL_WAITING'
      ? reminderOf(
          {
            approver: { id: '2', firstName: 'Kofi' },
            employee: EMPLOYEE,
            request: EXAMPLE_REQUEST,
            typeName: 'Annual Leave',
            asAt: '2026-02-24',
          },
          wording,
        )
      : noticeOf(exampleOf(name), wording);

  return { subject, body };
}

function exampleOf(name: Exclude<EmailName, 'STILL_WAITING'>): WhatHappened {
  return {
    event: name === 'UNROUTABLE_FOR_HR' ? 'UNROUTABLE' : name,
    employee: EMPLOYEE,
    recipient: TO_SOMEBODY_ELSE.includes(name) ? { id: '2', firstName: 'Kofi' } : undefined,
    request: EXAMPLE_REQUEST,
    typeName: 'Annual Leave',
    decidedBy: 'MANAGER',
    comment: 'Two of the team are already away that week.',
    availableAfter: 14,
    overturned: { desk: 'MANAGER', said: 'APPROVE' },
    daysBack: 2,
    movedInto: { typeName: 'Sick Leave', availableAfter: 8 },
    declared: { name: 'Founders’ Day', date: '2026-03-04' },
  };
}
