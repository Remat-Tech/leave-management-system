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

/** Where a request has got to. §6.. */
export type RequestStatus = 'SUBMITTED' | 'APPROVED' | 'WITHDRAWN' | 'CANCELLED' | 'REFUSED';

/** What kind of thing one step of a trail is. */
export type TrailStepKind = 'ASKED' | 'DECIDED' | 'ENDED' | 'STILL_TO_ASK';

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
  reason: string;
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
  reason: string;
  countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS';
  days: number;
  calendarDays: number;
  status: RequestStatus;
  /** FR 38a. The desk it is now sitting on. */
  awaitingApprovalFrom: Desk | null;
  submittedAt: string;
  /** What the reservation left. */
  availableAfter: number;
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
 * Asks for the leave. FR 10.
 *
 * The day count is deliberately not among the arguments. The server counts the period
 * again inside the transaction that holds the days, and what it counts is what is charged
 * — a quote is not a promise, and a caller that could hand over a figure could hand over a
 * smaller one.
 */
export async function askForLeave(input: {
  leaveTypeId: string;
  from: string;
  to: string;
  reason: string;
}): Promise<Submitted> {
  return request<Submitted>('POST', '/api/me/requests', input);
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
