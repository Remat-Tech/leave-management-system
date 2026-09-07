import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_LINK_SECONDS,
  type DownloadLink,
  DownloadLinkNotUsable,
  TOKEN_PATTERN,
  digestOf,
  downloadPathFor,
  newDownloadToken,
  secondsLeft,
  whyNotUsable,
} from '../../src/features/leave-request/attachment-link.js';

/**
 * The short-lived link a certificate is fetched through. NFR SEC 04, NFR SEC 06. LMS 407.
 *
 * Everything pure: what a token is, what is kept of it, and the four reasons a link opens
 * nothing. That the row is written, the link spent once and the policy asked again at the
 * fetch is ../integration/attachment-link.test.ts's.
 */

const ISSUED_AT = new Date('2026-09-07T09:00:00Z');

function aLink(overrides: Partial<DownloadLink> = {}): DownloadLink {
  return {
    id: '1',
    attachmentId: '7',
    issuedToEmployeeId: '42',
    issuedAt: ISSUED_AT,
    expiresAt: new Date(ISSUED_AT.getTime() + DOWNLOAD_LINK_SECONDS * 1000),
    redeemedAt: null,
    issuedBy: 'Ama Owusu',
    issuedByEmployeeId: '42',
    ...overrides,
  };
}

describe('a token', () => {
  it('is 32 random bytes and nothing derived from the file', () => {
    expect(newDownloadToken()).toMatch(TOKEN_PATTERN);
    expect(newDownloadToken()).not.toBe(newDownloadToken());
  });

  /* NFR SEC 04. What the table holds opens nothing, which is the point of holding it. */
  it('is kept as its digest, and the digest is not the token', () => {
    const token = newDownloadToken();

    expect(digestOf(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(digestOf(token)).not.toBe(token);
    expect(digestOf(token)).toBe(digestOf(token));
  });

  it('is the whole of the address', () => {
    const token = newDownloadToken();

    expect(downloadPathFor(token)).toBe(`/api/attachments/downloads/${token}`);
  });
});

describe('whether a link opens anything', () => {
  it('does, for the person it was issued to, before it expires', () => {
    expect(whyNotUsable(aLink(), '42', ISSUED_AT)).toBeNull();
  });

  it('does not once it has been used', () => {
    expect(whyNotUsable(aLink({ redeemedAt: ISSUED_AT }), '42', ISSUED_AT)).toMatchObject({
      outcome: 'ALREADY_USED',
    });
  });

  /* Two minutes, and the boundary is closed: a link is unusable at the instant it expires. */
  it('does not once it has expired', () => {
    const link = aLink();

    expect(whyNotUsable(link, '42', new Date(link.expiresAt.getTime() - 1))).toBeNull();
    expect(whyNotUsable(link, '42', link.expiresAt)).toMatchObject({ outcome: 'EXPIRED' });
  });

  /* NFR SEC 04. The half that makes a copied address worthless rather than merely brief. */
  it('does not for anybody else, whatever standing they have over the request', () => {
    expect(whyNotUsable(aLink(), '43', ISSUED_AT)).toMatchObject({ outcome: 'REFUSED' });
  });

  it('and not for an actor with nobody behind it', () => {
    expect(whyNotUsable(aLink(), null, ISSUED_AT)).toMatchObject({ outcome: 'REFUSED' });
  });

  it('says how long is left, and never a negative number', () => {
    const link = aLink();

    expect(secondsLeft(link, ISSUED_AT)).toBe(DOWNLOAD_LINK_SECONDS);
    expect(secondsLeft(link, new Date(link.expiresAt.getTime() + 60_000))).toBe(0);
  });
});

/* NFR SEC 04. Four reasons, one sentence: a pair that differed would say which guesses had
   once been real. */
describe('the refusal', () => {
  it('reads the same whichever of the four it was', () => {
    const messages = new Set(
      [null, 'EXPIRED', 'ALREADY_USED', 'REFUSED'].map(
        (outcome) => new DownloadLinkNotUsable(outcome as never).message,
      ),
    );

    expect(messages.size).toBe(1);
  });

  it('keeps which it was for the log, and says nothing about it', () => {
    const refusal = new DownloadLinkNotUsable('ALREADY_USED');

    expect(refusal.outcome).toBe('ALREADY_USED');
    expect(refusal.message).not.toContain('ALREADY_USED');
    expect(refusal.message).not.toContain('already been used');
  });
});
