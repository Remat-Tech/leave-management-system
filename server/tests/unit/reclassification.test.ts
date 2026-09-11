import { describe, expect, it } from 'vitest';
import {
  InvalidLeaveRequest,
  type LeaveRequest,
  type RequestStatus,
  reclassificationTo,
} from '../../src/features/leave-request/leave-request.js';
import {
  assertItCanBeMovedInto,
  assertTheCertificateStands,
  assertTheDaysAreNotAlreadyMoved,
  CertificateNotUsable,
  DaysAlreadyMoved,
  DaysOutsideTheLeave,
  daysMovedSoFar,
  NotATypeToMoveInto,
  periodToMove,
  type Reclassification,
  reasonForReclassification,
  reclassificationInWords,
} from '../../src/features/leave-request/reclassification.js';
import type { LeaveRequestAttachment } from '../../src/features/leave-request/attachment.js';
import { type LeaveType, validateNewLeaveType } from '../../src/features/leave-type/leave-type.js';

/**
 * Sickness during annual leave, moved to sick leave. FR 32c, §8.6c. LMS 507.
 *
 * Everything pure: which days are being moved, where they may go, what may stand as the
 * certificate, and the one sentence both ledger entries carry. That the days actually move
 * — two balances, two entries, one correlation — is ../integration/sickness-reclassification.test.ts's.
 */

function leaveType(overrides: { code: string; name: string } & Record<string, unknown>): LeaveType {
  return {
    id: overrides.code,
    ...validateNewLeaveType({
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      ...overrides,
    }),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

const ANNUAL = leaveType({ code: 'ANNUAL_TEST', name: 'Annual Leave' });

/** FR 32a. The one thing that makes a type somewhere days may be moved to. §8.6b. */
const SICK = leaveType({
  code: 'SICK_TEST',
  name: 'Sick Leave',
  exceedableWithDocument: true,
});

const COMPASSIONATE = leaveType({ code: 'COMP_TEST', name: 'Compassionate Leave' });

function aRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'request-1',
    employeeId: 'ama',
    leaveTypeId: ANNUAL.id,
    leaveYearId: 'y2026',
    from: '2026-03-02',
    to: '2026-03-06',
    reason: 'A week by the sea',
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 5,
    calendarDays: 5,
    status: 'APPROVED' as RequestStatus,
    awaitingApprovalFrom: null,
    decidedBySingleApprover: false,
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    ...overrides,
  };
}

function aCertificate(overrides: Partial<LeaveRequestAttachment> = {}): LeaveRequestAttachment {
  return {
    id: 'attachment-1',
    leaveRequestId: null,
    heldForEmployeeId: 'ama',
    slot: 1,
    filename: 'certificate.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    checksumSha256: 'a'.repeat(64),
    storageKey: 'b'.repeat(64),
    scanStatus: 'CLEAN',
    scanSignature: null,
    scannedBy: 'the built-in test signature scanner',
    scannedAt: new Date('2026-03-09T09:00:01Z'),
    uploadedBy: 'employee ama',
    uploadedByEmployeeId: 'ama',
    uploadedAt: new Date('2026-03-09T09:00:00Z'),
    ...overrides,
  };
}

function aMove(overrides: Partial<Reclassification> = {}): Reclassification {
  return {
    id: '1',
    leaveRequestId: 'request-1',
    toLeaveTypeId: SICK.id,
    from: '2026-03-03',
    to: '2026-03-04',
    days: 2,
    reason:
      '2 days of Annual Leave moved to Sick Leave, 2026-03-03 to 2026-03-04, ill on a medical certificate',
    correlationId: '0b5f1d3e-0000-4000-8000-00000000abcd',
    certificateId: 'attachment-1',
    recordedBy: 'Ama in HR',
    recordedByEmployeeId: 'hr-1',
    recordedAt: new Date('2026-03-10T09:00:00Z'),
    ...overrides,
  };
}

/* ------------------------------------------- which days, FR 32c's first criterion */

