/** Reading the audit log. NFR AUD 01, LMS 113. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { AuditLogTable } from '../../db/schema.js';
import type { AuditAction, AuditedEntity, AuditEntry } from './audit.js';

type AuditRow = Selectable<AuditLogTable>;

/** One thing to look up: a kind of record and which one. */
export interface AuditSubject {
  entity: AuditedEntity;
  entityId: string;
}

/** How much to read back. */
export const DEFAULT_LIMIT = 500;

export interface HistoryOptions {
  limit?: number;
  /** Only what happened on or after this instant. */
  since?: Date;
}

export class AuditRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Everything that ever happened to one record, oldest first. */
  async forSubjects(
    subjects: readonly AuditSubject[],
    options: HistoryOptions = {},
  ): Promise<AuditEntry[]> {
    if (subjects.length === 0) {
      // `where (…)` with nothing in it is not valid SQL, and asking about
      // nothing has an answer.
      return [];
    }

    let query = this.db
      .selectFrom('audit_log')
      .selectAll()
      .where((eb) =>
        eb.or(
          subjects.map((subject) =>
            eb.and([eb('entity', '=', subject.entity), eb('entity_id', '=', subject.entityId)]),
          ),
        ),
      );

    if (options.since !== undefined) {
      query = query.where('occurred_at', '>=', options.since);
    }

    const rows = await query
      .orderBy('occurred_at')
      .orderBy('id')
      .limit(options.limit ?? DEFAULT_LIMIT)
      .execute();

    return rows.map(toEntry);
  }

  /** The most recent changes to anything, newest first. */
  async recent(
    options: HistoryOptions & { actorEmployeeId?: string; entity?: AuditedEntity } = {},
  ): Promise<AuditEntry[]> {
    let query = this.db.selectFrom('audit_log').selectAll();

    if (options.actorEmployeeId !== undefined) {
      query = query.where('actor_employee_id', '=', options.actorEmployeeId);
    }
    if (options.entity !== undefined) {
      query = query.where('entity', '=', options.entity);
    }
    if (options.since !== undefined) {
      query = query.where('occurred_at', '>=', options.since);
    }

    const rows = await query
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(options.limit ?? DEFAULT_LIMIT)
      .execute();

    return rows.map(toEntry);
  }

  /** How many entries there are for a record. */
  async countFor(subject: AuditSubject): Promise<number> {
    const row = await this.db
      .selectFrom('audit_log')
      .where('entity', '=', subject.entity)
      .where('entity_id', '=', subject.entityId)
      .select((eb) => eb.fn.countAll<string>().as('entries'))
      .executeTakeFirstOrThrow();

    return Number(row.entries);
  }
}

/** A row as the application sees it. */
function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action as AuditAction,
    entity: row.entity as AuditedEntity,
    entityId: row.entity_id,
    before: row.before,
    after: row.after,
    actor: row.actor,
    actorEmployeeId: row.actor_employee_id,
  };
}
