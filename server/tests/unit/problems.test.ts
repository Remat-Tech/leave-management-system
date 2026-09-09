import { describe, expect, it } from 'vitest';
import { problemFor } from '../../src/http/problems.js';
import { NotEnoughDays } from '../../src/features/leave-request/leave-request.js';
import type { LeaveType } from '../../src/features/leave-type/leave-type.js';

/**
 * What a refusal says to the person who met it. NFR USA 03, LMS 410.
 *
 * ../integration/request-form-api.test.ts proves the domain's own sentences arrive over HTTP
 * intact. What is left is the two claims this layer is answerable for: the one sentence it
 * writes itself, and that it rewords nothing else on the way out.
 */
describe('what a refusal says', () => {
  /** "Something went wrong. It has been logged." stated a fact about our filing, not an act. */
  it('says what to do about a fault, and not only that it happened', () => {
    const { status, body } = problemFor(new Error('a column that is not there'));

    expect(status).toBe(500);
    expect(body.error).toBe('Unexpected');

    /* Ours rather than theirs, so nobody goes looking through what they typed. */
    expect(body.message).toContain('at our end');

    /* And the two acts that are actually theirs. */
    expect(body.message).toContain('Try again');
    expect(body.message).toContain('tell IT');
  });

  /** And it never says what went wrong, which is NFR SEC 03 rather than politeness. */
  it('and says nothing about the fault itself', () => {
    const { body } = problemFor(new Error('relation "leave_balance" does not exist'));

    expect(body.message).not.toContain('leave_balance');
  });

  /** The story's second criterion, at the one layer that could quietly undo it. */
  it('carries a balance refusal to the browser with the figure still in it', () => {
    const { status, body } = problemFor(
      new NotEnoughDays(annualLeave, { from: '2026-03-02', to: '2026-03-10' }, 6, 3),
    );

    expect(status).toBe(409);
    expect(body.error).toBe('NotEnoughDays');
    expect(body.message).toContain('6 days of Annual Leave and you have 3 left');
    expect(body.message).toContain('Ask for 3 days or fewer');
  });

  /** The one leave type this file needs, and only the fields a refusal reads off one. */
  const annualLeave = { id: 'annual', name: 'Annual Leave' } as LeaveType;
});
