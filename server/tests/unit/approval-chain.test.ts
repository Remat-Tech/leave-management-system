import { describe, expect, it } from 'vitest';
import {
  APPROVER_ROLES,
  chainInWords,
  chainOf,
  DEFAULT_APPROVAL_CHAIN,
  firstApprover,
  InvalidApprovalChain,
  isApprovable,
  isApprovedBy,
  LONGEST_CHAIN,
  nextUnapproved,
  readApproverRole,
  stagesNotApproved,
  stepsOf,
  validateApprovalChain,
} from '../../src/domain/approval-chain.js';
import { ROLE_CODES, readRoleCode, UnknownRole } from '../../src/auth/roles.js';
import {
  assertSomebodyApprovesIt,
  approvalChainInWords,
  type LeaveType,
  NobodyApprovesLeaveType,
  validateNewLeaveType,
} from '../../src/domain/leave-type.js';

/**
 * Who approves a kind of leave, and in what order. FR 38a, §5.5. LMS 204.
 *
 * The walk and the shaping are pure functions, so this is where the story is
 * proved. ../integration/approval-chain.test.ts shows that the seven types of
 * FR 32 really carry these chains on a migrated database, that the two unpaid
 * ones really go to HR and the Chief Executive, and that the database holds the
 * same rules as constraints.
 *
 * The property every test below is really about is the one design principle 5 of
 * the Technical Design Document states and the README repeats: **the chain is
 * configuration, and no part of it is a branch on a type code.** Nothing here
 * builds a type called maternity and expects a chain from it. Every assertion
 * sets the chain and reads the answer back, which is the only way to tell a
 * system that is configured from one that has the seven cases written into it.
 *
 * The distinction that gets the most attention is the one that will cause the
 * most trouble if it is ever lost: **an approver role is not a role code.** Three
 * desks, MANAGER, HR and CEO, against four grants, EMPLOYEE, HR_OFFICER, HR_ADMIN
 * and SYS_ADMIN. Two of the three desks have no row in `role` to be — a manager is
 * a relationship and the Chief Executive is a position — and the day somebody
 * joins the two sets is the day an approver queue is quietly wrong.
 */

describe('the three desks a chain names, FR 38a', () => {
  it('are manager, HR and the CEO, and nothing else', () => {
    expect([...APPROVER_ROLES]).toEqual(['MANAGER', 'HR', 'CEO']);
  });

  /* The load bearing separation, asserted from both sides. ../../src/auth/roles.ts
     refuses MANAGER as a grant in as many words — "Being a manager is a
     relationship... Holding it as a role too would create two sources of truth" —
     and CEO is FR 04's single root rather than anything anybody grants. A chain
     names the desk; how the desk is found is three different questions. */
  it('are not role codes, and no role code is one of them', () => {
    for (const desk of APPROVER_ROLES) {
      expect(ROLE_CODES as readonly string[]).not.toContain(desk);
      expect(() => readRoleCode(desk)).toThrow(UnknownRole);
    }

    for (const code of ROLE_CODES) {
      expect(APPROVER_ROLES as readonly string[]).not.toContain(code);
      expect(() => readApproverRole(code)).toThrow(InvalidApprovalChain);
    }
  });

  /* HR is the desk, not the grant, and the two people who staff it hold two
     different codes. An HR Administrator configuring a leave type should not have
     to decide which of them is on duty. */
  it('name HR as one desk, though two roles staff it', () => {
    expect(readApproverRole('HR')).toBe('HR');
    expect(() => readApproverRole('HR_OFFICER')).toThrow(InvalidApprovalChain);
    expect(() => readApproverRole('HR_ADMIN')).toThrow(InvalidApprovalChain);
  });

  it('read the same desk however it was typed', () => {
    expect(readApproverRole('  ceo  ')).toBe('CEO');
    expect(readApproverRole('Manager')).toBe('MANAGER');
  });

  /* Three desks, each asked once, so three stages is as long as a chain can be.
     That follows from the desks rather than from anybody's view about how many
     approvals are sensible, which is why it is read off the list. */
  it('put a ceiling on a chain without anybody writing one down', () => {
    expect(LONGEST_CHAIN).toBe(APPROVER_ROLES.length);
    expect(validateApprovalChain([...APPROVER_ROLES])).toHaveLength(LONGEST_CHAIN);
  });
});

