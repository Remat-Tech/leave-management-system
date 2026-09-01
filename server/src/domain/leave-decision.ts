/**
 * What an approver said, and who said it. FR 39, FR 52, §6. LMS 315.
 *
 * The story is a person whose leave has been turned down finding out why without having
 * to catch somebody in a corridor, and every part of this file follows from taking that
 * literally: a refusal carries a sentence written by the person who made it, the sentence
 * is stored beside the decision rather than repeated in a message, and nothing can edit it
 * afterwards.
 *
 * LMS 314 got a request as far as being routed and decided; what it recorded was where the
 * request went. `leave_request.status` says a request was refused and
 * `awaiting_approval_from` says it is waiting on nobody, and between them they cannot
 * answer either of the two questions somebody actually has: **why**, and **who by**. The
 * audit log answers the second and only the second — see the note below on why it is not
 * enough on its own.
 *
 * ## Three facts, and the third is the one that needs arguing for
 *
 * A decision records what was decided, why where a reason is owed, and who decided it —
 * which is {@link LeaveDecision.decidedBy} and {@link LeaveDecision.decidedAt}, both
 * stamped by the database — and then {@link LeaveDecision.onBehalfOf}, which is the desk
 * the request was standing at when it happened.
 *
 * For an approval those last two say the same thing twice, and deliberately so: only the
 * person a desk resolves to may approve at it, which is `leaveRequestPolicy.approve`
 * admitting `THE_DESK_IT_IS_WITH` and nobody else. For a *refusal* they can differ, because
 * `TRANSITIONS` admits a line manager and HR to the `REFUSE` row whichever desk the request
 * is sitting at — an HR Officer may turn down leave that is with a manager, and a manager
 * may turn down unpaid leave whose chain has no manager stage at all.
 *
 * So "refused by an HR Officer, at the line manager's stage" is a sentence this pair can
 * make and one field could not, and the manager who reads it can see that the decision was
 * not theirs. That is what FR 52 asks to be on the record.
 *
 * ## The asymmetry between the two verbs is the story
 *
 * A refusal must say why and an approval need not, and it is worth being plain that this is
 * a judgement rather than an oversight. Somebody who has been told no has to be able to act
 * on it — ask for different dates, arrange cover, appeal — and "no" with nothing after it
 * leaves them with nothing to act on and a conversation to chase. Somebody who has been told
 * yes needs no account of the yes.
 *
 * {@link requireAComment} and {@link readComment} are the two halves of that, and
 * `leave_request_refusal_says_why` holds the same rule where no sentence can reach.
 *
 * ## Why the audit log is not this
 *
 * It is a fair question, because `leave_request` has been audited since LMS 301 and every
 * transition already writes an entry with the actor and the instant on it. Three reasons,
 * and the third is the one that decides it:
 *
 *   **It has nowhere to put the comment.** An audit entry is `before` and `after` snapshots
 *   of the row that changed, and the reason an approver gives is not a column of
 *   `leave_request` — putting it there would mean a request with one comment, overwritten by
 *   each desk in turn.
 *
 *   **It cannot say which desk.** The row's `awaiting_approval_from` moves in the same
 *   statement, so the entry holds the desk before and the desk after and neither of them is
 *   labelled "who decided this".
 *
 *   **It is not a thing the person is shown.** NFR AUD 02 makes the audit log an
 *   investigator's record, read by whoever is settling a dispute two years later. The
 *   sentence a manager writes when they turn leave down is written *to the requester*, and a
 *   record only an administrator can read is the corridor conversation with extra steps.
 *
 * The two are complements and both are written, in one transaction: the log answers who
 * moved this request and when, and this answers what they said about it.
 *
 * ## What is not here
 *
 * **No withdrawal and no cancellation.** {@link DECIDING_ACTIONS} is two of the four
 * {@link RequestAction}s, and the two it leaves out are not decisions at a desk: withdrawing
 * is somebody taking their own request back and cancelling is HR unwinding a row that should
 * not be on the books. A decision recorded for either would put a judgement in front of the
 * requester that nobody made — and asking a person to justify changing their mind is not a
 * thing FR 39 asks for.
 *
 * **No notification.** That somebody is *told* their leave was refused is FR 45 and is a
 * story of its own; what this one guarantees is that there is something true to tell them.
 *
 * **No policy.** Who may approve and who may refuse is ../auth/leave-request-policy.ts, and
 * it is unchanged by this story — a comment is something a decision carries rather than a
 * power somebody holds.
 *
 * **No appeal.** FR 41's disputing of a refusal reads these rows and adds none.
 */

