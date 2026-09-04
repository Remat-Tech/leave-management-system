/**
 * A leave request started and not finished. FR 19, FR 10, §6., LMS 302.
 */

import { type CalendarDate, formatDay, isCalendarDate } from '../../shared/time.js';
import type { NewLeaveRequest } from './leave-request.js';

/**
 * The fields a draft holds, in the order a form asks for them. FR 10, FR 19.
 *
 * `whatIsMissing` reports in this order, so the sentence names the first thing to do.
 */
export const DRAFT_FIELDS = ['leaveTypeId', 'from', 'to', 'reason'] as const;

export type DraftField = (typeof DRAFT_FIELDS)[number];

/** A field as a person says it, for the sentence that names what is left. NFR USA 03. */
export function fieldInWords(field: DraftField): string {
  switch (field) {
    case 'leaveTypeId':
      return 'the kind of leave';
    case 'from':
      return 'the first day';
    case 'to':
      return 'the last day';
    default:
      return 'the reason';
  }
}

/**
 * What somebody has filled in so far. FR 19.
 *
 * FR 10's four fields, each of them optional, which is the story read literally: somebody
 * plans before the dates are settled. Whose leave it is is not here — a draft's owner is
 * the actor, never a field a caller supplies.
 */
export interface DraftContents {
  leaveTypeId: string | null;
  from: CalendarDate | null;
  to: CalendarDate | null;
  reason: string | null;
}

/** A draft as it comes back out. */
export interface LeaveRequestDraft extends DraftContents {
  id: string;
  employeeId: string;
  createdAt: Date;
  /** When it was last worked on, which is what a list of drafts is ordered by. */
  updatedAt: Date;
}

/** A draft that is not a draft. The shape every validator here has. NFR USA 03. */
export class InvalidLeaveRequestDraft extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeaveRequestDraft';
    this.field = field;
  }
}

/** No such draft. */
export class LeaveRequestDraftNotFound extends Error {
  readonly draftId: string;

  constructor(id: string) {
    super(`There is no leave request draft ${id}.`);
    this.name = 'LeaveRequestDraftNotFound';
    this.draftId = id;
  }
}

/**
 * A draft submitted with something still to fill in. FR 19, NFR USA 03. LMS 302.
 *
 * The one refusal that is about a draft rather than about the leave. Everything a
 * submission refuses — the days, the year, the overlap — is refused afterwards by the path
 * that already says it, in its own words.
 */
export class DraftIsNotFinished extends Error {
  /** FR 19. What a client branches on, to put the person back on the field. */
  readonly code = 'DRAFT_NOT_FINISHED';
  readonly draftId: string;
  /** In {@link DRAFT_FIELDS} order. */
  readonly missing: readonly DraftField[];

  constructor(draft: LeaveRequestDraft, missing: readonly DraftField[]) {
    super(
      `This draft still needs ${listOf(missing.map(fieldInWords))}. A draft is saved with ` +
        `as little as one field filled in, and asked for once it says what leave it is, ` +
        `when it runs and why. Nothing is held until then.`,
    );
    this.name = 'DraftIsNotFinished';
    this.draftId = draft.id;
    this.missing = [...missing];
  }
}

/**
 * What a draft still needs before it can be asked for, in FR 10's order. FR 19.
 *
 * Pure, and the one answer to that question: {@link readyToSubmit} refuses on it and a
 * screen lists it, so a form and a refusal cannot disagree about what is left.
 */
export function whatIsMissing(draft: DraftContents): readonly DraftField[] {
  return DRAFT_FIELDS.filter((field) => draft[field] === null);
}

/** Whether it holds everything a request is made of. FR 19. */
export function isFinished(draft: DraftContents): boolean {
  return whatIsMissing(draft).length === 0;
}

/**
 * Whether anything has been filled in at all. FR 19.
 *
 * An empty draft is a row saying somebody opened a form, which is not planning. Refused by
 * {@link validateDraftContents} rather than stored.
 */
export function isEmpty(draft: DraftContents): boolean {
  return whatIsMissing(draft).length === DRAFT_FIELDS.length;
}

/**
 * The draft as the four fields a submission takes, refusing an unfinished one. FR 19, FR 10.
 *
 * The one door between a draft and a request. Nothing here defaults a missing field, so a
 * draft cannot become leave nobody asked for.
 */
