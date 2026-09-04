/**
 * Database access for a request's attachments. FR 12, NFR SEC 07. LMS 310.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Attribution } from '../audit/audit.js';
import type { Database } from '../../db/index.js';
import type { LeaveRequestAttachmentTable } from '../../db/schema.js';
import { recording } from '../../db/recording.js';
import {
  type AcceptedContentType,
  InvalidAttachment,
  type LeaveRequestAttachment,
  type NewAttachment,
  type ScanStatus,
} from './attachment.js';

/** Postgres `unique_violation` and `check_violation`. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/** Which field a refused row is reported against. */
const CHECKED_FIELDS: Record<string, string> = {
  leave_request_attachment_filename_is_a_name: 'filename',
  leave_request_attachment_content_type_accepted: 'file',
  leave_request_attachment_size_within_the_cap: 'file',
  leave_request_attachment_slot_is_one_of_five: 'file',
  leave_request_attachment_five_per_request: 'file',
};

type AttachmentRow = Selectable<LeaveRequestAttachmentTable>;

export class AttachmentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Writes the row. The uploader is stamped by the trigger off `recording`. */
  async add(by: Attribution, attachment: NewAttachment): Promise<LeaveRequestAttachment> {
    return this.catchRefusals(async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_request_attachment')
          .values({
            leave_request_id: attachment.leaveRequestId,
            slot: attachment.slot,
            filename: attachment.filename,
            content_type: attachment.contentType,
            size_bytes: attachment.sizeBytes,
            checksum_sha256: attachment.checksumSha256,
            storage_key: attachment.storageKey,
            scan_status: attachment.scanStatus,
            scan_signature: attachment.scanSignature,
            scanned_by: attachment.scannedBy,
            scanned_at: attachment.scannedAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toAttachment(row);
    });
  }

  /** Everything on one request, in the order it was attached. */
  async forRequest(leaveRequestId: string): Promise<LeaveRequestAttachment[]> {
    const rows = await this.db
      .selectFrom('leave_request_attachment')
      .selectAll()
      .where('leave_request_id', '=', leaveRequestId)
      .orderBy('id', 'asc')
      .execute();

    return rows.map(toAttachment);
  }

  async findById(id: string): Promise<LeaveRequestAttachment | undefined> {
    const row = await this.db
      .selectFrom('leave_request_attachment')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toAttachment(row);
  }

  /**
   * Writes the verdict, and only onto a file that has none. NFR SEC 07.
   *
   * The `WHERE` is the race: two scans landing together, and the second changes nothing
   * rather than overwriting the first. The trigger refuses it either way.
   */
  async settleScan(
    id: string,
    verdict: Exclude<ScanStatus, 'PENDING'>,
    signature: string | null,
    scannedBy: string,
  ): Promise<LeaveRequestAttachment | undefined> {
    const row = await this.db
      .updateTable('leave_request_attachment')
      .set({
        scan_status: verdict,
        scan_signature: signature,
        scanned_by: scannedBy,
        scanned_at: new Date(),
      })
      .where('id', '=', id)
      .where('scan_status', '=', 'PENDING')
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toAttachment(row);
  }

  /** Takes the row off. The bytes are the service's to remove. */
  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('leave_request_attachment')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  private async catchRefusals<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      const constraint = failure.constraint ?? '';

      if (
        (failure.code === CHECK_VIOLATION || failure.code === UNIQUE_VIOLATION) &&
        constraint in CHECKED_FIELDS
      ) {
        throw new InvalidAttachment(CHECKED_FIELDS[constraint], messageFor(constraint));
      }

      throw error;
    }
  }
}

/** Unreachable through the service, which asks every one of these first. */
function messageFor(constraint: string): string {
  switch (constraint) {
    case 'leave_request_attachment_filename_is_a_name':
      return 'An attachment is named, and the name is a label rather than a path.';
    case 'leave_request_attachment_content_type_accepted':
      return 'That is not a kind of file this system accepts. FR 12.';
    case 'leave_request_attachment_size_within_the_cap':
      return 'That file is larger than the limit, or empty. FR 12.';
    default:
      return 'This request already holds as many files as it may. FR 12.';
  }
}

function toAttachment(row: AttachmentRow): LeaveRequestAttachment {
  return {
    id: row.id,
    leaveRequestId: row.leave_request_id,
    slot: row.slot,
    filename: row.filename,
    contentType: row.content_type as AcceptedContentType,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    storageKey: row.storage_key,
    scanStatus: row.scan_status as ScanStatus,
    scanSignature: row.scan_signature,
    scannedBy: row.scanned_by,
    scannedAt: row.scanned_at,
    uploadedBy: row.uploaded_by,
    uploadedByEmployeeId: row.uploaded_by_employee_id,
    uploadedAt: row.uploaded_at,
  };
}
