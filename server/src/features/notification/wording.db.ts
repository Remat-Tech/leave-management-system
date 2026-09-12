/** Database access for HR's wording of the emails. FR 61, LMS 512. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { NotificationTemplateTable } from '../../db/schema.js';
import { recording } from '../../db/recording.js';
import type { Attribution } from '../audit/audit.js';
import type { EmailName, Wording } from './wording.js';

/** HR's wording for one email, and when it last changed. */
export interface SavedWording extends Wording {
  name: EmailName;
  updatedAt: Date;
}

export class EmailWordingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every email HR has reworded. */
  async all(): Promise<SavedWording[]> {
    const rows = await this.db.selectFrom('notification_template').selectAll().execute();

    return rows.map(toSaved);
  }

  /** Saves HR's wording for one email, over any before it. */
  async save(by: Attribution, name: EmailName, wording: Wording): Promise<SavedWording> {
    const row = await recording(this.db, by, (on) =>
      on
        .insertInto('notification_template')
        .values({ name, subject: wording.subject, body: wording.body })
        .onConflict((conflict) =>
          conflict.column('name').doUpdateSet({ subject: wording.subject, body: wording.body }),
        )
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toSaved(row);
  }

  /** Puts one email back to its original wording. */
  async putBack(by: Attribution, name: EmailName): Promise<void> {
    await recording(this.db, by, (on) =>
      on.deleteFrom('notification_template').where('name', '=', name).execute(),
    );
  }
}

function toSaved(row: Selectable<NotificationTemplateTable>): SavedWording {
  return {
    name: row.name as EmailName,
    subject: row.subject,
    body: row.body,
    updatedAt: row.updated_at,
  };
}
