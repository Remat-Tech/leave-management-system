/** What an audit entry is. NFR AUD 01, NFR AUD 02, LMS 113. */

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
] as const;

export type AuditedEntity = (typeof AUDITED_ENTITIES)[number];

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
