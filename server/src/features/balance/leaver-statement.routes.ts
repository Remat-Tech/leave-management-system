/** The leaver figure, over HTTP. FR 37a, §8.7, LMS 509, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { Leaver, LeaverStatementService } from './leaver-statement.service.js';
import type { LeaverSettlement, LeaverSettlementLine, SettlementStep } from './leaver-statement.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import { actorOf } from '../../http/identify.js';

export interface LeaverRoutes {
  leavers: LeaverStatementService;
}

export function leaverRoutes(parts: LeaverRoutes): Router {
  const routes = Router();

  /** Who has left. The picker, and nothing else. FR 06. */
  routes.get('/leavers', (_request: Request, response: Response, next) => {
    void parts.leavers
      .whoHasLeft(actorOf(response))
      .then((leavers) => {
        response.json({ leavers: leavers.map(leaverAsJson) });
      })
      .catch(next);
  });

  /** One leaver's figure, with the working behind it. FR 37a. */
  routes.get('/leavers/:employeeId', (request: Request, response: Response, next) => {
    void parts.leavers
      .forEmployee(actorOf(response), asString(request.params.employeeId))
      .then((settlement) => {
        response.json(settlementAsJson(settlement));
      })
      .catch(next);
  });

  return routes;
}

/** A field as it arrived, where a string was asked for. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function leaverAsJson(leaver: Leaver): unknown {
  return {
    id: leaver.id,
    name: leaver.name,
    employeeNumber: leaver.employeeNumber,
    jobTitle: leaver.jobTitle,
    /** A calendar date, ten characters from the column to the screen. NFR DAT 03. */
    exitDate: leaver.exitDate,
  };
}

function settlementAsJson(settlement: LeaverSettlement): unknown {
  return {
    employeeId: settlement.employeeId,
    employeeNumber: settlement.employeeNumber,
    name: settlement.name,
    jobTitle: settlement.jobTitle,
    startDate: settlement.startDate,
    exitDate: settlement.exitDate,
    year: yearAsJson(settlement.year),
    portion: { from: settlement.portion.from, to: settlement.portion.to },
    /** LMS 013. The figure says which rule produced it. */
    proRataRule: settlement.proRataRule,
    lines: settlement.lines.map(lineAsJson),
  };
}

function yearAsJson(year: LeaveYear): unknown {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    isClosed: year.isClosed,
  };
}

/** One kind of leave settled, every figure the server's. */
function lineAsJson(line: LeaverSettlementLine): unknown {
  return {
    leaveTypeId: line.leaveTypeId,
    code: line.code,
    name: line.name,
    countingBasis: line.countingBasis,
    countingBasisLabel: line.countingBasisLabel,

    fullYearDays: line.fullYearDays,
    accrued: line.accrued,
    granted: line.granted,
    grantedAhead: line.grantedAhead,
    carriedOver: line.carriedOver,
    adjustment: line.adjustment,
    taken: line.taken,
    pending: line.pending,
    owed: line.owed,
    availableOnTheBalance: line.availableOnTheBalance,

    working: line.working.map(stepAsJson),
  };
}

function stepAsJson(step: SettlementStep): unknown {
  return { label: step.label, days: step.days, part: step.part, says: step.says };
}
