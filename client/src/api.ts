/** The one place this application talks to the server. LMS 401. */

/** A leave year, as the picker and the heading show it. */
export interface Year {
  id: string;
  label: string;
  /** Ten characters. */
  startDate: string;
  endDate: string;
  isClosed: boolean;
}

/** One leave type's figures, with everything needed to render them beside them. */
export interface BalanceLine {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  /** FR 22. */
  countingBasisLabel: string;
  entitlementBasis: 'QUOTA' | 'EVENT';
  /** What the figures on this line are, so a nought says which kind of nought. */
  allowanceInWords: string;
  unit: 'DAYS' | 'WEEKS' | 'MONTHS';
  isPaid: boolean;
  stillOffered: boolean;

  entitled: number;
  carriedOver: number;
  adjustment: number;
  taken: number;
  pending: number;
  /** `entitled + carriedOver + adjustment`, computed on the server. */
  owed: number;
  /** May be negative. §8.6. */
  available: number;

  hasMoved: boolean;
  /** An instant, ISO 8601, or null where nothing has ever moved this balance. */
  updatedAt: string | null;
}

export interface Statement {
  employeeId: string;
  year: Year;
  years: Year[];
  lines: BalanceLine[];
}

/** ------------------------------------------------ my request history. FR 54, LMS 402. */

/** A desk in an approval chain — not a role somebody holds. */
export type Desk = 'MANAGER' | 'HR' | 'CEO';

/** Where a request has got to. §6., FR 48b. */
export type RequestStatus =
  | 'SUBMITTED'
  | 'APPROVED'
  /** Nobody could be found to decide it. FR 48b, LMS 320. */
  | 'UNROUTABLE'
  | 'WITHDRAWN'
  | 'CANCELLED'
  | 'REFUSED';

/** What kind of thing one step of a trail is. */
export type TrailStepKind =
  | 'ASKED'
  | 'DECIDED'
  /** A decision that reversed the line manager's. FR 44, LMS 318. */
  | 'OVERTURNED'
  | 'ENDED'
  /** An ask for agreed leave to come off the books, or HR's answer. FR 47, LMS 324. */
  | 'WITHDRAWAL'
  | 'STILL_TO_ASK';

/** One thing that happened to a request, or one thing that has not happened yet. */
export interface TrailStep {
  kind: TrailStepKind;
  /** The desk this step belongs to, where it belongs to one. */
  desk: Desk | null;
  /** FR 39. */
  comment: string | null;
  /** Who, in words, where a record names somebody. */
  by: string | null;
  /** An instant, ISO 8601 — or null for a step that has not happened. */
  at: string | null;
  /** The step in one sentence, written by the server. */
  inWords: string;
}

/** One past request, with what became of it. */
export interface RequestEntry {
  requestId: string;
  leaveTypeId: string;
  typeName: string;
  leaveYearId: string;
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 10. Null where the type asks for none. */
  reason: string | null;
  /** FR 18. Why HR put it on the record past the backdating window. Null on everything else. */
  lateEntryReason: string | null;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  /** FR 11, FR 24. */
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** The story's first criterion, in a word a person says. */
  statusInWords: string;
  submittedAt: string;

  /** FR 41. */
  agreed: boolean;
  /** The desk it is sitting on, or null once it is sitting nowhere. */
  awaiting: Desk | null;
  chain: Desk[];
  approvedBy: Desk[];
  stillToApprove: Desk[];
  /** Stages of today's chain with no approval on this request. */
  stagesMissing: Desk[];
  /** FR 41. */
  progressInWords: string;

  /** The story's second criterion. */
  trail: TrailStep[];
}

export interface History {
  employeeId: string;
  /** The year being shown, or null for every request there is. */
  year: Year | null;
  /** The years this person has asked for leave in. */
  years: Year[];
  entries: RequestEntry[];
}

/** ---------------------------------------------------- the request form. LMS 403. */

