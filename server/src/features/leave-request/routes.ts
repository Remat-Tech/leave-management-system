/** The request screens, over HTTP. FR 54, LMS 402, LMS 403, LMS 404, FR 10, FR 11, FR 13, FR 20, FR 55, FR 56, LMS 405. */

import { type Request, type Response, Router } from 'express';
import type { LeaveYear } from '../leave-year/leave-year.js';
import { type FreeDay, freeDayInWords } from '../leave-calculator/leave-calculator.js';
import type {
  ApproverQueue,
  AskerBalance,
  QueueItem,
  QueueWarning,
  TeamAway,
  TeamContext,
} from './approver-queue.js';
import type { FormRule, RequestableLeaveType, RequestForm } from './request-form.js';
import type { LeaveRequestQuote, RequestWarning } from './leave-request.js';
import type { LeaveRequested } from '../balance/balance.service.js';
import type { RequestHistory, RequestHistoryEntry, TrailStep } from './request-history.js';
import type { ApproverQueueService } from './approver-queue.service.js';
import type { LeaveRequestService } from './leave-request.service.js';
import type { RequestFormService } from './request-form.service.js';
import type { RequestHistoryService } from './request-history.service.js';
import { actorOf } from '../../http/identify.js';

export interface RequestRoutes {
  history: RequestHistoryService;
  /** LMS 403. What each kind of leave asks of somebody, before any dates. */
  form: RequestFormService;
  /** LMS 403, LMS 301. What a period would cost, and the one door that writes a request. */
  requests: LeaveRequestService;
  /** LMS 404. Everything waiting on me. */
  queue: ApproverQueueService;
}

export function requestRoutes({ history, form, requests, queue }: RequestRoutes): Router {
  const routes = Router();

  /**
   * Everything waiting on me. FR 20, FR 40. LMS 404.
   *
   * `/me` here means the same as it does below — the id off the verified cookie — but it names
   * the *approver* rather than the person taking the leave, which is why this is the one route
   * in the file that hands back somebody else's requests. What bounds it is
   * `leaveRequestPolicy.queue` and the desks it establishes; there is no id to supply.
   */
  routes.get('/me/approvals', (_request: Request, response: Response, next) => {
    void queue
      .forApprover(actorOf(response))
      .then((waiting) => {
        response.json(queueAsJson(waiting));
      })
      .catch(next);
  });

  /** Every request I have made, newest first, with what became of each. */
  routes.get('/me/requests', (request: Request, response: Response, next) => {
    void history
      .forEmployee(actorOf(response), employeeIdOf(response), {
        leaveYearId: oneYearIn(request),
      })
      .then((found) => {
        response.json(historyAsJson(found));
      })
      .catch(next);
  });

  /**
   * The kinds of leave I may ask for, and what each of them asks of me. LMS 403.
   *
   * The whole of the story's second and third criteria, and a separate call from the quote
   * below rather than a field on it, because the two become answerable at different moments.
   * This one is answerable the instant the screen opens; a quote is not answerable until
   * somebody has chosen two dates. Folding the rules into the quote would give a form that
   * could not say maternity leave needs a certificate until after the fortnight had been
   * picked, which is precisely the "not after" the story is written about.
   */
  routes.get('/me/request-form', (_request: Request, response: Response, next) => {
    void form
      .forEmployee(actorOf(response), employeeIdOf(response))
      .then((found) => {
        response.json(formAsJson(found));
      })
      .catch(next);
  });

  /**
   * What this period would cost me, before anything is written. LMS 403's first criterion.
   *
   * **A GET, and the method is load bearing rather than a preference.** The service writes
   * nothing, reserves nothing, and is documented as safe to call on every keystroke that
   * changes a date — which is exactly what this route is for. A POST would say the opposite
   * to every proxy, every log and every developer reading the route table, and the first
   * person to see `POST /me/requests/quote` beside `POST /me/requests` would reasonably
   * wonder which of the two created something.
   *
   * `reason` is not a parameter. It is not an input to what a period costs — see
   * `LeaveRequestService.quote`, whose signature says so — and a form pricing a fortnight
   * while somebody is still typing would otherwise put a half-written sentence in a query
   * string and from there into an access log.
   *
   * Every refusal this can raise is a sentence the form shows beside the dates: a period that
   * costs nothing, one that crosses a year end, one over leave already booked. What stops
   * those arriving as a five hundred is ../../http/problems.ts.
   */
  routes.get('/me/requests/quote', (request: Request, response: Response, next) => {
    void requests
      .quote(actorOf(response), {
        employeeId: employeeIdOf(response),
        leaveTypeId: asString(request.query.leaveTypeId),
        from: asString(request.query.from),
        to: asString(request.query.to),
      })
      .then((quote) => {
        response.json(quoteAsJson(quote));
      })
      .catch(next);
  });

  /**
   * Asks for the leave. FR 10, LMS 301.
   *
   * 201, carrying the request that was written and the balance it left, because a screen
   * that has just submitted something has to say what happened: what it cost, and what is
   * left.
   *
   * The day count is not accepted and could not be. `LeaveRequestService.submit` counts the
   * period again inside the transaction that holds the days, and the reason it does is the
   * reason this route takes only the four fields somebody actually filled in: a caller that
   * can supply a figure can supply a smaller one.
   */
  routes.post('/me/requests', (request: Request, response: Response, next) => {
    const sent = bodyOf(request);

    void requests
      .submit(actorOf(response), {
        employeeId: employeeIdOf(response),
        leaveTypeId: asString(sent.leaveTypeId),
        from: asString(sent.from),
        to: asString(sent.to),
        reason: asString(sent.reason),
      })
      .then((submitted) => {
        response.status(201).json(submittedAsJson(submitted));
      })
      .catch(next);
  });

  return routes;
}

