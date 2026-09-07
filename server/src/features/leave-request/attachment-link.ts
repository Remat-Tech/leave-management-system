/**
 * The short-lived link a certificate is fetched through, and the record of every fetch. NFR SEC 04, NFR SEC 06. LMS 407.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * How long a link is good for. The database sets it; this is the same number in words.
 *
 * `attachment_download_link_is_short_lived` is what makes it true, and
 * ../../../tests/integration/attachment-link.test.ts asserts the two say the same thing.
 */
export const DOWNLOAD_LINK_SECONDS = 120;

/** 32 random bytes as hex. Not derived from anything, so nothing about it can be guessed. */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Where the bytes are fetched from. The only address there is, and it lasts two minutes. */
export function downloadPathFor(token: string): string {
  return `/api/attachments/downloads/${token}`;
}

export function newDownloadToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * What is kept of a token. NFR SEC 04.
 *
 * The token is never written down. A backup, a support query or a leaked dump of
 * `attachment_download_link` holds nothing that opens anything.
 */
export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A link as it comes back out. */
export interface DownloadLink {
  id: string;
  attachmentId: string;
  /** Who it was minted for. Anybody else presenting it is refused and recorded. */
  issuedToEmployeeId: string;
  expiresAt: Date;
  /** When it was spent, or null while it is still good for one fetch. */
  redeemedAt: Date | null;
  issuedBy: string;
  issuedByEmployeeId: string | null;
  issuedAt: Date;
}

/* ------------------------------------------------------------------- the access log */

/** What became of one reach for a file. NFR SEC 04. */
export const ACCESS_OUTCOMES = [
  /** A link was minted for somebody the policy admitted. */
  'ISSUED',
  'DOWNLOADED',
  'EXPIRED',
  'ALREADY_USED',
  /** Presented by somebody it was not for, or by somebody who may no longer read it. */
  'REFUSED',
] as const;

export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

/** One reach for a file, as it was written down. */
export interface AttachmentAccess {
  id: string;
  attachmentId: string;
  linkId: string;
  outcome: AccessOutcome;
  /** NFR USA 03. Null on the two outcomes that are not refusals. */
  because: string | null;
  accessedBy: string;
  accessedByEmployeeId: string | null;
  accessedAt: Date;
}

/** What is written down about one reach. The reader is stamped by the trigger. */
export interface NewAttachmentAccess {
  attachmentId: string;
  linkId: string;
  outcome: AccessOutcome;
  because: string | null;
}

/* --------------------------------------------------------------------- redemption */

/** Whether this link opens anything, for this person, now. NFR SEC 04. */
export function whyNotUsable(
  link: DownloadLink,
  employeeId: string | null,
  now: Date = new Date(),
): { outcome: Exclude<AccessOutcome, 'ISSUED' | 'DOWNLOADED'>; because: string } | null {
  if (link.redeemedAt !== null) {
    return {
      outcome: 'ALREADY_USED',
      because: 'the link had already been used',
    };
  }

  if (link.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'EXPIRED', because: 'the link had expired' };
  }

  if (employeeId === null || employeeId !== link.issuedToEmployeeId) {
    return {
      outcome: 'REFUSED',
      because: 'the link was presented by somebody it was not issued to',
    };
  }

  return null;
}

/** How long this link has left, never below nought. */
export function secondsLeft(link: DownloadLink, now: Date = new Date()): number {
  return Math.max(0, Math.round((link.expiresAt.getTime() - now.getTime()) / 1000));
}

/* ---------------------------------------------------------------------- refusals */

/**
 * A link that opens nothing. NFR SEC 04.
 *
 * Expired, spent, presented by somebody else, or naming no link that was ever issued — one
 * class and one sentence for all four, which is the same rule the authorisation layer holds
 * about a record that is missing and a record that is withheld. A pair of answers that
 * differed would tell somebody working through addresses which of their guesses had once
 * been real.
 *
 * Which it actually was is in `attachment_access`, where the person whose certificate it is
 * can be told — except for the fourth, which is written down nowhere because there is no
 * file for it to be an access to.
 */
export class DownloadLinkNotUsable extends Error {
  readonly code = 'LINK_NOT_USABLE';
  /** For the log, never for the message. Null where the token named nothing. */
  readonly outcome: AccessOutcome | null;

  constructor(outcome: AccessOutcome | null) {
    super(
      'That download link no longer works. A link opens a file once and lasts two minutes, ' +
        'so that a copied address is not a way into somebody’s medical records. Open the ' +
        'request again and press download. NFR SEC 04.',
    );
    this.name = 'DownloadLinkNotUsable';
    this.outcome = outcome;
  }
}
