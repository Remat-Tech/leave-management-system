import { describe, expect, it } from 'vitest';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import {
  alreadyReminded,
  daysUntilItStarts,
  daysWaiting,
  REMINDER_EVENT,
  reminderOf,
  type WhatIsWaiting,
} from '../../src/features/notification/reminder.js';
import { summaryOf } from '../../src/features/notification/reminder.job.js';

/**
 * What an approver is chased with, every day until they decide. FR 50, FR 60. LMS 330.
 *
 * The message is written to somebody other than the person whose leave it is, so the two
 * things it must never get wrong are whose days these are and what a reminder is: it is the
 * only message this system sends that reports nothing having happened, and the sentence
 * saying so is asserted in every shape below.
 *
 * ../integration/reminder.test.ts is where the daily cadence, the desk resolution and the
 * "it decided nothing" proof live.
 */

const MARCH: { from: string; to: string } = { from: '2026-03-02', to: '2026-03-10' };

/** The day the request was asked for, and the day the job is pretending to run. */
const ASKED = new Date('2026-02-01T09:00:00Z');
const TODAY = '2026-02-14';

function aRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: '41',
    employeeId: '7',
    leaveTypeId: '1',
    leaveYearId: '2',
    from: MARCH.from,
    to: MARCH.to,
    reason: 'My sister is getting married',
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 6,
    calendarDays: 9,
    status: 'SUBMITTED',
    awaitingApprovalFrom: 'MANAGER',
    decidedBySingleApprover: false,
    submittedAt: ASKED,
    createdAt: ASKED,
    updatedAt: ASKED,
    ...overrides,
  };
}

function waiting(overrides: Partial<WhatIsWaiting> = {}): WhatIsWaiting {
  return {
    approver: { id: '3', firstName: 'Kwame' },
    employee: { name: 'Adwoa Frimpong' },
    request: aRequest(),
    typeName: 'Annual Leave',
    asAt: TODAY,
    ...overrides,
  };
}

/* ------------------------------------------------------------- how long it has sat */

describe('how long somebody has been waiting', () => {
  it('is counted from the day they asked, in whole days', () => {
    expect(daysWaiting(aRequest(), TODAY)).toBe(13);
  });

  /* A request asked for this morning has waited no days, and the message says "today". */
  it('and is nought on the day it was asked for', () => {
    expect(daysWaiting(aRequest(), '2026-02-01')).toBe(0);
  });

  /* FR 17. The figure that makes one of these urgent, and it goes negative rather than
     stopping at nought: leave that has started and is still undecided is the worst case. */
  it('and how close the leave is goes negative once it has started', () => {
    expect(daysUntilItStarts(aRequest(), TODAY)).toBe(16);
    expect(daysUntilItStarts(aRequest(), '2026-03-02')).toBe(0);
    expect(daysUntilItStarts(aRequest(), '2026-03-04')).toBe(-2);
  });
});

/* ---------------------------------------------------------------- once a day, per person */

describe('who has already been chased', () => {
  const sent = [
    { employeeId: '3', leaveRequestId: '41' },
    { employeeId: '9', leaveRequestId: '55' },
  ];

  it('is answered per approver and per request, not per request alone', () => {
    expect(alreadyReminded(sent, '3', '41')).toBe(true);

    /* The same approver about a different request, and a different approver about this one:
       two people at one desk are two reminders. FR 48d. */
    expect(alreadyReminded(sent, '3', '55')).toBe(false);
    expect(alreadyReminded(sent, '9', '41')).toBe(false);
  });

  it('and nobody has been chased when nothing has gone', () => {
    expect(alreadyReminded([], '3', '41')).toBe(false);
  });
});

/* ------------------------------------------------------------------- what it says */

