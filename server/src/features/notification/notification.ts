/**
 * What somebody is told when something happens to their leave, and in what words. FR 59, §7.1., LMS 329, LMS 306, LMS 315, LMS 316, LMS 323, FR 60, LMS 209.
 */

import { type ApproverRole, deskInWords, possessively } from '../leave-type/approval-chain.js';
import type { LeaveRequest } from '../leave-request/leave-request.js';
import { type CalendarDate, formatDay } from '../../shared/time.js';

/** The things somebody is told about. FR 59, FR 44. */
export const NOTICE_EVENTS = [
  'SUBMITTED',
  'STAGE_APPROVED',
  /** A stage said no and the request went on to the next desk. FR 44, LMS 318. */
  'STAGE_REFUSED',
  'APPROVED',
  'REFUSED',
  'WITHDRAWN',
  'CANCELLED',
  /** The line manager, told their decision was overturned. FR 44, §7.2, LMS 318. */
  'DECISION_OVERTURNED',
  /** Nobody can decide it, told to the requester and to whoever can fix that. FR 48b, LMS 320. */
  'UNROUTABLE',
] as const;

export type NoticeEvent = (typeof NOTICE_EVENTS)[number];

/** The events after which the leave is not going to happen, and the days are back. */
const ENDED_AND_GAVE_THE_DAYS_BACK: readonly NoticeEvent[] = ['REFUSED', 'WITHDRAWN', 'CANCELLED'];

/** Whether this is news that the leave is off and the balance has the days again. */
export function givesTheDaysBack(event: NoticeEvent): boolean {
  return ENDED_AND_GAVE_THE_DAYS_BACK.includes(event);
}

/** What is written down, and what is sent. FR 59. */
export interface NewNotice {
  /** Whose leave it is, which for FR 59 is also who is being told. */
  employeeId: string;
  leaveRequestId: string;
  event: NoticeEvent;
  subject: string;
  body: string;
}

/** A notice as it comes back out, with what became of its email beside it. */
export interface Notice extends NewNotice {
  id: string;
  /** FR 59's in-app half. */
  readAt: Date | null;
  /** When the email left, or null where it has not. */
  emailedAt: Date | null;
  /** Why it did not, in the transport's own words. */
  emailFailure: string | null;
  createdAt: Date;
}

/** A notice that was refused, and the field that caused it. FR 60. */
export class InvalidNotice extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidNotice';
    this.field = field;
  }
}

/** A notice nobody has. */
export class NoticeNotFound extends Error {
  readonly noticeId: string;

  constructor(id: string) {
    super(`No notification with id ${id}.`);
    this.name = 'NoticeNotFound';
    this.noticeId = id;
  }
}

/**
 * Everything a message is composed from, and nothing else.
 *
 * Every field is a fact that has already happened, taken from what the door gave back
 * rather than from what the caller expected — see ../features/leave-request/leave-request.service.ts,
 * which reads all of them off the returned request, decision and balance. That is the
 * difference between describing what was committed and describing what was attempted, and
 * it is the whole reason a notice is composed after the transaction rather than before it.
 */
export interface WhatHappened {
  event: NoticeEvent;
  /** Whose leave it is, and their name for a message written to somebody else. FR 44. */
  employee: { id: string; firstName: string; name: string };
  /** Who is being told, where that is not the person whose leave it is. FR 44, FR 60. */
  recipient?: { id: string; firstName: string };
  /** The request **as it stands now**, which is where the desk and the status come from. */
  request: LeaveRequest;
  /** FR 27's problem again: a row carries a `leaveTypeId` and nobody recognises one. */
  typeName: string;
  /**
   * FR 52. The desk that just decided, where a desk did.
   *
   * Null for a submission, a withdrawal and a cancellation — none of which is a decision at
   * a desk, which is the same line ./leave-decision.ts draws for what gets recorded.
   */
  decidedBy: ApproverRole | null;
  /**
   * FR 39. What the approver said, where they said anything.
   *
   * Always present on a refusal — `requireAComment` and `leave_request_refusal_says_why`
   * see to that long before this is composed — and usually absent on an approval.
   */
  comment: string | null;
  /**
   * What the person may book now, after whatever just happened.
   *
   * The figure from the same transaction that moved it, which is why it is a parameter
   * rather than something composed from `request.days`: a release gives back what the
   * request was priced at, and what somebody has *left* is a fact about their whole balance.
   * It is the second most useful line in every one of these messages and it is the one that
   * stops a refusal being followed by a person opening the system to see whether the days
   * came back.
   */
  availableAfter: number;
  /** FR 44. Which decision was overturned, on the one event that is about that. LMS 318. */
  overturned?: { desk: ApproverRole; said: 'APPROVE' | 'REFUSE' } | null;
}

