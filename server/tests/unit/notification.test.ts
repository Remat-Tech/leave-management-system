import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVER_ROLES } from '../../src/features/leave-type/approval-chain.js';
import {
  type LeaveRequest,
  RELEASING_STATUSES,
} from '../../src/features/leave-request/leave-request.js';
import {
  approvalNews,
  endingNews,
  givesTheDaysBack,
  InvalidNotice,
  NOTICE_EVENTS,
  type NoticeEvent,
  noticeOf,
  periodInWords,
  validateNotice,
  type WhatHappened,
} from '../../src/features/notification/notification.js';

/**
 * What somebody is told, and the sentence they act on. FR 59, §7.1. LMS 329.
 *
 * The story's "so that" is an aeroplane ticket in the other tab, so the assertions here are
 * mostly about **one sentence in each message**: whether the leave is theirs to take. Every
 * other line is context around it, and the two ways of getting it wrong are the two this
 * file spends most of its length on — a stage approval that reads like an approval, and an
 * approval that hedges.
 *
 * Everything is pure, which is the point of composing in `/domain` rather than in the
 * service: what an email says can be read back without a database, a mailbox or a person.
 * ../integration/notification.test.ts is where the row, the send and the ordering live.
 */

const MARCH: { from: string; to: string } = { from: '2026-03-02', to: '2026-03-10' };

const WHY_NOT = 'Two of the team are already away that week and the desk cannot be empty';

function aRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: '41',
    employeeId: '7',
    leaveTypeId: '1',
    leaveYearId: '2',
    from: MARCH.from,
    to: MARCH.to,
    reason: 'My sister is getting married',
    countingBasis: 'WORKING_DAYS',
    days: 6,
    calendarDays: 9,
    status: 'SUBMITTED',
    awaitingApprovalFrom: 'MANAGER',
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    ...overrides,
  };
}

function happened(overrides: Partial<WhatHappened> = {}): WhatHappened {
  return {
    event: 'SUBMITTED',
    employee: { id: '7', firstName: 'Adwoa', name: 'Adwoa Frimpong' },
    request: aRequest(),
    typeName: 'Annual Leave',
    decidedBy: null,
    comment: null,
    availableAfter: 14,
    ...overrides,
  };
}

/* ------------------------------------------------------- the six pieces of news */