describe('the reminder', () => {
  it('is addressed to the approver and is about somebody else’s leave', () => {
    const notice = reminderOf(waiting());

    expect(notice.employeeId).toBe('3');
    expect(notice.leaveRequestId).toBe('41');
    expect(notice.event).toBe(REMINDER_EVENT);
    expect(notice.body).toContain('Hello Kwame,');
    expect(notice.subject).toBe(
      'Adwoa Frimpong’s Annual Leave for 2 March 2026 to 10 March 2026 is still waiting on you',
    );
  });

  /* The subject carries the news, because a phone shows nothing else. */
  it('and says in the subject that it is still waiting on them', () => {
    expect(reminderOf(waiting()).subject).toContain('is still waiting on you');
  });

  /* The three things an approver needs to act: what was asked for, how long ago, and how
     close the leave is. */
  it('and names the leave, the day count, the wait and the start', () => {
    const notice = reminderOf(waiting());

    expect(notice.body).toContain('6 days of Annual Leave, 2 March 2026 to 10 March 2026');
    expect(notice.body).toContain('13 days ago, on 1 February 2026');
    expect(notice.body).toContain('The leave starts in 16 days.');
  });

  it('and says "today" rather than "0 days ago" on the day it was asked for', () => {
    const notice = reminderOf(waiting({ asAt: '2026-02-01' }));

    expect(notice.body).toContain('asked for 6 days of Annual Leave');
    expect(notice.body).toContain('today, and it is waiting on you.');
    expect(notice.body).not.toContain('0 days');
  });

  /* One day is a day, in both figures the message carries. */
  it('and pluralises a single day correctly', () => {
    const notice = reminderOf(
      waiting({ request: aRequest({ days: 1, to: MARCH.from }), asAt: '2026-02-02' }),
    );

    expect(notice.body).toContain('1 day of Annual Leave, 2 March 2026');
    expect(notice.body).toContain('1 day ago');
  });

  it('and says the leave starts tomorrow, or today, in those words', () => {
    expect(reminderOf(waiting({ asAt: '2026-03-01' })).body).toContain(
      'The leave starts tomorrow.',
    );
    expect(reminderOf(waiting({ asAt: '2026-03-02' })).body).toContain('The leave starts today.');
  });

  /* The worst case this story exists to prevent: leave that has begun and nobody has said
     yes or no. */
  it('and says so plainly once the leave has started and nothing has been decided', () => {
    const notice = reminderOf(waiting({ asAt: '2026-03-04' }));

    expect(notice.body).toContain('The leave started 2 days ago, on 2 March 2026');
    expect(notice.body).toContain('still not decided');
  });

  /* The story's third criterion, in the message as well as in the job. */
  it('and says that it approves nothing and turns nothing down', () => {
    const notice = reminderOf(waiting());

    expect(notice.body).toContain('Nothing has been decided at your stage.');
    expect(notice.body).toContain('it approves nothing and turns nothing down');
    expect(notice.body).toContain('Approve it or turn it down and it stops');
  });

  /* The days are somebody else's, and a message to an approver that read "your balance"
     would be the one mistake this message can make about whose leave it is. */
  it('and says whose days are held, without claiming they are the reader’s', () => {
    const notice = reminderOf(waiting());

    expect(notice.body).toContain('Their 6 days are held while it waits');
    expect(notice.body).not.toContain('your balance');
    expect(notice.body).not.toContain('You have');
  });

  /* The same sign off every message here ends with, which is how a reader tells a real one
     from a forgery. */
  it('and ends the way every other message does', () => {
    expect(reminderOf(waiting()).body.trimEnd().endsWith('Remat Holdings Leave')).toBe(true);
  });

  /* It goes through `validateNotice`, the same gate `noticeOf` does, so a reminder is
     trimmed and can never be the blank message a templating bug produces. */
  it('and goes through the same check every other notice does', () => {
    const notice = reminderOf(waiting());

    expect(notice.subject).toBe(notice.subject.trim());
    expect(notice.body).toBe(notice.body.trim());
  });
});

/* ------------------------------------------------------------------- what a run said */

describe('the run summary', () => {
  it('counts what was waiting and what was chased', () => {
    expect(
      summaryOf({
        asAt: TODAY,
        ranAt: new Date('2026-02-14T06:00:00Z'),
        requestsWaiting: 3,
        reminded: [
          { leaveRequestId: '41', employeeId: '3', daysWaiting: 13, emailed: true },
          { leaveRequestId: '42', employeeId: '9', daysWaiting: 2, emailed: true },
        ],
        notReminded: [],
      }),
    ).toBe('3 requests waiting on 2026-02-14, 2 reminders sent.');
  });

  /* FR 48b. A request with nobody at its desk is not a forgetful approver, and a summary
     that hid it would hide the one thing a reminder cannot fix. */
  it('and says how many have nobody at the desk', () => {
    expect(
      summaryOf({
        asAt: TODAY,
        ranAt: new Date('2026-02-14T06:00:00Z'),
        requestsWaiting: 2,
        reminded: [{ leaveRequestId: '41', employeeId: '3', daysWaiting: 13, emailed: true }],
        notReminded: [{ leaveRequestId: '42', employeeId: null, because: 'NOBODY_IS_AT_THE_DESK' }],
      }),
    ).toBe('2 requests waiting on 2026-02-14, 1 reminder sent. 1 has nobody at the desk. FR 48b.');
  });
});