/**
 * Whose session this is. FR 55, FR 56.
 *
 * `me` means the same thing on all four routes above: the id off the verified cookie, never
 * anything a caller wrote down. There is no way to name somebody else, so those two
 * requirements are unreachable here by construction rather than by a guard being asked.
 *
 * Throws rather than answering, and the throw is unreachable: `identify` puts an actor on
 * every response behind it, and an actor with no employee is a service account, which has no
 * business on a route called `/me`. Express hands a synchronous throw from a handler to
 * ../../http/problems.ts, which logs it and answers a five hundred — which is the right
 * answer, because that state is a wiring mistake rather than anything the caller did.
 */
function employeeIdOf(response: Response): string {
  const actor = actorOf(response);

  if (actor.employeeId === null) {
    throw new Error('This route was reached by an actor with no employee behind it.');
  }

  return actor.employeeId;
}

/** The leave year asked for, where one string was asked for. */
function oneYearIn(request: Request): string | undefined {
  const value = request.query.leaveYearId;

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * One string from whatever arrived, and the empty string for anything else.
 *
 * A query value can be an array or an object — `?from=a&from=b`, `?from[x]=y` — and a JSON
 * body can hold anything at all. Coerced here rather than validated, deliberately: the domain
 * already refuses an empty id, an empty reason and a date that is not a date, each with the
 * sentence NFR USA 03 asks for and each naming the field a form puts it beside. A second set
 * of checks here would be a second set of messages, and they would disagree eventually. All
 * this guarantees is that the domain is handed a string to refuse.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The parsed body, where something object shaped arrived. */
function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/* ---------------------------------------------------------------- the queue, as JSON */

function queueAsJson(queue: ApproverQueue): unknown {
  return {
    approverId: queue.approverId,
    /** FR 38a. Which desks these came from, so a screen can say which hat is being worn. */
    desks: [...queue.desks],
    inWords: queue.inWords,
    items: queue.items.map(queueItemAsJson),
  };
}

function queueItemAsJson(item: QueueItem): unknown {
  return {
    requestId: item.requestId,
    asker: {
      employeeId: item.asker.employeeId,
      name: item.asker.name,
      jobTitle: item.asker.jobTitle,
    },
    leaveTypeId: item.leaveTypeId,
    typeName: item.typeName,
    leaveYearId: item.leaveYearId,
    /** Ten characters, each way. NFR DAT 03. */
    from: item.from,
    to: item.to,
    reason: item.reason,
    /** FR 11. Read off the request, never off the type. */
    countingBasis: item.countingBasis,
    countingBasisLabel: item.countingBasisLabel,
    /** FR 24. */
    days: item.days,
    calendarDays: item.calendarDays,
    submittedAt: item.submittedAt.toISOString(),

    /** FR 38a, FR 41. */
    desk: item.desk,
    chain: [...item.chain],
    approvedBy: [...item.approvedBy],
    stillToApprove: [...item.stillToApprove],
    stageInWords: item.stageInWords,

    /** FR 17, FR 18. The figures as well as the sentences; a screen sorts on a number. */
    noticeGivenDays: item.noticeGivenDays,
    shortNoticeBy: item.shortNoticeBy,
    backdatedBy: item.backdatedBy,
    startsInDays: item.startsInDays,
    warnings: item.warnings.map(queueWarningAsJson),

    balance: balanceAsJson(item.balance),
    team: teamAsJson(item.team),

    /** FR 48, §8.6a. */
    actionable: item.actionable,
    notActionableBecause: item.notActionableBecause,
  };
}

function queueWarningAsJson(warning: QueueWarning): unknown {
  return { code: warning.code, inWords: warning.inWords };
}

function balanceAsJson(balance: AskerBalance): unknown {
  return {
    leaveTypeId: balance.leaveTypeId,
    leaveYearId: balance.leaveYearId,
    owed: balance.owed,
    taken: balance.taken,
    pending: balance.pending,
    /** May be negative, legitimately. §8.6b. */
    available: balance.available,
    inWords: balance.inWords,
  };
}

function teamAsJson(team: TeamContext): unknown {
  return { size: team.size, away: team.away.map(teamAwayAsJson), inWords: team.inWords };
}

function teamAwayAsJson(away: TeamAway): unknown {
  return {
    employeeId: away.employeeId,
    /** Null where this approver has no standing to be told it. */
    name: away.name,
    from: away.from,
    to: away.to,
    days: away.days,
    status: away.status,
    typeName: away.typeName,
  };
}

/* -------------------------------------------------------------- the history, as JSON */

function historyAsJson(history: RequestHistory): unknown {
  return {
    employeeId: history.employeeId,
    year: history.year === null ? null : yearAsJson(history.year),
    years: history.years.map(yearAsJson),
    entries: history.entries.map(entryAsJson),
  };
}

/** A leave year. NFR DAT 03. */
function yearAsJson(year: LeaveYear): unknown {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isClosed: year.isClosed,
  };
}

