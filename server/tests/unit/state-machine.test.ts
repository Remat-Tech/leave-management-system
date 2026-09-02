import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signedInAs } from '../../src/auth/actor.js';
import { leaveRequestPolicy } from '../../src/auth/leave-request-policy.js';
import type { BalanceOwner } from '../../src/auth/ledger-policy.js';
import { APPROVER_ROLES, type ApproverRole } from '../../src/domain/approval-chain.js';
import {
  approvalTo,
  isSettled,
  isTheLastWord,
  LeaveAlreadySettled,
  LeaveCannotBeMoved,
  type LeaveRequest,
  progressOf,
  RELEASING_ACTIONS,
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

/**
 * A request in a given state, waiting where that state implies.
 *
 * `awaitingApprovalFrom` is not free to be anything: `leave_request_waits_at_a_desk` makes
 * it present exactly while the status is `SUBMITTED`, so a fixture that set a desk on a
 * withdrawn request would be a row the database cannot hold and an assertion about nothing.
 */
function aRequestIn(status: RequestStatus, awaiting: ApproverRole = 'MANAGER'): LeaveRequest {
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
    awaitingApprovalFrom: status === 'SUBMITTED' ? awaiting : null,
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
  };
}

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
   * And the state a request waits in answers every verb there is.
   *
   * This used to be said of every state that had not ended, and it was written knowing the
   * approval story would break it: "the moment it does, this test asks whether an approved
   * request can be withdrawn, refused and cancelled. If the answer for any of them is no,
   * the refusal above has to learn to say something other than 'already settled', and this
   * is what says so."
   *
   * `APPROVED` is that state, and the answer is no for all three. It holds its days as
   * `taken` rather than as `pending`, so none of the three verbs has anything to work on —
   * `daysToRelease` would find no hold to give back — and the story that takes agreed leave
   * off the books brings the movement that can. {@link LeaveCannotBeMoved} is the refusal
   * that had to arrive with it, pinned below.
   *
   * What survives is the claim about the state a request actually *waits* in, which is the
   * one somebody is looking at when they say a request is stuck. Everything can be done to
   * a submitted request, and a verb added without a row out of `SUBMITTED` is a button that
   * does nothing.
   */
  it('and everything can be done to a request that is waiting to be decided', () => {
    for (const action of REQUEST_ACTIONS) {
      expect(transitionFor('SUBMITTED', action)).toBeDefined();
    }
  });

  /**
   * And a state with no way out has a refusal that says which state it is.
   *
   * The invariant that replaced the old one, and it is the one `settlementTo`'s refusal
   * actually leans on. A status added to {@link REQUEST_STATUSES} with no row out of it and
   * no word for it in the refusals is a request somebody is looking at, cannot move, and is
   * told nothing useful about — which is precisely the condition §6 exists to prevent.
   *
   * Asserted through the refusal rather than against a list of words, so it fails on the
   * afternoon somebody adds a sixth status and forgets that `inWordsSettled` has a default.
   */
  it('and every state with no way out of it is refused in words that name it', () => {
    const stuck = REQUEST_STATUSES.filter((status) => transitionsFrom(status).length === 0);

    expect(stuck.length).toBeGreaterThan(0);

    for (const status of stuck) {
      const said = status.toLowerCase();

      for (const action of RELEASING_ACTIONS) {
        expect(() => settlementTo(aRequestIn(status), action)).toThrow(
          expect.objectContaining({ message: expect.stringContaining(said) }),
        );
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
   * And every destination a *releasing* action reaches ends the request.
   *
   * This used to be said of every row, and the note explained that the approval story's
   * row would be the first with a live destination and would fail it — "which is the
   * intent: `releaseForRequest` is the wrong door for a move that commits days rather than
   * giving them back, and failing here is how that gets noticed before a balance does".
   *
   * It was noticed, and the answer was in the type system rather than here:
   * `settlementTo` and `RequestToSettle` take a {@link RELEASING_ACTIONS} member, so
   * `APPROVE` cannot reach the release door at all. What is asserted now is the property
   * that narrowing depends on — that the three verbs which release days all land somewhere
   * that has ended — and the `isSettled` answer inside `settlementTo` is unreachable
   * exactly while this passes.
   */
  it('and every releasing action lands somewhere that ends the request', () => {
    for (const action of RELEASING_ACTIONS) {
      expect(REQUEST_ACTIONS).toContain(action);

      const rows = TRANSITIONS.filter((transition) => transition.action === action);

      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        expect(isSettled(row.to)).toBe(true);
      }
    }
  });

  /**
   * And approval is the one verb that does not always move the status. FR 38a. LMS 314.
   *
   * The row says `SUBMITTED → APPROVED`, and that is where the *last* desk leaves it. Every
   * desk before the last leaves the status exactly where it is and moves the request along
   * its chain instead, which is why {@link approvalTo} exists and why the table alone
   * cannot answer where an approval lands.
   */
  it('and approval is the only row whose destination keeps the request alive', () => {
    const live = TRANSITIONS.filter((transition) => !isSettled(transition.to));

    expect(live.map((transition) => transition.action)).toEqual(['APPROVE']);
    expect(live.map((transition) => transition.to)).toEqual(['APPROVED']);
  });
});

describe('where a settlement lands', () => {
  const aRequest = aRequestIn;

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
      for (const action of RELEASING_ACTIONS) {
        expect(() => settlementTo(aRequest(status), action)).toThrow(LeaveAlreadySettled);
      }
    }
  });

  /**
   * And an approved request goes nowhere either, but is told something else. LMS 314.
   *
   * The two refusals are the same shape and different sentences, and the difference is what
   * is true. "This leave was already withdrawn and its days have been given back" is the
   * right thing to say to somebody pressing withdraw twice; said about approved leave it is
   * wrong twice over — the request has not ended, and the days are taken rather than back.
   *
   * It is the refusal `APPROVED` made necessary. Before it there was no state that was
   * running and did not answer every verb, so every miss meant one thing.
   */
  it.each([...RELEASING_ACTIONS])(
    'and %s on approved leave is refused with its own words',
    (action) => {
      const approved = aRequest('APPROVED');

      expect(() => settlementTo(approved, action)).toThrow(LeaveCannotBeMoved);
      expect(() => settlementTo(approved, action)).not.toThrow(LeaveAlreadySettled);

      try {
        settlementTo(approved, action);
      } catch (error) {
        expect((error as LeaveCannotBeMoved).code).toBe('MOVE_NOT_AVAILABLE');
        expect((error as Error).message).toContain('has been approved');
        /* And it does not claim the days are back, which is the thing that would be false. */
        expect((error as Error).message).not.toContain('given back');
      }
    },
  );

  /**
   * And taking a request back is not a question about the desk. FR 46. LMS 323.
   *
   * The property that makes "cancel a request I have not yet had approved" true of a chain
   * of any length, and it is a property of the *table* rather than of a method — which is
   * why it is asserted here rather than only against a real server.
   *
   * A `WITHDRAW` is keyed by the from-status and nothing else, and `SUBMITTED` is the whole
   * of "not yet approved" however many desks a type has and however many of them have signed
   * — the status is what says a request is still being decided, and the desk is a separate
   * column that says who is deciding it. So the same row answers a request nobody has looked
   * at and one that two approvers have already agreed to.
   *
   * The way this could stop being true is a standing: `THE_DESK_IT_IS_WITH` on the `WITHDRAW`
   * row would make taking your own leave back depend on where it had got to, and a person
   * whose request had moved past their manager would be holding days they could not release
   * until somebody else acted. That is exactly the "waste an approver's time" this story is
   * about, arriving as a policy change nobody would read as one.
   */
  it('and withdrawing is answered by the status alone, whatever desk the request is at', () => {
    for (const desk of APPROVER_ROLES) {
      expect(settlementTo(aRequestIn('SUBMITTED', desk), 'WITHDRAW')).toBe('WITHDRAWN');
    }

    expect(standingsFor('WITHDRAW')).not.toContain('THE_DESK_IT_IS_WITH');
  });
});

