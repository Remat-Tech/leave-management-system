/**
 * Asking for approved leave to be taken off the books, and what HR answered. FR 47, §6., LMS 324, NFR USA 03.
 */

import { InvalidLeaveRequest, type RequestAction } from './leave-request.js';

/** The four acts there are. FR 47. */
export const WITHDRAWAL_ACTIONS = [
  /** The employee, asking. The one act that is not HR's. */
  'ASK_TO_WITHDRAW',
  /** HR agreeing before the leave has started: all of it comes off the books. */
  'WITHDRAW_APPROVED',
  /** HR agreeing once it has started: what is left comes back and the rest stays spent. */
  'AMEND',
  /** HR declining. The leave stands and the days stay spent. */
  'REFUSE_WITHDRAWAL',
] as const;

export type WithdrawalAction = (typeof WITHDRAWAL_ACTIONS)[number];

/** The three that are HR's answer to an ask. FR 47. */
export const ANSWERING_ACTIONS = [
  'WITHDRAW_APPROVED',
  'AMEND',
  'REFUSE_WITHDRAWAL',
] as const satisfies readonly WithdrawalAction[];

export type WithdrawalAnswer = (typeof ANSWERING_ACTIONS)[number];

/** The two that give days back. Which of them applies is `grantingAction`'s, not HR's. FR 47. */
export const GRANTING_ACTIONS = [
  'WITHDRAW_APPROVED',
  'AMEND',
] as const satisfies readonly WithdrawalAction[];

export type GrantingAction = (typeof GRANTING_ACTIONS)[number];

/**
 * The three that are owed a sentence. FR 47, FR 39.
 *
 * Written out rather than derived by subtraction. `leave_request_withdrawal_says_why` holds
 * the same rule in the schema.
 */
export const WITHDRAWAL_ACTIONS_THAT_SAY_WHY = [
  'ASK_TO_WITHDRAW',
  'AMEND',
  'REFUSE_WITHDRAWAL',
] as const satisfies readonly WithdrawalAction[];

/** Whether this verb belongs to the withdrawal of agreed leave at all. */
export function isAboutAWithdrawal(action: RequestAction): action is WithdrawalAction {
  return (WITHDRAWAL_ACTIONS as readonly RequestAction[]).includes(action);
}

/** Whether this verb is HR answering an ask rather than the employee making one. FR 47. */
export function isAnAnswer(action: RequestAction): action is WithdrawalAnswer {
  return (ANSWERING_ACTIONS as readonly RequestAction[]).includes(action);
}

/** Whether this verb gives days back. FR 47. */
export function isAGrant(action: RequestAction): action is GrantingAction {
  return (GRANTING_ACTIONS as readonly RequestAction[]).includes(action);
}

/** Whether this verb has to say why. FR 47, FR 39. */
export function saysWhy(action: WithdrawalAction): boolean {
  return (WITHDRAWAL_ACTIONS_THAT_SAY_WHY as readonly WithdrawalAction[]).includes(action);
}

/** What the caller supplies to record one. */
export interface NewWithdrawal {
  leaveRequestId: string;
  action: WithdrawalAction;
  reason: string | null;
  /** The ask this answers, and null on an ask. */
  answersId: string | null;
}

/** The shape a checked one has by the time it reaches the repository. */
export type ValidatedWithdrawal = NewWithdrawal;

/** One as it comes back out, with who wrote it and when. FR 52. */
export interface Withdrawal extends ValidatedWithdrawal {
  id: string;
  /** Who, in words. */
  recordedBy: string;
  /** Who, as an id to join on. */
  recordedByEmployeeId: string | null;
  recordedAt: Date;
}

/* ------------------------------------------------------------------- refusals */

/** An ask or an answer with nothing said. FR 47, FR 39, NFR USA 03. */
export class WithdrawalNeedsAReason extends Error {
  /** FR 47. */
  readonly code = 'WITHDRAWAL_NEEDS_A_REASON';
  /** NFR USA 03. */
  readonly field = 'reason';
  readonly action: WithdrawalAction;

  constructor(action: WithdrawalAction) {
    super(whyItIsNeeded(action));
    this.name = 'WithdrawalNeedsAReason';
    this.action = action;
  }
}

/** One sentence per act, because the three readers are different people. NFR USA 03. */
function whyItIsNeeded(action: WithdrawalAction): string {
  switch (action) {
    case 'ASK_TO_WITHDRAW':
      return (
        'Asking for leave that has been agreed to be taken off the books needs a reason. ' +
        'HR is being asked to undo something every approver already said yes to, and it is ' +
        'what they decide on. FR 47.'
      );
    case 'AMEND':
      return (
        'This leave has already started, so some of its days are spent and are not coming ' +
        'back. Amending it needs a reason in writing: it is the only account the person ' +
        'will have of why part of what they asked for stands. FR 47.'
      );
    default:
      return (
        'Turning down an ask to withdraw leave needs a reason. The person asked to have ' +
        'days put back and is keeping leave they say they no longer need. FR 47.'
      );
  }
}

