/**
 * The request history screen, assembled. FR 54, §7.4. LMS 402.
 *
 * One method, six reads and no writes. What a history *is* lives in
 * ../domain/request-history.ts; who may read one is ../auth/leave-request-policy.ts; this
 * gathers the rows those two need and resolves the year somebody asked for.
 *
 * ## Why it is not a method on `LeaveRequestService`
 *
 * That class already reads requests, already reads decisions, and already assembles the
 * approval progress of one — `forEmployee`, `decisionsFor` and `progressFor` are three of its
 * methods and the shortest version of this story is a fourth that calls all three in a loop.
 *
 * It is here instead for the reason `BalanceStatementService` is not a method on
 * `BalanceService`, and the argument is the same one twice:
 *
 *   **That class is the write door.** It holds the balance service, the calculator and the
 *   notifier because submitting, approving and refusing need all three, and every one of them
 *   would have to be constructed to serve a screen that reads. A route layer that had to build
 *   an SMTP transport to render a list of past leave is one where the read path fails for
 *   reasons the read path has nothing to do with.
 *
 *   **A loop over those three methods is a query per row.** `progressFor` re-reads the
 *   request, the employee, the type and the decisions for each entry, because it is written to
 *   answer about one request from an id. Forty requests is a hundred and sixty round trips for
 *   a page, and the shape that produces it is a method reused past what it was for rather than
 *   a mistake anybody would make on purpose.
 *
 * So the reads are done once, in bulk, and ../domain/request-history.ts does the assembling —
 * which is where `progressOf` is called anyway. Nothing here writes, opens a transaction, or
 * holds a `BalanceService`.
 *
 * ## Six reads, and one of them is wider than the screen
 *
 * The employee, every leave type, every leave year, **every one of this person's requests**,
 * the decisions on the ones being shown, and the people who made those decisions.
 *
 * The requests are read across all years even when one year was asked for, and it is the same
 * decision `BalanceStatementService` makes about balances for the same reason: which years are
 * on the picker is a function of which years hold a request, so asking only for the chosen
 * year would mean either a second query or a picker that could offer a year the screen then
 * had nothing for. The filtering is then a `filter` over rows already in hand rather than a
 * second trip.
 *
 * It is a small read — one person's requests, which for a decade of service is a few hundred
 * rows of a table indexed by employee — and the alternative is two queries that can disagree.
 *
 * The decisions are read only for the requests being *shown*, because unlike the years there
 * is nothing about a hidden request's decisions that the screen needs. The deciders follow
 * from those, distinct and in one statement — see {@link whoDecidedThem}, which also says why
 * that read asks no policy of its own.
 *
 * ## No lock, and nothing to lock
 *
 * A history is read and looked at. Nothing here is about to be acted on, and
 * `BalanceStatementService` says the rest: "a lock taken for a figure nobody is about to act
 * on is a lock somebody else waits behind for nothing."
 *
 * ## Three policies asked, and one of them can refuse
 *
 * The layering rule says a service asks the policy for its resource, and a history touches
 * three tables, so all three are asked rather than only the interesting one.
 * `leaveTypePolicy.list` and `leaveYearPolicy.list` allow anybody signed in — those tables are
 * the rules themselves — so the question that decides is `leaveRequestPolicy.read`: your own
 * requests, your direct reports', or a role that reads everybody. FR 54, FR 55, FR 56.
 *
 * That is deliberately the same rule that guards the balance, and ../auth/leave-request-policy.ts
 * gives the reason in full: "a request is why a figure is what it is… standing to see one
 * without the other would be standing to see half an explanation."
 *
 * **Whose history it is comes from the caller's id, never from the wire.** This method takes an
 * employee id because FR 55 and FR 56 exist, and the route that serves FR 54 passes the actor's
 * own id rather than anything a client sent.
 */

import type { Actor } from '../auth/actor.js';
import { leaveRequestPolicy } from '../auth/leave-request-policy.js';
import { leaveTypePolicy } from '../auth/leave-type-policy.js';
import { leaveYearPolicy } from '../auth/leave-year-policy.js';
import type { BalanceOwner } from '../auth/ledger-policy.js';
import type { Guard } from '../auth/policy.js';
import { type Employee, EmployeeNotFound } from '../domain/employee.js';
import type { LeaveDecision } from '../domain/leave-decision.js';
import { type LeaveYear, LeaveYearNotFound } from '../domain/leave-year.js';
import { historyFor, type RequestHistory, yearsWithRequests } from '../domain/request-history.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { LeaveDecisionRepository } from '../repositories/leave-decision-repository.js';
import type { LeaveRequestRepository } from '../repositories/leave-request-repository.js';
import type { LeaveTypeRepository } from '../repositories/leave-type-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';

/** Which slice of somebody's history to show. */
export interface HistoryOptions {
  /**
   * The year to narrow to, or nothing for every request there is.
   *
   * The default is deliberately *everything*, which is the opposite of the balance screen's
   * default and follows from what the two are. A balance is per leave year and cannot be
   * shown without one; a history is a list of things that happened, and "all my past
   * requests" is the story's own words.
   *
   * Refused with {@link LeaveYearNotFound} for an id that is nobody's, and with nothing at
   * all for a real year this person has no requests in — see ../domain/request-history.ts,
   * which argues why an empty history is a true answer where an empty statement is not.
   */
  leaveYearId?: string;
}

