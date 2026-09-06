/**
 * Attaching evidence to a request. FR 12, FR 13, NFR SEC 04, NFR SEC 07. LMS 310.
 */

import type { Actor } from '../../auth/actor.js';
import type { Attribution } from '../audit/audit.js';
import type { BalanceOwner } from '../balance/policy.js';
import { type Employee, EmployeeNotFound } from '../employee/employee.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { Guard } from '../../auth/policy.js';
import type { LeaveRequest } from './leave-request.js';
import { LeaveRequestNotFound } from './leave-request.js';
import type { LeaveRequestRepository } from './leave-request.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { OrganisationRepository } from '../organisation/organisation.db.js';
import type { Storage } from '../../storage/index.js';
import { type ScanResult, type Scanner, ScannerUnavailable } from '../../scanning/index.js';
import { leaveRequestPolicy } from './policy.js';
import type { AttachmentRepository } from './attachment.db.js';
import {
  AttachmentIsInfected,
  AttachmentNotFound,
  AttachmentNotScanned,
  AttachmentTypeNotAccepted,
  type EvidenceOnARequest,
  InvalidAttachment,
  type LeaveRequestAttachment,
  type ScanStatus,
  TooManyAttachments,
  assertAttachmentsAreOpen,
  assertItIsNotTheLastEvidence,
  countUsable,
  evidenceOn,
  nextFreeSlot,
  sniffContentType,
  validateContent,
  validateFilename,
} from './attachment.js';

/** What a request holds, and whether FR 13 is met by it. */
export interface AttachmentsOnARequest {
  leaveRequestId: string;
  attachments: LeaveRequestAttachment[];
  evidence: EvidenceOnARequest;
}

/** What one person has uploaded and not yet asked for leave with. FR 13, LMS 311. */
export interface AttachmentsWaiting {
  employeeId: string;
  attachments: LeaveRequestAttachment[];
  /** How many of them could stand as documentation today. NFR SEC 07. */
  usable: number;
  inWords: string;
}

/** One file, with its bytes, for a download. */
export interface AttachmentContent {
  attachment: LeaveRequestAttachment;
  content: Buffer;
}

/** What arrives at the door. The content type sent is recorded and never believed. */
export interface UploadedFile {
  filename: unknown;
  content: unknown;
  /** What the client claimed, for the refusal's message alone. NFR SEC 07. */
  claimedContentType?: string;
}

export class AttachmentService {
  constructor(
    /* NFR SEC 02. Required rather than defaulted; see ../../auth/policy.ts. */
    private readonly guard: Guard,
    private readonly attachments: AttachmentRepository,
    private readonly requests: LeaveRequestRepository,
    /** Whose leave it is, which a request id cannot say by itself. */
    private readonly employees: EmployeeRepository,
    /** FR 13. Whether this length of this type asks for documentation. */
    private readonly types: LeaveTypeRepository,
    /** FR 48c. Who the `CEO` desk resolves to, for an approver reading a certificate. */
    private readonly organisation: OrganisationRepository,
    /** NFR SEC 04. The only thing that knows where bytes live. */
    private readonly storage: Storage,
    /** NFR SEC 07. */
    private readonly scanner: Scanner,
  ) {}

  /**
   * Attaches one file. FR 12, NFR SEC 07.
   *
   * In this order, and each step is refused before the next costs anything: whose leave,
   * whether it is still open, the size, what the bytes actually are, whether there is a
   * seat, then the scan. Nothing is written and nothing is stored until all of those pass.
   *
   * An infected file is refused outright — no row, no bytes. A scanner that cannot be
   * reached leaves the file `PENDING`, which is kept and satisfies nothing.
   */
  async attach(
    actor: Actor,
    leaveRequestId: string,
    upload: UploadedFile,
  ): Promise<LeaveRequestAttachment> {
    const { request, employee } = await this.theRequest(leaveRequestId);

    this.guard.enforce(leaveRequestPolicy.attach(actor, ownerOf(employee)));

    assertAttachmentsAreOpen(request, 'attach to');

    const taken = (await this.attachments.forRequest(request.id)).map((held) => held.slot);

    return this.store(actor, upload, {
      leaveRequestId: request.id,
      heldForEmployeeId: employee.id,
      seat: nextFreeSlot(taken),
      full: request,
    });
  }

