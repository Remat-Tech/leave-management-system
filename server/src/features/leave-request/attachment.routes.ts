/** Attachments on a request, over HTTP. FR 12, NFR SEC 04, NFR SEC 07. LMS 310. */

import express, { type Request, type Response, Router } from 'express';
import { actorOf } from '../../http/identify.js';
import type { AttachmentService, AttachmentsOnARequest } from './attachment.service.js';
import {
  type EvidenceOnARequest,
  type LeaveRequestAttachment,
  MAX_ATTACHMENT_BYTES,
} from './attachment.js';

export interface AttachmentRoutes {
  attachments: AttachmentService;
}

export function attachmentRoutes({ attachments }: AttachmentRoutes): Router {
  const routes = Router();

  /**
   * Attaches one file. FR 12.
   *
   * **The body is the bytes.** One file per call rather than a multipart form, because
   * the caps are per file anyway and a multipart parser is a second thing that has to
   * agree with them. The `Content-Type` sent is not read to decide what the file is —
   * `sniffContentType` does that — and is carried only into the refusal's message.
   *
   * The name arrives in a header rather than a query parameter so that
   * `?filename=biopsy-result.pdf` does not end up in an access log. It is percent
   * encoded, because a header is Latin-1 and a filename is not.
   */
  routes.post(
    '/requests/:id/attachments',
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    (request: Request, response: Response, next) => {
      void attachments
        .attach(actorOf(response), asString(request.params.id), {
          filename: filenameOf(request),
          content: request.body,
          claimedContentType: asString(request.get('content-type')),
        })
        .then((attached) => {
          response.status(201).json(attachmentAsJson(attached));
        })
        .catch(next);
    },
  );

  /** What is attached, and whether FR 13's rule is met by it. FR 12, FR 13. */
  routes.get('/requests/:id/attachments', (request: Request, response: Response, next) => {
    void attachments
      .forRequest(actorOf(response), asString(request.params.id))
      .then((held) => {
        response.json(attachmentsAsJson(held));
      })
      .catch(next);
  });

  /**
   * The file itself. NFR SEC 04, NFR SEC 07.
   *
   * Refused unless the scanner has called it clean. Sent as an octet stream with the
   * sniffed type named separately, so that nothing a browser renders inline can be
   * served from this origin.
   */
  routes.get(
    '/requests/:id/attachments/:attachmentId',
    (request: Request, response: Response, next) => {
      void attachments
        .download(
          actorOf(response),
          asString(request.params.id),
          asString(request.params.attachmentId),
        )
        .then(({ attachment, content }) => {
          response
            .status(200)
            .set('Content-Type', 'application/octet-stream')
            .set('X-Content-Type-Options', 'nosniff')
            .set('X-Attachment-Content-Type', attachment.contentType)
            .set('Content-Disposition', dispositionFor(attachment.filename))
            .send(content);
        })
        .catch(next);
    },
  );

  /** Takes a file back off, while the request is still being decided. FR 12. */
  routes.delete(
    '/requests/:id/attachments/:attachmentId',
    (request: Request, response: Response, next) => {
      void attachments
        .remove(
          actorOf(response),
          asString(request.params.id),
          asString(request.params.attachmentId),
        )
        .then(() => {
          response.status(204).end();
        })
        .catch(next);
    },
  );

  /** Asks the scanner again about a file it never answered for. NFR SEC 07. */
  routes.post(
    '/requests/:id/attachments/:attachmentId/scan',
    (request: Request, response: Response, next) => {
      void attachments
        .rescan(
          actorOf(response),
          asString(request.params.id),
          asString(request.params.attachmentId),
        )
        .then((scanned) => {
          response.json(attachmentAsJson(scanned));
        })
        .catch(next);
    },
  );

  return routes;
}

/**
 * The name the uploader gave it, percent decoded.
 *
 * A header that is not valid percent encoding is passed through as it stands rather than
 * refused here — `validateFilename` is the one place that says what a name may be.
 */
function filenameOf(request: Request): string {
  const sent = asString(request.get('x-filename'));

  try {
    return decodeURIComponent(sent);
  } catch {
    return sent;
  }
}

/**
 * `Content-Disposition`, with the name in both forms.
 *
 * The quoted one is stripped to ASCII for clients that read only that; `filename*` carries
 * what the person actually called it. RFC 6266.
 */
function dispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/* ------------------------------------------------------ an attachment, as JSON */

/** `storageKey` is deliberately absent: it is storage's handle, not a client's. NFR SEC 04. */
function attachmentAsJson(attachment: LeaveRequestAttachment): unknown {
  return {
    attachmentId: attachment.id,
    leaveRequestId: attachment.leaveRequestId,
    slot: attachment.slot,
    filename: attachment.filename,
    /** NFR SEC 07. What the bytes are, never what they were called. */
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    checksumSha256: attachment.checksumSha256,
    scanStatus: attachment.scanStatus,
    scanSignature: attachment.scanSignature,
    scannedBy: attachment.scannedBy,
    scannedAt: attachment.scannedAt === null ? null : attachment.scannedAt.toISOString(),
    /** NFR SEC 07. What a screen greys the download out on. */
    downloadable: attachment.scanStatus === 'CLEAN',
    uploadedBy: attachment.uploadedByEmployeeId,
    uploadedAt: attachment.uploadedAt.toISOString(),
  };
}

function attachmentsAsJson(held: AttachmentsOnARequest): unknown {
  return {
    leaveRequestId: held.leaveRequestId,
    attachments: held.attachments.map(attachmentAsJson),
    evidence: evidenceAsJson(held.evidence),
  };
}

/** FR 13, NFR SEC 07. Whether this leave's documentation rule is met, and by how much. */
function evidenceAsJson(evidence: EvidenceOnARequest): unknown {
  return {
    required: evidence.required,
    satisfied: evidence.satisfied,
    usable: evidence.usable,
    attached: evidence.attached,
    inWords: evidence.inWords,
  };
}
