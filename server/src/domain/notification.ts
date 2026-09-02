/**
 * What somebody is told when something happens to their leave, and in what words. FR 59,
 * §7.1. LMS 329.
 *
 * The story is one sentence and the whole file follows from it: *I am not refreshing a
 * screen to find out whether I can book a flight.* Read that literally and it is not a
 * request for messages — it is a request for a particular sentence to arrive at a
 * particular moment, and every decision here is about which sentence.
 *
 * Four stories have ended by pointing at this one. LMS 306: "Being *told* that a request
 * went away is FR 59's". LMS 315: "That somebody is *told* their leave was refused is a
 * story of its own; what this one guarantees is that there is something true to tell them."
 * LMS 316 built {@link progressOf} so that "is this agreed" had one answer. LMS 323 said
 * FR 59 "owns notification for every event in a request's life". This is that file, and
 * what those four left it is a system in which every event already has something true to
 * say about it.
 *
 * ## The composition is here, so that the email and the screen are one message
 *
 * {@link noticeOf} returns a subject and a body, both plain text, and both are stored on
 * the row. The email sends exactly them; the in-app notice shows exactly them. There is no
 * second template anywhere and there is deliberately nowhere to put one.
 *
 * That is the same argument {@link chainInWords} makes about naming a desk — "the same
 * sentence is wanted in an email, in an error and on a screen, and three copies of it would
 * drift" — and the drift here would be worse than a wording difference. Two templates
 * eventually disagree about whether leave is *agreed*, and the person reading the more
 * optimistic of the two books a flight.
 *
 * ## The six events are six different pieces of news
 *
 * {@link NOTICE_EVENTS}, and the one worth arguing about is that an approval is two of
 * them. `STAGE_APPROVED` and `APPROVED` differ by the only thing the story cares about:
 * whether the leave is yours to take. "Your line manager approved this" is the sentence
 * LMS 316 was written to stop being the whole answer, and a single `APPROVED` event
 * covering both would put that defect in an email — where it is worse, because an email is
 * read once, out of context, on a phone, by somebody with a booking page open.
 *
 * So `STAGE_APPROVED` says *do not book anything on it* in the body, in those words, and
 * `APPROVED` says *this is agreed and is yours to take*. Every other line in either message
 * is context around that sentence.
 *
 * ## What is not here
 *
 * **No email envelope.** A {@link Mail} has an address on it and `/domain` holds neither
 * addresses nor transports — `noticeEmail` sits beside the service, exactly as `codeEmail`
 * sits beside the code rules in ../auth/mfa.ts and `discrepancyEmail` beside the
 * reconciliation job.
 *
 * **No recipient.** {@link noticeOf} is handed whose leave it is and composes for them;
 * where the message is delivered is the service's, from the employee record. That division
 * is what lets the whole of the wording be tested without a person, a mailbox or a
 * database.
 *
 * **No decision about when to send.** These are pure functions over facts that have already
 * happened. That a notice is written *after* the transaction commits — never inside it — is
 * ../services/notification-service.ts and the migration, and it is the one rule about this
 * feature that a wrong answer to is unrecoverable.
 *
 * **No approver's queue.** FR 59 is what the *requester* is told. That the manager has
 * something waiting is FR 60, would put a different id in `notification.employee_id`, and
 * needs the desk resolved to a person — which is ../auth/leave-request-policy.ts's and not
 * a question this file can ask.
 *
 * **No override.** FR 59 lists one among the things somebody is told about and nothing in
 * this system overrides a decision yet: `REQUEST_ACTIONS` is withdraw, refuse, cancel and
 * approve. LMS 209's rule — a value nothing can write is a promise the schema cannot keep —
 * applies to this list exactly as it does to `REQUEST_STATUSES`, so the story that brings
 * the override brings its notice, which is one member here and one branch in
 * {@link noticeOf}.
 */

import { type ApproverRole, deskInWords } from './approval-chain.js';
import type { LeaveRequest } from './leave-request.js';
import { type CalendarDate, formatDay } from './time.js';

