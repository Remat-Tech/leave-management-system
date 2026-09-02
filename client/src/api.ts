/**
 * The one place this application talks to the server. LMS 401.
 *
 * Every type here is a description of what the API sends rather than a model of anything.
 * That distinction is the whole architecture of this client and it is worth stating
 * plainly, because the pressure to break it will arrive with the second screen:
 *
 * **Nothing in the browser computes a leave figure. Ever.**
 *
 * Not `available`, which is a subtraction over five columns and is
 * `rebuild_one_balance_from_the_ledger()`'s in the database, `available()` in
 * `server/src/domain/balance.ts`, and nowhere else. Not a day count, which is the
 * calculator's and depends on a working pattern and a public holiday calendar this
 * application does not have. Not which leave year today is in, which depends on a clock
 * and on rows only the server can see.
 *
 * The reason is not tidiness. A figure computed here is a second implementation of a rule,
 * running on a machine no test in this repository can reach, and the first sign that the
 * two disagree is somebody planning a fortnight around a number that was never true. The
 * server sends the answers; this renders them.
 *
 * So {@link BalanceLine} carries `available` and `owed` as fields, and there is no
 * function in this folder that adds anything up.
 *
 * ## Dates are strings and stay strings
 *
 * `startDate` and `endDate` are ten characters — `2026-12-31` — and are never given to
 * `new Date()`. A leave year runs to a day rather than to an instant, and turning one into
 * a `Date` in a browser is how the last day of the year becomes the second to last for
 * anybody west of Greenwich. There is no timezone conversion anywhere in this client, and
 * the only value here that is genuinely an instant is `updatedAt`.
 *
 * ## The session is a cookie, and this file never sees it
 *
 * `credentials: 'same-origin'` is on every call, which sends the `HttpOnly` cookie the
 * server set and which no script here can read — that is the point of `HttpOnly`. There is
 * no token in `localStorage`, no `Authorization` header, and nothing that identifies the
 * user in any request this file builds. Who somebody is is a question the server answers
 * from the cookie.
 */

/** A leave year, as the picker and the heading show it. */
export interface Year {
  id: string;
  label: string;
  /** Ten characters. Not an instant. See the module note. */
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
  /** FR 22. "Working days" or "Calendar days". The server writes it; this shows it. */
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
  /** May be negative. Sick leave goes below nought on purpose — §8.6b. */
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

/**
 * Who the session belongs to.
 *
 * A name and an id, and deliberately **no roles**. A client that knew what it held would
 * start deciding what to draw from it, and the day the two disagree the server is right
 * and the screen has been lying. What somebody may do is answered by asking for the thing.
 */
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

/**
 * A refusal the server wrote, carried rather than replaced.
 *
 * The message is the server's own sentence, and this client shows it verbatim. Every one
 * of them was written to say what is wrong *and what to do about it* — NFR USA 03 — and a
 * front end that substituted "Something went wrong" would throw away the only part of a
 * refusal that helps anybody.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Which input, where the server said. For putting the message beside it. */
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

/**
 * Who the session belongs to, or a 401 where there is no usable one.
 *
 * The browser cannot answer this for itself and that is deliberate: the session is an
 * `HttpOnly` cookie, so no script here can read it, and a flag kept in `localStorage`
 * beside it would be a second answer that goes stale the moment the cookie expires, the
 * account is closed, or the employment ends. Asking is the only honest way, and the reply
 * accounts for all three.
 */
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

/**
 * My balances, for one leave year or for the one the server picks.
 *
 * `leaveYearId` is left off on the first load on purpose. Which year is "this" one depends
 * on a clock and on which years this person was employed for, and both of those are the
 * server's — a browser that worked it out would disagree with the database on the first of
 * January for anybody not on UTC.
 */
export async function myBalances(leaveYearId?: string): Promise<Statement> {
  const query = leaveYearId === undefined ? '' : `?leaveYearId=${encodeURIComponent(leaveYearId)}`;

  return request<Statement>('GET', `/api/me/balances${query}`);
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