import type { ApproverRole } from './approval-chain.js';
import type { RequestAction } from './leave-request.js';

/**
 * The two verbs that are a decision at a desk. FR 39. LMS 315.
 *
 * A sub-list of {@link REQUEST_ACTIONS}, written out rather than derived from it — the
 * same discipline {@link RELEASING_ACTIONS} keeps, and for the same reason. "Every action
 * but the two administrative ones" is a definition that absorbs whatever verb arrives next,
 * and the next one is FR 26's cancelling of leave already agreed: an administrative
 * unwinding, which would land here by subtraction and start demanding a comment of HR for
 * correcting a row that was entered twice.
 *
 * The unit suite asserts every member of this list is a member of that one, and that the
 * two it leaves out are the two the release door settles without a desk.
 *
 * `leave_request_decision_action_known` holds the same two values, and the integration
 * suite reads that constraint back out of `pg_constraint` and asserts they agree — so
 * neither can be extended alone.
 */
export const DECIDING_ACTIONS = ['APPROVE', 'REFUSE'] as const;

export type DecidingAction = (typeof DECIDING_ACTIONS)[number];

/** Whether this verb is somebody at a desk deciding, rather than a request being unwound. */
export function isADecision(action: RequestAction): action is DecidingAction {
  return (DECIDING_ACTIONS as readonly RequestAction[]).includes(action);
}

/**
 * A refusal with nothing said about it. FR 39, NFR USA 03. LMS 315.
 *
 * The story's first criterion, and the refusal the person turned down never sees — it is
 * met by the approver, at the moment they press the button, which is the only moment at
 * which the reason can still be written.
 *
 * The message says what the comment is *for* rather than only that the field is required,
 * because the likely reader is a manager in a hurry who thinks of it as paperwork. It is not
 * paperwork: it is the whole of what the person whose leave this is will be given, and the
 * only account of the decision that will exist when somebody asks about it next year.
 */
export class RefusalNeedsAComment extends Error {
  /** FR 39. What a client branches on, so a form can put the cursor in the box. */
  readonly code = 'REFUSAL_NEEDS_A_COMMENT';
  /** NFR USA 03. The message belongs beside the input it is about. */
  readonly field = 'comment';

  constructor() {
    super(
      'Turning leave down says why. Whoever asked for it is owed the reason in writing — ' +
        'it is what they will act on, and it is the only account of this decision that ' +
        'will exist when somebody asks about it next year. Approving needs no comment; ' +
        'refusing does.',
    );
    this.name = 'RefusalNeedsAComment';
  }
}

/**
 * What is written down, once the two rules about the comment have been applied.
 *
 * None of `decidedBy`, `decidedByEmployeeId` or `decidedAt` is here, and their absence is
 * the same rule `ValidatedLedgerEntry` keeps about its own three: they are stamped by
 * `stamp_the_decider_on_a_decision()` from the transaction the write is made in, and a
 * caller that could supply them could record a refusal under somebody else's name or date
 * one before the request it decides.
 */
export interface ValidatedDecision {
  leaveRequestId: string;
  action: DecidingAction;
  /** FR 52. The desk this answers for, read off the request rather than chosen. */
  onBehalfOf: ApproverRole;
  /** Required of a refusal, null on an approval that said nothing. */
  comment: string | null;
}

/** A decision as it comes back out. */
export interface LeaveDecision {
  id: string;
  leaveRequestId: string;
  action: DecidingAction;
  /**
   * FR 52. The desk this decision answered for, which is not always the desk the person
   * making it belongs to. See the module note.
   */
  onBehalfOf: ApproverRole;
  comment: string | null;
  /** Who, in words. {@link UNATTRIBUTED} where nobody said. */
  decidedBy: string;
  /** Who, as an id to join on. Null for the system and for anything unattributed. */
  decidedByEmployeeId: string | null;
  decidedAt: Date;
}

