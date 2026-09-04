/** Attachments on a request, over HTTP. FR 12, NFR SEC 04, NFR SEC 07. LMS 310. */

import express, { type Request, type Response, Router } from 'express';
import { actorOf } from '../../http/identify.js';
import type {
  AttachmentService,
  AttachmentsOnARequest,
  AttachmentsWaiting,
  UploadedFile,
} from './attachment.service.js';
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
   * Uploads evidence ahead of the request it will go on. FR 13, LMS 311.
   *
   * The route the story needs and LMS 310 had no place for: FR 13 is answered at submission,
   * so the certificate has to exist before the request does. Same body, same header, same
   * caps as the one below — what differs is only that it names nothing to hang off.
   */
  routes.post(
    '/me/evidence',
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    (request: Request, response: Response, next) => {
      void attachments
        .hold(actorOf(response), employeeIdOf(response), uploadIn(request))
        .then((held) => {
          response.status(201).json(attachmentAsJson(held));
        })
        .catch(next);
    },
  );

  /**
   * The same, for HR putting somebody else's leave on the record. FR 13, FR 18, LMS 311.
   *
   * `leaveRequestPolicy.attach` has admitted HR on somebody's behalf since LMS 310; `/me`
   * has no way to say whose evidence it is, exactly as `/me/requests` has none to say whose
   * leave it is.
   */
  routes.post(
    '/employees/:id/evidence',
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    (request: Request, response: Response, next) => {
      void attachments
        .hold(actorOf(response), asString(request.params.id), uploadIn(request))
        .then((held) => {
          response.status(201).json(attachmentAsJson(held));
        })
        .catch(next);
    },
  );

  /** What is waiting to go on a request, and how much of it counts. FR 13, LMS 311. */
  routes.get('/me/evidence', (_request: Request, response: Response, next) => {
    void attachments
      .waitingFor(actorOf(response), employeeIdOf(response))
      .then((waiting) => {
        response.json(waitingAsJson(waiting));
      })
      .catch(next);
  });

  routes.get('/employees/:id/evidence', (request: Request, response: Response, next) => {
    void attachments
      .waitingFor(actorOf(response), asString(request.params.id))
      .then((waiting) => {
        response.json(waitingAsJson(waiting));
      })
      .catch(next);
  });

  /**
   * Throws away a file that never went on a request. FR 13, LMS 311.
   *
   * Addressed by its own id, because there is no request to address it through. Whose it is
   * is the row's own answer, and the policy is asked about that person.
   */
  routes.delete('/evidence/:id', (request: Request, response: Response, next) => {
    void attachments
      .discard(actorOf(response), asString(request.params.id))
      .then(() => {
        response.status(204).end();
      })
      .catch(next);
  });

  /** Asks the scanner again about a waiting file it never answered for. NFR SEC 07, LMS 311. */
  routes.post('/evidence/:id/scan', (request: Request, response: Response, next) => {
    void attachments
      .rescanWaiting(actorOf(response), asString(request.params.id))
      .then((scanned) => {
        response.json(attachmentAsJson(scanned));
      })
      .catch(next);
  });

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
        .attach(actorOf(response), asString(request.params.id), uploadIn(request))
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

/** The upload as it arrived: the bytes, the name, and what the client claimed it was. */
function uploadIn(request: Request): UploadedFile {
  return {
    filename: filenameOf(request),
    content: request.body,
    claimedContentType: asString(request.get('content-type')),
  };
}

/** The signed-in person, for the `/me` routes. The same reading requestRoutes makes. */
function employeeIdOf(response: Response): string {
  const actor = actorOf(response);

  if (actor.employeeId === null) {
    throw new Error('This route was reached by an actor with no employee behind it.');
  }

  return actor.employeeId;
}

/* ------------------------------------------------------ an attachment, as JSON */

/** `storageKey` is deliberately absent: it is storage's handle, not a client's. NFR SEC 04. */
function attachmentAsJson(attachment: LeaveRequestAttachment): unknown {
  return {
    attachmentId: attachment.id,
    /** FR 13. Null while it waits for the request it will evidence. LMS 311. */
    leaveRequestId: attachment.leaveRequestId,
    heldForEmployeeId: attachment.heldForEmployeeId,
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

/** FR 13, LMS 311. What is waiting to go on a request, and how much of it counts. */
function waitingAsJson(waiting: AttachmentsWaiting): unknown {
  return {
    employeeId: waiting.employeeId,
    attachments: waiting.attachments.map(attachmentAsJson),
    usable: waiting.usable,
    inWords: waiting.inWords,
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
