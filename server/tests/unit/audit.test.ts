import { describe, expect, it } from 'vitest';
import {
  AUDITED_ENTITIES,
  type AuditEntry,
  changedFields,
  isRedacted,
  REDACTED,
  UNATTRIBUTED,
} from '../../src/domain/audit.js';

/**
 * The audit log, with no database. NFR AUD 01. LMS 113.
 *
 * Almost all of this story is in the database — the trigger that writes the
 * entries, the rules that refuse to let them change — so there is less to test
 * without one here than in most stories, and the integration suite carries the
 * weight. What is here is the reading of an entry, which is a pure function and
 * is the part a screen will lean on.
 *
 * {@link changedFields} is the whole of it. An entry holds two snapshots because
 * that is what settles an argument; nobody wants to read two snapshots, and
 * turning them into "her working pattern changed on 3 March" is this function's
 * job.
 */

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '1',
    occurredAt: new Date('2026-03-03T09:04:00Z'),
    action: 'UPDATE',
    entity: 'employee',
    entityId: '11',
    before: { id: '11', job_title: 'Officer', work_pattern_id: '1' },
    after: { id: '11', job_title: 'Officer', work_pattern_id: '2' },
    actor: 'employee 9',
    actorEmployeeId: '9',
    ...overrides,
  };
}

describe('the entities an entry can be about', () => {
  it('does not include role, which only a migration writes', () => {
    /* lms_app holds no INSERT, UPDATE or DELETE on it since the
       role-assignment-rules migration, so the only writer is a file in git with
       an author and a review on it. That is a better record than a row. */
    expect(AUDITED_ENTITIES as readonly string[]).not.toContain('role');
  });

  it('does not include the audit log itself', () => {
    // It is never updated or deleted, and a trigger recording its own inserts is
    // a loop.
    expect(AUDITED_ENTITIES as readonly string[]).not.toContain('audit_log');
  });

  it('covers every table the application can change', () => {
    // The integration suite asserts this list against the triggers the migration
    // actually created; this is the half that can be read at a glance.
    expect([...AUDITED_ENTITIES]).toEqual([
      'employee',
      'department',
      'work_pattern',
      'work_pattern_day',
      'app_user',
      'user_role',
      'leave_type',
      'leave_entitlement_rule',
      /* LMS 204. A step has no updated_at of its own, so these entries are the
         whole of the history of who approves what. */
      'leave_type_approval_step',
      /* LMS 205. Mostly one entry that matters per year — closing it — and after
         that nothing about the year can move, so the entry is the record of the
         one decision that made that true. */
      'leave_year',
    ]);
  });
});

describe('reading what changed', () => {
  it('names the field that moved, and what it moved from', () => {
    expect(changedFields(entry())).toEqual([{ field: 'work_pattern_id', from: '1', to: '2' }]);
  });

  it('says nothing about the fields that stayed', () => {
    // A record has a dozen columns and a change usually touches one. A reading
    // that listed all twelve would be the snapshots again, with extra steps.
    expect(changedFields(entry()).map((change) => change.field)).not.toContain('job_title');
  });

  it('reports a creation as every field arriving from nothing', () => {
    const created = entry({
      action: 'CREATE',
      before: null,
      after: { id: '11', job_title: 'Officer' },
    });

    expect(changedFields(created)).toEqual([
      { field: 'id', from: null, to: '11' },
      { field: 'job_title', from: null, to: 'Officer' },
    ]);
  });

  it('reports a deletion as every field going to nothing', () => {
    const deleted = entry({
      action: 'DELETE',
      before: { id: '3', name: 'Four days, Wednesdays off' },
      after: null,
    });

    expect(changedFields(deleted)).toEqual([
      { field: 'id', from: '3', to: null },
      { field: 'name', from: 'Four days, Wednesdays off', to: null },
    ]);
  });

  it('notices a field that only exists on one side', () => {
    /* Two entries written either side of a migration describe two different
       shapes of the same table, and history has to survive the schema moving.
       A reading that only walked the fields of `after` would silently skip a
       dropped column. */
    const migrated = entry({
      before: { id: '11', old_column: 'gone' },
      after: { id: '11', new_column: 'arrived' },
    });

    expect(changedFields(migrated).map((change) => change.field)).toEqual([
      'new_column',
      'old_column',
    ]);
  });

  it('finds nothing to say about a change that changed nothing', () => {
    /* The trigger refuses to write one of these at all — an update that moves no
       column material to anybody writes no entry — so this is a belt on the
       braces rather than a case anybody meets. */
    const unchanged = entry({ after: { id: '11', job_title: 'Officer', work_pattern_id: '1' } });

    expect(changedFields(unchanged)).toEqual([]);
  });

  it('orders the fields the same way every time', () => {
    // A screen showing a change should not reorder its rows because the driver
    // happened to hand the keys back differently.
    const scrambled = entry({
      before: { zebra: 1, apple: 1 },
      after: { apple: 2, zebra: 2 },
    });

    expect(changedFields(scrambled).map((change) => change.field)).toEqual(['apple', 'zebra']);
  });
});

describe('a secret in an entry', () => {
  it('says that one was set and never what it was', () => {
    /* The whole rule about credentials in the audit log. A password hash in a
       table the application can SELECT would make this the cheapest way to steal
       every credential in the building, so what is stored is the fact of a
       change and not the value. */
    const reset = entry({
      entity: 'app_user',
      before: { id: '4', password_hash: REDACTED },
      after: { id: '4', password_hash: REDACTED },
    });

    expect(isRedacted(reset.after!.password_hash)).toBe(true);
    expect(reset.before!.password_hash).not.toMatch(/scrypt/);
  });

  it('shows a password being set for the first time as a change', () => {
    const first = entry({
      entity: 'app_user',
      before: { id: '4', password_hash: null },
      after: { id: '4', password_hash: REDACTED },
    });

    expect(changedFields(first)).toEqual([{ field: 'password_hash', from: null, to: REDACTED }]);
  });
});

describe('an entry nobody claimed', () => {
  it('says so in words rather than leaving a null for every reader to guard', () => {
    /* A migration correcting data, the seed loading fixtures, somebody at a psql
       prompt. "Nobody is recorded as having done this" is itself a finding. */
    const unattributed = entry({ actor: UNATTRIBUTED, actorEmployeeId: null });

    expect(unattributed.actor).toBe(UNATTRIBUTED);
    expect(UNATTRIBUTED).not.toBe('');
  });
});