  /**
   * Takes evidence ahead of the request it will go on. FR 13, LMS 311.
   *
   * The half of the story that makes "block submission without an attachment" possible at
   * all: FR 13 is answered while the form is still open, which is before there is a request
   * for anything to hang off. So the file is uploaded, scanned and stored now, and waits
   * under the person's own name until they ask for the leave — see
   * {@link LeaveRequestService.submit}, which puts it on the request in the same transaction
   * as the row itself.
   *
   * Everything else is `attach`'s: the same caps, the same sniffing, the same scanner, and
   * an infected file refused before anything is written.
   */
  async hold(
    actor: Actor,
    employeeId: string,
    upload: UploadedFile,
  ): Promise<LeaveRequestAttachment> {
    const employee = await this.theEmployee(employeeId);

    this.guard.enforce(leaveRequestPolicy.attach(actor, ownerOf(employee)));

    const taken = (await this.attachments.waitingFor(employee.id)).map((held) => held.slot);

    return this.store(actor, upload, {
      leaveRequestId: null,
      heldForEmployeeId: employee.id,
      seat: nextFreeSlot(taken),
      full: null,
    });
  }

  /**
   * Everything an upload is, wherever it is going. FR 12, NFR SEC 07.
   *
   * In this order, and each step is refused before the next costs anything: the size, what
   * the bytes actually are, whether there is a seat, then the scan. Nothing is written and
   * nothing is stored until all of those pass.
   */
  private async store(
    actor: Actor,
    upload: UploadedFile,
    onto: {
      leaveRequestId: string | null;
      heldForEmployeeId: string;
      seat: number | undefined;
      /** The request whose seats are full, for the refusal's sentence. Null for the pile. */
      full: LeaveRequest | null;
    },
  ): Promise<LeaveRequestAttachment> {
    const filename = validateFilename(upload.filename);
    const content = validateContent(upload.content);

    /** NFR SEC 07. The bytes say what this is; the name and the header say nothing. */
    const contentType = sniffContentType(content);

    if (contentType === null) {
      throw new AttachmentTypeNotAccepted(null, upload.claimedContentType ?? '');
    }

    if (onto.seat === undefined) {
      throw new TooManyAttachments(onto.full);
    }

    const scan = await this.scan(content);

    if (scan?.verdict === 'INFECTED') {
      throw new AttachmentIsInfected(scan.signature);
    }

    const stored = await this.storage.put(content);

    try {
      return await this.attachments.add(attributionOf(actor), {
        leaveRequestId: onto.leaveRequestId,
        heldForEmployeeId: onto.heldForEmployeeId,
        slot: onto.seat,
        filename,
        contentType,
        sizeBytes: stored.size,
        checksumSha256: stored.checksumSha256,
        storageKey: stored.key,
        scanStatus: scan === null ? 'PENDING' : 'CLEAN',
        scanSignature: null,
        scannedBy: scan?.scannedBy ?? null,
        scannedAt: scan === null ? null : new Date(),
      });
    } catch (error) {
      /* A row that was refused — the last seat taken while this upload was scanning —
         leaves bytes nothing names. Removed here rather than left for the retention job. */
      await this.storage.delete(stored.key);
      throw error;
    }
  }

  /** What is attached, and whether FR 13's rule is met by it. FR 12, FR 13. */
  async forRequest(actor: Actor, leaveRequestId: string): Promise<AttachmentsOnARequest> {
    const { request } = await this.readable(actor, leaveRequestId);

    const type = await this.types.findById(request.leaveTypeId);

    if (type === undefined) {
      /* Unreachable: a request names a type by foreign key. Answered rather than
         asserted, because the alternative is a requirement nothing can judge. */
      throw new LeaveRequestNotFound(leaveRequestId);
    }

    const attachments = await this.attachments.forRequest(request.id);

    return {
      leaveRequestId: request.id,
      attachments,
      evidence: evidenceOn(type, request, attachments),
    };
  }

  /** What is waiting to go on a request, and how much of it counts. FR 13, LMS 311. */
  async waitingFor(actor: Actor, employeeId: string): Promise<AttachmentsWaiting> {
    const employee = await this.theEmployee(employeeId);

    this.guard.enforce(leaveRequestPolicy.attach(actor, ownerOf(employee)));

    const attachments = await this.attachments.waitingFor(employee.id);
    const usable = countUsable(attachments);

    return {
      employeeId: employee.id,
      attachments,
      usable,
      inWords: waitingInWords(attachments.length, usable),
    };
  }