describe('the days being moved', () => {
  /* The whole request, which is what dates left out mean. There is no flag to set. */
  it('are the whole of the leave where no dates are named', () => {
    const request = aRequest();

    expect(periodToMove(request, { toLeaveTypeId: SICK.id, certificateId: '1' })).toEqual({
      from: request.from,
      to: request.to,
    });
  });

  it('and are the dates named, where they are inside the leave', () => {
    expect(
      periodToMove(aRequest(), {
        toLeaveTypeId: SICK.id,
        certificateId: '1',
        from: '2026-03-03',
        to: '2026-03-04',
      }),
    ).toEqual({ from: '2026-03-03', to: '2026-03-04' });
  });

  /* Being ill outside agreed leave is a sick leave request of its own: there is nothing
     here to credit back, and crediting it anyway would invent annual days. */
  it('and cannot reach past either end of it', () => {
    for (const outside of [
      { from: '2026-03-01', to: '2026-03-04' },
      { from: '2026-03-04', to: '2026-03-07' },
      { from: '2026-04-01', to: '2026-04-02' },
    ]) {
      expect(() =>
        periodToMove(aRequest(), { toLeaveTypeId: SICK.id, certificateId: '1', ...outside }),
      ).toThrow(DaysOutsideTheLeave);
    }
  });

  /* One date and not the other is a form half filled in rather than a period. */
  it('and are both dates or neither', () => {
    for (const half of [{ from: '2026-03-03' }, { to: '2026-03-04' }]) {
      expect(() =>
        periodToMove(aRequest(), { toLeaveTypeId: SICK.id, certificateId: '1', ...half }),
      ).toThrow(InvalidLeaveRequest);
    }
  });
});

/* ------------------------------------------------------- and only once, FR 32c */

