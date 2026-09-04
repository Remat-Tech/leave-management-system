import { describe, expect, it } from 'vitest';
import {
  DRAFT_FIELDS,
  DraftIsNotFinished,
  fieldInWords,
  InvalidLeaveRequestDraft,
  isEmpty,
  isFinished,
  type LeaveRequestDraft,
  progressOfDraft,
  readyToSubmit,
  validateDraftContents,
  whatIsMissing,
} from '../../src/features/leave-request/draft.js';

/**
 * Saving a request and finishing it later. FR 19. LMS 302.
 *
 * Everything pure: what a draft may hold, what it is still missing, and what turns one into
 * the four fields a submission takes. That a draft holds no days, blocks no calendar and is
 * nobody else's to read is ../integration/draft.test.ts's.
 */
function aDraft(overrides: Partial<LeaveRequestDraft> = {}): LeaveRequestDraft {
  return {
    id: 'draft-1',
    employeeId: 'ama',
    leaveTypeId: 'annual',
    from: '2026-03-02',
    to: '2026-03-06',
    reason: 'Family wedding',
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    ...overrides,
  };
}

describe('what a draft may hold', () => {
  it('accepts a draft with only the kind of leave chosen', () => {
    expect(validateDraftContents({ leaveTypeId: 'annual' })).toEqual({
      leaveTypeId: 'annual',
      from: null,
      to: null,
      reason: null,
    });
  });

  /* The story's sentence, read literally: planning starts before the dates are settled. */
  it('accepts a first day with no last day', () => {
    expect(validateDraftContents({ from: '2026-03-02' }).to).toBeNull();
  });

  it('accepts a reason and nothing else', () => {
    expect(validateDraftContents({ reason: '  Family wedding  ' }).reason).toBe('Family wedding');
  });

  /* A form that was opened rather than leave that is being planned. */
  it('refuses a draft with nothing in it', () => {
    expect(() => validateDraftContents({})).toThrow(InvalidLeaveRequestDraft);
  });

  it('refuses a draft whose every field was cleared', () => {
    expect(() => validateDraftContents({ leaveTypeId: '', from: '', reason: '   ' })).toThrow(
      InvalidLeaveRequestDraft,
    );
  });

  /* Absent and blank are one state, so a cleared field reads back as absent rather than as
     an empty string the submission path would then refuse. */
  it('reads a cleared field as absent', () => {
    const contents = validateDraftContents({ leaveTypeId: 'annual', reason: '' });

    expect(contents.reason).toBeNull();
  });

  it('refuses a date that is not ten characters', () => {
    expect(() => validateDraftContents({ from: '03/04/2026' })).toThrow(InvalidLeaveRequestDraft);
  });

  it('names the field a bad date arrived in', () => {
    expect(() => validateDraftContents({ to: 'next Tuesday' })).toThrow(
      expect.objectContaining({ field: 'to' }),
    );
  });

  /* Unfinished is an absent date. Two dates the wrong way round is a mistake, and the
     sentence naming it is worth more now than at submission. */
  it('refuses two dates the wrong way round', () => {
    expect(() => validateDraftContents({ from: '2026-03-06', to: '2026-03-02' })).toThrow(
      InvalidLeaveRequestDraft,
    );
  });

  it('names the days in that refusal', () => {
    expect(() => validateDraftContents({ from: '2026-03-06', to: '2026-03-02' })).toThrow(
      /6 March 2026|2 March 2026/,
    );
  });

  it('accepts one day, which is a period', () => {
    expect(validateDraftContents({ from: '2026-03-02', to: '2026-03-02' }).to).toBe('2026-03-02');
  });
});

describe('what is still to fill in', () => {
  it('reports nothing missing on a finished draft', () => {
    expect(whatIsMissing(aDraft())).toEqual([]);
    expect(isFinished(aDraft())).toBe(true);
  });

  it('reports the empty fields in the order a form asks for them', () => {
    expect(whatIsMissing(aDraft({ leaveTypeId: null, to: null }))).toEqual(['leaveTypeId', 'to']);
  });

  it('counts a draft with one field as started rather than empty', () => {
    expect(isEmpty(aDraft({ leaveTypeId: null, from: null, to: null }))).toBe(false);
  });

  it('has a word for every field it can report', () => {
    for (const field of DRAFT_FIELDS) {
      expect(fieldInWords(field)).not.toBe('');
    }
  });

  /* NFR USA 03. The sentence says what to do, and says that nothing has happened yet —
     which is the first criterion, told to the person it is about. */
  it('says what is left and that nothing is held', () => {
    const progress = progressOfDraft(aDraft({ reason: null }));

    expect(progress.finished).toBe(false);
    expect(progress.inWords).toContain('the reason');
    expect(progress.inWords).toContain('Nothing is held');
  });

  it('says a finished draft is ready to ask for', () => {
    expect(progressOfDraft(aDraft()).inWords).toContain('ready to ask for');
  });
});

describe('turning a draft into a request', () => {
  it('hands over the four fields a submission takes', () => {
    expect(readyToSubmit(aDraft())).toEqual({
      leaveTypeId: 'annual',
      from: '2026-03-02',
      to: '2026-03-06',
      reason: 'Family wedding',
    });
  });

  /* Nothing here defaults a missing field, so a draft cannot become leave nobody asked
     for. */
  it('refuses one with a field still to fill in', () => {
    expect(() => readyToSubmit(aDraft({ reason: null }))).toThrow(DraftIsNotFinished);
  });

  it('carries the empty fields on the refusal, for a form to go back to', () => {
    try {
      readyToSubmit(aDraft({ leaveTypeId: null, from: null }));
      expect.unreachable('an unfinished draft is not submitted');
    } catch (error) {
      expect(error).toBeInstanceOf(DraftIsNotFinished);
      expect((error as DraftIsNotFinished).missing).toEqual(['leaveTypeId', 'from']);
      expect((error as DraftIsNotFinished).code).toBe('DRAFT_NOT_FINISHED');
    }
  });

  it('names them in the sentence too', () => {
    expect(() => readyToSubmit(aDraft({ to: null }))).toThrow(/the last day/);
  });
});