/**
 * The things somebody is told about. FR 59.
 *
 * The story's list — "submission, each decision, override, cancellation and withdrawal
 * outcome" — with the override absent for the reason the module note gives, and with "each
 * decision" spelled as the three it actually is: a stage approving, the last stage
 * approving, and a refusal.
 *
 * `notification_event_known` holds the same six values, and the integration suite reads
 * that constraint back out of `pg_constraint` and asserts the two agree — so neither can
 * be extended alone.
 *
 * Written out rather than derived from {@link REQUEST_STATUSES} or {@link REQUEST_ACTIONS},
 * and it is the same discipline every list in ./leave-request.ts keeps. Neither derivation
 * works: there are five statuses and six events, because approval is one status and two
 * pieces of news, and there are four actions and six events, because submitting is not an
 * action in the state machine at all. A list that absorbed whatever arrived next would
 * either notify nobody about a new verb or notify everybody about a new status with no
 * words to say.
 */
export const NOTICE_EVENTS = [
  'SUBMITTED',
  'STAGE_APPROVED',
  'APPROVED',
  'REFUSED',
  'WITHDRAWN',
  'CANCELLED',
] as const;

export type NoticeEvent = (typeof NOTICE_EVENTS)[number];

/**
 * The events after which the leave is not going to happen, and the days are back.
 *
 * The three {@link RELEASING_STATUSES} named as news rather than as states, and the reason
 * they are a list here is {@link noticeOf}'s closing paragraph: all three end with the same
 * two sentences about the balance, and writing those three times is how one of them comes
 * to say the days are back when they are not.
 */
const ENDED_AND_GAVE_THE_DAYS_BACK: readonly NoticeEvent[] = ['REFUSED', 'WITHDRAWN', 'CANCELLED'];

/** Whether this is news that the leave is off and the balance has the days again. */
export function givesTheDaysBack(event: NoticeEvent): boolean {
  return ENDED_AND_GAVE_THE_DAYS_BACK.includes(event);
}

/**
 * What is written down, and what is sent. FR 59.
 *
 * `subject` and `body` are one composition used by both channels — see the module note on
 * why there is deliberately no second template. Neither carries the recipient: an address
 * is the service's business and an id is the row's.
 */
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
  /** FR 59's in-app half. Null until the person has seen it. */
  readAt: Date | null;
  /** When the email left, or null where it has not. */
  emailedAt: Date | null;
  /** Why it did not, in the transport's own words. Null where it did. */
  emailFailure: string | null;
  createdAt: Date;
}

/**
 * A notice that was refused, and the field that caused it.
 *
 * The same shape every refusal in `/domain` carries, and it exists for one caller that is
 * not a person: nothing in this system lets somebody type a notice, so every one of these
 * is a bug in a composer rather than a form filled in wrongly. The field is carried anyway,
 * because the day FR 60 adds an approver's queue there will be a second composer and the
 * message should say which part of it was empty.
 */
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
 * rather than from what the caller expected — see ../services/leave-request-service.ts,
 * which reads all of them off the returned request, decision and balance. That is the
 * difference between describing what was committed and describing what was attempted, and
 * it is the whole reason a notice is composed after the transaction rather than before it.
 */
export interface WhatHappened {
  event: NoticeEvent;
  /** Whose leave it is. The first name is what the message opens with. */
  employee: { id: string; firstName: string };
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
    employeeId: employee.id,
    leaveRequestId: request.id,
    event,
    subject: message.subject,
    body: [`Hello ${employee.firstName},`, ...message.paragraphs, SIGN_OFF].join('\n\n'),
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
 * Which piece of news an ending was.
 *
 * A total function over {@link ReleasingStatus} and nothing wider, so the three endings and
 * the three events cannot come apart — the unit suite asserts every member of
 * `RELEASING_STATUSES` has one here. The names match on purpose and are still mapped rather
 * than cast: the day an ending arrives whose news is not its status is the day a cast would
 * be silently wrong.
 */
export function endingNews(status: 'WITHDRAWN' | 'CANCELLED' | 'REFUSED'): NoticeEvent {
  switch (status) {
    case 'WITHDRAWN':
      return 'WITHDRAWN';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'REFUSED';
  }
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
