import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signedInAs } from '../../src/auth/actor.js';
import { leaveRequestPolicy } from '../../src/auth/leave-request-policy.js';
import type { BalanceOwner } from '../../src/auth/ledger-policy.js';
import {
  isSettled,
  LeaveAlreadySettled,
  type LeaveRequest,
  REQUEST_ACTIONS,
  REQUEST_STATUSES,
  type RequestStatus,
  settlementTo,
  standingsFor,
  STANDINGS,
  TRANSITIONS,
  transitionFor,
  transitionsFrom,
} from '../../src/domain/leave-request.js';

/**
 * A request moves through defined states and no others. §6. LMS 313.
 *
 * The story is a request nobody can explain or resolve, and the three criteria are three
 * different defences against it. They are tested together here because they are one
 * design — an explicit table, one writer, and a record of every move — and because a
 * file per criterion would hide that the second and third are what make the first mean
 * anything.
 *
 *   **The table is explicit**, keyed by from-status, action and standing. Asserted for
 *   the properties a table can have that a scattering of `if`s cannot: no duplicate key,
 *   no move out of a terminal state, no dead verb, nothing keyed on a status that does
 *   not exist.
 *
 *   **One writer of the status column.** A claim about code that does not exist, so it
 *   is read out of the source — the same technique ./one-writer.test.ts uses on the
 *   ledger, and for the same reason: the realistic second writer is an honest service
 *   doing an honest `UPDATE`, not a rogue one.
 *
 * The third criterion — every transition writes an audit entry — is a database trigger
 * and is ../integration/leave-request.test.ts's, because a row written by a trigger
 * inside somebody else's transaction is not a thing a pure function can be asked about.
 *
 * ## What is asserted here, and what is deliberately asserted elsewhere
 *
 * Now that ../../src/auth/leave-request-policy.ts reads `TRANSITIONS`, **a test checking
 * the policy against the table is a test checking a function against itself** — widen a
 * row and both move together. That is the trap the seven-leave-types suite names as
 * "checking the migration against a copy of itself", and it is easy to walk into here
 * because the check reads like the important one.
 *
 * So the table is pinned in full below, and which desks the policy actually admits is
 * ./policy.test.ts's, asserted against hardcoded actors. A widened row fails both, and
 * neither can be satisfied by the other's mistake.
 */

/* ------------------------------------------------------------------ the table */

describe('the transitions a request may make', () => {
  it('is an explicit table rather than a rule spread over three files', () => {
    expect(TRANSITIONS.length).toBeGreaterThan(0);

    for (const transition of TRANSITIONS) {
      expect(REQUEST_STATUSES).toContain(transition.from);
      expect(REQUEST_STATUSES).toContain(transition.to);
      expect(REQUEST_ACTIONS).toContain(transition.action);
    }
  });

  /**
   * And each row is keyed by a from-status and an action, once.
   *
   * `transitionFor` is a `find`, so a duplicate key would not be an error — it would be
   * a second row that never fires, quietly overridden by whichever was written first.
   * That is the failure mode of every table like this one, and it is invisible: both
   * rows read correctly, and only one of them is the rule.
   */
  it('and no two rows share a from-status and an action', () => {
    const keys = TRANSITIONS.map((transition) => `${transition.from}/${transition.action}`);

    expect(keys).toEqual([...new Set(keys)]);
  });

  /**
   * And every move names somebody who can make it.
   *
   * An empty `by` is a transition nobody may perform, which is a state a request can
   * enter and never leave — precisely the condition the story is written against, and
   * the one it would be easiest to create by deleting a standing rather than a row.
   */
  it('and every move names at least one standing that can make it', () => {
    for (const transition of TRANSITIONS) {
      expect(transition.by.length).toBeGreaterThan(0);

      for (const standing of transition.by) {
        expect(STANDINGS).toContain(standing);
      }
    }
  });

  /**
   * And a settled request goes nowhere, which is written as the absence of a row.
   *
   * `WITHDRAWN`, `CANCELLED` and `REFUSED` appear in the `to` column and never in the
   * `from` column. That is what makes them terminal — not a flag on the status and not a
   * separate rule saying so — and it is why `settlementTo` can answer "already settled"
   * for every miss rather than guessing.
   */
  it('and nothing moves out of a state that has ended', () => {
    for (const status of REQUEST_STATUSES.filter(isSettled)) {
      expect(transitionsFrom(status)).toEqual([]);
    }
  });

  /**
   * And every state that has *not* ended answers every action.
   *
   * The invariant `settlementTo`'s refusal leans on: it reports every miss as "this
   * request has already ended", which is honest only while a miss can mean nothing else.
   * The approval story adds `APPROVED` — a live state — and the moment it does, this
   * test asks whether an approved request can be withdrawn, refused and cancelled. If
   * the answer for any of them is no, the refusal above has to learn to say something
   * other than "already settled", and this is what says so.
   */
  it('and every state still running answers every action', () => {
    const running = REQUEST_STATUSES.filter((status) => !isSettled(status));

    expect(running.length).toBeGreaterThan(0);

    for (const status of running) {
      for (const action of REQUEST_ACTIONS) {
        expect(transitionFor(status, action)).toBeDefined();
      }
    }
  });

  /* And no verb is dead. An action nothing can perform is a name in a list that reads
     as a feature and does nothing, which is what `REQUEST_STATUSES` was kept short to
     avoid on the other axis. */
  it('and every action is reachable from somewhere', () => {
    for (const action of REQUEST_ACTIONS) {
      expect(TRANSITIONS.some((transition) => transition.action === action)).toBe(true);
    }
  });

  /**
   * And every destination in today's table ends the request — deliberately, and only
   * for now.
   *
   * Every action here releases days, so every one of them lands somewhere terminal, and
   * `settlementTo` narrows to a `ReleasingStatus` on the strength of it. The approval
   * story's row is the first with a live destination and it will fail this test, which
   * is the intent: `releaseForRequest` is the wrong door for a move that commits days
   * rather than giving them back, and failing here is how that gets noticed before a
   * balance does.
   */
  it('and every destination today is one that ends it, which approval will change', () => {
    for (const transition of TRANSITIONS) {
      expect(isSettled(transition.to)).toBe(true);
    }
  });
});