/* ------------------------------------------------ where an approval lands, §6 */

/**
 * Approval advances to the next stage, or to approved if none remains. FR 38, FR 38a, FR
 * 40. LMS 314's second criterion, and the whole of the routing.
 *
 * Asserted against chains written out here rather than read from a leave type, because that
 * is exactly the point: {@link approvalTo} is a function of a list of desks, and the same
 * list gives the same answers whether it came from annual leave, from unpaid leave or from
 * a type an HR Administrator adds next year. Nothing in it knows which type is which — the
 * third criterion is that unpaid leave has no manager stage, and the way that is true is
 * that no code anywhere reads a type code.
 */
describe('where an approval lands', () => {
  const waitingOn = (desk: ApproverRole): LeaveRequest => aRequestIn('SUBMITTED', desk);

  /** Manager then HR — what every type but the two unpaid ones goes through. */
  const ORDINARY: readonly ApproverRole[] = ['MANAGER', 'HR'];

  /** HR then the Chief Executive, and no manager stage at all. FR 32h, §4.3.1. */
  const UNPAID: readonly ApproverRole[] = ['HR', 'CEO'];

  it('sends a request on to the next desk, leaving it where it was', () => {
    const outcome = approvalTo(waitingOn('MANAGER'), ORDINARY, []);

    expect(outcome).toEqual({ by: 'MANAGER', to: 'SUBMITTED', awaiting: 'HR' });
    expect(isTheLastWord(outcome)).toBe(false);
  });

  it('and approves it when every stage has approved', () => {
    const outcome = approvalTo(waitingOn('HR'), ORDINARY, ['MANAGER']);

    expect(outcome).toEqual({ by: 'HR', to: 'APPROVED', awaiting: null });
    expect(isTheLastWord(outcome)).toBe(true);
  });

  /**
   * And unpaid leave goes HR then the Chief Executive, with no manager stage. LMS 314's
   * third criterion.
   *
   * The same function, the same request, a different list — and the walk skips a stage
   * nothing told it to skip, because the stage was never in the chain. A manager
   * approving this one is refused by the policy rather than routed around here; see
   * ../unit/policy.test.ts.
   */
  it('and walks an unpaid chain from HR to the Chief Executive, with no manager in it', () => {
    expect(approvalTo(waitingOn('HR'), UNPAID, [])).toEqual({
      by: 'HR',
      to: 'SUBMITTED',
      awaiting: 'CEO',
    });

    expect(approvalTo(waitingOn('CEO'), UNPAID, ['HR'])).toEqual({
      by: 'CEO',
      to: 'APPROVED',
      awaiting: null,
    });
  });

  /* And a chain of one is decided by the one desk on it, first time. A three-stage chain
     takes three, and neither is a case this function is told about — both fall out of
     walking a list. */
  it('and a chain of one desk is decided by that desk', () => {
    expect(approvalTo(waitingOn('HR'), ['HR'], [])).toMatchObject({
      to: 'APPROVED',
      awaiting: null,
    });
  });

  it('and a chain of three is walked all the way down', () => {
    const chain: readonly ApproverRole[] = ['MANAGER', 'HR', 'CEO'];

    expect(approvalTo(waitingOn('MANAGER'), chain, []).awaiting).toBe('HR');
    expect(approvalTo(waitingOn('HR'), chain, ['MANAGER']).awaiting).toBe('CEO');
    expect(approvalTo(waitingOn('CEO'), chain, ['MANAGER', 'HR']).awaiting).toBeNull();
  });

  /**
   * And a request standing on a desk the chain no longer has is refused by name.
   *
   * The seam in reading the chain live rather than copying it onto the request. HR changes
   * annual leave from manager-then-HR to HR alone while somebody's request sits with their
   * manager; the manager approves.
   *
   * LMS 314 refused it because the walk would otherwise have approved the leave. LMS 316
   * removed that danger — the chain still has a stage nobody has signed, so the walk would
   * route the request to HR rather than approve it — and the refusal stays for the reason
   * that survived: every approval on record has to belong to a stage, or "every stage has
   * approved" is a claim about a set with strangers in it.
   *
   * The message carries both chains, because the person who meets it is an approver who has
   * done nothing wrong.
   */
  it('and refuses a request waiting on a desk the chain has since dropped', () => {
    expect(() => approvalTo(waitingOn('MANAGER'), ['HR'], [])).toThrow(
      expect.objectContaining({ name: 'ApprovalChainChanged', code: 'CHAIN_CHANGED' }),
    );

    try {
      approvalTo(waitingOn('MANAGER'), ['HR'], []);
    } catch (error) {
      expect((error as Error).message).toContain('your line manager');
      expect((error as Error).message).toContain('changed to HR');
    }
  });

  /* And a widening at the end is not a refusal. The Chief Executive added after HR is HR
     asking for one more signature, which is what the administrator meant by adding them. */
  it('but follows a chain that has grown a stage at the end since the request was made', () => {
    expect(approvalTo(waitingOn('HR'), ['MANAGER', 'HR', 'CEO'], ['MANAGER']).awaiting).toBe('CEO');
  });

  /**
   * And a stage added *in front of* a request in flight is asked before it is agreed. FR
   * 41. LMS 316, and the case the old walk got wrong.
   *
   * The manager has signed and the request is with HR. An HR Administrator puts the Chief
   * Executive at the head of the chain — FR 31 says they may — and HR approves.
   *
   * `approverAfter(chain, 'HR')` was the old question, and in `[CEO, MANAGER, HR]` the desk
   * after HR is nothing: the leave would have been approved on the spot, with the Chief
   * Executive never seeing a request the policy now routes to them, and the employee told
   * it was agreed. Asking which stage has not signed answers CEO.
   */
  it('and asks a stage added in front of where the request had got to', () => {
    const widened: readonly ApproverRole[] = ['CEO', 'MANAGER', 'HR'];

    const outcome = approvalTo(waitingOn('HR'), widened, ['MANAGER']);

    expect(outcome).toEqual({ by: 'HR', to: 'SUBMITTED', awaiting: 'CEO' });
    expect(isTheLastWord(outcome)).toBe(false);
  });

  /* And it is agreed only once that stage has signed too, which is the criterion in one
     line: every stage, not every stage that happened to be in the chain at the time. */
  it('and is agreed only once that stage has signed as well', () => {
    const widened: readonly ApproverRole[] = ['CEO', 'MANAGER', 'HR'];

    expect(approvalTo(waitingOn('CEO'), widened, ['MANAGER', 'HR'])).toEqual({
      by: 'CEO',
      to: 'APPROVED',
      awaiting: null,
    });
  });

  /* And an approval recorded at a desk the chain does not name counts for nothing. It
     cannot happen through the door — `ApprovalChainChanged` refuses it — and if a row for
     one existed the walk would still ask every stage. */
  it('and a signature from outside the chain does not stand in for a stage', () => {
    expect(approvalTo(waitingOn('HR'), UNPAID, ['MANAGER'])).toEqual({
      by: 'HR',
      to: 'SUBMITTED',
      awaiting: 'CEO',
    });
  });
});

