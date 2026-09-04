import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_CONTENT_TYPES,
  AttachmentTooLarge,
  AttachmentsAreClosed,
  InvalidAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
  acceptedInWords,
  assertAttachmentsAreOpen,
  assertItIsNotTheLastEvidence,
  attachmentSatisfiesADocumentationRule,
  DocumentationCannotBeRemoved,
  evidenceOn,
  type LeaveRequestAttachment,
  nextFreeSlot,
  sniffContentType,
  validateContent,
  validateFilename,
} from '../../src/features/leave-request/attachment.js';
import type {
  LeaveRequest,
  RequestStatus,
} from '../../src/features/leave-request/leave-request.js';
import type { LeaveType } from '../../src/features/leave-type/leave-type.js';
import { validateNewLeaveType } from '../../src/features/leave-type/leave-type.js';
import { createScanner, ScannerUnavailable } from '../../src/scanning/index.js';

/**
 * Evidence on a request. FR 12, FR 13, NFR SEC 07. LMS 310.
 *
 * Everything pure: what the bytes are, what a name may be, which seat a file takes, and
 * whether a documentation rule is met by what is attached. That the row is written, the
 * bytes stored and the standing enforced is ../integration/attachment.test.ts's.
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

const SICK = leaveType({
  code: 'SICK_TEST',
  name: 'Sick Leave',
  documentation: 'AFTER_DAYS',
  documentationAfterDays: 3,
});

const ANNUAL = leaveType({ code: 'ANNUAL_TEST', name: 'Annual Leave' });

function aRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'request-1',
    employeeId: 'ama',
    leaveTypeId: SICK.id,
    leaveYearId: 'y2026',
    from: '2026-03-02',
    to: '2026-03-06',
    reason: null,
    lateEntryReason: null,
    evidenceRequired: false,
    countingBasis: 'WORKING_DAYS',
    days: 5,
    calendarDays: 5,
    status: 'SUBMITTED' as RequestStatus,
    awaitingApprovalFrom: 'MANAGER',
    submittedAt: new Date('2026-02-25T09:00:00Z'),
    createdAt: new Date('2026-02-25T09:00:00Z'),
    updatedAt: new Date('2026-02-25T09:00:00Z'),
    ...overrides,
  };
}

function anAttachment(overrides: Partial<LeaveRequestAttachment> = {}): LeaveRequestAttachment {
  return {
    id: 'attachment-1',
    leaveRequestId: 'request-1',
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
    scannedAt: new Date('2026-02-25T09:00:01Z'),
    uploadedBy: 'employee ama',
    uploadedByEmployeeId: 'ama',
    uploadedAt: new Date('2026-02-25T09:00:00Z'),
    ...overrides,
  };
}

/* -------------------------------------------------------------------- sniffing */

/** A PDF, a JPEG and a PNG are their first bytes and nothing else. */
const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
const A_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const A_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

