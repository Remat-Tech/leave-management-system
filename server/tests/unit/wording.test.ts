import { describe, expect, it } from 'vitest';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import { NOTICE_EVENTS, noticeOf } from '../../src/features/notification/notification.js';
import { reminderOf } from '../../src/features/notification/reminder.js';
import {
  EMAILS,
  emailFor,
  EmailNotFound,
  fillIn,
  InvalidWording,
  LONGEST_SUBJECT,
  ORIGINAL_WORDING,
  placeholdersOffered,
  readEmailName,
  validateWording,
} from '../../src/features/notification/wording.js';
import { previewOf } from '../../src/features/notification/wording-preview.js';

/** HR's wording of the emails. FR 61, LMS 512. The original wording is pinned by ./notification.test.ts. */

function aRequest(): LeaveRequest {
  return {
    id: '41',
    employeeId: '7',
    leaveTypeId: '1',
    leaveYearId: '2',
    from: '2026-03-02',
    to: '2026-03-10',
    reason: null,
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 6,
    calendarDays: 9,
    status: 'SUBMITTED',
    awaitingApprovalFrom: 'MANAGER',
    decidedBySingleApprover: false,
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
  };
}

describe('the emails', () => {
  it('are one for every event, and two for the one with two readers', () => {
    expect([...EMAILS].sort()).toEqual([...NOTICE_EVENTS, 'UNROUTABLE_FOR_HR'].sort());
    expect(emailFor('UNROUTABLE', true)).toBe('UNROUTABLE');
    expect(emailFor('UNROUTABLE', false)).toBe('UNROUTABLE_FOR_HR');
    expect(emailFor('DECISION_OVERTURNED', false)).toBe('DECISION_OVERTURNED');
  });

  it.each(EMAILS)('%s in its original words is wording HR could have saved', (name) => {
    expect(validateWording(name, ORIGINAL_WORDING[name])).toEqual(ORIGINAL_WORDING[name]);
  });

  it('offers the placeholders the original uses, and the ones every email has', () => {
    expect(placeholdersOffered('REFUSED')).toContain('comment');
    expect(placeholdersOffered('SUBMITTED')).toContain('employeeName');
    expect(placeholdersOffered('SUBMITTED')).not.toContain('comment');
    expect(placeholdersOffered('STILL_WAITING')).not.toContain('daysLeftToBook');
  });

  it('refuses a name the system sends nothing under', () => {
    expect(() => readEmailName('BIRTHDAY')).toThrow(EmailNotFound);
    expect(readEmailName('APPROVED')).toBe('APPROVED');
  });
});

describe('filling one in', () => {
  it('drops a paragraph that fills in to nothing', () => {
    const filled = fillIn({ subject: 'Hi', body: 'One.\n\n{{comment}}\n\nTwo.' }, { comment: '' });

    expect(filled.body).toBe('One.\n\nTwo.');
  });

  it('capitalises a placeholder written with a capital', () => {
    expect(
      fillIn({ subject: '{{DecidedBy}} said yes', body: 'x' }, { decidedBy: 'your manager' })
        .subject,
    ).toBe('Your manager said yes');
  });

  it('never fills in a placeholder somebody typed into a value', () => {
    const filled = fillIn(
      { subject: 's', body: '{{comment}}' },
      { comment: 'They said:\n\n    {{firstName}}', firstName: 'Ama' },
    );

    expect(filled.body).toContain('{{firstName}}');
  });
});

describe('what HR may save', () => {
  const good = { subject: 'Leave for {{period}}', body: 'Hello {{firstName}},\n\nIt is agreed.' };

  it('is a subject line and a message, tidied', () => {
    expect(validateWording('APPROVED', { subject: '  Agreed ', body: ' Yes\r\n\r\nNo ' })).toEqual({
      subject: 'Agreed',
      body: 'Yes\n\nNo',
    });
    expect(validateWording('APPROVED', good)).toEqual(good);
  });

  it('refuses a blank subject, a second line, and one too long', () => {
    expect(() => validateWording('APPROVED', { ...good, subject: ' ' })).toThrow(InvalidWording);
    expect(() => validateWording('APPROVED', { ...good, subject: 'One\nTwo' })).toThrow('one line');
    expect(() =>
      validateWording('APPROVED', { ...good, subject: 'x'.repeat(LONGEST_SUBJECT + 1) }),
    ).toThrow(InvalidWording);
  });

  it('refuses a blank message', () => {
    expect(() => validateWording('APPROVED', { ...good, body: '' })).toThrow(InvalidWording);
  });

  it('refuses a placeholder the email cannot fill in, naming the field and the ones it can', () => {
    try {
      validateWording('SUBMITTED', { ...good, body: 'Hello {{comment}}' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWording);
      expect((error as InvalidWording).field).toBe('body');
      expect((error as InvalidWording).message).toContain('{{nowWith}}');
    }
  });

  it('refuses a brace that is not part of a placeholder', () => {
    expect(() => validateWording('APPROVED', { ...good, body: 'Hello {{first name}}' })).toThrow(
      'double braces',
    );
  });
});

describe('an email in HR’s words', () => {
  it('is what is composed when there is some', () => {
    const notice = noticeOf(
      {
        event: 'APPROVED',
        employee: { id: '7', firstName: 'Adwoa', name: 'Adwoa Frimpong' },
        request: { ...aRequest(), status: 'APPROVED', awaitingApprovalFrom: null },
        typeName: 'Annual Leave',
        decidedBy: 'MANAGER',
        comment: null,
        availableAfter: 14,
      },
      { subject: 'Enjoy {{period}}', body: 'Dear {{firstName}},\n\n{{comment}}\n\nRemat' },
    );

    expect(notice.subject).toBe('Enjoy 2 March 2026 to 10 March 2026');
    expect(notice.body).toBe('Dear Adwoa,\n\nRemat');
  });

  it('and for the daily reminder too', () => {
    const notice = reminderOf(
      {
        approver: { id: '3', firstName: 'Kofi' },
        employee: { name: 'Adwoa Frimpong' },
        request: aRequest(),
        typeName: 'Annual Leave',
        asAt: '2026-02-03',
      },
      { subject: 'Still waiting: {{employeeName}}', body: '{{whenAsked}}' },
    );

    expect(notice.subject).toBe('Still waiting: Adwoa Frimpong');
    expect(notice.body).toContain('2 days ago');
  });

  it.each(EMAILS)('%s can be previewed in its original words', (name) => {
    const preview = previewOf(name, ORIGINAL_WORDING[name]);

    expect(preview.subject).not.toMatch(/\{\{|\}\}/);
    expect(preview.body).not.toMatch(/\{\{|\}\}/);
  });
});
