import { describe, expect, it } from 'vitest';
import { type Actor, signedInAs, theSystem } from '../../src/auth/actor.js';
import type {
  LeaveRequest,
  RequestStatus,
} from '../../src/features/leave-request/leave-request.js';
import { leaveRequestPolicy } from '../../src/features/leave-request/policy.js';
import {
  NothingToReverse,
  reasonForReversal,
  ReversalNeedsAReason,
  reversalOf,
  TooLateToReverse,
  validateReversal,
} from '../../src/features/leave-request/reversal.js';

/** The Chief Executive reversing a request every desk has finished deciding. */

const TODAY = '2026-09-17';

function aRequest(status: RequestStatus, from = '2026-10-05'): LeaveRequest {
  return {
    id: '41',
    employeeId: '11',
    leaveTypeId: '1',
    leaveYearId: '1',
    from,
    to: '2026-10-09',
    reason: null,
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 5,
    calendarDays: 5,
    status,
    awaitingApprovalFrom: null,
    decidedBySingleApprover: false,
    submittedAt: new Date('2026-09-01T09:00:00Z'),
    createdAt: new Date('2026-09-01T09:00:00Z'),
    updatedAt: new Date('2026-09-01T09:00:00Z'),
  };
}

const chief: Actor = signedInAs('1', {
  roles: ['EMPLOYEE'],
  isManager: true,
  isChiefExecutive: true,
});
const hr: Actor = signedInAs('5', { roles: ['EMPLOYEE', 'HR_ADMIN'], isManager: false });
const theirs = { employeeId: '11', managerId: '7' };

describe('which reversal applies', () => {
  it('turns approved leave down, before it starts', () => {
    expect(reversalOf(aRequest('APPROVED'), TODAY)).toEqual({
      action: 'REVERSE_APPROVAL',
      to: 'REFUSED',
    });
  });

  it('but not once it has started', () => {
    expect(() => reversalOf(aRequest('APPROVED', TODAY), TODAY)).toThrow(TooLateToReverse);
    expect(() => reversalOf(aRequest('APPROVED', '2026-09-01'), TODAY)).toThrow(TooLateToReverse);
  });

  it('approves refused leave, whenever it was for', () => {
    expect(reversalOf(aRequest('REFUSED', '2026-01-05'), TODAY)).toEqual({
      action: 'REVERSE_REFUSAL',
      to: 'APPROVED',
    });
  });

  it('and has nothing to reverse on leave still being decided or taken back', () => {
    for (const status of ['SUBMITTED', 'UNROUTABLE', 'WITHDRAWN', 'CANCELLED'] as const) {
      expect(() => reversalOf(aRequest(status), TODAY)).toThrow(NothingToReverse);
    }
  });
});

describe('what it has to say', () => {
  it('needs a reason', () => {
    expect(() =>
      validateReversal({ leaveRequestId: '41', action: 'REVERSE_APPROVAL', reason: '  ' }),
    ).toThrow(ReversalNeedsAReason);
  });

  it('names the leave and the direction on the ledger', () => {
    expect(reasonForReversal('Annual Leave', aRequest('APPROVED'), 'REVERSE_APPROVAL')).toBe(
      '5 days of Annual Leave, 2026-10-05 to 2026-10-09: approval reversed by the Chief Executive, days given back',
    );
  });
});

describe('who may', () => {
  it('lets the Chief Executive see everybody’s leave, and nobody else that page', () => {
    expect(leaveRequestPolicy.listEveryone(chief).allowed).toBe(true);
    expect(leaveRequestPolicy.read(chief, theirs).allowed).toBe(true);

    expect(leaveRequestPolicy.listEveryone(hr).allowed).toBe(false);
    expect(leaveRequestPolicy.listEveryone(theSystem('a test')).allowed).toBe(false);
  });

  it('lets only the Chief Executive reverse, and never their own leave', () => {
    expect(leaveRequestPolicy.reverse(chief, 'REVERSE_APPROVAL', theirs).allowed).toBe(true);
    expect(leaveRequestPolicy.reverse(chief, 'REVERSE_REFUSAL', theirs).allowed).toBe(true);

    expect(leaveRequestPolicy.reverse(hr, 'REVERSE_APPROVAL', theirs).allowed).toBe(false);
    expect(
      leaveRequestPolicy.reverse(chief, 'REVERSE_REFUSAL', { employeeId: '1', managerId: null })
        .allowed,
    ).toBe(false);
  });
});