export function readyToSubmit(draft: LeaveRequestDraft): Omit<NewLeaveRequest, 'employeeId'> {
  const missing = whatIsMissing(draft);

  if (missing.length > 0 || draft.leaveTypeId === null || draft.reason === null) {
    throw new DraftIsNotFinished(draft, missing);
  }

  if (draft.from === null || draft.to === null) {
    /* Unreachable: `whatIsMissing` reports both. Answered rather than asserted, because
       the alternative is a period with an undefined end in it. */
    throw new DraftIsNotFinished(draft, missing);
  }

  return {
    leaveTypeId: draft.leaveTypeId,
    from: draft.from,
    to: draft.to,
    reason: draft.reason,
  };
}

/**
 * Where a draft stands, for the screen somebody comes back to. FR 19, NFR USA 03.
 */
export interface DraftProgress {
  finished: boolean;
  missing: readonly DraftField[];
  inWords: string;
}

/** The sentence beside a draft, which says what to do rather than what is absent. */
export function progressOfDraft(draft: DraftContents): DraftProgress {
  const missing = whatIsMissing(draft);

  return {
    finished: missing.length === 0,
    missing,
    inWords:
      missing.length === 0
        ? 'This is ready to ask for. Nothing is held and nobody has been asked until you do.'
        : `Still to fill in: ${listOf(missing.map(fieldInWords))}. Nothing is held and ` +
          `nobody has been asked.`,
  };
}

/**
 * The four fields as a form sent them, before anything has been checked. FR 19.
 *
 * `unknown` rather than the domain types, because a draft's fields arrive from a JSON body
 * and absent, empty and cleared all have to be told apart in one place — this one.
 */
export interface DraftAsSent {
  leaveTypeId?: unknown;
  from?: unknown;
  to?: unknown;
  reason?: unknown;
}

/**
 * The whole of what somebody typed, checked for shape and nothing else. FR 19.
 *
 * Every field may be absent, and what is checked is that what is *there* is what it claims
 * to be. Whether the leave is affordable, in one year, or over leave already booked is
 * asked at submission by the path that already asks it.
 */
export function validateDraftContents(input: DraftAsSent): DraftContents {
  const contents: DraftContents = {
    leaveTypeId: optionalId('leaveTypeId', input.leaveTypeId),
    from: optionalDay('from', input.from),
    to: optionalDay('to', input.to),
    reason: optionalText(input.reason),
  };

  if (isEmpty(contents)) {
    throw new InvalidLeaveRequestDraft(
      'leaveTypeId',
      'A draft with nothing in it is a form that was opened rather than leave that is ' +
        'being planned. Fill in whatever is settled — the kind of leave, a date, or why ' +
        '— and the rest can wait.',
    );
  }

  /* The same rule `leave_request_draft_ends_after_it_starts` holds, said where it can name
     the days. Only where both are there: one date is unfinished rather than wrong. */
  if (contents.from !== null && contents.to !== null && contents.to < contents.from) {
    throw new InvalidLeaveRequestDraft(
      'to',
      `This draft ends on ${formatDay(contents.to)} and starts on ` +
        `${formatDay(contents.from)}. Leave that ends before it starts is two dates the ` +
        `wrong way round. Leave either one out until it is settled.`,
    );
  }

  return contents;
}

/** An id, or nothing. Blank is nothing: a cleared field is a field nobody has filled in. */
function optionalId(field: DraftField, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new InvalidLeaveRequestDraft(field, `${field} is an id, or is left out.`);
  }

  return value.trim() === '' ? null : value.trim();
}

/** A day, or nothing. The same ten characters `requireDay` insists on. NFR DAT 03. */
function optionalDay(field: DraftField, value: unknown): CalendarDate | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (!isCalendarDate(value)) {
    throw new InvalidLeaveRequestDraft(
      field,
      `${field} is a date in the form YYYY-MM-DD, or is left out. 03/04/2026 and ` +
        `04/03/2026 are the same ten characters meaning two different days.`,
    );
  }

  return value;
}

/** A sentence, or nothing. Trimmed to nothing is nothing, which the column also holds. */
function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return value.trim() === '' ? null : value.trim();
}

/** "the kind of leave, the first day and the reason". The list `chainInWords` reads like. */
function listOf(words: readonly string[]): string {
  return words.length <= 1
    ? (words[0] ?? 'nothing')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