/* ------------------------------------------------- where a request has got to */

/**
 * What a person is told about a request they are about to book a flight on. FR 41, FR 42.
 * LMS 316.
 *
 * The story's "so that", and the half that is not about routing: *I never take leave
 * believing it was agreed when it was not*. Every fact needed to be wrong about that is
 * stored, and it is stored in four places — the status, the desk, the decisions, the chain —
 * so `progressOf` is the one reading of all four, and `agreed` is what somebody acts on.
 */
describe('how far through its chain a request has got', () => {
  const ORDINARY: readonly ApproverRole[] = ['MANAGER', 'HR'];

  it('is not agreed while a stage is still to approve, however many have', () => {
    const progress = progressOf({
      request: aRequestIn('SUBMITTED', 'HR'),
      chain: ORDINARY,
      approvedBy: ['MANAGER'],
    });

    expect(progress.agreed).toBe(false);
    expect(progress.approvedBy).toEqual(['MANAGER']);
    expect(progress.stillToApprove).toEqual(['HR']);
    expect(progress.awaiting).toBe('HR');
  });

  /* And the sentence says so first. A screen that showed only the newest decision would say
     "Approved by your line manager", which is true and is the exact belief this story is
     written against — so the two halves are one string composed once rather than two fields
     a screen may show one of. */
  it('and says so before it says who has approved', () => {
    const { inWords } = progressOf({
      request: aRequestIn('SUBMITTED', 'HR'),
      chain: ORDINARY,
      approvedBy: ['MANAGER'],
    });

    expect(inWords).toMatch(/not agreed yet/);
    expect(inWords).toMatch(/do not book anything on it/);
    expect(inWords).toMatch(/Approved by your line manager/);
    expect(inWords).toMatch(/still needs HR/);
  });

  it('and is agreed once the request is approved', () => {
    const progress = progressOf({
      request: aRequestIn('APPROVED'),
      chain: ORDINARY,
      approvedBy: ['MANAGER', 'HR'],
    });

    expect(progress.agreed).toBe(true);
    expect(progress.stillToApprove).toEqual([]);
    expect(progress.stagesMissing).toEqual([]);
    expect(progress.inWords).toMatch(/agreed and is yours to take/);
  });

  /**
   * And `agreed` is the status rather than an arithmetic over today's chain.
   *
   * The tempting definition is "every stage of the chain has approved", and it is wrong
   * about leave that was properly agreed under a chain that has since grown: the days are
   * already taken, the request was approved by everybody it was routed to, and a screen
   * computing the answer afresh would tell the person their leave is not agreed after all.
   * What was recorded is what happened. `stagesMissing` is where the difference is reported
   * rather than hidden.
   */
  it('and stays agreed when a stage is added to the chain afterwards', () => {
    const progress = progressOf({
      request: aRequestIn('APPROVED'),
      chain: ['CEO', 'MANAGER', 'HR'],
      approvedBy: ['MANAGER', 'HR'],
    });

    expect(progress.agreed).toBe(true);
    expect(progress.stagesMissing).toEqual(['CEO']);
    /* And it is not put in anybody's queue by saying so. */
    expect(progress.stillToApprove).toEqual([]);
    expect(progress.awaiting).toBeNull();
  });

  /* And a request that has ended is not waiting on anybody, whatever the chain says. A
     withdrawn request reading "still waiting on HR" is the queue entry
     `leave_request_waits_at_a_desk` keeps out of the schema, arriving in the reading. */
  it('and a request that has ended waits on nobody', () => {
    const progress = progressOf({
      request: aRequestIn('REFUSED'),
      chain: ORDINARY,
      approvedBy: ['MANAGER'],
    });

    expect(progress.agreed).toBe(false);
    expect(progress.stillToApprove).toEqual([]);
    expect(progress.awaiting).toBeNull();
    expect(progress.inWords).toMatch(/was refused and is not yours to take/);
    expect(progress.inWords).toMatch(/days are back/);
  });

  it('and a request nobody has looked at yet says exactly that', () => {
    const { inWords } = progressOf({
      request: aRequestIn('SUBMITTED', 'MANAGER'),
      chain: ORDINARY,
      approvedBy: [],
    });

    expect(inWords).toMatch(/Nobody has approved it yet/);
    expect(inWords).toMatch(/still needs your line manager then HR/);
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
      {
        from: 'SUBMITTED',
        action: 'APPROVE',
        to: 'APPROVED',
        by: ['THE_DESK_IT_IS_WITH'],
      },
    ]);
  });

  /* And the vocabulary it is keyed by, for the same reason. A standing added here
     without a branch in `hasStanding` does not compile; one added and left out of every
     row is a concept nothing uses. */
  it('and is keyed by the four actions and the four standings there are', () => {
    expect([...REQUEST_ACTIONS]).toEqual(['WITHDRAW', 'REFUSE', 'CANCEL', 'APPROVE']);
    expect([...STANDINGS]).toEqual([
      'THE_REQUESTER',
      'THEIR_LINE_MANAGER',
      'LEAVE_ADMINISTRATION',
      'THE_DESK_IT_IS_WITH',
    ]);
  });

  /**
   * And the three that release days are exactly the three that are not approval.
   *
   * `RELEASING_ACTIONS` is written out rather than derived, for the reason
   * `RELEASING_STATUSES` is: "every action but the approving one" is a definition that
   * absorbs whatever verb arrives next, and the next one — FR 26's cancelling of leave
   * already agreed — would land in it by subtraction and post a `RELEASE` against days that
   * have already been taken. This is what holds the two lists together in the meantime.
   */
  it('and the releasing actions are a sub-list of them, written out rather than subtracted', () => {
    expect([...RELEASING_ACTIONS]).toEqual(['WITHDRAW', 'REFUSE', 'CANCEL']);

    for (const action of RELEASING_ACTIONS) {
      expect(REQUEST_ACTIONS).toContain(action);
    }
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
    expect(() => settlementTo(aRequestIn('WITHDRAWN'), 'WITHDRAW')).toThrow(LeaveAlreadySettled);
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
   *
   * **This is the assertion LMS 314 had to be built around**, and it is worth saying so.
   * Approval needed a second kind of move — one that changes the desk a request is waiting
   * at and leaves the status alone — and the obvious shape for it was an `advance()` beside
   * `settle()`. Two methods, both correct, both writing the column: exactly the second
   * writer this test exists to find. So there is one method, `moveTo`, and both doors go
   * through it.
   */
  it('and exactly one statement in it sets a status', () => {
    const repository = sources.find(
      ({ file }) => file === 'repositories/leave-request-repository.ts',
    );

    expect(repository).toBeDefined();
    expect(repository?.code.match(/\.set\(\s*\{\s*status/g) ?? []).toHaveLength(1);
  });

  /**
   * And one file calls it: the door that writes the movement in the same transaction.
   *
   * `BalanceService` rather than `LeaveRequestService` itself, and that is the ledger's
   * one-door rule winning over this one where they meet — the status and the movement have
   * to land together, and movements are written in one place. The state machine is still the
   * only way in: it is `LeaveRequestService` that decides the move, and it reaches the write
   * through that door and nowhere else.
   */
  it('and one file calls the repository method that does it', () => {
    const calling = sources.filter(({ code }) => /requests\.moveTo\s*\(/.test(code));

    expect(calling.map(({ file }) => file)).toEqual(['services/balance-service.ts']);
  });

  /**
   * And the destination it writes is the table's, not a caller's.
   *
   * The one that would undo the whole criterion quietly: a door taking a status and writing
   * it. Both take an *action* — one implicitly, by being the approval door — and ask the
   * table inside the lock, so a caller cannot name where a request ends up.
   *
   * `approveForRequest` is the sharper case since LMS 314, because it is handed a chain and
   * could plausibly have been handed an outcome. It is not: `approvalTo` is called again
   * inside the transaction, and a caller that could pass the destination could approve a
   * request one desk early.
   */
  it('and the door asks the table where the request lands', () => {
    const door = sources.find(({ file }) => file === 'services/balance-service.ts');

    expect(door?.code).toMatch(/settlementTo\(/);
    expect(door?.code).toMatch(/approvalTo\(/);
    expect(door?.code).toMatch(/holdStill\(/);
  });

  /* And nothing outside the state machine and its doors decides where a move lands. A
     third caller of either lookup is a third place that knows the state machine. */
  it.each([
    ['settlementTo', /\bsettlementTo\s*\(/],
    ['approvalTo', /\bapprovalTo\s*\(/],
  ])('and only the state machine and its door consult the table for %s', (_name, pattern) => {
    const consulting = sources.filter(({ code }) => pattern.test(code));

    expect(consulting.map(({ file }) => file).sort()).toEqual([
      'domain/leave-request.ts',
      'services/balance-service.ts',
      'services/leave-request-service.ts',
    ]);
  });
});
