/**
 * The balance screen, over HTTP. FR 53. LMS 401.
 *
 * One route. It reads the year out of the query string, asks
 * `BalanceStatementService` and serialises what comes back — no rule, no arithmetic and
 * no decision about which types or which years, all of which are
 * ../domain/balance-statement.ts's and are the reason this file is nine lines of work
 * inside a page of argument.
 *
 * ## Whose balances, and why there is no id in the path
 *
 * `GET /api/me/balances`, and `me` is not a convenience. FR 53 is a person looking at
 * their own figures, and the id handed to the service is `actor.employeeId` — taken from
 * the session cookie, which ./identify.ts verified — so **there is no way to ask this
 * route about anybody else**, whatever is sent.
 *
 * That is stronger than checking a supplied id, and the difference is worth being exact
 * about. `ledgerPolicy.read` would refuse somebody else's balances anyway, and a
 * `/employees/:id/balances` route guarded by it would be correct. It would also be a
 * route whose correctness depends on the guard being asked, and the day somebody adds a
 * second handler beside it is the day that stops being obvious. A route that cannot name
 * anybody else needs no such argument.
 *
 * FR 55 and FR 56 — a manager's view of a report, HR's view of anybody — are LMS 402 and
 * LMS 405, and they are a different route with a different rule about who the subject may
 * be. The service already takes an employee id for them, and the policy is already
 * written and already refuses the wrong people. What is deliberately not here is the
 * *route*, because "a manager may see their direct reports" is a decision that should be
 * made once, in the open, by the story that owns it — not inherited by a query parameter
 * somebody added to this one.
 *
 * ## Nothing is recalculated by the client, and this is where that is guaranteed
 *
 * Every figure on the page is on the wire: the five stored ones, `available` and `owed`
 * computed by ../domain/balance.ts, the counting basis in words, and the sentence that
 * says what a nought means. A browser that had to derive any of them would be a second
 * implementation of the projection — the exact drift `leave_balance` exists to be checked
 * against — and it would run in a place no test in this repository can see.
 *
 * ## The dates go out as they are held
 *
 * `startDate` and `endDate` are ten characters and stay ten characters. NFR DAT 03 and
 * ../domain/time.ts: they are not instants, they have no zone, and turning one into a
 * `Date` on the way out is how the last day of a leave year becomes the second to last in
 * a browser west of Greenwich. `updatedAt` genuinely is an instant and goes out as ISO
 * 8601, which is the one place this file converts anything.
 */

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

  /**
   * My balances for one leave year, with the years I may switch to.
   *
   * `leaveYearId` is optional and the server picks when it is absent — which year "this
   * one" is depends on a clock, and the clock that decides is the server's. A browser
   * that worked it out would disagree with the database on the first of January for
   * everybody east or west of UTC.
   *
   * Refusals are left to ./problems.ts: a year that is nobody's is 404, a real year that
   * is not this person's is 404 with the years that are, and a company with no leave year
   * defined at all is 409 with the sentence that says whose job it is.
   */
  routes.get('/me/balances', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    /* Unreachable: `identify` only ever builds an actor from an employee record it has
       just read, and `theSystem()` — the one actor with a null id — is never minted by a
       route. Answered rather than asserted, because the alternative is asking the service
       for the balances of employee `null`. */
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

/**
 * The leave year asked for, where one string was asked for.
 *
 * Express hands back `string | string[] | undefined` for a repeated parameter, and
 * `?leaveYearId=1&leaveYearId=2` is a caller asking two questions. Refused by being
 * ignored rather than by a 400: the answer to "which of these two years" is the ordinary
 * default, which is a year this person certainly has, rather than an error page about a
 * query string.
 */
function oneYearIn(request: Request): string | undefined {
  const value = request.query.leaveYearId;

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The statement as JSON.
 *
 * Written out field by field rather than handed to `res.json(statement)`, which would
 * work today and is the wrong habit: a domain type is not a wire format, and the day
 * somebody adds a field to `BalanceStatementLine` for an internal reason it would appear
 * on the API without anybody deciding it should. This is the list of what is published.
 */
function asJson(statement: BalanceStatement): unknown {
  return {
    employeeId: statement.employeeId,
    year: yearAsJson(statement.year),
    years: statement.years.map(yearAsJson),
    lines: statement.lines.map(lineAsJson),
  };
}

/** A leave year. Both dates are calendar dates and are not touched. See the module note. */
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
    countingBasisInWords: line.countingBasisInWords,
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
    /* An instant, and the only thing here that is. ISO 8601 in UTC, which is what
       ../domain/time.ts holds every timestamp in. NFR DAT 03. */
    updatedAt: line.updatedAt === null ? null : line.updatedAt.toISOString(),
  };
}
