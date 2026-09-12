/**
 * What somebody is told when something happens to their leave, and in what words. FR 59, §7.1., LMS 329, LMS 306, LMS 315, LMS 316, LMS 323, FR 60, LMS 209.
 */

import { type ApproverRole, deskInWords, possessively } from '../leave-type/approval-chain.js';
import type { LeaveRequest } from '../leave-request/leave-request.js';
import { type CalendarDate, formatDay } from '../../shared/time.js';
import {
  emailFor,
  fillIn,
  ORIGINAL_WORDING,
  type PlaceholderValues,
  type Wording,
} from './wording.js';

/** How every message ends. */
export { SIGN_OFF } from './wording.js';

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
  /** The manager, told their decision was overturned. FR 44, §7.2, LMS 318. */
  'DECISION_OVERTURNED',
  /** Nobody can decide it, told to the requester and to whoever can fix that. FR 48b, LMS 320. */
  'UNROUTABLE',
  /** The manager who has just inherited a pending request. FR 07, §8.4, LMS 325. */
  'REASSIGNED',
  /**
   * The four turns of FR 47's conversation about agreed leave. LMS 324.
   *
   * `WITHDRAWAL_ASKED` goes to HR, who has to answer it — the second event written to
   * somebody other than the person taking the leave. The other three go back to them, and
   * none of the three could be carried by an event that already existed: `WITHDRAWN` says
   * "nobody has to approve anything for that to take effect", which is true of a request in
   * a queue and is the opposite of this.
   */
  'WITHDRAWAL_ASKED',
  'WITHDRAWAL_GRANTED',
  'LEAVE_AMENDED',
  'WITHDRAWAL_REFUSED',
  /** The approver a request is still sitting on, chased daily. FR 50, FR 60, LMS 330. */
  'STILL_WAITING',
  /**
   * Days of agreed leave that became sick leave. FR 32c, §8.6c, LMS 507.
   *
   * Not `LEAVE_AMENDED`: nothing came off the books and the leave still happened. What the
   * person needs told is that a holiday they spent unwell is back in their annual balance.
   */
  'LEAVE_RECLASSIFIED',
  /**
   * A public holiday declared inside leave they already had. FR 25, §8.8, LMS 508.
   *
   * The story's fourth criterion. Not `LEAVE_AMENDED` either: nothing came off the books
   * and nobody agreed to anything. A day the country was not working stopped being charged.
   */
  'LEAVE_RECALCULATED',
] as const;

export type NoticeEvent = (typeof NOTICE_EVENTS)[number];

/**
 * Whether this is the daily reminder rather than news of something that happened. FR 50, LMS 330.
 *
 * The one event ./reminder.ts composes: nothing has happened to the request, which is the
 * whole of what it is about, so {@link noticeOf} has no branch for it.
 */
export function isAReminder(event: NoticeEvent): boolean {
  return event === 'STILL_WAITING';
}

/**
 * The events after which a balance has days it did not have before. FR 47, LMS 324.
 *
 * Three of them end the leave. `LEAVE_AMENDED` does not and is on the list anyway, which is
 * the reason it is named for what the balance did rather than for what the request did: the
 * question a reader has is whether days came back, and an amendment is the one piece of news
 * where some did and the leave went ahead.
 */
const GAVE_THE_DAYS_BACK: readonly NoticeEvent[] = [
  'REFUSED',
  'WITHDRAWN',
  'CANCELLED',
  'WITHDRAWAL_GRANTED',
  'LEAVE_AMENDED',
  /** FR 32c. Into one balance, and out of another. LMS 507. */
  'LEAVE_RECLASSIFIED',
  /** FR 25. Into the balance the day was charged to, out of nothing. LMS 508. */
  'LEAVE_RECALCULATED',
];

/** Whether this is news that the balance has days again. */
export function givesTheDaysBack(event: NoticeEvent): boolean {
  return GAVE_THE_DAYS_BACK.includes(event);
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
  /** Why the last attempt did not, in the transport's own words. */
  emailFailure: string | null;
  /** Sends made, delivered or not. LMS 331. */
  emailAttempts: number;
  /** When the next send is due, null where none is. LMS 331. */
  emailNextAttemptAt: Date | null;
  /** When the last permitted attempt failed. LMS 331. */
  emailGaveUpAt: Date | null;
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
  /**
   * FR 47. How many days actually came back, on the events where that is not all of them. LMS 324.
   *
   * Every other message says `request.days`, because every other movement in a request's
   * life is the whole of what it was priced at. An amendment is the first that is not:
   * agreed leave that has started gives back what was left and keeps what was taken, so a
   * message composed from the request would tell somebody a fortnight had come back when
   * four days had.
   *
   * Taken from the entry that was written rather than worked out here, for the reason every
   * field on this interface is: it describes what committed.
   */
  daysBack?: number | null;
  /** FR 32c. What the days became, and what that balance holds now. LMS 507. */
  movedInto?: { typeName: string; availableAfter: number } | null;
  /** FR 25. The day the gazette declared late, on the one event that is about that. LMS 508. */
  declared?: { name: string; date: CalendarDate } | null;
}