describe('where a settlement lands', () => {
  function aRequest(status: RequestStatus): LeaveRequest {
    return {
      id: 'request-1',
      employeeId: 'ama',
      leaveTypeId: 'annual',
      leaveYearId: '2026',
      from: '2026-03-02',
      to: '2026-03-10',
      reason: 'My sister is getting married',
      countingBasis: 'WORKING_DAYS',
      days: 6,
      calendarDays: 9,
      status,
      submittedAt: new Date('2026-02-01T09:00:00Z'),
      createdAt: new Date('2026-02-01T09:00:00Z'),
      updatedAt: new Date('2026-02-01T09:00:00Z'),
    };
  }

  /**
   * The destination comes off the table, which is what makes the table load bearing.
   *
   * Before LMS 313 the service named it at each call site — `settle(actor, id,
   * 'WITHDRAWN', …)` — so the table could have said anything and the code would still
   * have written whatever the caller asked for. There is now nowhere to say it.
   */
  it.each([
    ['WITHDRAW', 'WITHDRAWN'],
    ['REFUSE', 'REFUSED'],
    ['CANCEL', 'CANCELLED'],
  ] as const)('%s leaves a submitted request %s', (action, to) => {
    expect(settlementTo(aRequest('SUBMITTED'), action)).toBe(to);
  });

  it('and a request that has ended goes nowhere, whatever is asked of it', () => {
    for (const status of REQUEST_STATUSES.filter(isSettled)) {
      for (const action of REQUEST_ACTIONS) {
        expect(() => settlementTo(aRequest(status), action)).toThrow(LeaveAlreadySettled);
      }
    }
  });
});

/* ---------------------------------------------------- the table, written down */

/**
 * The table is these three rows and no others. §6, criterion one. LMS 313.
 *
 * Pinned in full rather than checked for properties, and the reason is the lesson the
 * seven-leave-types suite learned: a test that derives its expectation from the thing it
 * is testing is "checking the migration against a copy of itself". Every assertion above
 * this one is a property — no duplicate key, nothing out of a terminal state — and a
 * property holds just as well for a table somebody has widened by hand. So does the
 * policy, now that it reads the table: adding `THE_REQUESTER` to the `REFUSE` row makes
 * the policy allow it and every derived check still agree.
 *
 * This is the one that fails. Changing who may do what means changing this list, in a
 * diff a reviewer reads as a change to the rules — which is what an explicit table buys
 * over three `if`s, and is worthless unless something insists on it.
 *
 * ../unit/policy.test.ts holds the other end: that the desks the table names are the
 * desks the policy actually admits, asserted against hardcoded actors rather than
 * against `TRANSITIONS`. Between them a widened row fails twice, and neither test can be
 * satisfied by the other's mistake.
 */