/**
 * The reason a refusal has to carry. FR 39.
 *
 * Trimmed, never defaulted, and unconstrained beyond being something — the same rule
 * `requireReason` holds a request's own reason to, and for the same reason: a field with a
 * minimum length is a field people pad, and one with a list of permitted values is one where
 * somebody picks the nearest wrong option.
 *
 * A string of spaces is nothing, which is the half of "required" that is usually missed and
 * is the half `leave_request_decision_comment_not_blank` exists for.
 */
export function requireAComment(value: unknown): string {
  const said = readComment(value);

  if (said === null) {
    throw new RefusalNeedsAComment();
  }

  return said;
}

/**
 * The reason an approval may carry, or nothing.
 *
 * Blank becomes null rather than an empty string, so that "the approver typed two spaces"
 * and "the approver said nothing" are the same row — which is what they are. The alternative
 * is a comment that renders as an empty speech bubble beside somebody's approved leave.
 */
export function readComment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const said = value.trim();

  return said === '' ? null : said;
}

/**
 * Checks a decision on its way to being written, and applies the rule about the comment.
 *
 * Asked here as well as at the service's front door, which is the arrangement every rule in
 * this system that matters has: the service refuses a refusal with no reason before it reads
 * anything at all, so the approver is told at once, and this is asked again inside the
 * transaction that writes — where the answer binds and where nothing has been able to get
 * between the check and the row.
 *
 * `onBehalfOf` is a parameter rather than something this reads off a request, because the
 * desk that binds is the one read *inside the balance lock* — see
 * `BalanceService.approveForRequest`, which re-decides where the request is standing before
 * it composes this.
 */
export function validateDecision(input: {
  leaveRequestId: string;
  action: DecidingAction;
  onBehalfOf: ApproverRole;
  comment: unknown;
}): ValidatedDecision {
  return {
    leaveRequestId: input.leaveRequestId,
    action: input.action,
    onBehalfOf: input.onBehalfOf,
    comment:
      input.action === 'REFUSE' ? requireAComment(input.comment) : readComment(input.comment),
  };
}

/**
 * The refusal among a request's decisions, where there is one.
 *
 * What a screen puts at the top of a request that was turned down, and the one reading of
 * this list worth naming rather than leaving to each caller: a request collects an approval
 * per stage and at most one refusal, because refusing ends it, so "why was this refused" has
 * a single answer and finding it should not be a filter written twice.
 *
 * Undefined for a request that was approved or is still being decided, which is every
 * request but the ones this is asked about.
 *
 * **Nothing calls it yet**, and that is worth saying rather than leaving to be noticed. The
 * caller is the leave page of Phase 4, and it is here rather than there for the reason
 * {@link noticeShortfall} was written in LMS 201 and read in LMS 301: the moment a screen
 * writes this filter for itself, the notification of FR 45 writes it again for the email, and
 * the two disagree the first time somebody decides an appeal should show the refusal it is
 * about. It is one line, it is tested, and the alternative is two copies of it.
 */
export function theRefusal(decisions: readonly LeaveDecision[]): LeaveDecision | undefined {
  return decisions.find((decision) => decision.action === 'REFUSE');
}

/**
 * The desks that have said yes to this request. FR 41. LMS 316.
 *
 * What the walk is asked against, and the reason LMS 316 could be built at all: until these
 * rows existed, "has every stage approved" had no answer in the system — there was a cursor
 * saying where a request had got to and nothing saying who had actually signed. The two agree
 * while nothing moves, and FR 31 lets an HR Administrator move the chain.
 *
 * **Only approvals count, and a refusal is not the absence of one.** A refused request has
 * ended, so it never reaches the question; filtering rather than mapping is what keeps that
 * true if it ever does.
 *
 * The desks rather than the decisions, because that is all the walk needs and it is what lets
 * ./approval-chain.ts stay a file about lists of desks. ./leave-request.ts asks
 * {@link nextUnapproved} with the answer, and neither of them imports this file — the service
 * carries the value across, which is the same seam the counting basis and the balance are
 * handed over on.
 */
export function desksThatApproved(decisions: readonly LeaveDecision[]): ApproverRole[] {
  return decisions
    .filter((decision) => decision.action === 'APPROVE')
    .map((decision) => decision.onBehalfOf);
}
