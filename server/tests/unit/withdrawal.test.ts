import { describe, expect, it } from 'vitest';
import {
  grantingAction,
  type LeaveRequest,
  NothingLeftToGiveBack,
  reasonForGivingBackTakenDays,
  type RequestStatus,
  whatIsLeftOf,
  withdrawalTo,
} from '../../src/features/leave-request/leave-request.js';
import {
  ANSWERING_ACTIONS,
  AlreadyAskedToWithdraw,
  GRANTING_ACTIONS,
  isAboutAWithdrawal,
  isAGrant,
  isAnAnswer,
  NothingToAnswer,
  readReason,
  saysWhy,
  theOpenAsk,
  validateWithdrawal,
  wasWithdrawn,
  type Withdrawal,
  WITHDRAWAL_ACTIONS,
  type WithdrawalAction,
  WithdrawalNeedsAReason,
  withdrawalInWords,
} from '../../src/features/leave-request/withdrawal.js';

/**
 * Taking agreed leave off the books. FR 47. LMS 324.
 *
 * Three criteria and three shapes: the ask is the employee's, HR's answer restores the days
 * while the leave has not started, and once it has, HR amends with a reason. Everything here
 * is pure — which of the two grants applies, what is left of a period, and what each act is
 * owed in writing. Whether the days actually move is ../integration/leave-request.test.ts's.
 */
function aRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'request-1',
    employeeId: 'ama',
    leaveTypeId: 'annual',
    leaveYearId: '2026',
    from: '2026-03-02',
    to: '2026-03-10',
    reason: 'My sister is getting married',
    /** FR 18, LMS 308. */
    lateEntryReason: null,
    countingBasis: 'WORKING_DAYS',
    days: 6,
    calendarDays: 9,
    status: 'APPROVED',
    awaitingApprovalFrom: null,
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    ...overrides,
  };
}