describe('the events somebody is told about', () => {
  /* FR 59's list, and LMS 318 brought the two the notification migration said were coming.
     See the CHECK in that migration, which says the same thing. */
  it('are the thirteen FR 59 names that this system can actually produce', () => {
    expect(NOTICE_EVENTS).toEqual([
      'SUBMITTED',
      'STAGE_APPROVED',
      'STAGE_REFUSED',
      'APPROVED',
      'REFUSED',
      'WITHDRAWN',
      'CANCELLED',
      'DECISION_OVERTURNED',
      /** FR 48b, LMS 320. The alert, told to the requester and to whoever can unstick it. */
      'UNROUTABLE',
      /** FR 47, LMS 324. The ask goes to HR; the three answers go back to the person. */
      'WITHDRAWAL_ASKED',
      'WITHDRAWAL_GRANTED',
      'LEAVE_AMENDED',
      'WITHDRAWAL_REFUSED',
    ]);
  });

  /* The two endings that are not decisions, and the two events they produce. */
  it('and every ending a request can have is one of them', () => {
    for (const status of ['WITHDRAWN', 'CANCELLED'] as const) {
      expect(NOTICE_EVENTS).toContain(endingNews(status));
    }

    expect(RELEASING_STATUSES).toContain('REFUSED');
    expect(NOTICE_EVENTS).toContain('REFUSED');
  });

  /* An approval is two pieces of news, and which one is a fact on the committed row. */
  it('and an approval is told apart from a stage approval by the status, not by a walk', () => {
    expect(approvalNews(aRequest({ status: 'APPROVED', awaitingApprovalFrom: null }))).toBe(
      'APPROVED',
    );
    expect(approvalNews(aRequest({ status: 'SUBMITTED', awaitingApprovalFrom: 'HR' }))).toBe(
      'STAGE_APPROVED',
    );
  });

  /* FR 47, LMS 324. `LEAVE_AMENDED` is the one where days came back and the leave still
     went ahead, which is why the list is named for what the balance did. */
  it('and five of them mean the days are back', () => {
    const back = NOTICE_EVENTS.filter(givesTheDaysBack);

    expect(back).toEqual([
      'REFUSED',
      'WITHDRAWN',
      'CANCELLED',
      'WITHDRAWAL_GRANTED',
      'LEAVE_AMENDED',
    ]);
  });

  /* Nothing composes an empty message, whichever branch it took. */
  it('and every one of them composes something to say', () => {
    for (const event of NOTICE_EVENTS) {
      const notice = noticeOf(
        happened({
          event,
          request: aRequest(requestFor(event)),
          decidedBy: event === 'SUBMITTED' ? null : 'MANAGER',
          comment: saysWhy(event) ? WHY_NOT : null,
          overturned: event === 'DECISION_OVERTURNED' ? { desk: 'MANAGER', said: 'REFUSE' } : null,
        }),
      );

      expect(notice.subject.trim()).not.toBe('');
      expect(notice.body.trim()).not.toBe('');
      expect(notice.event).toBe(event);
      expect(notice.employeeId).toBe('7');
      expect(notice.leaveRequestId).toBe('41');
    }
  });

  /* Every message names what kind of leave, when, and how much — because a person reading
     one has more than one request in flight and a subject line is all they see. */
  it('and every one of them names the leave, the dates and the day count', () => {
    for (const event of NOTICE_EVENTS) {
      const notice = noticeOf(
        happened({
          event,
          request: aRequest(requestFor(event)),
          decidedBy: 'MANAGER',
          comment: WHY_NOT,
          overturned: event === 'DECISION_OVERTURNED' ? { desk: 'MANAGER', said: 'REFUSE' } : null,
        }),
      );

      expect(notice.subject).toContain('Annual Leave');
      expect(notice.body).toContain('6 days of Annual Leave');
      expect(notice.body).toContain('2 March 2026 to 10 March 2026');
      expect(notice.body).toContain('Hello Adwoa,');
      expect(notice.body).toContain('Remat Holdings Leave');
    }
  });
});

/**
 * The state each event describes, so a message is composed from a row that could exist.
 *
 * `noticeOf` reads the status and the desk to say where the leave stands, so handing every
 * branch a submitted request would test sentences the system never sends. FR 44, LMS 318.
 */
function requestFor(event: NoticeEvent): Partial<LeaveRequest> {
  switch (event) {
    case 'APPROVED':
    case 'DECISION_OVERTURNED':
      return { status: 'APPROVED', awaitingApprovalFrom: null };
    case 'REFUSED':
      return { status: 'REFUSED', awaitingApprovalFrom: null };
    /** FR 47, LMS 324. The ask and the two answers that leave the leave standing. */
    case 'WITHDRAWAL_ASKED':
    case 'LEAVE_AMENDED':
    case 'WITHDRAWAL_REFUSED':
      return { status: 'APPROVED', awaitingApprovalFrom: null };
    case 'WITHDRAWAL_GRANTED':
      return { status: 'WITHDRAWN', awaitingApprovalFrom: null };
    case 'STAGE_APPROVED':
    case 'STAGE_REFUSED':
      return { awaitingApprovalFrom: 'HR' };
    default:
      return {};
  }
}

/** The events whose message quotes a reason. FR 39, FR 44. */
function saysWhy(event: NoticeEvent): boolean {
  return [
    'REFUSED',
    'STAGE_REFUSED',
    'DECISION_OVERTURNED',
    /** FR 47, LMS 324. */
    'WITHDRAWAL_ASKED',
    'LEAVE_AMENDED',
    'WITHDRAWAL_REFUSED',
  ].includes(event);
}

/* ------------------------------------------- the sentence the whole story is about */