/**
 * HR answering an ask nobody made. FR 47.
 *
 * Agreed leave is not taken off the books by HR alone, which is FR 47's first criterion read
 * as a refusal.
 */
export class NothingToAnswer extends Error {
  /** FR 47. */
  readonly code = 'NOTHING_TO_ANSWER';
  readonly leaveRequestId: string;

  constructor(leaveRequestId: string) {
    super(
      `Nobody has asked for this leave to be taken off the books, so there is nothing to ` +
        `agree to or to turn down. Agreed leave comes back to a balance because the person ` +
        `taking it asks and HR answers. If the request should never have stood at all, that ` +
        `is an adjustment with a reason on it. FR 47.`,
    );
    this.name = 'NothingToAnswer';
    this.leaveRequestId = leaveRequestId;
  }
}

/**
 * A second ask while the first is unanswered. FR 47.
 *
 * Asking again *after* an answer is legitimate and the table holds both.
 * `leave_request_is_asked_to_withdraw_once_at_a_time` says the same in the schema.
 */
export class AlreadyAskedToWithdraw extends Error {
  /** FR 47. */
  readonly code = 'ALREADY_ASKED_TO_WITHDRAW';
  readonly leaveRequestId: string;
  /** When the open ask was made, or null where the database refused this rather than a read. */
  readonly askedAt: Date | null;

  constructor(leaveRequestId: string, askedAt: Date | null) {
    super(
      `You have already asked for this leave to be taken off the books, and HR has not ` +
        `answered yet. Asking again would give them two sentences and one decision. If what ` +
        `you told them has changed, tell HR — the ask is on the record. FR 47.`,
    );
    this.name = 'AlreadyAskedToWithdraw';
    this.leaveRequestId = leaveRequestId;
    this.askedAt = askedAt;
  }
}

/* ---------------------------------------------------------------- what is valid */

/**
 * Checks an ask or an answer on its way to being written. FR 47.
 *
 * Every rule here is also a constraint in the withdraw-an-approved-request migration; this is
 * the copy that names the field, which is what a form needs.
 */
export function validateWithdrawal(input: NewWithdrawal): ValidatedWithdrawal {
  const action = requireAction(input.action);
  const reason = input.reason === null ? null : input.reason.trim();

  if (saysWhy(action) && (reason === null || reason === '')) {
    throw new WithdrawalNeedsAReason(action);
  }

  return {
    leaveRequestId: requireId(input.leaveRequestId),
    action,
    reason: reason === '' ? null : reason,
    answersId: input.answersId,
  };
}

/** The reason as it arrived, or null where nothing was said. NFR USA 03. */
export function readReason(said: string | undefined | null): string | null {
  return said === undefined || said === null || said.trim() === '' ? null : said.trim();
}

/**
 * The ask still waiting for an answer, where there is one. FR 47.
 *
 * A question about the whole conversation rather than about the newest row: a request asked
 * about in March, turned down, and asked about again in April has two asks and one is open.
 */
export function theOpenAsk(withdrawals: readonly Withdrawal[]): Withdrawal | undefined {
  const answered = new Set(
    withdrawals.map((withdrawal) => withdrawal.answersId).filter((id) => id !== null),
  );

  return withdrawals.find(
    (withdrawal) => withdrawal.action === 'ASK_TO_WITHDRAW' && !answered.has(withdrawal.id),
  );
}

/** Whether agreed leave has already come off the books through this door. FR 47. */
export function wasWithdrawn(withdrawals: readonly Withdrawal[]): boolean {
  return withdrawals.some((withdrawal) => withdrawal.action === 'WITHDRAW_APPROVED');
}

/** One act, in the words the person whose leave it is reads. FR 47, NFR USA 03. */
export function withdrawalInWords(withdrawal: Withdrawal): string {
  switch (withdrawal.action) {
    case 'ASK_TO_WITHDRAW':
      return 'You asked for this leave to be taken off the books.';
    case 'WITHDRAW_APPROVED':
      return 'HR agreed. The leave came off the books and the days went back into the balance.';
    case 'AMEND':
      return (
        'HR agreed, and this leave had already started — so the days up to then are spent ' +
        'and the rest went back into the balance.'
      );
    default:
      return 'HR did not agree. This leave stands and the days stay spent.';
  }
}

function requireAction(value: unknown): WithdrawalAction {
  if (typeof value !== 'string' || !(WITHDRAWAL_ACTIONS as readonly string[]).includes(value)) {
    throw new InvalidLeaveRequest(
      'action',
      `${String(value)} is not something anybody does to a withdrawal. They are ` +
        `${WITHDRAWAL_ACTIONS.join(', ')}. FR 47.`,
    );
  }

  return value as WithdrawalAction;
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveRequest(
      'leaveRequestId',
      'An ask to withdraw leave has to name the leave it is about.',
    );
  }

  return value.trim();
}