function entryAsJson(entry: RequestHistoryEntry): unknown {
  return {
    requestId: entry.requestId,
    leaveTypeId: entry.leaveTypeId,
    typeName: entry.typeName,
    leaveYearId: entry.leaveYearId,
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
    countingBasis: entry.countingBasis,
    countingBasisLabel: entry.countingBasisLabel,
    days: entry.days,
    calendarDays: entry.calendarDays,
    status: entry.status,
    statusInWords: entry.statusInWords,
    submittedAt: entry.submittedAt.toISOString(),

    /** FR 41. */
    agreed: entry.progress.agreed,
    awaiting: entry.progress.awaiting,
    chain: [...entry.progress.chain],
    approvedBy: [...entry.progress.approvedBy],
    stillToApprove: [...entry.progress.stillToApprove],
    stagesMissing: [...entry.progress.stagesMissing],
    progressInWords: entry.progress.inWords,

    trail: entry.trail.map(stepAsJson),
  };
}

function stepAsJson(step: TrailStep): unknown {
  return {
    kind: step.kind,
    desk: step.desk,
    /** FR 39. */
    comment: step.comment,
    by: step.by,
    at: step.at === null ? null : step.at.toISOString(),
    inWords: step.inWords,
  };
}

/* ----------------------------------------------------------------- the form, as JSON */