export class RequestHistoryService {
  constructor(
    private readonly requests: LeaveRequestRepository,
    /**
     * FR 39, FR 52. What each desk said, and why. LMS 315.
     *
     * The reading half only. A decision has to be written in the same transaction as the
     * status it explains, so `record()` belongs to the door that owns transactions —
     * `LeaveRequestService` keeps the same division and says why.
     */
    private readonly decisions: LeaveDecisionRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * The employee record, for two facts and no more: who their line manager is, which the
     * policy decides on, and that the person exists at all.
     */
    private readonly employees: EmployeeRepository,
    /** For each request's type name and its approval chain as it stands. */
    private readonly types: LeaveTypeRepository,
    /** For the picker, and to tell a year that is nobody's from one that is empty. */
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * One person's requests, newest first, each with the account of how it was decided.
   *
   * The whole of LMS 402 as one call, because the two criteria are one screen: a list that
   * came back without its trails would leave them to be fetched per row, which is the query
   * per request this service exists to avoid.
   *
   * Refused with {@link EmployeeNotFound} for an id that is nobody, raised before the policy
   * because there is no history to have standing towards, and with the policy's silent
   * refusal for somebody else's — deliberately different in kind, and the second discloses
   * nothing. See the note at the top of ../auth/policy.ts.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: HistoryOptions = {},
  ): Promise<RequestHistory> {
    const employee = await this.require(employeeId);

    this.guard.enforce(leaveRequestPolicy.read(actor, ownerOf(employee)));
    this.guard.enforce(leaveTypePolicy.list(actor));
    this.guard.enforce(leaveYearPolicy.list(actor));

    /* All of them, across every year, because the picker is a function of which years hold
       one. See the module note on why that is the consistent arrangement as well as the
       cheaper one. */
    const asked = await this.requests.list({ employeeId: employee.id });

    const year = await this.yearToShow(options.leaveYearId);

    const shown =
      year === null ? asked : asked.filter((request) => request.leaveYearId === year.id);

    const decisions = await this.decisions.forRequests(shown.map((request) => request.id));

    return historyFor({
      employeeId: employee.id,
      year,
      years: yearsWithRequests(await this.years.list(), asked),
      requests: shown,
      /* Every type, retired ones included: a request made under a type HR has since
         withdrawn is still a request that happened, and a history that dropped it would be
         the screen hiding the thing somebody came to check. */
      types: await this.types.list(),
      decisions,
      deciders: await this.employees.findAllById(whoDecidedThem(decisions)),
    });
  }

  /**
   * Which year this history is narrowed to, or null for all of them.
   *
   * A named year is checked once, and only for existing — unlike the balance statement,
   * which checks twice because a year that is not somebody's produces a screen of noughts
   * that reads as "you have no leave". The same year here produces an empty list, which
   * reads as "you asked for no leave then", and that is what it means. There is nothing to
   * refuse.
   *
   * `LeaveYearNotFound` remains, because an id that names nothing is a broken link or a
   * stale bookmark rather than an answer.
   */
  private async yearToShow(leaveYearId: string | undefined): Promise<LeaveYear | null> {
    if (leaveYearId === undefined) {
      return null;
    }

    const year = await this.years.findById(leaveYearId);

    if (year === undefined) {
      throw new LeaveYearNotFound(leaveYearId);
    }

    return year;
  }

  /** The record, or {@link EmployeeNotFound}. Read before any policy is asked. */
  private async require(employeeId: string): Promise<Employee> {
    const employee = await this.employees.findById(employeeId);

    if (employee === undefined) {
      throw new EmployeeNotFound(employeeId);
    }

    return employee;
  }
}

/** Whose requests these are, and who their line manager is. ../auth/ledger-policy.ts. */
function ownerOf(employee: Employee): BalanceOwner {
  return { employeeId: employee.id, managerId: employee.managerId };
}

/**
 * The people to look up so a trail can name them. FR 52.
 *
 * Distinct, because two stages of one chain are often signed by the same HR Officer and a
 * duplicate id in an `IN` list is a row read twice. Nulls dropped: a decision with no employee
 * behind it is the system or something unattributed, and `whoDecided` answers those from what
 * was recorded rather than from a record that does not exist.
 *
 * **No policy is asked before this read, and that is deliberate rather than an omission.** It
 * is the same reading `progressFor` already makes about a chain and `LeaveRequestService`
 * makes about a leave type: the caller has been allowed to see this request, a decision on it
 * is part of the request, and who made it is part of the decision. Nothing else about the
 * record leaves this method — {@link historyFor} keeps the name and drops the row.
 */
function whoDecidedThem(decisions: readonly LeaveDecision[]): string[] {
  return [
    ...new Set(
      decisions
        .map((decision) => decision.decidedByEmployeeId)
        .filter((id): id is string => id !== null),
    ),
  ];
}
