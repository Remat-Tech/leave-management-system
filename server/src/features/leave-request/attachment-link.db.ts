/**
 * Database access for download links and the access log. NFR SEC 04, NFR SEC 06. LMS 407.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Attribution } from '../audit/audit.js';
import type { Database } from '../../db/index.js';
import type { AttachmentAccessTable, AttachmentDownloadLinkTable } from '../../db/schema.js';
import { recording } from '../../db/recording.js';
import {
  type AccessOutcome,
  type AttachmentAccess,
  type DownloadLink,
  type NewAttachmentAccess,
} from './attachment-link.js';

type LinkRow = Selectable<AttachmentDownloadLinkTable>;
type AccessRow = Selectable<AttachmentAccessTable>;

export class AttachmentLinkRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Mints one. The expiry and the issuer are the trigger's, never this caller's. */
  async issue(
    by: Attribution,
    link: { attachmentId: string; issuedToEmployeeId: string; tokenDigest: string },
  ): Promise<DownloadLink> {
    const row = await recording(this.db, by, (on) =>
      on
        .insertInto('attachment_download_link')
        .values({
          attachment_id: link.attachmentId,
          issued_to_employee_id: link.issuedToEmployeeId,
          token_digest: link.tokenDigest,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toLink(row);
  }

  /** The link somebody presented, found by what is kept of its token. */
  async byDigest(tokenDigest: string): Promise<DownloadLink | undefined> {
    const row = await this.db
      .selectFrom('attachment_download_link')
      .selectAll()
      .where('token_digest', '=', tokenDigest)
      .executeTakeFirst();

    return row === undefined ? undefined : toLink(row);
  }

  /**
   * Spends it, and only one of two fetches racing on the same link wins.
   *
   * The `WHERE` is the race: the loser changes nothing and gets `undefined` rather than the
   * trigger's exception, which is a refusal this caller can turn into a sentence.
   * `redeemed_at` is stamped by the trigger, so the value set here is only the fact that it
   * moved.
   */
  async spend(id: string): Promise<DownloadLink | undefined> {
    const row = await this.db
      .updateTable('attachment_download_link')
      .set({ redeemed_at: new Date() })
      .where('id', '=', id)
      .where('redeemed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toLink(row);
  }

  /** Writes down one reach for a file. The reader is stamped by the trigger. */
  async record(by: Attribution, access: NewAttachmentAccess): Promise<AttachmentAccess> {
    const row = await recording(this.db, by, (on) =>
      on
        .insertInto('attachment_access')
        .values({
          attachment_id: access.attachmentId,
          link_id: access.linkId,
          outcome: access.outcome,
          because: access.because,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toAccess(row);
  }

  /* There is deliberately no read of the log here. Writing it down is this story; showing
     somebody who has opened their certificate is a screen, a policy and a story of its own,
     and a repository method nothing calls is a method nobody has decided the shape of. The
     rows are there when that story arrives. */
}

function toLink(row: LinkRow): DownloadLink {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    issuedToEmployeeId: row.issued_to_employee_id,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    issuedBy: row.issued_by,
    issuedByEmployeeId: row.issued_by_employee_id,
    issuedAt: row.issued_at,
  };
}

function toAccess(row: AccessRow): AttachmentAccess {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    linkId: row.link_id,
    outcome: row.outcome as AccessOutcome,
    because: row.because,
    accessedBy: row.accessed_by,
    accessedByEmployeeId: row.accessed_by_employee_id,
    accessedAt: row.accessed_at,
  };
}