describe('the default chain, which is the story’s second criterion', () => {
  it('is the manager and then HR', () => {
    expect([...DEFAULT_APPROVAL_CHAIN]).toEqual(['MANAGER', 'HR']);
  });

  /* A type created without a word about approvals is approved by somebody. The
     alternative — an empty chain read as "the default" at query time — would put
     the rule back in the code and leave the configuration screen showing nothing
     for annual leave. */
  it('is what a type created without one is given', () => {
    expect(
      validateNewLeaveType({
        code: 'STUDY',
        name: 'Study Leave',
        countingBasis: 'WORKING_DAYS',
        entitlementBasis: 'QUOTA',
      }).approvalChain,
    ).toEqual(['MANAGER', 'HR']);
  });

  it('is not applied over a chain the caller actually gave', () => {
    expect(
      validateNewLeaveType({
        code: 'SABBATICAL',
        name: 'Sabbatical',
        countingBasis: 'WORKING_DAYS',
        entitlementBasis: 'EVENT',
        approvalChain: ['HR', 'CEO'],
      }).approvalChain,
    ).toEqual(['HR', 'CEO']);
  });
});

describe('what a chain may be', () => {
  it('takes the desks in the order they were given, however they were typed', () => {
    expect(validateApprovalChain(['hr', ' ceo '])).toEqual(['HR', 'CEO']);
  });

  /* HR then the manager is unusual and legitimate. A rule about which desk may
     come first would be a policy invented in the validator rather than one the
     SRS asks for, which is the failure mode the leave type table was built to
     avoid. */
  it('allows any order, because the order is the policy', () => {
    expect(validateApprovalChain(['HR', 'MANAGER'])).toEqual(['HR', 'MANAGER']);
    expect(validateApprovalChain(['CEO'])).toEqual(['CEO']);
  });

  /* Refused rather than dropped. A chain quietly shortened by one is a chain
     missing an approval nobody will notice is missing. */
  it('refuses a desk nobody knows how to find', () => {
    expect(() => validateApprovalChain(['MANAGER', 'DIRECTOR'])).toThrow(InvalidApprovalChain);
    expect(() => validateApprovalChain(['LINE_MANAGER'])).toThrow(InvalidApprovalChain);
  });

  /* A type nobody approves is a type whose requests are approved by nobody or by
     everybody, and neither is a decision anybody made. "Nobody may ask for this"
     is retiring the type, and the message says so. */
  it('refuses a chain with nobody in it', () => {
    expect(() => validateApprovalChain([])).toThrow(/at least one approver/);
    expect(() => validateApprovalChain([])).toThrow(/retire it/);
  });

  it('refuses a chain that asks the same desk twice', () => {
    expect(() => validateApprovalChain(['HR', 'MANAGER', 'HR'])).toThrow(/twice/);
  });

  it('refuses something that is not a list at all', () => {
    expect(() => validateApprovalChain('MANAGER')).toThrow(InvalidApprovalChain);
    expect(() => validateApprovalChain(undefined)).toThrow(InvalidApprovalChain);
  });

  /* NFR USA 03. The message goes next to the input it is about, so the refusal
     has to say which input that is. */
  it('names the field a form should put the message beside', () => {
    try {
      validateApprovalChain(['NOBODY']);
      throw new Error('That was accepted, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidApprovalChain);
      expect((error as InvalidApprovalChain).field).toBe('approvalChain');
    }
  });
});

describe('a chain as rows and back', () => {
  /* The numbering is produced from the list rather than supplied, which is what
     makes a gap impossible from this side. leave_type_approval_chain_is_whole is
     the same rule for every other writer. */
  it('numbers the steps from one, in the order the chain was given', () => {
    expect(stepsOf(['HR', 'CEO'])).toEqual([
      { stepOrder: 1, approverRole: 'HR' },
      { stepOrder: 2, approverRole: 'CEO' },
    ]);
  });

  /* Sorted on the way back rather than trusted to arrive sorted, so that the one
     query which forgets an ORDER BY cannot silently reverse who signs off first
     — which would send every unpaid request to the Chief Executive before HR had
     seen it. */
  it('reads the chain back in order however the rows arrived', () => {
    expect(
      chainOf([
        { stepOrder: 2, approverRole: 'HR' },
        { stepOrder: 1, approverRole: 'MANAGER' },
      ]),
    ).toEqual(['MANAGER', 'HR']);
  });

  it('survives the round trip it will actually make', () => {
    for (const chain of [['MANAGER', 'HR'], ['HR', 'CEO'], ['CEO']] as const) {
      expect(chainOf(stepsOf([...chain]))).toEqual([...chain]);
    }
  });
});

describe('the walk, which is what routing will read', () => {
  const MOST_TYPES = validateApprovalChain(['MANAGER', 'HR']);
  const UNPAID = validateApprovalChain(['HR', 'CEO']);

  it('sends a request to the first desk in the chain', () => {
    expect(firstApprover(MOST_TYPES)).toBe('MANAGER');
    expect(firstApprover(UNPAID)).toBe('HR');
  });

  /**
   * And the front of the list is where a request nobody has decided goes.
   *
   * `firstApprover` is a question about the chain and `nextUnapproved` is a
   * question about the chain and what has happened; they agree for a request with
   * no decisions on it, which every new one is. Asserted so that submission going
   * through the first and routing going through the second cannot come apart.
   */
  it('and that is the same desk the walk sends an undecided request to', () => {
    for (const chain of [MOST_TYPES, UNPAID]) {
      expect(nextUnapproved(chain, [])).toBe(firstApprover(chain));
    }
  });

  /* The whole of the story, said as one assertion: unpaid leave goes to HR and
     the CEO while everything else goes to the manager, and the difference is two
     lists rather than two branches. */
  it('sends unpaid leave to HR and then the CEO, and everything else to the manager', () => {
    expect(nextUnapproved(UNPAID, ['HR'])).toBe('CEO');
    expect(nextUnapproved(UNPAID, ['HR', 'CEO'])).toBeUndefined();

    expect(nextUnapproved(MOST_TYPES, ['MANAGER'])).toBe('HR');
    expect(nextUnapproved(MOST_TYPES, ['MANAGER', 'HR'])).toBeUndefined();
  });

  /**
   * Undefined is what "every stage has approved" looks like, and it is the one
   * thing it can mean. FR 41. LMS 316.
   *
   * This used to read "undefined after the last desk… and it is the same
   * undefined a desk outside the chain produces — which is why isFinalApprover
   * exists rather than callers comparing to undefined". Both halves are gone with
   * `approverAfter`: the walk is no longer asked about a desk at all, so there is
   * no desk it can be asked about wrongly, and undefined means the list of
   * unsigned stages is empty.
   */
  it('runs out only once every stage has signed', () => {
    expect(stagesNotApproved(MOST_TYPES, [])).toEqual(['MANAGER', 'HR']);
    expect(stagesNotApproved(MOST_TYPES, ['MANAGER'])).toEqual(['HR']);
    expect(stagesNotApproved(MOST_TYPES, ['MANAGER', 'HR'])).toEqual([]);
  });

  /**
   * And a stage added in front of a request in flight is still asked. LMS 316's
   * first criterion, and the case `approverAfter` got wrong.
   *
   * The manager has signed and HR is about to. Under the old walk, "the desk after
   * HR" in `[CEO, MANAGER, HR]` is nothing, so HR's yes approved the leave and the
   * Chief Executive never saw it. Asking which stage has *not* signed cannot make
   * that mistake, because it is a question about the whole chain rather than about
   * one position in it.
   */
  it('and asks a stage added in front of where a request had got to', () => {
    const widened = validateApprovalChain(['CEO', 'MANAGER', 'HR']);

    expect(nextUnapproved(widened, ['MANAGER', 'HR'])).toBe('CEO');
    expect(nextUnapproved(widened, ['MANAGER', 'HR', 'CEO'])).toBeUndefined();
  });

  /* And the order is the chain's, so a request still travels it the way an HR
     Administrator wrote it — what the order does not decide is when the request is
     agreed, which is "none left" and is a question about a set. */
  it('and asks in the order the chain is written, whatever order they signed in', () => {
    expect(nextUnapproved(validateApprovalChain(['CEO', 'MANAGER', 'HR']), [])).toBe('CEO');
    expect(nextUnapproved(MOST_TYPES, ['HR'])).toBe('MANAGER');
  });

  /* And nobody is asked twice. `approverAfter` could not promise this once the
     order could change underneath a live request; a walk that skips what is signed
     can. `leave_request_decision_once_per_desk` holds the same rule in the schema. */
  it('and never asks a desk that has already signed', () => {
    for (const chain of [MOST_TYPES, UNPAID, validateApprovalChain(['CEO', 'MANAGER', 'HR'])]) {
      for (const signed of chain) {
        expect(nextUnapproved(chain, [signed])).not.toBe(signed);
      }
    }
  });

  /* A desk outside the chain is neither a stage nor a signature that counts. It is
     ignored here and refused where somebody is actually approving — see
     `ApprovalChainChanged`, which is what keeps every recorded approval a stage. */
  it('ignores an approval by a desk the chain does not name', () => {
    expect(nextUnapproved(UNPAID, ['MANAGER'])).toBe('HR');
    expect(isApprovedBy(UNPAID, 'MANAGER')).toBe(false);
    expect(isApprovedBy(UNPAID, 'CEO')).toBe(true);
  });

  it('says whether anybody approves this at all', () => {
    expect(isApprovable(MOST_TYPES)).toBe(true);
    expect(isApprovable([])).toBe(false);
    expect(firstApprover([])).toBeUndefined();

    /* A chain with no stages has none outstanding, which reads as fully approved.
       That is `assertSomebodyApprovesIt`'s to refuse, at submission, with the type
       named — see the note on `stagesNotApproved`. */
    expect(stagesNotApproved([], [])).toEqual([]);
  });
});

describe('a chain as a person reads it', () => {
  /* The same sentence is wanted in an email, in a refusal and on the request
     form. Three copies of it would drift the first time somebody decided the
     Chief Executive should be called that rather than the CEO. */
  it('says who signs it off, in order', () => {
    expect(chainInWords(['MANAGER', 'HR'])).toBe('your line manager then HR');
    expect(chainInWords(['HR', 'CEO'])).toBe('HR then the Chief Executive');
    expect(chainInWords(['MANAGER', 'HR', 'CEO'])).toBe(
      'your line manager, HR then the Chief Executive',
    );
    expect(chainInWords(['CEO'])).toBe('the Chief Executive');
    expect(chainInWords([])).toBe('nobody');
  });

  it('reads it off the type, which is what a request form has in hand', () => {
    const type = stored(['HR', 'CEO']);

    expect(approvalChainInWords(type)).toBe('HR then the Chief Executive');
  });
});

describe('a type nobody approves', () => {
  /* Reachable, which is why the check exists. ensure_statutory_leave_types() puts
     back a leave type and cannot know about a table written after it, so a type
     restored without the call beside it comes back with no chain — see the
     leave-type-approval-chain migration for why that is closed off here rather
     than by a constraint. */
  it('is refused at the point of asking, not left to sit in no queue', () => {
    expect(() => assertSomebodyApprovesIt(stored([]))).toThrow(NobodyApprovesLeaveType);
    expect(() => assertSomebodyApprovesIt(stored(['MANAGER', 'HR']))).not.toThrow();
  });

  /* NFR USA 03. The person who hits this cannot fix it themselves, so the message
     has to say whose job it is — and what the answer usually is. */
  it('says whose job it is to fix, and what most types do', () => {
    try {
      assertSomebodyApprovesIt(stored([]));
      throw new Error('That was allowed, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(NobodyApprovesLeaveType);
      expect((error as Error).message).toMatch(/HR Administrator/);
      expect((error as Error).message).toMatch(/your line manager then HR/);
    }
  });
});

/** A stored type carrying the chain a test is about, and nothing else varying. */
function stored(approvalChain: readonly string[]): LeaveType {
  return {
    id: '1',
    ...validateNewLeaveType({
      code: 'ANNUAL',
      name: 'Annual Leave',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      /* An empty chain is refused by the validator, which is the point of it, so
         a type that has one is built by clearing it afterwards — which is exactly
         how the database gets one too. */
      approvalChain: approvalChain.length === 0 ? undefined : approvalChain,
    }),
    approvalChain: approvalChain.length === 0 ? [] : validateApprovalChain(approvalChain),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}
