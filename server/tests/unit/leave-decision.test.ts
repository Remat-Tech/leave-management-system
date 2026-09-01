import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECIDING_ACTIONS,
  desksThatApproved,
  isADecision,
  type LeaveDecision,
  readComment,
  RefusalNeedsAComment,
  requireAComment,
  theRefusal,
  validateDecision,
} from '../../src/domain/leave-decision.js';
import { RELEASING_ACTIONS, REQUEST_ACTIONS } from '../../src/domain/leave-request.js';

/**
 * Approving or turning down leave, with a comment. FR 39, FR 52. LMS 315.
 *
 * The story is a person who has been told no finding out why without chasing anybody, and
 * the two criteria that can be checked without a database are the two about the comment: a
 * refusal must carry one and an approval need not.
 *
 * The third criterion — who, when, and on whose behalf — is stamped by the database from
 * the transaction the write is made in, so ../integration/leave-request.test.ts carries it.
 * There is nothing a pure function can be asked about a column three triggers away.
 *
 * ## What is here, and why the source-reading half is here too
 *
 * The rules about the comment, and then a claim about code that does not exist: that one
 * repository writes a decision and one service calls it. That is the same technique
 * ./one-writer.test.ts uses on the ledger and ./state-machine.test.ts uses on the status
 * column, and the reason is the same — the realistic second writer is an honest service
 * recording a decision from somewhere sensible and outside the transaction that moves the
 * request, at which point a refusal can commit while the refusing rolls back.
 */

/* ------------------------------------------------ the two verbs that are a decision */

describe('the verbs that are a decision at a desk', () => {
  it('is a sub-list of the actions there are', () => {
    for (const action of DECIDING_ACTIONS) {
      expect(REQUEST_ACTIONS).toContain(action);
    }
  });

  /**
   * And it is written out rather than subtracted from anything.
   *
   * Pinned in full for the reason `TRANSITIONS` is: a property holds just as well for a
   * list somebody has widened, and the widening that matters here is FR 26's cancelling of
   * leave already agreed. That is an administrative unwinding, it would land in this list by
   * any subtraction anybody would write, and it would start demanding that HR justify
   * correcting a row that was entered twice.
   */
  it('and is exactly approving and refusing', () => {
    expect([...DECIDING_ACTIONS]).toEqual(['APPROVE', 'REFUSE']);
  });

  /**
   * And the two it leaves out are the two that end a request without deciding it.
   *
   * Withdrawing is somebody taking their own request back and cancelling is HR unwinding a
   * row that should not be on the books. Refusing is in both lists, and that overlap is not
   * an accident of the lists — it is the one act that both ends a request and is a judgement
   * about it, which is why the release door is the one that writes a decision.
   */
  it('and the endings that are not decisions are withdrawing and cancelling', () => {
    const notDecided = RELEASING_ACTIONS.filter((action) => !isADecision(action));

    expect(notDecided).toEqual(['WITHDRAW', 'CANCEL']);
    expect(isADecision('REFUSE')).toBe(true);
    expect(isADecision('APPROVE')).toBe(true);
  });
});

/* ------------------------------------------------------------------- the comment */

