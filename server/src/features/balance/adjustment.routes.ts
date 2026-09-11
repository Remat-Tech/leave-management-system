/** The balance adjustment screen, over HTTP. FR 37, FR 27, LMS 506, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type {
  AdjustableEmployee,
  AdjustmentView,
  BalanceAdjustmentService,
  Movement,
} from './adjustment.service.js';
import type { BalanceMoved, BalanceService } from './balance.service.js';
import type { BalanceStatementLine } from './balance-statement.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import { type LedgerEntry, movementInWords } from './ledger.js';
import { actorOf } from '../../http/identify.js';

export interface BalanceAdjustmentRoutes {
  adjustments: BalanceAdjustmentService;
  /**
   * FR 37. The write door, handed in whole rather than built here.
   *
   * `BalanceService` is the one place a balance moves, and an adjustment is a movement like
   * any other. A second way into `leave_ledger_entry` would be a second answer to what a
   * correction does to a cached figure.
   */
  balances: BalanceService;
}

export function balanceAdjustmentRoutes(parts: BalanceAdjustmentRoutes): Router {
  const routes = Router();

  /** Whose balance can be put right. The picker, and nothing else. */
  routes.get('/balance-adjustments', (_request: Request, response: Response, next) => {
    void parts.adjustments
      .whoCanBeAdjusted(actorOf(response))
      .then((employees) => {
        response.json({ employees: employees.map(personAsJson) });
      })
      .catch(next);
  });

  /** One person's figures for one year, and every movement behind them. FR 27. */
  routes.get('/balance-adjustments/:employeeId', (request: Request, response: Response, next) => {
    void parts.adjustments
      .forEmployee(actorOf(response), asString(request.params.employeeId), oneYearIn(request))
      .then((view) => {
        response.json(viewAsJson(view));
      })
      .catch(next);
  });

  /**
   * Moves a balance by hand. FR 37.
   *
   * `days` is passed through as it arrived rather than coerced. The domain refuses what is
   * not a movement with a sentence naming the field, and a route that read `'3'` as three
   * would be deciding what a form meant.
   */
  routes.post('/balance-adjustments', (request: Request, response: Response, next) => {
    const sent = bodyOf(request);

    void parts.balances
      .adjust(actorOf(response), {
        employeeId: asString(sent.employeeId),
        leaveTypeId: asString(sent.leaveTypeId),
        leaveYearId: asString(sent.leaveYearId),
        days: sent.days as number,
        reason: sent.reason as string,
      })
      .then((moved) => {
        response.status(201).json(movedAsJson(moved));
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

/** A field as it arrived, where a string was asked for. A blank is the domain's to refuse. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function viewAsJson(view: AdjustmentView): unknown {
  return {
    employee: personAsJson(view.employee),
    year: yearAsJson(view.statement.year),
    years: view.statement.years.map(yearAsJson),
    lines: view.statement.lines.map(lineAsJson),
    /** FR 27. The story's second criterion: where an adjustment shows up afterwards. */
    ledger: view.ledger.map(movementAsJson),
  };
}

function personAsJson(employee: AdjustableEmployee): unknown {
  return {
    id: employee.id,
    name: employee.name,
    employeeNumber: employee.employeeNumber,
    jobTitle: employee.jobTitle,
    /** FR 06. */
    hasLeft: employee.hasLeft,
  };
}

/** A leave year. NFR DAT 03. */
function yearAsJson(year: LeaveYear): unknown {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate,
    endDate: year.endDate,
    /** §8.9. A settled year takes an adjustment and nothing else, which the screen says. */
    isClosed: year.isClosed,
  };
}

/** One leave type's figures, field for field as `/api/me/balances` sends the reader's own. FR 53. */
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
    /** An instant. NFR DAT 03. */
    updatedAt: line.updatedAt === null ? null : line.updatedAt.toISOString(),
  };
}

/** One entry, with who wrote it and why. FR 27. */
function entryAsJson(entry: LedgerEntry): Record<string, unknown> {
  return {
    id: entry.id,
    leaveTypeId: entry.leaveTypeId,
    entryType: entry.entryType,
    inWords: movementInWords(entry.entryType),
    /** Signed, and an adjustment is the only kind that may go either way. FR 37. */
    days: entry.days,
    /** FR 27. The one thing about an entry nothing else can work out afterwards. */
    reason: entry.reason,
    correctsId: entry.correctsId,
    leaveRequestId: entry.leaveRequestId,
    createdBy: entry.createdBy,
    createdByEmployeeId: entry.createdByEmployeeId,
    /** An instant. NFR DAT 03. */
    createdAt: entry.createdAt.toISOString(),
  };
}

/** The same, named and with the figure it left behind it. LMS 211. */
function movementAsJson(movement: Movement): unknown {
  return {
    ...entryAsJson(movement),
    typeName: movement.typeName,
    after: movement.after,
  };
}

/**
 * The movement that was written, and what the balance became.
 *
 * The entry carries neither a running total nor a type name, because neither would be true
 * of one movement read on its own. What is worth saying after a correction is the figure the
 * balance now stands at, which the server has in hand and the screen must not add up.
 */
function movedAsJson(moved: BalanceMoved): unknown {
  return {
    entry: entryAsJson(moved.entry),
    balance: {
      leaveTypeId: moved.balance.leaveTypeId,
      leaveYearId: moved.balance.leaveYearId,
      entitled: moved.balance.entitled,
      carriedOver: moved.balance.carriedOver,
      adjustment: moved.balance.adjustment,
      taken: moved.balance.taken,
      pending: moved.balance.pending,
      available: moved.balance.available,
    },
  };
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