describe('the table, written out', () => {
  it('is exactly the moves §6 permits', () => {
    expect(TRANSITIONS).toEqual([
      {
        from: 'SUBMITTED',
        action: 'WITHDRAW',
        to: 'WITHDRAWN',
        by: ['THE_REQUESTER', 'LEAVE_ADMINISTRATION'],
      },
      {
        from: 'SUBMITTED',
        action: 'REFUSE',
        to: 'REFUSED',
        by: ['THEIR_LINE_MANAGER', 'LEAVE_ADMINISTRATION'],
      },
      {
        from: 'SUBMITTED',
        action: 'CANCEL',
        to: 'CANCELLED',
        by: ['LEAVE_ADMINISTRATION'],
      },
    ]);
  });

  /* And the vocabulary it is keyed by, for the same reason. A standing added here
     without a branch in `hasStanding` does not compile; one added and left out of every
     row is a concept nothing uses. */
  it('and is keyed by the three actions and the three standings there are', () => {
    expect([...REQUEST_ACTIONS]).toEqual(['WITHDRAW', 'REFUSE', 'CANCEL']);
    expect([...STANDINGS]).toEqual(['THE_REQUESTER', 'THEIR_LINE_MANAGER', 'LEAVE_ADMINISTRATION']);
  });
});

/* ------------------------------------- two questions, asked in one order only */

/**
 * The policy answers "is this your business" and the table answers "is this move
 * available", and the order matters in both directions. §6, §10. LMS 313.
 *
 * Both are keyed by the action; only the second is keyed by the from-status. That split
 * is not tidiness, it is the only arrangement in which each refusal is both true and
 * safe:
 *
 *   **The policy cannot consider the state**, or somebody withdrawing leave they have
 *   already withdrawn is told they *may not* — untrue, unactionable, and it would make
 *   `LeaveAlreadySettled` unreachable for the one person most likely to need it.
 *
 *   **The state cannot be read first**, or a colleague probing ids learns that
 *   somebody's leave was refused before anything has decided whether they may see it.
 *
 * So the policy is asked first and knows only who is asking; `settlementTo` is asked
 * second and knows only where the request is. What ../unit/policy.test.ts pins is which
 * desks the first admits, against hardcoded actors rather than against the table.
 */
describe('the two questions, and the order they are asked in', () => {
  /** Ama's request. Akosua is her line manager. */
  const hers: BalanceOwner = { employeeId: 'ama', managerId: 'akosua' };

  const ama = signedInAs('ama', { roles: ['EMPLOYEE'], isManager: false });

  /**
   * The requester may withdraw, and the decision does not depend on where the request
   * has got to — it cannot, because it is not given it.
   *
   * This is what leaves room for the specific refusal: the person pressing withdraw a
   * second time passes the policy and meets `LeaveAlreadySettled`, which names what
   * happened and says the days are already back.
   */
  it('the policy decides on who is asking, and is not given the state', () => {
    expect(leaveRequestPolicy.withdraw(ama, hers).allowed).toBe(true);
    expect(leaveRequestPolicy.withdraw.length).toBe(2);
  });

  it('and the table decides on the state, for the same person', () => {
    expect(() =>
      settlementTo(
        {
          id: 'request-1',
          employeeId: 'ama',
          leaveTypeId: 'annual',
          leaveYearId: '2026',
          from: '2026-03-02',
          to: '2026-03-10',
          reason: 'My sister is getting married',
          countingBasis: 'WORKING_DAYS',
          days: 6,
          calendarDays: 9,
          status: 'WITHDRAWN',
          submittedAt: new Date('2026-02-01T09:00:00Z'),
          createdAt: new Date('2026-02-01T09:00:00Z'),
          updatedAt: new Date('2026-02-01T09:00:00Z'),
        },
        'WITHDRAW',
      ),
    ).toThrow(LeaveAlreadySettled);
  });

  /**
   * And the projection the policy decides on is the row's own list.
   *
   * `standingsFor` is a union across the rows for an action, which is exact only while
   * each action has one row — pinned above. A story giving one action different desks in
   * different states makes this too permissive, and the test that catches it is the one
   * asserting the table is exactly three rows.
   */
  it.each(REQUEST_ACTIONS)('and the standings %s is decided on are that row’s', (action) => {
    expect(standingsFor(action)).toEqual(transitionFor('SUBMITTED', action)?.by);
  });
});