describe('whether the leave is theirs to take', () => {
  /* The defect LMS 316 exists against, arriving by email. */
  it('a stage approval says not to book anything, next to the good news', () => {
    const notice = noticeOf(
      happened({
        event: 'STAGE_APPROVED',
        request: aRequest({ awaitingApprovalFrom: 'HR' }),
        decidedBy: 'MANAGER',
      }),
    );

    expect(notice.subject).toBe('Your line manager approved your Annual Leave — it still needs HR');
    expect(notice.body).toContain('do not book anything on it');
    expect(notice.body).toContain('It has gone on to HR.');
    expect(notice.body).not.toContain('yours to take');
  });

  it('and says the balance has not moved, because it has not', () => {
    const notice = noticeOf(
      happened({
        event: 'STAGE_APPROVED',
        request: aRequest({ awaitingApprovalFrom: 'HR' }),
        decidedBy: 'MANAGER',
        availableAfter: 14,
      }),
    );

    expect(notice.body).toContain('Your balance has not moved');
    expect(notice.body).toContain('still being held');
    expect(notice.body).toContain('You have 14 days to book.');
  });

  it('and an approval says the leave is agreed and the days are spent', () => {
    const notice = noticeOf(
      happened({
        event: 'APPROVED',
        request: aRequest({ status: 'APPROVED', awaitingApprovalFrom: null }),
        decidedBy: 'HR',
        availableAfter: 14,
      }),
    );

    expect(notice.subject).toBe('Your Annual Leave for 2 March 2026 to 10 March 2026 is approved');
    expect(notice.body).toContain('is agreed and is yours to take');
    expect(notice.body).toContain('HR was the last');
    expect(notice.body).toContain('The 6 days have come off your balance.');
    expect(notice.body).not.toContain('do not book');
  });

  it('and a submission says it is with somebody and not agreed yet', () => {
    const notice = noticeOf(happened({ event: 'SUBMITTED' }));

    expect(notice.subject).toContain('has been submitted');
    expect(notice.body).toContain('It is now with your line manager.');
    expect(notice.body).toContain('not agreed yet, so do not book anything on it');
    expect(notice.body).toContain('being held while it is decided');
  });
});

/* --------------------------------------------------------- the endings, and why */

