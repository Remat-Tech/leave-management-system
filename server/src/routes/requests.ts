/**
 * The request history screen, over HTTP. FR 54. LMS 402.
 *
 * One route. It reads an optional year out of the query string, asks
 * {@link RequestHistoryService} and serialises what comes back — no rule, no ordering and no
 * decision about what a trail contains, all of which are ../domain/request-history.ts's.
 *
 * The second route this application has, and it is deliberately the same shape as the first.
 * ./balances.ts is worth reading beside it: everything that file says about `me`, about
 * refusals being left to ./problems.ts and about dates going out as they are held is true
 * here for the same reasons and is not restated.
 *
 * ## Whose history, and why there is no id in the path
 *
 * `GET /api/me/requests`, and the id handed to the service is `actor.employeeId` — taken from
 * the session cookie, which ./identify.ts verified. **There is no way to ask this route about
 * anybody else**, whatever is sent.
 *
 * FR 55 and FR 56 — a manager's view of a report's leave, HR's view of anybody's — are LMS 405
 * and are a different route with a different rule about who the subject may be.
 * `leaveRequestPolicy.read` already admits both and the service already takes an employee id
 * for them; what is deliberately not here is the *route*, because "a manager may see their
 * direct reports" is a decision that should be made once, in the open, by the story that owns
 * it rather than inherited by a query parameter somebody added to this one.
 *
 * ## Everything the screen shows is on the wire, the sentences included
 *
 * The status in words, the trail's sentence per step, the approval progress in one line, the
 * counting basis as a label. None of them is a mapping a browser makes for itself, for the
 * reason ../domain/balance-statement.ts gives about `countingBasisLabel`: a second place
 * deciding what `REFUSED` is called is a second place that can call it something else.
 *
 * The `kind` on a trail step is the one machine-readable field there, and it is there so a
 * screen can give the four shapes different treatments — not so it can compose the words
 * again.
 */

import { type Request, type Response, Router } from 'express';
import type { LeaveYear } from '../domain/leave-year.js';
import type { RequestHistory, RequestHistoryEntry, TrailStep } from '../domain/request-history.js';
import type { RequestHistoryService } from '../services/request-history-service.js';
import { actorOf } from './identify.js';

export interface RequestRoutes {
  history: RequestHistoryService;
}

export function requestRoutes({ history }: RequestRoutes): Router {
  const routes = Router();

  /**
   * Every request I have made, newest first, with what became of each.
   *
   * `leaveYearId` is optional and its absence means *everything* rather than "this year" —
   * see `HistoryOptions`, which argues why the default here is the opposite of the balance
   * screen's. So no clock is consulted, and there is no year for the server to pick.
   *
   * Refusals are left to ./problems.ts: a year that is nobody's is 404. A real year this
   * person has no requests in is not a refusal at all — it is an empty list, which is the
   * true answer.
   */
  routes.get('/me/requests', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    /* Unreachable: `identify` only ever builds an actor from an employee record it has just
       read, and `theSystem()` — the one actor with a null id — is never minted by a route.
       Answered rather than asserted, because the alternative is asking the service for the
       leave of employee `null`. */
    if (actor.employeeId === null) {
      next(new Error('This route was reached by an actor with no employee behind it.'));
      return;
    }

    void history
      .forEmployee(actor, actor.employeeId, { leaveYearId: oneYearIn(request) })
      .then((found) => {
        response.json(asJson(found));
      })
      .catch(next);
  });

  return routes;
}

/**
 * The leave year asked for, where one string was asked for.
 *
 * The same reading ./balances.ts makes, and the same refusal by omission: Express hands back
 * `string | string[] | undefined` for a repeated parameter, and `?leaveYearId=1&leaveYearId=2`
 * is a caller asking two questions. Ignored rather than answered with a 400, because the
 * answer to "which of these two years" is the ordinary default — which here is every request
 * there is, and is certainly not an error page about a query string.
 */
function oneYearIn(request: Request): string | undefined {
  const value = request.query.leaveYearId;

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The history as JSON.
 *
 * Written out field by field rather than handed to `res.json(history)`, for the reason
 * ./balances.ts gives: a domain type is not a wire format, and the day somebody adds a field
 * to {@link RequestHistoryEntry} for an internal reason it would appear on the API without
 * anybody deciding it should. This is the list of what is published.
 */
function asJson(history: RequestHistory): unknown {
  return {
    employeeId: history.employeeId,
    year: history.year === null ? null : yearAsJson(history.year),
    years: history.years.map(yearAsJson),
    entries: history.entries.map(entryAsJson),
  };
}

/** A leave year. Both dates are calendar dates and are not touched. NFR DAT 03. */
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
    /* Ten characters in the column, ten on the wire. A leave period runs to a day rather
       than to an instant, and turning one into a `Date` on the way out is how the last day
       of somebody's holiday becomes the second to last in a browser west of Greenwich. */
    from: entry.from,
    to: entry.to,
    reason: entry.reason,
    countingBasis: entry.countingBasis,
    countingBasisLabel: entry.countingBasisLabel,
    days: entry.days,
    calendarDays: entry.calendarDays,
    status: entry.status,
    statusInWords: entry.statusInWords,
    /* An instant, and one of the three things here that are. ISO 8601 in UTC. */
    submittedAt: entry.submittedAt.toISOString(),

    /* FR 41. `agreed` is the field anybody acts on; the rest is the account of it. The
       chain and the desks are published as the three lists the domain keeps them as rather
       than as one merged one, because "signed" and "still to be asked" are what a screen
       arranges differently. */
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
    /* FR 39. The approver's own words, verbatim. Never trimmed to a length here — a
       refusal shortened on the way out is a refusal the person cannot act on, and the
       column is the only account of that decision that will exist next year. */
    comment: step.comment,
    by: step.by,
    at: step.at === null ? null : step.at.toISOString(),
    inWords: step.inWords,
  };
}
