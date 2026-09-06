import { describe, expect, it } from 'vitest';
import {
  bulkInWords,
  MOST_AT_ONCE,
  NotABulkAction,
  NothingToDecide,
  TooManyToDecideAtOnce,
  validateBulkDecision,
} from '../../src/features/leave-request/bulk-decision.js';
import { RefusalNeedsAComment } from '../../src/features/leave-request/leave-decision.js';

/**
 * What a batch is checked for before anything is decided. FR 51, FR 39. LMS 328.
 *
 * ../integration/bulk-approval.test.ts walks the decisions themselves. This is the door: which
 * verbs a queue may be cleared with, the reason a batch of refusals owes, and what the list of
 * rows amounts to once it has been read.
 */

const A_ROW = { requestId: 'r-1', version: '2026-03-01T09:00:00.000Z' };

describe('the verb a batch carries', () => {
  it('takes the two a queue is cleared with', () => {
    expect(
      validateBulkDecision({ action: 'APPROVE', comment: null, requests: ['r-1'] }).action,
    ).toBe('APPROVE');

    expect(
      validateBulkDecision({ action: 'REFUSE', comment: 'Two of you are away', requests: ['r-1'] })
        .action,
    ).toBe('REFUSE');
  });

  /* FR 44. An override is reasoned about one request at a time, so it has no batch. */
  it('and refuses an override, naming why it is decided one at a time', () => {
    expect(() =>
      validateBulkDecision({
        action: 'OVERTURN_REJECTION',
        comment: 'Policy',
        requests: ['r-1'],
      }),
    ).toThrow(NotABulkAction);

    try {
      validateBulkDecision({ action: 'OVERTURN_REJECTION', comment: 'Policy', requests: ['r-1'] });
    } catch (error) {
      expect((error as Error).message).toContain('one request at a time');
      expect((error as { field: string }).field).toBe('action');
    }
  });

  it('and refuses a verb that is no decision at all', () => {
    expect(() =>
      validateBulkDecision({ action: 'WITHDRAW', comment: null, requests: ['r-1'] }),
    ).toThrow(NotABulkAction);

    expect(() => validateBulkDecision({ action: 7, comment: null, requests: ['r-1'] })).toThrow(
      NotABulkAction,
    );
  });
});

describe('the reason a batch of refusals owes', () => {
  /* FR 39. The same rule the single door keeps, asked once for the whole selection. */
  it('is required, and refused before the selection is read', () => {
    expect(() =>
      validateBulkDecision({ action: 'REFUSE', comment: '   ', requests: ['r-1'] }),
    ).toThrow(RefusalNeedsAComment);

    /* The list is empty as well, and it is the comment that is answered: nothing is decided
       either way, and a form puts this message beside the box somebody left blank. */
    expect(() => validateBulkDecision({ action: 'REFUSE', comment: null, requests: [] })).toThrow(
      RefusalNeedsAComment,
    );
  });

  it('and goes on every one of them', () => {
    const batch = validateBulkDecision({
      action: 'REFUSE',
      comment: '  Two of the team are already away that week  ',
      requests: ['r-1', 'r-2'],
    });

    expect(batch.comment).toBe('Two of the team are already away that week');
  });

  /** An approval owes none, which is FR 39's asymmetry. */
  it('while an approval may say nothing', () => {
    expect(
      validateBulkDecision({ action: 'APPROVE', comment: undefined, requests: ['r-1'] }).comment,
    ).toBeNull();
  });
});

describe('the rows a batch names', () => {
  it('keeps the version each queue row handed out', () => {
    const batch = validateBulkDecision({ action: 'APPROVE', comment: null, requests: [A_ROW] });

    expect(batch.requests).toEqual([A_ROW]);
  });

  /* NFR DAT 02, LMS 326. A caller with no screen behind it is answered by the locks alone. */
  it('and takes a bare id as a row with no version', () => {
    const batch = validateBulkDecision({ action: 'APPROVE', comment: null, requests: [' r-1 '] });

    expect(batch.requests).toEqual([{ requestId: 'r-1', version: null }]);
  });

  it('and keeps them in the order they arrived', () => {
    const batch = validateBulkDecision({
      action: 'APPROVE',
      comment: null,
      requests: ['r-3', 'r-1', 'r-2'],
    });

    expect(batch.requests.map((one) => one.requestId)).toEqual(['r-3', 'r-1', 'r-2']);
  });

  /* One decision at a desk, so one row here. The second mention would have lost to the first. */
  it('and the same request twice is one decision', () => {
    const batch = validateBulkDecision({
      action: 'APPROVE',
      comment: null,
      requests: [A_ROW, { requestId: 'r-1', version: 'a-later-one' }, 'r-2'],
    });

    expect(batch.requests).toEqual([A_ROW, { requestId: 'r-2', version: null }]);
  });

  it('and drops an entry that names nothing', () => {
    const batch = validateBulkDecision({
      action: 'APPROVE',
      comment: null,
      requests: [null, 7, '', { version: 'x' }, 'r-1'],
    });

    expect(batch.requests).toEqual([{ requestId: 'r-1', version: null }]);
  });

  it('and refuses a batch that selected nothing', () => {
    expect(() => validateBulkDecision({ action: 'APPROVE', comment: null, requests: [] })).toThrow(
      NothingToDecide,
    );

    expect(() =>
      validateBulkDecision({ action: 'APPROVE', comment: null, requests: 'r-1' }),
    ).toThrow(NothingToDecide);

    /* Everything sent named nothing, which is the same news as sending nothing. */
    expect(() =>
      validateBulkDecision({ action: 'APPROVE', comment: null, requests: [null, ''] }),
    ).toThrow(NothingToDecide);
  });

  it('and refuses more than one press decides, naming how many', () => {
    const tooMany = Array.from({ length: MOST_AT_ONCE + 1 }, (_, index) => `r-${String(index)}`);

    expect(() =>
      validateBulkDecision({ action: 'APPROVE', comment: null, requests: tooMany }),
    ).toThrow(TooManyToDecideAtOnce);

    /* And the cap itself goes through, so the message is about one row too many. */
    expect(
      validateBulkDecision({ action: 'APPROVE', comment: null, requests: tooMany.slice(1) })
        .requests,
    ).toHaveLength(MOST_AT_ONCE);
  });
});

describe('what one press did, in words', () => {
  it('says the count where every row went through', () => {
    expect(bulkInWords('APPROVE', 9, 0)).toBe('9 requests approved.');
    expect(bulkInWords('REFUSE', 1, 0)).toBe('1 request turned down.');
  });

  it('and names both figures where some were left', () => {
    expect(bulkInWords('APPROVE', 8, 1)).toBe(
      '8 of 9 approved. 1 request left where it was, and each says why.',
    );

    expect(bulkInWords('REFUSE', 3, 2)).toBe(
      '3 of 5 turned down. 2 requests left where they were, and each says why.',
    );
  });

  it('and says so where nothing went through', () => {
    expect(bulkInWords('APPROVE', 0, 2)).toBe(
      'Nothing was approved. 2 requests left where they were, and each says why.',
    );
  });
});
