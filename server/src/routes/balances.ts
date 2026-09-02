/** The balance screen, over HTTP. FR 53, LMS 401, FR 55, FR 56, LMS 405, LMS 402, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { BalanceStatement, BalanceStatementLine } from '../domain/balance-statement.js';
import type { LeaveYear } from '../domain/leave-year.js';
import type { BalanceStatementService } from '../services/balance-statement-service.js';
import { actorOf } from './identify.js';

export interface BalanceRoutes {
  statements: BalanceStatementService;
}

export function balanceRoutes({ statements }: BalanceRoutes): Router {
  const routes = Router();

  /** My balances for one leave year, with the years I may switch to. */
  routes.get('/me/balances', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    if (actor.employeeId === null) {
      next(new Error('This route was reached by an actor with no employee behind it.'));
      return;
    }

    void statements
      .forEmployee(actor, actor.employeeId, { leaveYearId: oneYearIn(request) })
      .then((statement) => {
        response.json(asJson(statement));
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

/** The statement as JSON. */
function asJson(statement: BalanceStatement): unknown {
  return {
    employeeId: statement.employeeId,
    year: yearAsJson(statement.year),
    years: statement.years.map(yearAsJson),
    lines: statement.lines.map(lineAsJson),
  };
}

/** A leave year. */
function yearAsJson(year: LeaveYear): unknown {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isClosed: year.isClosed,
  };
}

function lineAsJson(line: BalanceStatementLine): unknown {
  return {
    leaveTypeId: line.leaveTypeId,
    code: line.code,
    name: line.name,
    countingBasis: line.countingBasis,
    countingBasisLabel: line.countingBasisLabel,
    entitlementBasis: line.entitlementBasis,
    allowanceInWords: line.allowanceInWords,
    unit: line.unit,
    isPaid: line.isPaid,
    stillOffered: line.stillOffered,

    entitled: line.entitled,
    carriedOver: line.carriedOver,
    adjustment: line.adjustment,
    taken: line.taken,
    pending: line.pending,
    owed: line.owed,
    available: line.available,

    hasMoved: line.hasMoved,
    /** An instant, and the only thing here that is. NFR DAT 03. */
    updatedAt: line.updatedAt === null ? null : line.updatedAt.toISOString(),
  };
}
