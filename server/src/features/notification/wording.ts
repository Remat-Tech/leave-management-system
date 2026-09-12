/** The words each email is sent in, and HR's changes to them. FR 61, FR 59, LMS 512. */

import type { NoticeEvent } from './notification.js';

/** How every message ends. The part a reader checks the email is genuine by. */
export const SIGN_OFF = 'Remat Holdings Leave';

/** One email's words, with `{{placeholders}}` for what changes from request to request. */
export interface Wording {
  subject: string;
  body: string;
}

/** Every email the system sends. `UNROUTABLE` has two readers, so two emails. */
export const EMAILS = [
  'SUBMITTED',
  'STAGE_APPROVED',
  'STAGE_REFUSED',
  'APPROVED',
  'REFUSED',
  'WITHDRAWN',
  'CANCELLED',
  'DECISION_OVERTURNED',
  'UNROUTABLE',
  'UNROUTABLE_FOR_HR',
  'REASSIGNED',
  'WITHDRAWAL_ASKED',
  'WITHDRAWAL_GRANTED',
  'LEAVE_AMENDED',
  'WITHDRAWAL_REFUSED',
  'STILL_WAITING',
  'LEAVE_RECLASSIFIED',
  'LEAVE_RECALCULATED',
] as const satisfies readonly (NoticeEvent | 'UNROUTABLE_FOR_HR')[];

export type EmailName = (typeof EMAILS)[number];

/** Which email one event sends to one reader. */
export function emailFor(event: NoticeEvent, toTheRequester: boolean): EmailName {
  return event === 'UNROUTABLE' && !toTheRequester ? 'UNROUTABLE_FOR_HR' : event;
}

/** What each email is, and who reads it, for the screen. */
export const ABOUT_EACH_EMAIL: Record<EmailName, { label: string; readBy: string }> = {
  SUBMITTED: { label: 'Leave asked for', readBy: 'the person asking' },
  STAGE_APPROVED: { label: 'Approved at one stage, more to go', readBy: 'the person asking' },
  STAGE_REFUSED: { label: 'Turned down at one stage, sent on', readBy: 'the person asking' },
  APPROVED: { label: 'Leave approved', readBy: 'the person asking' },
  REFUSED: { label: 'Leave turned down', readBy: 'the person asking' },
  WITHDRAWN: { label: 'Request taken back', readBy: 'the person asking' },
  CANCELLED: { label: 'Leave cancelled by HR', readBy: 'the person asking' },
  DECISION_OVERTURNED: { label: 'A manager’s decision overturned', readBy: 'the manager' },
  UNROUTABLE: { label: 'Nobody can decide a request', readBy: 'the person asking' },
  UNROUTABLE_FOR_HR: { label: 'Nobody can decide a request', readBy: 'HR' },
  REASSIGNED: { label: 'A request handed to a new manager', readBy: 'the new manager' },
  WITHDRAWAL_ASKED: { label: 'Agreed leave asked off the books', readBy: 'HR' },
  WITHDRAWAL_GRANTED: { label: 'Agreed leave taken off the books', readBy: 'the person asking' },
  LEAVE_AMENDED: { label: 'Leave cut short after it started', readBy: 'the person asking' },
  WITHDRAWAL_REFUSED: { label: 'Agreed leave kept on the books', readBy: 'the person asking' },
  STILL_WAITING: { label: 'Daily reminder to decide', readBy: 'the approver' },
  LEAVE_RECLASSIFIED: { label: 'Holiday days now sick leave', readBy: 'the person asking' },
  LEAVE_RECALCULATED: { label: 'A day credited back for a holiday', readBy: 'the person asking' },
};