/**
 * What kind of thing one rule is.
 *
 * A token rather than a sentence, so the screen can group and order them without reading
 * the words. What each one *says* is composed on the server — see
 * `server/src/features/leave-request/request-form.ts`, which argues why the wording of a
 * leave rule is not a browser's to invent.
 */
export type FormRuleKind =
  | 'DESCRIPTION'
  | 'DOCUMENTATION'
  | 'EVIDENCE_IF_EXCEEDED'
  | 'NOTICE'
  | 'BACKDATING'
  | 'REASON'
  | 'ENTITLEMENT'
  | 'COUNTING'
  | 'APPROVAL';

/** One thing a kind of leave says about itself. */
export interface FormRule {
  kind: FormRuleKind;
  inWords: string;
  /** Whether it asks something of the person, rather than only explaining how the leave works. */
  asks: boolean;
}

/** A kind of leave this person may ask for, with what it asks of them. FR 05, FR 13, FR 17. */
export interface RequestableLeaveType {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  isPaid: boolean;
  /** FR 17, FR 18. Numbers, because a date input needs a number and not a sentence. */
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  /** FR 13, FR 32a. */
  documentation: 'NOT_REQUIRED' | 'ALWAYS' | 'AFTER_DAYS';
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  /** FR 10. Whether the reason box is required for this kind of leave. */
  reasonRequired: boolean;
  /** FR 38a. "your line manager, then HR". */
  approvedBy: string;
  rules: FormRule[];
}

export interface RequestForm {
  employeeId: string;
  /** In the order §7.4 puts them, which is the order the balance screen uses too. */
  types: RequestableLeaveType[];
}

/** Why a day inside a period cost nothing. */
export type FreeReason = 'NOT_A_WORKING_DAY' | 'PUBLIC_HOLIDAY';

/** One day inside the period that cost nothing. */
export interface FreeDay {
  /** Ten characters. */
  date: string;
  because: FreeReason;
  /** The holiday's name, where that is the reason. */
  name: string | null;
  /** The whole thing in a sentence, written by the server. */
  inWords: string;
}

/** FR 13, FR 17, FR 14. Worth saying before somebody submits, and not a refusal. */
export type QuoteWarningCode = 'SHORT_NOTICE' | 'DOCUMENTATION_REQUIRED' | 'NOT_ENOUGH_DAYS';

export interface QuoteWarning {
  code: QuoteWarningCode;
  message: string;
}

/** What a period would cost, before anything is written. FR 10, FR 11. */
export interface Quote {
  leaveTypeId: string;
  leaveTypeName: string;
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 11. The basis this was counted under, and what submitting would copy onto it. */
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisInWords: string;
  /** FR 24. The story's first criterion. */
  days: number;
  calendarDays: number;
  /** What turns the number into an explanation. */
  free: FreeDay[];
  availableNow: number;
  /** May be negative, legitimately. §8.6b. */
  availableAfter: number;
  /** FR 38a. */
  approvedBy: string;
  warnings: QuoteWarning[];
}

/** What came back from asking. LMS 301. */
export interface Submitted {
  requestId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: string;
  to: string;
  /** FR 10. Null where the type asks for none. */
  reason: string | null;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** FR 13, FR 32a. Whether documentation was asked of it, and so is on it. LMS 311. */
  evidenceRequired: boolean;
  /** FR 38a. The desk it is now sitting on. */
  awaitingApprovalFrom: Desk | null;
  submittedAt: string;
  /** What the reservation left. */
  availableAfter: number;
}

/** ------------------------------------------- everything waiting on me. FR 20, LMS 404. */

/** FR 17, FR 18. Worth pointing out before deciding, and not a refusal. */
export type QueueFlag = 'SHORT_NOTICE' | 'BACKDATED';

export interface QueueWarning {
  code: QueueFlag;
  inWords: string;
}

/** Who asked. FR 52. */
export interface Asker {
  employeeId: string;
  name: string;
  jobTitle: string | null;
}

