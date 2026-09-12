/** What an audit entry is. NFR AUD 01, NFR AUD 02, LMS 113, LMS 513. */

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
  /** LMS 201. */
  'leave_type',
  /** LMS 203. */
  'leave_entitlement_rule',
  /** LMS 204. */
  'leave_type_approval_step',
  /** LMS 205. */
  'leave_year',
  /** LMS 206. */
  'holiday',
  /** LMS 218. */
  'leave_entitlement_event',
  /** LMS 301. */
  'leave_request',
  /** LMS 321. */
  'organisation_setting',
  /** FR 49, LMS 327. */
  'approval_delegation',
  /** FR 61, LMS 512. */
  'notification_template',
] as const;

export type AuditedEntity = (typeof AUDITED_ENTITIES)[number];

/** Each kind of record, as the audit screen names it. LMS 513. */
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

/** An entry with the writer's name, where the writer is an employee. LMS 513. */
export interface NamedAuditEntry extends AuditEntry {
  actorName: string | null;
}

/** The most entries one search shows. LMS 513. */
export const LONGEST_SEARCH = 200;

/** Longer than any id a record has. */
const LONGEST_ENTITY_ID = 64;

/** What the audit log is searched by, each part optional. LMS 513. */
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

/** The search as it arrived, checked. LMS 513. */
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