/** Every placeholder there is, and what it fills in. */
export const PLACEHOLDER_MEANINGS = {
  firstName: 'the first name of whoever the email is to',
  employeeName: 'the full name of whoever the leave belongs to',
  employeeNamePossessive: 'the same, as “Ama Mensah’s”',
  typeName: 'the kind of leave',
  period: 'the dates, as “2 March 2026 to 10 March 2026”',
  cost: 'the days, the kind of leave and the dates together',
  days: 'how many days were asked for, as “6 days”',
  daysLeftToBook: 'how many days they may still book',
  decidedBy: 'the stage that decided, as “your manager”',
  decidedByPossessive: 'the same, as “the manager’s”',
  nowWith: 'who the request is with now',
  comment: 'what the approver wrote, quoted whole, or nothing',
  theirDecision: 'what the manager had decided',
  finalDecision: 'what the leave is now',
  daysBack: 'how many days came back',
  isOrAre: '“is” for one day back, “are” for more',
  hasOrHave: '“has” for one day back, “have” for more',
  thoseDaysAre: '“that day is” or “those days are”',
  movedIntoTypeName: 'the kind of leave the days became',
  movedIntoBalance: 'a sentence on the balance the days moved to',
  declaredHoliday: 'a sentence naming the new public holiday',
  whenAsked: 'a sentence on when it was asked for',
  whenItStarts: 'a sentence on how soon the leave starts',
} as const;

export type Placeholder = keyof typeof PLACEHOLDER_MEANINGS;

export type PlaceholderValues = Partial<Record<Placeholder, string>>;

/** Offered in every email, whether or not the original uses them. */
const ALWAYS_OFFERED: readonly Placeholder[] = [
  'firstName',
  'employeeName',
  'employeeNamePossessive',
  'typeName',
  'period',
  'cost',
  'days',
];

/** The body every original shares: a greeting, the paragraphs, the sign off. */
function body(...paragraphs: string[]): string {
  return ['Hello {{firstName}},', ...paragraphs, SIGN_OFF].join('\n\n');
}

const TO_BOOK = 'You have {{daysLeftToBook}} to book.';