/** What this request would spend, against what they have. §8.6. */
export interface AskerBalance {
  leaveTypeId: string;
  leaveYearId: string;
  owed: number;
  taken: number;
  /** Days held by requests still being decided — this one among them. */
  pending: number;
  /** What is left, this request's days already out of it. May be negative. §8.6b. */
  available: number;
  inWords: string;
}

/** One other person on the team who is away over the same days. */
export interface TeamAway {
  employeeId: string;
  /** Null where this approver has no standing to be told it. */
  name: string | null;
  /** Ten characters. */
  from: string;
  to: string;
  days: number;
  status: RequestStatus;
  typeName: string;
}

export interface TeamContext {
  /** How many report to the asker's line manager, the asker included. */
  size: number;
  away: TeamAway[];
  inWords: string;
}

/** One request waiting on me, with what the decision needs beside it. */
export interface QueueItem {
  requestId: string;
  asker: Asker;
  leaveTypeId: string;
  typeName: string;
  leaveYearId: string;
  /** Ten characters. */
  from: string;
  to: string;
  /** FR 10. Null where the type asks for none. */
  reason: string | null;
  /** FR 18. Why HR put it on the record past the backdating window. Null on everything else. */
  lateEntryReason: string | null;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  countingBasisLabel: string;
  /** FR 24. */
  days: number;
  calendarDays: number;
  submittedAt: string;

  /** FR 38a. The desk it is sitting on, which is one of mine. */
  desk: Desk;
  chain: Desk[];
  approvedBy: Desk[];
  stillToApprove: Desk[];
  /** FR 41, written by the server in the approver's voice rather than the requester's. */
  stageInWords: string;

  /** FR 17, FR 18. Numbers as well as sentences, because a screen sorts and colours on them. */
  noticeGivenDays: number;
  shortNoticeBy: number;
  backdatedBy: number;
  /** Calendar days from today to the first day off. Negative once it has started. */
  startsInDays: number;
  warnings: QueueWarning[];

  balance: AskerBalance;
  team: TeamContext;

  /** FR 48, §8.6a. False for my own request, whatever desk it is sitting at. */
  actionable: boolean;
  notActionableBecause: string | null;
}

export interface ApproverQueue {
  approverId: string;
  /** FR 38a. Which desks these came from. */
  desks: Desk[];
  inWords: string;
  /** Soonest to start first. */
  items: QueueItem[];
}

/** ---------------------------------------- requests I have not finished. FR 19, LMS 302. */

/** A field a draft may still be missing, in the order the form asks for them. */
export type DraftField = 'leaveTypeId' | 'from' | 'to' | 'reason';

/** What a draft still needs before it can be asked for. */
export interface DraftProgress {
  finished: boolean;
  missing: DraftField[];
  /** What is left, and that nothing is held yet, in one sentence. */
  inWords: string;
}

/**
 * A leave request started and not finished. FR 19.
 *
 * Every field is nullable, which is the story: somebody plans before the dates are settled.
 * Nothing is held and nobody has been asked until it is submitted.
 */
export interface Draft {
  draftId: string;
  leaveTypeId: string | null;
  /** Ten characters, or null. */
  from: string | null;
  to: string | null;
  reason: string | null;
  progress: DraftProgress;
  createdAt: string;
  /** What the list is ordered by. */
  updatedAt: string;
}

/** What a draft form sends. Any of them may be left out or cleared. */
export interface DraftFields {
  leaveTypeId?: string | null;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
}

/** Who the session belongs to. */
export interface Me {
  employeeId: string;
  firstName: string;
  lastName: string;
}

export interface SignedIn {
  employeeId: string;
  firstName: string;
  lastName: string;
}

/** The second factor was sent instead of a session being opened. LMS 110. */
export interface CodeSent {
  status: 'CODE_SENT';
  companyEmail: string;
  expiresAt: string;
}

/** A refusal the server wrote, carried rather than replaced. NFR USA 03. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Which input, where the server said. */
  readonly field?: string;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Whether a failure is "you are not signed in", which is a screen rather than an error. */