describe('the three endings', () => {
  /* FR 39. The reason is reproduced whole, in the words the approver wrote. */
  it('a refusal quotes the reason verbatim and says where the days went', () => {
    const notice = noticeOf(
      happened({
        event: 'REFUSED',
        request: aRequest({ status: 'REFUSED', awaitingApprovalFrom: null }),
        decidedBy: 'MANAGER',
        comment: WHY_NOT,
        availableAfter: 20,
      }),
    );

    expect(notice.subject).toBe(
      'Your Annual Leave for 2 March 2026 to 10 March 2026 was turned down',
    );
    expect(notice.body).toContain(WHY_NOT);
    expect(notice.body).toContain("turned down at the line manager's stage");
    expect(notice.body).toContain('The 6 days are back in your balance.');
    expect(notice.body).toContain('You have 20 days to book.');
    expect(notice.body).toContain('ask for it again');
  });

  /* FR 52. A refusal may be made at a desk the refuser does not belong to, so the message
     says which stage rather than assuming the manager. */
  it('and it names the stage it was refused at, whichever that was', () => {
    for (const desk of APPROVER_ROLES) {
      const notice = noticeOf(
        happened({
          event: 'REFUSED',
          request: aRequest({ status: 'REFUSED', awaitingApprovalFrom: null }),
          decidedBy: desk,
          comment: WHY_NOT,
        }),
      );

      expect(notice.body).toMatch(/turned down at .+'s stage/);
    }
  });

  it('and a withdrawal says nobody has to approve the days coming back', () => {
    const notice = noticeOf(
      happened({
        event: 'WITHDRAWN',
        request: aRequest({ status: 'WITHDRAWN', awaitingApprovalFrom: null }),
        availableAfter: 20,
      }),
    );

    expect(notice.subject).toContain('has been taken back');
    expect(notice.body).toContain('nobody has to approve anything');
    expect(notice.body).toContain('The 6 days are back in your balance.');
  });

  /* The one message whose likeliest reader has the wrong idea about what happened. */
  it('and a cancellation says plainly that nobody turned anything down', () => {
    const notice = noticeOf(
      happened({
        event: 'CANCELLED',
        request: aRequest({ status: 'CANCELLED', awaitingApprovalFrom: null }),
        availableAfter: 20,
      }),
    );

    expect(notice.subject).toContain('has been cancelled');
    expect(notice.body).toContain('cancelled by HR');
    expect(notice.body).toContain('nobody has turned anything down');
    expect(notice.body).toContain('The 6 days are back in your balance.');
  });

  /* Neither administrative ending is a decision, so neither carries a reason to quote. */
  it('and neither administrative ending quotes anybody', () => {
    for (const event of ['WITHDRAWN', 'CANCELLED'] as NoticeEvent[]) {
      const notice = noticeOf(
        happened({ event, request: aRequest({ awaitingApprovalFrom: null }) }),
      );

      expect(notice.body).not.toContain('They said:');
    }
  });
});

/* ------------------------------------------------------------ saying it properly */

describe('the words themselves', () => {
  /* The month is a word, for the reason formatDay exists: 03/10/2026 is two different days
     depending on who is reading, and this is the message somebody books a flight against. */
  it('a period is said with the month as a word', () => {
    expect(periodInWords('2026-03-02', '2026-03-10')).toBe('2 March 2026 to 10 March 2026');
  });

  it('and one day is said once rather than as a range to itself', () => {
    expect(periodInWords('2026-03-02', '2026-03-02')).toBe('2 March 2026');
  });

  it('and one day is one day', () => {
    const notice = noticeOf(
      happened({
        request: aRequest({ from: '2026-03-02', to: '2026-03-02', days: 1, calendarDays: 1 }),
        availableAfter: 1,
      }),
    );

    expect(notice.body).toContain('1 day of Annual Leave, 2 March 2026');
    expect(notice.body).toContain('You have 1 day to book.');
    expect(notice.body).not.toContain('1 days');
  });

  /* "your line manager has approved" opening a sentence reads as a typo. */
  it('and a desk opening a sentence is capitalised', () => {
    const notice = noticeOf(
      happened({
        event: 'STAGE_APPROVED',
        request: aRequest({ awaitingApprovalFrom: 'HR' }),
        decidedBy: 'MANAGER',
      }),
    );

    expect(notice.body.startsWith('Hello Adwoa,\n\nYour line manager has approved')).toBe(true);
  });

  /* An approver who said something has it shown; one who said nothing produces no empty
     speech bubble. */
  it('and an approval with nothing said shows nothing', () => {
    const notice = noticeOf(
      happened({
        event: 'APPROVED',
        request: aRequest({ status: 'APPROVED', awaitingApprovalFrom: null }),
        decidedBy: 'HR',
        comment: null,
      }),
    );

    expect(notice.body).not.toContain('They said:');
  });

  it('and an approval with something said shows it', () => {
    const notice = noticeOf(
      happened({
        event: 'APPROVED',
        request: aRequest({ status: 'APPROVED', awaitingApprovalFrom: null }),
        decidedBy: 'HR',
        comment: 'Cover is arranged, enjoy the wedding',
      }),
    );

    expect(notice.body).toContain('They said:');
    expect(notice.body).toContain('Cover is arranged, enjoy the wedding');
  });
});

/* ------------------------------------------------ the refusals nobody should provoke */

describe('a notice that says nothing', () => {
  /* The shape every templating bug takes: a row that satisfies NOT NULL and says nothing. */
  it('is refused before it can be written or sent', () => {
    expect(() =>
      validateNotice({
        employeeId: '7',
        leaveRequestId: '41',
        event: 'SUBMITTED',
        subject: '   ',
        body: 'something',
      }),
    ).toThrow(InvalidNotice);

    expect(() =>
      validateNotice({
        employeeId: '7',
        leaveRequestId: '41',
        event: 'SUBMITTED',
        subject: 'something',
        body: '  \n  ',
      }),
    ).toThrow(InvalidNotice);
  });

  it('and the refusal names the field, for the composer FR 60 will add', () => {
    try {
      validateNotice({
        employeeId: '7',
        leaveRequestId: '41',
        event: 'SUBMITTED',
        subject: '',
        body: 'something',
      });
      expect.unreachable('a blank subject was accepted');
    } catch (error) {
      expect((error as InvalidNotice).field).toBe('subject');
    }
  });

  it('and an event nobody is told about is refused with the list', () => {
    expect(() =>
      validateNotice({
        employeeId: '7',
        leaveRequestId: '41',
        event: 'OVERRIDDEN' as NoticeEvent,
        subject: 'something',
        body: 'something',
      }),
    ).toThrow(/OVERRIDDEN is not something anybody is told about/);
  });
});

/* ---------------------------------------- and it is never sent inside a transaction */

/**
 * FR 59's one unrecoverable rule, checked the only way a rule about code that does not
 * exist can be: by reading the source.
 *
 * The same technique ./one-writer.test.ts uses for the ledger's single door, and it is here
 * for the same reason. The realistic mistake is not somebody deliberately emailing inside a
 * transaction — it is a future story adding a notification to `BalanceService`, where the
 * movement is, because that is where everything else about a request's life happens. At
 * which point an SMTP handshake sits inside `holdStill`, and an approval that a deferred
 * constraint refuses at COMMIT has already told somebody their leave is agreed.
 */
const SOURCE = join(process.cwd(), 'server', 'src');

const sources = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({
    file: file.replaceAll('\\', '/'),
    code: readFileSync(join(SOURCE, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' '),
  }));

/**
 * The files that may compose or send a notice, and what each is for.
 *
 * `features/notification/notification.ts` composes the words. `features/notification/notification.db.ts`
 * writes the row. `features/notification/notification.service.ts` is the one that sends. And
 * `features/leave-request/leave-request.service.ts` calls it, after the door has returned — which is the
 * only place in the application where a notice is occasioned by something that happened.
 */
const MAY_NOTIFY = [
  'features/notification/notification.ts',
  'features/notification/notification.db.ts',
  'features/notification/notification.service.ts',
  'features/leave-request/leave-request.service.ts',
  /**
   * The composition root, which constructs one and never calls it. LMS 403.
   *
   * A different permission from the four above and it is worth keeping the distinction: those
   * four compose or send a notice, and this one only decides which object the door is handed.
   * Somewhere has to say `new NotificationService(...)` — the alternative is a default
   * argument, and ./leave-request.service.ts argues at length why that would be worse: "a
   * service that can be built without one is a service somebody builds without one, and the
   * failure is silent."
   *
   * It is `main.ts` rather than `http/app.ts` deliberately. The read services assemble
   * themselves out of repositories inside `buildApp`, and the write door is passed in whole,
   * so a balance screen still cannot reach a mailer by being wired up — which is the property
   * `RequestFormService` was separated out to keep.
   */
  'main.ts',
];

describe('a notice is composed and sent outside every transaction', () => {
  it('there is source to read', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  /* The door owns the transactions. It must not know how to tell anybody anything. */
  it('and the one writer of balance movements cannot notify at all', () => {
    const door = sources.find(({ file }) => file === 'features/balance/balance.service.ts');

    expect(door).toBeDefined();
    expect(door?.code).not.toMatch(/NotificationService|noticeOf|Mailer|\.tell\s*\(/);
  });

  /* And neither may anything else that is not one of the four above. */
  it('and nothing outside the notification files sends one', () => {
    const telling = sources.filter(
      ({ file, code }) => !MAY_NOTIFY.includes(file) && /NotificationService/.test(code),
    );

    expect(telling.map(({ file }) => file)).toEqual([]);
  });

  /* The seam that owns transactions does not hand one out, so a notice cannot be written on
     a connection inside somebody else's transaction by accident. */
  it('and the transaction seam offers no notification repository', () => {
    const seam = sources.find(({ file }) => file === 'db/transaction.ts');

    expect(seam?.code).not.toMatch(/NotificationRepository/);
  });

  /* And the sender opens none of its own. */
  it('and the service that sends opens no transaction', () => {
    const service = sources.find(
      ({ file }) => file === 'features/notification/notification.service.ts',
    );

    expect(service?.code).not.toMatch(/allOrNothing|Transactions|recording\s*\(/);
  });

  /* The repository that writes the row deliberately does not go through `recording()`,
     which would open one. The migration and the repository both argue why. */
  it('and the repository that writes one opens no transaction either', () => {
    const repository = sources.find(
      ({ file }) => file === 'features/notification/notification.db.ts',
    );

    expect(repository?.code).not.toMatch(/recording\s*\(|transaction\s*\(/);
  });
});