/** The wording every email had before HR changed anything. FR 59, LMS 329. */
export const ORIGINAL_WORDING: Record<EmailName, Wording> = {
  SUBMITTED: {
    subject: 'Your {{typeName}} for {{period}} has been submitted',
    body: body(
      'You have asked for {{cost}}.',
      'It is now with {{nowWith}}. This leave is not agreed yet, so do not book anything on it.',
      `The {{days}} are being held while it is decided. ${TO_BOOK}`,
      'You will hear again the moment anything happens to it.',
    ),
  },

  STAGE_APPROVED: {
    subject: '{{DecidedBy}} approved your {{typeName}} — it still needs {{nowWith}}',
    body: body(
      '{{DecidedBy}} has approved your request for {{cost}}.',
      'It is not agreed yet, so do not book anything on it. It has gone on to {{nowWith}}.',
      '{{comment}}',
      `Your balance has not moved — the {{days}} are still being held while it is decided. ${TO_BOOK}`,
    ),
  },

  APPROVED: {
    subject: 'Your {{typeName}} for {{period}} is approved',
    body: body(
      'Your request for {{cost}} is approved.',
      'Every approver has said yes — {{decidedBy}} was the last — so this leave is agreed and is yours to take.',
      '{{comment}}',
      `The {{days}} have come off your balance. ${TO_BOOK}`,
    ),
  },

  /* FR 44, LMS 318. Turned down, and not over. */
  STAGE_REFUSED: {
    subject: '{{DecidedBy}} turned down your {{typeName}} — it has gone to {{nowWith}}',
    body: body(
      '{{DecidedBy}} has turned down your request for {{cost}}.',
      'That is not the end of it. Every stage decides, and it has gone on to {{nowWith}}, who will make the final call.',
      '{{comment}}',
      `Your balance has not moved — the {{days}} are still being held while it is decided. ${TO_BOOK}`,
    ),
  },

  REFUSED: {
    subject: 'Your {{typeName}} for {{period}} was turned down',
    body: body(
      'Your request for {{cost}} has been turned down at {{decidedByPossessive}} stage.',
      '{{comment}}',
      `The {{days}} are back in your balance. ${TO_BOOK}`,
      'Nothing is blocking those dates now, so if you still need the time off you can ask for it again — for the same days or for different ones.',
    ),
  },

  /* FR 44, §7.2, LMS 318. To the manager who was overturned. */
  DECISION_OVERTURNED: {
    subject: '{{decidedBy}} overturned your decision on {{employeeNamePossessive}} {{typeName}}',
    body: body(
      'You {{theirDecision}} {{employeeNamePossessive}} request for {{cost}}, and {{decidedBy}} has decided otherwise. The leave is {{finalDecision}}.',
      '{{comment}}',
      'This is a record of a decision, not a question. If you think it was made on the wrong facts, speak to HR — the reason above and your own are both on the request for good.',
    ),
  },

  /* FR 48b, §8.6a, LMS 320. */
  UNROUTABLE: {
    subject: 'Your {{typeName}} for {{period}} has nobody who can decide it',
    body: body(
      'Your request for {{cost}} has stopped: there is no approver left who could decide it, so nobody has approved or turned it down.',
      '{{comment}}',
      `Nothing is wrong with the request and nobody has judged it. The {{days}} are still held while this is sorted out. ${TO_BOOK}`,
      'HR has been told and will put it back to an approver. If you no longer need the time off, withdraw it.',
    ),
  },

  UNROUTABLE_FOR_HR: {
    subject: '{{employeeNamePossessive}} {{typeName}} for {{period}} has nobody who can decide it',
    body: body(
      '{{employeeName}} asked for {{cost}}, and the approval chain for it has run out of people who could decide it. The request has not been approved and has not been turned down.',
      '{{comment}}',
      'Their {{days}} are still held, so this is not costing them anything yet — but nothing will happen to it until somebody can be asked.',
      'Once there is, send the request back to its approvers. Nobody may decide their own leave, whatever roles they hold. FR 48b.',
    ),
  },

  /* FR 07, §8.4, LMS 325. */
  REASSIGNED: {
    subject: '{{employeeNamePossessive}} {{typeName}} for {{period}} is now yours to decide',
    body: body(
      '{{employeeName}} asked for {{cost}}, and you are now their manager, so the request is waiting on you.',
      '{{comment}}',
      'Nothing has been decided at your stage. Any approval an earlier stage has already given stands, in the name of whoever gave it.',
      'Their {{days}} are held while it is decided, so an answer either way is worth having soon.',
    ),
  },

  /* FR 47, LMS 324. HR's copy. */
  WITHDRAWAL_ASKED: {
    subject:
      '{{employeeNamePossessive}} {{typeName}} for {{period}} — they have asked for it to be taken off the books',
    body: body(
      '{{employeeName}} has asked for their agreed leave — {{cost}} — to be taken off the books. It was approved, so the {{days}} are already out of their balance.',
      '{{comment}}',
      'If the leave has not started, agreeing puts all {{days}} back. If it has, what is left of it comes back and the days already taken stay taken — which needs a reason in writing, because they are being told some of their leave is spent.',
      'Nobody answers their own ask, whatever roles they hold.',
    ),
  },

  WITHDRAWAL_GRANTED: {
    subject: 'Your {{typeName}} for {{period}} has been taken off the books',
    body: body(
      'HR has agreed to take your request for {{cost}} off the books. It had not started, so all of it comes back.',
      '{{comment}}',
      `The {{days}} are back in your balance. ${TO_BOOK}`,
      'Nothing is blocking those dates now, so you can ask for them again — or for different ones — if you change your mind.',
    ),
  },

  LEAVE_AMENDED: {
    subject: 'Your {{typeName}} for {{period}} has been amended',
    body: body(
      'HR has agreed to take back what was left of your leave. It had already started, so it stays on the record as {{cost}} — the days you were away for are days you took.',
      '{{comment}}',
      `Of that, {{daysBack}} had not been taken, and {{thoseDaysAre}} back in your balance. ${TO_BOOK}`,
      'If you think the split is wrong, speak to HR — the dates and the reason above are both on the request for good.',
    ),
  },

  WITHDRAWAL_REFUSED: {
    subject: 'Your {{typeName}} for {{period}} still stands',
    body: body(
      'You asked for your request for {{cost}} to be taken off the books, and HR has not agreed.',
      '{{comment}}',
      `Your balance has not moved — the {{days}} stay taken and this leave is still yours. ${TO_BOOK}`,
      'If circumstances change again, ask again: the ask above and this answer are both on the record.',
    ),
  },

  WITHDRAWN: {
    subject: 'Your {{typeName}} for {{period}} has been taken back',
    body: body(
      'The request for {{cost}} has been withdrawn, and nobody has to approve anything for that to take effect.',
      `The {{days}} are back in your balance. ${TO_BOOK}`,
      'If this was not you, it was HR taking it back on your behalf. Ask them why.',
    ),
  },

  CANCELLED: {
    subject: 'Your {{typeName}} for {{period}} has been cancelled',
    body: body(
      'The request for {{cost}} has been cancelled by HR.',
      'A cancellation is HR taking a record off the books — leave entered twice, or against the wrong person, or in the wrong year. It is not a decision about whether you may have the time off, and nobody has turned anything down.',
      `The {{days}} are back in your balance. ${TO_BOOK}`,
      'If you were expecting this leave to happen, speak to HR.',
    ),
  },

  /* FR 50, FR 60, LMS 330. To the approver, about nothing having happened. */
  STILL_WAITING: {
    subject: '{{employeeNamePossessive}} {{typeName}} for {{period}} is still waiting on you',
    body: body(
      '{{whenAsked}}',
      '{{whenItStarts}}',
      'Nothing has been decided at your stage. Their {{days}} are held while it waits, so they are days nobody can book anything else on.',
      'This is a reminder and nothing else: it approves nothing and turns nothing down. Approve it or turn it down and it stops; until then you will hear from me every day.',
    ),
  },

  /* FR 32c, §8.6c, LMS 507. */
  LEAVE_RECLASSIFIED: {
    subject:
      '{{daysBack}} of your {{typeName}} for {{period}} {{isOrAre}} now {{movedIntoTypeName}}',
    body: body(
      '{{daysBack}} of your {{cost}} have been recorded as {{movedIntoTypeName}} on your medical certificate.',
      `The {{daysBack}} are back in your {{typeName}} balance. ${TO_BOOK}`,
      '{{movedIntoBalance}}',
      'The rest of this leave stands exactly as it was booked. Nothing has been moved to later dates: if you want those days back as time off, ask for them.',
    ),
  },

  /* FR 25, §8.8, LMS 508. */
  LEAVE_RECALCULATED: {
    subject: '{{daysBack}} of your {{typeName}} for {{period}} {{hasOrHave}} been credited back',
    body: body(
      '{{declaredHoliday}}',
      'The country was not working that day, so you are not charged leave for it — even though the leave was already approved when the day was gazetted.',
      `The {{daysBack}} {{isOrAre}} back in your balance. ${TO_BOOK}`,
      'Your leave itself has not changed. The dates you booked are the dates you have, and nothing has been added to the end of it.',
    ),
  },
};