export function isNotSignedIn(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Who the session belongs to, or a 401 where there is no usable one. */
export async function currentSession(): Promise<Me> {
  return request<Me>('GET', '/api/me');
}

export async function signIn(email: string, password: string): Promise<SignedIn | CodeSent> {
  return request<SignedIn | CodeSent>('POST', '/api/session', { email, password });
}

export async function submitCode(email: string, code: string): Promise<SignedIn> {
  return request<SignedIn>('POST', '/api/session/code', { email, code });
}

export async function signOut(): Promise<void> {
  await request<void>('DELETE', '/api/session');
}

/** My balances, for one leave year or for the one the server picks. */
export async function myBalances(leaveYearId?: string): Promise<Statement> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<Statement>('GET', `/api/me/balances${query}`);
}

/**
 * Every request I have made, or only those in one leave year. FR 54. LMS 402.
 *
 * `leaveYearId` is left off by default and that means **everything**, which is the opposite
 * of what leaving it off means for {@link myBalances}. A balance is per leave year and cannot
 * be shown without one, so the server picks; a history is a list of things that happened, and
 * the story asks for all of them.
 *
 * So there is no year for a browser to work out here either, and nothing to hide behind a
 * filter the person did not set.
 */
export async function myRequests(leaveYearId?: string): Promise<History> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<History>('GET', `/api/me/requests${query}`);
}

/**
 * The kinds of leave I may ask for, and what each of them asks of me. LMS 403.
 *
 * Asked once, when the form opens. Nothing in it depends on what somebody types, which is
 * the whole point: the rule that maternity leave needs a certificate is true before a date
 * has been chosen, and a screen that waited for the dates would tell people too late.
 */
export async function requestForm(): Promise<RequestForm> {
  return request<RequestForm>('GET', '/api/me/request-form');
}

/**
 * What this period would cost, before anything is written. LMS 403's first criterion.
 *
 * A GET, because it is one: it writes nothing and reserves nothing, and is meant to be
 * called again every time a date changes.
 *
 * **The reason is not sent.** It is not an input to what a period costs — the server's
 * signature says so — and a form that put a half-written sentence in a query string on
 * every keystroke would be writing somebody's private explanation into an access log.
 */
export async function quoteLeave(input: {
  leaveTypeId: string;
  from: string;
  to: string;
}): Promise<Quote> {
  const query = new URLSearchParams({
    leaveTypeId: input.leaveTypeId,
    from: input.from,
    to: input.to,
  });

  return request<Quote>('GET', `/api/me/requests/quote?${query.toString()}`);
}

/**
 * Everything waiting on me. FR 20, FR 40. LMS 404.
 *
 * No parameters, and there is nothing to pass: the desks are established from the session, so
 * there is no id a browser could name and nothing to narrow by.
 *
 * Refused with a 403 and the server's own sentence for somebody who staffs no desk, and the
 * screen shows that sentence. There is deliberately no flag on `/api/me` to hide the tab in
 * advance: `integration/balances-api.test.ts` pins that route's fields precisely so nothing
 * like `canApprove` appears there, and the reason holds here — a client that decided what to
 * draw from its own standing would be a second answer to a question the server owns.
 */
export async function myApprovals(): Promise<ApproverQueue> {
  return request<ApproverQueue>('GET', '/api/me/approvals');
}

/**
 * Asks for the leave. FR 10.
 *
 * The day count is deliberately not among the arguments. The server counts the period
 * again inside the transaction that holds the days, and what it counts is what is charged
 * — a quote is not a promise, and a caller that could hand over a figure could hand over a
 * smaller one.
 *
 * `acknowledgesShortNotice` answers the quote's `SHORT_NOTICE` warning. FR 17, LMS 307. Sent
 * either way; whether one was owed is the server's to decide.
 *
 * `evidence` answers its `DOCUMENTATION_REQUIRED` one. FR 13, FR 32a, LMS 311. Ids from
 * {@link holdEvidence}, uploaded before this call, because a type that asks for documentation
 * refuses a request that arrives without it.
 */