/**
 * The message, for both channels, in HR's wording where there is some. FR 59, FR 61, LMS 512.
 *
 * Pure. The words live in ./wording.ts; this works out what fills them in.
 */
export function noticeOf(happened: WhatHappened, wording?: Wording): NewNotice {
  const { event, employee, request } = happened;

  if (!(NOTICE_EVENTS as readonly string[]).includes(event)) {
    throw notAnEvent(event);
  }

  /* FR 50, LMS 330. A reminder says nothing happened, so ./reminder.ts composes it. */
  if (isAReminder(event)) {
    throw new InvalidNotice(
      'event',
      `${event} is not news of anything happening to a request, so it is not composed here.`,
    );
  }

  /** FR 44, FR 60. The person being told, who is not always the requester. */
  const reader = happened.recipient ?? employee;
  const email = emailFor(event, reader.id === employee.id);
  const filled = fillIn(wording ?? ORIGINAL_WORDING[email], placeholderValuesOf(happened));

  return validateNotice({
    employeeId: reader.id,
    leaveRequestId: request.id,
    event,
    subject: filled.subject,
    body: filled.body,
  });
}

/** The placeholders every email about one request can use. FR 61, LMS 512. */
export function leaveInWords(leave: {
  firstName: string;
  employeeName: string;
  request: LeaveRequest;
  typeName: string;
}): Record<
  'firstName' | 'employeeName' | 'employeeNamePossessive' | 'typeName' | 'period' | 'cost' | 'days',
  string
> {
  const period = periodInWords(leave.request.from, leave.request.to);

  return {
    firstName: leave.firstName,
    employeeName: leave.employeeName,
    employeeNamePossessive: possessively(leave.employeeName),
    typeName: leave.typeName,
    period,
    cost: `${inDays(leave.request.days)} of ${leave.typeName}, ${period}`,
    days: inDays(leave.request.days),
  };
}

/** What fills in the placeholders for one piece of news. */
function placeholderValuesOf(happened: WhatHappened): PlaceholderValues {
  const { event, employee, request, decidedBy, comment } = happened;
  const reader = happened.recipient ?? employee;

  const leave = leaveInWords({
    firstName: reader.firstName,
    employeeName: employee.name,
    request,
    typeName: happened.typeName,
  });

  const oneDayBack = happened.daysBack === 1;
  const into = happened.movedInto ?? null;
  const day = happened.declared ?? null;

  return {
    ...leave,
    daysLeftToBook: inDays(happened.availableAfter),
    decidedBy: deskOrSomebody(decidedBy),
    decidedByPossessive: possessive(decidedBy),
    nowWith: withWhom(request),
    /* FR 39, quoted whole and set apart, in the words the approver wrote. */
    comment: comment === null ? '' : `They said:\n\n    ${comment}`,
    theirDecision: happened.overturned?.said === 'APPROVE' ? 'approved' : 'turned down',
    finalDecision: request.status === 'APPROVED' ? 'approved' : 'turned down',
    /* FR 25. A holiday credits back one day unless told otherwise. */
    daysBack: inDays(happened.daysBack ?? (event === 'LEAVE_RECALCULATED' ? 1 : request.days)),
    isOrAre: oneDayBack ? 'is' : 'are',
    hasOrHave: oneDayBack ? 'has' : 'have',
    thoseDaysAre: oneDayBack ? 'that day is' : 'those days are',
    movedIntoTypeName: into?.typeName ?? 'sick leave',
    movedIntoBalance:
      into === null
        ? 'The same days have been taken off the balance they moved to.'
        : `They have come off your ${into.typeName} balance instead, which now stands ` +
          `at ${inDays(into.availableAfter)}. That figure can be negative — sick leave ` +
          `past its allowance is granted on a certificate rather than refused.`,
    declaredHoliday:
      day === null
        ? `A public holiday has been declared on a day inside your ${leave.cost}.`
        : `${formatDay(day.date)} has been declared ${day.name}, and it falls inside ` +
          `your ${leave.cost}.`,
  };
}

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
    throw notAnEvent(input.event);
  }

  return { ...input, subject, body };
}

function notAnEvent(event: string): InvalidNotice {
  return new InvalidNotice(
    'event',
    `${event} is not something anybody is told about. The events are ${NOTICE_EVENTS.join(', ')}.`,
  );
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

/** "the manager's" — the desk said as the owner of a stage. */
function possessive(desk: ApproverRole | null): string {
  const named = deskOrSomebody(desk);

  return named.startsWith('your ') ? `the ${named.slice('your '.length)}'s` : `${named}'s`;
}

/** "6 days", "1 day". The pluralisation every message needs and none of them repeats. */
export function inDays(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