/** The longest subject line accepted. */
export const LONGEST_SUBJECT = 200;

/** The longest body accepted. */
export const LONGEST_BODY = 5000;

/** `{{name}}`, spaces inside the braces allowed. */
const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/** A blank line, which is what separates paragraphs. */
const PARAGRAPH_BREAK = /\n[ \t]*(?:\n[ \t]*)+/;

/** Wording HR sent that could not be saved, and the field it was in. FR 61. */
export class InvalidWording extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidWording';
    this.field = field;
  }
}

/** An email the system does not send. */
export class EmailNotFound extends Error {
  constructor(name: string) {
    super(`The system sends no email called ${name}.`);
    this.name = 'EmailNotFound';
  }
}

/** The email a caller named, or a refusal. */
export function readEmailName(value: unknown): EmailName {
  if (typeof value !== 'string' || !(EMAILS as readonly string[]).includes(value)) {
    throw new EmailNotFound(String(value));
  }

  return value as EmailName;
}

/** The placeholders one email can use, in the order they are listed. */
export function placeholdersOffered(name: EmailName): Placeholder[] {
  const original = ORIGINAL_WORDING[name];
  const used = new Set([...namesIn(original.subject), ...namesIn(original.body)].map(lowerFirst));

  return (Object.keys(PLACEHOLDER_MEANINGS) as Placeholder[]).filter(
    (placeholder) => ALWAYS_OFFERED.includes(placeholder) || used.has(placeholder),
  );
}