/**
 * The message, for both channels. FR 59.
 *
 * Pure, and every event is a branch of one function rather than six composers, so that the
 * things every message has to get right — the type, the dates, the day count, the balance —
 * are written once. Six functions would be six places for "6 days" to become "6 day".
 *
 * ## What every message does, in this order
 *
 *   **Says what happened, in the subject.** Somebody scanning a mailbox on a phone reads
 *   the subject and nothing else, so it carries the news rather than the reference: "Your
 *   Annual Leave for 2 March to 10 March is approved", never "Leave request 4471 updated".
 *
 *   **Says whether the leave is theirs to take.** The one sentence the story is about, and
 *   it is present in every branch including the ones where it is obvious. `STAGE_APPROVED`
 *   says *do not book anything on it* in those words, next to the good news, because the
 *   good news is exactly what makes somebody stop reading.
 *
 *   **Says what the balance did.** A held day, a taken day and a returned day are three
 *   different things and none of them is visible from a status. `availableAfter` is what
 *   the person actually wants — how many days they may book now — rather than an arithmetic
 *   they have to do.
 *
 *   **Says what to do next, where there is anything.** A refusal points at asking again on
 *   different dates, because the days are back and nothing about those dates is blocked any
 *   more. A cancellation points at HR, because it is not a judgement about the leave and
 *   the likeliest reader thinks it is.
 *
 * ## The reason is quoted rather than summarised
 *
 * FR 39's comment is reproduced whole, on its own indented line, in the words the approver
 * wrote. That is the same rule ./leave-decision.ts holds the column to and for the same
 * reason: it is the only account of the decision that will exist when somebody asks about
 * it next year, and a message that paraphrased it would be a second version of a sentence
 * that is supposed to have one.
 */
