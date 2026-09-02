/** The request history screen, over HTTP. FR 54, LMS 402, FR 55, FR 56, LMS 405. */

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

  /** Every request I have made, newest first, with what became of each. */
  routes.get('/me/requests', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

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

/** The leave year asked for, where one string was asked for. */
function oneYearIn(request: Request): string | undefined {
  const value = request.query.leaveYearId;

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The history as JSON. */
function asJson(history: RequestHistory): unknown {
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
