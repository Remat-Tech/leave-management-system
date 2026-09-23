/** Reading the audit log. NFR AUD 01. */

import { type Kysely, type Selectable, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { AuditLogTable } from '../../db/schema.js';
import type {
  AuditAction,
  AuditedEntity,
  AuditEntry,
  AuditRecordOption,
  AuditSearch,
  NamedAuditEntry,
  RecordSource,
} from './audit.js';

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

  /** Entries matching a search, newest first, with the day boundaries in `zone`. */
  async search(search: AuditSearch, zone: string, limit: number): Promise<NamedAuditEntry[]> {
    let query = this.db
      .selectFrom('audit_log')
      .leftJoin('employee', 'employee.id', 'audit_log.actor_employee_id')
      .selectAll('audit_log')
      .select(['employee.first_name', 'employee.last_name']);

    if (search.entity !== undefined) {
      query = query.where('audit_log.entity', '=', search.entity);
    }
    if (search.entityId !== undefined) {
      query = query.where('audit_log.entity_id', '=', search.entityId);
    }
    if (search.from !== undefined) {
      query = query.where(
        'audit_log.occurred_at',
        '>=',
        sql<Date>`(${search.from}::date)::timestamp AT TIME ZONE ${zone}`,
      );
    }
    if (search.to !== undefined) {
      query = query.where(
        'audit_log.occurred_at',
        '<',
        sql<Date>`(${search.to}::date + 1)::timestamp AT TIME ZONE ${zone}`,
      );
    }

    const rows = await query
      .orderBy('audit_log.occurred_at', 'desc')
      .orderBy('audit_log.id', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      ...toEntry(row),
      actorName:
        row.first_name === null || row.last_name === null
          ? null
          : `${row.first_name} ${row.last_name}`,
    }));
  }

  /**
   * The records of one kind, for the picker on the search screen.
   *
   * A leaver and a closed department are both listed. What happened to a record is exactly the
   * question somebody asks after it stops being current, so filtering these to the active ones
   * would hide the histories most worth reading.
   */
  async recordsFor(source: RecordSource): Promise<AuditRecordOption[]> {
    switch (source) {
      case 'employee': {
        const rows = await this.db
          .selectFrom('employee')
          .select(['id', 'first_name', 'last_name', 'employee_number'])
          .orderBy('last_name')
          .orderBy('first_name')
          .execute();

        return rows.map((row) => ({
          id: row.id,
          label: `${row.first_name} ${row.last_name} · ${row.employee_number}`,
        }));
      }

      case 'app_user': {
        /* Labelled by the person, not by the address: the reader is looking for whose login
           changed, and two of them can share neither name nor id here. */
        const rows = await this.db
          .selectFrom('app_user')
          .innerJoin('employee', 'employee.id', 'app_user.employee_id')
          .select([
            'app_user.id as id',
            'employee.first_name',
            'employee.last_name',
            'employee.employee_number',
          ])
          .orderBy('employee.last_name')
          .orderBy('employee.first_name')
          .execute();

        return rows.map((row) => ({
          id: row.id,
          label: `${row.first_name} ${row.last_name} · ${row.employee_number}`,
        }));
      }

      case 'department': {
        const rows = await this.db
          .selectFrom('department')
          .select(['id', 'name'])
          .orderBy('name')
          .execute();

        return rows.map((row) => ({ id: row.id, label: row.name }));
      }

      case 'work_pattern': {
        const rows = await this.db
          .selectFrom('work_pattern')
          .select(['id', 'name'])
          .orderBy('name')
          .execute();

        return rows.map((row) => ({ id: row.id, label: row.name }));
      }

      case 'leave_type': {
        const rows = await this.db
          .selectFrom('leave_type')
          .select(['id', 'name'])
          .orderBy('name')
          .execute();

        return rows.map((row) => ({ id: row.id, label: row.name }));
      }

      case 'leave_year': {
        /* Newest first, unlike the rest: the year somebody is asking about is almost always
           the current one, and it sorts to the bottom by label. */
        const rows = await this.db
          .selectFrom('leave_year')
          .select(['id', 'label'])
          .orderBy('start_date', 'desc')
          .execute();

        return rows.map((row) => ({ id: row.id, label: row.label }));
      }
    }
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
