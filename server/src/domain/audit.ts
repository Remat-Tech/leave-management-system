/**
 * What an audit entry is. NFR AUD 01 and NFR AUD 02. LMS 113.
 *
 * The story is a dispute two years from now. Somebody's balance is wrong, or is
 * said to be, and nobody remembers why. What settles it is not a memory and not
 * a log line — it is a row written at the time by the same statement that made
 * the change, which nobody has been able to touch since.
 *
 * The rules live here as types and pure functions. The rows are written by
 * database triggers, which is the whole design and is argued for in the
 * audit-log migration: an entry a service composes is an entry a service can
 * compose wrongly, or forget, or write outside the transaction that made the
 * change. Nothing in this file, and nothing above it, ever inserts one.
 *
 * What the application *does* supply is the one thing the database cannot know,
 * which is who. That is {@link Attribution}, and it reaches the trigger through a
 * transaction-local setting the repositories put there — see
 * ../repositories/recording.ts.
 */

/**
 * Who a write is attributed to.
 *
 * Structurally satisfied by {@link Actor}, and deliberately not that type. A
 * repository has no business knowing what a role is or what an authorisation
 * decision looks like; what it needs from the caller is a name and an id, which
 * is what this says and all it says. `/domain` importing `/auth` would be the
 * layering rule going backwards.
 *
 * `employeeId` is null for work no person asked for — a job, the seed, a
 * migration — and that is a fact to record rather than a gap to fill in. See
 * {@link theSystem}.
 */
export interface Attribution {
  employeeId: string | null;
  description: string;
}

/** What happened to the record. */
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * The tables an entry can be about.
 *
 * The same six the audit-log migration attaches a trigger to, and the
 * integration suite asserts the two agree — a table given a trigger and not
 * named here is a table whose history nothing can read, and a name here with no
 * trigger is a promise of history that was never recorded.
 *
 * `role` is deliberately absent. lms_app cannot write it, so the only writer is
 * a migration, which is a file in git with an author and a review on it.
 */
export const AUDITED_ENTITIES = [
  'employee',
  'department',
  'work_pattern',
  'work_pattern_day',
  'app_user',
  'user_role',
] as const;

export type AuditedEntity = (typeof AUDITED_ENTITIES)[number];

/**
 * What the audit log says when nobody said who they were.
 *
 * A migration correcting data, the seed loading fixtures, somebody at a psql
 * prompt. The same sentence the audit-log migration writes, and the integration
 * suite asserts they are still the same sentence — a constant here that has
 * drifted from the SQL is a filter that quietly matches nothing.
 *
 * It is a sentence rather than a null because "nobody is recorded as having done
 * this" is itself a finding, and a null is a thing every reader has to guard and
 * half of them forget to.
 */
export const UNATTRIBUTED = 'not named by the writer';

/**
 * One change to one record, as it was written down.
 *
 * `before` and `after` are the whole record either side of the change rather
 * than a list of what moved. That is what makes an entry settle an argument: "her
 * start date says 2023" is answered by a snapshot, and is not answered by knowing
 * that somebody changed some fields in March.
 *
 * They are loosely typed on purpose. An entry written in 2026 describes the
 * `employee` table as it was in 2026, and history has to stay readable when the
 * schema moves under it — typing these as `Employee` would be a claim that every
 * row ever written matches today's interface, which is the one thing an audit
 * log must not assume.
 */
export interface AuditEntry {
  id: string;
  occurredAt: Date;
  action: AuditAction;
  entity: AuditedEntity;
  /** The record this is filed under: its own id, or its parent's for a child table. */
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Who, in words. {@link UNATTRIBUTED} when nobody said. */
  actor: string;
  /** Who, as an id to join on. Null for the system and for anything unattributed. */
  actorEmployeeId: string | null;
}

/** One field that moved, for a screen that shows a change rather than a record. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Which fields moved, and to what.
 *
 * The reading of an entry, rather than the entry. A person disputing a balance
 * wants "her working pattern changed on 3 March, from the standard week to four
 * days" — the snapshots are what make that answerable and are not what anybody
 * wants to read.
 *
 * Every field either side is considered, not only those in `after`, so that a
 * column added or dropped between two entries shows up as a change rather than
 * being silently skipped. Compared by their JSON text, because that is the form
 * they were stored in and two values that serialise identically are the same
 * value as far as this record is concerned.
 *
 * A CREATE reports every field as arriving from nothing and a DELETE as going to
 * nothing, which is the honest reading of both.
 */
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

/**
 * Whether this entry is about a secret, and so says only that one changed.
 *
 * The audit log stores `"[set]"` where a credential was, so that the fact of a
 * password being set or reset is recorded and the value is not. A screen showing
 * a change wants to say "the password was reset" rather than showing `[set]`
 * becoming `[set]`, which reads like a bug.
 */
export const REDACTED = '[set]';

export function isRedacted(value: unknown): boolean {
  return value === REDACTED;
}