export async function askForLeave(input: {
  leaveTypeId: string;
  from: string;
  to: string;
  /** FR 10. Sent as typed; whether nothing is allowed is the leave type's rule. */
  reason: string;
  acknowledgesShortNotice?: boolean;
  /** FR 13, FR 32a. Attachment ids, never files. LMS 311. */
  evidence?: string[];
}): Promise<Submitted> {
  return request<Submitted>('POST', '/api/me/requests', input);
}

/* ------------------------------------------------------- drafts. FR 19, LMS 302 */

/** Everything I have started and not finished, the one I last worked on first. */
export async function myDrafts(): Promise<{ drafts: Draft[] }> {
  return request<{ drafts: Draft[] }>('GET', '/api/me/request-drafts');
}

/**
 * Saves what I have filled in so far. FR 19.
 *
 * Every field is optional and nothing is held, so this is safe to call with a form that is
 * barely started. What comes back says what is still to fill in rather than refusing it.
 */
export async function saveDraft(fields: DraftFields): Promise<Draft> {
  return request<Draft>('POST', '/api/me/request-drafts', fields);
}

/**
 * Replaces what a draft holds. FR 19.
 *
 * A PUT, and the whole form is sent: a field somebody cleared has to arrive as cleared, and
 * leaving it out would mean "unchanged".
 */
export async function editDraft(draftId: string, fields: DraftFields): Promise<Draft> {
  return request<Draft>('PUT', `/api/me/request-drafts/${encodeURIComponent(draftId)}`, fields);
}

export async function discardDraft(draftId: string): Promise<void> {
  await request<void>('DELETE', `/api/me/request-drafts/${encodeURIComponent(draftId)}`);
}

/**
 * Finishes it: asks for the leave, and the draft goes away. FR 19, FR 10.
 *
 * The same answer {@link askForLeave} gives, and every refusal it can meet. A refused
 * submission leaves the draft exactly where it was.
 *
 * The acknowledgement is given here rather than saved on the draft: how short the notice is
 * depends on the day it is finished. FR 17, LMS 307.
 */
export async function submitDraft(
  draftId: string,
  acknowledgesShortNotice = false,
  /** FR 13, FR 32a, LMS 311. Given here for the same reason: a draft holds no files. */
  evidence: string[] = [],
): Promise<Submitted> {
  return request<Submitted>(
    'POST',
    `/api/me/request-drafts/${encodeURIComponent(draftId)}/submit`,
    { acknowledgesShortNotice, evidence },
  );
}

/* ---------------------------------------------- attachments. FR 12, LMS 310 */

/** NFR SEC 07. `PENDING` is a file nothing has checked; it counts as no evidence. */
export type ScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED';

/** FR 12. What the server accepts, as the bytes say it rather than as the name claims. */
export type AttachmentContentType =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface Attachment {
  attachmentId: string;
  /** FR 13. Null while the file is waiting for the request it will evidence. LMS 311. */
  leaveRequestId: string | null;
  /** FR 13. Whose evidence it is. LMS 311. */
  heldForEmployeeId: string;
  slot: number;
  filename: string;
  /** Sniffed server side. What this says may differ from what the file was called. */
  contentType: AttachmentContentType;
  sizeBytes: number;
  checksumSha256: string;
  scanStatus: ScanStatus;
  scanSignature: string | null;
  scannedBy: string | null;
  scannedAt: string | null;
  /** What to grey the download out on. */
  downloadable: boolean;
  uploadedBy: string | null;
  uploadedAt: string;
}

/** FR 13. Whether this leave's documentation rule is met by what is attached. */
export interface Evidence {
  required: boolean;
  satisfied: boolean;
  usable: number;
  attached: number;
  inWords: string;
}

export interface Attachments {
  leaveRequestId: string;
  attachments: Attachment[];
  evidence: Evidence;
}

/** FR 13. What has been uploaded and not yet asked for leave with. LMS 311. */
export interface EvidenceWaiting {
  employeeId: string;
  attachments: Attachment[];
  /** How many of them could stand as documentation. `PENDING` counts for nothing. */
  usable: number;
  inWords: string;
}