describe('days a certificate has already moved', () => {
  it('do not move again', () => {
    expect(() =>
      assertTheDaysAreNotAlreadyMoved(aRequest(), { from: '2026-03-04', to: '2026-03-05' }, [
        aMove(),
      ]),
    ).toThrow(DaysAlreadyMoved);
  });

  /* Inclusive at both ends, as every other period in this system is: leave ending on the
     fourth and a move starting on the fourth share the fourth. */
  it('and the overlap is judged at both ends', () => {
    const already = [aMove({ from: '2026-03-03', to: '2026-03-04' })];

    expect(() =>
      assertTheDaysAreNotAlreadyMoved(
        aRequest(),
        { from: '2026-03-04', to: '2026-03-06' },
        already,
      ),
    ).toThrow(DaysAlreadyMoved);

    expect(() =>
      assertTheDaysAreNotAlreadyMoved(
        aRequest(),
        { from: '2026-03-05', to: '2026-03-06' },
        already,
      ),
    ).not.toThrow();
  });

  it('and the refusal names the move that already covers them', () => {
    try {
      assertTheDaysAreNotAlreadyMoved(aRequest(), { from: '2026-03-03', to: '2026-03-03' }, [
        aMove(),
      ]);
      throw new Error('That was accepted, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(DaysAlreadyMoved);
      expect((error as DaysAlreadyMoved).period).toEqual({ from: '2026-03-03', to: '2026-03-04' });
      expect((error as DaysAlreadyMoved).code).toBe('DAYS_ALREADY_MOVED');
    }
  });

  /* The race, where the exclusion constraint refused it rather than a read. The sentence
     says to reload and look rather than pretending to have looked. */
  it('and the same refusal says less when nothing was read', () => {
    const refused = new DaysAlreadyMoved('request-1', null);

    expect(refused.period).toBeNull();
    expect(refused.message).toContain('Reload');
  });

  it('and how many have moved so far is their sum', () => {
    expect(daysMovedSoFar([])).toBe(0);
    expect(daysMovedSoFar([aMove(), aMove({ days: 3 })])).toBe(5);
  });
});

/* --------------------------------------------------------- where they may go, §8.6b */

describe('the type they move into', () => {
  it('is one whose allowance may be exceeded on a document', () => {
    expect(() => assertItCanBeMovedInto(ANNUAL, SICK)).not.toThrow();
  });

  /* A move from a balance to itself is two entries that cancel out and a day nobody can
     account for. */
  it('and is never the type the leave already is', () => {
    expect(() => assertItCanBeMovedInto(ANNUAL, ANNUAL)).toThrow(NotATypeToMoveInto);
  });

  /**
   * And never a type that is refused at its allowance. FR 32a, §8.6b.
   *
   * The days arrive whether or not the balance can afford them — that is what makes this a
   * move rather than a request — so the destination has to be a type that may go past its
   * allowance. It is `exceedable_with_document` and not a code: design principle 5.
   */
  it('and never one that is refused at its allowance instead', () => {
    expect(() => assertItCanBeMovedInto(ANNUAL, COMPASSIONATE)).toThrow(NotATypeToMoveInto);
  });
});

/* ------------------------------------------------- the certificate, FR 13, NFR SEC 07 */

describe('the certificate it stands on', () => {
  it('is a clean file of the person whose leave it is', () => {
    expect(assertTheCertificateStands('ama', aCertificate()).id).toBe('attachment-1');
  });

  it('and is never one nothing has cleared', () => {
    for (const scanStatus of ['PENDING', 'INFECTED'] as const) {
      expect(() => assertTheCertificateStands('ama', aCertificate({ scanStatus }))).toThrow(
        CertificateNotUsable,
      );
    }
  });

  it('and is never somebody else’s, or absent', () => {
    expect(() =>
      assertTheCertificateStands('ama', aCertificate({ heldForEmployeeId: 'kofi' })),
    ).toThrow(CertificateNotUsable);

    expect(() => assertTheCertificateStands('ama', undefined)).toThrow(CertificateNotUsable);
  });

  /* Two sentences, because the two readers are different: one has the wrong file and the
     other has the right file too early. */
  it('and says which of the two it was', () => {
    expect(
      new CertificateNotUsable(aCertificate({ scanStatus: 'PENDING' }), 'ama').message,
    ).toContain('being checked for viruses');

    expect(new CertificateNotUsable(undefined, 'ama').message).toContain('Upload it');
  });
});

/* ------------------------------------------------------------ the one sentence, FR 27 */

describe('what both entries say', () => {
  it('names the two types, the days and the dates', () => {
    expect(
      reasonForReclassification({
        typeName: 'Annual Leave',
        intoName: 'Sick Leave',
        period: { from: '2026-03-03', to: '2026-03-04' },
        days: 2,
      }),
    ).toBe(
      '2 days of Annual Leave moved to Sick Leave, 2026-03-03 to 2026-03-04, ' +
        'ill on a medical certificate',
    );
  });

  it('and counts one day as a day', () => {
    expect(
      reasonForReclassification({
        typeName: 'Annual Leave',
        intoName: 'Sick Leave',
        period: { from: '2026-03-03', to: '2026-03-03' },
        days: 1,
      }),
    ).toContain('1 day of Annual Leave');
  });

  it('and reads as a sentence on a screen as well', () => {
    expect(reclassificationInWords(aMove(), 'Sick Leave')).toContain('became Sick Leave');
  });
});

/* ----------------------------------------------------------- out of what state, §6 */

describe('the leave it comes out of', () => {
  it('is leave every desk has agreed to', () => {
    expect(reclassificationTo(aRequest())).toBe('APPROVED');
  });

  /* Leave still being decided has taken no days, so there is nothing to move; leave that
     ended gave its days back already. */
  it('and nothing else', () => {
    for (const status of [
      'SUBMITTED',
      'UNROUTABLE',
      'WITHDRAWN',
      'CANCELLED',
      'REFUSED',
    ] as const) {
      expect(() => reclassificationTo(aRequest({ status }))).toThrow();
    }
  });
});