function aWithdrawal(overrides: Partial<Withdrawal> = {}): Withdrawal {
  return {
    id: '1',
    leaveRequestId: 'request-1',
    action: 'ASK_TO_WITHDRAW',
    reason: 'The wedding is off',
    answersId: null,
    recordedBy: 'Ama Mensah',
    recordedByEmployeeId: 'ama',
    recordedAt: new Date('2026-02-20T09:00:00Z'),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ the four acts */

describe('the acts an approved request’s withdrawal has', () => {
  it('are the four FR 47 names, and the answers are the three that are HR’s', () => {
    expect([...WITHDRAWAL_ACTIONS]).toEqual([
      'ASK_TO_WITHDRAW',
      'WITHDRAW_APPROVED',
      'AMEND',
      'REFUSE_WITHDRAWAL',
    ]);

    expect([...ANSWERING_ACTIONS]).toEqual(
      WITHDRAWAL_ACTIONS.filter((action) => action !== 'ASK_TO_WITHDRAW'),
    );
  });

  /* And the two that move days are the two grants, which is what tells the door whether to
     write a RECALCULATION at all. */
  it('and the two that give days back are the grants, never the refusal', () => {
    expect([...GRANTING_ACTIONS]).toEqual(['WITHDRAW_APPROVED', 'AMEND']);

    expect(WITHDRAWAL_ACTIONS.filter(isAGrant)).toEqual([...GRANTING_ACTIONS]);
    expect(isAGrant('REFUSE_WITHDRAWAL')).toBe(false);
    expect(isAGrant('ASK_TO_WITHDRAW')).toBe(false);
  });

  it('and every one of them is recognised as belonging to this conversation', () => {
    for (const action of WITHDRAWAL_ACTIONS) {
      expect(isAboutAWithdrawal(action)).toBe(true);
    }

    for (const other of ['WITHDRAW', 'APPROVE', 'CANCEL', 'ROUTE'] as const) {
      expect(isAboutAWithdrawal(other)).toBe(false);
      expect(isAnAnswer(other)).toBe(false);
    }
  });

  /**
   * And three of the four are owed a sentence, which is FR 47's third criterion.
   *
   * The one that is not is HR agreeing to take leave that has not started off the books:
   * nobody loses anything by it, and the ask it answers already says why. The asymmetry is
   * FR 39's, from the other end of a request's life.
   */
  it('and only agreeing to leave that has not started needs no reason', () => {
    expect(WITHDRAWAL_ACTIONS.filter(saysWhy)).toEqual([
      'ASK_TO_WITHDRAW',
      'AMEND',
      'REFUSE_WITHDRAWAL',
    ]);
  });
});

/* ------------------------------------------------ what each act says about itself */

describe('an ask or an answer on its way to being written', () => {
  it.each(['ASK_TO_WITHDRAW', 'AMEND', 'REFUSE_WITHDRAWAL'] as const)(
    'refuses a %s with nothing said, naming the field',
    (action) => {
      const written = {
        leaveRequestId: 'request-1',
        action,
        reason: '   ',
        answersId: action === 'ASK_TO_WITHDRAW' ? null : '1',
      };

      expect(() => validateWithdrawal(written)).toThrow(WithdrawalNeedsAReason);

      try {
        validateWithdrawal(written);
      } catch (error) {
        expect((error as WithdrawalNeedsAReason).field).toBe('reason');
        expect((error as WithdrawalNeedsAReason).code).toBe('WITHDRAWAL_NEEDS_A_REASON');
        expect((error as WithdrawalNeedsAReason).action).toBe(action);
      }
    },
  );

  /* Three acts, three sentences, because the three readers are different people. */
  it('and says something different to each of the three', () => {
    const said = (['ASK_TO_WITHDRAW', 'AMEND', 'REFUSE_WITHDRAWAL'] as const).map(
      (action) => new WithdrawalNeedsAReason(action).message,
    );

    expect(new Set(said).size).toBe(3);
    expect(said.every((sentence) => sentence.includes('FR 47'))).toBe(true);
  });

  it('and lets HR agree to leave that has not started without saying anything', () => {
    expect(
      validateWithdrawal({
        leaveRequestId: 'request-1',
        action: 'WITHDRAW_APPROVED',
        reason: null,
        answersId: '1',
      }).reason,
    ).toBeNull();
  });

  /* Trimmed rather than refused when it arrives padded, as every other note in this system
     is — and a reason that is only spaces is nothing said. */
  it('and trims what was written, so a reason of spaces is no reason', () => {
    expect(
      validateWithdrawal({
        leaveRequestId: 'request-1',
        action: 'ASK_TO_WITHDRAW',
        reason: '  The wedding is off  ',
        answersId: null,
      }).reason,
    ).toBe('The wedding is off');

    expect(readReason('   ')).toBeNull();
    expect(readReason(undefined)).toBeNull();
    expect(readReason(' something ')).toBe('something');
  });
});

/* ------------------------------------------------------------- one ask at a time */

describe('the ask that is still waiting', () => {
  const ask = aWithdrawal({ id: '1' });

  it('is the one no answer names', () => {
    expect(theOpenAsk([ask])).toBe(ask);
  });

  it('and is nothing once it has been answered, whichever way', () => {
    for (const action of ANSWERING_ACTIONS) {
      const answer = aWithdrawal({ id: '2', action, answersId: '1', reason: 'no' });

      expect(theOpenAsk([ask, answer])).toBeUndefined();
    }
  });

  /**
   * And asking again after an answer is a new ask, which is the point of reading the whole
   * conversation rather than the newest row.
   *
   * HR turned it down in March because cover was arranged; by April the leave is genuinely
   * not wanted. Only two *unanswered* asks are refused.
   */
  it('and a second ask after an answer is open again', () => {
    const refused = aWithdrawal({
      id: '2',
      action: 'REFUSE_WITHDRAWAL',
      answersId: '1',
      reason: 'Cover is already arranged',
    });
    const again = aWithdrawal({ id: '3' });

    expect(theOpenAsk([ask, refused, again])).toBe(again);
  });

  it('and a request that came off the books says so, whatever else is on it', () => {
    expect(wasWithdrawn([ask])).toBe(false);
    expect(
      wasWithdrawn([ask, aWithdrawal({ id: '2', action: 'WITHDRAW_APPROVED', answersId: '1' })]),
    ).toBe(true);
    expect(
      wasWithdrawn([
        ask,
        aWithdrawal({ id: '2', action: 'AMEND', answersId: '1', reason: 'Back on Thursday' }),
      ]),
    ).toBe(false);
  });

  it('and the two refusals about a conversation carry the request they are about', () => {
    expect(new NothingToAnswer('request-1').leaveRequestId).toBe('request-1');
    expect(new NothingToAnswer('request-1').code).toBe('NOTHING_TO_ANSWER');

    const asked = new AlreadyAskedToWithdraw('request-1', ask.recordedAt);

    expect(asked.code).toBe('ALREADY_ASKED_TO_WITHDRAW');
    expect(asked.askedAt).toBe(ask.recordedAt);
  });
});

/* ------------------------------------------ which grant, and how much of it, FR 47 */

describe('which answer a grant is', () => {
  /**
   * The story's second and third criteria, decided by the calendar rather than by HR.
   *
   * Handing the choice to the caller would make "restores the days if leave has not started"
   * something somebody remembers rather than something that is true.
   */
  it('is a full withdrawal while the leave has not started', () => {
    expect(grantingAction(aRequest(), '2026-03-01')).toBe('WITHDRAW_APPROVED');
    expect(withdrawalTo(aRequest(), 'WITHDRAW_APPROVED')).toBe('WITHDRAWN');
  });

  /* The first day counts as started: somebody on leave today has taken today. */
  it('and an amendment from the first day of it onwards', () => {
    for (const today of ['2026-03-02', '2026-03-05', '2026-03-10', '2026-03-20']) {
      expect(grantingAction(aRequest(), today)).toBe('AMEND');
    }

    expect(withdrawalTo(aRequest(), 'AMEND')).toBe('APPROVED');
  });

  /* And the acts that decide nothing leave the request exactly where it was. */
  it('and asking, or being turned down, moves nothing', () => {
    expect(withdrawalTo(aRequest(), 'ASK_TO_WITHDRAW')).toBe('APPROVED');
    expect(withdrawalTo(aRequest(), 'REFUSE_WITHDRAWAL')).toBe('APPROVED');
  });

  /* And none of the four is available anywhere else, because agreed leave is the only state
     with a row for them. A request still being decided is taken back with `WITHDRAW`. */
  it('and none of them can be done to a request that is not agreed', () => {
    for (const status of ['SUBMITTED', 'UNROUTABLE', 'WITHDRAWN', 'REFUSED'] as RequestStatus[]) {
      for (const action of WITHDRAWAL_ACTIONS) {
        expect(() => withdrawalTo(aRequest({ status }), action)).toThrow();
      }
    }
  });
});

describe('what is left of an approved period', () => {
  /* Tomorrow to the last day, so a fortnight abandoned on its third day gives back what is
     after today and not what is after its start. */
  it('starts the day after today', () => {
    expect(whatIsLeftOf(aRequest(), '2026-03-04')).toEqual({
      from: '2026-03-05',
      to: '2026-03-10',
    });
  });

  /* Leave that has not started yet is left over in full, which is the figure a full
     withdrawal gives back anyway — the two agree, and neither is derived from the other. */
  it('and is the whole period where it has not begun', () => {
    expect(whatIsLeftOf(aRequest(), '2026-02-20')).toEqual({
      from: '2026-03-02',
      to: '2026-03-10',
    });
  });

  it('and is nothing once the last day has been taken', () => {
    expect(whatIsLeftOf(aRequest(), '2026-03-10')).toBeNull();
    expect(whatIsLeftOf(aRequest(), '2026-04-01')).toBeNull();
  });

  it('and leave with nothing left is refused in words that name the dates', () => {
    const refusal = new NothingLeftToGiveBack(aRequest(), 'Annual Leave');

    expect(refusal.code).toBe('NOTHING_LEFT_TO_GIVE_BACK');
    expect(refusal.message).toContain('2 March 2026');
    expect(refusal.message).toContain('10 March 2026');
    expect(refusal.message).toContain('Annual Leave');
  });
});

/* --------------------------------------------------------- what the ledger will say */

describe('the sentence on the movement that gives days back', () => {
  const period = { from: '2026-03-02', to: '2026-03-10' } as const;

  /**
   * Which of the two grants it was is in the sentence, because that is the part nobody can
   * reconstruct from the figures.
   *
   * Six days coming back look identical whether the leave never happened or whether it was
   * cut short, and those are different conversations — the same argument
   * `reasonForRelease` makes about the three endings.
   */
  it('says which grant it was, and names the days and the dates', () => {
    expect(reasonForGivingBackTakenDays('Annual Leave', period, 6, 'WITHDRAW_APPROVED')).toBe(
      '6 days of Annual Leave given back, 2026-03-02 to 2026-03-10, the approved leave was ' +
        'taken off the books',
    );

    expect(reasonForGivingBackTakenDays('Annual Leave', period, 4, 'AMEND')).toBe(
      '4 days of Annual Leave given back, 2026-03-02 to 2026-03-10, the leave had started ' +
        'and was amended to the days actually taken',
    );
  });

  it('and counts one day as a day', () => {
    expect(reasonForGivingBackTakenDays('Annual Leave', period, 1, 'AMEND')).toContain('1 day of');
  });
});

/* ---------------------------------------------------------------- what a trail says */

describe('the account a person reads on their own history', () => {
  /**
   * Four acts, four sentences, and none of them is "taken back before it was decided".
   *
   * That is what `trailFor` said of every `WITHDRAWN` request until this story, and it is
   * false of exactly the ones LMS 324 makes.
   */
  it('has one sentence per act and none of them claims nobody had decided', () => {
    const said = WITHDRAWAL_ACTIONS.map((action: WithdrawalAction) =>
      withdrawalInWords(
        aWithdrawal({ action, answersId: action === 'ASK_TO_WITHDRAW' ? null : '1' }),
      ),
    );

    expect(new Set(said).size).toBe(WITHDRAWAL_ACTIONS.length);

    for (const sentence of said) {
      expect(sentence.trim()).not.toBe('');
      expect(sentence).not.toContain('before it was decided');
    }
  });

  /* And the amendment says the half nobody expects: some of the days are spent. */
  it('and the amendment says that some of the days are not coming back', () => {
    expect(withdrawalInWords(aWithdrawal({ action: 'AMEND', answersId: '1' }))).toContain('spent');
  });
});