/* ------------------------------------------ one writer of the status column */

const SOURCE = join(process.cwd(), 'server', 'src');

/** Read with the comments taken out; these files discuss `status` at length. */
const sources = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({
    file: file.replaceAll('\\', '/'),
    code: readFileSync(join(SOURCE, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' '),
  }));

/**
 * Only the state machine writes `leave_request.status`. §6. LMS 313.
 *
 * The story's second criterion, and a claim about code that does not exist — so it is
 * read out of the source, exactly as ./one-writer.test.ts reads the ledger's.
 *
 * **What this protects against is not a rogue `UPDATE`.** `refuse_an_impossible_
 * transition()` refuses those on every connection and `leave_request_gives_its_days_back`
 * refuses a status that moved without releasing. The realistic second writer is an
 * honest one: a bulk cancellation that loops over requests, an import that sets a status
 * while fixing something else. Each would go through the repository, satisfy both
 * triggers by releasing properly, and skip the table — writing a status the state
 * machine would never have permitted, with the ledger and the audit log both agreeing it
 * was fine.
 */
describe('one writer of the status column', () => {
  it('there is source to read', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  /**
   * The repository is the only file that may issue an UPDATE against the table at all.
   *
   * The positive half is asserted first and is not a formality: a filter that finds
   * nothing passes whether the rule holds or the pattern has stopped matching, and a
   * renamed Kysely method or a change of quoting style would turn this into a test that
   * guards nothing and says so to nobody.
   */
  it('and only the repository updates the leave request table', () => {
    const updates = /updateTable\(\s*['"]leave_request['"]\s*\)/;

    const repository = sources.find(
      ({ file }) => file === 'repositories/leave-request-repository.ts',
    );

    expect(repository?.code).toMatch(updates);

    expect(
      sources
        .filter(
          ({ file, code }) =>
            file !== 'repositories/leave-request-repository.ts' && updates.test(code),
        )
        .map(({ file }) => file),
    ).toEqual([]);
  });

  /**
   * And within it, exactly one statement sets `status`.
   *
   * `reword` updates the same table and deliberately sets only `reason` — the field
   * that explains rather than decides. A second `set({ status ... })` is the shape a
   * second writer would take, and it would be four characters added to a method that
   * already had the row in hand.
   */
  it('and exactly one statement in it sets a status', () => {
    const repository = sources.find(
      ({ file }) => file === 'repositories/leave-request-repository.ts',
    );

    expect(repository).toBeDefined();
    expect(repository?.code.match(/\.set\(\s*\{\s*status/g) ?? []).toHaveLength(1);
  });

  /**
   * And one file calls it: the door that writes the `RELEASE` in the same transaction.
   *
   * `BalanceService.releaseForRequest` rather than `LeaveRequestService` itself, and
   * that is the ledger's one-door rule winning over this one where they meet — the
   * status and the movement have to land together, and movements are written in one
   * place. The state machine is still the only way in: it is `LeaveRequestService` that
   * decides the move, and it reaches the write through that door and nowhere else.
   */
  it('and one file calls the repository method that does it', () => {
    const calling = sources.filter(({ code }) => /requests\.settle\s*\(/.test(code));

    expect(calling.map(({ file }) => file)).toEqual(['services/balance-service.ts']);
  });

  /**
   * And the destination it writes is the table's, not a caller's.
   *
   * The one that would undo the whole criterion quietly: `releaseForRequest` taking a
   * status and writing it. It takes an *action* and asks `settlementTo` inside the lock,
   * so a caller cannot name where a request ends up.
   */
  it('and the door asks the table where the request lands', () => {
    const door = sources.find(({ file }) => file === 'services/balance-service.ts');

    expect(door?.code).toMatch(/settlementTo\(/);
    expect(door?.code).toMatch(/holdStill\(/);
  });

  /* And nothing outside the two decides where a settlement lands. A third caller of
     `settlementTo` is a third place that knows the state machine. */
  it('and only the state machine and its door consult the table', () => {
    const consulting = sources.filter(({ code }) => /\bsettlementTo\s*\(/.test(code));

    expect(consulting.map(({ file }) => file).sort()).toEqual([
      'domain/leave-request.ts',
      'services/balance-service.ts',
      'services/leave-request-service.ts',
    ]);
  });
});
