/**
 * Who approves a kind of leave, and in what order. FR 38a, §5.5., LMS 204, FR 04, FR 48, LMS 316, LMS 314, FR 31.
 */

/** The desks a stage of a chain can name. FR 38a. */
export const APPROVER_ROLES = ['MANAGER', 'HR', 'CEO'] as const;

export type ApproverRole = (typeof APPROVER_ROLES)[number];

/** Manager then HR. */
export const DEFAULT_APPROVAL_CHAIN: readonly ApproverRole[] = ['MANAGER', 'HR'];

/**
 * The longest a chain can be, which follows from there being three desks rather than from anybody's view about how many approvals are sensible.
 */
export const LONGEST_CHAIN = APPROVER_ROLES.length;

/** One stage of a chain, as it is stored: a position and the desk at it. */
export interface ApprovalStep {
  /** 1 is the first approver. */
  stepOrder: number;
  approverRole: ApproverRole;
}

/** A chain that was refused, and the field that caused it. NFR USA 03. */
export class InvalidApprovalChain extends Error {
  readonly field: string;

  constructor(message: string, field = 'approvalChain') {
    super(message);
    this.name = 'InvalidApprovalChain';
    this.field = field;
  }
}

/** Reads a chain, or refuses it. §8. */
export function validateApprovalChain(value: unknown): ApproverRole[] {
  if (!Array.isArray(value)) {
    throw new InvalidApprovalChain(
      'An approval chain is the list of approvers a request goes to, in order — ' +
        `${APPROVER_ROLES.join(', ')}.`,
    );
  }

  const chain = value.map((role) => readApproverRole(role));

  if (chain.length === 0) {
    throw new InvalidApprovalChain(
      'A leave type needs at least one approver. A type nobody approves is one ' +
        'whose requests sit in no queue at all; if it should not be asked for at ' +
        'all, retire it instead.',
    );
  }

  const seen = new Set<ApproverRole>();
  for (const role of chain) {
    if (seen.has(role)) {
      throw new InvalidApprovalChain(
        `${deskInWords(role)} is in this chain twice. An approver is asked once; a ` +
          'second stage naming the same desk waits for somebody to approve what ' +
          'they have already approved.',
      );
    }
    seen.add(role);
  }

  return chain;
}

/** Reads one desk, or refuses it. Case and spacing are forgiven; nothing else is. */
export function readApproverRole(value: unknown): ApproverRole {
  if (typeof value !== 'string') {
    throw new InvalidApprovalChain(
      `${String(value)} is not an approver. Approvers are ${APPROVER_ROLES.join(', ')}.`,
    );
  }

  const role = value.trim().toUpperCase();

  if (!(APPROVER_ROLES as readonly string[]).includes(role)) {
    throw new InvalidApprovalChain(
      `${value.trim()} is not an approver. Approvers are ${APPROVER_ROLES.join(', ')} — ` +
        'the desk a request goes to, rather than the role somebody holds, so HR ' +
        'covers an HR Officer and an HR Administrator alike.',
    );
  }

  return role as ApproverRole;
}

/**
 * A chain as the rows it is stored as, numbered from one.
 *
 * The numbering is produced here rather than supplied by a caller, which is what
 * makes a gap impossible from this side: a chain is a list, and its positions are
 * where its members are. `leave_type_approval_chain_is_whole` is the same rule for
 * every other writer.
 */
export function stepsOf(chain: readonly ApproverRole[]): ApprovalStep[] {
  return chain.map((approverRole, index) => ({ stepOrder: index + 1, approverRole }));
}

/**
 * A chain read back out of its rows, in order.
 *
 * Sorted here rather than trusted to arrive sorted, so that the one query that
 * forgot an ORDER BY cannot silently reverse who signs off first.
 */
export function chainOf(steps: readonly ApprovalStep[]): ApproverRole[] {
  return [...steps]
    .sort((left, right) => left.stepOrder - right.stepOrder)
    .map((step) => step.approverRole);
}

/** Whether anybody at all is set up to approve this. */
export function isApprovable(chain: readonly ApproverRole[]): boolean {
  return chain.length > 0;
}

/**
 * The desk a request goes to first, or undefined where nobody approves this.
 *
 * Undefined rather than a throw, because "is there anybody" is a fair question
 * with an answer; the refusal belongs where somebody is actually trying to raise
 * a request, which is {@link assertSomebodyApprovesIt} in ./leave-type.ts.
 *
 * It is the front of the list, which is a question about the *chain*, where
 * {@link nextUnapproved} is a question about a chain and what has happened to a
 * request. They give the same answer for a request nobody has decided yet —
 * which every new one is — and the unit suite asserts as much, so the two cannot
 * come apart while a submission goes through this one.
 */
export function firstApprover(chain: readonly ApproverRole[]): ApproverRole | undefined {
  return chain[0];
}

