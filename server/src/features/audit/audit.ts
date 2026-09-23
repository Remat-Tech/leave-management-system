/** What an audit entry is. NFR AUD 01, NFR AUD 02. */

import { type CalendarDate, isCalendarDate } from '../../shared/time.js';

/** Who a write is attributed to. */
export interface Attribution {
  employeeId: string | null;
  description: string;
}

/** What happened to the record. */
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

/** The tables an entry can be about. */
export const AUDITED_ENTITIES = [
  'employee',
  'department',
  'work_pattern',
  'work_pattern_day',
  'app_user',
  'user_role',
  'leave_type',
  'leave_entitlement_rule',
  'leave_type_approval_step',
  'leave_year',
  'holiday',
  'leave_entitlement_event',
  'leave_request',
  'organisation_setting',
  /** FR 49. */
  'approval_delegation',
  /** FR 61. */
  'notification_template',
] as const;

export type AuditedEntity = (typeof AUDITED_ENTITIES)[number];

/** Each kind of record, as the audit screen names it. */
export const AUDITED_ENTITY_LABELS: Readonly<Record<AuditedEntity, string>> = {
  employee: 'Employee',
  department: 'Department',
  work_pattern: 'Working pattern',
  work_pattern_day: 'Working pattern days',
  app_user: 'Login',
  user_role: 'Roles',
  leave_type: 'Leave type',
  leave_entitlement_rule: 'Entitlement rule',
  leave_type_approval_step: 'Approval chain',
  leave_year: 'Leave year',
  holiday: 'Public holiday',
  leave_entitlement_event: 'Entitlement event',
  leave_request: 'Leave request',
  organisation_setting: 'Policy setting',
  approval_delegation: 'Delegation',
  notification_template: 'Email wording',
};

/**
 * The kinds whose records can be offered as a list rather than typed as an id.
 *
 * Only where the set is bounded by something that does not grow with use: headcount, the
 * departments, the leave types. `leave_request` and `leave_entitlement_event` are deliberately
 * absent — there is one per request and one per accrual, so a list of them is a list that is
 * useless within a month, and those keep the typed id.
 *
 * The value is the table to draw the list from, which is not always the entity's own: a child
 * table is filed under its parent, so `work_pattern_day` is picked from the patterns and
 * `user_role` from the logins. See the audit-log migration's note on `entity_id`.
 */
export const PICKABLE_ENTITIES = {
  employee: 'employee',
  department: 'department',
  work_pattern: 'work_pattern',
  work_pattern_day: 'work_pattern',
  app_user: 'app_user',
  user_role: 'app_user',
  leave_type: 'leave_type',
  leave_year: 'leave_year',
} as const satisfies Partial<Record<AuditedEntity, string>>;

export type PickableEntity = keyof typeof PICKABLE_ENTITIES;

/** Which table a kind's records are listed from. */
export type RecordSource = (typeof PICKABLE_ENTITIES)[PickableEntity];

export function isPickableEntity(value: string): value is PickableEntity {
  return Object.hasOwn(PICKABLE_ENTITIES, value);
}

/** One record, as a picker names it. */
export interface AuditRecordOption {
  id: string;
  label: string;
}

/** What the audit log says when nobody said who they were. */
export const UNATTRIBUTED = 'not named by the writer';

/** One change to one record, as it was written down. */
export interface AuditEntry {
  id: string;
  occurredAt: Date;
  action: AuditAction;
  entity: AuditedEntity;
  /** The record this is filed under: its own id, or its parent's for a child table. */
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Who, in words. */
  actor: string;
  /** Who, as an id to join on. */
  actorEmployeeId: string | null;
}

/** An entry with the writer's name, where the writer is an employee. */
export interface NamedAuditEntry extends AuditEntry {
  actorName: string | null;
}

/** The most entries one search shows. */
export const LONGEST_SEARCH = 200;

/** Longer than any id a record has. */
const LONGEST_ENTITY_ID = 64;

/** What the audit log is searched by, each part optional. */
export interface AuditSearch {
  entity?: AuditedEntity;
  entityId?: string;
  from?: CalendarDate;
  to?: CalendarDate;
}

/** A search the log cannot answer, naming the field. */
export class InvalidAuditSearch extends Error {
  readonly field: keyof AuditSearch;

  constructor(field: keyof AuditSearch, message: string) {
    super(message);
    this.name = 'InvalidAuditSearch';
    this.field = field;
  }
}

/** The search as it arrived, checked. */
export function readAuditSearch(asked: Partial<Record<keyof AuditSearch, string>>): AuditSearch {
  const entity = filled(asked.entity);
  const entityId = filled(asked.entityId);
  const from = filled(asked.from);
  const to = filled(asked.to);

  if (entity !== undefined && !isAuditedEntity(entity)) {
    throw new InvalidAuditSearch('entity', 'That is not a kind of record the audit log keeps.');
  }

  if (entityId !== undefined && entity === undefined) {
    // Ids repeat across tables.
    throw new InvalidAuditSearch('entity', 'Choose the kind of record that id belongs to.');
  }

  if (entityId !== undefined && entityId.length > LONGEST_ENTITY_ID) {
    throw new InvalidAuditSearch('entityId', 'That is not the id of a record.');
  }

  if (from !== undefined && !isCalendarDate(from)) {
    throw new InvalidAuditSearch('from', 'A date is written as YYYY-MM-DD.');
  }

  if (to !== undefined && !isCalendarDate(to)) {
    throw new InvalidAuditSearch('to', 'A date is written as YYYY-MM-DD.');
  }

  if (from !== undefined && to !== undefined && to < from) {
    throw new InvalidAuditSearch('to', `The search ends on ${to}, before it starts on ${from}.`);
  }

  return { entity, entityId, from, to };
}

function isAuditedEntity(value: string): value is AuditedEntity {
  return (AUDITED_ENTITIES as readonly string[]).includes(value);
}

/** Trimmed, with blank as not sent. */
function filled(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === '' ? undefined : trimmed;
}

/** One field that moved, for a screen that shows a change rather than a record. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Which fields moved, and to what. */
export function changedFields(entry: AuditEntry): FieldChange[] {
  const fields = [
    ...new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})]),
  ].sort();

  return fields
    .map((field) => ({
      field,
      from: entry.before?.[field] ?? null,
      to: entry.after?.[field] ?? null,
    }))
    .filter((change) => JSON.stringify(change.from) !== JSON.stringify(change.to));
}

/** Whether this entry is about a secret, and so says only that one changed. */
export const REDACTED = '[set]';

export function isRedacted(value: unknown): boolean {
  return value === REDACTED;
}