function formAsJson(form: RequestForm): unknown {
  return {
    employeeId: form.employeeId,
    types: form.types.map(leaveTypeAsJson),
  };
}

function leaveTypeAsJson(type: RequestableLeaveType): unknown {
  return {
    leaveTypeId: type.leaveTypeId,
    code: type.code,
    name: type.name,
    countingBasis: type.countingBasis,
    countingBasisLabel: type.countingBasisLabel,
    isPaid: type.isPaid,
    /** FR 17, FR 18. The figures as well as the sentences; a date input needs a number. */
    minNoticeCalendarDays: type.minNoticeCalendarDays,
    maxBackdateCalendarDays: type.maxBackdateCalendarDays,
    /** FR 13, FR 32a. What a client branches on, where `rules` is what it shows. */
    documentation: type.documentation,
    documentationAfterDays: type.documentationAfterDays,
    exceedableWithDocument: type.exceedableWithDocument,
    /** FR 38a. */
    approvedBy: type.approvedBy,
    rules: type.rules.map(ruleAsJson),
  };
}

function ruleAsJson(rule: FormRule): unknown {
  return { kind: rule.kind, inWords: rule.inWords, asks: rule.asks };
}

/* ---------------------------------------------------------------- the quote, as JSON */

function quoteAsJson(quote: LeaveRequestQuote): unknown {
  return {
    leaveTypeId: quote.leaveTypeId,
    leaveTypeName: quote.leaveTypeName,
    /** Ten characters, each way. NFR DAT 03. */
    from: quote.from,
    to: quote.to,
    /** FR 11. The basis this was counted under, and what submission would copy onto it. */
    countingBasis: quote.countingBasis,
    countingBasisInWords: quote.countingBasisInWords,
    /** FR 24. The story's first criterion. */
    days: quote.days,
    calendarDays: quote.calendarDays,
    /* What turns the number into an explanation: the days inside the period that cost
       nothing, and why each of them did. NFR USA 03. */
    free: quote.free.map(freeDayAsJson),
    availableNow: quote.availableNow,
    /** May be negative, legitimately. §8.6b. */
    availableAfter: quote.availableAfter,
    /** FR 38a. */
    approvedBy: quote.approvedBy,
    /** FR 13, FR 17, FR 14. Not refusals — the request may still go ahead. */
    warnings: quote.warnings.map(warningAsJson),
  };
}

function warningAsJson(warning: RequestWarning): unknown {
  return { code: warning.code, message: warning.message };
}

/**
 * One day inside the period that cost nothing. FR 22, FR 24.
 *
 * The token and the sentence both. A screen groups by `because` — every free day rendered
 * the same way is a list, and public holidays picked out of it are an answer — and shows
 * `inWords`, which is composed by the file that defines the reason rather than here.
 */
function freeDayAsJson(day: FreeDay): unknown {
  return {
    date: day.date,
    because: day.because,
    /** The holiday's name, where that is the reason. */
    name: day.name,
    inWords: freeDayInWords(day),
  };
}

/* ------------------------------------------------------- what was submitted, as JSON */

/** The request that was written, and the balance it left. LMS 301. */
function submittedAsJson(submitted: LeaveRequested): unknown {
  return {
    requestId: submitted.request.id,
    leaveTypeId: submitted.request.leaveTypeId,
    leaveYearId: submitted.request.leaveYearId,
    from: submitted.request.from,
    to: submitted.request.to,
    reason: submitted.request.reason,
    /** FR 11. Read off the request, never off the type — always. */
    countingBasis: submitted.request.countingBasis,
    days: submitted.request.days,
    calendarDays: submitted.request.calendarDays,
    status: submitted.request.status,
    /** FR 38a. The desk it is now sitting on. */
    awaitingApprovalFrom: submitted.request.awaitingApprovalFrom,
    submittedAt: submitted.request.submittedAt.toISOString(),
    /** What the RESERVATION left, so the screen can say what is left without asking again. */
    availableAfter: submitted.balance.available,
  };
}