  /**
   * Throws away a file that never went on a request. FR 12, LMS 311.
   *
   * Addressed by its own id and by nothing else, because there is no request to address it
   * through. Whose it is, is the row's own answer — `held_for_employee_id` — and the policy
   * is asked about that person before the file is admitted to exist.
   */
  async discard(actor: Actor, attachmentId: string): Promise<void> {
    const { attachment } = await this.theWaitingFile(actor, attachmentId);

    if (!(await this.attachments.remove(attachment.id))) {
      /* Two tabs removing the same file. The second is told what the first did. */
      throw new AttachmentNotFound(attachmentId);
    }

    await this.storage.delete(attachment.storageKey);
  }

  /**
   * Asks the scanner again about a waiting file it never answered for. NFR SEC 07, LMS 311.
   *
   * The counterpart of {@link AttachmentService.rescan}, and it matters more here: a
   * `PENDING` file satisfies no documentation rule, so somebody whose scanner was down when
   * they uploaded has evidence that cannot be asked for leave with until this settles it.
   */
  async rescanWaiting(actor: Actor, attachmentId: string): Promise<LeaveRequestAttachment> {
    const { attachment } = await this.theWaitingFile(actor, attachmentId);

    return this.scanAgain(attachment);
  }

  /**
   * The bytes, for somebody who may read the request. NFR SEC 04, NFR SEC 07.
   *
   * Refused for anything not `CLEAN`: an unscanned file is not handed to an approver on
   * the grounds that it is probably fine.
   */
  async download(
    actor: Actor,
    leaveRequestId: string,
    attachmentId: string,
  ): Promise<AttachmentContent> {
    const { request } = await this.readable(actor, leaveRequestId);
    const attachment = await this.onThisRequest(request, attachmentId);

    if (attachment.scanStatus !== 'CLEAN') {
      throw new AttachmentNotScanned(attachment);
    }

    return { attachment, content: await this.storage.get(attachment.storageKey) };
  }

  /**
   * Takes a file back off. FR 12, FR 13.
   *
   * The uploader's standing, and only while the request is still `SUBMITTED` — see
   * {@link assertAttachmentsAreOpen}. The row goes and the bytes go with it.
   *
   * Since LMS 311 there is a second refusal: the last file standing as a required request's
   * documentation stays. `leave_request_attachment_is_what_it_was_allowed_on` holds the same
   * rule behind this one.
   */
  async remove(actor: Actor, leaveRequestId: string, attachmentId: string): Promise<void> {
    const { request, employee } = await this.theRequest(leaveRequestId);

    this.guard.enforce(leaveRequestPolicy.attach(actor, ownerOf(employee)));

    const attachment = await this.onThisRequest(request, attachmentId);

    assertAttachmentsAreOpen(request, 'remove from');

    /** FR 13, LMS 311. */
    assertItIsNotTheLastEvidence(
      request,
      attachment,
      await this.attachments.forRequest(request.id),
    );

    if (!(await this.attachments.remove(attachment.id))) {
      /* Two tabs removing the same file. The second is told what the first did. */
      throw new AttachmentNotFound(attachmentId);
    }

    await this.storage.delete(attachment.storageKey);
  }

  /**
   * Asks the scanner again about a file it never answered for. NFR SEC 07.
   *
   * What makes `PENDING` recoverable. Infected bytes are deleted and the row stays, so the
   * record says a file was attached and what became of it.
   */
  async rescan(
    actor: Actor,
    leaveRequestId: string,
    attachmentId: string,
  ): Promise<LeaveRequestAttachment> {
    const { request, employee } = await this.theRequest(leaveRequestId);

    this.guard.enforce(leaveRequestPolicy.attach(actor, ownerOf(employee)));

    return this.scanAgain(await this.onThisRequest(request, attachmentId));
  }

  /** One more look at a `PENDING` file, wherever it is sitting. NFR SEC 07. */
  private async scanAgain(attachment: LeaveRequestAttachment): Promise<LeaveRequestAttachment> {
    if (attachment.scanStatus !== 'PENDING') {
      return attachment;
    }

    const scan = await this.scan(await this.storage.get(attachment.storageKey));

    if (scan === null) {
      return attachment;
    }

    const settled = await this.attachments.settleScan(
      attachment.id,
      scan.verdict as Exclude<ScanStatus, 'PENDING'>,
      scan.signature,
      scan.scannedBy,
    );

    if (scan.verdict === 'INFECTED') {
      await this.storage.delete(attachment.storageKey);
    }

    /* Undefined where another scan settled it first, which is that scan's answer. */
    return settled ?? (await this.attachments.findById(attachment.id)) ?? attachment;
  }