/**
 * The first desk in this chain that has not approved yet, or undefined when
 * every one of them has. FR 41, FR 42. LMS 316.
 *
 * The whole of the walk, and it is here rather than in the request workflow of
 * Phase 3 for the reason {@link worksOn} is here rather than in the leave
 * calculator: it needs nothing but the chain and the desks that have signed, so
 * it can be read and tested without a request, a person or a database. What the
 * workflow adds is who the desk resolves to and what happens when nobody is
 * there.
 *
 * ## It replaced `approverAfter`, and the difference is the story
 *
 * LMS 314 walked the chain with `approverAfter(chain, theDeskItWasAt)` — "the
 * one after the one that just signed" — and kept a cursor on the request saying
 * where it had got to. That is right whenever the chain stands still, and the
 * chain does not have to: FR 31 gives it to an HR Administrator, who may edit it
 * while a request is in the queue.
 *
 * The case it gets wrong is a stage added **in front of** where a request is
 * standing. Annual leave goes manager then HR, a request is with HR because the
 * manager has signed, and the administrator changes the chain to CEO, manager,
 * HR. The cursor says HR; the desk after HR is nothing; so HR's yes approves the
 * leave and the Chief Executive — a stage the policy now names — never sees it.
 * The employee is told their leave is agreed, which is the sentence LMS 316
 * exists to make true.
 *
 * Asking instead which desk has *not* signed cannot make that mistake, because
 * it is a question about the whole chain rather than about one position in it.
 * The cursor stays — it is what an approver's queue reads, FR 40, and what the
 * policy resolves to a person — but it is a record of where the request was sent
 * rather than the thing that decides where it goes next.
 *
 * ## Order, and what it is and is not doing
 *
 * The first unapproved desk **in chain order**, so a request still travels the
 * chain the way an HR Administrator wrote it. What the order does not do is
 * decide when the request is agreed: that is "none left", which is a question
 * about a set. A chain reordered under a live request routes by the new order
 * and still collects every signature.
 *
 * A desk that has approved is never returned, which is what stops anybody being
 * asked twice — {@link approverAfter} could not promise that once the order
 * could change, and `leave_request_decision_once_per_desk` now holds it in the
 * schema.
 *
 * Approvals from desks the chain does not name are ignored rather than refused
 * here. They are refused where somebody is actually trying to approve — see
 * `ApprovalChainChanged` — and this function is a question about the chain's own
 * stages, so a signature from outside it is simply not one of them.
 */
export function nextUnapproved(
  chain: readonly ApproverRole[],
  approved: readonly ApproverRole[],
): ApproverRole | undefined {
  return stagesNotApproved(chain, approved)[0];
}

/**
 * Every stage of this chain that has not approved, in chain order. FR 41. LMS
 * 316's first criterion, as a list rather than as a verdict.
 *
 * The walk itself, and {@link nextUnapproved} is its first element — one pass
 * over the list with two readings, rather than two passes that can disagree.
 * "Every stage has approved" is this coming back empty, and it is written that
 * way at each of the two places that ask rather than given a predicate of its
 * own: both of them want the list as well, to route to or to say aloud.
 *
 * **An empty chain gives an empty list**, so a type nobody approves reads as
 * fully approved. That is not a hole for this function to plug: a request for
 * such a type is refused at submission by `assertSomebodyApprovesIt`, with the
 * type named, which is where a person can act on it. The question "is there a
 * chain at all" is {@link isApprovable} and is asked there.
 */
export function stagesNotApproved(
  chain: readonly ApproverRole[],
  approved: readonly ApproverRole[],
): ApproverRole[] {
  return chain.filter((desk) => !approved.includes(desk));
}

/** Whether that desk is asked at all. */
export function isApprovedBy(chain: readonly ApproverRole[], role: ApproverRole): boolean {
  return chain.includes(role);
}

/**
 * The chain as a person reads it: "your manager, then HR".
 *
 * On the request form beside the type, and in the refusal a retired or
 * unapprovable type produces. It is here rather than in an interface layer
 * because the same sentence is wanted in an email, in an error and on a screen,
 * and three copies of it would drift the first time somebody decided the Chief
 * Executive should be called that rather than the CEO.
 */
export function chainInWords(chain: readonly ApproverRole[]): string {
  if (chain.length === 0) {
    return 'nobody';
  }

  const named = chain.map(deskInWords);

  return named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(', ')} then ${named[named.length - 1]}`;
}

/**
 * One desk, as a person says it rather than as the column holds it.
 *
 * Exported since LMS 329, and for the reason {@link chainInWords} gives about itself: the
 * same words are wanted in an email, in an error and on a screen. A notification saying
 * "your leave is now with HR" is naming one desk rather than a chain, and
 * `chainInWords([desk])` said it correctly while reading as a list of one — which is the
 * shape somebody eventually writes `'the ' + desk.toLowerCase()` instead of.
 */
export function deskInWords(role: ApproverRole): string {
  switch (role) {
    case 'MANAGER':
      return 'your line manager';
    case 'HR':
      return 'HR';
    default:
      return 'the Chief Executive';
  }
}

/**
 * The same desk, said to somebody who is not the person taking the leave. LMS 404.
 *
 * {@link deskInWords} is second person — every caller it had was talking to the requester — and
 * an approver queue is the first screen here that describes somebody else's request. Only
 * `MANAGER` differs, because it is the one desk that resolves through a relationship; a copy of
 * that switch beside a `<span>` is how a queue comes to say "their manager" where an email says
 * "your line manager" about the same signature.
 *
 * `whose` is a possessive from {@link possessively}, and a name rather than a pronoun: the
 * record carries a gender for FR 05 and nothing else.
 */
export function deskInWordsAbout(role: ApproverRole, whose: string): string {
  return role === 'MANAGER' ? `${whose} line manager` : deskInWords(role);
}

/** A chain said about somebody else, as {@link chainInWords} says it to them. LMS 404. */
export function chainInWordsAbout(chain: readonly ApproverRole[], whose: string): string {
  if (chain.length === 0) {
    return 'nobody';
  }

  const named = chain.map((role) => deskInWordsAbout(role, whose));

  return named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(', ')} then ${named[named.length - 1]}`;
}

/** A name as a possessive. "Adwoa Frimpong" becomes "Adwoa Frimpong’s", "Ababios" "Ababios’". */
export function possessively(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}
