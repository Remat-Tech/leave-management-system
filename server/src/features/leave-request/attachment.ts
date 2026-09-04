/**
 * A certificate or supporting document on a request. FR 12, FR 13, NFR SEC 07. LMS 310.
 */

import { documentationRequired, type LeaveType } from '../leave-type/leave-type.js';
import { type LeaveRequest, isSettled } from './leave-request.js';

/** FR 12. What is accepted, as the bytes say it rather than as the name claims it. */
export const ACCEPTED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

/** FR 12. Ten megabytes, and five files. The same numbers the table holds. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;

/** A type as somebody says it, for a message about what may be attached. NFR USA 03. */
export function contentTypeInWords(type: AcceptedContentType): string {
  switch (type) {
    case 'application/pdf':
      return 'PDF';
    case 'image/jpeg':
      return 'JPG';
    case 'image/png':
      return 'PNG';
    default:
      return 'DOCX';
  }
}

/** "PDF, JPG, PNG and DOCX". */
export function acceptedInWords(): string {
  const words = ACCEPTED_CONTENT_TYPES.map(contentTypeInWords);

  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/* ------------------------------------------------------------------ scanning */

/** NFR SEC 07. `PENDING` is a file nothing has looked at yet. */
export const SCAN_STATUSES = ['PENDING', 'CLEAN', 'INFECTED'] as const;

export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** An attachment as it comes back out. */
export interface LeaveRequestAttachment {
  id: string;
  leaveRequestId: string;
  /** Which of the five seats on the request this holds. */
  slot: number;
  /** The uploader's own name for it. A label, never a path. */
  filename: string;
  /** Sniffed, never taken from the extension. NFR SEC 07. */
  contentType: AcceptedContentType;
  sizeBytes: number;
  checksumSha256: string;
  /** The handle storage issued. Never sent to a client. NFR SEC 04. */
  storageKey: string;
  scanStatus: ScanStatus;
  /** What the scanner found, on `INFECTED` alone. */
  scanSignature: string | null;
  scannedBy: string | null;
  scannedAt: Date | null;
  uploadedBy: string;
  uploadedByEmployeeId: string | null;
  uploadedAt: Date;
}

/** What a validated upload holds, before it is written. */
export interface NewAttachment {
  leaveRequestId: string;
  slot: number;
  filename: string;
  contentType: AcceptedContentType;
  sizeBytes: number;
  checksumSha256: string;
  storageKey: string;
  scanStatus: ScanStatus;
  scanSignature: string | null;
  scannedBy: string | null;
  scannedAt: Date | null;
}

/**
 * Whether this file can stand as evidence. NFR SEC 07.
 *
 * A scanned, clean file and nothing else — which is the whole of "unscanned files cannot
 * satisfy a requirement".
 */
export function attachmentSatisfiesADocumentationRule(attachment: LeaveRequestAttachment): boolean {
  return attachment.scanStatus === 'CLEAN';
}

/** Whether FR 13's rule for this leave is met, and the sentence saying so. FR 13, NFR SEC 07. */
export interface EvidenceOnARequest {
  required: boolean;
  satisfied: boolean;
  /** Files that count, of the files that are there. */
  usable: number;
  attached: number;
  inWords: string;
}

export function evidenceOn(
  type: LeaveType,
  request: LeaveRequest,
  attachments: readonly LeaveRequestAttachment[],
): EvidenceOnARequest {
  const required = documentationRequired(type, request.days);
  const usable = attachments.filter(attachmentSatisfiesADocumentationRule).length;
  const waiting = attachments.length - usable;

  return {
    required,
    satisfied: !required || usable > 0,
    usable,
    attached: attachments.length,
    inWords: evidenceInWords(type, required, usable, waiting),
  };
}

function evidenceInWords(
  type: LeaveType,
  required: boolean,
  usable: number,
  waiting: number,
): string {
  const unscanned =
    waiting === 0
      ? ''
      : ` ${waiting === 1 ? 'One file is' : `${waiting} files are`} still being checked ` +
        `for viruses and cannot count until that is done.`;

  if (!required) {
    return usable === 0
      ? `${type.name} of this length asks for no documentation. Anything attached is ` +
          `there because you wanted it on the record.${unscanned}`
      : `${type.name} of this length asks for no documentation, and ${usable} ` +
          `${usable === 1 ? 'file is' : 'files are'} attached anyway.${unscanned}`;
  }

  return usable === 0
    ? `${type.name} of this length needs supporting documentation, and nothing usable is ` +
        `attached.${unscanned} Attach ${acceptedInWords()}, up to ` +
        `${MAX_ATTACHMENTS_PER_REQUEST} files.`
    : `${type.name} of this length needs supporting documentation, and ${usable} ` +
        `${usable === 1 ? 'file' : 'files'} can stand as it.${unscanned}`;
}

/* ------------------------------------------------------------------ the seats */

/** The lowest free seat, or undefined where all five are taken. FR 12. */
export function nextFreeSlot(taken: readonly number[]): number | undefined {
  for (let slot = 1; slot <= MAX_ATTACHMENTS_PER_REQUEST; slot += 1) {
    if (!taken.includes(slot)) {
      return slot;
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ refusals */

/** An upload that is not one. Carries the field, like every other validator. NFR USA 03. */
export class InvalidAttachment extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAttachment';
    this.field = field;
  }
}

export class AttachmentNotFound extends Error {
  readonly attachmentId: string;

  constructor(id: string) {
    super(`There is no attachment ${id}.`);
    this.name = 'AttachmentNotFound';
    this.attachmentId = id;
  }
}

/** FR 12, NFR SEC 07. What the bytes are is not what may be attached. */
export class AttachmentTypeNotAccepted extends Error {
  readonly code = 'TYPE_NOT_ACCEPTED';
  /** What it actually is, where that could be told at all. */
  readonly sniffed: string | null;

  constructor(sniffed: string | null, claimed: string) {
    super(
      `This file is ${sniffed ?? 'not a kind of file this system recognises'}, whatever ` +
        `it is called. ${acceptedInWords()} are accepted, and what a file is, is read ` +
        `from the file rather than from its name — so renaming it will not help. ` +
        `You sent it as ${claimed || 'nothing in particular'}. FR 12.`,
    );
    this.name = 'AttachmentTypeNotAccepted';
    this.sniffed = sniffed;
  }
}

/** FR 12. */
export class AttachmentTooLarge extends Error {
  readonly code = 'FILE_TOO_LARGE';
  readonly sizeBytes: number;
  readonly maxBytes = MAX_ATTACHMENT_BYTES;

  constructor(sizeBytes: number) {
    super(
      `That file is ${megabytes(sizeBytes)} MB and the limit is ` +
        `${megabytes(MAX_ATTACHMENT_BYTES)} MB per file. A photograph of a certificate ` +
        `is usually well under it; scanning at a lower resolution, or saving as PDF, ` +
        `brings most things down. FR 12.`,
    );
    this.name = 'AttachmentTooLarge';
    this.sizeBytes = sizeBytes;
  }
}

/** FR 12. */
export class TooManyAttachments extends Error {
  readonly code = 'TOO_MANY_FILES';
  readonly leaveRequestId: string;
  readonly maxFiles = MAX_ATTACHMENTS_PER_REQUEST;

  constructor(request: LeaveRequest) {
    super(
      `This request already has ${MAX_ATTACHMENTS_PER_REQUEST} files on it, which is the ` +
        `limit. Remove one you no longer need and attach this in its place. FR 12.`,
    );
    this.name = 'TooManyAttachments';
    this.leaveRequestId = request.id;
  }
}

/** NFR SEC 07. Refused at the door; nothing is stored and no row is written. */
export class AttachmentIsInfected extends Error {
  readonly code = 'FILE_INFECTED';
  readonly signature: string | null;

  constructor(signature: string | null) {
    super(
      `The virus scanner refused this file${signature === null ? '' : ` — ${signature}`}. ` +
        `It has not been stored. If you believe that is wrong, send the document to HR ` +
        `another way and tell them what happened. NFR SEC 07.`,
    );
    this.name = 'AttachmentIsInfected';
    this.signature = signature;
  }
}

/** NFR SEC 07. A file nothing has cleared is a file nobody may open. */
export class AttachmentNotScanned extends Error {
  readonly code = 'NOT_SCANNED';
  readonly attachmentId: string;
  readonly scanStatus: ScanStatus;

  constructor(attachment: LeaveRequestAttachment) {
    super(
      attachment.scanStatus === 'INFECTED'
        ? `This file was found to be infected and cannot be downloaded. It counts as no ` +
            `evidence of anything. NFR SEC 07.`
        : `This file has not been scanned for viruses yet, so it cannot be downloaded and ` +
            `it satisfies no documentation requirement. It will be scanned again shortly. ` +
            `NFR SEC 07.`,
    );
    this.name = 'AttachmentNotScanned';
    this.attachmentId = attachment.id;
    this.scanStatus = attachment.scanStatus;
  }
}

/** FR 12. Evidence goes on a request that is still open. */
export class AttachmentsAreClosed extends Error {
  readonly code = 'REQUEST_CLOSED';
  readonly leaveRequestId: string;

  constructor(request: LeaveRequest, act: 'attach to' | 'remove from') {
    super(
      `This leave has been ${request.status.toLowerCase()}, so there is nothing left to ` +
        `${act === 'attach to' ? 'evidence' : 'take back'}. Files already on it stay on ` +
        `it: what was attached while it was being decided is part of the record of why it ` +
        `was decided that way. FR 12.`,
    );
    this.name = 'AttachmentsAreClosed';
    this.leaveRequestId = request.id;
  }
}

/** Whether a request is still open to evidence. FR 12. */
export function assertAttachmentsAreOpen(
  request: LeaveRequest,
  act: 'attach to' | 'remove from',
): void {
  /* Attaching is refused once the leave has ended; removing is refused the moment a desk
     could have read the file, which is anything past `SUBMITTED`. */
  const closed = act === 'attach to' ? isSettled(request.status) : request.status !== 'SUBMITTED';

  if (closed) {
    throw new AttachmentsAreClosed(request, act);
  }
}

/* ---------------------------------------------------------------- validation */

/**
 * The name, as a name. FR 12.
 *
 * Trimmed, stripped of anything that makes it a path, and capped. The database holds the
 * same rule; this is where the sentence is.
 */
export function validateFilename(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidAttachment(
      'filename',
      'An attachment needs a name, so that whoever approves this knows what they are ' +
        'looking at. Send it in the X-Filename header.',
    );
  }

  /* The basename, whatever arrived: a browser on Windows sends the whole path on some
     forms, and none of it is ours to keep. */
  const name = value.split(/[\\/]/).pop()?.trim() ?? '';

  if (name === '' || name === '.' || name === '..' || hasAControlCharacter(name)) {
    throw new InvalidAttachment(
      'filename',
      `"${value}" is a path or a control character rather than the name of a file. Send ` +
        `the name as it appears on your machine, such as "certificate.pdf".`,
    );
  }

  if (name.length > 255) {
    throw new InvalidAttachment(
      'filename',
      'That filename is longer than 255 characters. Shorten it — the name is a label for ' +
        'whoever approves this, not part of the document.',
    );
  }

  return name;
}

/** The bytes, as bytes. FR 12. */
export function validateContent(content: unknown): Buffer {
  if (!Buffer.isBuffer(content) || content.byteLength === 0) {
    throw new InvalidAttachment(
      'file',
      'The body of an upload is the file itself, sent as bytes with a content type this ' +
        'server does not read. An empty body is not a document.',
    );
  }

  if (content.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLarge(content.byteLength);
  }

  return content;
}

/** A filename is a label somebody types, so nothing below space belongs in it. */
function hasAControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

/* ------------------------------------------------------------------ sniffing */

/**
 * What the bytes actually are, or null. NFR SEC 07.
 *
 * The extension is never consulted. DOCX is a zip, so it is told from the other zips by
 * reading the archive's own list of entries rather than by trusting the name.
 */
export function sniffContentType(content: Buffer): AcceptedContentType | null {
  if (startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf';
  }

  if (startsWith(content, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  if (startsWith(content, [0x50, 0x4b]) && isWordDocument(content)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  return null;
}

function startsWith(content: Buffer, magic: readonly number[]): boolean {
  return content.byteLength >= magic.length && magic.every((byte, at) => content[at] === byte);
}

/** A zip holding `word/`, which is what tells DOCX from XLSX, PPTX and a plain archive. */
function isWordDocument(content: Buffer): boolean {
  const names = zipEntryNames(content);

  return names.includes('[Content_Types].xml') && names.some((name) => name.startsWith('word/'));
}

/**
 * The names in a zip's central directory.
 *
 * Read from the end of the file rather than by walking local headers, which is the only
 * part of a zip that is authoritative about what the archive contains.
 */
function zipEntryNames(content: Buffer): string[] {
  const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
  const CENTRAL_FILE_HEADER = 0x02014b50;

  if (content.byteLength < 22) {
    return [];
  }

  /* The record is last, after a comment of up to 64 KB. */
  const earliest = Math.max(0, content.byteLength - (0xffff + 22));
  let end = -1;

  for (let at = content.byteLength - 22; at >= earliest; at -= 1) {
    if (content.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }

  if (end === -1) {
    return [];
  }

  const entries = content.readUInt16LE(end + 10);
  let at = content.readUInt32LE(end + 16);
  const names: string[] = [];

  for (let read = 0; read < entries; read += 1) {
    if (at + 46 > content.byteLength || content.readUInt32LE(at) !== CENTRAL_FILE_HEADER) {
      break;
    }

    const nameLength = content.readUInt16LE(at + 28);
    const extraLength = content.readUInt16LE(at + 30);
    const commentLength = content.readUInt16LE(at + 32);

    names.push(content.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}