/**
 * The wording with every placeholder filled in.
 *
 * A paragraph left empty is dropped, so `{{comment}}` with nothing said leaves no gap.
 * `{{DecidedBy}}` is `{{decidedBy}}` starting a sentence.
 */
export function fillIn(wording: Wording, values: PlaceholderValues): Wording {
  return {
    subject: fill(wording.subject, values).replace(/\s+/g, ' ').trim(),
    body: wording.body
      .replace(/\r\n?/g, '\n')
      .split(PARAGRAPH_BREAK)
      .map((paragraph) => fill(paragraph, values))
      .filter((paragraph) => paragraph.trim() !== '')
      .join('\n\n'),
  };
}

/** Checks and tidies HR's wording for one email. FR 61, LMS 512. */
export function validateWording(
  name: EmailName,
  input: { subject?: unknown; body?: unknown },
): Wording {
  const subject = requireText('subject', input.subject, LONGEST_SUBJECT);
  const body = requireText('body', input.body, LONGEST_BODY).replace(/\r\n?/g, '\n');

  if (subject.includes('\n')) {
    throw new InvalidWording('subject', 'A subject line is one line.');
  }

  const offered = placeholdersOffered(name);

  requireKnownPlaceholders('subject', subject, offered);
  requireKnownPlaceholders('body', body, offered);

  return { subject, body };
}

function requireText(field: 'subject' | 'body', value: unknown, longest: number): string {
  const text = typeof value === 'string' ? value.trim() : '';

  if (text === '') {
    throw new InvalidWording(
      field,
      field === 'subject' ? 'An email needs a subject line.' : 'An email needs a message.',
    );
  }

  if (text.length > longest) {
    throw new InvalidWording(
      field,
      `The ${field === 'subject' ? 'subject line' : 'message'} is ${String(text.length)} characters, and the longest accepted is ${String(longest)}.`,
    );
  }

  return text;
}

function requireKnownPlaceholders(
  field: 'subject' | 'body',
  text: string,
  offered: readonly Placeholder[],
): void {
  const unknown = namesIn(text).find(
    (named) => !offered.includes(lowerFirst(named) as Placeholder),
  );

  if (unknown !== undefined) {
    throw new InvalidWording(
      field,
      `{{${unknown}}} is not something this email can fill in. It can use ` +
        `${offered.map((one) => `{{${one}}}`).join(', ')}.`,
    );
  }

  const leftOver = text.replace(PLACEHOLDER, '');

  if (leftOver.includes('{{') || leftOver.includes('}}')) {
    throw new InvalidWording(
      field,
      'A placeholder is a name inside double braces, like {{firstName}}. One of the braces here is not part of one.',
    );
  }
}

function fill(text: string, values: PlaceholderValues): string {
  return text.replace(PLACEHOLDER, (whole, named: string) => valueOf(named, values) ?? whole);
}

/** The value, capitalised where the placeholder was. */
function valueOf(named: string, values: PlaceholderValues): string | undefined {
  const placeholder = lowerFirst(named) as Placeholder;
  const value = Object.hasOwn(values, placeholder) ? values[placeholder] : undefined;

  if (value === undefined || placeholder === named) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function namesIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

function lowerFirst(named: string): string {
  return named.charAt(0).toLowerCase() + named.slice(1);
}
