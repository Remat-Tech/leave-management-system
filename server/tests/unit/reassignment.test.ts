import { describe, expect, it } from 'vitest';
import type { ApproverRole } from '../../src/features/leave-type/approval-chain.js';
import type {
  LeaveRequest,
  RequestStatus,
} from '../../src/features/leave-request/leave-request.js';
import {
  lineMoved,
  reassignmentFor,
  reassignmentInWords,
  requestsThatFollow,
} from '../../src/features/leave-request/reassignment.js';

/**
 * Pending leave follows the reporting line. FR 07, §8.4, LMS 325.
 *
 * The pure half: which requests a moved line carries, and what the record of the handover
 * says. Which people the desks resolve to is a database question and is
 * ../integration/reassignment.test.ts's.
 */

function aRequestIn(status: RequestStatus, awaiting: ApproverRole | null = null): LeaveRequest {
  return {
    id: 'request-1',
    employeeId: 'adwoa',
    leaveTypeId: 'annual',
    leaveYearId: '2026',
    from: '2026-03-02',
    to: '2026-03-10',
    reason: 'My sister is getting married',
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 6,
    calendarDays: 9,
    status,
    awaitingApprovalFrom: status === 'SUBMITTED' ? awaiting : null,
    decidedBySingleApprover: false,
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
  };
}

describe('a reporting line that moved', () => {
  it('carried nothing where the manager is the one already on the record', () => {
    expect(lineMoved({ employeeId: 'adwoa', from: 'kofi', to: 'kofi' })).toBe(false);
    expect(lineMoved({ employeeId: 'adwoa', from: 'kofi', to: 'akosua' })).toBe(true);
    /** FR 04. Gaining a manager and losing one are both moves. */
    expect(lineMoved({ employeeId: 'adwoa', from: null, to: 'akosua' })).toBe(true);
    expect(lineMoved({ employeeId: 'adwoa', from: 'kofi', to: null })).toBe(true);
  });
});

/* --------------------------------------------------------- which requests follow */

describe('the requests a moved line carries', () => {
  it('takes the stage waiting at the manager’s desk', () => {
    const waiting = aRequestIn('SUBMITTED', 'MANAGER');

    expect(requestsThatFollow([waiting])).toEqual([waiting]);
  });

  /** FR 48b, LMS 320. An empty manager's desk is one of the things that strands a request. */
  it('and one that stopped because nobody could decide it', () => {
    const stuck = aRequestIn('UNROUTABLE');

    expect(requestsThatFollow([stuck])).toEqual([stuck]);
  });

  /**
   * And leaves everything a desk has already answered where it is. FR 44, the second criterion.
   *
   * A stage that decided moved the request off that desk, so a request sitting at HR is one
   * whose manager's stage is settled — by an approval, a refusal or a recorded skip. Carrying
   * it would re-ask a question somebody has answered and put their name on a stage they are
   * no longer at.
   */
  it('and leaves alone every request no longer waiting on a manager', () => {
    const elsewhere = [
      aRequestIn('SUBMITTED', 'HR'),
      aRequestIn('SUBMITTED', 'CEO'),
      aRequestIn('APPROVED'),
      aRequestIn('REFUSED'),
      aRequestIn('WITHDRAWN'),
      aRequestIn('CANCELLED'),
    ];

    expect(requestsThatFollow(elsewhere)).toEqual([]);
  });
});

/* ------------------------------------------------------------- what is recorded */

describe('the handover recorded', () => {
  const move = { employeeId: 'adwoa', from: 'kofi', to: 'akosua' };

  /* The ordinary case, and the one nothing else in the schema would show: the desk is the
     reporting line, so the column does not move and the person does. */
  it('says the desk stayed and the person changed', () => {
    const recorded = reassignmentFor(
      aRequestIn('SUBMITTED', 'MANAGER'),
      { awaiting: 'MANAGER' },
      move,
    );

    expect(recorded).toMatchObject({
      movedFrom: 'MANAGER',
      movedTo: 'MANAGER',
      from: 'kofi',
      to: 'akosua',
    });
    expect(recorded.because).toContain('now theirs to decide');
  });

  /** FR 48b. The new manager cannot answer it, so the stage went to the stand-in. */
  it('and says where the stage went when the desk itself moved', () => {
    const recorded = reassignmentFor(aRequestIn('SUBMITTED', 'MANAGER'), { awaiting: 'HR' }, move);

    expect(recorded).toMatchObject({ movedFrom: 'MANAGER', movedTo: 'HR' });
    expect(recorded.because).toContain('HR');
    expect(recorded.because).toContain('Nobody approved it on the way');
  });

  /** FR 04. The person is now the head of the organisation, so the desk emptied under them. */
  it('and says the request stopped where nobody is left to ask', () => {
    const recorded = reassignmentFor(
      aRequestIn('SUBMITTED', 'MANAGER'),
      { awaiting: null },
      { employeeId: 'adwoa', from: 'kofi', to: null },
    );

    expect(recorded).toMatchObject({ movedFrom: 'MANAGER', movedTo: null, to: null });
    expect(recorded.because).toContain('no longer has a manager');
    expect(recorded.because).toContain('stopped there');
  });

  /* Never blank, whatever the shape: `leave_request_reassignment_says_why` refuses a row
     that does not explain itself. */
  it('and always says why', () => {
    const desks: (ApproverRole | null)[] = ['MANAGER', 'HR', 'CEO', null];

    for (const movedFrom of desks) {
      for (const movedTo of desks) {
        const words = reassignmentInWords({ movedFrom, movedTo, from: 'kofi', to: 'akosua' });

        expect(words.trim()).not.toBe('');
      }
    }
  });
});