export function noticeOf(happened: WhatHappened): NewNotice {
  const { event, employee, request, typeName, decidedBy, comment, availableAfter } = happened;

  /** FR 44, FR 60. The person being told, who is the requester on every event but one. */
  const reader = happened.recipient ?? employee;

  const period = periodInWords(request.from, request.to);
  const cost = `${inDays(request.days)} of ${typeName}, ${period}`;
  const held = inDays(request.days);
  const left = `You have ${inDays(availableAfter)} to book.`;
  /* FR 39, quoted whole and set apart, in the words the approver wrote. */
  const said = comment === null ? [] : ['They said:', `    ${comment}`];
  const decided = deskOrSomebody(decidedBy);

  const message = ((): { subject: string; paragraphs: string[] } => {
    switch (event) {
      case 'SUBMITTED':
        return {
          subject: `Your ${typeName} for ${period} has been submitted`,
          paragraphs: [
            `You have asked for ${cost}.`,
            `It is now with ${withWhom(request)}. This leave is not agreed yet, so do not book anything on it.`,
            `The ${held} are being held while it is decided. ${left}`,
            'You will hear again the moment anything happens to it.',
          ],
        };

      case 'STAGE_APPROVED':
        return {
          subject:
            `${sentenceCase(decided)} approved your ${typeName} — ` +
            `it still needs ${withWhom(request)}`,
          paragraphs: [
            `${sentenceCase(decided)} has approved your request for ${cost}.`,
            `It is not agreed yet, so do not book anything on it. It has gone on to ${withWhom(request)}.`,
            ...said,
            `Your balance has not moved — the ${held} are still being held while it is decided. ${left}`,
          ],
        };

      case 'APPROVED':
        return {
          subject: `Your ${typeName} for ${period} is approved`,
          paragraphs: [
            `Your request for ${cost} is approved.`,
            `Every approver has said yes — ${decided} was the last — so this leave is agreed and is yours to take.`,
            ...said,
            `The ${held} have come off your balance. ${left}`,
          ],
        };

      /* FR 44, LMS 318. A stage said no and the request carried on to the next desk. The
         days are still held and the leave is not over, which is exactly the thing somebody
         reading "turned down" would otherwise get wrong. */
      case 'STAGE_REFUSED':
        return {
          subject:
            `${sentenceCase(decided)} turned down your ${typeName} — ` +
            `it has gone to ${withWhom(request)}`,
          paragraphs: [
            `${sentenceCase(decided)} has turned down your request for ${cost}.`,
            `That is not the end of it. Every stage decides, and it has gone on to ${withWhom(request)}, who will make the final call.`,
            ...said,
            `Your balance has not moved — the ${held} are still being held while it is decided. ${left}`,
          ],
        };

      case 'REFUSED':
        return {
          subject: `Your ${typeName} for ${period} was turned down`,
          paragraphs: [
            `Your request for ${cost} has been turned down at ${possessive(decidedBy)} stage.`,
            ...said,
            `The ${held} are back in your balance. ${left}`,
            'Nothing is blocking those dates now, so if you still need the time off you can ask for it again — for the same days or for different ones.',
          ],
        };

      /* FR 44, §7.2, LMS 318. The one message written to somebody other than the person
         taking the leave: the line manager whose decision was reversed. It names the
         justification in full, which is the whole of what they are owed. */
      case 'DECISION_OVERTURNED': {
        const theirs = happened.overturned?.said === 'APPROVE' ? 'approved' : 'turned down';
        const now = request.status === 'APPROVED' ? 'approved' : 'turned down';

        return {
          subject: `${decided} overturned your decision on ${possessively(employee.name)} ${typeName}`,
          paragraphs: [
            `You ${theirs} ${possessively(employee.name)} request for ${cost}, and ${decided} has decided otherwise. The leave is ${now}.`,
            ...said,
            'This is a record of a decision, not a question. If you think it was made on the wrong facts, speak to HR — the reason above and your own are both on the request for good.',
          ],
        };
      }

      /* FR 48b, §8.6a, LMS 320. Two readers: the person whose leave has stopped, and
         whoever can change the organisation so that it has not. The comment carries the
         routing's own account of which desk was empty and what would fill it. */
      case 'UNROUTABLE': {
        const theirs = reader.id === employee.id;

        return {
          subject: theirs
            ? `Your ${typeName} for ${period} has nobody who can decide it`
            : `${possessively(employee.name)} ${typeName} for ${period} has nobody who can decide it`,
          paragraphs: theirs
            ? [
                `Your request for ${cost} has stopped: there is no approver left who could ` +
                  `decide it, so nobody has approved or turned it down.`,
                ...said,
                `Nothing is wrong with the request and nobody has judged it. The ${held} ` +
                  `are still held while this is sorted out. ${left}`,
                'HR has been told and will put it back to an approver. If you no longer need the time off, withdraw it.',
              ]
            : [
                `${employee.name} asked for ${cost}, and the approval chain for it has run ` +
                  `out of people who could decide it. The request has not been approved and ` +
                  `has not been turned down.`,
                ...said,
                `Their ${held} are still held, so this is not costing them anything yet — ` +
                  'but nothing will happen to it until somebody can be asked.',
                'Once there is, send the request back to its approvers. Nobody may decide their own leave, whatever roles they hold. FR 48b.',
              ],
        };
      }

      case 'WITHDRAWN':
        return {
          subject: `Your ${typeName} for ${period} has been taken back`,
          paragraphs: [
            `The request for ${cost} has been withdrawn, and nobody has to approve anything for that to take effect.`,
            `The ${held} are back in your balance. ${left}`,
            'If this was not you, it was HR taking it back on your behalf. Ask them why.',
          ],
        };

      default:
        return {
          subject: `Your ${typeName} for ${period} has been cancelled`,
          paragraphs: [
            `The request for ${cost} has been cancelled by HR.`,
            'A cancellation is HR taking a record off the books — leave entered twice, or against the wrong person, or in the wrong year. It is not a decision about whether you may have the time off, and nobody has turned anything down.',
            `The ${held} are back in your balance. ${left}`,
            'If you were expecting this leave to happen, speak to HR.',
          ],
        };
    }
  })();

  return validateNotice({
    /** FR 44, FR 60. The recipient rather than the subject; the two differ on one event. */
    employeeId: reader.id,
    leaveRequestId: request.id,
    event,
    subject: message.subject,
    body: [`Hello ${reader.firstName},`, ...message.paragraphs, SIGN_OFF].join('\n\n'),
  });
}

/**
 * How every message ends, in the same words the sign in code uses.
 *
 * One constant rather than a line in six branches, because it is the part a reader uses to
 * decide the message is genuine — and a phishing message is much easier to write against a
 * system whose own emails end differently each time.
 */
const SIGN_OFF = 'Remat Holdings Leave';

/**
 * Checks a notice on its way to being written.
 *
 * Every field is composed rather than typed, so nothing here can be provoked by a person —
 * which is exactly why it is worth having. `notification_subject_not_blank` and its pair
 * refuse an empty message at the table, with a sentence about a constraint; this refuses
 * it at the composer, naming the field, before a row is attempted and before an email with
 * an empty subject line reaches somebody's phone.
 *
 * A blank message is the shape every templating bug takes. A leave type with no name, an
 * event that fell through a switch, a body assembled from an empty list — all of them
 * produce a notice that satisfies NOT NULL and says nothing.
 */