/** A minimal zip, built so the DOCX check has a real central directory to read. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(body);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const entry = Buffer.concat([local, nameBytes, deflated]);
    locals.push(entry);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(deflated.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([header, nameBytes]));
    offset += entry.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

const A_DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  '_rels/.rels': '<Relationships/>',
  'word/document.xml': '<document/>',
});

const AN_XLSX = zip({
  '[Content_Types].xml': '<Types/>',
  'xl/workbook.xml': '<workbook/>',
});

describe('what the bytes are, rather than what they are called', () => {
  it('reads a PDF', () => {
    expect(sniffContentType(A_PDF)).toBe('application/pdf');
  });

  it('reads a JPEG', () => {
    expect(sniffContentType(A_JPEG)).toBe('image/jpeg');
  });

  it('reads a PNG', () => {
    expect(sniffContentType(A_PNG)).toBe('image/png');
  });

  /* A DOCX is a zip, so the archive's own list of entries is what tells it apart. */
  it('reads a DOCX by the entries inside it', () => {
    expect(sniffContentType(A_DOCX)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('refuses a spreadsheet, which is the same zip without word/ in it', () => {
    expect(sniffContentType(AN_XLSX)).toBeNull();
  });

  it('refuses a zip that is only a zip', () => {
    expect(sniffContentType(zip({ 'notes.txt': 'hello' }))).toBeNull();
  });

  /* NFR SEC 07, said as plainly as it can be. */
  it('is not fooled by an extension', () => {
    const script = Buffer.from('#!/bin/sh\nrm -rf /\n');

    expect(sniffContentType(script)).toBeNull();
  });

  it('calls a JPEG a JPEG whatever the name claims', () => {
    expect(sniffContentType(A_JPEG)).toBe('image/jpeg');
  });

  it('refuses an empty file and a stub too short to hold any magic', () => {
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
    expect(sniffContentType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('accepts exactly the four types the table holds', () => {
    expect([...ACCEPTED_CONTENT_TYPES]).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    expect(acceptedInWords()).toBe('PDF, JPG, PNG and DOCX');
  });
});

/* ------------------------------------------------------------------ the name */

describe('the name a file arrives under', () => {
  it('keeps an ordinary one', () => {
    expect(validateFilename('  certificate.pdf  ')).toBe('certificate.pdf');
  });

  /* Some browsers send the whole path on some forms, and none of it is ours to keep. */
  it('keeps only the basename of a path', () => {
    expect(validateFilename('C:\\Users\\ama\\Desktop\\note.pdf')).toBe('note.pdf');
    expect(validateFilename('/home/ama/note.pdf')).toBe('note.pdf');
  });

  it('refuses a traversal that leaves nothing behind', () => {
    expect(() => validateFilename('../../etc/passwd')).not.toThrow();
    expect(validateFilename('../../etc/passwd')).toBe('passwd');
    expect(() => validateFilename('../..')).toThrow(InvalidAttachment);
  });

  it('refuses a control character', () => {
    expect(() => validateFilename('note\u0000.pdf')).toThrow(InvalidAttachment);
    expect(() => validateFilename('note\n.pdf')).toThrow(InvalidAttachment);
  });

  it('refuses nothing at all, and says where to put it', () => {
    expect(() => validateFilename('')).toThrow(/X-Filename/);
    expect(() => validateFilename(undefined)).toThrow(InvalidAttachment);
  });

  it('refuses one longer than the column holds', () => {
    expect(() => validateFilename(`${'a'.repeat(256)}.pdf`)).toThrow(/255/);
  });
});

/* ----------------------------------------------------------------- the bytes */

describe('the bytes themselves', () => {
  it('refuses a body that is not bytes', () => {
    expect(() => validateContent({ leaveTypeId: 'annual' })).toThrow(InvalidAttachment);
  });

  it('refuses an empty body', () => {
    expect(() => validateContent(Buffer.alloc(0))).toThrow(InvalidAttachment);
  });

  it('accepts a file on the cap and refuses the byte past it', () => {
    expect(validateContent(Buffer.alloc(MAX_ATTACHMENT_BYTES)).byteLength).toBe(
      MAX_ATTACHMENT_BYTES,
    );
    expect(() => validateContent(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).toThrow(
      AttachmentTooLarge,
    );
  });

  /* NFR USA 03: the number the person is looking at, in the unit they think in. */
  it('names both figures in megabytes', () => {
    expect(() => validateContent(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))).toThrow(/10 MB/);
  });
});

/* ------------------------------------------------------------------ the seats */

describe('five files, and the sixth has nowhere to sit', () => {
  it('gives the first file the first seat', () => {
    expect(nextFreeSlot([])).toBe(1);
  });

  it('fills the gap a removed file left rather than the next number up', () => {
    expect(nextFreeSlot([1, 3, 4])).toBe(2);
  });

  it('has nothing to give once all five are taken', () => {
    expect(nextFreeSlot([1, 2, 3, 4, 5])).toBeUndefined();
    expect(MAX_ATTACHMENTS_PER_REQUEST).toBe(5);
  });
});

/* ------------------------------------------------------- when it may be attached */

describe('when evidence may go on, and come off', () => {
  it('goes on while the request is being decided', () => {
    expect(() => assertAttachmentsAreOpen(aRequest(), 'attach to')).not.toThrow();
  });

  it('goes on a request nobody could be found to decide', () => {
    expect(() =>
      assertAttachmentsAreOpen(aRequest({ status: 'UNROUTABLE' }), 'attach to'),
    ).not.toThrow();
  });

  it('does not go on leave that has ended', () => {
    for (const status of ['WITHDRAWN', 'CANCELLED', 'REFUSED'] as const) {
      expect(() => assertAttachmentsAreOpen(aRequest({ status }), 'attach to')).toThrow(
        AttachmentsAreClosed,
      );
    }
  });

  /* A file a desk could already have read is part of why the leave was decided. */
  it('comes off only while it is still submitted', () => {
    expect(() => assertAttachmentsAreOpen(aRequest(), 'remove from')).not.toThrow();
    expect(() => assertAttachmentsAreOpen(aRequest({ status: 'APPROVED' }), 'remove from')).toThrow(
      AttachmentsAreClosed,
    );
  });
});

/* --------------------------- the file a request was let through on, FR 13, LMS 311 */

describe('taking the last of a request’s evidence back off it', () => {
  /* FR 13, LMS 311. A request that could not have been made without a certificate. */
  const NEEDED_ONE = aRequest({ evidenceRequired: true });

  const CERTIFICATE = anAttachment({ id: 'attachment-1' });
  const A_SECOND = anAttachment({ id: 'attachment-2', slot: 2 });

  /**
   * The hole LMS 310 could not have had, because nothing required anything.
   *
   * Evidence that arrives with the request and is removed a minute later is evidence that
   * was chased after all, and the request is left on the books in a state submission would
   * have refused.
   */
  it('is refused where it is the only thing standing as it', () => {
    expect(() => assertItIsNotTheLastEvidence(NEEDED_ONE, CERTIFICATE, [CERTIFICATE])).toThrow(
      DocumentationCannotBeRemoved,
    );
  });

  it('and allowed where another usable file is behind it', () => {
    expect(() =>
      assertItIsNotTheLastEvidence(NEEDED_ONE, CERTIFICATE, [CERTIFICATE, A_SECOND]),
    ).not.toThrow();
  });

  /* NFR SEC 07. A file nothing has cleared is not what is holding the request up. */
  it('and is not held back by a file that counts for nothing', () => {
    const unscanned = anAttachment({ id: 'attachment-2', slot: 2, scanStatus: 'PENDING' });

    expect(() =>
      assertItIsNotTheLastEvidence(NEEDED_ONE, CERTIFICATE, [CERTIFICATE, unscanned]),
    ).toThrow(DocumentationCannotBeRemoved);

    /* And removing the unscanned one takes nothing away, so it goes. */
    expect(() =>
      assertItIsNotTheLastEvidence(NEEDED_ONE, unscanned, [CERTIFICATE, unscanned]),
    ).not.toThrow();
  });

  it('and asks nothing of a request no rule applied to', () => {
    expect(() =>
      assertItIsNotTheLastEvidence(aRequest(), CERTIFICATE, [CERTIFICATE]),
    ).not.toThrow();
  });
});

/* -------------------------------------------------- what satisfies a requirement */

describe('an unscanned file satisfies nothing', () => {
  it('counts a clean file', () => {
    expect(attachmentSatisfiesADocumentationRule(anAttachment())).toBe(true);
  });

  it('does not count one nothing has looked at', () => {
    expect(attachmentSatisfiesADocumentationRule(anAttachment({ scanStatus: 'PENDING' }))).toBe(
      false,
    );
  });

  it('does not count an infected one', () => {
    expect(attachmentSatisfiesADocumentationRule(anAttachment({ scanStatus: 'INFECTED' }))).toBe(
      false,
    );
  });
});

describe('whether a request has the documentation it needs', () => {
  /* FR 13, LMS 311. Five days of sick leave that was let through on a certificate. */
  const NEEDS_ONE = aRequest({ days: 5, evidenceRequired: true });

  it('is unsatisfied where the rule applied and nothing is attached', () => {
    const evidence = evidenceOn(SICK, NEEDS_ONE, []);

    expect(evidence.required).toBe(true);
    expect(evidence.satisfied).toBe(false);
    expect(evidence.inWords).toContain('PDF, JPG, PNG and DOCX');
  });

  it('is satisfied by one clean file', () => {
    expect(evidenceOn(SICK, NEEDS_ONE, [anAttachment()]).satisfied).toBe(true);
  });

  /* NFR SEC 07, and the whole point of holding the verdict on the row. */
  it('is not satisfied by a file the scanner has not answered for', () => {
    const evidence = evidenceOn(SICK, NEEDS_ONE, [anAttachment({ scanStatus: 'PENDING' })]);

    expect(evidence.satisfied).toBe(false);
    expect(evidence.attached).toBe(1);
    expect(evidence.usable).toBe(0);
    expect(evidence.inWords).toContain('still being checked');
  });

  it('is satisfied where nothing was asked of it, attached or not', () => {
    const short = aRequest({ leaveTypeId: ANNUAL.id, days: 2 });

    expect(evidenceOn(ANNUAL, short, []).required).toBe(false);
    expect(evidenceOn(ANNUAL, short, []).satisfied).toBe(true);
  });

  /**
   * LMS 311, and it is the change worth pinning: `required` is the *request's* answer, not
   * the type's as it now stands.
   *
   * Before this story the two were the same question, and they cannot be. FR 32a's threshold
   * is the balance, which has moved by the time an approver opens the page; FR 13's is a rule
   * HR may reword this afternoon. A screen that recomputed it would tell an approver what
   * today's rule says about leave that was allowed under a different one.
   */
  it('reports what the leave was allowed on rather than what the type says now', () => {
    const fourDays = aRequest({ days: 4, evidenceRequired: false });

    expect(evidenceOn(SICK, fourDays, []).required).toBe(false);
    expect(evidenceOn(SICK, fourDays, []).satisfied).toBe(true);

    /* And the other way: a two day absence that went past the sick allowance. FR 32a. */
    expect(evidenceOn(SICK, aRequest({ days: 2, evidenceRequired: true }), []).required).toBe(true);
  });
});

/* ----------------------------------------------------------------- the scanner */

describe('the scanner the environment builds', () => {
  it('flags the EICAR test file', async () => {
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );

    const result = await createScanner({ SCANNER_DRIVER: 'signature' } as NodeJS.ProcessEnv).scan(
      eicar,
    );

    expect(result.verdict).toBe('INFECTED');
    expect(result.signature).toBe('EICAR-Test-File');
  });

  it('calls an ordinary certificate clean', async () => {
    const result = await createScanner({ SCANNER_DRIVER: 'signature' } as NodeJS.ProcessEnv).scan(
      A_PDF,
    );

    expect(result.verdict).toBe('CLEAN');
    expect(result.signature).toBeNull();
  });

  /* NFR SEC 07: nothing may be assumed clean because nothing looked at it. */
  it('answers nothing at all when it is off, rather than clean', async () => {
    await expect(
      createScanner({ SCANNER_DRIVER: 'off' } as NodeJS.ProcessEnv).scan(A_PDF),
    ).rejects.toThrow(ScannerUnavailable);
  });

  it('refuses a driver it does not have', () => {
    expect(() => createScanner({ SCANNER_DRIVER: 'clamav' } as NodeJS.ProcessEnv)).toThrow(
      /Unknown SCANNER_DRIVER/,
    );
  });
});