  /** The verdict, or null where nothing could give one. NFR SEC 07. */
  private async scan(content: Buffer): Promise<ScanResult | null> {
    try {
      return await this.scanner.scan(content);
    } catch (error) {
      if (error instanceof ScannerUnavailable) {
        return null;
      }

      throw error;
    }
  }

  /**
   * A file that is waiting for a request, for somebody who may attach it. FR 13, LMS 311.
   *
   * Standing before existence, as everywhere else here: the row says whose it is, the policy
   * is asked about that person, and a refusal is silent. A file already on a request is *not
   * found* rather than refused — it is addressed through the request it is on, and this
   * address does not reach it.
   */
  private async theWaitingFile(
    actor: Actor,
    attachmentId: string,
  ): Promise<{ attachment: LeaveRequestAttachment; employee: Employee }> {
    const id = requireId(attachmentId, 'attachmentId');
    const attachment = await this.attachments.findById(id);

    if (attachment === undefined || attachment.leaveRequestId !== null) {
      throw new AttachmentNotFound(id);
    }

    const employee = await this.theEmployee(attachment.heldForEmployeeId);

    this.guard.enforce(leaveRequestPolicy.attach(actor, ownerOf(employee)));

    return { attachment, employee };
  }

  /** Whose evidence this is, before anything is asked about standing. */
  private async theEmployee(employeeId: string): Promise<Employee> {
    const id = requireId(employeeId, 'employeeId');
    const employee = await this.employees.findById(id);

    if (employee === undefined) {
      throw new EmployeeNotFound(id);
    }

    return employee;
  }

  /** The request and whose it is, with nothing asked about standing yet. */
  private async theRequest(
    leaveRequestId: string,
  ): Promise<{ request: LeaveRequest; employee: Employee }> {
    const id = requireId(leaveRequestId, 'leaveRequestId');
    const request = await this.requests.findById(id);

    if (request === undefined) {
      throw new LeaveRequestNotFound(id);
    }

    const employee = await this.employees.findById(request.employeeId);

    if (employee === undefined) {
      /* Unreachable: a request names an employee by foreign key and nothing deletes one. */
      throw new LeaveRequestNotFound(id);
    }

    return { request, employee };
  }

  /** The request, for somebody who may see what is on it. FR 12, LMS 310. */
  private async readable(
    actor: Actor,
    leaveRequestId: string,
  ): Promise<{ request: LeaveRequest; employee: Employee }> {
    const { request, employee } = await this.theRequest(leaveRequestId);

    this.guard.enforce(
      leaveRequestPolicy.readAttachment(actor, {
        ...ownerOf(employee),
        awaiting: request.awaitingApprovalFrom,
        chiefExecutiveId: await this.organisation.chiefExecutiveId(),
      }),
    );

    return { request, employee };
  }

  /**
   * One attachment, and it has to be this request's.
   *
   * Not found rather than refused for a file on another request: the standing was decided
   * against the request in the address, so an id from elsewhere has not been shown to exist.
   */
  private async onThisRequest(
    request: LeaveRequest,
    attachmentId: string,
  ): Promise<LeaveRequestAttachment> {
    const id = requireId(attachmentId, 'attachmentId');
    const attachment = await this.attachments.findById(id);

    if (attachment === undefined || attachment.leaveRequestId !== request.id) {
      throw new AttachmentNotFound(id);
    }

    return attachment;
  }
}

/**
 * What is waiting, as a person reads it. FR 13, NFR USA 03. LMS 311.
 *
 * The distinction it exists to make is `PENDING` against `CLEAN`: somebody with a file
 * uploaded and unscanned has *something* on the screen and nothing that will get their leave
 * through, and finding that out at the moment they submit is the failure this story is about.
 */
function waitingInWords(attached: number, usable: number): string {
  if (attached === 0) {
    return (
      'Nothing is waiting. Upload a certificate here before you ask for leave that needs ' +
      'one, and it goes on the request as you submit it.'
    );
  }

  const waiting = attached - usable;

  return (
    `${usable} of ${attached} ${attached === 1 ? 'file' : 'files'} can stand as ` +
    `documentation.${
      waiting === 0
        ? ''
        : ` The other ${waiting === 1 ? 'one is' : `${waiting} are`} still being checked for` +
          ` viruses and cannot count until that is done.`
    }`
  );
}

function requireId(id: unknown, field: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new InvalidAttachment(field, `An attachment is asked for by its ${field}.`);
  }

  return id.trim();
}

function attributionOf(actor: Actor): Attribution {
  return { employeeId: actor.employeeId, description: actor.description };
}

function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}