export function validateNotice(input: NewNotice): NewNotice {
  const subject = input.subject.trim();
  const body = input.body.trim();

  if (subject === '') {
    throw new InvalidNotice(
      'subject',
      'A notice with no subject line is a bell that rings and says nothing.',
    );
  }

  if (body === '') {
    throw new InvalidNotice(
      'body',
      'A notice with no message is worse than not being told at all.',
    );
  }

  if (!(NOTICE_EVENTS as readonly string[]).includes(input.event)) {
    throw new InvalidNotice(
      'event',
      `${String(input.event)} is not something anybody is told about. The events are ` +
        `${NOTICE_EVENTS.join(', ')}.`,
    );
  }

  return { ...input, subject, body };
}

/**
 * Which piece of news an approval was. FR 38a, FR 41. LMS 314, LMS 316, LMS 329.
 *
 * Read off the request **as it stands after the approval**, which is what makes it the
 * answer rather than a guess: `awaiting_approval_from` is null exactly when there is nobody
 * left to ask, and `leave_request_waits_at_a_desk` holds that equivalence on every
 * connection. The same reading `LeaveApproved` tells its callers to make.
 *
 * Deliberately not `isTheLastWord(outcome)`, though the two agree. That outcome is worked
 * out twice — once by the service for the sentence and once inside the balance lock, where
 * it binds — and a notice composed from the first would describe an approval that a
 * lengthened chain had turned into something else. The row is what committed.
 */
export function approvalNews(request: LeaveRequest): NoticeEvent {
  return request.status === 'APPROVED' ? 'APPROVED' : 'STAGE_APPROVED';
}

/**
 * Which piece of news one desk's decision was. FR 44, LMS 318.
 *
 * Four answers from two facts: which way the desk went, and whether the request has
 * anywhere left to go. Read off the committed row, so a stage that turned leave down
 * without ending it says so rather than telling somebody their leave is over.
 */
export function decisionNews(request: LeaveRequest, saidYes: boolean): NoticeEvent {
  if (saidYes) {
    return approvalNews(request);
  }

  return request.status === 'REFUSED' ? 'REFUSED' : 'STAGE_REFUSED';
}

/**
 * Which piece of news an ending was.
 *
 * A total function over {@link ReleasingStatus} and nothing wider, so the three endings and
 * the three events cannot come apart — the unit suite asserts every member of
 * `RELEASING_STATUSES` has one here. The names match on purpose and are still mapped rather
 * than cast: the day an ending arrives whose news is not its status is the day a cast would
 * be silently wrong.
 */
export function endingNews(status: 'WITHDRAWN' | 'CANCELLED'): NoticeEvent {
  return status === 'WITHDRAWN' ? 'WITHDRAWN' : 'CANCELLED';
}

/**
 * The period, as a person says it. "2 March 2026 to 10 March 2026", or one day on its own.
 *
 * {@link formatDay} at both ends, so the month is a word — the argument that function makes
 * at length, and it is sharpest here of anywhere: `03/10/2026` in an email about leave is
 * two different days depending on who is reading, and this is the message somebody books a
 * flight against.
 *
 * A single day is said once rather than as "to itself", which is the one case a naive join
 * gets embarrassingly wrong.
 */
export function periodInWords(from: CalendarDate, to: CalendarDate): string {
  return from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`;
}

/**
 * Who has the request now, in words, for a message written before anybody has decided.
 *
 * Answers the null rather than asserting it. `awaiting_approval_from` is not null exactly
 * while the status is `SUBMITTED`, so a submission notice always has a desk — but a notice
 * that read "it is now with undefined" would be worse than one that says less, which is
 * the same choice `reasonForRelease` makes about a leave type that cannot be missing.
 */
function withWhom(request: LeaveRequest): string {
  return request.awaitingApprovalFrom === null
    ? 'an approver'
    : deskInWords(request.awaitingApprovalFrom);
}

/**
 * A desk, where the caller has already established there is one.
 *
 * The null case is unreachable for every event that passes a desk in — an approval and a
 * refusal are both decisions at one, and `leave_request_records_its_decision` refuses at
 * COMMIT a move that recorded none. Answered rather than asserted, for the reason above.
 */
function deskOrSomebody(desk: ApproverRole | null): string {
  return desk === null ? 'an approver' : deskInWords(desk);
}

/** "the line manager's" — the desk said as the owner of a stage. */
function possessive(desk: ApproverRole | null): string {
  const named = deskOrSomebody(desk);

  return named.startsWith('your ') ? `the ${named.slice('your '.length)}'s` : `${named}'s`;
}

/** "6 days", "1 day". The pluralisation every message needs and none of them repeats. */
function inDays(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** A phrase that starts a sentence. "your line manager" opening one reads as a typo. */
function sentenceCase(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}
