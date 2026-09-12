/** Deletes stored certificates once the retention period has passed. NFR SEC 06, LMS 514. */

import type { Storage } from '../../storage/index.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import type { OrganisationRepository } from '../organisation/organisation.db.js';
import { UNCONFIGURED } from '../organisation/organisation.js';
import type { AttachmentRepository } from './attachment.db.js';
import { fileDeletedOn } from './attachment.js';

/** One stored file that was deleted. */
export interface FileDeleted {
  attachmentId: string;
  leaveRequestId: string;
  leaveEndedOn: CalendarDate;
  dueOn: CalendarDate;
}

/** What one run did. */
export interface AttachmentPurgeRun {
  asAt: CalendarDate;
  ranAt: Date;
  /** Null where HR keeps certificates indefinitely. */
  retentionMonths: number | null;
  deleted: readonly FileDeleted[];
}

export class AttachmentPurge {
  constructor(
    private readonly attachments: AttachmentRepository,
    /** NFR SEC 06. The retention period HR set. */
    private readonly organisation: OrganisationRepository,
    private readonly storage: Storage,
  ) {}

  /**
   * Deletes every stored file past its day. Safe to run again.
   *
   * Bytes first, then the row, so a run that fails part way is finished by the next.
   */
  async run(asAt: CalendarDate = calendarDateIn(new Date(), 'UTC')): Promise<AttachmentPurgeRun> {
    const ranAt = new Date();
    const retentionMonths = await this.retentionMonths();
    const deleted: FileDeleted[] = [];

    if (retentionMonths === null) {
      return { asAt, ranAt, retentionMonths, deleted };
    }

    for (const kept of await this.attachments.keptOnLeaveEndedBefore(asAt)) {
      const dueOn = fileDeletedOn(kept.leaveEndedOn, retentionMonths);

      if (dueOn > asAt) {
        continue;
      }

      await this.storage.delete(kept.attachment.storageKey);

      if ((await this.attachments.markFileDeleted(kept.attachment.id)) !== undefined) {
        deleted.push({
          attachmentId: kept.attachment.id,
          leaveRequestId: kept.leaveRequestId,
          leaveEndedOn: kept.leaveEndedOn,
          dueOn,
        });
      }
    }

    return { asAt, ranAt, retentionMonths, deleted };
  }

  /** A database with no settings row uses the default. */
  private async retentionMonths(): Promise<number | null> {
    const settings = await this.organisation.settings();

    return settings === undefined
      ? UNCONFIGURED.attachmentRetentionMonths
      : settings.attachmentRetentionMonths;
  }
}