describe('what a refusal has to say', () => {
  /* The story's first criterion. */
  it('is refused when there is nothing there at all', () => {
    for (const nothing of [undefined, null, '', '   ', '\n\t', 7, {}]) {
      expect(() => requireAComment(nothing)).toThrow(RefusalNeedsAComment);
    }
  });

  /**
   * And the refusal says what the comment is for rather than that a field is required.
   *
   * NFR USA 03, and the likely reader is a manager in a hurry who thinks of it as
   * paperwork. The `code` is what a form branches on to put the cursor in the box, and the
   * `field` is what puts the message beside it.
   */
  it('and says why the reason matters, with a code a form can branch on', () => {
    try {
      requireAComment('  ');
      expect.unreachable('a refusal with nothing said should not be accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(RefusalNeedsAComment);
      expect((error as RefusalNeedsAComment).code).toBe('REFUSAL_NEEDS_A_COMMENT');
      expect((error as RefusalNeedsAComment).field).toBe('comment');
      expect((error as Error).message).toMatch(/owed the reason in writing/);
    }
  });

  /* And a comment that is there is kept, trimmed. Nothing else is done to it — no length,
     no list of permitted values. A reason nobody can write freely is a reason everybody
     writes 'no' in. */
  it('and keeps what was written, trimmed and otherwise untouched', () => {
    expect(requireAComment('  The team cannot cover both of you that week. ')).toBe(
      'The team cannot cover both of you that week.',
    );
  });
});

describe('what an approval may say', () => {
  /* The story's second criterion, and the whole of the asymmetry: the same input that is
     refused above is simply nothing here. */
  it('is nothing at all, and nothing is a null rather than an empty string', () => {
    for (const nothing of [undefined, null, '', '   ', 7, {}]) {
      expect(readComment(nothing)).toBeNull();
    }
  });

  it('and is kept, trimmed, where somebody had something to add', () => {
    expect(readComment('  Enjoy the wedding  ')).toBe('Enjoy the wedding');
  });
});

/* --------------------------------------------------------- what is written down */

describe('a decision on its way to being written', () => {
  const aRefusal = { leaveRequestId: '41', action: 'REFUSE', onBehalfOf: 'MANAGER' } as const;
  const anApproval = { leaveRequestId: '41', action: 'APPROVE', onBehalfOf: 'HR' } as const;

  it('carries the desk it answers for, and the request it is about', () => {
    expect(validateDecision({ ...anApproval, comment: 'Fine by me' })).toEqual({
      leaveRequestId: '41',
      action: 'APPROVE',
      onBehalfOf: 'HR',
      comment: 'Fine by me',
    });
  });

  it('and an approval with nothing said is a decision all the same', () => {
    expect(validateDecision({ ...anApproval, comment: undefined })).toMatchObject({
      action: 'APPROVE',
      comment: null,
    });
  });

  /* The same rule as `requireAComment`, asked again where the row is composed. The service
     refuses first, for the sentence; this is the one that stands between a caller and the
     table. */
  it('and a refusal with nothing said never becomes a row', () => {
    expect(() => validateDecision({ ...aRefusal, comment: '   ' })).toThrow(RefusalNeedsAComment);
  });

  it('and a refusal with a reason keeps it', () => {
    expect(
      validateDecision({ ...aRefusal, comment: 'Two of you are away that week' }),
    ).toMatchObject({
      action: 'REFUSE',
      onBehalfOf: 'MANAGER',
      comment: 'Two of you are away that week',
    });
  });

  /**
   * And nothing here decides who or when.
   *
   * `stamp_the_decider_on_a_decision()` overwrites all three, and the shape of
   * {@link ValidatedDecision} is what makes that unmistakable at the call site: a caller
   * that could name the decider could record a refusal under somebody else's name, and one
   * that could date it could put a decision before the request it decides.
   */
  it('and says nothing about who decided it or when', () => {
    const written = validateDecision({ ...anApproval, comment: null });

    expect(Object.keys(written).sort()).toEqual([
      'action',
      'comment',
      'leaveRequestId',
      'onBehalfOf',
    ]);
  });
});

/* ------------------------------------------------------------ reading them back */

describe('the refusal among a request’s decisions', () => {
  const decision = (action: 'APPROVE' | 'REFUSE', comment: string | null): LeaveDecision => ({
    id: action,
    leaveRequestId: '41',
    action,
    onBehalfOf: 'MANAGER',
    comment,
    decidedBy: 'employee 7',
    decidedByEmployeeId: '7',
    decidedAt: new Date('2026-03-01T09:00:00Z'),
  });

  it('is the one a screen puts in front of the person who asked', () => {
    const found = theRefusal([decision('APPROVE', null), decision('REFUSE', 'No cover')]);

    expect(found?.comment).toBe('No cover');
  });

  /* And a request that was approved has none, which is every request but the turned-down
     ones. Named once rather than filtered at each call site, because "why was this refused"
     has a single answer — refusing ends a request — and two `find`s are two answers waiting
     to disagree. */
  it('and there is none on a request nobody turned down', () => {
    expect(theRefusal([decision('APPROVE', null)])).toBeUndefined();
    expect(theRefusal([])).toBeUndefined();
  });
});

/* ------------------------------------------------- what the walk is asked */

/**
 * The desks that have said yes, which is what "every stage has approved" is read against.
 * FR 41. LMS 316.
 *
 * The reason this table could carry the next story at all: until these rows existed there was
 * a cursor saying where a request had got to and nothing saying who had actually signed, and
 * the two agree only while nobody edits a chain.
 */
describe('the desks that have approved a request', () => {
  const decision = (
    action: 'APPROVE' | 'REFUSE',
    onBehalfOf: 'MANAGER' | 'HR' | 'CEO',
  ): LeaveDecision => ({
    id: `${onBehalfOf}-${action}`,
    leaveRequestId: '41',
    action,
    onBehalfOf,
    comment: action === 'REFUSE' ? 'No cover' : null,
    decidedBy: 'employee 7',
    decidedByEmployeeId: '7',
    decidedAt: new Date('2026-03-01T09:00:00Z'),
  });

  it('is the desks, in the order they decided', () => {
    expect(desksThatApproved([decision('APPROVE', 'MANAGER'), decision('APPROVE', 'HR')])).toEqual([
      'MANAGER',
      'HR',
    ]);
  });

  /* And a refusal is not an approval, which is filtering rather than mapping. A refused
     request has ended so it never reaches the walk; the filter is what keeps that true if
     it ever does. */
  it('and a refusal is not one of them', () => {
    expect(desksThatApproved([decision('APPROVE', 'MANAGER'), decision('REFUSE', 'HR')])).toEqual([
      'MANAGER',
    ]);
  });

  it('and a request nobody has decided has none', () => {
    expect(desksThatApproved([])).toEqual([]);
  });
});

/* ---------------------------------------------- one writer of a decision */

const SOURCE = join(process.cwd(), 'server', 'src');

/** Read with the comments taken out; these files discuss decisions at length. */
const sources = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({
    file: file.replaceAll('\\', '/'),
    code: readFileSync(join(SOURCE, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' '),
  }));

/**
 * A decision is written by one repository, from one service, inside the transaction that
 * moves the request. FR 39, FR 52. LMS 315.
 *
 * The realistic second writer is an honest one, exactly as it is for the ledger and for the
 * status column: a queue screen that records the manager's comment as it renders, a bulk
 * approval that writes the decisions in a loop and the statuses in another. Each is
 * reasonable, and each can leave a refusal committed against a request that was never
 * refused, or a request refused with the reason lost to a rollback.
 *
 * `leave_request_records_its_decision` refuses the second of those at COMMIT on every
 * connection. What it cannot refuse is the first, and this is what does.
 */
describe('one writer of a decision', () => {
  it('there is source to read', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  /* The positive half first, and it is not a formality: a filter that finds nothing passes
     whether the rule holds or the pattern has stopped matching. */
  it('and only its repository inserts one', () => {
    const inserts = /insertInto\(\s*['"]leave_request_decision['"]\s*\)/;

    const repository = sources.find(
      ({ file }) => file === 'repositories/leave-decision-repository.ts',
    );

    expect(repository?.code).toMatch(inserts);

    expect(
      sources
        .filter(
          ({ file, code }) =>
            file !== 'repositories/leave-decision-repository.ts' && inserts.test(code),
        )
        .map(({ file }) => file),
    ).toEqual([]);
  });

  /**
   * And one file records through it: the door that moves the status in the same
   * transaction.
   *
   * `BalanceService` rather than `LeaveRequestService`, which is the arrangement the status
   * column already has and for the same reason — the decision and the move it explains have
   * to land together, and the seam that owns transactions is reachable from there.
   */
  it('and one file calls the repository method that writes it', () => {
    const calling = sources.filter(({ code }) => /decisions\.record\s*\(/.test(code));

    expect(calling.map(({ file }) => file)).toEqual(['services/balance-service.ts']);
  });

  /* And the rule about the comment is consulted only where a row is composed. A third
     caller of `validateDecision` is a third place that decides what a decision has to say. */
  it('and only the domain and that door compose one', () => {
    const composing = sources.filter(({ code }) => /\bvalidateDecision\s*\(/.test(code));

    expect(composing.map(({ file }) => file).sort()).toEqual([
      'domain/leave-decision.ts',
      'services/balance-service.ts',
    ]);
  });

  /**
   * And nothing anywhere supplies who decided it or when.
   *
   * The three stamped columns, asserted by their absence from every file but the one that
   * declares them — which is the only end of that rule this side of the database can hold.
   * `stamp_the_decider_on_a_decision()` overwrites all three whatever is sent, so what this
   * catches is not a value getting through: it is the afternoon somebody adds
   * `decided_by_employee_id` to a row builder because a test wanted a particular name on it,
   * and then reads the column back believing it.
   *
   * ../../src/db/schema.ts is the exception and is named rather than hidden, and it is
   * asserted for the property that makes it one: all three are typed `never` on the way in,
   * so a writer that tried does not compile.
   */
  it('and nothing supplies the decider, the id or the instant', () => {
    const stamping = sources.filter(
      ({ file, code }) =>
        file !== 'db/schema.ts' &&
        /decided_by\s*:|decided_at\s*:|decided_by_employee_id\s*:/.test(code),
    );

    expect(stamping.map(({ file }) => file)).toEqual([]);

    const schema = sources.find(({ file }) => file === 'db/schema.ts');

    for (const column of ['decided_by', 'decided_by_employee_id']) {
      expect(schema?.code).toMatch(
        new RegExp(`${column}:\\s*ColumnType<[^>]*,\\s*never,\\s*never>`),
      );
    }

    /* `decided_at` goes through the file's own `Timestamp`, which is
       `ColumnType<Date, never, never>` — the same alias every other stamped instant in this
       schema uses, and the reason this one is asserted by its name rather than by its
       shape. */
    expect(schema?.code).toMatch(/decided_at:\s*Timestamp;/);
  });
});