/** FR 12. Ten megabytes, five files. Shown on the form, enforced on the server. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 5;

export async function attachmentsOn(requestId: string): Promise<Attachments> {
  return request<Attachments>('GET', `/api/requests/${encodeURIComponent(requestId)}/attachments`);
}

/**
 * Attaches one file. FR 12.
 *
 * The body is the bytes and the name goes in a header, so a filename never reaches a
 * query string or an access log. The content type is sent for the record and is not what
 * the server decides on — it sniffs the bytes. NFR SEC 07.
 */
export async function attachToRequest(requestId: string, file: File): Promise<Attachment> {
  return upload(`/api/requests/${encodeURIComponent(requestId)}/attachments`, file);
}

/** The one shape both uploads have: bytes as the body, name in a header. FR 12. */
async function upload(path: string, file: File): Promise<Attachment> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': file.type === '' ? 'application/octet-stream' : file.type,
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
  });

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw errorFrom(response.status, payload);
  }

  return payload as Attachment;
}

/**
 * Uploads evidence ahead of the request it will go on. FR 13, FR 32a. LMS 311.
 *
 * The call a form makes *before* it submits, because a type that asks for documentation
 * refuses a request that arrives without it. The id that comes back is what
 * {@link submitRequest} names in `evidence`.
 */
export async function holdEvidence(file: File): Promise<Attachment> {
  return upload('/api/me/evidence', file);
}

/** What is waiting, and how much of it counts. FR 13, LMS 311. */
export async function evidenceWaiting(): Promise<EvidenceWaiting> {
  return request<EvidenceWaiting>('GET', '/api/me/evidence');
}

/** Throws away a waiting file. It is addressed by its own id; there is no request yet. */
export async function discardEvidence(attachmentId: string): Promise<void> {
  await request<void>('DELETE', `/api/evidence/${encodeURIComponent(attachmentId)}`);
}

/** Asks the scanner again about a waiting file it never answered for. NFR SEC 07, LMS 311. */
export async function rescanEvidence(attachmentId: string): Promise<Attachment> {
  return request<Attachment>('POST', `/api/evidence/${encodeURIComponent(attachmentId)}/scan`);
}

/** Where the browser fetches the bytes from. Refused unless the scan came back clean. */
export function attachmentHref(requestId: string, attachmentId: string): string {
  return (
    `/api/requests/${encodeURIComponent(requestId)}/attachments/` + encodeURIComponent(attachmentId)
  );
}

export async function removeAttachment(requestId: string, attachmentId: string): Promise<void> {
  await request<void>('DELETE', attachmentHref(requestId, attachmentId));
}

/** Asks the scanner again about a file it never answered for. NFR SEC 07. */
export async function rescanAttachment(
  requestId: string,
  attachmentId: string,
): Promise<Attachment> {
  return request<Attachment>('POST', `${attachmentHref(requestId, attachmentId)}/scan`);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    /* Sends the HttpOnly session cookie. Same-origin rather than include, because the API
       is proxied onto this origin — see client/vite.config.ts — and `include` would be
       asking for a cross-origin credentialed request that the server's SameSite=Strict
       cookie would refuse to be part of anyway. */
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw errorFrom(response.status, payload);
  }

  return payload as T;
}

/**
 * A refusal, from whatever the server sent.
 *
 * Defensive about the shape because a proxy, a load balancer or a crash can produce a
 * non-JSON body with a perfectly good status code, and a client that threw a
 * `TypeError: undefined is not an object` in that case would show a stack trace where a
 * sentence belongs.
 */
function errorFrom(status: number, payload: unknown): ApiError {
  const body =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

  return new ApiError(
    status,
    typeof body.error === 'string' ? body.error : 'Unexpected',
    typeof body.message === 'string'
      ? body.message
      : 'Something went wrong, and the server did not say what.',
    typeof body.field === 'string' ? body.field : undefined,
  );
}
