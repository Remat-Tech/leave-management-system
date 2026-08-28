/**
 * Reading the audit log. NFR AUD 01. LMS 113.
 *
 * Queries and row mapping, nothing else — and one thing that is not here at all.
 *
 * **There is no write method, and there must never be one.** Every row in
 * audit_log is written by a trigger on the table that changed; see the audit-log
 * migration for why. An insert from here would be an entry composed by the
 * application, which is an entry the application can compose wrongly, or forget,
 * or write in a different transaction from the change it claims to describe. The
 * table types in ../db/schema.ts say the same thing by making every column
 * unwritable, so this is a rule the compiler holds as well as this comment.
 *
 * lms_app does hold INSERT on the table, because the trigger runs as whoever
 * issued the statement and that is lms_app. It holds no UPDATE and no DELETE,
 * which is what makes the log append only to the application.
 *
 * Everything here is keyed on `entity` and `entity_id`, which is the handle the
 * audit-log migration files entries under: the record's own id, or its parent's
 * for a child table. Turning "this person" into that handle is the service's job
 * — a person's history is their employee record, their login and their roles,
 * and those are three entities.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { AuditLogTable } from '../db/schema.js';
import type { AuditAction, AuditedEntity, AuditEntry } from '../domain/audit.js';

type AuditRow = Selectable<AuditLogTable>;

/** One thing to look up: a kind of record and which one. */
export interface AuditSubject {
  entity: AuditedEntity;
  entityId: string;
}

/**
 * How much to read back.
 *
 * A cap rather than paging, and a large one. The history of a single record over
 * a working life is tens of rows, not thousands, and offering pages of it would
 * be building for a shape nobody has met yet. What the cap is really for is the
 * whole-log read, where an unbounded query against a table that only grows is
 * the sort of thing that works for two years.
 */
export const DEFAULT_LIMIT = 500;

export interface HistoryOptions {
  limit?: number;
  /** Only what happened on or after this instant. */
  since?: Date;
}

export class AuditRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Everything that ever happened to one record, oldest first.
   *
   * Oldest first because that is the direction the question runs. "How did this
   * balance get here" is answered by reading forward from the beginning, and a
   * list that starts at the end is a list somebody has to reverse in their head.
   */
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

  /**
   * The most recent changes to anything, newest first.
   *
   * The other direction, and deliberately: this is not somebody following one
   * record through time, it is somebody asking what has been happening — after
   * an incident, or over the shoulder of a new HR officer's first week.
   *
   * `actorEmployeeId` narrows it to one person's doing, which is the question
   * asked after the denial log has shown somebody probing. Unattributed entries
   * are not reachable that way, which is right: a filter on a person should not
   * quietly include the writes nobody claimed.
   */
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

  /** How many entries there are for a record. For a screen that says "42 changes". */
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

/**
 * A row as the application sees it.
 *
 * `action` and `entity` are cast rather than parsed, and that is a considered
 * difference from how a role code is read. A role code arrives from a form and
 * is refused if it is not one of four; these arrive from a column a CHECK
 * constraint holds closed and a trigger fills from TG_TABLE_NAME, so there is no
 * writer that could put anything else there. Validating would be defending
 * against the database having lied.
 */
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
