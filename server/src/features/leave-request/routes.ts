/** The request screens, over HTTP. FR 54, LMS 402, LMS 403, LMS 404, FR 10, FR 11, FR 13, FR 20, FR 55, FR 56, LMS 405. */

import { type Request, type Response, Router } from 'express';
import type { LeaveYear } from '../leave-year/leave-year.js';
import { type FreeDay, freeDayInWords } from '../leave-calculator/leave-calculator.js';
import type {
  ApproverQueue,
  AskerBalance,
  ManagersDecision,
  QueueItem,
  QueueWarning,
  TeamAway,
  TeamContext,
} from './approver-queue.js';
import type { FormRule, RequestableLeaveType, RequestForm } from './request-form.js';
import { OVERRIDING_ACTIONS, type OverridingAction } from './leave-decision.js';
import {
  InvalidLeaveRequest,
  type LeaveRequestQuote,
  type RequestWarning,
} from './leave-request.js';
import type {
  LeaveApproved,
  LeaveRequested,
  WithdrawalAnswered,
  WithdrawalAsked,
} from '../balance/balance.service.js';
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

  /**
   * What a line manager turned down that is now waiting on me. FR 44, §7.2. LMS 318.
   *
   * The dedicated view of the story's first criterion, and the same rows as `/me/approvals`
   * narrowed to the ones a manager said no to. Bounded by the same `leaveRequestPolicy.queue`
   * — there is no id to supply and nothing here that is not already at this person's desk.
   */
  routes.get('/me/approvals/rejections', (_request: Request, response: Response, next) => {
    void queue
      .rejectionsFor(actorOf(response))
      .then((waiting) => {
        response.json(queueAsJson(waiting));
      })
      .catch(next);
  });

  /**
   * Says yes at the desk this request is sitting on. FR 38, FR 38a, FR 40. LMS 314.
   *
   * A comment is optional here and required of everything below it, which is FR 39's
   * asymmetry: somebody whose leave is granted needs no explanation of the yes.
   */
  routes.post('/requests/:id/approve', (request: Request, response: Response, next) => {
    void requests
      .approve(actorOf(response), asString(request.params.id), asString(bodyOf(request).comment))
      .then((decided) => {
        response.json(decidedAsJson(decided));
      })
      .catch(next);
  });

  /**
   * Turns it down at that desk, and says why. FR 39, FR 42, FR 44. LMS 315, LMS 318.
   *
   * Not an ending in itself since LMS 318: a rejection at a stage that is not the last sends
   * the request on to the next desk with the days still held.
   */
  routes.post('/requests/:id/refuse', (request: Request, response: Response, next) => {
    void requests
      .refuse(actorOf(response), asString(request.params.id), asString(bodyOf(request).comment))
      .then((decided) => {
        response.json(decidedAsJson(decided));
      })
      .catch(next);
  });

  /**
   * Overturns the line manager's decision. FR 44, §7.2. LMS 318.
   *
   * Two verbs at one address, because they are one act with a direction: `OVERTURN_REJECTION`
   * lets leave a manager refused stand, `OVERTURN_APPROVAL` stops leave they agreed to. Which
   * of the two is legitimate on this request is the domain's to say — `NothingToOverturn`
   * refuses one that contradicts nobody — so the route passes the verb through rather than
   * deciding it, exactly as it passes the day count through nowhere at all.
   *
   * The justification is mandatory and is refused before anything is read.
   */
  routes.post('/requests/:id/override', (request: Request, response: Response, next) => {
    const sent = bodyOf(request);

    void requests
      .override(
        actorOf(response),
        asString(request.params.id),
        readOverride(sent.action),
        asString(sent.justification),
      )
      .then((decided) => {
        response.json(decidedAsJson(decided));
      })
      .catch(next);
  });

  /**
   * Sends a request nobody could decide back into its chain. FR 48b, §8.6a. LMS 320.
   *
   * HR's, and deliberately not a decision: it says nothing about the leave, and the request
   * comes back waiting on whichever desk can now be asked.
   */
  routes.post('/requests/:id/route', (request: Request, response: Response, next) => {
    void requests
      .route(actorOf(response), asString(request.params.id))
      .then((rerouted) => {
        response.json({
          requestId: rerouted.request.id,
          status: rerouted.request.status,
          /** FR 38a. The desk it can now be asked at. */
          awaitingApprovalFrom: rerouted.request.awaitingApprovalFrom,
          balance: rerouted.balance,
        });
      })
      .catch(next);
  });

  /**
   * Asks for leave every desk has agreed to be taken off the books. FR 47. LMS 324.
   *
   * The person's own, and the reason is mandatory — it is what HR answers.
   */
  routes.post('/requests/:id/withdrawal', (request: Request, response: Response, next) => {
    void requests
      .askToWithdraw(
        actorOf(response),
        asString(request.params.id),
        asString(bodyOf(request).reason),
      )
      .then((asked) => {
        response.status(201).json(withdrawalAsJson(asked));
      })
      .catch(next);
  });

  /**
   * HR agreeing to it. FR 47. LMS 324.
   *
   * One address for both of the story's grants: whether this restores the whole request or
   * amends it to the days actually taken is the calendar's answer, not the caller's, so
   * there is no verb to pass. A reason is required only once the leave has started, which
   * `WithdrawalNeedsAReason` says with the field on it.
   */
  routes.post('/requests/:id/withdrawal/grant', (request: Request, response: Response, next) => {
    void requests
      .grantWithdrawal(
        actorOf(response),
        asString(request.params.id),
        asString(bodyOf(request).reason),
      )
      .then((answered) => {
        response.json(withdrawalAsJson(answered));
      })
      .catch(next);
  });

  /** HR turning it down, with the reason. FR 47, FR 39. LMS 324. */
  routes.post('/requests/:id/withdrawal/refuse', (request: Request, response: Response, next) => {
    void requests
      .refuseWithdrawal(
        actorOf(response),
        asString(request.params.id),
        asString(bodyOf(request).reason),
      )
      .then((answered) => {
        response.json(withdrawalAsJson(answered));
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

/**
 * Which way an override goes. FR 44, §7.2. LMS 318.
 *
 * The one place in this file that reads a value rather than coercing one, because there is no
 * domain function further down that takes a string: `LeaveRequestService.override` is typed on
 * {@link OverridingAction}, so an unrecognised verb has to be refused here or cast, and a cast
 * would let `{"action": "APPROVE"}` skip the justification the override exists to demand.
 */
function readOverride(value: unknown): OverridingAction {
  if (typeof value !== 'string' || !(OVERRIDING_ACTIONS as readonly string[]).includes(value)) {
    throw new InvalidLeaveRequest(
      'action',
      `An override either lets leave a line manager turned down stand, or stops leave they ` +
        `agreed to. Those are ${OVERRIDING_ACTIONS.join(' and ')}, and ${String(value)} is ` +
        `neither. FR 44.`,
    );
  }

  return value as OverridingAction;
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

    /** FR 44, §7.2. LMS 318. */
    managersDecision:
      item.managersDecision === null ? null : managersDecisionAsJson(item.managersDecision),
    /* Which of this desk's two verbs would be overturning the line manager, so a screen can
       ask for the justification before the button rather than after the refusal. */
    approvingIs: item.approvingIs,
    refusingIs: item.refusingIs,
  };
}

function managersDecisionAsJson(managers: ManagersDecision): unknown {
  return {
    said: managers.said,
    /** FR 39. The reason HR is weighing, in the manager's own words. */
    comment: managers.comment,
    by: managers.by,
    at: managers.at.toISOString(),
    inWords: managers.inWords,
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

/**
 * What one desk's decision did to the request. FR 38a, FR 39, FR 44. LMS 314, LMS 318.
 *
 * The decision itself as well as the request, because the two answer different questions: the
 * status says where the leave stands, and the decision says who decided it, what they said and
 * — since LMS 318 — which earlier decision it reversed.
 */
function decidedAsJson(decided: LeaveApproved): unknown {
  return {
    requestId: decided.request.id,
    status: decided.request.status,
    /** FR 38a. Null once there is nobody left to ask. */
    awaitingApprovalFrom: decided.request.awaitingApprovalFrom,
    decision: {
      action: decided.decision.action,
      /** FR 52. */
      onBehalfOf: decided.decision.onBehalfOf,
      /** FR 39, FR 44. */
      comment: decided.decision.comment,
      /** FR 44. The decision this one reversed, where it reversed one. */
      overridesDecisionId: decided.decision.overridesDecisionId,
      decidedBy: decided.decision.decidedBy,
      decidedAt: decided.decision.decidedAt.toISOString(),
    },
    /** Null where this decision was not the last word and no days moved. */
    entryId: decided.entry?.id ?? null,
    availableAfter: decided.balance.available,
  };
}

/** An ask to take agreed leave off the books, or the answer to one. FR 47. LMS 324. */
function withdrawalAsJson(answered: WithdrawalAsked | WithdrawalAnswered): unknown {
  return {
    requestId: answered.request.id,
    status: answered.request.status,
    withdrawal: {
      id: answered.withdrawal.id,
      action: answered.withdrawal.action,
      /** FR 47. */
      reason: answered.withdrawal.reason,
      /** The ask this answers, and null on an ask. */
      answersId: answered.withdrawal.answersId,
      recordedBy: answered.withdrawal.recordedBy,
      recordedAt: answered.withdrawal.recordedAt.toISOString(),
    },
    /** The RECALCULATION, where days came back. */
    entryId: 'entry' in answered ? (answered.entry?.id ?? null) : null,
    daysBack: 'entry' in answered ? (answered.entry?.days ?? 0) : 0,
    availableAfter: answered.balance.available,
  };
}

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
