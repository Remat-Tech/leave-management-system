import { describe, expect, it } from 'vitest';
import {
  ATTEMPTS_ALLOWED,
  BACKOFF_FACTOR,
  backoffAfter,
  type DeliveryRun,
  FIRST_RETRY_AFTER_SECONDS,
  nextAttemptAfter,
  type Redelivered,
  summaryOf,
  wouldGiveUpAfter,
} from '../../src/features/notification/delivery.js';
import { notificationPolicy } from '../../src/features/notification/policy.js';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import type { RoleCode } from '../../src/features/role/roles.js';

/**
 * When a failed send is tried again. FR 59, §7.1. LMS 331.
 *
 * The arithmetic of the story's first criterion, which is a pure function and belongs here.
 * ../integration/delivery.test.ts is where the claim, the record and the second criterion —
 * that a mail failure rolls nothing back — are proved against a real server.
 */

const FAILED_AT = new Date('2026-03-02T09:00:00Z');

const secondsBetween = (later: Date, earlier: Date): number =>
  (later.getTime() - earlier.getTime()) / 1000;

describe('the wait after a failed send', () => {
  it('starts at a minute', () => {
    expect(backoffAfter(1)).toBe(FIRST_RETRY_AFTER_SECONDS);
  });

  it('and multiplies for each attempt after that', () => {
    expect(backoffAfter(2)).toBe(FIRST_RETRY_AFTER_SECONDS * BACKOFF_FACTOR);
    expect(backoffAfter(3)).toBe(FIRST_RETRY_AFTER_SECONDS * BACKOFF_FACTOR ** 2);
  });

  /* The whole point of backing off: a mail server that is down stops being asked every
     minute, so the retries do not become the outage. */
  it('so each wait is longer than the one before it', () => {
    const waits = [1, 2, 3, 4, 5].map(backoffAfter);

    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(new Set(waits).size).toBe(waits.length);
  });

  /* An evening outage still delivers before the next working morning, which is the figure
     ATTEMPTS_ALLOWED was chosen for. */
  it('and the attempts together span more than a working night', () => {
    const total = [1, 2, 3, 4, 5]
      .slice(0, ATTEMPTS_ALLOWED - 1)
      .reduce((sum, attempt) => sum + backoffAfter(attempt), 0);

    expect(total / 3600).toBeGreaterThan(12);
  });
});

describe('when the next attempt is due', () => {
  it('is the wait after the one that just failed', () => {
    const due = nextAttemptAfter(1, FAILED_AT);

    expect(due).not.toBeNull();
    expect(secondsBetween(due as Date, FAILED_AT)).toBe(FIRST_RETRY_AFTER_SECONDS);
  });

  it('and each one is further out than the last', () => {
    const first = nextAttemptAfter(1, FAILED_AT) as Date;
    const third = nextAttemptAfter(3, FAILED_AT) as Date;

    expect(third.getTime()).toBeGreaterThan(first.getTime());
  });

  /* Six attempts and then it stops. A notice retried for ever is a mailbox that no longer
     exists being written to for ever. */
  it('and there is no attempt after the last one allowed', () => {
    expect(nextAttemptAfter(ATTEMPTS_ALLOWED - 1, FAILED_AT)).not.toBeNull();
    expect(nextAttemptAfter(ATTEMPTS_ALLOWED, FAILED_AT)).toBeNull();
    expect(nextAttemptAfter(ATTEMPTS_ALLOWED + 1, FAILED_AT)).toBeNull();
  });

  it('which is the same question wouldGiveUpAfter answers', () => {
    expect(wouldGiveUpAfter(ATTEMPTS_ALLOWED - 1)).toBe(false);
    expect(wouldGiveUpAfter(ATTEMPTS_ALLOWED)).toBe(true);
  });

  /* Deterministic, so two notices that failed in the same second come back in the same
     second. One job drains them one at a time, so there is nothing to spread out. */
  it('and the same failure always gives the same answer', () => {
    expect(nextAttemptAfter(2, FAILED_AT)).toEqual(nextAttemptAfter(2, FAILED_AT));
  });
});

/* ------------------------------------------------- who may drain the undelivered post */

const asHr = (role: RoleCode) => signedInAs('3', { roles: [role], isManager: false });

/** Somebody with post of their own and no role at all. */
const THEM = signedInAs('7', { roles: ['EMPLOYEE'], isManager: false });

describe('standing to send again', () => {
  it('is the system, which is what runs it', () => {
    expect(notificationPolicy.resend(theSystem('undelivered notices')).allowed).toBe(true);
  });

  it('and HR, who runs it by hand when the mail server comes back', () => {
    expect(notificationPolicy.resend(asHr('HR_OFFICER')).allowed).toBe(true);
    expect(notificationPolicy.resend(asHr('HR_ADMIN')).allowed).toBe(true);
  });

  /* The company's post, not one person's. An employee reading their own notifications is
     `read` and is unchanged; sending everybody's again is not a thing they do. */
  it('and nobody else, however much of their own post they can read', () => {
    expect(notificationPolicy.resend(THEM).allowed).toBe(false);
    expect(notificationPolicy.read(THEM, { employeeId: '7' }).allowed).toBe(true);
  });

  it('and the refusal says why, for the log', () => {
    expect(notificationPolicy.resend(THEM).because).toContain('undelivered post');
  });
});

/* ---------------------------------------------------------------- what a run reports */

describe('the summary of a run', () => {
  const attempt = (overrides: Partial<Redelivered> = {}): Redelivered => ({
    noticeId: '1',
    employeeId: '7',
    attempt: 2,
    emailed: true,
    tryingAgainAt: null,
    gaveUp: false,
    ...overrides,
  });

  const run = (overrides: Partial<DeliveryRun> = {}): DeliveryRun => ({
    ranAt: FAILED_AT,
    due: 0,
    attempted: [],
    claimedElsewhere: 0,
    ...overrides,
  });

  it('counts what was due, what was tried and what arrived', () => {
    const said = summaryOf(run({ due: 3, attempted: [attempt(), attempt({ emailed: false })] }));

    expect(said).toContain('3 undelivered notices due');
    expect(said).toContain('2 tried');
    expect(said).toContain('1 delivered');
  });

  it('and reads as a sentence when there is one of them', () => {
    expect(summaryOf(run({ due: 1 }))).toContain('1 undelivered notice due');
  });

  /* The line an operator is actually looking for: somebody was never told. */
  it('and says so where something was given up on', () => {
    const said = summaryOf(run({ due: 1, attempted: [attempt({ emailed: false, gaveUp: true })] }));

    expect(said).toContain('1 gave up');
    expect(said).toContain(String(ATTEMPTS_ALLOWED));
  });

  it('and does not mention giving up where nothing was', () => {
    expect(summaryOf(run({ due: 1, attempted: [attempt()] }))).not.toContain('gave up');
  });
});
